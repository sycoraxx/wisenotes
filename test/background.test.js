import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as frames from "../lib/frames.js";
import * as sarvam from "../lib/sarvam.js";
import * as ocr from "../lib/ocr.js";
import * as prompt from "../lib/prompt.js";
import * as planner from "../lib/planner.js";
import * as state from "../lib/state.js";
import * as embed from "../lib/embed.js";
import * as captions from "../lib/captions.js";
import * as languages from "../lib/languages.js";
import * as translation from "../lib/translation.js";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");

function harness(session, overrides = {}) {
  const sessions = new Map([[session.sessionId, structuredClone(session)]]);
  const effects = [];
  const context = vm.createContext({
    ...frames, ...sarvam, ...ocr, ...prompt, ...planner, ...state, ...embed, ...captions, ...languages, ...translation,
    translateTextToEnglish: async ({ text }) => ({ text, sourceLanguageCode: "en-IN" }),
    DOMException, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, crypto,
    getSession: async (id) => structuredClone(sessions.get(id)),
    getLatestSession: async () => structuredClone([...sessions.values()][0]),
    putSession: async (item) => sessions.set(item.sessionId, structuredClone(item)),
    clearSessions: async () => sessions.clear(),
    patchSession: async (id, patch) => {
      const next = state.applySessionPatch(sessions.get(id), structuredClone(patch));
      sessions.set(id, next);
      return structuredClone(next);
    },
    chrome: {
      storage: { local: { get: async () => ({ sarvamApiKey: "fake" }), set: async () => {}, remove: async () => {} } },
      runtime: {
        onMessage: { addListener() {} }, getPlatformInfo: async () => ({}),
        sendMessage: async (message) => { effects.push(message.type); return { ok: true }; }
      },
      tabs: {
        get: async () => ({ id: 2, windowId: 1 }), update: async () => {},
        remove: async (id) => { effects.push(`close:${id}`); },
        sendMessage: async (_id, message) => { effects.push(message.type); return { ok: true }; }
      },
      windows: { update: async () => {}, remove: async () => {} },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
      scripting: { executeScript: async () => [] },
      tabCapture: { getMediaStreamId: async () => { throw new Error("not been invoked"); } }
    },
    ...overrides
  });
  vm.runInContext(source, context);
  return { context, sessions, effects };
}

const savedSession = (extra = {}) => ({
  sessionId: "s", state: "extracting", transcript: [{ start: 0, text: "lecture" }],
  frames: [{ t: 1 }, { t: 2 }], frameExtractions: [], nextFrameIndex: 0,
  progress: {}, ...extra
});

