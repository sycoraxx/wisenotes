// Helpers for the ad-free embed capture path.
//
// WiseNotes captures frames through a dedicated capture tab that plays the lecture in an embedded
// player instead of seeking the user's own watch tab. Measured in the same signed-out browser, the
// watch page served a 15-second pre-roll for a video that the embed served with no ad at all, so
// non-Premium users are not stalled mid-capture.
//
// This module is deliberately free of DOM and Chrome API access so it can be unit tested.

export const EMBED_HOSTS = Object.freeze({
  NOCOOKIE: "www.youtube-nocookie.com",
  YOUTUBE: "www.youtube.com"
});

// The capture tab plays the lecture in an embedded player, which YouTube only allows when the embed
// request carries a Referer naming a real http(s), non-YouTube origin: the player reads what it
// calls the "embedder identity" out of that header. Three other shapes were tried and all fail, each
// confirmed against YouTube's own error codes:
//   - a top-level /embed/ navigation sends no Referer at all                         -> Error 153;
//   - an embed inside a youtube.com page makes youtube.com the embedder              -> Error 152;
//   - an embed inside a chrome-extension:// page also sends no Referer, because Blink never emits
//     an extension URL as a Referer, even with referrerpolicy="origin"                -> Error 153.
// A Chrome extension cannot be an http(s) origin, so the capture tab is docs/player.html, published
// by GitHub Pages, and yt-content.js runs inside the framed embed via all_frames.
export const CAPTURE_WINDOW_HOST = EMBED_HOSTS.NOCOOKIE;

export const AD_SHOWING_SELECTOR = ".html5-video-player.ad-showing";

export const AD_SKIP_SELECTORS = Object.freeze([
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button",
  ".ytp-skip-ad-button",
  ".ytp-ad-skip-button-container button",
  ".ytp-ad-skip-button-modern button"
]);

// The embed player draws its own title bar, gradient scrims, control bar, watermark, and overlays.
// They are hidden during capture so a saved frame contains only lecture content. yt-content.js also
// hides everything inside the player that is not the video or one of its ancestors, so a renamed or
// newly added overlay cannot leak into a frame even if this list falls behind.
export const EMBED_CHROME_SELECTORS = Object.freeze([
  ".ytp-chrome-top",
  ".ytp-chrome-bottom",
  ".ytp-gradient-top",
  ".ytp-gradient-bottom",
  ".ytp-title",
  ".ytp-watermark",
  ".ytp-large-play-button",
  ".ytp-spinner",
  ".ytp-cued-thumbnail-overlay",
  ".ytp-impression-link",
  ".ytp-pause-overlay",
  ".ytp-cards-teaser",
  ".ytp-ce-element",
  ".ytp-shorts-brand",
  ".ytp-paid-content-overlay",
  ".ytp-ad-overlay-container"
]);

// chrome.tabs.captureVisibleTab is limited to two calls per second, and the visible-tab fallback
// can fire repeatedly while blur recovery walks around a single timestamp.
export const MIN_VISIBLE_CAPTURE_INTERVAL_MS = 500;

// enablejsapi is deliberately absent. It obliges the player to receive a matching `origin`
// parameter, and YouTube answers a missing or mismatched origin with "Video player configuration
// error". Nothing here needs it: yt-content.js runs inside the embed document and drives the
// <video> element directly, so the postMessage widget API is never used.
const DEFAULT_PARAMS = Object.freeze({
  autoplay: "1",
  mute: "1",
  controls: "0",
  modestbranding: "1",
  rel: "0",
  iv_load_policy: "3",
  playsinline: "1",
  fs: "0",
  disablekb: "1"
});

export function buildEmbedUrl(videoId, options = {}) {
  const id = String(videoId || "").trim();
  if (!id) throw new Error("An embed URL needs a YouTube video id.");
  const host = String(options.host || CAPTURE_WINDOW_HOST).trim() || CAPTURE_WINDOW_HOST;
  const params = new URLSearchParams(EMBED_PARAMS);

  if (options.muted === false) {
    params.set("autoplay", "0");
    params.delete("mute");
  }
  const origin = String(options.origin || "").trim();
  if (origin) params.set("origin", origin);
  const start = Number(options.startSeconds);
  if (Number.isFinite(start) && start > 0) params.set("start", String(Math.floor(start)));

  return `https://${host}/embed/${encodeURIComponent(id)}?${params.toString()}`;
}

// The canonical query string for the embedded player. docs/player.html mirrors this exact string,
// because a page served over http cannot import a module, and test/embed.test.js fails if the two
// copies drift apart.
export const EMBED_PARAMS = new URLSearchParams({ ...DEFAULT_PARAMS }).toString();

// Where the hosted player page lives. GitHub Pages publishes the docs/ directory of the default
// branch, so this is the page the capture tab opens.
export const PLAYER_PAGE_URL = "https://sycoraxx.github.io/wisenotes/player.html";

// YouTube video ids are 11 characters of [A-Za-z0-9_-]. docs/player.html enforces the same pattern
// before it will frame anything, so an unexpected video id cannot turn into an arbitrary embed.
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function buildPlayerPageUrl(videoId) {
  const id = String(videoId || "").trim();
  if (!VIDEO_ID_PATTERN.test(id)) {
    throw new Error("The player page needs an 11-character YouTube video id.");
  }
  return `${PLAYER_PAGE_URL}?v=${encodeURIComponent(id)}`;
}

const PLAYER_PAGE_ORIGIN = new URL(PLAYER_PAGE_URL).origin;
const PLAYER_PAGE_PATH = new URL(PLAYER_PAGE_URL).pathname;

export function isPlayerPageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === PLAYER_PAGE_ORIGIN && url.pathname === PLAYER_PAGE_PATH;
  } catch {
    return false;
  }
}

export function isEmbedPath(pathname = "") {
  return /^\/embed\//.test(String(pathname));
}

export function isEmbedUrl(value, hosts = [EMBED_HOSTS.NOCOOKIE, EMBED_HOSTS.YOUTUBE]) {
  try {
    const url = new URL(value);
    return hosts.includes(url.hostname) && isEmbedPath(url.pathname);
  } catch {
    return false;
  }
}

// An embed that cannot report the same duration as the watch page is either showing an ad,
// failing to load, or not the lecture the user asked for.
export function durationMatches(mainDuration, embedDuration, toleranceSeconds = 2) {
  const expected = Number(mainDuration);
  const actual = Number(embedDuration);
  if (!Number.isFinite(expected) || expected <= 0) return false;
  if (!Number.isFinite(actual) || actual <= 0) return false;
  return Math.abs(actual - expected) <= Math.abs(Number(toleranceSeconds) || 0);
}

export function paceDelayMs(lastCaptureAtMs, nowMs, minIntervalMs = MIN_VISIBLE_CAPTURE_INTERVAL_MS) {
  const last = Number(lastCaptureAtMs);
  const now = Number(nowMs);
  const interval = Math.max(0, Number(minIntervalMs) || 0);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return 0;
  return Math.max(0, interval - (now - last));
}

// The widget postMessage protocol is the fallback when the player DOM is unreachable.
export function parseWidgetMessage(data) {
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const event = typeof payload.event === "string" ? payload.event : "";
  const info = payload.info && typeof payload.info === "object" ? payload.info : null;
  if (!event && !info) return null;
  return { event, info };
}
