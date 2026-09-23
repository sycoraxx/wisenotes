# WiseNotes

WiseNotes is a free, open-source Chrome extension that turns captioned YouTube lectures into evidence-grounded LaTeX notes.

> **WiseNotes is not “transcript + LLM.”** It captures the lecture’s actual video frames, detects meaningful visual changes, and uses those frames as the source of truth for equations, diagrams, slides, tables, and code. Captions provide narration and timing; they do not get to invent what appeared on screen.

There is no WiseNotes server, subscription, telemetry, build step, or Chrome Web Store dependency. Users bring a free-tier Gemini key and can use the completed prompt with the capable LLM provider of their choice.

## Where WiseNotes shines

The rule is simple: **use WiseNotes wherever the lecture's content is on screen rather than in the narration.** If the important material is shown — notation, code, terminal output, diagrams, tables — then speech is lossy, and a transcript-derived summary provably loses it. That covers any session where the narration alone is not enough. Two formats show it most sharply, and they are what WiseNotes is tuned and tested for:

- **Derivation-heavy STEM** — chalkboard mathematics, digital-ink or tablet handwriting, and dense notation. The steps of a derivation exist only on the board. A transcript reduces them to narration such as “so then we substitute,” which is exactly the information the notes need.
- **Live coding** — a lecturer typing, refactoring, and debugging on screen. The code as written, the compiler and test output, and the terminal state *are* the lecture; spoken narration describes them rather than containing them.

WiseNotes captures the frames in every case, so the notation, code, and terminal output in your notes come from what was actually on screen. The same logic extends to any comparable material: lab walkthroughs, whiteboard architecture and systems-design sessions, statistics and data-modeling work, hardware and circuit diagrams, and worked problems in any technical subject.

**It is not the right tool where the narration already carries the content** — talking-head talks, discussion panels, history, or slide-only lectures whose slides are read aloud. There a free transcript summariser gives a comparable result in seconds without the setup, the capture run, or the visual pipeline. Reach for WiseNotes when losing what was on screen would lose the lecture.

## What it does

1. Reads the English YouTube captions and their timestamps.
2. Opens the lecture in an embedded player on a small static page published from this repository, then captures real video pixels through Chrome’s tab-capture API. YouTube does not serve the watch page’s pre-roll ad to an embedded player. Chrome requires one toolbar click on that new tab before it may be captured, which WiseNotes signals with a red badge on its icon. If that page cannot be reached, WiseNotes captures the user’s own watch tab instead, temporarily requesting its highest exposed quality and Theater mode.
3. Discovers every explicit stable Gemini Flash model available to the user's API key, tries the last successful model first, then falls through from full Flash to Flash-Lite until one can infer visually important timestamps from the complete transcript. Those moments are combined with local 30-second coverage probes.
4. Replaces soft captures with a clearer nearby view of the same scene, measures visual changes locally, and removes duplicate frames.
5. Sends only the selected frames—with nearby caption context—to Gemini Flash-Lite for structured visual and equation extraction.
6. Combines the full transcript with frame-grounded equations, code, tables, and visual descriptions.
7. Builds one provider-neutral synthesis prompt and makes it available through **Copy universal prompt**.
8. The user pastes it into any capable LLM. Claude is recommended and its free plan works well, but it is not required.

Raw candidate frames are ranked and deduplicated on the user’s device. Gemini never receives the full 30-second probe set.

## Transcript retrieval

On the normal path, WiseNotes reads YouTube's player response and prefers human-written English captions, then automatic English captions, then an English translation generated through YouTube from another translatable caption track. It downloads the selected complete timestamped transcript in one JSON response rather than scraping captions line by line. The transcript panel is used only as a compatibility fallback when a direct English track exists but its player-response request fails, or when player caption data is unavailable.

The official YouTube Data API is not a replacement for arbitrary public lectures: [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list) returns track metadata rather than the caption text, while [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download) requires an OAuth-authorized user who has permission to edit the video. The player-response caption URL is therefore isolated as an updateable adapter because it is useful but not a documented public transcript API.

## Install

