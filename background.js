import {
  clearSessions,
  getLatestSession,
  getSession,
  patchSession,
  putSession
} from "./db.js";
import {
  blurRecoveryOffsets,
  buildCapturePlan,
  chooseClearestNearbyFrame,
  frameQuality,
  frameBudget,
  selectFrames,
  selectPeakStates
} from "./lib/frames.js";
import { SarvamError, SARVAM_LLM_MODEL, abortableDelay } from "./lib/sarvam.js";
import { OCR_MODEL_LABEL, readFrameWithOcr, hasUsefulVisualEvidence } from "./lib/ocr.js";
import { buildSynthesisPrompt } from "./lib/prompt.js";
import { inferFrameTriggers } from "./lib/planner.js";
import { translateTranscriptToEnglish, translateTextToEnglish } from "./lib/translation.js";
import { normalizeLanguageCode } from "./lib/languages.js";
import { JOB_STATES, assertTransition, publicSession, migrateSessionToSarvam } from "./lib/state.js";
import { buildPlayerPageUrl, durationMatches, paceDelayMs } from "./lib/embed.js";
import {
  captionJson3Url,
  dedupeSegments,
  transcriptCaptionCandidates,
  mergeCaptionSources
} from "./lib/captions.js";

const OFFSCREEN_PATH = "offscreen.html";
const AD_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
const FRAME_JPEG_QUALITY = 0.9;
const OCR_LIMITATION_WARNING = "OCR can miss faint handwriting and diagram geometry. Review the generated notes against the lecture.";
// Capture runs through a dedicated tab that loads the YouTube embed player, because ads are far
// less likely to play for an embedded player than for the watch page. Users without Premium
// are therefore not stalled mid-capture. The user's own watch tab is only used for the
// transcript and the video snapshot, and is never seeked.
const EMBED_CAPTURE_ENABLED = true;
const CAPTURE_TAB_PREPARE_TIMEOUT_MS = 20000;
// How long the user has to activate the capture tab before WiseNotes falls back to capturing
// the lecture tab the old way.
const CAPTURE_TAB_INVOKE_TIMEOUT_MS = 60000;
const activeRuns = new Map();
let jobLaunchPending = false;
const cleanupRuns = new Map();
let lastVisibleCaptureAt = 0;

if (chrome.storage.local.setAccessLevel) {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
}

// Frame id of the framed player inside the capture tab, reported by the content script that runs
// there. Needed because chrome.scripting cannot inject into "all frames" of a tab whose top frame the
// extension has no host permission for.
const embedFrameIds = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (String(message?.type || "").startsWith("OFFSCREEN_")) return false;
  if (message?.type === "EMBED_FRAME_READY") {
    if (Number.isInteger(sender?.tab?.id) && Number.isInteger(sender.frameId)) {
      embedFrameIds.set(sender.tab.id, sender.frameId);
    }
    return false;
  }
  handleMessage(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: friendlyError(error) })
  );
  return true;
});

async function handleMessage(message = {}) {
  switch (message.type) {
    case "PREPARE_CAPTURE":
      await ensureOffscreen();
      return {};
    case "START_JOB":
      return withJobLaunch(() => startJob(message));
    case "GET_JOB_STATUS": {
      let session = message.sessionId ? await getSession(message.sessionId) : await getLatestSession();
      session = await recoverInterruptedSession(session);
      return { session: publicSession(session) };
    }
    case "GET_PROMPT": {
      const session = await getSession(message.sessionId);
      if (!session?.finalPrompt) throw new Error("No prepared prompt is available yet.");
      return { prompt: session.finalPrompt };
    }
    case "CANCEL_JOB":
      return cancelJob(message.sessionId);
    case "RESUME_JOB":
      return withJobLaunch(() => resumeJob(message.sessionId));
    case "CLEAR_DATA":
      if (activeRuns.size || jobLaunchPending) throw new Error("Cancel the active lecture before clearing saved data.");
      return withJobLaunch(async () => {
        await stopCaptureAndRestore(await getLatestSession()).catch(() => {});
        await clearSessions();
        await chrome.storage.local.remove("lastSessionId");
        return {};
      });
    default:
      throw new Error(`Unknown WiseNotes message: ${message.type || "missing type"}`);
  }
}

async function withJobLaunch(launch) {
  if (activeRuns.size || jobLaunchPending) throw new Error("A WiseNotes lecture is already running.");
  jobLaunchPending = true;
  try {
    return await launch();
  } finally {
    jobLaunchPending = false;
  }
}

// A reasoning request can outlive Chrome's 30-second idle timer after the popup closes.
// Keep the worker active only for the bounded provider operation, then release the timer.
async function withProviderActivity(operation) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

async function startJob({ youtubeTabId }) {
  if (activeRuns.size) throw new Error("A WiseNotes lecture is already running.");
  const ids = { youtubeTabId: Number(youtubeTabId) };
  if (!Number.isInteger(ids.youtubeTabId)) throw new Error("Open the YouTube lecture you want to process.");

  const settings = await chrome.storage.local.get([
    "sarvamApiKey", "ocrLanguageCode"
  ]);
  if (!settings.sarvamApiKey) throw new Error("Add your Sarvam API key in WiseNotes settings first.");
  const youtubeTab = await chrome.tabs.get(ids.youtubeTabId);
  if (!isYouTubeWatchUrl(youtubeTab.url)) throw new Error("Start WiseNotes from a YouTube watch page.");

  await ensureOffscreen();
  const snapshotResponse = await tabMessage(ids.youtubeTabId, { type: "YOUTUBE_SNAPSHOT" });
  if (!snapshotResponse.ok) throw new Error(snapshotResponse.error);
  if (!snapshotResponse.videoId) throw new Error("The current page does not contain a normal YouTube video ID.");
  if (snapshotResponse.duration <= 0) throw new Error("Wait for the lecture to load, then try again.");

  const now = Date.now();
  const session = {
    sessionId: crypto.randomUUID(),
    videoId: snapshotResponse.videoId,
    videoUrl: youtubeTab.url,
    youtubeTabId: ids.youtubeTabId,
    title: snapshotResponse.title || youtubeTab.title || "YouTube Lecture",
    duration: snapshotResponse.duration,
    originalPlayback: snapshotResponse.snapshot,
    originalVisualSettings: null,
    captureBackend: "",
    captureTabId: 0,
    captureWindowId: 0,
    createdAt: now,
    updatedAt: now,
    state: JOB_STATES.IDLE,
    progress: { current: 0, total: 1, percent: 0, message: "Starting WiseNotes…" },
    transcript: [],
    sourceTranscript: [],
    sourceLanguageCode: "",
    transcriptTranslationPending: false,
    ocrLanguageCode: normalizeLanguageCode(settings.ocrLanguageCode),
    frames: [],
    frameExtractions: [],
    nextFrameIndex: 0,
    provider: "sarvam",
    model: SARVAM_LLM_MODEL,
    ocrModel: OCR_MODEL_LABEL,
    plannerModel: SARVAM_LLM_MODEL,
    frameTriggers: [],
    planningMode: "",
    planningPending: false,
    finalPrompt: "",
    deliveryMode: "copy",
    warning: OCR_LIMITATION_WARNING,
    error: "",
    errorCode: "",
    skippedCaptures: 0
  };
  await putSession(session);
  await chrome.storage.local.set({ lastSessionId: session.sessionId });

  const controller = new AbortController();
  activeRuns.set(session.sessionId, controller);
  runNewJob(session.sessionId, settings.sarvamApiKey, controller).finally(() => {
    activeRuns.delete(session.sessionId);
  });
  return { sessionId: session.sessionId };
}