async function settle(context) {
  for (let i = 0; i < 100; i += 1) {
    if (!vm.runInContext("activeRuns.size", context)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("background run did not finish");
}

test("OCR checkpoints survive 429 and Resume continues the saved job and next frame", async () => {
  const seen = [];
  let throttle = true;
  const { context, sessions } = harness(savedSession(), {
    readFrameWithOcr: async ({ frame, jobId, onJobCreated }) => {
      seen.push([frame.t, jobId]);
      if (!jobId) await onJobCreated(`job-${frame.t}`);
      if (frame.t === 2 && throttle) throw new sarvam.SarvamError("rate limit", { status: 429 });
      return { t: frame.t, visibleText: `board ${frame.t}`, useful: true };
    }
  });
  assert.equal(await context.runOcrFrames("s", "fake", new AbortController().signal), false);
  assert.equal(sessions.get("s").state, "paused_rate_limit");
  assert.equal(sessions.get("s").nextFrameIndex, 1);
  assert.equal(sessions.get("s").activeOcrJob.jobId, "job-2");
  throttle = false;
  await context.handleMessage({ type: "RESUME_JOB", sessionId: "s" });
  await settle(context);
  assert.equal(sessions.get("s").state, "ready");
  assert.equal(sessions.get("s").frameExtractions.length, 2);
  assert.deepEqual(seen, [[1, ""], [2, ""], [2, "job-2"]]);
  assert.equal(sessions.get("s").frames.length, 0);
});

test("prompt-save failure retains JPEGs and completed OCR for a local-only resume", async () => {
  const session = savedSession({ extractionComplete: true, frameExtractions: [{ t: 1, visibleText: "board" }] });
  const { context, sessions } = harness(session);
  const save = context.patchSession;
  context.patchSession = async (id, patch) => {
    if (patch.state === "ready") throw new Error("storage unavailable");
    return save(id, patch);
  };
  await assert.rejects(context.finishPrompt("s", new AbortController().signal), /storage unavailable/);
  assert.equal(sessions.get("s").frames.length, 2);
  await context.recordRunFailure("s", new Error("storage unavailable"));
  context.patchSession = save;
  context.chrome.storage.local.get = async () => assert.fail("completed OCR needs no API key");
  await context.handleMessage({ type: "RESUME_JOB", sessionId: "s" });
  await settle(context);
  assert.equal(sessions.get("s").state, "ready");
  assert.match(sessions.get("s").finalPrompt, /board/);
});

test("interrupted capture stops the stream, closes the owned tab and restores playback once", async () => {
  const { context, sessions, effects } = harness(savedSession({
    state: "capturing", captureBackend: "embed", captureTabId: 9,
    youtubeTabId: 2, originalPlayback: { currentTime: 10 }
  }));
  await context.recoverInterruptedSession(sessions.get("s"));
  assert.equal(sessions.get("s").state, "error");
  assert.ok(effects.includes("OFFSCREEN_STOP_CAPTURE"));
  assert.ok(effects.includes("close:9"));
  assert.ok(effects.includes("RESTORE_VIDEO"));
  await context.stopCaptureAndRestore(sessions.get("s"));
  assert.equal(effects.filter((effect) => effect === "RESTORE_VIDEO").length, 1);
});

test("cancelling the permission handshake aborts promptly and cannot become an error", async () => {
  const { context, sessions } = harness(savedSession({ state: "awaiting_capture_window" }));
  const controller = new AbortController();
  vm.runInContext("activeRuns.set('s', null)", context);
  context.controllerForTest = controller;
  vm.runInContext("activeRuns.set('s', controllerForTest)", context);
  const pending = context.acquireCaptureStream(sessions.get("s"), 9, "capture tab", controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await context.cancelJob("s");
  await rejected;
  await context.recordRunFailure("s", new Error("late permission failure"));
  assert.equal(sessions.get("s").state, "cancelled");
});

test("the launch lock rejects a second start before the first storage lookup resolves", async () => {
  let release;
  const { context } = harness(savedSession());
  context.chrome.storage.local.get = () => new Promise((resolve) => { release = resolve; });
  const first = context.handleMessage({ type: "START_JOB", youtubeTabId: 2 });
  await assert.rejects(context.handleMessage({ type: "START_JOB", youtubeTabId: 3 }), /already running/);
  release({});
  await assert.rejects(first, /Sarvam API key/);
});

test("native Hindi captions are retrieved without requiring an English track", async () => {
  const { context } = harness(savedSession());
  context.chrome.scripting.executeScript = async () => [{ result: [{
    tracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?lang=hi", languageCode: "hi", kind: "asr", isTranslatable: false }],
    translationLanguages: []
  }] }];
  context.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.has("tlang"), false);
    return { ok: true, text: async () => JSON.stringify({ events: [{ tStartMs: 1234, segs: [{ utf8: "नमस्ते" }] }] }) };
  };
  const result = await context.extractTranscript(2, new AbortController().signal);
  assert.equal(result.sourceLanguageCode, "hi-IN");
  assert.equal(result.ocrLanguageCode, "hi-IN");
  assert.equal(result.segments[0].start, 1.234);
  assert.equal(result.segments[0].text, "नमस्ते");
});

test("panel fallback carries unknown language into detection rather than assuming English", async () => {
  const { context } = harness(savedSession());
  context.chrome.scripting.executeScript = async () => [{ result: [] }];
  context.chrome.tabs.sendMessage = async () => ({ ok: true, segments: [{ start: 2, text: "নমস্কার" }] });
  const result = await context.extractTranscript(2, new AbortController().signal);
  assert.equal(result.sourceLanguageCode, "");
  assert.equal(result.segments[0].text, "নমস্কার");
});

test("English caption normalization resumes before visual planning and retains the OCR source hint", async () => {
  const sourceTranscript = [{ start: 1, text: "नमस्ते" }, { start: 2, text: "दुनिया" }];
  const { context, sessions } = harness(savedSession({
    state: "paused_rate_limit", sourceTranscript, sourceLanguageCode: "hi-IN",
    transcript: [{ start: 1, text: "Hello" }], transcriptTranslationPending: true,
    ocrLanguageCode: "ta-IN", frames: []
  }));
  let planned = false;
  context.translateTranscriptToEnglish = async ({ completedSegments, onProgress }) => {
    assert.equal(completedSegments.length, 1);
    const segments = [{ start: 1, text: "Hello" }, { start: 2, text: "world" }];
    await onProgress({ segments, sourceLanguageCode: "hi-IN" });
    return { segments, sourceLanguageCode: "hi-IN" };
  };
  context.continueFromTranscript = async () => {
    planned = true;
    assert.equal(sessions.get("s").transcript[1].text, "world");
    assert.equal(sessions.get("s").transcriptTranslationPending, false);
  };
  await context.handleMessage({ type: "RESUME_JOB", sessionId: "s" });
  await settle(context);
  assert.equal(planned, true);
  assert.equal(sessions.get("s").ocrLanguageCode, "ta-IN");
  assert.equal(sessions.get("s").transcriptLanguageCode, "en-IN");
});

test("caption translation rate limits keep source and completed captions recoverable", async () => {
  const { context, sessions } = harness(savedSession({
    state: "transcript", sourceTranscript: [{ start: 0, text: "नमस्ते" }],
    transcriptTranslationPending: true, transcript: []
  }));
  await context.recordRunFailure("s", new sarvam.SarvamError("rate limit", { status: 429, retryAfterSeconds: 90 }));
  assert.equal(sessions.get("s").state, "paused_rate_limit");
  assert.equal(sessions.get("s").sourceTranscript[0].text, "नमस्ते");
  assert.equal(state.publicSession(sessions.get("s")).canResume, true);
});

test("Resume upgrades partially translated captions to batches before planning", async () => {
  const sourceTranscript = Array.from({ length: 40 }, (_, start) => ({ start, text: "नमस्ते" }));
  const { context, sessions } = harness(savedSession({
    state: "error", sourceTranscript, sourceLanguageCode: "hi-IN", frames: [],
    transcript: sourceTranscript.slice(0, 3).map((segment) => ({ ...segment, text: "Hello" })),
    transcriptTranslationPending: true
  }));
  let requests = 0;
  let planned = false;
  context.translateTranscriptToEnglish = (options) => translation.translateTranscriptToEnglish({
    ...options,
    fetchImpl: async (_url, init) => {
      requests += 1;
      const texts = JSON.parse(JSON.parse(init.body).messages.at(-1).content).texts;
      return { ok: true, status: 200, json: async () => ({ choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ translations: texts.map(({ id }) => ({ id, text: "Hello" })) }) }
      }] }) };
    }
  });
  context.continueFromTranscript = async () => { planned = true; };
  await context.handleMessage({ type: "RESUME_JOB", sessionId: "s" });
  await settle(context);
  assert.equal(requests, 2);
  assert.equal(planned, true);
  assert.deepEqual(sessions.get("s").transcript, sourceTranscript.map((segment) => ({ ...segment, text: "Hello" })));
  assert.equal(sessions.get("s").transcriptTranslationPending, false);
});

