import { hammingHex } from "./dhash.js";

export const BLUR_SHARPNESS_THRESHOLD = 85;
export const BLUR_RECOVERY_OFFSETS = Object.freeze([-1.25, 1.25]);

const REGION_CHANGE_DISTANCE = 18;
const REGION_STABLE_DISTANCE = 10;

// This is a hard Gemini-bound ceiling, not a requirement to fill every slot. Local scouting may
// inspect many more frames. Interpolate between the three duration targets so the budget grows
// smoothly without a large jump at 30 or 60 minutes.
export function frameBudget(durationSeconds) {
  const minutes = Math.max(0, Number(durationSeconds) || 0) / 60;
  if (minutes <= 30) return Math.max(8, Math.ceil((minutes / 30) * 23));
  if (minutes <= 60) return Math.ceil(23 + ((minutes - 30) / 30) * 17);
  return Math.min(60, Math.ceil(40 + ((minutes - 60) / 60) * 20));
}

export function buildCapturePlan(durationSeconds, triggers, intervalSeconds = 30) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const points = new Map();
  const put = (t, metadata) => {
    const clamped = Math.max(0, Math.min(duration - 0.25, t));
    if (!Number.isFinite(clamped) || clamped < 0 || duration <= 0) return;
    const key = clamped.toFixed(2);
    const existing = points.get(key);
    if (!existing || (metadata.triggerScore ?? 0) > (existing.triggerScore ?? 0)) {
      points.set(key, { t: clamped, ...metadata });
    }
  };

  for (let t = Math.min(5, duration / 2); t < duration; t += intervalSeconds) {
    put(t, {
      source: "probe",
      triggerScore: 0,
      triggerBase: null,
      windowId: null,
      visualKind: "coverage",
      incremental: false
    });
  }

  for (const [index, trigger] of (triggers ?? []).entries()) {
    const start = clamp(Number(trigger.windowStart ?? trigger.t), 0, duration);
    const fallbackWindow = defaultWindowSeconds(trigger.visualKind, trigger.incremental);
    const end = clamp(
      Number(trigger.windowEnd) > start ? Number(trigger.windowEnd) : start + fallbackWindow,
      start + 2,
      Math.min(duration, start + 45)
    );
    const windowId = trigger.windowId || `visual-${index}-${start.toFixed(2)}`;
    const common = {
      triggerScore: trigger.score,
      triggerBase: trigger.t,
      windowId,
      windowStart: start,
      windowEnd: end,
      visualKind: trigger.visualKind || "other",
      incremental: Boolean(trigger.incremental)
    };

    const samples = trigger.incremental
      ? [
        [start + 2, "window-start"],
        [start + 5, "window-growing"],
        [start + 8, "window-growing"],
        [start + 12, "window-late"],
        [end - 0.75, "window-peak"]
      ]
      : [
        [start + 3, "trigger-early"],
        [start + 8, "trigger-late"],
        [end - 0.75, "window-peak"]
      ];

    for (const [time, source] of samples) {
      if (time >= start && time <= end) put(time, { ...common, source });
    }
  }

  return [...points.values()].sort((a, b) => a.t - b.t);
}

export function lateTriggerCaptures(captured, durationSeconds, threshold = 8) {
  const byTrigger = new Map();
  for (const frame of captured ?? []) {
    if (frame.triggerBase == null) continue;
    const list = byTrigger.get(frame.triggerBase) ?? [];
    list.push(frame);
    byTrigger.set(frame.triggerBase, list);
  }

  const late = [];
  for (const [triggerBase, frames] of byTrigger) {
    const sorted = frames.sort((a, b) => a.t - b.t);
    if (sorted.length < 2) continue;
    const first = sorted[0];
    const second = sorted.at(-1);
    if (hammingHex(first.hash, second.hash) > threshold) {
      const t = Math.min(Number(durationSeconds) - 0.25, triggerBase + 15);
      if (t > second.t + 0.5) {
        late.push({
          t,
          source: "trigger-settled",
          triggerScore: Math.max(first.triggerScore ?? 0, second.triggerScore ?? 0),
          triggerBase,
          windowId: first.windowId || second.windowId || null,
          visualKind: first.visualKind || second.visualKind || "other",
          incremental: Boolean(first.incremental || second.incremental)
        });
      }
    }
  }
  return late.sort((a, b) => a.t - b.t);
}

export function blurRecoveryOffsets(sharpness, threshold = BLUR_SHARPNESS_THRESHOLD) {
  const score = Number(sharpness);
  return !Number.isFinite(score) || score < threshold ? [...BLUR_RECOVERY_OFFSETS] : [];
}