async function runNewJob(sessionId, apiKey, controller) {
  let session = await getSession(sessionId);
  try {
    session = await setState(session, JOB_STATES.TRANSCRIPT, "Checking lecture captions and language…", 0);
    // Rolling caption events can repeat the same line, which would otherwise show up twice in the
    // final prompt.
    const captions = await extractTranscript(session.youtubeTabId, controller.signal);
    const sourceTranscript = dedupeSegments(captions.segments);
    throwIfAborted(controller.signal);
    await patchSession(sessionId, {
      sourceTranscript,
      sourceLanguageCode: captions.sourceLanguageCode,
      ocrLanguageCode: session.ocrLanguageCode || captions.ocrLanguageCode || "",
      transcriptTranslationPending: true
    });
    await continueTranscriptTranslation(sessionId, apiKey, controller.signal);
  } catch (error) {
    await recordRunFailure(sessionId, error);
  } finally {
    await stopCaptureAndRestore(await getSession(sessionId).catch(() => session)).catch(() => {});
  }
}

async function continueTranscriptTranslation(sessionId, apiKey, signal) {
  const session = await getSession(sessionId);
  await updateProgress(sessionId, 2, "Translating captions into English in batches with Sarvam…", session.transcript?.length || 0, session.sourceTranscript.length);
  const result = await withProviderActivity(() => translateTranscriptToEnglish({
    apiKey, signal,
    segments: session.sourceTranscript,
    sourceLanguageCode: session.sourceLanguageCode,
    completedSegments: session.transcript || [],
    onProgress: async ({ segments, sourceLanguageCode }) => {
      throwIfAborted(signal);
      await patchSession(sessionId, {
        transcript: segments, sourceLanguageCode,
        progress: {
          current: segments.length, total: session.sourceTranscript.length, percent: 3,
          message: `Translated ${segments.length} of ${session.sourceTranscript.length} caption segments into English…`
        }
      });
    }
  }));
  throwIfAborted(signal);
  await patchSession(sessionId, {
    transcript: result.segments,
    sourceLanguageCode: result.sourceLanguageCode,
    transcriptLanguageCode: "en-IN",
    ocrLanguageCode: session.ocrLanguageCode || result.sourceLanguageCode,
    transcriptTranslationPending: false,
    planningPending: true
  });
  await continueFromTranscript(sessionId, apiKey, signal);
}

async function continueFromTranscript(sessionId, apiKey, signal) {
  let session = await getSession(sessionId);
  const transcript = session.transcript ?? [];
  if (!transcript.length) throw new Error("The saved transcript is unavailable; start the lecture again.");

  await updateProgress(
    sessionId,
    5,
    "Sarvam-105B is selecting useful visual moments…",
    0,
    1
  );

  let framePlan;
  try {
    framePlan = await withProviderActivity(() => inferFrameTriggers({
      apiKey,
      transcript,
      durationSeconds: session.duration,
      signal
    }));
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof SarvamError && error.status === 429) {
      throwIfAborted(signal);
      const retryAfter = Math.max(60, error.retryAfterSeconds || 0);
      assertTransition(session.state, JOB_STATES.PAUSED_RATE_LIMIT);
      await patchSession(sessionId, {
        state: JOB_STATES.PAUSED_RATE_LIMIT,
        planningPending: true,
        retryAt: Date.now() + retryAfter * 1000,
        error: error.message,
        progress: {
          ...session.progress,
          message: `Sarvam rate limit reached during timestamp planning. Resume after ${new Date(Date.now() + retryAfter * 1000).toLocaleTimeString()}.`
        }
      });
      return false;
    }
    throw new Error(
      `${friendlyError(error)} WiseNotes did not fall back to dense local capture. Your transcript is saved; choose Resume to retry Sarvam planning.`
    );
  }

  throwIfAborted(signal);
  session = await patchSession(sessionId, {
    frameTriggers: framePlan.triggers,
    plannerModel: framePlan.model,
    planningMode: "semantic",
    planningPending: false,
    warning: OCR_LIMITATION_WARNING,
    error: "",
    errorCode: ""
  });

  const capture = await prepareCaptureBackend(session, session.warning, signal);
  throwIfAborted(signal);
  session = capture.session;
  session = await setState(
    session,
    JOB_STATES.CAPTURING,
    `Using ${framePlan.model}; finding useful lecture frames locally…`,
    8
  );
  const captureResult = await captureFrames(session, transcript, signal, framePlan.triggers);
  await stopCaptureAndRestore(session);
  throwIfAborted(signal);
  session = await patchSession(sessionId, {
    frames: captureResult.frames,
    skippedCaptures: captureResult.skipped,
    progress: {
      current: captureResult.frames.length,
      total: captureResult.frames.length,
      percent: 55,
      message: `${captureResult.frames.length} useful frames selected locally.`
    }
  });

  session = await setState(session, JOB_STATES.EXTRACTING, "Sarvam Vision is reading the selected frames…", 56);
  const completed = await runOcrFrames(sessionId, apiKey, signal);
  if (!completed) return false;
  await finishPrompt(sessionId, signal);
  return true;
}

