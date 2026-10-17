import test from "node:test";
import assert from "node:assert/strict";
import { translateTextToEnglish, translateTranscriptToEnglish, splitTranslationText } from "../lib/translation.js";
import { LANGUAGE_NAMES, normalizeLanguageCode } from "../lib/languages.js";

const response = (value) => ({ ok: true, status: 200, json: async () => value });
const translateHindi = (value) => value.replaceAll("नमस्ते", "Hello").replaceAll("दुनिया", "world");
const options = { apiKey: "fake-key", sourceLanguageCode: "hi-IN", retryDelayMs: 1 };
const translator = (input) => response({ translated_text: translateHindi(input), source_language_code: "hi-IN" });
const completion = (value) => response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const captionTexts = (init) => JSON.parse(JSON.parse(init.body).messages.at(-1).content).texts;
const captionTranslator = (init) => completion({
  translations: captionTexts(init).map(({ id, text }) => ({ id, text: translateHindi(text) }))
});

test("Indic language metadata normalizes all supported languages and YouTube's Odia alias", () => {
  assert.equal(Object.keys(LANGUAGE_NAMES).length, 23);
  for (const code of Object.keys(LANGUAGE_NAMES)) assert.equal(normalizeLanguageCode(code.toLowerCase()), code);
  assert.equal(normalizeLanguageCode("or"), "od-IN");
  assert.equal(normalizeLanguageCode("hi-Latn"), "hi-IN");
  assert.equal(normalizeLanguageCode("es"), "");
});

test("translation targets English using Sarvam Translate with a bounded text input", async () => {
  const result = await translateTextToEnglish({
    ...options, text: "नमस्ते दुनिया",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.sarvam.ai/translate");
      assert.equal(init.headers["api-subscription-key"], "fake-key");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "sarvam-translate:v1");
      assert.equal(body.source_language_code, "hi-IN");
      assert.equal(body.target_language_code, "en-IN");
      assert.equal(body.mode, "formal");
      assert.equal(body.numerals_format, "international");
      return translator(body.input);
    }
  });
  assert.equal(result.text, "Hello world");
});

for (const [code, text, english] of [
  ["bn-IN", "নমস্কার", "Hello"],
  ["ta-IN", "வணக்கம்", "Hello"],
  ["te-IN", "నమస్కారం", "Hello"],
  ["ur-IN", "سلام", "Hello"],
  ["sat-IN", "ᱡᱚᱦᱟᱨ", "Hello"],
  ["hi-IN", "namaste dosto", "Hello friends"]
]) {
  test(`OCR language detection supports ${code} before English translation`, async () => {
    const paths = [];
    const result = await translateTextToEnglish({
      apiKey: "fake-key", text,
      fetchImpl: async (url, init) => {
        paths.push(url);
        const body = JSON.parse(init.body);
        if (url.endsWith("/chat/completions")) {
          assert.equal(body.model, "sarvam-105b");
          assert.equal(body.response_format.json_schema.name, "lecture_source_language");
          return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ languageCode: code }) } }] });
        }
        assert.equal(body.source_language_code, code);
        return response({ translated_text: english });
      }
    });
    assert.equal(paths.length, 2);
    assert.equal(result.text, english);
    assert.equal(result.sourceLanguageCode, code);
  });
}

test("English captions do not consume translation calls", async () => {
  const segments = [{ start: 1.23, text: "English lecture" }];
  const result = await translateTranscriptToEnglish({
    ...options, segments, sourceLanguageCode: "en-IN",
    fetchImpl: () => assert.fail("English captions should not be sent for translation")
  });
  assert.deepEqual(result.segments, segments);
});

test("English-labelled captions containing Indic prose are translated", async () => {
  const result = await translateTranscriptToEnglish({
    apiKey: "fake-key", sourceLanguageCode: "en-IN", segments: [{ start: 2, text: "नमस्ते" }],
    fetchImpl: async (_url, init) => JSON.parse(init.body).response_format.json_schema.name === "lecture_source_language"
      ? completion({ languageCode: "hi-IN" }) : captionTranslator(init)
  });
  assert.deepEqual(result.segments, [{ start: 2, text: "Hello" }]);
});