WiseNotes requires desktop Chrome 116 or newer. Most users want the packaged zip; see [Releases](#releases).

1. Download `wisenotes-<version>.zip` from [the latest release](https://github.com/sycoraxx/wisenotes/releases/latest) and unzip it, or clone this repository if you want to work on it.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder, or this repository folder.
5. Open WiseNotes settings and save a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

No package installation or build command is required for extension users.

## Releases

Each version is published twice, and both are the same file: as a [GitHub Release](https://github.com/sycoraxx/wisenotes/releases) with the zip attached, and as `releases/wisenotes-<version>.zip` in this repository. The [latest release](https://github.com/sycoraxx/wisenotes/releases/latest) is the usual download.

The zip contains only the files Chrome needs to run the extension. Tests, the hosted player page, and the uncompressed logo source are left out. `LICENSE` and `PRIVACY.md` are included, because the MIT terms require the licence notice to travel with copies and the Chrome Web Store requires an accessible privacy policy.

The zip is built by `npm run package` from an explicit file list, and the script fails if the manifest points at a file the package is missing, so an incomplete extension cannot be published by accident. Regenerate it whenever the version in `manifest.json` changes, commit the result, and attach the same file to the matching GitHub Release when you tag one.

Frame capture loads its player page from `sycoraxx.github.io/wisenotes`. If that page cannot be reached, WiseNotes captures the lecture tab directly instead.

## Use

1. Open an English, captioned YouTube lecture of any length.
2. Open WiseNotes and choose **Prepare universal prompt**.
3. Leave the lecture tab open. WiseNotes opens a dedicated capture tab that plays the lecture through the YouTube embed player and seeks through that instead of through your tab. An embedded player is much less likely to serve ads, so runs without YouTube Premium are not stalled mid-capture. Your lecture tab is paused for the duration and restored afterwards, along with the original timestamp, playback state, rate, volume, mute state, quality preference, layout, and scroll position.
4. If WiseNotes reports that it needs permission, click the WiseNotes toolbar icon once on the capture tab. Chrome only allows tab capture for a tab you have invoked the extension on, and invoking it on your lecture tab does not carry over to the capture tab. If you skip this, WiseNotes waits a minute and then captures your lecture tab the older way.
5. When processing finishes, choose **Copy universal prompt**.
6. Paste the prompt into Claude (recommended, including the free plan), ChatGPT, Gemini, or another capable LLM and send it yourself.

## Visual grounding

WiseNotes combines two independent evidence streams:

| Evidence | Role |
|---|---|
| Video frames | Ground truth for formulas, notation, diagrams, tables, slide text, and code |
| Transcript | Narrative, explanation, topic order, and timestamps |

Frame discovery does not rely only on phrases such as “look at this.” WiseNotes queries Gemini's model catalog and accepts only explicit stable `gemini-X.Y-flash` and `gemini-X.Y-flash-lite` model IDs exposed to the user's API key. It tries the last model that completed planning successfully, then every full Flash model from newest to oldest, followed by stable Flash-Lite models. Transient service failures are retried with exponential backoff before the next candidate is attempted. A rate limit pauses the session and honors `Retry-After`; if every Flash candidate is temporarily unavailable, the transcript remains saved and WiseNotes offers Resume instead of silently creating a dense local capture plan. The bounded timestamp plan is combined with a local visual sweep, then WiseNotes calculates perceptual hashes, detects changed scenes, samples settling moments, and ranks frames for both quality and time coverage. When a capture is unusually soft, it checks 1.25 seconds before and after and keeps a meaningfully sharper candidate only when its perceptual hash still matches the original scene. The budget scales with the lecture at 0.6 frames per minute — 18 frames for 30 minutes, 72 for two hours — and is never capped, so a longer lecture gets proportionally more evidence rather than being thinned out.

For every selected frame, Flash-Lite must inspect both handwritten and typeset mathematics and return each visible equation in reading order as pdflatex-compatible content. Each equation also carries its literal visible reading, derivation role, confidence, and any ambiguous glyphs, while a separate context field explains how the equations relate. The synthesis model receives this complete structure and is explicitly forbidden from guessing or silently correcting uncertain notation.

## Privacy and cost

- The Gemini API key is stored only in `chrome.storage.local`, never synced by WiseNotes, and never logged.
- The complete timestamped transcript is sent to the first stable Gemini Flash or Flash-Lite model that completes semantic timestamp planning. A user-triggered Resume after a service failure sends the planning request again.
- Candidate frames stay local. Selected frames and nearby transcript context are sent directly from the extension to Gemini Flash-Lite.
- Raw frames are deleted from WiseNotes storage after Gemini has extracted them successfully.
- The final synthesis prompt is built and stored locally. WiseNotes does not open, inspect, or write into any LLM provider site; only the user decides where to paste it.
- WiseNotes has no analytics, backend, user database, or payment system.
- The number of frames sent to Gemini scales with the lecture at 0.6 per minute, so a long lecture uses proportionally more of the quota. Nothing is capped, which is deliberate: trimming frames would mean less evidence for what was on screen.
- Google currently offers free-tier access for the configured Lite model, but quotas can vary. Free-tier material may be used by Google to improve its products.

See [PRIVACY.md](PRIVACY.md) for the complete data-flow summary.

## Important YouTube warning

WiseNotes captures frames from the YouTube embed player. It blocks no ad requests and patches no player code, but when an ad does play it presses YouTube's own Skip Ad control if YouTube renders one. Automating that click is not something YouTube's Terms of Service authorises, and it may put a YouTube account at risk. WiseNotes never fast-forwards, mutes, or otherwise rewrites an ad, and it waits an ad out when no skip control is offered.

## Using the universal prompt

WiseNotes does not automate any LLM website. It copies the finished prompt only when the user presses **Copy universal prompt**. The user remains responsible for choosing a provider, reviewing the prompt, and submitting it under that provider’s terms. Claude is the recommended default because it handles the structured prompt and long LaTeX output well, including on its free plan, but WiseNotes does not require or access a Claude account.

## Failure recovery

- Completed Gemini batches are checkpointed in IndexedDB.
- Timestamp planning never falls back automatically to an unbounded local cue plan. A temporary service failure preserves the transcript and exposes **Resume**.
- A Gemini `429` pauses the session without discarding captured frames; reopen the popup and choose **Resume** later.
- Gemini frame-extraction requests are bounded and retried automatically. A stalled or transiently failing request is retried up to three times with exponential backoff before WiseNotes reports the error and offers **Resume**. Rate limits and permanent client errors are never retried.
- Timestamp planning is not bounded by a request timeout yet, so a stalled planning request can leave the job waiting at the model-selection step.
- Closing the popup does not intentionally cancel a run. Reopening it displays the last saved session.
- Cancelling restores the YouTube player.
- **Clear lecture data** removes stored sessions, transcripts, extractions, and prompts.
- **Forget API key** removes the Gemini key without touching lecture sessions.

YouTube’s caption and embed-player interfaces can change without notice. WiseNotes uses fallbacks and visible errors, but those integrations cannot be guaranteed.

## Development

The shipped extension is dependency-free vanilla JavaScript. Development needs only a current Node release — Node 20 or newer; install it from [nodejs.org](https://nodejs.org) or your package manager. No other tooling is required. Development tests use only Node’s built-in test runner:

```sh
npm test
npm run check
```

The test suite covers semantic timestamp-plan validation, stable Flash/Flash-Lite discovery and failover, perceptual hashing, local cue scoring, capture budgets, caption-track selection and transcript de-duplication, embed-URL construction, blur recovery, deduplication, transcript windows, Gemini response validation and batch retry bounds, provider-neutral prompt construction, and job-state transitions. Live YouTube and Gemini checks remain manual because they require user accounts, real media, and browser permissions; see [test/manual.md](test/manual.md).

## Project layout

```text
manifest.json          Chrome MV3 declaration
background.js          Pipeline orchestration and recovery
offscreen.*            Tab stream capture, crop, hash, and frame analysis
yt-content.js          YouTube player control and transcript fallback
popup.*                Setup, progress, resume, universal-prompt copy, and data controls
options.*              Local Gemini key and model settings
db.js                  IndexedDB session store
lib/                   Pure caption, embed, frame, planner, prompt, state, hash, trigger, and Gemini modules
docs/player.html       Hosted player page the capture tab opens, published by GitHub Pages
releases/              Release zips, one per version, built by npm run package
tools/package.mjs      Runtime-only packaging script
test/                  Dependency-free unit and manual test coverage
```

The extension logo lives in `assets/icons/`. Its connected frame-and-page symbol represents the central WiseNotes idea: the visual lecture itself flows into the notes.

## License

MIT. WiseNotes is built for users and includes no monetization or tracking.