async function captureFrames(session, transcript, signal, plannedTriggers = []) {
  const triggers = plannedTriggers;
  const plan = buildCapturePlan(session.duration, triggers);
  const scouted = [];
  let skipped = 0;

  for (let index = 0; index < plan.length; index += 1) {
    throwIfAborted(signal);
    const item = plan[index];
    await updateProgress(
      session.sessionId,
      8 + Math.round((index / Math.max(1, plan.length)) * 28),
      `Scouting visual state ${index + 1} of ${plan.length} locally…`,
      index + 1,
      plan.length
    );
    try {
      scouted.push(await captureScoutAt(session, item, signal));
    } catch (error) {
      if (error.name === "AbortError") throw error;
      skipped += 1;
    }
  }

  const peaks = selectPeakStates(scouted);
  const budget = frameBudget(session.duration);
  const primary = selectFrames(peaks, session.duration, budget);
  const primaryKeys = new Set(primary.map(frameCandidateKey));
  // Peak candidates are the first reserves. If every peak was selected, retain lower-ranked
  // scout states as a last-resort replacement for a recapture that fails or lands on an ad/
  // transition. They never consume Sarvam OCR quota unless a primary frame could not be recovered.
  const reserve = [...peaks, ...scouted]
    .filter((frame) => !primaryKeys.has(frameCandidateKey(frame)))
    .sort((a, b) => frameQuality(b) - frameQuality(a))
    .filter((frame, index, all) =>
      all.findIndex((candidate) => frameCandidateKey(candidate) === frameCandidateKey(frame)) === index
    );
  const queue = [...primary, ...reserve];
  const target = Math.min(budget, primary.length);
  const captured = [];

  for (let index = 0; index < queue.length && captured.length < target; index += 1) {
    throwIfAborted(signal);
    await updateProgress(
      session.sessionId,
      36 + Math.round((captured.length / Math.max(1, target)) * 19),
      `Capturing peak-information frame ${captured.length + 1} of ${target}…`,
      captured.length + 1,
      target
    );
    try {
      captured.push(await captureAt(session, queue[index], signal, session.duration));
    } catch (error) {
      if (error.name === "AbortError") throw error;
      skipped += 1;
    }
  }

  const selected = selectFrames(captured, session.duration, budget);
  if (!selected.length) throw new Error("WiseNotes could not capture a usable lecture frame.");
  return { frames: selected, skipped };
}

async function captureScoutAt(session, item, signal) {
  const frame = await captureRawAt(session, item.t, signal, { analysisOnly: true });
  return {
    ...frame,
    source: item.source,
    triggerScore: item.triggerScore ?? 0,
    triggerBase: item.triggerBase,
    windowId: item.windowId,
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    visualKind: item.visualKind || "other",
    incremental: Boolean(item.incremental),
    requestedTime: item.t
  };
}