test("OCR translation preserves fenced code, inline code, math, environments, links and tags", async () => {
  const literals = [
    '```py\nprint("नमस्ते")\n```\n',
    '~~~js\nconst x = "नमस्ते";\n~~~\n',
    '`variable_name`', '$x_1 = \\alpha$', '$$\\sum_i x_i$$',
    '\\[x=1\\]', '\\(y=2\\)', '\\begin{aligned}x&=1\\\\y&=2\\end{aligned}',
    'https://example.test/path', '<table class="x">'
  ];
  const text = "नमस्ते\n" + literals.join("\nनमस्ते\n") + "\nदुनिया";
  const result = await translateTextToEnglish({
    ...options, text, fetchImpl: async (_url, init) => translator(JSON.parse(init.body).input)
  });
  for (const literal of literals) assert.ok(result.text.includes(literal), `lost protected evidence: ${literal}`);
  assert.ok(result.text.startsWith("Hello\n"));
  assert.ok(result.text.endsWith("\nworld"));
});

test("code-only or math-only frames bypass translation and language detection", async () => {
  const text = '```py\nprint("नमस्ते")\n```\n\\[x = \\alpha\\]';
  const result = await translateTextToEnglish({
    apiKey: "fake-key", text,
    fetchImpl: () => assert.fail("literal evidence must stay local to this step")
  });
  assert.equal(result.text, text);
});

test("long OCR prose is chunked below the provider limit while retaining every source character", async () => {
  const text = "नमस्ते दुनिया\n".repeat(500);
  let requests = 0;
  const result = await translateTextToEnglish({
    ...options, text,
    fetchImpl: async (_url, init) => {
      requests += 1;
      const input = JSON.parse(init.body).input;
      assert.ok(input.length <= 2000);
      return translator(input);
    }
  });
  assert.ok(requests > 1);
  assert.equal(result.text, translateHindi(text));
});

test("chunking preserves Unicode pairs and every source character", () => {
  const text = "a".repeat(1995) + "🧠".repeat(1200);
  const chunks = splitTranslationText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("regression: caption batching uses JSON ids, never protected in-text markers or timestamps", async () => {
  const segments = [{ start: 1.25, duration: 2.3, text: "नमस्ते" }];
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith("/v1/chat/completions"));
      const body = JSON.parse(init.body);
      assert.equal(body.model, "sarvam-105b");
      assert.equal(body.reasoning_effort, null);
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(captionTexts(init), [{ id: 0, text: "नमस्ते" }]);
      assert.doesNotMatch(body.messages.at(-1).content, /WNSEG|ZXQWNLITERAL|start|duration/);
      return completion({ translations: [{ id: 0, text: "Hello" }] });
    }
  });
  assert.deepEqual(result.segments, [{ ...segments[0], text: "Hello" }]);
});

