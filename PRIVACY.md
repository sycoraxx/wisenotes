# WiseNotes privacy notes

WiseNotes has no backend and collects no telemetry. Data moves only between the user’s browser and the AI services the user explicitly configures.

## Data stored locally

- Gemini API key and selected model ID in Chrome local extension storage.
- Recoverable lecture sessions in IndexedDB: video metadata, transcript, progress, textual Gemini extractions, and the prepared universal prompt.
- Selected JPEG frames only until Gemini has processed them successfully. They are then removed from the session.

The user can remove sessions with **Clear lecture data** and remove the API key with **Forget API key**.

## Data sent to Gemini

- The complete timestamped transcript, once per planning attempt, so an explicit stable Gemini Flash or Flash-Lite model available to the user's key can infer visually important capture moments. If planning must be resumed after a service failure, the request is sent again.
- Locally selected lecture frames, never the complete metadata-only scout set.
- Timestamped transcript excerpts within 30 seconds of every selected frame.
- Instructions to select visual timestamps and to extract visible text, equations, code, tables, and diagrams as structured JSON.

Frame-extraction requests are bounded and retried automatically, so a stalled or transiently failing request may send the same frames and transcript excerpts more than once, up to three attempts. Rate limits and permanent client errors are not retried.

Requests go directly to `generativelanguage.googleapis.com`. Free-tier Gemini inputs and outputs may be used by Google to improve its products according to Google’s current pricing and data-use disclosures.

## Data in the universal prompt

- The complete timestamped transcript.
- Textual visual extractions produced from the selected frames.
- Instructions for producing one complete LaTeX document.

WiseNotes stores this prompt locally and copies it only after the user presses **Copy universal prompt**. The extension does not access any LLM provider site. A provider receives the material only when the user chooses that provider, pastes the prompt, and submits it.

## Tab capture

Chrome grants WiseNotes a media stream of the selected YouTube tab after the user starts a job. WiseNotes crops each capture to the on-page video element before storing or processing it. It does not retain whole-tab screenshots. If primary capture returns a blank image, a whole-tab screenshot may be taken as a fallback, but it is cropped immediately in the offscreen document and only the video crop is returned to the pipeline.

## No hidden collection

WiseNotes does not collect account credentials, browsing history, LLM responses, analytics, crash reports, advertising identifiers, or payment information.
