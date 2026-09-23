import { dHashFromImageData, hashToHex } from "./lib/dhash.js";

const video = document.querySelector("#capture-stream");
let stream = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!String(message?.type || "").startsWith("OFFSCREEN_")) return false;
  handleMessage(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "OFFSCREEN_START_CAPTURE":
      await startCapture(message.streamId);
      return { width: video.videoWidth, height: video.videoHeight };
    case "OFFSCREEN_CAPTURE_FRAME":
      return captureFromVideo(message.captureMeta, message.quality, message.analysisOnly);
    case "OFFSCREEN_PROCESS_DATA_URL":
      return processDataUrl(message.dataUrl, message.captureMeta, message.quality, message.analysisOnly);
    case "OFFSCREEN_STOP_CAPTURE":
      stopCapture();
      return {};
    default:
      throw new Error(`Unknown offscreen message: ${message.type}`);
  }
}

async function startCapture(streamId) {
  stopCapture();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });
  video.srcObject = stream;
  await waitForVideo(video);
  await video.play();
}

function stopCapture() {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
  stream = null;
  video.srcObject = null;
}

async function captureFromVideo(captureMeta, quality = 0.82, analysisOnly = false) {
  if (!stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error("The tab capture stream is not ready.");
  }
  return processSource(video, video.videoWidth, video.videoHeight, captureMeta, quality, analysisOnly);
}

async function processDataUrl(dataUrl, captureMeta, quality = 0.82, analysisOnly = false) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return processSource(image, image.naturalWidth, image.naturalHeight, captureMeta, quality, analysisOnly);
}

async function processSource(source, sourceWidth, sourceHeight, captureMeta, quality, analysisOnly) {
  const crop = mappedCrop(sourceWidth, sourceHeight, captureMeta);
  const maxWidth = 1280;
  const outputWidth = Math.max(1, Math.min(maxWidth, Math.round(crop.width)));
  const outputHeight = Math.max(1, Math.round(crop.height * (outputWidth / crop.width)));
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    outputWidth,
    outputHeight
  );

  const hashCanvas = new OffscreenCanvas(9, 8);
  const hashContext = hashCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  hashContext.drawImage(canvas, 0, 0, outputWidth, outputHeight, 0, 0, 9, 8);
  const hash = hashToHex(dHashFromImageData(hashContext.getImageData(0, 0, 9, 8)));
  const analysis = analyzeCanvas(canvas);
  const payload = {
    hash,
    regionalHashes: calculateRegionalHashes(canvas),
    sharpness: analysis.sharpness,
    blank: analysis.blank,
    edgeDensity: analysis.edgeDensity,
    occupiedRatio: analysis.occupiedRatio,
    informationScore: analysis.informationScore,
    exposureQuality: analysis.exposureQuality,
    edgeGrid: analysis.edgeGrid,
    crop: {
      sourceWidth,
      sourceHeight,
      x: Math.round(crop.x),
      y: Math.round(crop.y),
      width: Math.round(crop.width),
      height: Math.round(crop.height),
      outputWidth,
      outputHeight
    }
  };
  if (analysisOnly) return payload;
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { ...payload, dataUrl: await blobToDataUrl(blob) };
}

function mappedCrop(sourceWidth, sourceHeight, captureMeta = {}) {
  const viewport = captureMeta.viewport || {};
  const rect = captureMeta.crop || {};
  const scaleX = sourceWidth / Math.max(1, Number(viewport.width) || sourceWidth);
  const scaleY = sourceHeight / Math.max(1, Number(viewport.height) || sourceHeight);
  const x = clamp((Number(rect.x) || 0) * scaleX, 0, sourceWidth - 1);
  const y = clamp((Number(rect.y) || 0) * scaleY, 0, sourceHeight - 1);
  const width = clamp((Number(rect.width) || viewport.width || sourceWidth) * scaleX, 1, sourceWidth - x);
  const height = clamp((Number(rect.height) || viewport.height || sourceHeight) * scaleY, 1, sourceHeight - y);
  return { x, y, width, height };
}

function analyzeCanvas(canvas) {
  const sampleWidth = Math.min(160, canvas.width);
  const sampleHeight = Math.max(1, Math.round(canvas.height * (sampleWidth / canvas.width)));
  const sample = new OffscreenCanvas(sampleWidth, sampleHeight);
  const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
  const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
  const gray = new Float32Array(sampleWidth * sampleHeight);
  let mean = 0;
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const value = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    gray[index] = value;
    mean += value;
  }
  mean /= gray.length;

  let variance = 0;
  let laplacianVariance = 0;
  let laplacianMean = 0;
  let count = 0;
  const laplacians = [];
  const edgeColumns = 16;
  const edgeRows = 9;
  const edgeCounts = new Uint32Array(edgeColumns * edgeRows);
  const cellCounts = new Uint32Array(edgeColumns * edgeRows);
  let edgePixels = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  variance /= gray.length;

  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      const i = y * sampleWidth + x;
      const laplacian = gray[i - 1] + gray[i + 1] + gray[i - sampleWidth] + gray[i + sampleWidth] - 4 * gray[i];
      laplacians.push(laplacian);
      laplacianMean += laplacian;
      count += 1;
      const column = Math.min(edgeColumns - 1, Math.floor((x / sampleWidth) * edgeColumns));
      const row = Math.min(edgeRows - 1, Math.floor((y / sampleHeight) * edgeRows));
      const cell = row * edgeColumns + column;
      cellCounts[cell] += 1;
      if (Math.abs(laplacian) >= 18) {
        edgePixels += 1;
        edgeCounts[cell] += 1;
      }
    }
  }
  laplacianMean /= Math.max(1, count);
  for (const value of laplacians) laplacianVariance += (value - laplacianMean) ** 2;
  laplacianVariance /= Math.max(1, count);

  const edgeGrid = [...edgeCounts].map((edges, index) => {
    const density = edges / Math.max(1, cellCounts[index]);
    return Math.round(Math.min(1, density * 5) * 15);
  });
  const edgeDensity = edgePixels / Math.max(1, count);
  const occupiedRatio = edgeGrid.filter((value) => value >= 2).length / edgeGrid.length;
  const exposureQuality = clamp(0.4 + Math.sqrt(variance) / 45, 0, 1);
  const informationScore = clamp(
    (edgeDensity * 4 + occupiedRatio * 0.35) * (0.72 + exposureQuality * 0.28),
    0,
    1
  );

  return {
    sharpness: Math.round(laplacianVariance * 100) / 100,
    blank: variance < 1.5,
    edgeDensity: round(edgeDensity, 4),
    occupiedRatio: round(occupiedRatio, 4),
    informationScore: round(informationScore, 4),
    exposureQuality: round(exposureQuality, 4),
    edgeGrid
  };
}

function calculateRegionalHashes(canvas, columns = 3, rows = 3) {
  const hashes = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.floor((column / columns) * canvas.width);
      const y = Math.floor((row / rows) * canvas.height);
      const right = Math.floor(((column + 1) / columns) * canvas.width);
      const bottom = Math.floor(((row + 1) / rows) * canvas.height);
      const tile = new OffscreenCanvas(9, 8);
      const context = tile.getContext("2d", { alpha: false, willReadFrequently: true });
      context.drawImage(canvas, x, y, Math.max(1, right - x), Math.max(1, bottom - y), 0, 0, 9, 8);
      hashes.push(hashToHex(dHashFromImageData(context.getImageData(0, 0, 9, 8))));
    }
  }
  return hashes;
}

function waitForVideo(element) {
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out while starting tab capture.")), 8000);
    element.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
