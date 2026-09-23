# Manual browser test matrix

Use a fresh Chrome profile when testing permissions and first-run behavior. Never commit captured content or API keys.

## Installation

- Load the repository as an unpacked extension in Chrome 116+.
- Confirm the service worker and both extension pages report no console errors.
- Confirm the popup clearly says that WiseNotes captures actual video frames and is not transcript-only summarization.
- Confirm Start stays disabled without a YouTube watch page or Gemini key, and becomes enabled without requiring an LLM tab or account.

## Transcript

- Human-captioned English lecture: transcript is extracted without opening the panel when player data is available.
- Automatic English captions: transcript succeeds.
- Non-English captions with English available in YouTube's translation list: an English-translated JSON3 transcript succeeds.
- Non-English captions explicitly marked translatable, but with YouTube's translation-language list omitted: WiseNotes still attempts `tlang=en` and succeeds.
- Human English, automatic English, and translated English all present: human English is selected.
- Captions disabled: the popup reports a useful failure.
- Captions available only in another language with no English translation target: the popup reports that English is unavailable and hides the percentage and progress bar.
- Force every offered translated-caption request to fail: the popup reports a translation retrieval failure rather than claiming no English option exists, hides the progress bar, and shows the explanation only once.
- Force the player-response path to fail and verify transcript-panel scraping.
- On a lecture whose captions repeat lines across rolling JSON3 events, confirm the final prompt lists each caption line only once.

## Semantic timestamp planning

- Confirm WiseNotes lists the models exposed to the API key, rejects aliases and preview/specialized variants, and sends the complete timestamped transcript without images to an explicit stable Flash model.
- Confirm the popup names the Flash model actually selected for the lecture.
- Simulate a `503` and confirm exponential retries occur before WiseNotes tries the next compatible Flash model.
- Make the first four models fail and confirm WiseNotes continues to the fifth, then to stable Flash-Lite.
- Simulate a planner `429` and confirm no second model is called, `Retry-After` is saved, and Resume retries planning.
- Confirm the structured response contains bounded, chronological visual moments and invalid timestamps are rejected.
- Use a lecture with indirect visual language and confirm semantic moments are captured even without literal formula/diagram keywords.
- Simulate every planner candidate returning `503` and confirm the transcript is preserved, no capture begins, and the popup offers Resume.

## Frame capture

Test the two target formats first and treat them as acceptance-critical: a chalkboard or digital-ink STEM lecture, and a live coding lecture. Cover a slide lecture and a diagram-heavy lecture as secondary cases.

- Confirm Chrome shows tab capture only after Start is clicked.
- Start from a lower manual quality and default layout, then force the lecture-tab fallback and confirm WiseNotes requests the highest exposed quality, uses Theater mode during capture, and restores the prior quality/layout afterward.
- Confirm the saved crop contains the actual video frame and not comments, recommendations, browser chrome, or another tab.
- Confirm formulas and diagrams absent from captions appear in the Gemini extraction.
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

## Gemini

- Verify batches contain no more than sixteen images.
- Inspect one request and confirm every frame’s nearby transcript context is represented.
- Confirm returned equations are structured JSON and retain the captured timestamp.
- Test handwritten and typeset equations containing fractions, roots, accents, arrows, primes, nested subscripts, matrices, cases, integrals with bounds, and aligned derivations. Confirm every visible step is returned in order as compilable LaTeX.
- Deliberately use a faint or ambiguous symbol and confirm it appears in `uncertainTokens` with reduced confidence rather than being guessed from captions.
- Simulate malformed JSON, network failure, and an HTTP 429.
- Stall a frame-extraction request and confirm WiseNotes retries automatically up to three times, that no attempt waits indefinitely, and that an error with **Resume** is offered only after the final attempt.
- Confirm an HTTP 429 is never retried and pauses the session instead.
- For 429, confirm completed batches remain, the session pauses, and Resume starts at the first unfinished frame.
- After success, inspect IndexedDB and confirm raw frame data is gone.

## Universal prompt handoff

- Confirm the ready state says **Your universal prompt is ready** and exposes **Copy universal prompt**.
- Copy the prompt and confirm it exactly matches the prompt stored for the session.
- Confirm the prompt contains no provider-specific instructions or Claude-only artifact requirement.
- Paste it manually into Claude, ChatGPT, and Gemini and confirm each receives a self-contained request for one `pdflatex` document.
- Confirm WiseNotes does not request host access to, open, inspect, or modify any LLM provider site.

## End-to-end acceptance

Run ten English lectures across mathematics, physics, computer science, and engineering. At least four must be a chalkboard or digital-ink STEM lecture, and at least two must be a live coding lecture; those six are the formats WiseNotes is built for. For each generated response:

- Confirm equations and visible technical terms agree with the captured lecture frames.
- Confirm the document contains no invented figures or notation.
- Compile with `pdflatex` or Overleaf.
- Record whether the result is useful without extension debugging.

The beta target is at least eight useful documents out of ten and under five minutes of WiseNotes processing for a 30-minute lecture, excluding the chosen provider’s generation time.
