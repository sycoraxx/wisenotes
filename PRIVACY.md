# WiseNotes privacy

WiseNotes has no application backend, accounts, analytics, or telemetry. It communicates directly with YouTube and Sarvam, loads one static capture page from GitHub Pages, and copies the final prompt only when the user asks.

## Data flow

| Data | Destination | Purpose | Retention by WiseNotes |
|---|---|---|---|
| Sarvam API key | Chrome local extension storage | Authenticate requests | Until **Forget API key** |
| Original captions and OCR prose | Sarvam Chat Completions / Text Translation | Identify the source language and translate Indic prose into English | Originals and completed translations stay in the local session |
| Complete English timestamped transcript | Sarvam-105B | Select likely visual moments | Stored in the recoverable local session |
| Selected cropped JPEG frames | Sarvam Document AI | OCR for visible text, equations, code, and tables | JPEGs deleted locally when the final prompt is saved |
| OCR job IDs and textual visual extractions | Local IndexedDB | Build and recover the final prompt | Until **Clear lecture data** |
| Universal synthesis prompt | Local IndexedDB and clipboard | Let the user choose a final LLM | Until **Clear lecture data**; clipboard is user-triggered |
| YouTube video ID | GitHub Pages request | Load the static capture page | Not stored or processed by WiseNotes |

Candidate scout frames remain local. Sarvam receives only the frames that survive local ranking.

## Sarvam

The English transcript is sent once per planning attempt. Resuming after a planning failure sends it again.

Requests go directly to `api.sarvam.ai` with the user’s subscription key in an authentication header. Source captions and OCR prose may be sent to `sarvam-105b` for language detection and to `/translate` with `sarvam-translate:v1` for English translation. The English transcript goes to `sarvam-105b` for planning. Selected cropped images go to Document AI for OCR; the OCR upload does not include captions.

Planning, language detection, translation, and read-only OCR status/results requests may retry transient failures up to three attempts. A 429 pauses immediately. Creating an OCR job is attempted once automatically; after Sarvam returns a job ID, that ID is saved locally and reused on Resume. If creation succeeded but its response was lost, no ID is available and a user-triggered Resume may create another job.

Original captions, raw OCR, English translations, translation checkpoints, and server job IDs stay in the local session for recovery. Caption timestamps remain unchanged. Translation excludes protected code blocks, math, and literal data. Completed caption batches and OCR chunks are reused on Resume. Local JPEGs are removed when the final prompt is saved. **Clear lecture data** only deletes local copies; it does not cancel or delete Sarvam’s server jobs or uploads. Cancelling stops local work, while a submitted server job may continue. Sarvam’s server retention and data-use rules depend on its service terms and the user’s account; WiseNotes makes no promise about server-side deletion.

Saving a Sarvam key removes the previous provider’s stored key and model preferences. Existing lecture sessions and prompts remain available, and recoverable frames can be processed through Sarvam.

## Hosted capture page

YouTube requires an HTTP(S) referrer for embedded playback, which an extension page cannot provide. WiseNotes therefore opens `sycoraxx.github.io/wisenotes/player.html`.

The page is static, contains no analytics or storage, validates the 11-character YouTube video ID, and embeds only `youtube-nocookie.com`. GitHub’s infrastructure receives the normal page request, including that video ID. If the page is unavailable, WiseNotes falls back to capturing the original watch tab after the attempted GitHub Pages request.

## Tab capture

After the user starts a job, Chrome provides a media stream for the selected YouTube tab. WiseNotes crops every capture to the video element before returning it to the pipeline. A blank-stream fallback may momentarily capture the visible tab, but it is cropped inside the offscreen document; the whole-tab image is not persisted.

## Final LLM

WiseNotes does not access Claude, ChatGPT, Gemini’s chat interface, or another LLM website. It stores the universal prompt locally and copies it only after **Copy universal prompt** is pressed. The chosen provider receives it only after the user pastes and submits it.

## Google API Limited Use

WiseNotes uses information received from Google APIs only to create the user-requested lecture prompt.

**The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.**

See the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

WiseNotes does not sell lecture data, use it for advertising, or expose it to a WiseNotes operator. There is no WiseNotes server on which a human could inspect it.

## User controls

- **Clear lecture data** removes saved sessions, transcripts, frame extractions, and prompts.
- **Forget API key** removes the Sarvam key and any legacy provider key without deleting lecture sessions.

WiseNotes does not collect account passwords, browsing history, LLM responses, crash reports, advertising identifiers, or payment information.