async function captureAt(session, item, signal, duration) {
  const base = await captureRawAt(session, item.t, signal);
  const alternatives = [];
  for (const offset of blurRecoveryOffsets(base.sharpness)) {
    throwIfAborted(signal);
    const nearbyTime = clampCaptureTime(item.t + offset, duration);
    if (Math.abs(nearbyTime - base.t) < 0.2) continue;
    try {
      alternatives.push(await captureRawAt(session, nearbyTime, signal));
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
  }

  const clearest = chooseClearestNearbyFrame(base, alternatives);
  return {
    ...clearest,
    source: item.source,
    triggerScore: item.triggerScore ?? 0,
    triggerBase: item.triggerBase,
    windowId: item.windowId,
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    visualKind: item.visualKind || "other",
    incremental: Boolean(item.incremental),
    peakScore: item.peakScore,
    blurRecovered: clearest !== base,
    requestedTime: item.t
  };
}

async function captureRawAt(session, seconds, signal, { analysisOnly = false } = {}) {
  const seek = await seekCaptureTarget(session, seconds, signal);
  const frame = await captureFromStream(session.captureTabId, seek.captureMeta, { analysisOnly });
  if (!frame?.ok) throw new Error(frame?.error || "Tab capture failed.");
  if (frame.blank) throw new Error("The captured lecture frame was blank.");

  return {
    t: Number(seek.actualTime ?? seconds),
    dataUrl: frame.dataUrl,
    hash: frame.hash,
    regionalHashes: frame.regionalHashes,
    sharpness: frame.sharpness,
    edgeDensity: frame.edgeDensity,
    occupiedRatio: frame.occupiedRatio,
    informationScore: frame.informationScore,
    exposureQuality: frame.exposureQuality,
    edgeGrid: frame.edgeGrid,
    crop: frame.crop
  };
}

// Polls the capture target until it reports lecture content. YouTube's own Skip Ad control is
// pressed on every ad tick, so a skippable ad clears in about a second instead of stalling the
// whole lecture until AD_WAIT_TIMEOUT_MS.
async function seekCaptureTarget(session, seconds, signal) {
  const adDeadline = Date.now() + AD_WAIT_TIMEOUT_MS;
  while (Date.now() < adDeadline) {
    throwIfAborted(signal);
    const seek = await tabMessage(session.captureTabId, { type: "SEEK_VIDEO", seconds });
    if (!seek.ok) throw new Error(seek.error);
    if (!seek.adShowing) return seek;
    await abortableSleep(seek.adSkipped ? 400 : 1000, signal);
  }
  throw new Error("A YouTube ad is still playing. Let it finish or skip it manually, then try again.");
}

async function captureFromStream(tabId, captureMeta, { analysisOnly = false } = {}) {
  const frame = await runtimeMessage({
    type: "OFFSCREEN_CAPTURE_FRAME",
    captureMeta,
    quality: FRAME_JPEG_QUALITY,
    analysisOnly
  });
  if (!frame?.ok) throw new Error(frame?.error || "Tab capture failed.");
  if (!frame.blank) return frame;
  return captureVisibleFallback(tabId, captureMeta, { analysisOnly });
}

function clampCaptureTime(seconds, duration) {
  const upper = Math.max(0, (Number(duration) || 0) - 0.25);
  return Math.max(0, Math.min(upper, Number(seconds) || 0));
}

async function captureVisibleFallback(tabId, captureMeta, { analysisOnly = false } = {}) {
  const delay = paceDelayMs(lastVisibleCaptureAt, Date.now());
  if (delay > 0) await sleep(delay);
  lastVisibleCaptureAt = Date.now();
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(250);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
  return runtimeMessage({
    type: "OFFSCREEN_PROCESS_DATA_URL",
    dataUrl,
    captureMeta,
    quality: FRAME_JPEG_QUALITY,
    analysisOnly
  });
}

function frameCandidateKey(frame) {
  return `${frame.windowId || "probe"}:${Number(frame.t).toFixed(2)}`;
}

async function runOcrFrames(sessionId, apiKey, signal) {
  let session = await getSession(sessionId);
  const frames = session.frames ?? [];
  const existing = [...(session.frameExtractions ?? [])];
  let nextIndex = Number(session.nextFrameIndex) || 0;

  while (nextIndex < frames.length) {
    throwIfAborted(signal);
    const frame = frames[nextIndex];
    const savedJob = session.activeOcrJob?.frameIndex === nextIndex ? session.activeOcrJob : null;
    let pending = session.pendingOcrExtraction?.frameIndex === nextIndex ? session.pendingOcrExtraction : null;
    await updateProgress(sessionId, 56 + Math.round((nextIndex / frames.length) * 34),
      `Sarvam Vision is reading frame ${nextIndex + 1} of ${frames.length}…`, nextIndex, frames.length);
    try {
      let output = pending?.output;
      if (!output) {
        output = await withProviderActivity(() => readFrameWithOcr({
          apiKey, frame, signal, jobId: savedJob?.jobId || "",
          languageCode: session.ocrLanguageCode || "en-IN",
          onJobCreated: async (jobId) => {
            session = await patchSession(sessionId, {
              activeOcrJob: { frameIndex: nextIndex, jobId }
            });
          }
        }));
        pending = { frameIndex: nextIndex, output, translationCheckpoint: null };
        session = await patchSession(sessionId, { pendingOcrExtraction: pending });
      }
      await updateProgress(sessionId, 56 + Math.round((nextIndex / frames.length) * 34),
        `Preparing frame ${nextIndex + 1} of ${frames.length} in English…`, nextIndex, frames.length);
      const translated = await withProviderActivity(() => translateTextToEnglish({
        apiKey, signal,
        text: output.ocrMarkdown || output.visibleText || "",
        checkpoint: pending.translationCheckpoint,
        onProgress: async (translationCheckpoint) => {
          throwIfAborted(signal);
          pending = { ...pending, translationCheckpoint };
          session = await patchSession(sessionId, { pendingOcrExtraction: pending });
        }
      }));
      output = {
        ...output, englishOcrMarkdown: translated.text,
        ocrSourceLanguageCode: translated.sourceLanguageCode, translationComplete: true
      };
      throwIfAborted(signal);
      existing.push(output);
      nextIndex += 1;
      session = await patchSession(sessionId, {
        frameExtractions: existing,
        nextFrameIndex: nextIndex,
        activeOcrJob: null,
        pendingOcrExtraction: null,
        error: "",
        progress: {
          current: nextIndex, total: frames.length,
          percent: 56 + Math.round((nextIndex / frames.length) * 34),
          message: `Sarvam Vision read ${nextIndex} of ${frames.length} frames.`
        }
      });
    } catch (error) {
      if (error.ocrJobFailed) await patchSession(sessionId, { activeOcrJob: null });
      if (error instanceof SarvamError && error.status === 429) {
        throwIfAborted(signal);
        const retryAt = Date.now() + Math.max(60, error.retryAfterSeconds || 0) * 1000;
        await patchSession(sessionId, {
          state: JOB_STATES.PAUSED_RATE_LIMIT, retryAt, error: error.message,
          progress: { ...session.progress, message: `Sarvam rate limit reached. Resume after ${new Date(retryAt).toLocaleTimeString()}.` }
        });
        return false;
      }
      throw error;
    }
  }
  if (!hasUsefulVisualEvidence(existing)) {
    throw new Error("Sarvam OCR did not recover any usable visual text. WiseNotes stopped instead of generating transcript-only notes.");
  }
  await patchSession(sessionId, { extractionComplete: true });
  return true;
}

async function finishPrompt(sessionId, signal) {
  throwIfAborted(signal);
  let session = await getSession(sessionId);
  session = await setState(session, JOB_STATES.STAGING, "Building the universal synthesis prompt…", 92);
  const finalPrompt = buildSynthesisPrompt({
    title: session.title,
    videoUrl: session.videoUrl,
    transcript: session.transcript,
    extractions: session.frameExtractions
  });
  throwIfAborted(signal);

  assertTransition(session.state, JOB_STATES.READY);
  await patchSession(sessionId, {
    state: JOB_STATES.READY,
    finalPrompt,
    frames: [],
    activeOcrJob: null,
    pendingOcrExtraction: null,
    error: "",
    progress: {
      current: 1,
      total: 1,
      percent: 100,
      message: "Universal prompt ready. Copy it into Claude (recommended) or any capable LLM."
    }
  });
}

async function resumeJob(sessionId) {
  if (activeRuns.size) throw new Error("Another WiseNotes lecture is already running.");
  let session = await getSession(sessionId);
  if (!session) throw new Error("That saved WiseNotes session no longer exists.");
  if (![JOB_STATES.PAUSED_RATE_LIMIT, JOB_STATES.ERROR].includes(session.state)) {
    throw new Error("This session does not need to be resumed.");
  }
  session = await patchSession(sessionId, migrateSessionToSarvam(session));
  if (session.finalPrompt || session.extractionComplete) {
    const controller = new AbortController();
    activeRuns.set(sessionId, controller);
    finishPrompt(sessionId, controller.signal)
      .catch((error) => recordRunFailure(sessionId, error))
      .finally(() => activeRuns.delete(sessionId));
    return { sessionId };
  }
  const { sarvamApiKey } = await chrome.storage.local.get("sarvamApiKey");
  if (!sarvamApiKey) throw new Error("Add your Sarvam API key before resuming.");

  if (session.transcriptTranslationPending && session.sourceTranscript?.length) {
    assertTransition(session.state, JOB_STATES.TRANSCRIPT);
    await patchSession(sessionId, { state: JOB_STATES.TRANSCRIPT, error: "", errorCode: "", retryAt: 0 });
    const controller = new AbortController();
    activeRuns.set(sessionId, controller);
    continueTranscriptTranslation(sessionId, sarvamApiKey, controller.signal)
      .catch((error) => recordRunFailure(sessionId, error))
      .finally(() => activeRuns.delete(sessionId));
    return { sessionId };
  }

  if (session.planningPending && session.transcript?.length) {
    assertTransition(session.state, JOB_STATES.TRANSCRIPT);
    await patchSession(sessionId, {
      state: JOB_STATES.TRANSCRIPT,
      error: "",
      errorCode: "",
      retryAt: 0,
      progress: { ...session.progress, message: "Retrying Sarvam-105B timestamp planning…" }
    });
    const controller = new AbortController();
    activeRuns.set(sessionId, controller);
    continuePlanning(sessionId, sarvamApiKey, controller).finally(() => activeRuns.delete(sessionId));
    return { sessionId };
  }

  if (!session.frames?.length) throw new Error("The saved frames are unavailable; start the lecture again.");

  assertTransition(session.state, JOB_STATES.EXTRACTING);
  await patchSession(sessionId, {
    state: JOB_STATES.EXTRACTING,
    error: "",
    retryAt: 0,
    progress: { ...session.progress, message: "Resuming Sarvam OCR…" }
  });
  const controller = new AbortController();
  activeRuns.set(sessionId, controller);
  continueExtraction(sessionId, sarvamApiKey, controller).finally(() => activeRuns.delete(sessionId));
  return { sessionId };
}

async function continuePlanning(sessionId, apiKey, controller) {
  try {
    await continueFromTranscript(sessionId, apiKey, controller.signal);
  } catch (error) {
    await recordRunFailure(sessionId, error);
  } finally {
    await stopCaptureAndRestore(await getSession(sessionId).catch(() => null)).catch(() => {});
  }
}

async function continueExtraction(sessionId, apiKey, controller) {
  try {
    const completed = await runOcrFrames(sessionId, apiKey, controller.signal);
    if (completed) await finishPrompt(sessionId, controller.signal);
  } catch (error) {
    await recordRunFailure(sessionId, error);
  }
}

async function cancelJob(sessionId) {
  const controller = activeRuns.get(sessionId);
  controller?.abort();
  const session = await getSession(sessionId);
  if (!session) return {};
  if (![JOB_STATES.READY, JOB_STATES.CANCELLED].includes(session.state)) {
    await patchSession(sessionId, {
      state: JOB_STATES.CANCELLED,
      error: "",
      progress: { ...session.progress, message: "Lecture processing cancelled." }
    });
  }
  await stopCaptureAndRestore(session).catch(() => {});
  return {};
}

async function recordRunFailure(sessionId, error) {
  const session = await getSession(sessionId).catch(() => null);
  if (!session || [JOB_STATES.PAUSED_RATE_LIMIT, JOB_STATES.CANCELLED, JOB_STATES.READY].includes(session.state)) return;
  const cancelled = error?.name === "AbortError";
  if (!cancelled && error instanceof SarvamError && error.status === 429 && session.transcriptTranslationPending) {
    const retryAt = Date.now() + Math.max(60, error.retryAfterSeconds || 0) * 1000;
    await patchSession(sessionId, {
      state: JOB_STATES.PAUSED_RATE_LIMIT, retryAt, error: error.message,
      progress: { ...session.progress, message: `Sarvam translation rate limit reached. Resume after ${new Date(retryAt).toLocaleTimeString()}.` }
    });
    return;
  }
  await patchSession(sessionId, {
    state: cancelled ? JOB_STATES.CANCELLED : JOB_STATES.ERROR,
    error: cancelled ? "" : friendlyError(error),
    errorCode: cancelled ? "" : String(error?.code || ""),
    progress: {
      ...session.progress,
      percent: error?.code === "NO_ENGLISH_CAPTIONS" ? 0 : session.progress?.percent,
      message: cancelled ? "Lecture processing cancelled." : friendlyError(error)
    }
  }).catch(() => {});
}

async function recoverInterruptedSession(session) {
  if (!session) return null;
  const runningStates = new Set([
    JOB_STATES.TRANSCRIPT,
    JOB_STATES.AWAITING_CAPTURE_WINDOW,
    JOB_STATES.CAPTURING,
    JOB_STATES.EXTRACTING,
    JOB_STATES.STAGING
  ]);
  if (!runningStates.has(session.state) || activeRuns.has(session.sessionId) || jobLaunchPending) return session;
  await stopCaptureAndRestore(session).catch(() => {});
  const recoverableMessage = session.finalPrompt
    ? "Chrome was interrupted while finalizing your prompt. The complete prompt is saved; choose Resume."
    : session.extractionComplete || (!session.frames?.length && session.geminiExtractions?.length)
      ? "Chrome interrupted prompt finalization. Your visual evidence is saved; choose Resume."
      : session.frames?.length
        ? "Chrome interrupted the background task. Your captured frames are saved; choose Resume."
        : session.transcriptTranslationPending && session.sourceTranscript?.length
          ? "Chrome interrupted English translation. Your captions are saved; choose Resume."
          : session.planningPending && session.transcript?.length
          ? "Chrome interrupted timestamp planning. Your transcript is saved; choose Resume."
          : "Chrome interrupted the background task before capture finished. Start the lecture again.";
  return patchSession(session.sessionId, {
    state: JOB_STATES.ERROR,
    error: recoverableMessage,
    progress: {
      ...session.progress,
      message: "The background task was interrupted."
    }
  });
}

async function setState(session, state, message, percent) {
  const current = await getSession(session.sessionId);
  if (current?.state === JOB_STATES.CANCELLED) throw new DOMException("Operation cancelled", "AbortError");
  assertTransition(session.state, state);
  return patchSession(session.sessionId, {
    state,
    error: "",
    errorCode: "",
    progress: { current: 0, total: 1, percent, message }
  });
}

async function updateProgress(sessionId, percent, message, current, total) {
  return patchSession(sessionId, {
    progress: { percent, message, current, total }
  });
}

async function stopCaptureAndRestore(session) {
  if (!session) return;
  const pending = cleanupRuns.get(session.sessionId);
  if (pending) return pending;
  const cleanup = releaseCapture(session);
  cleanupRuns.set(session.sessionId, cleanup);
  try {
    await cleanup;
  } finally {
    cleanupRuns.delete(session.sessionId);
  }
}

async function releaseCapture(session) {
  session = await getSession(session.sessionId).catch(() => session) || session;
  if (session.captureReleased) return;
  await runtimeMessage({ type: "OFFSCREEN_STOP_CAPTURE" }).catch(() => {});
  // Only the embed backend owns a tab. The watch backend's captureTabId is the user's own
  // lecture tab and must never be closed.
  if (session?.captureBackend === "embed" && Number.isInteger(session.captureTabId) && session.captureTabId) {
    embedFrameIds.delete(session.captureTabId);
    await chrome.tabs.remove(session.captureTabId).catch(() => {});
  }
  // Sessions saved by an earlier build used a separate window instead of a tab.
  if (Number.isInteger(session?.captureWindowId) && session.captureWindowId) {
    await chrome.windows.remove(session.captureWindowId).catch(() => {});
  }
  if (session?.youtubeTabId && session?.originalVisualSettings) {
    await restoreYouTubeVisuals(session.youtubeTabId, session.originalVisualSettings).catch(() => {});
  }
  if (session?.captureBackend && session?.youtubeTabId && session?.originalPlayback) {
    await tabMessage(session.youtubeTabId, {
      type: "RESTORE_VIDEO",
      snapshot: session.originalPlayback
    }).catch(() => {});
  }
  await patchSession(session.sessionId, { captureReleased: true, captureTabId: 0, captureWindowId: 0 }).catch(() => {});
}

// Chooses where frames come from. The embed backend is preferred because an embedded player does
// not serve the pre-roll the watch page serves, so a non-Premium user is not stalled mid-capture.
// The watch backend preserves the previous behaviour and is used whenever the player page is
// unusable, which also keeps WiseNotes working offline.
async function prepareCaptureBackend(session, planningWarning, signal) {
  throwIfAborted(signal);
  if (!EMBED_CAPTURE_ENABLED) return prepareWatchBackend(session, planningWarning, signal);

  let captureTabId = 0;
  let waiting = session;
  try {
    waiting = await setState(
      session,
      JOB_STATES.AWAITING_CAPTURE_WINDOW,
      "Opening the ad-free capture tab…",
      6
    );
    // Created active on purpose: a background tab is treated as hidden, and YouTube refuses to
    // load media into a hidden document. The tab opens the hosted player page rather than the raw
    // embed URL, because YouTube only plays an embed whose request carries a Referer naming a real
    // http(s), non-YouTube origin - see lib/embed.js for the shapes that fail.
    const captureTab = await chrome.tabs.create({
      url: buildPlayerPageUrl(session.videoId),
      active: true
    });
    captureTabId = captureTab?.id;
    if (!Number.isInteger(captureTabId)) throw new Error("Chrome did not open the capture tab");
    waiting = await patchSession(session.sessionId, { captureBackend: "embed", captureTabId, captureReleased: false });
    throwIfAborted(signal);
    await waitForPlayerTab(captureTabId, CAPTURE_TAB_PREPARE_TIMEOUT_MS, signal);
    await ensureOffscreen();
    // Capture is started before the player is asked to load anything, so the tab is already
    // marked as captured and keeps running after the user returns to their lecture tab.
    const streamId = await acquireCaptureStream(waiting, captureTabId, "the WiseNotes player tab", signal);
    throwIfAborted(signal);
    const started = await runtimeMessage({ type: "OFFSCREEN_START_CAPTURE", streamId });
    throwIfAborted(signal);
    if (!started?.ok) throw new Error(started?.error || "Could not start capture on the embed tab");

    let prepared = await tabMessage(captureTabId, { type: "PREPARE_EMBED" });
    throwIfAborted(signal);
    if (!prepared.ok) {
      // Bring the tab forward once and retry before giving up on the embed backend.
      await chrome.tabs.update(captureTabId, { active: true }).catch(() => {});
      await abortableDelay(1500, signal);
      prepared = await tabMessage(captureTabId, { type: "PREPARE_EMBED" });
    }
    if (!prepared.ok) throw new Error(prepared.error);
    if (!prepared.embedReady) throw new Error("the embed player did not report itself ready");
    if (!durationMatches(session.duration, prepared.duration, 3)) {
      throw new Error("the embed player reported a different lecture duration");
    }
    // Pinned before the first probe, so every captured frame comes from the highest level offered.
    const quality = await prepareEmbedQuality(captureTabId);
    throwIfAborted(signal);
    const qualityWarning = quality?.requested
      ? ""
      : "WiseNotes could not pin the embedded player's quality, so the capture used whatever resolution the player chose.";
    await probeCaptureTab(captureTabId);
    throwIfAborted(signal);
    await setVideoState(session.youtubeTabId, { paused: true, muted: true });

    return {
      session: await patchSession(session.sessionId, {
        captureBackend: "embed",
        captureTabId,
        captureWindowId: 0,
        warning: [planningWarning, qualityWarning].filter(Boolean).join(" ")
      })
    };
  } catch (error) {
    if (Number.isInteger(captureTabId) && captureTabId) {
      await chrome.tabs.remove(captureTabId).catch(() => {});
    }
    await runtimeMessage({ type: "OFFSCREEN_STOP_CAPTURE" }).catch(() => {});
    if (error?.name === "AbortError" || signal?.aborted) {
      // Cancellation may have restored playback while an in-flight preparation command
      // was still changing it. Let the final cleanup restore the settled state once more.
      await patchSession(session.sessionId, { captureReleased: false }).catch(() => {});
      throw new DOMException("Operation cancelled", "AbortError");
    }
    const notice = `WiseNotes could not use the ad-free player tab (${friendlyError(error)}), so it captured the lecture tab instead.${captureTabHint(error)}`;
    return prepareWatchBackend(waiting, [planningWarning, notice].filter(Boolean).join(" "), signal);
  }
}

// Manifest permission changes only take effect after the unpacked extension is reloaded, and
// that failure otherwise looks like a generic connection error.
function captureTabHint(error) {
  const text = String(error?.message || error);
  if (/host permission|Cannot access contents|must request permission|Receiving end does not exist|could not establish connection/i.test(text)) {
    return " Reload WiseNotes in chrome://extensions so the capture-tab permission takes effect.";
  }
  return "";
}

async function prepareWatchBackend(session, warning, signal) {
  throwIfAborted(signal);
  let originalVisualSettings = null;
  const warnings = warning ? [warning] : [];
  try {
    originalVisualSettings = await prepareYouTubeVisuals(session.youtubeTabId);
    if (!originalVisualSettings.requestedQuality) {
      warnings.push("YouTube did not expose a controllable quality level, so WiseNotes used the stream resolution available to the player.");
    }
  } catch (error) {
    warnings.push(`WiseNotes could not request maximum YouTube quality (${friendlyError(error)}).`);
  }
  await patchSession(session.sessionId, {
    captureBackend: "watch", captureTabId: session.youtubeTabId,
    captureReleased: false, originalVisualSettings
  });
  throwIfAborted(signal);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: session.youtubeTabId });
  throwIfAborted(signal);
  const captureStart = await runtimeMessage({ type: "OFFSCREEN_START_CAPTURE", streamId });
  if (signal?.aborted) {
    await runtimeMessage({ type: "OFFSCREEN_STOP_CAPTURE" }).catch(() => {});
    throwIfAborted(signal);
  }
  if (!captureStart?.ok) throw new Error(captureStart?.error || "Could not start tab capture.");

  return {
    session: await patchSession(session.sessionId, {
      captureBackend: "watch",
      captureTabId: session.youtubeTabId,
      captureWindowId: 0,
      originalVisualSettings,
      warning: warnings.filter(Boolean).join(" ")
    })
  };
}

