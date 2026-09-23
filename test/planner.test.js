import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFramePlanningPrompt,
  inferFrameTriggers,
  plannerMomentBudget,
  preferPreviouslySuccessfulModel,
  rankFlashModels,
  validateFramePlan
} from "../lib/planner.js";

test("semantic planner budget grows with lecture duration and stays bounded", () => {
  assert.equal(plannerMomentBudget(5 * 60), 8);
  assert.equal(plannerMomentBudget(30 * 60), 8);
  assert.equal(plannerMomentBudget(120 * 60), 30);
  assert.equal(plannerMomentBudget(5 * 60 * 60), 32);
});

test("planning prompt requests semantic visual inference and treats transcript as untrusted", () => {
  const prompt = buildFramePlanningPrompt(
    [{ start: 12, text: "Suppose the arrows commute in the natural way." }],
    120,
    8
  );
  assert.match(prompt, /semantically implies/i);
  assert.match(prompt, /high-value visual windows/i);
  assert.match(prompt, /physical boards/i);
  assert.match(prompt, /facecams over code/i);
  assert.match(prompt, /untrusted lecture data/i);
  assert.match(prompt, /\[0:12\]/);
});

test("planned moments are validated, snapped to transcript timestamps, and deduplicated", () => {
  const transcript = [
    { start: 10, text: "first" },
    { start: 17, text: "second" },
    { start: 40, text: "third" }
  ];
  const plan = validateFramePlan({ moments: [
    { timestampSeconds: 11.8, score: 3, visualKind: "diagram", reason: "diagram appears" },
    {
      timestampSeconds: 17.2,
      endTimestampSeconds: 35,
      score: 5,
      visualKind: "equation",
      incremental: true,
      reason: "derivation begins"
    },
    { timestampSeconds: 500, score: 5, visualKind: "slide", reason: "outside lecture" },
    { timestampSeconds: 40.4, score: 2, visualKind: "code", reason: "too weak" }
  ] }, transcript, 60, 8);
  assert.deepEqual(plan.map((item) => item.t), [17]);
  assert.equal(plan[0].score, 5);
  assert.equal(plan[0].source, "semantic-planner");
  assert.equal(plan[0].incremental, true);
  assert.equal(plan[0].windowStart, 10);
  assert.equal(plan[0].windowEnd, 35);
});

test("planner windows remain seekable at the exact end of a lecture", () => {
  const plan = validateFramePlan({ moments: [{
    timestampSeconds: 60,
    endTimestampSeconds: 80,
    score: 5,
    visualKind: "board-work",
    incremental: true,
    reason: "final board result"
  }] }, [{ start: 60, text: "That is the final result." }], 60, 8);
  assert.equal(plan[0].t, 59.75);
  assert.equal(plan[0].windowEnd, 60);
});

test("semantic planning sends the complete transcript in one model request", async () => {
  let generationCalls = 0;
  let requestBody;
  const plan = await inferFrameTriggers({
    apiKey: "test-key",
    transcript: [
      { start: 5, text: "The first visual idea" },
      { start: 50, text: "The final visual idea" }
    ],
    durationSeconds: 60,
    fetchImpl: async (url, options) => {
      if (options.method === "GET") {
        return successfulResponse({ models: [{
          name: "models/gemini-3.8-flash",
          baseModelId: "gemini-3.8-flash",
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: 1_000_000,
          thinking: true
        }] });
      }
      generationCalls += 1;
      requestBody = JSON.parse(options.body);
      assert.match(url, /gemini-3\.8-flash:generateContent/);
      return successfulResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({ moments: [{
                timestampSeconds: 50,
                score: 5,
                visualKind: "diagram",
                reason: "A final diagram is introduced"
              }] })
            }]
          }
        }]
      });
    }
  });
  const sentPrompt = requestBody.contents[0].parts[0].text;
  assert.equal(generationCalls, 1);
  assert.match(sentPrompt, /The first visual idea/);
  assert.match(sentPrompt, /The final visual idea/);
  assert.equal(plan.model, "gemini-3.8-flash");
  assert.deepEqual(plan.triggers.map((item) => item.t), [50]);
});

