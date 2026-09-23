# WiseNotes

<p align="center">
  <img src="assets/icons/wisenotes-mark.svg" width="92" alt="WiseNotes logo">
</p>

<p align="center"><strong>The lecturer said “substitute this.” The board showed five lines of math.<br>WiseNotes keeps both.</strong></p>

WiseNotes is a free, open-source Chrome extension that turns captioned YouTube lectures into visually grounded LaTeX notes.

It is not a transcript summarizer. WiseNotes captures the lecture’s actual frames and treats them as evidence for equations, diagrams, slides, tables, code, and terminal output. Captions supply the narration and timing; they do not get to guess what appeared on screen.

No subscription. No telemetry. No WiseNotes server. Bring a Gemini API key, then paste the finished universal prompt into Claude, ChatGPT, Gemini, or another capable model.

[Download the latest release](https://github.com/sycoraxx/wisenotes/releases/latest) · [Read the privacy summary](PRIVACY.md) · [See the architecture](PROJECT.md)

## Built for the moments transcripts lose

| Lecture | What a transcript misses | What WiseNotes captures |
|---|---|---|
| Chalkboard or digital ink | Symbols, substitutions, derivation steps | The fullest stable board state |
| Live coding | Exact code, diffs, errors, terminal output | Code and terminal frames around meaningful changes |
| Diagrams and worked problems | Geometry, arrows, labels, intermediate work | The visual state plus nearby explanation |
| Dense technical slides | Notation, tables, figures | Slide pixels as the source of truth |

WiseNotes is less useful for talking-head videos, discussions, or lectures where the speaker reads every slide aloud. In those cases, a transcript summarizer is faster and usually enough.

## From lecture to LaTeX

```text
YouTube captions ──► Gemini finds likely visual moments
                           │
Video pixels ──────► local visual scouting and peak selection
                           │
Selected frames ───► Gemini reads equations, code, tables, diagrams
                           │
Transcript + visual evidence ──► universal synthesis prompt ──► your LLM
```

The final model receives both sides of the lecture:

- **Frames are authoritative** for visible mathematics, notation, code, diagrams, and tables.
- **Captions are authoritative** for spoken explanation, sequence, and topic context.
- Ambiguous visual material stays marked as uncertain instead of being silently invented.

## Install in about a minute

WiseNotes targets desktop Chrome 116+.

1. Download and unzip [`wisenotes-<version>.zip`](https://github.com/sycoraxx/wisenotes/releases/latest).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. Open WiseNotes settings and save a key from [Google AI Studio](https://aistudio.google.com/app/apikey).
5. Open a captioned YouTube lecture and choose **Prepare universal prompt**.

Chrome may ask for one extra click on the WiseNotes toolbar icon when the dedicated capture tab opens. A red `1` badge points to it.

## Use

1. Start WiseNotes from the YouTube watch page.
2. Keep the lecture tab open while WiseNotes identifies and captures visual evidence.
3. If processing is rate-limited or interrupted, reopen the popup and choose **Resume**.
4. Choose **Copy universal prompt** when it is ready.
5. Paste, review, and send it in the LLM you prefer. Claude is the recommended default, including on its free plan.

WiseNotes never opens an LLM website, presses Send, or reads the generated response.

## How the visual pipeline stays efficient

Sending every frame would destroy a free API quota, so selection happens locally first:

1. A stable Gemini Flash model reads the complete timestamped transcript and proposes a small set of visually valuable windows.
2. WiseNotes adds sparse 30-second coverage probes so the model is not the only scout.
3. Metadata-only captures measure regional perceptual hashes, edge density, sharpness, exposure, information density, erasure, scrolling, and scene changes.
4. Peak selection keeps content-rich board, slide, and code states while discarding duplicates and transient frames.
5. Soft winners are checked 1.25 seconds before and after; a replacement is accepted only when it is sharper **and** still belongs to the same scene.
6. Only the winners are recaptured as JPEGs and sent to Gemini in batches of at most 16.

The selected-frame budget is `0.6 × lecture minutes`, rounded up: 18 frames for 30 minutes, 36 for one hour, and 72 for two hours. It is deliberately uncapped, so longer lectures retain proportionally more visual evidence.

## Captions, without pretending there is a public transcript API

WiseNotes prefers:

1. human-written English captions;
2. automatic English captions;
3. a YouTube-generated English translation of another caption track.

It normally downloads the complete timestamped track in one response. Transcript-panel scraping is a compatibility fallback.

The official YouTube Data API cannot download captions from arbitrary public lectures: [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list) returns metadata, while [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download) requires authorization to edit the video. WiseNotes therefore isolates YouTube’s player-caption interface behind a replaceable adapter.

## Privacy and cost, plainly

- The Gemini key stays in `chrome.storage.local`; WiseNotes never syncs or logs it.
- The complete transcript goes to Gemini for timestamp planning.
- Candidate frames stay local. Only selected frames and their nearby captions go to Gemini for visual extraction.
- Processed JPEGs are deleted from the saved session after extraction succeeds.
- The final prompt stays local until the user explicitly copies it.
- Free-tier Gemini data may be used by Google to improve its products. Quotas vary by account and project.
- The static capture page is hosted on GitHub Pages; GitHub receives a normal page request containing the YouTube video ID. See [PRIVACY.md](PRIVACY.md) for the exact data flow.

## Honest limitations

- YouTube’s caption and player internals can change without notice.
- Some videos forbid embedding. WiseNotes then falls back to capturing the original watch tab.
- The hosted embed reduced pre-rolls in testing; it does not block ads or guarantee an ad-free run.
- If YouTube exposes a **Skip Ad** control, the current beta clicks it automatically. The repository documents this because that automation may conflict with YouTube’s terms and may carry account risk.
- Timestamp planning tries the last known-good current-generation Flash model before consulting Gemini’s model catalog. Automatic planning ignores legacy 2.x candidates that Google restricts for new projects. On a fresh install, a catalog outage falls through a current stable full-Flash ladder before the configured Flash-Lite model. Every attempt is bounded; persistent provider outages still require **Resume**.
- WiseNotes prepares the evidence and prompt. It does not compile or download the final `.tex` file.

## Development

The shipped extension is dependency-free vanilla JavaScript. Development needs Node 20+ and no package installation:

```sh
npm test
npm run check
```

Live YouTube, capture, and Gemini scenarios are listed in [test/manual.md](test/manual.md). Contribution rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><strong>Repository map</strong></summary>

```text
manifest.json          Chrome MV3 declaration
background.js          Pipeline orchestration, checkpointing, and recovery
offscreen.*            Video crop, hashes, sharpness, and frame analysis
yt-content.js          YouTube playback control and transcript fallback
popup.* / options.*    Extension interface and local settings
db.js                  IndexedDB session store
lib/                   Pure caption, frame, planner, prompt, state, and Gemini modules
docs/player.html       Static hosted capture page
tools/package.mjs      Runtime-only release packager
test/                  Unit suite and manual browser matrix
```

</details>

## Release packaging

`npm run package` builds a runtime-only ZIP in `releases/`. It includes the MIT licence and privacy policy but excludes tests, development tools, the hosted page, and source artwork. Attach that exact ZIP to the matching GitHub Release whenever the manifest version changes.

## License

MIT. Built for students, with no monetization or tracking.
