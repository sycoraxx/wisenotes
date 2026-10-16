# WiseNotes architecture

This document explains the decisions behind the public beta. Start with the [README](README.md) if you only want to install or use WiseNotes.

## The invariant

WiseNotes is multimodal or it stops.

- OCR from captured frames supplies evidence for equations, notation, tables, slides, and code. OCR uncertainty and missing diagram geometry remain explicit.
- Captions govern narration, order, and timing.
- Conflicts resolve in favor of visual evidence.
- Failed visual capture or extraction must never quietly become transcript-only notes.

The acceptance-critical formats are derivation-heavy STEM and live coding. Optimizing a talking-head video is never worth losing fidelity on a crowded board or changing terminal.

## Pipeline at a glance

```text
Popup
  └─ service worker
      ├─ snapshot playback + fetch English or native Indic captions
      ├─ Sarvam Translate → timestamp-aligned English captions
      ├─ Sarvam-105B planner → semantic visual windows
      ├─ capture tab → YouTube embed → tabCapture stream
      ├─ offscreen analysis → hashes, edges, blur, scene boundaries
      ├─ peak selection → full-resolution recapture of winners
      ├─ Sarvam Vision Document AI → raw OCR Markdown
      ├─ Sarvam Translate → English OCR prose + original evidence
      ├─ local prompt builder → transcript + evidence
      └─ explicit Copy action → user-selected LLM
```

No LLM provider page is opened, inspected, or automated.

## Capture path

### Why a hosted player exists

YouTube embeds require an HTTP(S) referrer that identifies the embedder. Top-level embed URLs, extension pages, and YouTube-hosted wrappers failed with player errors during testing. WiseNotes therefore opens [`docs/player.html`](docs/player.html), published through GitHub Pages, which contains only a validated YouTube video ID and a `youtube-nocookie.com` iframe.

The YouTube content script runs in all frames but responds only from the actual player frame. The static wrapper is not granted extension host access.

### Permission handshake

Chrome grants tab capture only after the extension is invoked on that tab. The watch tab already has this grant; a newly opened capture tab does not. WiseNotes therefore:

1. activates the capture tab;
2. shows a red `1` badge and permission tooltip;
3. waits up to one minute for a toolbar click;
4. falls back to the watch tab if permission or embed playback fails.

The watch-tab fallback requests the highest exposed quality and Theater mode, then restores the previous quality, layout, playback state, rate, volume, mute state, timestamp, and scroll position.

Every screenshot path is cropped to the current video-element bounds before data returns to the service worker. Recommendations, comments, and browser chrome are not persisted.

## Finding the fullest frame

Semantic timing narrows the search; pixels make the final decision.

1. The planner receives the complete transcript and returns at most 8–32 high-value visual windows.
2. A 30-second coverage sweep protects against missed or indirect transcript cues.
3. Incremental windows are scouted at early, growing, late, and pre-transition points.
4. Metadata-only scouts return a global dHash, 3×3 regional hashes, a 16×9 edge grid, sharpness, exposure, occupied area, and information density.
5. Regional change distinguishes a moving lecturer or facecam from a camera/scene transition. Shifted edge maps detect scrolling; edge-mass loss detects erasure.
6. Each stable segment keeps its strongest information peak. Pre-scroll and pre-erasure states survive when a later frame cannot contain them.
7. Winners are recaptured as JPEGs. Blurry winners probe ±1.25 seconds and accept only sharper same-scene replacements.
8. Final deduplication balances visual novelty, trigger relevance, sharpness, information, and temporal coverage.

Only final winners consume image-model quota. The budget is `ceil(durationMinutes × 0.6)` with a minimum of one and no ceiling.

## Sarvam boundaries

| Stage | Input | Output | Failure behavior |
|---|---|---|---|
| Timestamp planning | Complete timestamped transcript | Strict JSON visual windows | 120s per attempt; up to 3 transient attempts; 429 pauses |
| Frame OCR | One cropped JPEG per job, mixed printed/handwritten content, source language | Markdown returned by the job results endpoint | Persist job ID before polling; 5s poll cadence; 10-minute polling deadline |

The planner uses Sarvam’s flagship `sarvam-105b` on `POST /v1/chat/completions`, with `response_format: json_schema`. Low reasoning effort and a 4096-token completion budget support Starter accounts. Truncated or malformed plans are rejected. Its context window is 128K tokens; oversized transcripts remain saved if the provider rejects them.

Sarvam Vision reads pixels through `POST /doc-ai/v1/job/digitise`. The endpoint selects its supported Vision model; there is no invented chat-model OCR endpoint or manually pinned Vision version. A repeatable multipart `file` part contains one JPEG, with the caption-derived or user-selected `language` and `content_type=mixed`. After `GET /doc-ai/v1/job/{id}/status` reports completion, `GET /doc-ai/v1/job/{id}/results?format=md` returns one document/page. This avoids ZIP downloads and additional storage-host permissions.

