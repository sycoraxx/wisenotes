import test from "node:test";
import assert from "node:assert/strict";
import { readFrameWithOcr, normalizeOcrResult, hasUsefulVisualEvidence } from "../lib/ocr.js";

const frame = { t: 42.25, dataUrl: "data:image/jpeg;base64,/9j/2Q==" };
const options = { apiKey: "fake-key", frame, pollIntervalMs: 1, retryDelayMs: 1 };
const response = (payload) => ({ ok: true, status: 200, json: async () => payload });
const output = (content = "# Board\n\\[x^2=1\\]\n```js\nconst x = 1;\n```") => ({
  type: "digitise", job_id: "job-1", status: "completed", usage: { pages_failed: 0 },
  documents: [{ file_name: "lecture-frame.jpg", pages: [{ page_number: 1, content }] }]
});

test("OCR uploads one cropped JPEG, checkpoints its job, polls and keeps raw Markdown", async () => {
  const calls = [];
  let savedJob;
  let polls = 0;
  const result = await readFrameWithOcr({
    ...options, onJobCreated: async (id) => { savedJob = id; },
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.headers["api-subscription-key"], "fake-key");
      if (init.method === "POST") {
        assert.equal(url, "https://api.sarvam.ai/doc-ai/v1/job/digitise");
        assert.equal(init.headers["Content-Type"], undefined);
        assert.equal(init.body.get("file").type, "image/jpeg");
        assert.equal(init.body.getAll("file").length, 1);
        assert.equal(init.body.get("language"), "en-IN");
        assert.equal(init.body.get("content_type"), "mixed");
        assert.equal(init.body.has("transcript"), false);
        return response({ job_id: "job-1", status: "pending" });
      }
      assert.equal(savedJob, "job-1", "checkpoint must precede polling");
      if (url.endsWith("/status")) return response({ status: ++polls === 1 ? "running" : "completed" });
      assert.ok(url.endsWith("/results?format=md"));
      return response(output());
    }
  });
  assert.equal(calls.length, 4);
  assert.equal(result.t, frame.t);
  assert.equal(result.ocrMarkdown, output().documents[0].pages[0].content);
  assert.equal(result.evidenceSource, "sarvam-ocr");
  assert.equal(result.confidence, null);
  assert.deepEqual(result.equations, []);
});

test("a rate limit preserves the job ID and Resume does not upload again", async () => {
  let savedJob;
  await assert.rejects(readFrameWithOcr({
    ...options, onJobCreated: async (id) => { savedJob = id; },
    fetchImpl: async (_url, init) => init.method === "POST"
      ? response({ job_id: "job-1" })
      : { ok: false, status: 429, headers: { get: () => "60" } }
  }), (error) => error.status === 429);
  assert.equal(savedJob, "job-1");
  const result = await readFrameWithOcr({
    ...options, jobId: savedJob,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "GET");
      return response(url.endsWith("/status") ? { status: "completed" } : output());
    }
  });
  assert.equal(result.t, frame.t);
});

test("ambiguous OCR job creation is not automatically repeated", async () => {
  let calls = 0;
  await assert.rejects(readFrameWithOcr({
    ...options,
    fetchImpl: async () => { calls += 1; throw new TypeError("connection lost"); }
  }), /connection lost/);
  assert.equal(calls, 1);
});

test("OCR cancellation stops status polling", async () => {
  const controller = new AbortController();
  let polls = 0;
  await assert.rejects(readFrameWithOcr({
    ...options, jobId: "job-1", signal: controller.signal,
    fetchImpl: async () => { polls += 1; controller.abort(); return response({ status: "running" }); }
  }), { name: "AbortError" });
  assert.equal(polls, 1);
});

for (const status of ["failed", "rejected", "partially_completed"]) {
  test(`OCR ${status} is not accepted as completed evidence`, async () => {
    await assert.rejects(readFrameWithOcr({
      ...options, jobId: "job-1", fetchImpl: async () => response({ status })
    }), (error) => error.ocrJobFailed === true);
  });
}

test("a long-running OCR job has a total deadline", async () => {
  await assert.rejects(readFrameWithOcr({
    ...options, jobId: "job-1", jobTimeoutMs: 15,
    fetchImpl: async () => response({ status: "running" })
  }), /still processing/);
});

test("an OCR result cannot be attached to multiple timestamps through a positional fallback", () => {
  const payload = output();
  payload.documents[0].pages.push({ page_number: 2, content: "another page" });
  assert.throws(() => normalizeOcrResult(payload, frame), /page count/);
  const missingPage = output();
  missingPage.documents = [];
  assert.throws(() => normalizeOcrResult(missingPage, frame), /page count/);
});

test("blank OCR cannot produce transcript-only notes", () => {
  const result = normalizeOcrResult(output("  "), frame);
  assert.equal(result.useful, false);
  assert.equal(hasUsefulVisualEvidence([result]), false);
  assert.equal(hasUsefulVisualEvidence([normalizeOcrResult(output(), frame)]), true);
});

test("a resumed job can fetch evidence even if its JPEG is no longer in memory", async () => {
  const result = await readFrameWithOcr({
    ...options, frame: { t: 7 }, jobId: "job-1",
    fetchImpl: async (url) => response(url.endsWith("/status") ? { status: "completed" } : output())
  });
  assert.equal(result.t, 7);
});

test("OCR uses the original Indic language even when final notes will be English", async () => {
  const result = await readFrameWithOcr({
    ...options, languageCode: "or",
    fetchImpl: async (url, init) => {
      if (init.method === "POST") {
        assert.equal(init.body.get("language"), "od-IN");
        return response({ job_id: "job-1" });
      }
      return response(url.endsWith("/status") ? { status: "completed" } : output("ନମସ୍କାର"));
    }
  });
  assert.equal(result.ocrMarkdown, "ନମସ୍କାର");
});
