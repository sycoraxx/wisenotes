# WiseNotes

<p align="center">
  <img src="assets/icons/wisenotes-mark.svg" width="92" alt="WiseNotes logo">
</p>

<p align="center"><strong>The lecturer said “substitute this.” The board showed five lines of math.<br>WiseNotes keeps both.</strong></p>

WiseNotes is a free, open-source Chrome extension that turns captioned YouTube lectures into visually grounded English LaTeX notes, including lectures with supported Indic-language captions.

WiseNotes captures lecture frames, selects useful visual states locally, and reads them with Sarvam Vision OCR. Captions supply narration and timing; OCR supplies visible text, equations, tables, code, and terminal output. Native Indic captions and OCR prose are translated into English using Sarvam Translate, with original timestamps and visual evidence retained. OCR may miss faint handwriting or diagram geometry, so the final prompt explicitly preserves that uncertainty.

No WiseNotes subscription, telemetry, or server. Bring a Sarvam API key with Chat Completions, Document AI, and Text Translation access; Sarvam usage consumes your account’s credits. Paste the finished universal prompt into the capable LLM you prefer.

[Download the latest release](https://github.com/sycoraxx/wisenotes/releases/latest) · [Read the privacy summary](PRIVACY.md) · [See the architecture](PROJECT.md)

## Built for the moments transcripts lose

| Lecture | What a transcript misses | What WiseNotes captures |
|---|---|---|
| Chalkboard or digital ink | Symbols, substitutions, derivation steps | The fullest stable board state |
| Live coding | Exact code, diffs, errors, terminal output | Code and terminal frames around meaningful changes |
| Diagrams and worked problems | Labels, intermediate written work | OCR-readable content; geometry may be missing |
| Dense technical slides | Notation and tables | OCR text and tables from selected slide frames |

WiseNotes is less useful for talking-head videos, discussions, or lectures where the speaker reads every slide aloud. In those cases, a transcript summarizer is faster and usually enough.

## From lecture to LaTeX

```text
YouTube captions ──► English translation ──► Sarvam-105B finds visual moments
                           │
Video pixels ──────► local visual scouting and peak selection
                           │
Selected frames ───► Sarvam Vision OCR ──► English translation of prose
                           │
Transcript + visual evidence ──► universal synthesis prompt ──► your LLM
```

The final model receives both sides of the lecture:

- **OCR from frames supplies visual evidence** for visible mathematics, notation, code, and tables; it is a machine reading that needs review.
- **Captions are authoritative** for spoken explanation, sequence, and topic context.
- Missing symbols or diagram relationships must not be reconstructed from captions.

## Install in about a minute

WiseNotes targets desktop Chrome 116+.

1. Download and unzip [`wisenotes-<version>.zip`](https://github.com/sycoraxx/wisenotes/releases/latest).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. Open WiseNotes settings and save a key from the [Sarvam dashboard](https://indus.sarvam.ai/key-management).
5. Open a captioned YouTube lecture and choose **Prepare universal prompt**.

Upgrading from 0.3.x: reload the extension in `chrome://extensions` to apply Sarvam host access, then save a Sarvam key. Existing prompts remain available; recoverable captured frames can resume through Sarvam. Saving the new key removes the old provider settings.

Chrome may ask for one extra click on the WiseNotes toolbar icon when the dedicated capture tab opens. A red `1` badge points to it.

## Use

1. Start WiseNotes from the YouTube watch page.
2. Keep the lecture tab open while WiseNotes identifies and captures visual evidence.
3. Indic captions and OCR prose are translated into English automatically. If slides use a different language from the captions, set **Board and slide language** in settings.
4. If processing is rate-limited or interrupted, reopen the popup and choose **Resume**.
5. Choose **Copy universal prompt** when it is ready.
6. Paste, review, and send it in the LLM you prefer. Claude is the recommended default, including on its free plan.

WiseNotes never opens an LLM website, presses Send, or reads the generated response.

## How the visual pipeline stays efficient

Local selection reduces OCR requests and credits:

1. Sarvam’s flagship `sarvam-105b` model reads the complete timestamped transcript and proposes a small set of visually valuable windows.
2. WiseNotes adds sparse 30-second coverage probes so the model is not the only scout.
3. Metadata-only captures measure regional perceptual hashes, edge density, sharpness, exposure, information density, erasure, scrolling, and scene changes.
4. Peak selection keeps content-rich board, slide, and code states while discarding duplicates and transient frames.
5. Soft winners are checked 1.25 seconds before and after; a replacement is accepted only when it is sharper **and** still belongs to the same scene.
6. Only the winners are recaptured as JPEGs and sent to Sarvam Document AI, one cropped frame per OCR job. Each job ID and completed frame are checkpointed for Resume.

The selected-frame budget is `0.6 × lecture minutes`, rounded up: 18 frames for 30 minutes, 36 for one hour, and 72 for two hours. It is deliberately uncapped, so longer lectures retain proportionally more visual evidence.

## Captions, without pretending there is a public transcript API

WiseNotes prefers human-written English captions, then automatic English. If no direct English track can be retrieved, it uses native captions in one of Sarvam Translate’s 22 supported Indic languages and translates them to English. YouTube-generated English translations remain a fallback for other available tracks.

The original captions stay saved locally. English translation is batched below the provider’s 2,000-character input limit, preserves each timestamp, and checkpoints completed segments. Transcript-panel fallback text is language-detected before planning. The final prompt requires English titles, explanations, headings, and labels while preserving literal code and mathematics.

It normally downloads the complete timestamped track in one response. Transcript-panel scraping is a compatibility fallback.

The official YouTube Data API cannot download captions from arbitrary public lectures: [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list) returns metadata, while [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download) requires authorization to edit the video. WiseNotes therefore isolates YouTube’s player-caption interface behind a replaceable adapter.

## Privacy and cost, plainly

- The Sarvam key stays in `chrome.storage.local`; WiseNotes never syncs or logs it.
- Captions and OCR prose may go to Sarvam-105B for language detection and to `sarvam-translate:v1` for English translation. The complete English transcript goes to Sarvam-105B for timestamp planning.
- Candidate frames stay local. Selected cropped JPEGs go to Sarvam Vision for OCR; captions are not uploaded with the images.
- JPEGs are deleted locally only after OCR succeeds and the final prompt is saved.
- Raw OCR and its English translation are kept together. Code blocks, mathematical notation, and literal data are protected during translation.
- The final prompt stays local until the user explicitly copies it.
- Sarvam’s pricing, quotas, and server-side data retention follow your account and its service terms. Clearing local lecture data does not delete uploaded documents from Sarvam.
- The static capture page is hosted on GitHub Pages; GitHub receives a normal page request containing the YouTube video ID. See [PRIVACY.md](PRIVACY.md) for the exact data flow.

## Honest limitations

- Videos still need readable captions; this version does not transcribe uncaptioned audio.
- YouTube’s caption and player internals can change without notice.
- Some videos forbid embedding. WiseNotes then falls back to capturing the original watch tab.
- The hosted embed reduced pre-rolls in testing; it does not block ads or guarantee an ad-free run.
- If YouTube exposes a **Skip Ad** control, the current beta clicks it automatically. The repository documents this because that automation may conflict with YouTube’s terms and may carry account risk.
- Planning uses `sarvam-105b` through the public V1 Chat Completions endpoint with strict JSON output. Requests have a 120-second timeout; transient planning and OCR polling failures retry at most three times. Rate limits pause immediately. OCR creation is attempted once to avoid automatically duplicating a billable job.
- Sarvam Vision is an OCR service, so diagram geometry, faint handwriting, and code indentation need special review. Empty OCR never becomes transcript-only notes.
- Sarvam-105B has a 128K-token context window. Very large transcripts can exceed provider limits; WiseNotes preserves them on failure.
- WiseNotes prepares the evidence and prompt. It does not compile or download the final `.tex` file.

## Development

The shipped extension is dependency-free vanilla JavaScript. Development needs Node 20+ and no package installation:

```sh
npm test
npm run check
```

Live YouTube, capture, and Sarvam scenarios are listed in [test/manual.md](test/manual.md). Contribution rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><strong>Repository map</strong></summary>

```text
manifest.json          Chrome MV3 declaration
background.js          Pipeline orchestration, checkpointing, and recovery
offscreen.*            Video crop, hashes, sharpness, and frame analysis
yt-content.js          YouTube playback control and transcript fallback
popup.* / options.*    Extension interface and local settings
db.js                  IndexedDB session store
lib/                   Caption, frame, planner, prompt, state, and Sarvam/OCR modules
docs/player.html       Static hosted capture page
tools/package.mjs      Runtime-only release packager
test/                  Unit suite and manual browser matrix
```

</details>

## Release packaging

`npm run package` builds a runtime-only ZIP in `releases/`. It includes the MIT licence and privacy policy but excludes tests, development tools, the hosted page, and source artwork. Attach that exact ZIP to the matching GitHub Release whenever the manifest version changes.

## License

MIT. Built for students, with no monetization or tracking.