test("model discovery ranks explicit stable full Flash before Flash-Lite", () => {
  const methods = ["generateContent"];
  assert.deepEqual(rankFlashModels([
    { baseModelId: "gemini-3.7-flash", supportedGenerationMethods: methods },
    { baseModelId: "gemini-3.8-flash-lite", supportedGenerationMethods: methods },
    { baseModelId: "gemini-3.8-flash", supportedGenerationMethods: methods },
    { baseModelId: "gemini-flash-latest", supportedGenerationMethods: methods },
    { baseModelId: "gemini-4-flash-preview", supportedGenerationMethods: methods },
    { baseModelId: "gemini-3.9-flash-live", supportedGenerationMethods: methods },
    { baseModelId: "gemini-9-pro", supportedGenerationMethods: methods }
  ]), [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash-lite"
  ]);
});

test("the last successful discovered model is attempted first", () => {
  assert.deepEqual(preferPreviouslySuccessfulModel([
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.5-flash-lite"
  ], "gemini-3.7-flash"), [
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite"
  ]);
});

test("a repeatedly unavailable model falls through to the next accessible Flash model", async () => {
  let firstModelAttempts = 0;
  let secondModelAttempts = 0;
  const result = await inferFrameTriggers({
    apiKey: "test-key",
    transcript: [{ start: 10, text: "A diagram is introduced." }],
    durationSeconds: 60,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      if (options.method === "GET") {
        return successfulResponse({ models: [
          {
            baseModelId: "gemini-3.8-flash",
            supportedGenerationMethods: ["generateContent"]
          },
          {
            baseModelId: "gemini-3.7-flash",
            supportedGenerationMethods: ["generateContent"]
          }
        ] });
      }
      if (url.includes("gemini-3.8-flash")) {
        firstModelAttempts += 1;
        return errorResponse(503);
      }
      secondModelAttempts += 1;
      return successfulResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ moments: [] }) }] } }]
      });
    }
  });
  assert.equal(firstModelAttempts, 4);
  assert.equal(secondModelAttempts, 1);
  assert.equal(result.model, "gemini-3.7-flash");
});

test("planning attempts every discovered stable Flash candidate", async () => {
  const attempted = [];
  const models = ["3.8", "3.7", "3.6", "3.5", "3.4"].map((version) => ({
    baseModelId: `gemini-${version}-flash`,
    supportedGenerationMethods: ["generateContent"]
  }));
  const result = await inferFrameTriggers({
    apiKey: "test-key",
    transcript: [{ start: 10, text: "A diagram is introduced." }],
    durationSeconds: 60,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      if (options.method === "GET") return successfulResponse({ models });
      const model = decodeURIComponent(url.match(/models\/(.+):generateContent/)[1]);
      attempted.push(model);
      if (model !== "gemini-3.4-flash") return errorResponse(503);
      return successfulResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ moments: [] }) }] } }]
      });
    }
  });
  assert.equal(result.model, "gemini-3.4-flash");
  assert.equal(attempted.filter((model) => model === "gemini-3.4-flash").length, 1);
  assert.ok(attempted.length > 4);
});

test("a planner 429 is returned without trying another model", async () => {
  let generationCalls = 0;
  await assert.rejects(() => inferFrameTriggers({
    apiKey: "test-key",
    transcript: [{ start: 10, text: "A diagram is introduced." }],
    durationSeconds: 60,
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") {
        return successfulResponse({ models: [
          { baseModelId: "gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
          { baseModelId: "gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] }
        ] });
      }
      generationCalls += 1;
      return errorResponse(429, "75");
    }
  }), (error) => error.status === 429 && error.retryAfterSeconds === 75);
  assert.equal(generationCalls, 1);
});

function successfulResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload
  };
}

function errorResponse(status, retryAfter = null) {
  return {
    ok: false,
    status,
    headers: { get: (name) => name === "Retry-After" ? retryAfter : null },
    text: async () => JSON.stringify({ error: { code: status } })
  };
}