One frame per job gives an unambiguous timestamp-to-page mapping. Unexpected page counts, failed jobs, and partially completed jobs stop the run. The raw Markdown is retained verbatim; WiseNotes does not invent equation records, diagram descriptions, or confidence scores. The final prompt explains OCR limitations and forbids reconstructing invisible symbols or diagram geometry from captions.

Each HTTP attempt includes response-body reading in its timeout. GET status/results and planning requests retry transient failures up to three attempts. OCR creation is never automatically retried because a lost response could have created a charged job. If no job ID was received, a user-triggered Resume may submit a new job. Known job IDs are reused on Resume. A short-lived extension-API timer keeps the service worker active during bounded provider calls and is cleared when they finish.

API references: [Chat Completions V1](https://docs.sarvam.ai/api-reference/chat/chat-completions-v1), [Digitise](https://docs.sarvam.ai/api-reference/doc-ai/job/digitise), [Job results](https://docs.sarvam.ai/api-reference/doc-ai/job/results).

## Captions

Selection order is human English → automatic English → native Indic captions → YouTube-translated English. Native Indic captions do not require YouTube to expose an English translation target. Player-response metadata from live and initial responses is merged before choosing a track. Empty or malformed YouTube responses receive one bounded retry; `429` never triggers an immediate retry. The transcript panel is the compatibility fallback when appropriate.

These are YouTube player interfaces, not stable public APIs. Keep them isolated and expect maintenance.

## English normalization

Native captions and OCR prose use `/translate` with `sarvam-translate:v1` and target `en-IN`. The model supports all 22 scheduled Indic languages. Known caption language codes are normalized, including YouTube’s `or` to Sarvam’s `od-IN`. Unknown panel/OCR prose is classified by Sarvam-105B before translation, including Romanized Indic text. Existing English captions skip translation requests.

Translation inputs are split below 2,000 characters. Caption boundaries are protected and checked so neither order nor timestamps can change. OCR translation masks code fences, inline code, LaTeX math, URLs, and HTML tags; every token must survive once and in order before its original bytes are restored. Empty results, changed protected data, and remaining Indic prose fail visibly. Original OCR and English OCR are both retained; translation cannot fix uncertain visual readings.

Caption normalization runs in the `transcript` state and persists original captions, completed English segments, and the pending flag. OCR results are saved before translation, with completed translation chunks. Resume can translate a saved OCR result without repeating the OCR job. The default OCR language follows available source captions; settings allow a different board/slide language. Final synthesis explicitly requires English prose, titles, headings, and labels. Uncaptioned audio transcription is outside this version’s pipeline.

References: [Sarvam Translate](https://docs.sarvam.ai/api/getting-started/models/sarvam-translate), [Translation API](https://docs.sarvam.ai/api-reference/text/translate-text).

## State and recovery

IndexedDB stores each session by UUID. Checkpoints occur after transcript retrieval, local capture, and every OCR job creation and completed frame.

```text
idle → transcript → awaiting_capture_window → capturing → extracting → staging → ready
                    └───────────────────────────────► paused_rate_limit
any active state ───────────────────────────────────► cancelled | error
```

- Raw JPEGs remain until the final prompt is saved atomically with the ready state.
- Completed frames resume at the first unprocessed frame, reusing its persisted OCR job ID when available.
- Completed OCR can finish the local prompt without a network request or API key.
- Legacy session fields are mapped to provider-neutral checkpoints; old API keys are never reused as Sarvam keys.
- Service-worker interruption during capture stops the stream, closes owned tabs, and restores the lecture. A new capture is required because metadata scouts are ephemeral.
- Cancellation always attempts to stop capture, close owned tabs, and restore the lecture.

## Security and privacy boundaries

- Sarvam credentials stay in Chrome local extension storage. Only `api.sarvam.ai` receives the subscription-key header.
- The service worker never logs the key or lecture data.
- The final prompt is copied only after an explicit user action.
- The static GitHub Pages request exposes the YouTube video ID to GitHub infrastructure; this is disclosed in [PRIVACY.md](PRIVACY.md).
- WiseNotes has no telemetry, account system, payment system, or application backend.
- The current beta clicks YouTube’s own Skip Ad button when one appears and otherwise waits. This behavior is disclosed because it may conflict with YouTube’s terms.

## Compatibility target

Desktop Chrome 116+, Manifest V3, captioned YouTube lectures with English or supported native Indic captions (or YouTube-translated English), and unpacked GitHub distribution. Other Chromium browsers may work but are not acceptance targets.