// Chrome only lets WiseNotes capture a tab the user has invoked the extension on. The user's own
// lecture tab already carries that grant; a tab WiseNotes opens itself does not, so the user is
// asked to click the WiseNotes icon there once. By then the popup is long closed, so the request has
// to live where the user is actually looking instead of in a popup nobody has open. The wait is
// bounded, and the run falls back to the lecture tab if the grant never arrives.
async function acquireCaptureStream(session, tabId, label, signal) {
  throwIfAborted(signal);
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    if (!needsInvocation(error)) throw error;
  }

  await requestCaptureGrant(session, tabId, label);
  const deadline = Date.now() + CAPTURE_TAB_INVOKE_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await abortableDelay(1000, signal);
      try {
        return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      } catch (error) {
        if (!needsInvocation(error)) throw error;
      }
    }
  } finally {
    await clearCaptureGrantRequest(tabId);
  }
  throw new Error(`${label} was never activated`);
}

// Three signals, because the popup alone was not enough: a numbered badge on the toolbar icon, a
// tooltip on that same icon, and the window brought forward so the new tab is actually on screen.
async function requestCaptureGrant(session, tabId, label) {
  await setState(
    session,
    JOB_STATES.AWAITING_CAPTURE_WINDOW,
    `Action needed: click the WiseNotes icon in the toolbar once, on ${label}, to allow capture.`,
    6
  );
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c0392b" }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: "1" }).catch(() => {});
  await chrome.action.setTitle({
    tabId,
    title: "Click the WiseNotes icon once to allow capturing this tab"
  }).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

async function clearCaptureGrantRequest(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: "WiseNotes" }).catch(() => {});
}

