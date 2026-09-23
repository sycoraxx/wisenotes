export const JOB_STATES = Object.freeze({
  IDLE: "idle",
  TRANSCRIPT: "transcript",
  AWAITING_CAPTURE_WINDOW: "awaiting_capture_window",
  CAPTURING: "capturing",
  EXTRACTING: "extracting",
  STAGING: "staging",
  READY: "ready",
  PAUSED_RATE_LIMIT: "paused_rate_limit",
  CANCELLED: "cancelled",
  ERROR: "error"
});

const TRANSITIONS = new Map([
  [JOB_STATES.IDLE, new Set([JOB_STATES.TRANSCRIPT, JOB_STATES.CANCELLED, JOB_STATES.ERROR])],
  [JOB_STATES.TRANSCRIPT, new Set([
    JOB_STATES.AWAITING_CAPTURE_WINDOW,
    JOB_STATES.CAPTURING,
    JOB_STATES.PAUSED_RATE_LIMIT,
    JOB_STATES.CANCELLED,
    JOB_STATES.ERROR
  ])],
  [JOB_STATES.AWAITING_CAPTURE_WINDOW, new Set([
    JOB_STATES.CAPTURING,
    JOB_STATES.CANCELLED,
    JOB_STATES.ERROR
  ])],
  [JOB_STATES.CAPTURING, new Set([JOB_STATES.EXTRACTING, JOB_STATES.CANCELLED, JOB_STATES.ERROR])],
  [JOB_STATES.EXTRACTING, new Set([
    JOB_STATES.STAGING,
    JOB_STATES.PAUSED_RATE_LIMIT,
    JOB_STATES.CANCELLED,
    JOB_STATES.ERROR
  ])],
  [JOB_STATES.PAUSED_RATE_LIMIT, new Set([
    JOB_STATES.TRANSCRIPT,
    JOB_STATES.EXTRACTING,
    JOB_STATES.CANCELLED,
    JOB_STATES.ERROR
  ])],
  [JOB_STATES.STAGING, new Set([JOB_STATES.READY, JOB_STATES.CANCELLED, JOB_STATES.ERROR])],
  [JOB_STATES.READY, new Set()],
  [JOB_STATES.CANCELLED, new Set()],
  [JOB_STATES.ERROR, new Set([
    JOB_STATES.TRANSCRIPT,
    JOB_STATES.EXTRACTING,
    JOB_STATES.STAGING,
    JOB_STATES.CANCELLED
  ])]
]);

export function canTransition(from, to) {
  return from === to || Boolean(TRANSITIONS.get(from)?.has(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`);
  }
}

export function publicSession(session) {
  if (!session) return null;
  const {
    frames,
    frameTriggers,
    originalPlayback,
    originalVisualSettings,
    transcript,
    finalPrompt,
    geminiExtractions,
    ...safe
  } = session;
  return {
    ...safe,
    frameCount: Array.isArray(frames) ? frames.length : 0,
    transcriptSegmentCount: Array.isArray(transcript) ? transcript.length : 0,
    extractionCount: Array.isArray(geminiExtractions) ? geminiExtractions.length : 0,
    hasPrompt: Boolean(finalPrompt)
  };
}
