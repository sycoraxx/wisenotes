import { DEFAULT_MODEL } from "./lib/gemini.js";

const apiKey = document.getElementById("api-key");
const model = document.getElementById("model");
const status = document.getElementById("status");

initialize();

async function initialize() {
  const saved = await chrome.storage.local.get(["geminiApiKey", "geminiModel"]);
  apiKey.value = saved.geminiApiKey || "";
  model.value = saved.geminiModel || DEFAULT_MODEL;
}

document.getElementById("toggle-key").addEventListener("click", (event) => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  event.currentTarget.textContent = show ? "Hide" : "Show";
});

document.getElementById("save").addEventListener("click", async () => {
  const key = apiKey.value.trim();
  const modelId = model.value.trim() || DEFAULT_MODEL;
  if (!key) {
    status.textContent = "Paste a Gemini API key before saving.";
    return;
  }
  if (!/^gemini-[a-z0-9.-]+$/i.test(modelId)) {
    status.textContent = "That Gemini model ID does not look valid.";
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: key, geminiModel: modelId });
  status.textContent = "Saved locally. You can close this tab.";
});

document.getElementById("forget").addEventListener("click", async () => {
  await chrome.storage.local.remove("geminiApiKey");
  apiKey.value = "";
  status.textContent = "The Gemini API key was removed.";
});
