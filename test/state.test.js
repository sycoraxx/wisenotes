import test from "node:test";
import assert from "node:assert/strict";
import { JOB_STATES, assertTransition, canTransition, publicSession } from "../lib/state.js";

test("pipeline state transitions reject impossible jumps", () => {
  assert.equal(canTransition(JOB_STATES.IDLE, JOB_STATES.TRANSCRIPT), true);
  assert.equal(canTransition(JOB_STATES.TRANSCRIPT, JOB_STATES.READY), false);
  assert.throws(() => assertTransition(JOB_STATES.CAPTURING, JOB_STATES.READY), /Invalid/);
});

test("the capture-window handshake can only progress into capture", () => {
  assert.equal(canTransition(JOB_STATES.TRANSCRIPT, JOB_STATES.AWAITING_CAPTURE_WINDOW), true);
  assert.equal(canTransition(JOB_STATES.AWAITING_CAPTURE_WINDOW, JOB_STATES.CAPTURING), true);
  assert.equal(canTransition(JOB_STATES.AWAITING_CAPTURE_WINDOW, JOB_STATES.EXTRACTING), false);
  assert.equal(canTransition(JOB_STATES.CAPTURING, JOB_STATES.AWAITING_CAPTURE_WINDOW), false);
  assert.equal(canTransition(JOB_STATES.AWAITING_CAPTURE_WINDOW, JOB_STATES.CANCELLED), true);
});

test("timestamp planning can pause and resume before capture", () => {
  assert.equal(canTransition(JOB_STATES.TRANSCRIPT, JOB_STATES.PAUSED_RATE_LIMIT), true);
  assert.equal(canTransition(JOB_STATES.PAUSED_RATE_LIMIT, JOB_STATES.TRANSCRIPT), true);
  assert.equal(canTransition(JOB_STATES.ERROR, JOB_STATES.TRANSCRIPT), true);
});

test("public sessions do not leak transcript, frames, prompt, or extractions", () => {
  const result = publicSession({
    sessionId: "s",
    transcript: [{ start: 0, text: "private" }],
    frames: [{ dataUrl: "large" }],
    geminiExtractions: [{ visibleText: "private" }],
    finalPrompt: "private",
    originalPlayback: { scrollY: 900 },
    originalVisualSettings: { availableQualities: ["hd2160"] }
  });
  assert.equal(result.transcript, undefined);
  assert.equal(result.frames, undefined);
  assert.equal(result.finalPrompt, undefined);
  assert.equal(result.originalPlayback, undefined);
  assert.equal(result.originalVisualSettings, undefined);
  assert.equal(result.frameCount, 1);
  assert.equal(result.hasPrompt, true);
});
