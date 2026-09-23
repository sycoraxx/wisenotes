(() => {
  if (globalThis.__wiseNotesYoutubeContent) return;
  globalThis.__wiseNotesYoutubeContent = true;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Content scripts cannot import modules, so these are mirrored from lib/embed.js.
  // test/embed.test.js asserts the two copies stay identical.
  const AD_SHOWING_SELECTOR = ".html5-video-player.ad-showing";
  const AD_SKIP_SELECTORS = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button",
    ".ytp-ad-skip-button-modern button"
  ];
  const EMBED_CHROME_SELECTORS = [
    ".ytp-chrome-top",
    ".ytp-chrome-bottom",
    ".ytp-gradient-top",
    ".ytp-gradient-bottom",
    ".ytp-title",
    ".ytp-watermark",
    ".ytp-large-play-button",
    ".ytp-spinner",
    ".ytp-cued-thumbnail-overlay",
    ".ytp-impression-link",
    ".ytp-pause-overlay",
    ".ytp-cards-teaser",
    ".ytp-ce-element",
    ".ytp-shorts-brand",
    ".ytp-paid-content-overlay",
    ".ytp-ad-overlay-container"
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!["YOUTUBE_SNAPSHOT", "SEEK_VIDEO", "RESTORE_VIDEO", "EXTRACT_TRANSCRIPT", "PREPARE_EMBED", "SET_VIDEO_STATE"].includes(message?.type)) {
      return false;
    }
    // The script is declared with all_frames because the ad-free capture tab is a plain http(s)
    // page that frames the player, and only the frame that owns the player can answer. Chrome also
    // injects into about:blank frames on the watch page, which would otherwise race the real player
    // frame and answer with "no video player was found".
    if (window.top !== window && !isEmbedPage()) {
      return false;
    }
    handleMessage(message).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  });
  // The capture tab's top frame is a hosted page the extension deliberately has no host permission
  // for, and chrome.scripting refuses to inject into "all frames" of a tab it cannot fully access.
  // Reporting this frame's id lets the background aim an injection at exactly this frame, for the one
  // job only the page's own world can do: pinning the highest offered playback quality.
  function announceEmbedFrame() {
    if (!isEmbedPage()) return;
    try {
      chrome.runtime.sendMessage({ type: "EMBED_FRAME_READY" }).catch(() => {});
    } catch {
      // The extension context is gone, so there is nothing left to announce to.
    }
  }

  // Once at load, and again whenever a command arrives, so a restarted service worker relearns this
  // frame id without needing the capture tab to be reloaded.
  announceEmbedFrame();
  async function handleMessage(message) {
    // Keeps the background's record of this frame fresh across service worker restarts.
    announceEmbedFrame();
    switch (message.type) {
      case "YOUTUBE_SNAPSHOT":
        return snapshot();
      case "SEEK_VIDEO":
        return seekVideo(Number(message.seconds));
      case "RESTORE_VIDEO":
        return restoreVideo(message.snapshot);
      case "EXTRACT_TRANSCRIPT":
        return { segments: await scrapeTranscriptPanel() };
      case "PREPARE_EMBED":
        return prepareEmbed();
      case "SET_VIDEO_STATE":
        return setVideoState(message);
      default:
        throw new Error("Unsupported YouTube command.");
    }
  }

  // Used to silence the user's own tab while the dedicated capture tab does the work.
  function setVideoState(message = {}) {
    const video = getVideo();
    if (typeof message.paused === "boolean") {
      if (message.paused) video.pause();
      else video.play().catch(() => {});
    }
    if (typeof message.muted === "boolean") video.muted = message.muted;
    return { paused: video.paused, muted: video.muted };
  }

  function isEmbedPage() {
    return /^\/embed\//.test(location.pathname);
  }

  function getVideo() {
    const video = document.querySelector("#movie_player video.html5-main-video, video.html5-main-video, video");
    if (!video) throw new Error("No YouTube video player was found. Reload the lecture and try again.");
    return video;
  }

  function snapshot() {
    const video = getVideo();
    return {
      snapshot: {
        currentTime: video.currentTime,
        paused: video.paused,
        playbackRate: video.playbackRate,
        volume: video.volume,
        muted: video.muted,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      title: document.title.replace(/\s+-\s+YouTube$/, "").trim(),
      videoId: new URL(location.href).searchParams.get("v") || "",
      captureMeta: getCaptureMeta(video)
    };
  }

  async function seekVideo(seconds) {
    if (!Number.isFinite(seconds)) throw new Error("Invalid capture timestamp.");
    if (isAdShowing()) {
      return { adShowing: true, adSkipped: skipAdIfPresent() };
    }
    const video = getVideo();
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await waitForEvent(video, "loadedmetadata", 8000);
    }

    video.pause();
    video.scrollIntoView({ behavior: "instant", block: "center" });
    const target = Math.max(0, Math.min(video.duration - 0.2, seconds));
    if (Math.abs(video.currentTime - target) > 0.12) {
      const seeked = waitForEvent(video, "seeked", 6000);
      video.currentTime = target;
      await seeked;
    }
    await waitForDecodedFrame(video);
    document.querySelector(".html5-video-player")?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await sleep(180);
    // YouTube restores its own chrome as soon as the player is interacted with, so the hiding is
    // re-applied immediately before every capture instead of only once when the player is prepared.
    // Only the embed page does this: the watch backend captures the user's own tab and must not
    // alter what they see there.
    if (isEmbedPage()) hideEmbedChrome();
    return {
      adShowing: false,
      actualTime: video.currentTime,
      captureMeta: getCaptureMeta(video)
    };
  }

  async function restoreVideo(state = {}) {
    const video = getVideo();
    video.pause();
    if (Number.isFinite(state.playbackRate)) video.playbackRate = state.playbackRate;
    if (Number.isFinite(state.volume)) video.volume = state.volume;
    video.muted = Boolean(state.muted);
    if (Number.isFinite(state.currentTime)) {
      const seeked = waitForEvent(video, "seeked", 5000).catch(() => {});
      video.currentTime = Math.max(0, Math.min(video.duration || state.currentTime, state.currentTime));
      await seeked;
    }
    window.scrollTo({ left: Number(state.scrollX) || 0, top: Number(state.scrollY) || 0, behavior: "instant" });
    if (!state.paused) await video.play().catch(() => {});
    return {};
  }

  function getCaptureMeta(video) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
      throw new Error("The YouTube player is not visible enough to capture.");
    }
    return {
      crop: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }
    };
  }

  function isAdShowing() {
    return Boolean(document.querySelector(AD_SHOWING_SELECTOR));
  }

  // Presses YouTube's own Skip Ad control when the player offers one, so a non-Premium user
  // is not forced to wait out a skippable ad. Only ever clicks a control YouTube itself renders,
  // and only while the player reports an ad is on screen.
  function skipAdIfPresent() {
    for (const selector of AD_SKIP_SELECTORS) {
      const button = document.querySelector(selector);
      if (!button || button.disabled) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      button.click();
      return true;
    }
    return false;
  }

  function hideEmbedChrome() {
    for (const selector of EMBED_CHROME_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        node.style.setProperty("display", "none", "important");
      }
    }
    // Backstop for the curated list above: inside the player, hide everything that is not the video
    // or one of its ancestors. The video's own chain is kept, so the picture cannot be hidden by
    // accident, and a renamed or newly added overlay cannot leak into a captured frame.
    const player = document.querySelector("#movie_player, .html5-video-player");
    const video = player?.querySelector("video.html5-main-video, video");
    if (!player || !video) return;
    const keep = new Set();
    for (let node = video; node && node !== player.parentElement; node = node.parentElement) {
      keep.add(node);
    }
    for (const node of player.querySelectorAll("*")) {
      if (!keep.has(node)) node.style.setProperty("display", "none", "important");
    }
  }

  // The embed player builds its <video> element asynchronously, well after the URL commits and
  // therefore after WiseNotes first asks the capture tab to get ready.
  async function waitForVideoElement(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const video = document.querySelector("#movie_player video.html5-main-video, video.html5-main-video, video");
      if (video) return video;
      await sleep(250);
    }
    throw new Error("No YouTube video player appeared on the embed page.");
  }

  // YouTube renders its own explanation inside the player when an embed cannot play, for example
  // "Video unavailable" or "Playback on other websites has been disabled by the video owner".
  function embedFailureReason() {
    const node = document.querySelector(
      ".ytp-error .ytp-error-content-wrap-reason, .ytp-error-content-wrap-reason, .ytp-error"
    );
    const text = node?.textContent?.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 180) : "";
  }

  // Polls for the duration instead of waiting on loadedmetadata, which may already have fired
  // before a listener could attach. Bails out early with YouTube's own explanation when the
  // embed is refusing to play.
  async function waitForEmbedDuration(video, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Number.isFinite(video.duration) && video.duration > 0) return;
      const reason = embedFailureReason();
      if (reason) throw new Error(`the embed player reported "${reason}"`);
      await sleep(250);
    }
    const reason = embedFailureReason();
    throw new Error(reason
      ? `the embed player reported "${reason}"`
      : "the embed player never loaded the lecture, so this video probably does not allow embedding");
  }

  // Called once on the dedicated capture tab, which is closed after the lecture finishes,
  // so the hidden chrome never needs to be restored.
  async function prepareEmbed() {
    if (!isEmbedPage()) throw new Error("WiseNotes expected a YouTube embed page.");
    const video = await waitForVideoElement();
    await waitForEmbedDuration(video);

    try {
      await video.play();
    } catch {
      // Muted autoplay is normally permitted; a rejection here is not fatal for capture,
      // because assigning currentTime still renders the requested frame.
    }

    document.documentElement.style.setProperty("background", "#000", "important");
    hideEmbedChrome();
    await sleep(400);
    hideEmbedChrome();

    return {
      embedReady: true,
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight
    };
  }

  async function waitForDecodedFrame(video) {
    if (typeof video.requestVideoFrameCallback === "function") {
      await Promise.race([
        new Promise((resolve) => video.requestVideoFrameCallback(() => resolve())),
        sleep(1000)
      ]);
      return;
    }
    await sleep(350);
  }

  function waitForEvent(target, name, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        target.removeEventListener(name, onEvent);
        reject(new Error(`Timed out waiting for YouTube ${name}.`));
      }, timeoutMs);
      const onEvent = () => {
        clearTimeout(timer);
        resolve();
      };
      target.addEventListener(name, onEvent, { once: true });
    });
  }

  async function scrapeTranscriptPanel() {
    let segments = [...document.querySelectorAll("ytd-transcript-segment-renderer")];
    if (!segments.length) {
      const buttons = [...document.querySelectorAll("button, yt-button-shape button")];
      const showButton = buttons.find((button) => /show transcript|transcript/i.test(
        `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`
      ));
      if (showButton) showButton.click();
      const deadline = Date.now() + 8000;
      while (!segments.length && Date.now() < deadline) {
        await sleep(250);
        segments = [...document.querySelectorAll("ytd-transcript-segment-renderer")];
      }
    }

    const parsed = segments.map((segment) => {
      const timestamp = segment.querySelector(".segment-timestamp")?.textContent?.trim() || "";
      const text = segment.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim() || "";
      return { start: parseTimestamp(timestamp), text };
    }).filter((segment) => Number.isFinite(segment.start) && segment.text);

    if (!parsed.length) {
      throw new Error("No English transcript was available for this lecture.");
    }
    return parsed;
  }

  function parseTimestamp(value) {
    const parts = String(value).split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
})();