function needsInvocation(error) {
  return /not been invoked|activeTab|cannot be captured|not allowed/i.test(String(error?.message || error));
}

// Readiness is taken from the load status rather than the tab's URL on purpose. Reading a tab's url
// or title needs either the "tabs" permission or a host permission for that tab, and WiseNotes
// deliberately asks for neither on the player page. tab.status is available without any permission,
// and PREPARE_EMBED still does the real waiting and reports a useful error if no player appears.
async function waitForPlayerTab(tabId, timeoutMs = CAPTURE_TAB_PREPARE_TIMEOUT_MS, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return tab;
    await abortableDelay(250, signal);
  }
  throw new Error("the capture tab did not finish loading the WiseNotes player page");
}

// Proves the capture tab really produces usable lecture pixels before the run commits to it.
async function probeCaptureTab(tabId) {
  const seek = await tabMessage(tabId, { type: "SEEK_VIDEO", seconds: 1 });
  if (!seek.ok) throw new Error(seek.error);
  if (seek.adShowing) throw new Error("the capture tab started on an advertisement");
  const frame = await captureFromStream(tabId, seek.captureMeta);
  if (!frame?.ok) throw new Error(frame?.error || "the capture tab produced no frame");
  if (frame.blank) throw new Error("the capture tab produced a blank frame");
  return frame;
}

