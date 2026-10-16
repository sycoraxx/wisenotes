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
  assert.match(prompt, /Frame extractions are the visual evidence/);
  assert.match(prompt, /visual ordering/);
  assert.match(prompt, /The slide defines an eigenvector/);
  assert.match(prompt, /A v =/);
  assert.match(prompt, /Linear Algebra\.tex/);
  assert.match(prompt, /interface supports named files or artifacts/);
  assert.doesNotMatch(prompt, /Claude/i);
});

test("OCR evidence remains verbatim and its confidence and geometry limits are disclosed", () => {
  const markdown = "\\[x = \\frac{1}{2}\\]\n```py\nif x:\n    print(x)\n```";
  const prompt = buildSynthesisPrompt({
    title: "Board", transcript: [], extractions: [{
      t: 12, evidenceSource: "sarvam-ocr", ocrMarkdown: markdown,
      visibleText: markdown, confidence: null, useful: true
    }]
  });
  const evidence = JSON.parse(prompt.split("<FRAME_EXTRACTIONS>\n")[1].split("\n</FRAME_EXTRACTIONS>")[0]);
  assert.equal(evidence.ocrMarkdown, markdown);
  assert.equal(evidence.confidence, null);
  assert.match(prompt, /machine readings, not verified transcriptions/);
  assert.match(prompt, /Never invent a diagram/);
});

test("Indic evidence has an English rendering and the final document explicitly requires English", () => {
  const prompt = buildSynthesisPrompt({
    title: "गणित", transcript: [{ start: 1, text: "We now differentiate." }],
    extractions: [{ t: 2, ocrMarkdown: "अवकलज $x^2$", englishOcrMarkdown: "Derivative $x^2$", ocrSourceLanguageCode: "hi-IN", useful: true }]
  });
  assert.match(prompt, /Write the title, headings, explanations, table labels, and recap in English/);
  assert.match(prompt, /Translate any remaining Indic prose faithfully/);
  assert.match(prompt, /Derivative \$x\^2\$/);
  assert.match(prompt, /अवकलज/);
  assert.match(prompt, /Translation is not additional visual evidence/);
});
