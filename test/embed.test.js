import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AD_SHOWING_SELECTOR,
  AD_SKIP_SELECTORS,
  CAPTURE_WINDOW_HOST,
  EMBED_CHROME_SELECTORS,
  EMBED_HOSTS,
  EMBED_PARAMS,
  PLAYER_PAGE_URL,
  VIDEO_ID_PATTERN,
  buildEmbedUrl,
  buildPlayerPageUrl,
  durationMatches,
  isEmbedPath,
  isEmbedUrl,
  isPlayerPageUrl,
  paceDelayMs,
  parseWidgetMessage
} from "../lib/embed.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ytContentSource = readFileSync(join(repoRoot, "yt-content.js"), "utf8");
const playerPageSource = readFileSync(join(repoRoot, "docs", "player.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8"));

test("embed URLs disable chrome and mute for unattended autoplay", () => {
  const url = new URL(buildEmbedUrl("dQw4w9WgXcQ"));
  assert.equal(url.hostname, CAPTURE_WINDOW_HOST);
  assert.equal(url.pathname, "/embed/dQw4w9WgXcQ");
  // enablejsapi=1 obliges the player to receive a matching origin parameter, and YouTube answers a
  // missing one with "Video player configuration error". The capture tab never uses the widget API.
  assert.equal(url.searchParams.get("enablejsapi"), null);
  assert.equal(url.searchParams.get("autoplay"), "1");
  assert.equal(url.searchParams.get("mute"), "1");
  assert.equal(url.searchParams.get("controls"), "0");
  assert.equal(url.searchParams.get("iv_load_policy"), "3");
  assert.equal(url.searchParams.get("origin"), null);
});

test("embed URLs carry the hosting origin and start offset when asked", () => {
  const url = new URL(buildEmbedUrl("abc123", {
    host: EMBED_HOSTS.YOUTUBE,
    origin: "chrome-extension://pkgid",
    startSeconds: 91.7
  }));
  assert.equal(url.hostname, "www.youtube.com");
  assert.equal(url.searchParams.get("origin"), "chrome-extension://pkgid");
  assert.equal(url.searchParams.get("start"), "91");
});

test("unmuted embeds never autoplay and reject a missing id", () => {
  const url = new URL(buildEmbedUrl("abc123", { muted: false }));
  assert.equal(url.searchParams.get("autoplay"), "0");
  assert.equal(url.searchParams.get("mute"), null);
  assert.throws(() => buildEmbedUrl("   "), /video id/);
});

