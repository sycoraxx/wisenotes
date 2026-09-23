import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionPrompt,
  extractFrameBatch,
  GEMINI_BATCH_SIZE,
  hasUsefulVisualEvidence,
  takeGeminiBatch,
  validateExtractions
} from "../lib/gemini.js";

test("free-tier extraction batches contain up to sixteen selected frames", () => {
  assert.equal(GEMINI_BATCH_SIZE, 16);
});

const retryFrames = [{ t: 1, dataUrl: "data:image/jpeg;base64,AAAA" }];
const fastRetry = { maxRequestAttempts: 3, retryDelayMs: 1 };

const okResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify([{
            index: 0,
            visibleText: "board 0",
            equations: [],
            equationContext: "",
            code: "",
            visualDescription: "",
            useful: true,
            confidence: 0.5
          }])
        }]
      }
    }]
  })
});

const errorResponse = (status) => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: async () => "upstream failure"
});

test("a stalled extraction request is retried and then reported", async () => {
  let calls = 0;
  await assert.rejects(
    extractFrameBatch({
      apiKey: "k",
      frames: retryFrames,
      transcript: [],
      fetchImpl: () => { calls += 1; return new Promise(() => {}); },
      requestTimeoutMs: 20,
      ...fastRetry
    }),
    /did not respond within/
  );
  assert.equal(calls, 3);
});

test("a transient server failure is retried and can still succeed", async () => {
  let calls = 0;
  const result = await extractFrameBatch({
    apiKey: "k",
    frames: retryFrames,
    transcript: [],
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? errorResponse(503) : okResponse();
    },
    requestTimeoutMs: 5_000,
    ...fastRetry
  });
  assert.equal(calls, 3);
  assert.equal(result[0].visibleText, "board 0");
});

test("a rate limit is not retried so the caller can pause instead", async () => {
  let calls = 0;
  await assert.rejects(
    extractFrameBatch({
      apiKey: "k",
      frames: retryFrames,
      transcript: [],
      fetchImpl: async () => { calls += 1; return errorResponse(429); },
      requestTimeoutMs: 5_000,
      ...fastRetry
    }),
    /rate limit/
  );
  assert.equal(calls, 1);
});

test("a permanent client error is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    extractFrameBatch({
      apiKey: "k",
      frames: retryFrames,
      transcript: [],
      fetchImpl: async () => { calls += 1; return errorResponse(403); },
      requestTimeoutMs: 5_000,
      ...fastRetry
    }),
    /403/
  );
  assert.equal(calls, 1);
});

test("cancellation is never retried or mistaken for a timeout", async () => {
  let calls = 0;
  const controller = new AbortController();
  const pending = extractFrameBatch({
    apiKey: "k",
    frames: retryFrames,
    transcript: [],
    // Models real fetch: rejects as soon as the signal aborts.
    fetchImpl: (_url, init) => new Promise((_, reject) => {
      calls += 1;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
    signal: controller.signal,
    requestTimeoutMs: 5_000,
    ...fastRetry
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("large inline frames split before the request body limit", () => {
  const frames = Array.from({ length: 16 }, (_, index) => ({
    t: index,
    dataUrl: `data:image/jpeg;base64,${"A".repeat(100)}`
  }));
  assert.equal(takeGeminiBatch(frames, 0, 16, 350).length, 3);
  assert.equal(takeGeminiBatch(frames, 3, 16, 350)[0].t, 3);
});

test("Gemini prompt explicitly requires image evidence", () => {
  const prompt = buildExtractionPrompt([{ t: 12 }], [{ start: 10, text: "Look at the matrix" }]);
  assert.match(prompt, /Read mathematical notation/);
  assert.match(prompt, /handwritten and typeset mathematics/);
  assert.match(prompt, /Never silently repair/);
  assert.match(prompt, /Image 0: timestamp=12\.00s/);
});

test("Gemini output is normalized to the captured timestamps", () => {
  const output = validateExtractions([{
    index: 0,
    visibleText: "  theorem  ",
    equationsLatex: ["x^2"],
    code: "",
    visualDescription: "board",
    useful: true,
    confidence: 2
  }], [{ t: 42 }]);
  assert.equal(output[0].t, 42);
  assert.equal(output[0].visibleText, "theorem");
  assert.deepEqual(output[0].equations, [{
    latex: "x^2",
    visibleSource: "",
    role: "unknown",
    confidence: 1,
    uncertainTokens: []
  }]);
  assert.equal(output[0].confidence, 1);
});

test("structured handwritten equations retain context and explicit uncertainty", () => {
  const output = validateExtractions([{
    index: 0,
    visibleText: "",
    equations: [{
      latex: "\\[ A\\vec{x} = \\lambda_1\\vec{x} \\]",
      visibleSource: "A x-arrow equals lambda-one x-arrow",
      role: "derivation-step",
      confidence: 0.72,
      uncertainTokens: ["subscript 1"]
    }],
    equationContext: "The board introduces the eigenvector relation; the lambda subscript is faint.",
    code: "",
    visualDescription: "handwritten board",
    useful: true,
    confidence: 0.8
  }], [{ t: 9 }]);
  assert.equal(output[0].equations[0].latex, "A\\vec{x} = \\lambda_1\\vec{x}");
  assert.deepEqual(output[0].equations[0].uncertainTokens, ["subscript 1"]);
  assert.match(output[0].equationContext, /subscript is faint/);
});

test("transcript-only synthesis is rejected when frames yield no evidence", () => {
  assert.equal(hasUsefulVisualEvidence([{ useful: false, visibleText: "slide" }]), false);
  assert.equal(hasUsefulVisualEvidence([{ useful: true, equationsLatex: ["x=1"] }]), true);
});

test("each image is immediately paired with its own nearby transcript", async () => {
  let sentParts;
  const frames = [
    { t: 10, dataUrl: "data:image/jpeg;base64,AA==" },
    { t: 100, dataUrl: "data:image/jpeg;base64,BB==" }
  ];
  await extractFrameBatch({
    apiKey: "test-key",
    frames,
    transcript: [
      { start: 8, text: "first board context" },
      { start: 102, text: "second code context" }
    ],
    fetchImpl: async (_url, options) => {
      sentParts = JSON.parse(options.body).contents[0].parts;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(frames.map((_, index) => ({
            index,
            visibleText: `frame ${index}`,
            equations: [],
            equationContext: "",
            code: "",
            visualDescription: "lecture content",
            useful: true,
            confidence: 0.9
          }))) }] } }]
        })
      };
    }
  });

  assert.equal(sentParts.length, 5);
  assert.match(sentParts[1].text, /first board context/);
  assert.doesNotMatch(sentParts[1].text, /second code context/);
  assert.equal(sentParts[2].inlineData.data, "AA==");
  assert.match(sentParts[3].text, /second code context/);
  assert.doesNotMatch(sentParts[3].text, /first board context/);
  assert.equal(sentParts[4].inlineData.data, "BB==");
});
