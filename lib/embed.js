// Helpers for the ad-free embed capture path.
//
// WiseNotes captures frames through a dedicated capture tab that loads the YouTube
// embed player instead of seeking the user's own watch tab. Ads are far less likely to
// play in an embed than on the watch page, so non-Premium users are not stalled by them.
//
// This module is deliberately free of DOM and Chrome API access so it can be unit tested.

export const EMBED_HOSTS = Object.freeze({
  NOCOOKIE: "www.youtube-nocookie.com",
  YOUTUBE: "www.youtube.com"
});

// Capture tab shape. Two shapes were considered:
//   - a chrome-extension:// page hosting a youtube.com/embed iframe is the truest
//     third-party embedder, but it is cross-origin, so the player's DOM cannot be read and
//     ads can be neither detected nor skipped inside it;
//   - a top-level embed page keeps full DOM control (ad detection, skip, quality, seek
//     confirmation) which the pipeline depends on.
// The top-level shape wins until a spike proves otherwise.
export const CAPTURE_WINDOW_HOST = EMBED_HOSTS.NOCOOKIE;

export const AD_SHOWING_SELECTOR = ".html5-video-player.ad-showing";

export const AD_SKIP_SELECTORS = Object.freeze([
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button",
  ".ytp-skip-ad-button",
  ".ytp-ad-skip-button-container button",
  ".ytp-ad-skip-button-modern button"
]);

// The embed player draws its own title bar, gradient scrims, and control bar. They are hidden
// during capture so a saved frame contains only lecture content.
export const EMBED_CHROME_SELECTORS = Object.freeze([
  ".ytp-chrome-top",
  ".ytp-chrome-bottom",
  ".ytp-gradient-top",
  ".ytp-gradient-bottom",
  ".ytp-title",
  ".ytp-pause-overlay",
  ".ytp-cards-teaser",
  ".ytp-ce-element",
  ".ytp-shorts-brand",
  ".ytp-paid-content-overlay"
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
  const params = new URLSearchParams({ ...DEFAULT_PARAMS });

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
