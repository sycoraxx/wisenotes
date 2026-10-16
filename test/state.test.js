import test from "node:test";
import assert from "node:assert/strict";
import { JOB_STATES, assertTransition, canTransition, publicSession, canResumeSession, migrateSessionToSarvam, applySessionPatch } from "../lib/state.js";

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
    frameExtractions: [{ ocrMarkdown: "private" }],
    activeOcrJob: { frameIndex: 0, jobId: "private" },
    sourceTranscript: [{ start: 0, text: "नमस्ते" }],
    pendingOcrExtraction: { output: { ocrMarkdown: "नमस्ते" } },
    finalPrompt: "private",
    originalPlayback: { scrollY: 900 },
    originalVisualSettings: { availableQualities: ["hd2160"] }
  });
  assert.equal(result.transcript, undefined);
  assert.equal(result.frames, undefined);
  assert.equal(result.finalPrompt, undefined);
  assert.equal(result.geminiExtractions, undefined);
  assert.equal(result.frameExtractions, undefined);
  assert.equal(result.activeOcrJob, undefined);
  assert.equal(result.sourceTranscript, undefined);
  assert.equal(result.pendingOcrExtraction, undefined);
  assert.equal(result.originalPlayback, undefined);
  assert.equal(result.originalVisualSettings, undefined);
  assert.equal(result.frameCount, 1);
  assert.equal(result.hasPrompt, true);
});

test("Resume is offered only for a recoverable checkpoint", () => {
  assert.equal(canResumeSession({ state: "error", transcript: [{ text: "saved" }] }), false);
  assert.equal(canResumeSession({ state: "error", transcript: [{}], planningPending: true }), true);
  assert.equal(canResumeSession({ state: "error", frames: [{}] }), true);
  assert.equal(canResumeSession({ state: "error", extractionComplete: true }), true);
  assert.equal(canResumeSession({ state: "error", transcriptTranslationPending: true, sourceTranscript: [{}] }), true);
  assert.equal(canResumeSession({ state: "cancelled", frames: [{}] }), false);
});

test("legacy sessions retain completed evidence and frame position when switching providers", () => {
  const patch = migrateSessionToSarvam({
    model: "old-provider", geminiExtractions: [{ t: 1, visibleText: "saved board" }],
    nextGeminiFrameIndex: 1, frames: [{ t: 1 }, { t: 2 }]
  });
  assert.equal(patch.model, "sarvam-105b");
  assert.equal(patch.provider, "sarvam");
  assert.equal(patch.nextFrameIndex, 1);
  assert.equal(patch.frameExtractions[0].visibleText, "saved board");
  assert.equal(patch.extractionComplete, false);
  assert.equal(migrateSessionToSarvam({ frames: [], geminiExtractions: [{}] }).extractionComplete, true);
});

test("a late asynchronous state write cannot resurrect a cancelled session", () => {
  assert.throws(() => applySessionPatch({ state: "cancelled" }, { state: "capturing" }), { name: "AbortError" });
  assert.equal(applySessionPatch({ state: "cancelled" }, { activeOcrJob: { jobId: "saved" } }).state, "cancelled");
});