test("OCR translation failure resumes from raw evidence without another OCR job", async () => {
  let reads = 0;
  let throttle = true;
  const { context, sessions } = harness(savedSession({ frames: [{ t: 4 }], ocrLanguageCode: "hi-IN" }), {
    readFrameWithOcr: async ({ languageCode }) => {
      reads += 1;
      assert.equal(languageCode, "hi-IN");
      return { t: 4, ocrMarkdown: "नमस्ते", visibleText: "नमस्ते", evidenceSource: "sarvam-ocr", useful: true };
    },
    translateTextToEnglish: async ({ checkpoint, onProgress }) => {
      if (throttle) {
        await onProgress({ sourceLanguageCode: "hi-IN", completedChunks: [] });
        throw new sarvam.SarvamError("rate limit", { status: 429 });
      }
      assert.equal(checkpoint.sourceLanguageCode, "hi-IN");
      return { text: "Hello", sourceLanguageCode: "hi-IN" };
    }
  });
  assert.equal(await context.runOcrFrames("s", "fake", new AbortController().signal), false);
  assert.equal(sessions.get("s").pendingOcrExtraction.output.ocrMarkdown, "नमस्ते");
  throttle = false;
  await context.handleMessage({ type: "RESUME_JOB", sessionId: "s" });
  await settle(context);
  assert.equal(reads, 1);
  const result = sessions.get("s");
  assert.equal(result.state, "ready");
  assert.equal(result.frameExtractions[0].englishOcrMarkdown, "Hello");
  assert.equal(result.frameExtractions[0].ocrMarkdown, "नमस्ते");
  assert.equal(result.pendingOcrExtraction, null);
});
