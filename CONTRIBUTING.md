# Contributing to WiseNotes

Thanks for helping users get better lecture notes.

## Principles

- Video frames are evidence, not decoration. Changes must preserve the rule that visible notation and technical material come from captured frames rather than caption guesses.
- Optimise for sessions where speech is lossy — any lecture whose important content is on screen rather than spoken. Derivation-heavy STEM (chalkboard, digital ink, dense notation) and live coding are the acceptance-critical reference formats; fidelity there outranks convenience for talking-head or slide-only lectures.
- Keep the shipped extension dependency-free and readable without a build step.
- Add no telemetry, backend, advertisements, paywalls, or credential collection.
- Keep the final handoff provider-neutral: WiseNotes may copy the prompt after a user click, but must not automate an LLM website or scrape its response.
- Fail visibly and preserve resumable work when an external interface changes.
- Bound every external request: give it a timeout, retry only transient failures, and never retry a rate limit or a permanent client error. An unbounded await is a hang, not a slow path.

## Checks

Run the dependency-free checks before opening a pull request. They need only a current Node release (Node 20 or newer):

```sh
npm test
npm run check
```

Then complete the relevant scenarios in [test/manual.md](test/manual.md). Do not commit API keys, transcripts, captured lecture frames, prompts, or LLM conversations.

When the version in `manifest.json` changes, run `npm run package` and commit the new `releases/wisenotes-<version>.zip`. That script packages an explicit file list, so review its output: it should list no `test/` or `docs/` files.

## Selector updates

YouTube selectors should remain centralized in its content script. When changing one, document the observed UI state and verify the corresponding fallback instead of deleting it.
