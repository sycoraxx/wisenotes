# WiseNotes public beta architecture

## Product invariant

WiseNotes is a multimodal lecture-note tool. It must never degrade silently into transcript summarization.

- Captured video frames are authoritative for equations, notation, diagrams, tables, slide text, and code.
- The transcript supplies narration, order, and timing.
- When the two conflict, visual evidence wins.
- If frame capture or frame extraction cannot run, the job fails visibly rather than producing transcript-only notes.

## Target use cases

The scope rule is: **WiseNotes is for sessions where the content is on screen rather than in the narration**, so speech is lossy and a transcript provably loses it. Any such session qualifies. Two formats are the acceptance-critical reference cases, and they are what the pipeline is tuned and tested for:

- **Derivation-heavy STEM**: chalkboard work, digital ink and tablet handwriting, dense notation, multi-step derivations, and worked examples.
- **Live coding**: code typed, refactored, and debugged on screen, together with terminal, build, and test output.

Comparable material follows the same rule: lab walkthroughs, whiteboard architecture and systems-design sessions, statistics and data-modeling work, and hardware or circuit diagrams.

Outside this scope the pipeline still runs, but the visual stage adds little. For talking-head, discussion, history, and slide-only lectures the transcript already carries the content, and a plain transcript summariser is the better tool. A change that trades fidelity in the reference formats for convenience elsewhere is the wrong trade.

## Runtime flow

```text
Popup user gesture
  -> MV3 service worker
     -> YouTube content script: transcript, playback snapshot, seek control
     -> resilient stable Gemini Flash/Flash-Lite chain: semantic visual-moment planning from the full transcript
     -> dedicated capture tab: hosted player page framing the embed, plus seek control
        (no quality request; the embed serves no pre-roll, so non-Premium users are not stalled)
     -> Chrome tabCapture stream
        -> offscreen document: crop, local dHash regions, edge map, sharpness, blank detection
     -> metadata-only local scouts: accumulation/reset/scroll/camera segmentation and peak ranking
     -> full-quality recapture of winners, blur recovery, deduplication, and sparse frame budget
     -> Gemini Flash-Lite: frame-level structured visual extraction
     -> synthesis prompt: full transcript + timestamped visual evidence
     -> local universal prompt, exposed through an explicit Copy action
     -> user chooses an LLM provider, pastes, reviews, and sends
```

Frames are captured from a dedicated capture tab that plays the lecture in an embedded player, because an embedded player does not serve the pre-roll the watch page serves. Measured in one signed-out browser on the same video, the watch page served a 15-second pre-roll and the embed served none. Users without Premium are therefore not stalled mid-capture. The user's own watch tab supplies the transcript and the playback snapshot and is never seeked; it is only paused and muted for the duration of the capture and restored afterwards.

YouTube plays an embed only when the request carries a `Referer` naming a real http(s), non-YouTube origin, because the player reads what it calls the embedder identity out of that header. A Chrome extension cannot be such an origin, and every alternative shape was tested against YouTube's own error codes: a top-level embed URL sends no referrer (Error 153), an embed inside a `chrome-extension://` page also sends none, even with `referrerpolicy="origin"` (Error 153), and an embed inside a youtube.com page is a denied embedder (Error 152). The capture tab therefore opens `docs/player.html`, a static page published by GitHub Pages from this repository. `yt-content.js` is declared with `all_frames` so it runs inside the framed player and keeps full seek, ad detection, ad skipping, and duration control; nested frames are ignored so they cannot answer in the player's place.

Chrome only permits tab capture for a tab the user has invoked the extension on. The watch tab carries that grant automatically, but the player tab does not, so WiseNotes asks the user to click the WiseNotes toolbar icon once on that tab. Because the popup is closed by then, the request is carried by a red `1` badge and a tooltip on the toolbar icon itself, and the window is brought forward, rather than by a message in a popup nobody has open. That wait is bounded; if the grant never arrives, or the embed player cannot be used at all, WiseNotes falls back to capturing the watch page directly. In that fallback mode it temporarily requests the highest exposed quality and enables Theater mode, then restores the prior quality preference and layout.