async function setVideoState(tabId, state) {
  await tabMessage(tabId, { type: "SET_VIDEO_STATE", ...state }).catch(() => {});
}

// Highest first. "auto" is excluded: pinning to it would leave quality free to drop mid-run.
const YOUTUBE_QUALITY_PREFERENCE = Object.freeze([
  "highres", "hd4320", "hd2880", "hd2160", "hd1440",
  "hd1080", "hd720", "large", "medium", "small", "tiny"
]);

// The embed capture tab used to make no quality request at all and rely on the player's adaptive
// choice, which follows bandwidth and can quietly settle for 360p part way through a run. This is the
// same preference logic the watch backend uses, injected into the framed player's own world. Unlike
// the watch backend there is nothing to restore afterwards, because the capture tab is temporary and
// closed when the run ends. The whole request is best effort: a refused injection must never take the
// run down, so it degrades to "no pin" and the caller reports it as a warning.
async function prepareEmbedQuality(tabId) {
  // allFrames cannot be used here. The capture tab's top frame is a hosted page the extension has no
  // host permission for, and chrome.scripting throws outright rather than skipping it, so the
  // injection is aimed at the one frame that owns the player.
  const frameId = embedFrameIds.get(tabId);
  if (!Number.isInteger(frameId)) return null;
  const execution = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    args: [YOUTUBE_QUALITY_PREFERENCE],
    func: async (qualityPreference) => {
      const player = document.querySelector("#movie_player");
      const video = document.querySelector("video.html5-main-video, video");
      if (!player || !video) return null;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const available = [...(player.getAvailableQualityLevels?.() || [])]
        .map(String)
        .filter((quality) => quality && quality !== "auto");
      const requested = qualityPreference.find((quality) => available.includes(quality))
        || available[0]
        || "";
      if (!requested) {
        return { requested, settled: false, available, videoHeight: video.videoHeight };
      }
      try {
        player.setPlaybackQualityRange?.(requested, requested);
      } catch {
        // Older players expose only setPlaybackQuality.
      }
      player.setPlaybackQuality?.(requested);
      let settled = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        await wait(250);
        if (String(player.getPlaybackQuality?.() || "") === requested
          && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          settled = true;
          await wait(500);
          break;
        }
      }
      return {
        requested,
        settled,
        current: String(player.getPlaybackQuality?.() || ""),
        available,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight
      };
    }
  }).catch(() => null);
  return execution?.[0]?.result ?? null;
}

async function prepareYouTubeVisuals(tabId) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [YOUTUBE_QUALITY_PREFERENCE],
    func: async (qualityPreference) => {
      const player = document.querySelector("#movie_player");
      const video = document.querySelector("video.html5-main-video, video");
      if (!player || !video) throw new Error("The YouTube player is unavailable.");
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isTheater = () => Boolean(document.querySelector("ytd-watch-flexy[theater]"));
      const originalTheater = isTheater();
      const originalQuality = String(player.getPlaybackQuality?.() || "");
      let originalRange = null;
      try {
        const range = player.getPlaybackQualityRange?.();
        if (range) {
          const min = String(range.min || range.minQuality || range[0] || "");
          const max = String(range.max || range.maxQuality || range[1] || "");
          if (min || max) originalRange = { min, max };
        }
      } catch {
        // Some YouTube player versions do not expose the preference range.
      }

      if (!originalTheater) {
        document.querySelector(".ytp-size-button")?.click();
        await wait(500);
      }

      const availableQualities = [...(player.getAvailableQualityLevels?.() || [])]
        .map(String)
        .filter((quality) => quality && quality !== "auto");
      const requestedQuality = qualityPreference.find((quality) => availableQualities.includes(quality))
        || availableQualities[0]
        || "";
      if (requestedQuality) {
        try {
          player.setPlaybackQualityRange?.(requestedQuality, requestedQuality);
        } catch {
          // Older players may support only setPlaybackQuality.
        }
        player.setPlaybackQuality?.(requestedQuality);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await wait(250);
          if (String(player.getPlaybackQuality?.() || "") === requestedQuality
            && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            await wait(500);
            break;
          }
        }
      }

      return {
        originalTheater,
        theaterChanged: originalTheater !== isTheater(),
        originalQuality,
        originalRange,
        requestedQuality,
        availableQualities,
        preparedVideoWidth: video.videoWidth,
        preparedVideoHeight: video.videoHeight
      };
    }
  });
  const result = execution?.[0]?.result;
  if (!result) throw new Error("YouTube did not return its capture settings.");
  return result;
}

async function restoreYouTubeVisuals(tabId, settings) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [settings],
    func: async (saved) => {
      const player = document.querySelector("#movie_player");
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      if (player) {
        try {
          if (saved.originalRange?.min || saved.originalRange?.max) {
            player.setPlaybackQualityRange?.(
              saved.originalRange.min || saved.originalQuality,
              saved.originalRange.max || saved.originalQuality
            );
          } else if (saved.originalQuality) {
            player.setPlaybackQuality?.(saved.originalQuality);
          }
        } catch {
          // Playback restoration below remains authoritative if YouTube changed this API.
        }
      }

      const currentTheater = Boolean(document.querySelector("ytd-watch-flexy[theater]"));
      if (currentTheater !== Boolean(saved.originalTheater)) {
        document.querySelector(".ytp-size-button")?.click();
        await wait(350);
      }
    }
  });
}

