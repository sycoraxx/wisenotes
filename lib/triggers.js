const TRIGGER_GROUPS = [
  {
    score: 4,
    reason: "explicit visual cue",
    pattern: /\b(as you can see|look at (?:this|here)|here we have|notice (?:this|that)|on (?:the )?(?:slide|board|screen)|shown (?:here|below))\b/i
  },
  {
    score: 4,
    reason: "drawing or writing cue",
    pattern: /\b(let me (?:write|draw|show)|I(?:'|’)ll (?:write|draw|show)|writing (?:this|it) (?:out|down)|draw (?:a|the|this))\b/i
  },
  {
    score: 3,
    reason: "visual object",
    pattern: /\b(this|the) (?:equation|formula|slide|figure|graph|plot|diagram|matrix|table|code|chart|proof)\b/i
  },
  {
    score: 2,
    reason: "mathematical notation",
    pattern: /\b(alpha|beta|gamma|theta|lambda|sigma|integral|summation|sum over|derivative|gradient|matrix|vector|eigenvalue|limit|theorem)\b/i
  },
  {
    score: 2,
    reason: "code cue",
    pattern: /\b(run this|the output|this function|this class|the compiler|in the code|code snippet|terminal)\b/i
  }
];

export function scoreSegment(text = "") {
  let score = 0;
  const reasons = [];
  for (const group of TRIGGER_GROUPS) {
    if (group.pattern.test(text)) {
      score += group.score;
      reasons.push(group.reason);
    }
  }
  return { score, reasons };
}

export function findTriggers(segments, minGapSeconds = 8) {
  const hits = [];
  for (const segment of segments ?? []) {
    const start = Number(segment.start);
    if (!Number.isFinite(start)) continue;
    const scored = scoreSegment(segment.text);
    if (scored.score > 0) {
      hits.push({ t: start, score: scored.score, reasons: scored.reasons });
    }
  }

  hits.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const hit of hits) {
    const previous = merged.at(-1);
    if (!previous || hit.t - previous.t >= minGapSeconds) {
      merged.push(hit);
      continue;
    }
    if (hit.score > previous.score) merged[merged.length - 1] = hit;
  }
  return merged;
}