export function chooseClearestNearbyFrame(
  base,
  candidates,
  { maxHashDistance = 12, minGainRatio = 1.15, minGainAbsolute = 8 } = {}
) {
  if (!base?.hash) return base;
  const baseSharpness = Math.max(0, Number(base.sharpness) || 0);
  const minimumSharpness = Math.max(
    baseSharpness * minGainRatio,
    baseSharpness + minGainAbsolute
  );
  const eligible = (candidates ?? []).filter((candidate) => {
    if (!candidate?.hash) return false;
    const sharpness = Number(candidate.sharpness);
    const comparison = compareFrameVisuals(base, candidate);
    return Number.isFinite(sharpness)
      && sharpness >= minimumSharpness
      && !comparison.boundary
      && hammingHex(base.hash, candidate.hash) <= maxHashDistance;
  });
  if (!eligible.length) return base;
  return eligible.sort((a, b) => Number(b.sharpness) - Number(a.sharpness))[0];
}

// Widespread regional change represents a new slide or a moving classroom camera; a strong
// vertical grid match represents a code/canvas scroll; a sudden loss of edge mass represents an
// erase. A facecam normally changes only one or two regions and therefore does not split the
// underlying board/code state.
export function compareFrameVisuals(previous, current) {
  const hashDistance = hammingHex(previous?.hash, current?.hash) / 64;
  const regionDistances = regionalDistances(previous?.regionalHashes, current?.regionalHashes);
  const changedRegionRatio = regionDistances.length
    ? regionDistances.filter((distance) => distance > REGION_CHANGE_DISTANCE).length / regionDistances.length
    : hashDistance;
  const stableRegionRatio = regionDistances.length
    ? regionDistances.filter((distance) => distance <= REGION_STABLE_DISTANCE).length / regionDistances.length
    : 1 - hashDistance;
  const previousMass = gridMass(previous?.edgeGrid);
  const currentMass = gridMass(current?.edgeGrid);
  const retention = edgeRetention(previous?.edgeGrid, current?.edgeGrid);
  const scroll = detectVerticalScroll(previous?.edgeGrid, current?.edgeGrid);
  const reset = previousMass > 0
    && currentMass < previousMass * 0.62
    && (changedRegionRatio >= 0.34 || hashDistance >= 0.28);
  const cameraOrSceneChange = changedRegionRatio >= 0.67
    || (hashDistance >= 0.48 && stableRegionRatio < 0.45);
  const boundary = scroll.detected || reset || cameraOrSceneChange;
  const sameScene = !boundary && (stableRegionRatio >= 0.45 || hashDistance <= 0.30);
  const previousInformation = informationValue(previous);
  const currentInformation = informationValue(current);
  const dominates = sameScene
    && retention >= 0.82
    && currentMass >= previousMass * 0.98
    && currentInformation >= previousInformation * 0.94;

  return {
    hashDistance,
    changedRegionRatio,
    stableRegionRatio,
    retention,
    scroll: scroll.detected,
    scrollShift: scroll.shift,
    reset,
    cameraOrSceneChange,
    boundary,
    sameScene,
    dominates
  };
}

// Reduces every semantic visual window to its non-dominated peak states. A window may retain
// multiple peaks only when an erase, scroll, slide change, or camera move means that one frame
// cannot contain the other. This step is local and consumes no Gemini quota.
export function selectPeakStates(frames) {
  const passthrough = [];
  const windows = new Map();
  for (const frame of [...(frames ?? [])].sort((a, b) => a.t - b.t)) {
    if (!frame.windowId) {
      passthrough.push({ ...frame, peakScore: framePeakScore(frame, 0.7) });
      continue;
    }
    const list = windows.get(frame.windowId) ?? [];
    list.push(frame);
    windows.set(frame.windowId, list);
  }

  const peaks = [...passthrough];
  for (const windowFrames of windows.values()) {
    const segments = [[]];
    for (const frame of windowFrames) {
      const current = segments.at(-1);
      const previous = current.at(-1);
      if (previous && compareFrameVisuals(previous, frame).boundary) segments.push([]);
      segments.at(-1).push(frame);
    }

    const windowPeaks = segments.filter((segment) => segment.length).map((segment) => {
      const stability = segment.map((frame, index) => localStability(segment, index));
      let best = segment[0];
      let bestScore = framePeakScore(best, stability[0]);
      for (let index = 1; index < segment.length; index += 1) {
        const frame = segment[index];
        const comparison = compareFrameVisuals(best, frame);
        const score = framePeakScore(frame, stability[index]);
        if (comparison.dominates || score > bestScore + 0.025 || (
          Math.abs(score - bestScore) <= 0.025 && frame.t > best.t
        )) {
          best = frame;
          bestScore = score;
        }
      }
      return { ...best, peakScore: bestScore };
    });

    const kind = windowFrames[0]?.visualKind || "other";
    const limit = ["board-work", "derivation", "digital-ink", "code", "live-code", "terminal"]
      .includes(kind) ? 3 : 2;
    peaks.push(...windowPeaks
      .sort((a, b) => framePeakScore(b) - framePeakScore(a))
      .slice(0, limit));
  }
  return peaks.sort((a, b) => a.t - b.t);
}