test("protected OCR evidence and replacement markers never reach the translation service", async () => {
  const text = 'नमस्ते $x=1$ दुनिया\n```py\nprint("नमस्ते")\n```\nनमस्ते';
  const inputs = [];
  const result = await translateTextToEnglish({
    ...options, text,
    fetchImpl: async (_url, init) => {
      const { input } = JSON.parse(init.body);
      inputs.push(input);
      assert.doesNotMatch(input, /ZXQWNLITERAL|WNSEG|\$|```|print/);
      return translator(input);
    }
  });
  assert.deepEqual(inputs, ["नमस्ते", "दुनिया", "नमस्ते"]);
  assert.equal(result.text, 'Hello $x=1$ world\n```py\nprint("नमस्ते")\n```\nHello');
});

test("untranslated Indic output is rejected", async () => {
  await assert.rejects(translateTextToEnglish({
    ...options, text: "नमस्ते", fetchImpl: async () => response({ translated_text: "नमस्ते" })
  }), /left Indic prose untranslated/);
});

test("equations retain exact bytes and order without trusting provider formatting", async () => {
  const result = await translateTextToEnglish({
    ...options, text: "नमस्ते $x=1$ दुनिया $y=2$",
    fetchImpl: async (_url, init) => {
      const { input } = JSON.parse(init.body);
      assert.ok(input === "नमस्ते" || input === "दुनिया");
      return response({ translated_text: `  ${translateHindi(input)}  ` });
    }
  });
  assert.equal(result.text, "Hello $x=1$ world $y=2$");
});

test("80 short captions take three batch requests while preserving timestamps, count, and order", async () => {
  const segments = Array.from({ length: 80 }, (_, index) => ({ start: index * 2.37, text: "नमस्ते दुनिया" }));
  let requests = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => { requests += 1; return captionTranslator(init); }
  });
  assert.equal(requests, 3);
  assert.deepEqual(result.segments, segments.map((segment) => ({ ...segment, text: "Hello world" })));
});

test("caption translation resumes at the first unfinished batch after 429", async () => {
  const segments = Array.from({ length: 70 }, (_, start) => ({ start, text: "नमस्ते दुनिया" }));
  let completedSegments = [];
  let calls = 0;
  await assert.rejects(translateTranscriptToEnglish({
    ...options, segments, onProgress: async (progress) => { completedSegments = progress.segments; },
    fetchImpl: async (_url, init) => ++calls === 2
      ? { ok: false, status: 429, headers: { get: () => "60" } }
      : captionTranslator(init)
  }), (error) => error.status === 429);
  assert.equal(calls, 2);
  assert.equal(completedSegments.length, 32);
  let resumedCalls = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments, completedSegments,
    fetchImpl: async (_url, init) => { resumedCalls += 1; return captionTranslator(init); }
  });
  assert.equal(resumedCalls, 2);
  assert.equal(result.segments.length, 70);
});

test("v0.5.0 completed captions resume with marker-free requests", async () => {
  const segments = [{ start: 1, text: "नमस्ते" }, { start: 3.75, text: "दुनिया" }];
  const completedSegments = [{ start: 1, text: "Hello" }];
  const inputs = [];
  const result = await translateTranscriptToEnglish({
    ...options, segments, completedSegments,
    fetchImpl: async (_url, init) => {
      inputs.push(...captionTexts(init).map((item) => item.text));
      return captionTranslator(init);
    }
  });
  assert.deepEqual(inputs, ["दुनिया"]);
  assert.deepEqual(result.segments, [completedSegments[0], { start: 3.75, text: "world" }]);
});

test("batched captions keep literal code, math, links, tags and their order entirely local", async () => {
  const segments = [
    { start: 1.37, duration: 4.2, text: 'नमस्ते $x=1$ दुनिया `keep("नमस्ते")`' },
    { start: 7.31, text: "दुनिया \\[y=2\\] नमस्ते https://example.test/path <b>दुनिया</b>" }
  ];
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => {
      for (const { text } of captionTexts(init)) {
        assert.ok(text === "नमस्ते" || text === "दुनिया");
        assert.doesNotMatch(text, /ZXQWNLITERAL|WNSEG|keep|\$|https:|<b>/);
      }
      return captionTranslator(init);
    }
  });
  assert.deepEqual(result.segments, [
    { ...segments[0], text: 'Hello $x=1$ world `keep("नमस्ते")`' },
    { ...segments[1], text: "world \\[y=2\\] Hello https://example.test/path <b>world</b>" }
  ]);
});

test("provider response order cannot move translations to different timestamps", async () => {
  const segments = [{ start: 3.25, text: "नमस्ते" }, { start: 12.5, text: "दुनिया" }];
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => completion({
      translations: captionTexts(init).map(({ id, text }) => ({ id, text: translateHindi(text) })).reverse()
    })
  });
  assert.deepEqual(result.segments, [{ start: 3.25, text: "Hello" }, { start: 12.5, text: "world" }]);
});

test("caption batches are bounded by source characters as well as segment count", async () => {
  const segments = Array.from({ length: 20 }, (_, start) => ({ start, text: "नमस्ते ".repeat(90) }));
  let requests = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => {
      requests += 1;
      const texts = captionTexts(init);
      assert.ok(texts.length <= 32);
      assert.ok(texts.reduce((sum, item) => sum + item.text.length, 0) <= 4000);
      return captionTranslator(init);
    }
  });
  assert.equal(requests, 4);
  assert.deepEqual(result.segments, segments.map((segment) => ({ ...segment, text: translateHindi(segment.text) })));
});

test("fragmented captions cannot exceed the structured batch item budget", async () => {
  const segments = Array.from({ length: 30 }, (_, start) => ({ start, text: "नमस्ते $x$ दुनिया $y$ नमस्ते" }));
  let requests = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => {
      requests += 1;
      assert.ok(captionTexts(init).length <= 64);
      return captionTranslator(init);
    }
  });
  assert.equal(requests, 2);
  assert.deepEqual(result.segments, segments.map((segment) => ({ ...segment, text: translateHindi(segment.text) })));
});

test("unusually large captions retain bounded Translate requests instead of risking batch truncation", async () => {
  const segments = [{ start: 2.71, text: "नमस्ते ".repeat(800) }];
  let requests = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (url, init) => {
      requests += 1;
      assert.ok(url.endsWith("/translate"));
      const { input } = JSON.parse(init.body);
      assert.ok(input.length <= 2000);
      return translator(input);
    }
  });
  assert.equal(requests, 3);
  assert.deepEqual(result.segments, [{ start: 2.71, text: translateHindi(segments[0].text) }]);
});

test("literal-only captions do not consume a batch translation request", async () => {
  const segments = [{ start: 4, text: '$x=1$ `print("नमस्ते")`' }, { start: 5, text: "123 + 456" }];
  const result = await translateTranscriptToEnglish({
    ...options, segments, fetchImpl: () => assert.fail("literal evidence must stay local")
  });
  assert.deepEqual(result.segments, segments);
});

for (const [name, translations] of [
  ["missing", [{ id: 0, text: "Hello" }]],
  ["duplicate", [{ id: 0, text: "Hello" }, { id: 0, text: "world" }]],
  ["unknown", [{ id: 0, text: "Hello" }, { id: 2, text: "world" }]],
  ["wrong type", [{ id: "0", text: "Hello" }, { id: 1, text: "world" }]],
  ["empty", [{ id: 0, text: "Hello" }, { id: 1, text: " " }]],
  ["untranslated", [{ id: 0, text: "Hello" }, { id: 1, text: "दुनिया" }]]
]) {
  test(`${name} batch results cannot be checkpointed as completed captions`, async () => {
    let checkpoints = 0;
    await assert.rejects(translateTranscriptToEnglish({
      ...options, segments: [{ start: 1, text: "नमस्ते" }, { start: 2, text: "दुनिया" }],
      onProgress: async () => { checkpoints += 1; },
      fetchImpl: async () => completion({ translations })
    }), /caption/);
    assert.equal(checkpoints, 0);
  });
}

test("a truncated batch response is rejected without saving partial captions", async () => {
  await assert.rejects(translateTranscriptToEnglish({
    ...options, segments: [{ start: 1, text: "नमस्ते" }],
    onProgress: () => assert.fail("must not save partial output"),
    fetchImpl: async () => response({ choices: [{ finish_reason: "length", message: { content: '{"translations":[]}' } }] })
  }), /did not complete English caption translation/);
});

test("cancelling a caption batch aborts the request without checkpointing it", async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = translateTranscriptToEnglish({
    ...options, segments: [{ start: 1, text: "नमस्ते" }], signal: controller.signal,
    onProgress: () => assert.fail("cancelled output must not be saved"),
    fetchImpl: async () => { requests += 1; return new Promise(() => {}); }
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests, 1);
});

test("legacy masked OCR checkpoints are not mistaken for new local-only parts", async () => {
  const result = await translateTextToEnglish({
    ...options, text: "नमस्ते $x=1$ दुनिया",
    checkpoint: { sourceLanguageCode: "hi-IN", completedChunks: ["Hello ZXQWNLITERAL0QXZ"] },
    fetchImpl: async (_url, init) => translator(JSON.parse(init.body).input)
  });
  assert.equal(result.text, "Hello $x=1$ world");
});

test("OCR translation resumes local-only parts without repeating translated prose", async () => {
  const text = "नमस्ते $x=1$ दुनिया";
  let checkpoint;
  let calls = 0;
  await assert.rejects(translateTextToEnglish({
    ...options, text, onProgress: async (value) => { checkpoint = value; },
    fetchImpl: async (_url, init) => ++calls === 2
      ? { ok: false, status: 429, headers: { get: () => "60" } }
      : translator(JSON.parse(init.body).input)
  }), (error) => error.status === 429);
  assert.equal(checkpoint.version, 2);
  assert.deepEqual(checkpoint.completedChunks, ["Hello ", "$x=1$"]);
  const inputs = [];
  const result = await translateTextToEnglish({
    ...options, text, checkpoint,
    fetchImpl: async (_url, init) => {
      const { input } = JSON.parse(init.body);
      inputs.push(input);
      return translator(input);
    }
  });
  assert.deepEqual(inputs, ["दुनिया"]);
  assert.equal(result.text, "Hello $x=1$ world");
});

test("OCR translation resumes completed text chunks without repeating them", async () => {
  const text = "नमस्ते दुनिया\n".repeat(500);
  let checkpoint;
  let calls = 0;
  await assert.rejects(translateTextToEnglish({
    ...options, text, onProgress: async (value) => { checkpoint = value; },
    fetchImpl: async (_url, init) => ++calls === 2
      ? { ok: false, status: 429, headers: { get: () => "60" } }
      : translator(JSON.parse(init.body).input)
  }), (error) => error.status === 429);
  assert.equal(checkpoint.completedChunks.length, 1);
  let resumedCalls = 0;
  const result = await translateTextToEnglish({
    ...options, text, checkpoint,
    fetchImpl: async (_url, init) => { resumedCalls += 1; return translator(JSON.parse(init.body).input); }
  });
  assert.equal(resumedCalls, splitTranslationText(text).length - 1);
  assert.equal(result.text, translateHindi(text));
});

test("a cancelled translation makes no request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(translateTextToEnglish({
    ...options, text: "नमस्ते", signal: controller.signal,
    fetchImpl: () => assert.fail("must not fetch")
  }), { name: "AbortError" });
});