async function extractTranscript(tabId, signal) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const player = document.querySelector("#movie_player");
      const readSources = () => {
        const responses = [player?.getPlayerResponse?.(), window.ytInitialPlayerResponse]
          .filter(Boolean);
        return responses.map((response) => {
          const renderer = response?.captions?.playerCaptionsTracklistRenderer;
          const tracks = renderer?.captionTracks ?? [];
          const translationLanguages = renderer?.translationLanguages ?? [];
          return {
            tracks: tracks.map((track) => ({
              baseUrl: track.baseUrl,
              languageCode: track.languageCode || "",
              kind: track.kind || "",
              isTranslatable: track.isTranslatable === true
                ? true
                : track.isTranslatable === false ? false : null,
              name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || ""
            })),
            translationLanguages: translationLanguages.map((language) => ({
              languageCode: language.languageCode || "",
              name: language.languageName?.simpleText
                || language.languageName?.runs?.map((run) => run.text).join("")
                || ""
            }))
          };
        });
      };

      // Caption metadata can populate shortly after the video element itself becomes ready.
      // Native Indic tracks are usable even without YouTube's translation catalog.
      const deadline = Date.now() + 2500;
      let sources = readSources();
      while (Date.now() < deadline) {
        const richEnough = sources.some((source) =>
          source.tracks.some((track) => track.baseUrl)
          || source.translationLanguages.some((language) => /^en(?:-|$)/i.test(language.languageCode))
        );
        if (richEnough) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        sources = readSources();
      }
      return sources;
    }
  });
  const captionData = mergeCaptionSources(execution?.[0]?.result ?? []);
  const tracks = captionData.tracks ?? [];
  if (tracks.length) {
    const candidates = transcriptCaptionCandidates(tracks, captionData.translationLanguages);
    let translatedCandidatesAttempted = 0;
    let lastTranslationError = null;
    let lastCaptionError = null;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      try {
        if (candidate.translated) translatedCandidatesAttempted += 1;
        const json = await fetchCaptionJson(captionJson3Url(candidate), 0, signal);
        const segments = parseJson3Transcript(json);
        if (segments.length) return {
          segments,
          sourceLanguageCode: candidate.requiresTranslation ? candidate.sourceLanguageCode : "en-IN",
          ocrLanguageCode: candidates.find((track) => track.requiresTranslation && track.track.kind === "asr")?.sourceLanguageCode
            || normalizeLanguageCode(candidate.track.languageCode)
        };
        throw new Error("The caption response contained no usable text.");
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        lastCaptionError = error;
        if (candidate.translated) lastTranslationError = error;
        // A rate limit applies to every remaining candidate, so trying them only deepens the
        // throttle. Breaking still lets a direct-English lecture fall through to the on-page
        // transcript panel below.
        if (isCaptionRateLimit(error)) break;
        // Try direct English, native Indic, then YouTube-translated English tracks.
      }
    }
    const fallback = await tabMessage(tabId, { type: "EXTRACT_TRANSCRIPT" });
    throwIfAborted(signal);
    if (fallback.ok && fallback.segments?.length) return { segments: fallback.segments, sourceLanguageCode: "", ocrLanguageCode: "" };
    if (translatedCandidatesAttempted) throw englishTranslationFailedError(lastTranslationError);
    if (candidates.length && lastCaptionError) throw new Error(`WiseNotes could not retrieve the lecture captions (${friendlyError(lastCaptionError)}). Reload the lecture and try again.`);
    throw noEnglishCaptionsError();
  }

  const fallback = await tabMessage(tabId, { type: "EXTRACT_TRANSCRIPT" });
  if (!fallback.ok || !fallback.segments?.length) {
    throw new Error(fallback.error || "No readable captions were available for this lecture.");
  }
  return { segments: fallback.segments, sourceLanguageCode: "", ocrLanguageCode: "" };
}

function noEnglishCaptionsError() {
  const error = new Error("No readable English or supported Indic captions were available for this lecture.");
  error.code = "NO_ENGLISH_CAPTIONS";
  return error;
}

function englishTranslationFailedError(cause) {
  // Reloading immediately is the wrong advice for a throttle, and it deepens the rate limit.
  if (isCaptionRateLimit(cause)) {
    const seconds = Number(cause?.retryAfterSeconds);
    const hint = Number.isFinite(seconds) && seconds > 0
      ? `Wait about ${Math.max(1, Math.ceil(seconds / 60))} minute(s), then start the lecture again.`
      : "Wait a few minutes, then start the lecture again. Reloading straight away will not help.";
    const error = new Error(`YouTube is rate limiting caption requests. ${hint}`);
    error.code = "CAPTION_RATE_LIMIT";
    return error;
  }
  const suffix = cause?.message ? ` (${cause.message})` : "";
  const error = new Error(
    `YouTube offered an English caption translation, but WiseNotes could not retrieve it${suffix}. Reload the lecture and try again.`
  );
  error.code = "ENGLISH_TRANSLATION_FAILED";
  return error;
}

// YouTube answers a subtitle request it will not serve with an empty 200 body. Reading the body
// as text keeps that cause visible instead of surfacing "Unexpected end of JSON input".
function parseCaptionBody(body) {
  const text = String(body ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// An empty body usually means caption metadata has not settled yet, and the popup already tells
// the user to reload and retry, so one bounded retry does that for them.
async function fetchCaptionJson(url, attempt = 0, signal) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw captionRequestError(response);
  const body = await response.text();
  const json = parseCaptionBody(body);
  if (json) return json;
  if (attempt < 1) {
    await abortableDelay(600, signal);
    return fetchCaptionJson(url, attempt + 1, signal);
  }
  throw new Error(`the caption endpoint returned ${body.length} bytes of unusable data over HTTP ${response.status}`);
}

// Keeps the HTTP status on the error so callers can tell a rate limit apart from a refusal, and
// surfaces Retry-After when YouTube supplies one.
function captionRequestError(response) {
  const error = new Error(`HTTP ${response.status}`);
  error.status = response.status;
  const retryAfter = Number(response.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
  return error;
}

function isCaptionRateLimit(error) {
  return Number(error?.status) === 429;
}

function parseJson3Transcript(payload) {
  return (payload?.events ?? []).map((event) => {
    const text = (event.segs ?? []).map((segment) => segment.utf8 || "").join("")
      .replace(/\s+/g, " ")
      .trim();
    return { start: (Number(event.tStartMs) || 0) / 1000, text };
  }).filter((segment) => segment.text);
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture and crop the lecture tab after the user starts WiseNotes."
    });
  } catch (error) {
    if (!/single offscreen document|already exists/i.test(error.message)) throw error;
  }
}

async function tabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error.message)) throw error;
    const tab = await chrome.tabs.get(tabId);
    const file = isYouTubeUrl(tab.url) ? "yt-content.js" : null;
    if (!file) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function runtimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Operation cancelled", "AbortError"));
    }, { once: true });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isYouTubeWatchUrl(value = "") {
  try {
    const url = new URL(value);
    return url.hostname === "www.youtube.com" && url.pathname === "/watch" && url.searchParams.has("v");
  } catch {
    return false;
  }
}

function isYouTubeUrl(value = "") {
  try {
    const host = new URL(value).hostname;
    return host === "www.youtube.com" || host === "www.youtube-nocookie.com";
  } catch {
    return false;
  }
}

function friendlyError(error) {
  if (!error) return "An unknown WiseNotes error occurred.";
  return String(error.message || error).replace(/^Error:\s*/i, "");
}
