const ENGLISH_CODE = /^en(?:-|$)/i;

export function mergeCaptionSources(sources) {
  const tracks = new Map();
  const translationLanguages = new Map();

  for (const source of sources ?? []) {
    for (const track of source?.tracks ?? []) {
      if (!track?.baseUrl) continue;
      const key = [track.baseUrl, track.languageCode || "", track.kind || ""].join("|");
      const existing = tracks.get(key);
      tracks.set(key, {
        ...(existing || {}),
        ...track,
        isTranslatable: mergeTranslatableFlag(existing?.isTranslatable, track.isTranslatable)
      });
    }
    for (const language of source?.translationLanguages ?? []) {
      const languageCode = String(language?.languageCode || "").trim();
      if (!languageCode) continue;
      const key = languageCode.toLowerCase();
      if (!translationLanguages.has(key)) translationLanguages.set(key, language);
    }
  }

  return {
    tracks: [...tracks.values()],
    translationLanguages: [...translationLanguages.values()]
  };
}

export function englishCaptionCandidates(tracks, translationLanguages = []) {
  const usable = (tracks ?? []).filter((track) => track?.baseUrl);
  const directEnglish = usable.filter((track) => ENGLISH_CODE.test(String(track.languageCode || "")));
  const humanEnglish = directEnglish.filter((track) => track.kind !== "asr");
  const automaticEnglish = directEnglish.filter((track) => track.kind === "asr");
  const candidates = [
    ...humanEnglish.map((track) => captionCandidate(track, "human-english")),
    ...automaticEnglish.map((track) => captionCandidate(track, "automatic-english"))
  ];

  const englishTarget = [...(translationLanguages ?? [])]
    .filter((language) => ENGLISH_CODE.test(String(language?.languageCode || "")))
    .sort((a, b) => Number(String(a.languageCode).toLowerCase() !== "en")
      - Number(String(b.languageCode).toLowerCase() !== "en"))[0];

  const translationSources = usable
    .filter((track) => !ENGLISH_CODE.test(String(track.languageCode || "")))
    // A listed English target is sufficient even when older player responses omit the flag.
    // Without the catalog, only make the optimistic `tlang=en` request when YouTube explicitly
    // marked the source track as translatable.
    .filter((track) => englishTarget
      ? track.isTranslatable !== false
      : track.isTranslatable === true)
    .sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
  if (!translationSources.length) return candidates;
  candidates.push(...translationSources.map((track) => captionCandidate(
    track,
    "translated-english",
    englishTarget?.languageCode || "en"
  )));
  return candidates;
}

export function captionJson3Url(candidate) {
  if (!candidate?.track?.baseUrl) throw new Error("The selected caption track has no URL.");
  const url = new URL(candidate.track.baseUrl);
  url.searchParams.set("fmt", "json3");
  if (candidate.translated) url.searchParams.set("tlang", candidate.targetLanguageCode || "en");
  return url.toString();
}

function captionCandidate(track, mode, targetLanguageCode = "") {
  return {
    track,
    mode,
    translated: mode === "translated-english",
    targetLanguageCode
  };
}

function mergeTranslatableFlag(previous, current) {
  if (previous === true || current === true) return true;
  if (previous === false || current === false) return false;
  return null;
}

// YouTube's json3 output can emit the same caption event more than once, and a repeated fetch or a
// duplicated panel node produces a literal second copy of everything. Segments therefore collapse
// only when both the start time and the normalized text match, so distinct caption lines that
// reuse the same wording are preserved.
export function dedupeSegments(segments) {
  const seen = new Set();
  const result = [];
  for (const segment of segments ?? []) {
    const text = String(segment?.text ?? "").replace(/\s+/g, " ").trim();
    const start = Number(segment?.start);
    if (!text || !Number.isFinite(start)) continue;
    const key = `${start}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ start, text });
  }
  return result;
}
