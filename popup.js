const elements = Object.fromEntries([
  "youtube-dot", "youtube-status", "key-dot", "key-status", "settings-button",
  "start-button",
  "progress-card", "progress-title", "progress-percent", "progress-track", "progress-bar",
  "progress-message", "error-message", "resume-button", "copy-button",
  "cancel-button", "clear-data", "forget-key"
].map((id) => [id, document.getElementById(id)]));

let youtubeTab = null;
let hasKey = false;
let currentSessionId = null;
let pollTimer = null;

initialize().catch(showTopError);

async function initialize() {
  bindEvents();
  const [activeTabs, storage] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get(["geminiApiKey", "lastSessionId"])
  ]);
  youtubeTab = activeTabs[0] ?? null;
  hasKey = Boolean(storage.geminiApiKey);
  currentSessionId = storage.lastSessionId || null;
  renderSetup();
  await request({ type: "PREPARE_CAPTURE" }).catch(() => null);
  if (currentSessionId) {
    await refreshStatus();
    startPolling();
  }
  updateStartButton();
}

function bindEvents() {
  elements["settings-button"].addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements["start-button"].addEventListener("click", startJob);
  elements["cancel-button"].addEventListener("click", cancelJob);
  elements["resume-button"].addEventListener("click", resumeJob);
  elements["copy-button"].addEventListener("click", copyPrompt);
  elements["clear-data"].addEventListener("click", clearData);
  elements["forget-key"].addEventListener("click", forgetKey);
}

function renderSetup() {
  const validYouTube = isYouTubeWatchUrl(youtubeTab?.url);
  setDot(elements["youtube-dot"], validYouTube);
  elements["youtube-status"].textContent = validYouTube
    ? youtubeTab.title?.replace(/\s+-\s+YouTube$/, "") || "Captioned lecture ready"
    : "Open a captioned youtube.com/watch lecture";
  setDot(elements["key-dot"], hasKey);
  elements["key-status"].textContent = hasKey ? "Stored only in this Chrome profile" : "Add a free-tier API key";
}

async function startJob() {
  clearInlineError();
  elements["start-button"].disabled = true;
  elements["start-button"].textContent = "Starting capture…";
  try {
    const response = await request({
      type: "START_JOB",
      youtubeTabId: youtubeTab.id
    });
    currentSessionId = response.sessionId;
    show(elements["progress-card"]);
    startPolling();
    await refreshStatus();
  } catch (error) {
    showInlineError(error.message);
  } finally {
    elements["start-button"].textContent = "Prepare universal prompt";
    updateStartButton();
  }
}

async function refreshStatus() {
  if (!currentSessionId) return;
  const response = await request({ type: "GET_JOB_STATUS", sessionId: currentSessionId });
  const session = response.session;
  if (!session) return;
  renderSession(session);
}

function renderSession(session) {
  show(elements["progress-card"]);
  const progress = session.progress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  elements["progress-percent"].textContent = `${percent}%`;
  elements["progress-bar"].style.width = `${percent}%`;
  elements["progress-message"].textContent = progress.message || session.state;
  const noEnglishCaptions = session.state === "error" && session.errorCode === "NO_ENGLISH_CAPTIONS";
  const translationFailed = session.state === "error" && session.errorCode === "ENGLISH_TRANSLATION_FAILED";
  const captionFailure = noEnglishCaptions || translationFailed;
  const checkingCaptions = session.state === "transcript" && session.transcriptSegmentCount === 0;
  elements["progress-title"].textContent = session.state === "ready"
    ? "Your universal prompt is ready"
    : noEnglishCaptions
      ? "English captions unavailable"
      : translationFailed
        ? "Caption translation failed"
      : checkingCaptions
        ? "Checking lecture captions"
      : "Working on your lecture";
  toggle(elements["progress-percent"], !captionFailure && !checkingCaptions);
  toggle(elements["progress-track"], !captionFailure && !checkingCaptions);

  toggle(elements["cancel-button"], ["transcript", "awaiting_capture_window", "capturing", "extracting", "staging"].includes(session.state));
  toggle(
    elements["resume-button"],
    session.state === "paused_rate_limit"
      || (session.state === "error" && (
        session.transcriptSegmentCount > 0
        || session.frameCount > 0
        || session.hasPrompt
      ))
  );
  toggle(elements["copy-button"], session.hasPrompt);

  // Warnings are shown as soon as they exist, not only once the job is ready. The capture-window
  // fallback reason in particular has to be visible while the run is still going.
  // Caption failures are already rendered as the progress message. Do not repeat the same
  // sentence in the inline error area underneath it.
  const problem = captionFailure
    ? session.warning || ""
    : session.error || session.warning || "";
  if (problem) showInlineError(problem);
  else clearInlineError();

  if (["ready", "cancelled", "error", "paused_rate_limit"].includes(session.state)) stopPolling();
}

async function cancelJob() {
  await request({ type: "CANCEL_JOB", sessionId: currentSessionId });
  await refreshStatus();
}

async function resumeJob() {
  clearInlineError();
  await request({ type: "RESUME_JOB", sessionId: currentSessionId });
  startPolling();
  await refreshStatus();
}

async function copyPrompt() {
  const response = await request({ type: "GET_PROMPT", sessionId: currentSessionId });
  await navigator.clipboard.writeText(response.prompt);
  elements["copy-button"].textContent = "Copied — paste into your AI";
  setTimeout(() => { elements["copy-button"].textContent = "Copy universal prompt"; }, 1600);
}

async function clearData() {
  await request({ type: "CLEAR_DATA" });
  currentSessionId = null;
  stopPolling();
  hide(elements["progress-card"]);
}

async function forgetKey() {
  await chrome.storage.local.remove(["geminiApiKey"]);
  hasKey = false;
  renderSetup();
  updateStartButton();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refreshStatus().catch((error) => showInlineError(error.message)), 1000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function updateStartButton() {
  const enabled = isYouTubeWatchUrl(youtubeTab?.url)
    && hasKey;
  elements["start-button"].disabled = !enabled;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "WiseNotes did not respond.");
  return response;
}

function showTopError(error) {
  show(elements["progress-card"]);
  showInlineError(error.message || String(error));
}

function showInlineError(message) {
  elements["error-message"].textContent = message;
  show(elements["error-message"]);
}

function clearInlineError() {
  elements["error-message"].textContent = "";
  hide(elements["error-message"]);
}

function setDot(element, good) {
  element.classList.toggle("good", good);
  element.classList.toggle("bad", !good);
}

function isYouTubeWatchUrl(value = "") {
  try {
    const url = new URL(value);
    return url.hostname === "www.youtube.com" && url.pathname === "/watch" && url.searchParams.has("v");
  } catch {
    return false;
  }
}

function toggle(element, visible) { element.classList.toggle("hidden", !visible); }
function show(element) { element.classList.remove("hidden"); }
function hide(element) { element.classList.add("hidden"); }
