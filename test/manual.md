# Manual browser test matrix

Use a fresh Chrome profile when testing permissions and first-run behavior. Never commit captured content or API keys.

## Installation

- Load the repository as an unpacked extension in Chrome 116+.
- Confirm the service worker and both extension pages report no console errors.
- Confirm the popup clearly says that WiseNotes captures actual video frames and is not transcript-only summarization.
- Confirm Start stays disabled without a YouTube watch page or Sarvam key, and becomes enabled without requiring an LLM tab or account.

## Transcript

- Human-captioned English lecture: transcript is extracted without opening the panel when player data is available.
- Automatic English captions: transcript succeeds.
- Hindi, Bengali, Tamil, Telugu, Urdu, and other supported Indic caption tracks: native JSON3 captions are translated through Sarvam, then English captions feed the planner.
- An Indic track with no English translation target and `isTranslatable=false` still succeeds through Sarvam translation.
- Human English, automatic English, and translated English all present: human English is selected.
- Captions disabled: the popup reports a useful failure.
- Unsupported non-Indic captions with no English translation or readable panel fallback: the popup reports that supported captions are unavailable.
- Force native Indic retrieval and every offered English translation request to fail: confirm a useful caption error. Force Sarvam translation to return 429: originals and completed English segments remain saved and Resume completes only unfinished segments.
- Force the player-response path to fail and verify transcript-panel scraping. Indic or Romanized Indic panel text must be detected and translated rather than assumed English.
- On a lecture whose captions repeat lines across rolling JSON3 events, confirm the final prompt lists each caption line only once.

## Semantic timestamp planning

- Confirm the complete timestamped transcript is sent to `api.sarvam.ai/v1/chat/completions` with `model=sarvam-105b`, strict JSON output, and a 4096-token budget.
- Confirm no Google Generative Language request is made, even if old provider settings exist.
- Confirm the popup identifies Sarvam-105B and the account has Chat Completions access.
- Close the popup while planning takes longer than 30 seconds; confirm the bounded request continues.
- Simulate transient 503/timeouts and confirm at most three attempts; a persistent failure preserves the transcript and offers Resume.
- Simulate a planner 429; confirm one attempt, a saved Retry-After, and a paused session.
- Confirm invalid, truncated, or refused plans fail visibly rather than beginning capture.
- Confirm chronological bounded windows and local 30-second coverage probes still work.
- Check a long transcript against the 128K context limit; provider rejection should retain the transcript.

## Frame capture

Test the two target formats first and treat them as acceptance-critical: a chalkboard or digital-ink STEM lecture, and a live coding lecture. Cover a slide lecture and a diagram-heavy lecture as secondary cases.

- Confirm Chrome shows tab capture only after Start is clicked.
- Start from a lower manual quality and default layout, then force the lecture-tab fallback and confirm WiseNotes requests the highest exposed quality, uses Theater mode during capture, and restores the prior quality/layout afterward.
- Confirm the saved crop contains the actual video frame and not comments, recommendations, browser chrome, or another tab.
- Confirm the embedded player is pinned to the highest quality the lecture offers: no quality warning appears, and a frame late in the lecture is as sharp as one from the start rather than having dropped resolution mid-run.
- Confirm no player chrome reaches a saved frame: no title bar, control bar, progress bar, YouTube watermark, gradient scrim, or "Watch on YouTube" overlay, checked on a frame captured after a seek as well as the first frame, since YouTube restores its chrome when the player is interacted with.
- Confirm text, equations, and code absent from captions appear in the OCR output. Record failures on handwritten content and diagrams; do not assume OCR understands geometry.
- Confirm duplicate static slides are removed.
- Confirm a changing board around a trigger receives the later settled capture.
- Pause during a blurred transition and confirm WiseNotes prefers a clearer frame from 1.25 seconds before or after, but never substitutes a different slide.
- Confirm the frame budget scales at 0.6 frames per minute with no ceiling: 18 frames for 30 minutes, 36 for an hour, 72 for two hours, and proportionally more beyond that. A three-hour lecture must select more frames than a one-hour lecture, not the same number.
- Confirm a lecture longer than two hours starts and completes, since there is no length limit.
- Confirm playback time, playing state, rate, volume, mute, and scroll position are restored after success, error, and cancellation.
- With a non-Premium account, confirm the dedicated capture tab opens the player page, that the embedded player loads, shows no pre-roll, and that capture completes across the whole lecture without the run stalling.
- Confirm embedded seeking is exact: watch the progress bar during capture and check that frames requested from the beginning, middle, and end of a long lecture are all lecture content, not the first frame repeated.
- Confirm the player is pinned to the top-left corner and fills the capture tab, so the saved crop contains only the video frame with no page background, offset, or border.
- Stop the network (or block the player page) and confirm WiseNotes reports that the player page was unavailable and captures the lecture tab instead.
- Confirm that when the player tab needs permission, the toolbar icon shows a red `1` badge whose tooltip reads "Click the WiseNotes icon once to allow capturing this tab", that the window comes forward, and that the click clears the badge and starts capture. Taking no action must fall back to lecture-tab capture after about a minute.
- Confirm the capture tab does not disturb the lecture tab's own playback beyond the documented pause, and that returning to the lecture tab during capture does not blank the captured frames.
- Confirm that when YouTube renders a Skip Ad control, WiseNotes presses it and capture resumes, and that the frame captured immediately afterwards is lecture content rather than an ad.
- Confirm the lecture tab is paused for the duration, and that timestamp, playing state, rate, volume, mute, quality, layout, and scroll position are all restored after success, error, and cancellation, with the capture tab closed in every case.
- Play a lecture that forbids embedding and confirm WiseNotes reports that the player page was unavailable and then captures the lecture tab instead.
- Force a blank tab stream and confirm visible-tab fallback returns only the player crop.

