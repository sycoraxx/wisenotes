import { SarvamError, sarvamRequest, abortableDelay, throwIfCancelled } from "./sarvam.js";
import { normalizeLanguageCode } from "./languages.js";

export const OCR_MODEL_LABEL = "Sarvam Vision (Document AI)";
const TERMINAL_STATES = new Set(["completed", "partially_completed", "failed", "rejected"]);

// One JPEG per job makes timestamp provenance exact, even if Sarvam returns files out of
// order. Persist the returned job id before polling so Resume never reuploads a known job.
export async function readFrameWithOcr({
  frame, jobId = "", onJobCreated, apiKey, signal, fetchImpl = fetch,
  pollIntervalMs = 5000, jobTimeoutMs = 10 * 60_000, languageCode = "en-IN", ...requestOptions
}) {
  const deadline = Date.now() + jobTimeoutMs;
  const request = (path, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SarvamError("Sarvam OCR is still processing. Choose Resume to check the saved job.");
    return sarvamRequest(path, {
      ...requestOptions, apiKey, signal, fetchImpl,
      deadline,
      requestTimeoutMs: Math.min(requestOptions.requestTimeoutMs ?? 120_000, remaining),
      ...options
    });
  };
  throwIfCancelled(signal);
  if (!jobId) {
    const match = String(frame?.dataUrl || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new SarvamError(`Frame at ${frame?.t}s has no JPEG payload.`);
    const bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/jpeg" }), "lecture-frame.jpg");
    const language = normalizeLanguageCode(languageCode);
    if (!language) throw new SarvamError("Select a supported OCR language in WiseNotes settings.");
    form.append("language", language);
    form.append("content_type", "mixed");
    // Do not retry creation automatically: a lost response may still have created a billable
    // job. Only status/results (which are safe to repeat) use transient retries.
    const created = await request("/doc-ai/v1/job/digitise", { method: "POST", body: form, maxAttempts: 1 });
    jobId = created?.job_id;
    if (typeof jobId !== "string" || !jobId.trim()) throw new SarvamError("Sarvam OCR did not return a job ID.");
    await onJobCreated?.(jobId);
  }

  const path = `/doc-ai/v1/job/${encodeURIComponent(jobId)}`;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    const result = await request(`${path}/status`);
    const status = String(result?.status || "").toLowerCase();
    if (TERMINAL_STATES.has(status)) {
      if (status !== "completed" || Number(result?.usage?.pages_failed) > 0) {
        const error = new SarvamError(`Sarvam OCR job ${status}. This frame was not accepted as visual evidence.`);
        error.ocrJobFailed = true;
        throw error;
      }
      const output = await request(`${path}/results?format=md`);
      return normalizeOcrResult(output, frame);
    }
    if (!["pending", "running"].includes(status)) throw new SarvamError("Sarvam OCR returned an unknown job status.");
    await abortableDelay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
  }
  throw new SarvamError("Sarvam OCR is still processing. Choose Resume to check the saved job.");
}

export function normalizeOcrResult(payload, frame) {
  if (payload?.type !== "digitise" || payload?.status !== "completed"
    || Number(payload?.usage?.pages_failed) > 0) {
    throw new SarvamError("Sarvam OCR returned incomplete frame results.");
  }
  const documents = payload.documents;
  if (!Array.isArray(documents) || documents.length !== 1
    || !Array.isArray(documents[0].pages) || documents[0].pages.length !== 1) {
    throw new SarvamError("Sarvam OCR returned an unexpected page count for a single lecture frame.");
  }
  const content = documents[0].pages[0].content;
  if (typeof content !== "string") throw new SarvamError("Sarvam OCR returned no readable page content.");
  return {
    t: Number(frame.t),
    visibleText: content.trim(),
    ocrMarkdown: content.trim(),
    evidenceSource: "sarvam-ocr",
    equations: [],
    equationsLatex: [],
    equationContext: "",
    code: "",
    visualDescription: "",
    useful: Boolean(content.trim()),
    // The page-content endpoint supplies no confidence. Never manufacture certainty.
    confidence: null
  };
}

export function hasUsefulVisualEvidence(extractions) {
  return (extractions ?? []).some((item) => item.useful !== false && Boolean(
    item.visibleText || item.ocrMarkdown || item.code || item.visualDescription
      || item.equations?.length || item.equationsLatex?.length
  ));
}
