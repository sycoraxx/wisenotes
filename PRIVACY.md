# WiseNotes privacy

WiseNotes has no application backend, accounts, analytics, or telemetry. It communicates directly with YouTube and Gemini, loads one static capture page from GitHub Pages, and copies the final prompt only when the user asks.

## Data flow

| Data | Destination | Purpose | Retention by WiseNotes |
|---|---|---|---|
| Gemini API key and model preference | Chrome local extension storage | Authenticate requests | Until **Forget API key** |
| Complete timestamped transcript | Gemini | Select likely visual moments | Stored in the recoverable local session |
| Selected JPEG frames + nearby captions | Gemini | Read equations, code, tables, diagrams, and visible text | JPEGs deleted after successful extraction |
| Textual visual extractions | Local IndexedDB | Build and recover the final prompt | Until **Clear lecture data** |
| Universal synthesis prompt | Local IndexedDB and clipboard | Let the user choose a final LLM | Until **Clear lecture data**; clipboard is user-triggered |
| YouTube video ID | GitHub Pages request | Load the static capture page | Not stored or processed by WiseNotes |

Candidate scout frames remain local. Gemini receives only the frames that survive local ranking.

## Gemini

The transcript is sent once per planning attempt. Resuming after a planning failure sends it again.

Frame extraction is retried only for transient failures. A stalled or transient request may therefore send the same selected frames and nearby captions up to three times. Rate limits and permanent client errors are not retried automatically.

Requests go directly to `generativelanguage.googleapis.com` using the key supplied by the user. Google states that free-tier inputs and outputs may be used to improve its products; users should review Google’s current Gemini pricing and data-use terms before processing sensitive material.

## Hosted capture page

YouTube requires an HTTP(S) referrer for embedded playback, which an extension page cannot provide. WiseNotes therefore opens `sycoraxx.github.io/wisenotes/player.html`.

The page is static, contains no analytics or storage, validates the 11-character YouTube video ID, and embeds only `youtube-nocookie.com`. GitHub’s infrastructure receives the normal page request, including that video ID. If the page is unavailable, WiseNotes falls back to capturing the original watch tab and makes no GitHub Pages request.

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
- **Forget API key** removes the Gemini key without deleting lecture sessions.

WiseNotes does not collect account passwords, browsing history, LLM responses, crash reports, advertising identifiers, or payment information.
