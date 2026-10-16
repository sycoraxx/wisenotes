import test from "node:test";
import assert from "node:assert/strict";
import { translateTextToEnglish, translateTranscriptToEnglish, splitTranslationText } from "../lib/translation.js";
import { LANGUAGE_NAMES, normalizeLanguageCode } from "../lib/languages.js";

const response = (value) => ({ ok: true, status: 200, json: async () => value });
const translateHindi = (value) => value.replaceAll("नमस्ते", "Hello").replaceAll("दुनिया", "world");
const options = { apiKey: "fake-key", sourceLanguageCode: "hi-IN", retryDelayMs: 1 };
const translator = (input) => response({ translated_text: translateHindi(input), source_language_code: "hi-IN" });

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
    fetchImpl: async (url, init) => url.endsWith("/chat/completions")
      ? response({ choices: [{ finish_reason: "stop", message: { content: '{"languageCode":"hi-IN"}' } }] })
      : translator(JSON.parse(init.body).input)
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

test("chunking preserves Unicode pairs and never splits an opaque protected marker", () => {
  const text = "a".repeat(1995) + "ZXQWNLITERAL0QXZ" + "🧠".repeat(1200);
  const chunks = splitTranslationText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.ok(chunks.some((chunk) => chunk.includes("ZXQWNLITERAL0QXZ")));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("modified or duplicated protected tokens fail instead of corrupting evidence", async () => {
  for (const corrupt of [
    (input) => input.replace(/ZXQWNLITERAL\d+QXZ/g, ""),
    (input) => input.replace(/(ZXQWNLITERAL\d+QXZ)/g, "$1 $1")
  ]) {
    await assert.rejects(translateTextToEnglish({
      ...options, text: "नमस्ते $x=1$",
      fetchImpl: async (_url, init) => response({ translated_text: corrupt(translateHindi(JSON.parse(init.body).input)) })
    }), /protected equation/);
  }
});

test("untranslated Indic output is rejected", async () => {
  await assert.rejects(translateTextToEnglish({
    ...options, text: "नमस्ते", fetchImpl: async () => response({ translated_text: "नमस्ते" })
  }), /left Indic prose untranslated/);
});

test("translation cannot reverse the visual order of two equations", async () => {
  await assert.rejects(translateTextToEnglish({
    ...options, text: "नमस्ते $x=1$ दुनिया $y=2$",
    fetchImpl: async (_url, init) => {
      const input = translateHindi(JSON.parse(init.body).input);
      const markers = [...input.matchAll(/ZXQWNLITERAL\d+QXZ/g)].map((match) => match[0]);
      return response({ translated_text: input.replaceAll(/ZXQWNLITERAL\d+QXZ/g, () => markers.pop()) });
    }
  }), /reordered protected equations/);
});

test("caption batches preserve exact timestamps, count, and order", async () => {
  const segments = Array.from({ length: 80 }, (_, index) => ({ start: index * 2.37, text: "नमस्ते दुनिया" }));
  const result = await translateTranscriptToEnglish({
    ...options, segments,
    fetchImpl: async (_url, init) => translator(JSON.parse(init.body).input)
  });
  assert.deepEqual(result.segments, segments.map((segment) => ({ ...segment, text: "Hello world" })));
});

test("caption translation resumes at the first unfinished batch after 429", async () => {
  const segments = Array.from({ length: 3 }, (_, start) => ({ start, text: "नमस्ते ".repeat(180) }));
  let completedSegments = [];
  let calls = 0;
  await assert.rejects(translateTranscriptToEnglish({
    ...options, segments, onProgress: async (progress) => { completedSegments = progress.segments; },
    fetchImpl: async (_url, init) => ++calls === 2
      ? { ok: false, status: 429, headers: { get: () => "60" } }
      : translator(JSON.parse(init.body).input)
  }), (error) => error.status === 429);
  assert.equal(completedSegments.length, 1);
  let resumedCalls = 0;
  const result = await translateTranscriptToEnglish({
    ...options, segments, completedSegments,
    fetchImpl: async (_url, init) => { resumedCalls += 1; return translator(JSON.parse(init.body).input); }
  });
  assert.equal(resumedCalls, 2);
  assert.equal(result.segments.length, 3);
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
