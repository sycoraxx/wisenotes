export const LANGUAGE_NAMES = Object.freeze({
  "en-IN": "English", "as-IN": "Assamese", "bn-IN": "Bengali", "brx-IN": "Bodo",
  "doi-IN": "Dogri", "gu-IN": "Gujarati", "hi-IN": "Hindi", "kn-IN": "Kannada",
  "ks-IN": "Kashmiri", "kok-IN": "Konkani", "mai-IN": "Maithili", "ml-IN": "Malayalam",
  "mni-IN": "Manipuri", "mr-IN": "Marathi", "ne-IN": "Nepali", "od-IN": "Odia",
  "pa-IN": "Punjabi", "sa-IN": "Sanskrit", "sat-IN": "Santali", "sd-IN": "Sindhi",
  "ta-IN": "Tamil", "te-IN": "Telugu", "ur-IN": "Urdu"
});

export function normalizeLanguageCode(value) {
  const base = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  const code = `${base === "or" ? "od" : base}-IN`;
  return LANGUAGE_NAMES[code] ? code : "";
}

export function isIndicLanguage(value) {
  const code = normalizeLanguageCode(value);
  return Boolean(code && code !== "en-IN");
}

export function containsIndicScript(text) {
  return /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Arabic}\p{Script=Ol_Chiki}\p{Script=Meetei_Mayek}\p{Script=Lepcha}]/u.test(String(text || ""));
}
