import test from "node:test";
import assert from "node:assert/strict";
import { buildSynthesisPrompt, formatTime, mergeTranscriptWindows } from "../lib/prompt.js";

test("transcript windows merge and retain every relevant segment", () => {
  const segments = [0, 20, 50, 80, 120].map((start) => ({ start, text: `At ${start}` }));
  assert.deepEqual(
    mergeTranscriptWindows(segments, [30, 90], 20).map((segment) => segment.start),
    [20, 50, 80]
  );
});

test("time formatting covers short and long lectures", () => {
  assert.equal(formatTime(65), "1:05");
  assert.equal(formatTime(3661), "1:01:01");
});

test("synthesis prompt makes frame evidence authoritative", () => {
  const prompt = buildSynthesisPrompt({
    title: "Linear Algebra",
    videoUrl: "https://www.youtube.com/watch?v=test",
    transcript: [{ start: 0, text: "The caption says x." }],
    extractions: [{
      t: 2,
      visibleText: "A v = lambda v",
      equations: [{
        latex: "A v = \\lambda v",
        visibleSource: "A v equals lambda v",
        role: "definition",
        confidence: 0.95,
        uncertainTokens: []
      }],
      equationContext: "The slide defines an eigenvector and its eigenvalue.",
      code: "",
      visualDescription: "Eigenvector equation",
      confidence: 0.95,
      useful: true
    }]
  });
  assert.match(prompt, /Frame extractions are the ground truth/);
  assert.match(prompt, /visual ordering/);
  assert.match(prompt, /The slide defines an eigenvector/);
  assert.match(prompt, /A v =/);
  assert.match(prompt, /Linear Algebra\.tex/);
  assert.match(prompt, /interface supports named files or artifacts/);
  assert.doesNotMatch(prompt, /Claude/i);
});
