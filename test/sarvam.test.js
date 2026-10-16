import test from "node:test";
import assert from "node:assert/strict";
import { sarvamRequest, sarvamJsonCompletion } from "../lib/sarvam.js";

const options = { apiKey: "fake-key", retryDelayMs: 1, requestTimeoutMs: 50 };
const errorResponse = (status, retryAfter = null) => ({
  ok: false, status, headers: { get: () => retryAfter }
});
const okResponse = (value = {}) => ({ ok: true, status: 200, json: async () => value });

test("Sarvam retries transient server errors with the key only in the auth header", async () => {
  let calls = 0;
  const result = await sarvamRequest("/v1/chat/completions", {
    ...options, method: "POST", body: { messages: [] },
    fetchImpl: async (url, init) => {
      assert.equal(url.includes("fake-key"), false);
      assert.equal(init.headers["api-subscription-key"], "fake-key");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      calls += 1;
      return calls < 3 ? errorResponse(503) : okResponse({ success: true });
    }
  });
  assert.equal(calls, 3);
  assert.equal(result.success, true);
});

for (const status of [400, 402, 403, 404, 429]) {
  test(`Sarvam ${status} is not retried`, async () => {
    let calls = 0;
    await assert.rejects(sarvamRequest("/test", {
      ...options, fetchImpl: async () => { calls += 1; return errorResponse(status, "90"); }
    }), (error) => error.status === status && error.retryAfterSeconds === 90);
    assert.equal(calls, 1);
  });
}

test("timeout includes stalled response bodies and retries remain bounded", async () => {
  let calls = 0;
  await assert.rejects(sarvamRequest("/test", {
    ...options, requestTimeoutMs: 10,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: () => new Promise(() => {}) };
    }
  }), /timed out/);
  assert.equal(calls, 3);
});

test("cancellation aborts even a transport that ignores its signal", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = sarvamRequest("/test", {
    ...options, signal: controller.signal, requestTimeoutMs: 10_000,
    fetchImpl: () => { calls += 1; return new Promise(() => {}); }
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("a previously cancelled request sends no network traffic", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sarvamRequest("/test", {
    ...options, signal: controller.signal,
    fetchImpl: () => assert.fail("must not fetch")
  }), { name: "AbortError" });
});

for (const choice of [
  { finish_reason: "length", message: { content: '{"moments":[]}' } },
  { finish_reason: "stop", message: { refusal: "Refused", content: "{}" } },
  { finish_reason: "stop", message: { content: "not JSON" } },
  { finish_reason: "stop", message: { content: null } }
]) {
  test(`invalid planning completion is rejected: ${JSON.stringify(choice)}`, async () => {
    await assert.rejects(sarvamJsonCompletion({
      ...options, name: "test", schema: {}, messages: [],
      fetchImpl: async () => okResponse({ choices: [choice] })
    }));
  });
}