## Sarvam OCR

- Inspect an upload: exactly one cropped JPEG in a `file` multipart part, the inferred or user-selected source `language`, `content_type=mixed`; no captions or API key in the URL.
- Confirm the returned job ID is saved before polling and corresponds to that frame’s timestamp.
- Confirm the status route is polled until completed, then results are fetched using `format=md`.
- Test equations, code indentation, and tables. Confirm original OCR Markdown is kept verbatim, an English translation is attached, and unknown confidence remains null.
- Test an Indic board during an English-captioned lecture. Set Board and slide language appropriately; OCR must use that source language and the resulting prose must become English.
- Translate an Indic paragraph around code fences and math. Protected code/math bytes and order must survive; inspect translation requests to confirm no protected bytes or replacement markers are sent. Caption timestamps and boundaries must stay local even if the provider flattens line breaks. Untranslated output must fail visibly.
- Resume a 0.5.0 caption-boundary error after updating: completed caption segments are retained, and unfinished captions use marker-free translation. A saved raw OCR result with a legacy translation checkpoint is translated again without creating another OCR job.
- Interrupt after OCR succeeds but during translation. Resume must use saved raw OCR and completed translation chunks without creating another OCR job.
- Test a diagram with labels: the prompt must disclose missing geometry and must not guess invisible relationships from captions.
- Make every OCR result blank; confirm no transcript-only prompt is produced.
- Simulate OCR creation losing its response; confirm it is not automatically repeated. A manual Resume may create another charged job.
- Simulate a 429 after job creation; confirm Resume reuses the saved job and skips completed frames.
- Simulate failed, rejected, partially completed, missing-page, or multiple-page results; confirm they are not accepted as successful single-frame evidence.
- Stall status/results; confirm bounded attempts and an overall 10-minute polling deadline. Resume should check the same known job.
- Cancel while awaiting permission, creating an OCR job, and polling. Confirm local requests stop and the cancelled state stays cancelled; an already submitted Sarvam job may continue remotely.
- Reload the extension during capture; reopen the popup and confirm cleanup closes owned tabs, stops the stream, and restores playback.
- Interrupt after OCR completion but before prompt storage. Resume must build the prompt locally, and JPEGs must survive until the prompt is saved.
- Start from two windows simultaneously; only one run may acquire the shared capture stream.
- After success, inspect IndexedDB and confirm the raw JPEG array is empty.
- Upgrade a saved 0.3.x session: ready prompts remain copyable; unfinished captured frames resume using Sarvam without the old key.
- Use Clear lecture data while a job is active and Resume without a key; confirm failures are shown in the popup.

## Universal prompt handoff

- Confirm the ready state says **Your universal prompt is ready** and exposes **Copy universal prompt**.
- Copy the prompt and confirm it exactly matches the prompt stored for the session.
- Confirm the prompt requests English titles, headings, explanations, table labels, and recap, even for native Indic captions/OCR. Original OCR remains available for verification; code and mathematical literals remain unchanged.
- Confirm the prompt contains no provider-specific instructions or Claude-only artifact requirement.
- Paste it manually into Claude, ChatGPT, and Gemini and confirm each receives a self-contained request for one `pdflatex` document.
- Confirm WiseNotes does not request host access to, open, inspect, or modify any LLM provider site.

## End-to-end acceptance

Run ten English lectures across mathematics, physics, computer science, and engineering. At least four must be a chalkboard or digital-ink STEM lecture, and at least two must be a live coding lecture; those six are the formats WiseNotes is built for. For each generated response:

- Confirm equations and visible technical terms agree with the captured lecture frames.
- Confirm the document contains no invented figures or notation.
- Compile with `pdflatex` or Overleaf.
- Record whether the result is useful without extension debugging.

Also run Hindi, Bengali, and Tamil lectures with native captions and native-script board text. Review the English translation against both the source captions and the original OCR; repeat one lecture with Romanized Indic panel text and one with English captions plus an Indic board.

The beta target is at least eight useful documents out of ten and under five minutes of WiseNotes processing for a 30-minute lecture, excluding the chosen provider’s generation time.
