# WiseNotes architecture

This document explains the decisions behind the public beta. Start with the [README](README.md) if you only want to install or use WiseNotes.

## The invariant

WiseNotes is multimodal or it stops.

- Frames govern equations, notation, diagrams, tables, slides, and code.
- Captions govern narration, order, and timing.
- Conflicts resolve in favor of visual evidence.
- Failed visual capture or extraction must never quietly become transcript-only notes.

The acceptance-critical formats are derivation-heavy STEM and live coding. Optimizing a talking-head video is never worth losing fidelity on a crowded board or changing terminal.

## Pipeline at a glance

```text
Popup
  └─ service worker
      ├─ snapshot playback + fetch captions
      ├─ Gemini Flash planner → semantic visual windows
      ├─ capture tab → YouTube embed → tabCapture stream
      ├─ offscreen analysis → hashes, edges, blur, scene boundaries
      ├─ peak selection → full-resolution recapture of winners
      ├─ Gemini Flash-Lite → structured visual evidence
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

## Gemini boundaries

| Stage | Input | Output | Failure behavior |
|---|---|---|---|
| Timestamp planning | Complete timestamped transcript | Bounded visual windows | Known-good model first; 20s discovery and 120s generation bounds; `429` pauses |
| Frame extraction | Up to 16 JPEGs, each paired with ±30s captions | Validated JSON visual evidence | 120s timeout, up to 3 transient retries, batch checkpointing |

Planning tries the last successful current-generation model before it depends on the catalog, then discovers explicit stable `gemini-X.Y-flash` and `gemini-X.Y-flash-lite` models exposed to the user’s key. Legacy 2.x candidates are excluded from automatic planning because Google limits their availability for new projects even when they appear in catalog results. On a cold start where discovery itself is unavailable, WiseNotes directly tries a current stable full-Flash ladder newest-first, followed by the configured stable Lite model. Aliases, previews, and specialized variants are rejected.

Frame extraction uses the configured Lite model. Its schema preserves visible text, code, diagrams, equation order, pdflatex-compatible notation, confidence, and ambiguous glyphs. Both prompts delimit lecture material as untrusted data and explicitly forbid following instructions inside it.

Catalog requests time out after 20 seconds. Planner generation and frame-extraction attempts time out after 120 seconds and retry only transient failures.

## Captions

Selection order is human English → automatic English → translated English. Player-response metadata from live and initial responses is merged before choosing a track. Empty or malformed YouTube responses receive one bounded retry; `429` never triggers an immediate retry. The transcript panel is the compatibility fallback when appropriate.

These are YouTube player interfaces, not stable public APIs. Keep them isolated and expect maintenance.

## State and recovery

IndexedDB stores each session by UUID. Checkpoints occur after transcript retrieval, local capture, and every Gemini batch.

```text
idle → transcript → awaiting_capture_window → capturing → extracting → staging → ready
                    └───────────────────────────────► paused_rate_limit
any active state ───────────────────────────────────► cancelled | error
```

- Raw JPEGs remain only while an unfinished extraction may need them.
- Completed batches resume at the first unprocessed frame.
- Service-worker interruption during capture requires a new capture because the media stream and metadata scouts are ephemeral.
- Cancellation always attempts to stop capture, close owned tabs, and restore the lecture.

## Security and privacy boundaries

- Gemini credentials stay in Chrome local extension storage.
- The service worker never logs the key or lecture data.
- The final prompt is copied only after an explicit user action.
- The static GitHub Pages request exposes the YouTube video ID to GitHub infrastructure; this is disclosed in [PRIVACY.md](PRIVACY.md).
- WiseNotes has no telemetry, account system, payment system, or application backend.
- The current beta clicks YouTube’s own Skip Ad button when one appears and otherwise waits. This behavior is disclosed because it may conflict with YouTube’s terms.

## Compatibility target

Desktop Chrome 116+, Manifest V3, captioned YouTube lectures with direct or translated English captions, and unpacked GitHub distribution. Other Chromium browsers may work but are not acceptance targets.
