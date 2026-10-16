import { SARVAM_LLM_MODEL } from "./lib/sarvam.js";
import { LANGUAGE_NAMES, normalizeLanguageCode } from "./lib/languages.js";

const apiKey = document.getElementById("api-key");
const model = document.getElementById("model");
const status = document.getElementById("status");
const ocrLanguage = document.getElementById("ocr-language");

for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = name;
  ocrLanguage.appendChild(option);
}

initialize();

async function initialize() {
  const saved = await chrome.storage.local.get(["sarvamApiKey", "ocrLanguageCode"]);
  apiKey.value = saved.sarvamApiKey || "";
  model.value = SARVAM_LLM_MODEL;
  ocrLanguage.value = normalizeLanguageCode(saved.ocrLanguageCode) || "auto";
}

document.getElementById("toggle-key").addEventListener("click", (event) => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  event.currentTarget.textContent = show ? "Hide" : "Show";
});

document.getElementById("save").addEventListener("click", async () => {
  const key = apiKey.value.trim();
  if (!key) {
    status.textContent = "Paste a Sarvam API key before saving.";
    return;
  }
  await chrome.storage.local.set({ sarvamApiKey: key, ocrLanguageCode: ocrLanguage.value });
  await chrome.storage.local.remove(["geminiApiKey", "geminiModel", "lastSuccessfulPlannerModel"]);
  status.textContent = "Saved locally. You can close this tab.";
});

document.getElementById("forget").addEventListener("click", async () => {
  await chrome.storage.local.remove(["sarvamApiKey", "geminiApiKey"]);
  apiKey.value = "";
  status.textContent = "The Sarvam API key was removed.";
});
