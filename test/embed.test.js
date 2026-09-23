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
  buildEmbedUrl,
  durationMatches,
  isEmbedPath,
  isEmbedUrl,
  paceDelayMs,
  parseWidgetMessage
} from "../lib/embed.js";

const ytContentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "yt-content.js"),
  "utf8"
);

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
