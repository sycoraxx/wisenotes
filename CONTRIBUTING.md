# Contributing to WiseNotes

WiseNotes exists because “then substitute this” is not a useful record of five lines of board work. Contributions should help preserve what students could actually see.

## Non-negotiables

- **Frames are evidence.** Never infer visible notation or code from captions alone.
- **Fail honestly.** If the visual pipeline fails, do not quietly return transcript-only notes.
- **Protect the student.** No telemetry, backend, ads, paywalls, credential collection, or surprise network requests.
- **Keep the handoff human.** Build and copy the universal prompt; never automate an LLM website or scrape its response.
- **Stay lightweight.** The shipped extension remains dependency-free and works without a build step.
- **Bound the network.** External requests need timeouts; retry only transient failures and never retry a rate limit immediately.

Derivation-heavy STEM and live coding are the reference cases. Test those before optimizing friendlier slide or talking-head content.

## Before opening a pull request

Node 20+ is the only development requirement.

```sh
npm test
npm run check
```

Then run the relevant cases in [test/manual.md](test/manual.md). Never commit API keys, transcripts, captured frames, generated prompts, or LLM conversations.

## Releases

When `manifest.json` changes version:

1. run `npm run package`;
2. inspect the ZIP listing—no `test/`, `docs/`, tools, or source artwork;
3. commit `releases/wisenotes-<version>.zip`;
4. attach that exact file to the matching GitHub Release.

## YouTube changes

Keep selectors centralized in `yt-content.js`. When YouTube changes its UI, record the observed state, update the narrowest adapter, and test the fallback before removing anything.