export function deduplicateFrames(frames, threshold = 8) {
  const sorted = [...(frames ?? [])].sort((a, b) => a.t - b.t);
  const unique = [];
  for (const frame of sorted) {
    let duplicateIndex = -1;
    let duplicateDistance = Infinity;
    let nearestDistance = 1;
    for (let index = 0; index < unique.length; index += 1) {
      const distance = visualDistance(frame, unique[index]);
      nearestDistance = Math.min(nearestDistance, distance);
      if (nearDuplicate(frame, unique[index], threshold) && distance < duplicateDistance) {
        duplicateIndex = index;
        duplicateDistance = distance;
      }
    }

    if (duplicateIndex === -1) {
      unique.push({ ...frame, novelty: unique.length ? nearestDistance : 1 });
      continue;
    }

    const existing = unique[duplicateIndex];
    const existingQuality = frameQuality(existing);
    const currentQuality = frameQuality(frame);
    if (currentQuality >= existingQuality || (
      frame.incremental && frame.t > existing.t && currentQuality >= existingQuality * 0.94
    )) {
      unique[duplicateIndex] = {
        ...frame,
        novelty: Math.max(Number(existing.novelty) || 0, duplicateDistance)
      };
    }
  }
  return unique.sort((a, b) => a.t - b.t);
}

export function selectFrames(frames, durationSeconds, budget = frameBudget(durationSeconds)) {
  const unique = deduplicateFrames(frames);
  if (unique.length <= budget) return unique;

  const duration = Math.max(1, Number(durationSeconds) || 1);
  const coverageSlots = Math.max(1, Math.min(budget, Math.ceil(budget * 0.5)));
  const bins = Array.from({ length: coverageSlots }, () => []);
  for (const frame of unique) {
    const index = Math.min(coverageSlots - 1, Math.floor((frame.t / duration) * coverageSlots));
    bins[index].push(frame);
  }

  const selected = [];
  const selectedSet = new Set();
  for (const bin of bins) {
    if (!bin.length) continue;
    const best = [...bin].sort((a, b) => frameQuality(b) - frameQuality(a))[0];
    selected.push(best);
    selectedSet.add(best);
  }

  while (selected.length < budget) {
    let best = null;
    let bestScore = -Infinity;
    for (const frame of unique) {
      if (selectedSet.has(frame)) continue;
      const visualNovelty = selected.length
        ? Math.min(...selected.map((chosen) => visualDistance(frame, chosen)))
        : 1;
      const temporalNovelty = selected.length
        ? Math.min(...selected.map((chosen) => Math.abs(frame.t - chosen.t) / duration))
        : 1;
      const score = frameQuality(frame) * 0.68
        + visualNovelty * 0.24
        + Math.min(1, temporalNovelty * coverageSlots) * 0.08;
      if (score > bestScore) {
        best = frame;
        bestScore = score;
      }
    }
    if (!best) break;
    selected.push(best);
    selectedSet.add(best);
  }

  return selected.sort((a, b) => a.t - b.t);
}

export function frameQuality(frame) {
  const sharpness = Math.min(1, Math.log1p(Math.max(0, Number(frame?.sharpness) || 0)) / 7);
  const trigger = Math.min(1, (Number(frame?.triggerScore) || 0) / 5);
  const novelty = clamp(Number(frame?.novelty) || 0, 0, 1);
  const information = informationValue(frame);
  const exposure = Number.isFinite(Number(frame?.exposureQuality))
    ? clamp(Number(frame.exposureQuality), 0, 1)
    : 0.7;
  const peak = Number.isFinite(Number(frame?.peakScore))
    ? clamp(Number(frame.peakScore), 0, 1)
    : information;
  return sharpness * 0.12
    + trigger * 0.24
    + novelty * 0.12
    + information * 0.24
    + exposure * 0.08
    + peak * 0.20;
}

export function visualDistance(a, b) {
  const global = hammingHex(a?.hash, b?.hash) / 64;
  const regions = regionalDistances(a?.regionalHashes, b?.regionalHashes);
  if (!regions.length) return global;
  const sorted = [...regions].sort((x, y) => x - y);
  const stableMajority = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.75)));
  const regional = stableMajority.reduce((sum, value) => sum + value, 0)
    / (stableMajority.length * 64);
  return clamp(global * 0.35 + regional * 0.65, 0, 1);
}