test("embed paths and URLs are recognised across both hosts", () => {
  assert.equal(isEmbedPath("/embed/dQw4w9WgXcQ"), true);
  assert.equal(isEmbedPath("/watch"), false);
  assert.equal(isEmbedUrl("https://www.youtube-nocookie.com/embed/abc?enablejsapi=1"), true);
  assert.equal(isEmbedUrl("https://www.youtube.com/embed/abc"), true);
  assert.equal(isEmbedUrl("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(isEmbedUrl("https://example.com/embed/abc"), false);
  assert.equal(isEmbedUrl("not a url"), false);
});

test("duration matching rejects ads and unloaded players", () => {
  assert.equal(durationMatches(600, 600.5, 2), true);
  assert.equal(durationMatches(600, 594, 2), false);
  assert.equal(durationMatches(600, 615, 2), false);
  assert.equal(durationMatches(600, NaN), false);
  assert.equal(durationMatches(0, 600), false);
});

test("capture pacing honours the visible-tab rate limit", () => {
  assert.equal(paceDelayMs(1000, 1000, 500), 500);
  assert.equal(paceDelayMs(1000, 1200, 500), 300);
  assert.equal(paceDelayMs(1000, 1600, 500), 0);
  assert.equal(paceDelayMs(undefined, 1600, 500), 0);
});

test("widget messages are parsed from objects and JSON strings", () => {
  assert.deepEqual(
    parseWidgetMessage({ event: "infoDelivery", info: { currentTime: 12 } }),
    { event: "infoDelivery", info: { currentTime: 12 } }
  );
  assert.deepEqual(
    parseWidgetMessage('{"event":"onStateChange","info":1}'),
    { event: "onStateChange", info: null }
  );
  assert.equal(parseWidgetMessage("not json"), null);
  assert.equal(parseWidgetMessage("{oops"), null);
  assert.equal(parseWidgetMessage(null), null);
  assert.equal(parseWidgetMessage({}), null);
});

test("ad skip and embed chrome selector lists are non-empty and unique", () => {
  for (const list of [AD_SKIP_SELECTORS, EMBED_CHROME_SELECTORS]) {
    assert.ok(list.length > 0);
    assert.equal(new Set(list).size, list.length);
  }
});

// yt-content.js runs as a classic content script and cannot import modules, so it mirrors these
// lists. This test fails the moment the two copies drift apart.
test("yt-content.js mirrors every embed selector", () => {
  const mirrored = [AD_SHOWING_SELECTOR, ...AD_SKIP_SELECTORS, ...EMBED_CHROME_SELECTORS];
  for (const selector of mirrored) {
    assert.ok(
      ytContentSource.includes(`"${selector}"`),
      `yt-content.js is missing the mirrored selector ${selector}`
    );
  }
});

// The capture tab opens a hosted http(s) page, because YouTube refuses an embed whose request has
// no Referer naming a real third-party origin. A Chrome extension cannot be such an origin.
test("the player page URL carries a validated video id", () => {
  const url = new URL(buildPlayerPageUrl("dQw4w9WgXcQ"));
  assert.equal(url.origin, new URL(PLAYER_PAGE_URL).origin);
  assert.equal(url.pathname, new URL(PLAYER_PAGE_URL).pathname);
  assert.equal(url.searchParams.get("v"), "dQw4w9WgXcQ");

  // A malformed id must never reach the hosted page as a frameable parameter.
  for (const bad of ["", "   ", "short", "way-too-long-to-be-a-video-id", "../../etc/passwd", null]) {
    assert.throws(() => buildPlayerPageUrl(bad), /video id/);
  }
});

test("player page URLs are recognised only on the exact origin and path", () => {
  assert.equal(isPlayerPageUrl(buildPlayerPageUrl("dQw4w9WgXcQ")), true);
  assert.equal(isPlayerPageUrl(PLAYER_PAGE_URL), true);
  assert.equal(isPlayerPageUrl("https://sycoraxx.github.io.evil.example/wisenotes/player.html"), false);
  assert.equal(isPlayerPageUrl("https://evil.example/wisenotes/player.html"), false);
  assert.equal(isPlayerPageUrl("https://sycoraxx.github.io/other/player.html"), false);
  assert.equal(isPlayerPageUrl("https://www.youtube-nocookie.com/embed/abc"), false);
  assert.equal(isPlayerPageUrl("not a url"), false);
});

// docs/player.html is served over http and cannot import a module, so it repeats the query string
// and the id pattern. These two tests are the only thing keeping the copies honest.
test("the hosted player page mirrors the canonical embed params", () => {
  const declared = /var EMBED_PARAMS = "([^"]+)"/.exec(playerPageSource);
  assert.ok(declared, "docs/player.html should declare EMBED_PARAMS");
  assert.equal(declared[1], EMBED_PARAMS);
});

test("the hosted player page mirrors the video id pattern", () => {
  const declared = /var VIDEO_ID_PATTERN = (\/\^[^;]+?\/);/.exec(playerPageSource);
  assert.ok(declared, "docs/player.html should declare VIDEO_ID_PATTERN");
  assert.equal(declared[1], VIDEO_ID_PATTERN.toString());
});

test("the hosted player page keeps a referrer-bearing policy", () => {
  // no-referrer (or same-origin) on this page would strip the Referer the embed requires and
  // playback would fail with Error 153, so pin the policy rather than merely allowing one.
  const policy = /<meta name="referrer" content="([^"]+)">/.exec(playerPageSource);
  assert.ok(policy, "docs/player.html needs an explicit referrer policy");
  assert.equal(policy[1], "strict-origin-when-cross-origin");
});

// WiseNotes crops the captured tab image using the video element's rectangle measured inside the
// iframe, so any offset, margin, or centring in the player page would shift every crop.
test("the hosted player page pins the iframe flush to the viewport origin", () => {
  const css = /#player\s*\{([^}]+)\}/.exec(playerPageSource);
  assert.ok(css, "docs/player.html should style #player");
  for (const rule of ["position: fixed", "inset: 0", "width: 100%", "height: 100%", "border: 0"]) {
    assert.ok(css[1].includes(rule), `#player must declare "${rule}" so crops stay aligned`);
  }
});

test("the content script runs in every frame and only the player frame answers", () => {
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].js.includes("yt-content.js"), true);
  assert.ok(
    ytContentSource.includes("window.top !== window && !isEmbedPage()"),
    "nested frames must not answer capture commands"
  );
});

// Narrowest permissions. Reading a tab's url or title needs the "tabs" permission or a host
// permission for that tab, and WiseNotes never reads them for the player page: it identifies that
// tab by load status instead. Adding "tabs" back would buy the "read your browsing history" warning
// and nothing else, so this test pins the exact set. Update it deliberately, not by accident.
test("the manifest requests only the permissions the extension actually uses", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "clipboardWrite", "offscreen", "scripting", "storage", "tabCapture"]
  );
  assert.ok(!JSON.stringify(manifest).includes('"tabs"'));
});
