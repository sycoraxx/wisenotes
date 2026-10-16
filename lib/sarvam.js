export const SARVAM_API_ORIGIN = "https://api.sarvam.ai";
export const SARVAM_LLM_MODEL = "sarvam-105b";

export class SarvamError extends Error {
  constructor(message, { status = 0, retryAfterSeconds = 0 } = {}) {
    super(message);
    this.name = "SarvamError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

export function abortableDelay(ms, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new DOMException("Operation cancelled", "AbortError"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// Bound the complete request, including reading the body, and cancel even if a transport
// ignores AbortSignal. A 429 always goes back to the session's pause/resume flow.
export async function sarvamRequest(path, {
  apiKey, method = "GET", body, signal, fetchImpl = fetch,
  requestTimeoutMs = 120_000, maxAttempts = 3, retryDelayMs = 2000, deadline = Infinity
} = {}) {
  if (!apiKey) throw new SarvamError("Add your Sarvam API key in WiseNotes settings first.");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfCancelled(signal);
    if (Date.now() >= deadline) throw new SarvamError("Sarvam OCR is still processing. Choose Resume to check the saved job.");
    const controller = new AbortController();
    let timer;
    let cancel;
    const interrupted = new Promise((_, reject) => {
      cancel = () => {
        const error = new DOMException("Operation cancelled", "AbortError");
        controller.abort(error);
        reject(error);
      };
      timer = setTimeout(() => {
        const error = new SarvamError("The Sarvam request timed out. Choose Resume to try again.", { status: 408 });
        controller.abort(error);
        reject(error);
      }, Math.min(requestTimeoutMs, deadline - Date.now()));
      signal?.addEventListener("abort", cancel, { once: true });
    });
    let retry = false;
    try {
      const request = async () => {
        const multipart = body instanceof FormData;
        const response = await fetchImpl(`${SARVAM_API_ORIGIN}${path}`, {
          method,
          headers: {
            "api-subscription-key": apiKey,
            ...(body && !multipart ? { "Content-Type": "application/json" } : {})
          },
          ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
          signal: controller.signal,
          credentials: "omit",
          redirect: "error"
        });
        if (!response.ok) {
          const labels = {
            402: "Sarvam credits or billing are unavailable.",
            403: "Sarvam rejected the API key or this account's API access.",
            429: "Sarvam rate limit reached. Your completed work was saved."
          };
          throw new SarvamError(labels[response.status] || `Sarvam request failed (${response.status}).`, {
            status: response.status,
            retryAfterSeconds: parseRetryAfter(response.headers?.get?.("Retry-After"))
          });
        }
        return response.json();
      };
      return await Promise.race([request(), interrupted]);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new DOMException("Operation cancelled", "AbortError");
      }
      retry = error instanceof TypeError || (error instanceof SarvamError
        && (error.status === 408 || error.status >= 500));
      if (!retry || attempt === maxAttempts - 1) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    if (retry) await abortableDelay(Math.min(retryDelayMs * 2 ** attempt, Math.max(0, deadline - Date.now())), signal);
  }
  throw new SarvamError("The Sarvam request failed.");
}

export async function sarvamJsonCompletion({
  messages, schema, name, taskLabel = "timestamp plan", maxTokens = 4096,
  reasoningEffort = "low", ...requestOptions
}) {
  const payload = await sarvamRequest("/v1/chat/completions", {
    ...requestOptions,
    method: "POST",
    body: {
      model: SARVAM_LLM_MODEL,
      messages,
      temperature: 0.1,
      reasoning_effort: reasoningEffort,
      // The Starter plan caps completion tokens (including reasoning) at 4096.
      max_tokens: maxTokens,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name, strict: true, schema }
      }
    }
  });
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason !== "stop" || choice?.message?.refusal) {
    throw new SarvamError(`Sarvam did not complete ${taskLabel}. Choose Resume to retry.`);
  }
  const text = choice?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new SarvamError(`Sarvam returned no ${taskLabel}.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new SarvamError(`Sarvam returned malformed JSON for ${taskLabel}.`);
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
}