function framePeakScore(frame, stability = 0.7) {
  const information = informationValue(frame);
  const sharpness = Math.min(1, Math.log1p(Math.max(0, Number(frame?.sharpness) || 0)) / 7);
  const trigger = Math.min(1, (Number(frame?.triggerScore) || 0) / 5);
  const exposure = Number.isFinite(Number(frame?.exposureQuality))
    ? clamp(Number(frame.exposureQuality), 0, 1)
    : 0.7;
  return information * 0.42
    + clamp(stability, 0, 1) * 0.23
    + sharpness * 0.14
    + trigger * 0.16
    + exposure * 0.05;
}

function localStability(frames, index) {
  const comparisons = [];
  if (index > 0) comparisons.push(compareFrameVisuals(frames[index - 1], frames[index]));
  if (index + 1 < frames.length) comparisons.push(compareFrameVisuals(frames[index], frames[index + 1]));
  if (!comparisons.length) return 0.7;
  const motion = comparisons.reduce((sum, comparison) => {
    const widespread = comparison.changedRegionRatio;
    const global = comparison.hashDistance;
    return sum + Math.min(1, widespread * 0.8 + global * 0.2);
  }, 0) / comparisons.length;
  return 1 - motion;
}

function informationValue(frame) {
  const explicit = Number(frame?.informationScore);
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 1);
  const edgeDensity = clamp(Number(frame?.edgeDensity) || 0, 0, 1);
  const occupied = clamp(Number(frame?.occupiedRatio) || 0, 0, 1);
  if (edgeDensity || occupied) return clamp(edgeDensity * 4 + occupied * 0.35, 0, 1);
  return 0.45;
}

function nearDuplicate(a, b, threshold) {
  const global = hammingHex(a?.hash, b?.hash);
  const regions = regionalDistances(a?.regionalHashes, b?.regionalHashes);
  if (!regions.length) return global <= threshold;
  const matching = regions.filter((distance) => distance <= threshold).length / regions.length;
  return global <= threshold + 4 && matching >= 0.75;
}

function regionalDistances(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return [];
  return a.map((hash, index) => hammingHex(hash, b[index]));
}

function edgeRetention(previous, current) {
  if (!validMatchingGrids(previous, current)) return 0;
  let retained = 0;
  let total = 0;
  for (let index = 0; index < previous.length; index += 1) {
    const before = Math.max(0, Number(previous[index]) || 0);
    const after = Math.max(0, Number(current[index]) || 0);
    retained += Math.min(before, after);
    total += before;
  }
  return total ? retained / total : 0;
}

function gridMass(grid) {
  return Array.isArray(grid)
    ? grid.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
    : 0;
}

function detectVerticalScroll(previous, current, columns = 16) {
  if (!validMatchingGrids(previous, current) || previous.length % columns !== 0) {
    return { detected: false, shift: 0, improvement: 0 };
  }
  const rows = previous.length / columns;
  const baseline = shiftedGridDifference(previous, current, columns, rows, 0);
  let bestDifference = baseline;
  let bestShift = 0;
  const maxShift = Math.min(4, rows - 1);
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    if (!shift) continue;
    const difference = shiftedGridDifference(previous, current, columns, rows, shift);
    if (difference < bestDifference) {
      bestDifference = difference;
      bestShift = shift;
    }
  }
  const improvement = baseline - bestDifference;
  return {
    detected: Math.abs(bestShift) >= 1 && improvement >= 0.11 && bestDifference <= 0.34,
    shift: bestShift,
    improvement
  };
}

function shiftedGridDifference(a, b, columns, rows, shift) {
  let difference = 0;
  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    const otherRow = row + shift;
    if (otherRow < 0 || otherRow >= rows) continue;
    for (let column = 0; column < columns; column += 1) {
      const left = Math.max(0, Number(a[row * columns + column]) || 0) / 15;
      const right = Math.max(0, Number(b[otherRow * columns + column]) || 0) / 15;
      difference += Math.abs(left - right);
      count += 1;
    }
  }
  return count ? difference / count : 1;
}

function validMatchingGrids(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length > 0 && a.length === b.length;
}

function defaultWindowSeconds(kind, incremental) {
  if (incremental) return 24;
  if (["board-work", "derivation", "digital-ink", "code", "live-code", "terminal"].includes(kind)) return 20;
  if (["demonstration", "diagram", "graph", "table"].includes(kind)) return 14;
  return 12;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