Every capture is cropped to the current video-element bounds, including the visible-tab fallback, so recommendations, comments, and browser chrome are not persisted. WiseNotes never draws YouTube's media element to a canvas.

## Job persistence

IndexedDB stores sessions by UUID. A session checkpoints after transcript extraction, local capture, and every Gemini batch. Raw JPEG frames remain available while Gemini work is incomplete and are removed immediately after every selected frame has been extracted successfully.

The service worker maintains an in-memory cancellation controller while active. If Chrome terminates the worker, the next status read marks the stale job as interrupted. Gemini-stage jobs can resume from the first unfinished frame; capture-stage jobs must restart because the tab stream and unsaved candidates no longer exist.

## External interfaces

YouTube’s caption-player response and transcript panel are not stable public APIs. Their integrations live behind content-script message boundaries so selectors and compatibility fallbacks can be updated independently.

WiseNotes queries Gemini's model catalog with the user's API key and accepts only explicit stable full Flash and Flash-Lite text models. The last model that completed planning is tried first, followed by every discovered full Flash model from newest to oldest and then every stable Flash-Lite model. The selected model receives the complete timestamped transcript once and returns a bounded, validated list of likely visual windows. Transient failures use exponential backoff and the next compatible model. Project-wide rate limits honor `Retry-After`; if every candidate is temporarily unavailable, WiseNotes checkpoints the transcript and offers Resume instead of silently switching to a dense local cue plan.

Every external request carries a bound. Gemini frame-extraction attempts time out after 120 seconds and are retried up to three times with exponential backoff before an error is surfaced and Resume is offered. A timeout both aborts the request and races the await, because aborting alone would not bound a request that ignores its signal. Rate limits and permanent client errors are never retried, so a project-wide throttle still pauses cleanly. The planning stage is not bounded this way yet, so a stalled planning request can wait indefinitely. The caption endpoint is not retried on a rate limit either, and never advises an immediate reload.

Every planned window is locally scouted at bounded early, growing, late, and peak points. The offscreen document returns compact visual metadata rather than a JPEG during this pass: whole-frame and 3×3 regional dHashes, a 16×9 edge-density map, sharpness, exposure, occupied area, and information score. Regional change separates camera/scene transitions from localized lecturer or facecam motion; shifted edge maps detect vertical code/canvas scrolling; edge-mass loss detects erasure. Peak-state reduction preserves the most informative state in each stable segment and keeps the pre-reset/pre-scroll state when later pixels cannot contain it. Only winners are recaptured as JPEGs and persisted.

Gemini Flash-Lite then receives batches of at most 16 selected frames. Each image is immediately preceded by its own ±30-second transcript window, preventing overlapping contexts from being associated only with the first image. Equations are returned as ordered structured records containing pdflatex-compatible notation, a literal visible reading, derivation role, confidence, ambiguity tokens, and frame-level equation context. Both outputs are constrained and validated as JSON before entering the rest of the pipeline.

## Security and privacy boundaries

- The Gemini key remains in Chrome local extension storage.
- Whole-tab capture data is cropped to the video bounds in the offscreen document before it returns to the pipeline.
- No LLM provider site is opened, read, or modified by the extension.
- Copying the final prompt requires an explicit user action.
- Untrusted text and frame content are explicitly delimited, and both AI prompts forbid following instructions embedded in lecture content.
- No telemetry or WiseNotes network service exists.
- WiseNotes blocks no ad requests and patches no player code. When an ad does play it presses YouTube's own Skip Ad control if YouTube renders one, and otherwise waits the ad out. Automating that click may conflict with YouTube's Terms of Service.

## Compatibility target

Desktop Chrome 116+, Manifest V3, English captioned YouTube lectures up to two hours, and unpacked GitHub distribution. Other Chromium browsers may work but are not part of the beta acceptance target.
