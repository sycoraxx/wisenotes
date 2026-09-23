import test from "node:test";
import assert from "node:assert/strict";
import {
  captionJson3Url,
  dedupeSegments,
  englishCaptionCandidates,
  mergeCaptionSources
} from "../lib/captions.js";

const url = (lang) => `https://www.youtube.com/api/timedtext?v=test&lang=${lang}`;

test("rolling caption events do not repeat the transcript", () => {
  assert.deepEqual(dedupeSegments([
    { start: 0, text: "we begin with the" },
    { start: 0, text: "we begin with the" },
    { start: 2, text: "we begin with the derivative" },
    { start: 2, text: "we begin with the derivative" },
    { start: 4, text: "which is defined as the limit" }
  ]), [
    { start: 0, text: "we begin with the" },
    { start: 2, text: "we begin with the derivative" },
    { start: 4, text: "which is defined as the limit" }
  ]);
});

test("only genuinely identical segments collapse", () => {
  const once = [
    { start: 0, text: "alpha" },
    { start: 5, text: "beta" }
  ];
  // A full second fetch of the same captions must not double the transcript.
  assert.equal(dedupeSegments([...once, ...once]).length, 2);
  // The same words at different times are different captions and must survive.
  assert.equal(dedupeSegments([
    { start: 1, text: "yes" },
    { start: 9, text: "yes" }
  ]).length, 2);
});

test("human English captions are preferred over automatic English", () => {
  const candidates = englishCaptionCandidates([
    { baseUrl: url("en"), languageCode: "en", kind: "asr" },
    { baseUrl: url("en-GB"), languageCode: "en-GB", kind: "" }
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.mode), [
    "human-english",
    "automatic-english"
  ]);
  assert.equal(candidates[0].track.languageCode, "en-GB");
});

test("automatic English is used when no human English track exists", () => {
  const candidates = englishCaptionCandidates([
    { baseUrl: url("en"), languageCode: "en", kind: "asr" }
  ]);
  assert.equal(candidates[0].mode, "automatic-english");
  assert.equal(candidates[0].translated, false);
});

test("translatable non-English tracks become the final English candidates", () => {
  const candidates = englishCaptionCandidates([
    { baseUrl: url("es"), languageCode: "es", kind: "", isTranslatable: true },
    { baseUrl: url("fr"), languageCode: "fr", kind: "asr", isTranslatable: true }
  ], [{ languageCode: "en", name: "English" }]);
  assert.deepEqual(candidates.map((candidate) => candidate.mode), [
    "translated-english",
    "translated-english"
  ]);
  assert.equal(candidates[0].track.languageCode, "es");
  const translatedUrl = new URL(captionJson3Url(candidates[0]));
  assert.equal(translatedUrl.searchParams.get("fmt"), "json3");
  assert.equal(translatedUrl.searchParams.get("tlang"), "en");
});

test("an explicitly translatable track falls back to the English tlang code", () => {
  const candidates = englishCaptionCandidates([
    { baseUrl: url("hi"), languageCode: "hi", kind: "asr", isTranslatable: true }
  ], []);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].translated, true);
  assert.equal(candidates[0].targetLanguageCode, "en");
  assert.equal(new URL(captionJson3Url(candidates[0])).searchParams.get("tlang"), "en");
});

test("an English translation listing tolerates an omitted translatable flag", () => {
  const candidates = englishCaptionCandidates([
    { baseUrl: url("ja"), languageCode: "ja", kind: "" }
  ], [{ languageCode: "en", name: "English" }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mode, "translated-english");
});

test("live and initial player caption metadata are merged", () => {
  const merged = mergeCaptionSources([
    {
      tracks: [{ baseUrl: url("hi"), languageCode: "hi", isTranslatable: true }],
      translationLanguages: []
    },
    {
      tracks: [{ baseUrl: url("hi"), languageCode: "hi", isTranslatable: null }],
      translationLanguages: [{ languageCode: "en", name: "English" }]
    }
  ]);
  assert.equal(merged.tracks.length, 1);
  assert.equal(merged.tracks[0].isTranslatable, true);
  assert.deepEqual(merged.translationLanguages.map((language) => language.languageCode), ["en"]);
});

test("no candidate is returned when English and English translation are unavailable", () => {
  assert.deepEqual(englishCaptionCandidates([
    { baseUrl: url("es"), languageCode: "es", kind: "" }
  ], [{ languageCode: "de", name: "German" }]), []);
});

test("direct English caption URLs do not add a translation parameter", () => {
  const [candidate] = englishCaptionCandidates([
    { baseUrl: url("en"), languageCode: "en", kind: "" }
  ]);
  const directUrl = new URL(captionJson3Url(candidate));
  assert.equal(directUrl.searchParams.get("fmt"), "json3");
  assert.equal(directUrl.searchParams.has("tlang"), false);
});
