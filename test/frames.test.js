import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAMES_PER_MINUTE,
  blurRecoveryOffsets,
  buildCapturePlan,
  chooseClearestNearbyFrame,
  deduplicateFrames,
  frameBudget,
  lateTriggerCaptures,
  selectFrames
} from "../lib/frames.js";

// Frames scale linearly and are never capped, so a longer lecture keeps getting more evidence
// instead of being thinned out to the same handful of captures.
test("the frame budget scales linearly and is never capped", () => {
  assert.equal(frameBudget(30 * 60), 18);
  assert.equal(frameBudget(60 * 60), 36);
  assert.equal(frameBudget(120 * 60), 72);
  assert.equal(frameBudget(5 * 60), 3);
  assert.equal(frameBudget(3 * 60 * 60), 108);
  assert.equal(frameBudget(10 * 60 * 60), 360);
  for (const minutes of [10, 45, 90, 240, 600]) {
    assert.equal(frameBudget(minutes * 60), Math.ceil(minutes * FRAMES_PER_MINUTE));
  }
  // A floor of one keeps an empty plan out of reach for very short clips.
  assert.equal(frameBudget(0), 1);
  assert.equal(frameBudget(5), 1);
});

test("capture plan combines local probes and trigger settling", () => {
  const plan = buildCapturePlan(100, [{ t: 20, score: 4 }], 30);
  assert.ok(plan.some((item) => item.source === "probe"));
  assert.ok(plan.some((item) => item.t === 23 && item.source === "trigger-early"));
  assert.ok(plan.some((item) => item.t === 28 && item.source === "trigger-late"));
});

test("changing trigger frames request a later settled capture", () => {
  const late = lateTriggerCaptures([
    { t: 13, triggerBase: 10, triggerScore: 4, hash: "0000000000000000" },
    { t: 18, triggerBase: 10, triggerScore: 4, hash: "ffffffffffffffff" }
  ], 100);
  assert.deepEqual(late.map((item) => item.t), [25]);
});

test("near-identical frames deduplicate and selection honors budget", () => {
  const frames = [
    { t: 1, hash: "0000000000000000", sharpness: 5, triggerScore: 0 },
    { t: 2, hash: "0000000000000001", sharpness: 10, triggerScore: 2 },
    { t: 20, hash: "ffffffffffffffff", sharpness: 8, triggerScore: 0 }
  ];
  assert.equal(deduplicateFrames(frames).length, 2);
  assert.equal(selectFrames(frames, 30, 1).length, 1);
});

test("blur recovery samples nearby only when the frame is soft", () => {
  assert.deepEqual(blurRecoveryOffsets(20), [-1.25, 1.25]);
  assert.deepEqual(blurRecoveryOffsets(200), []);
});

test("blur recovery chooses a meaningfully sharper same-scene frame", () => {
  const base = { t: 10, hash: "0000000000000000", sharpness: 40 };
  const chosen = chooseClearestNearbyFrame(base, [
    { t: 8.75, hash: "0000000000000001", sharpness: 44 },
    { t: 11.25, hash: "0000000000000003", sharpness: 70 }
  ]);
  assert.equal(chosen.t, 11.25);
});

test("blur recovery rejects a sharper frame from a different scene", () => {
  const base = { t: 10, hash: "0000000000000000", sharpness: 40 };
  const chosen = chooseClearestNearbyFrame(base, [
    { t: 11.25, hash: "ffffffffffffffff", sharpness: 200 }
  ]);
  assert.equal(chosen, base);
});
