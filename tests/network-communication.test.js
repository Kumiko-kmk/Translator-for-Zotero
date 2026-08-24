"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadTranslationContext,
  makeSegment
} = require("./helpers");

function successfulQwenResponse(text) {
  return {
    status: 200,
    response: {
      choices: [{ message: { content: text } }]
    }
  };
}

test("translation provider registry exposes credential and model contracts", function () {
  const context = loadTranslationContext();
  const registry = context.TranslationProviderRegistry;
  const providerIDs = Object.keys(registry);

  assert.equal(providerIDs.length, 6);
  assert.deepEqual(
    providerIDs.slice().sort(),
    ["bing", "cnki", "deepseek", "gemini", "qwen-mt", "transmart"]
  );
  assert.equal(registry.deepseek.credentialMode, "api-key");
  assert.equal(registry["qwen-mt"].credentialMode, "api-key");
  assert.equal(registry.gemini.credentialMode, "api-key");
  assert.equal(registry.bing.credentialMode, "none");
  assert.equal(registry.transmart.credentialMode, "none");
  assert.equal(registry.cnki.credentialMode, "none");
});

test("Qwen sends a redacted authenticated request and parses the response", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("title", "A reliable title", { id: "title" });
  const requests = [];
  context.setHTTP(async function (method, endpoint, options) {
    requests.push({ method, endpoint, options });
    return successfulQwenResponse("可靠标题");
  });

  const result = await context.QwenMTPlusTranslationClient.translate(
    "qwen-secret",
    [segment],
    { cancelled: false },
    { retryDelays: [], targetLanguage: "zh-CN" }
  );

  assert.equal(result.get("title"), "可靠标题");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].endpoint, /dashscope/);
  assert.doesNotMatch(requests[0].endpoint, /qwen-secret/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer qwen-secret");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "qwen-mt-plus");
  assert.equal(payload.messages[0].content, "A reliable title");
  assert.equal(payload.translation_options.source_lang, "English");
  assert.equal(payload.translation_options.target_lang, "Chinese");
});

test("Qwen retries transient HTTP and network failures, then surfaces authentication errors", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("abstract", "A short abstract", { id: "abstract" });
  let calls = 0;
  context.setHTTP(async function () {
    calls++;
    if (calls === 1) return { status: 429, response: {} };
    return successfulQwenResponse("摘要译文");
  });

  const translated = await context.QwenMTPlusTranslationClient.request(
    "qwen-secret",
    [segment],
    { cancelled: false },
    { retryDelays: [0] }
  );
  assert.equal(translated, "摘要译文");
  assert.equal(calls, 2);

  calls = 0;
  context.setHTTP(async function () {
    calls++;
    if (calls === 1) throw new Error("temporary network failure");
    return successfulQwenResponse("网络恢复");
  });
  const recovered = await context.QwenMTPlusTranslationClient.request(
    "qwen-secret",
    [segment],
    { cancelled: false },
    { retryDelays: [0] }
  );
  assert.equal(recovered, "网络恢复");
  assert.equal(calls, 2);

  context.setHTTP(async function () {
    return { status: 401, response: {} };
  });
  await assert.rejects(
    context.QwenMTPlusTranslationClient.request(
      "qwen-secret",
      [segment],
      { cancelled: false },
      { retryDelays: [0] }
    ),
    function (error) {
      return error && error.status === 401;
    }
  );
});

test("DeepSeek posts structured JSON and validates the mocked provider reply", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("title", "A title to translate", { id: "title" });
  const requests = [];
  context.setHTTP(async function (method, endpoint, options) {
    requests.push({ method, endpoint, options });
    return {
      status: 200,
      response: {
        choices: [{
          message: {
            content: "{\"translations\":[{\"id\":\"title\",\"zh\":\"可翻译标题\"}]}"
          }
        }]
      }
    };
  });

  const result = await context.DeepSeekTranslationClient.translate(
    "deepseek-secret",
    [segment],
    { cancelled: false }
  );

  assert.equal(result.get("title"), "可翻译标题");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].endpoint, /deepseek/);
  assert.doesNotMatch(requests[0].endpoint, /deepseek-secret/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer deepseek-secret");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "deepseek-v4-flash");
  assert.equal(payload.response_format.type, "json_object");
  assert.equal(JSON.parse(payload.messages[1].content).segments[0].id, "title");
});

test("Gemini builds the endpoint and extracts non-thought response parts", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("abstract", "A scientific abstract", { id: "abstract" });
  const requests = [];
  context.setHTTP(async function (method, endpoint, options) {
    requests.push({ method, endpoint, options });
    return {
      status: 200,
      response: {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: "internal reasoning" },
              { text: "科学" },
              { text: "摘要" }
            ]
          }
        }]
      }
    };
  });

  const result = await context.GeminiTranslationClient.translate(
    "gemini-secret",
    [segment],
    { cancelled: false },
    { retryDelays: [], targetLanguage: "zh-CN" }
  );

  assert.equal(result.get("abstract"), "科学摘要");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].endpoint, /generateContent/);
  assert.doesNotMatch(requests[0].endpoint, /gemini-secret/);
  assert.equal(requests[0].options.headers["x-goog-api-key"], "gemini-secret");
  const payload = JSON.parse(requests[0].options.body);
  assert.match(payload.contents[0].parts[0].text, /Source text:/);
  assert.match(payload.contents[0].parts[0].text, /A scientific abstract/);

  await assert.rejects(
    context.GeminiTranslationClient.request(
      "",
      [segment],
      { cancelled: false },
      { retryDelays: [] }
    ),
    function (error) {
      return error && error.code === "missing-key";
    }
  );
});

test("Bing splits long text and retries a transient network failure without credentials", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment(
    "abstract",
    "One sentence. Two sentence. Three sentence. Four sentence.",
    { id: "abstract" }
  );
  let calls = 0;
  const bodies = [];
  const successfulLabels = [];
  context.setHTTP(async function (method, endpoint, options) {
    calls++;
    bodies.push({
      method,
      endpoint,
      body: options.body
    });
    if (calls === 1) throw new Error("temporary Bing failure");
    successfulLabels.push("chunk-" + String(calls));
    return {
      status: 200,
      response: [{ translations: [{ text: "chunk-" + String(calls) }] }]
    };
  });

  const result = await context.BingTranslationClient.translate(
    "",
    [segment],
    { cancelled: false },
    { maxChars: 12, retryDelays: [0] }
  );

  assert.ok(calls >= 3);
  assert.equal(result.get("abstract"), successfulLabels.join(""));
  assert.ok(bodies.every(function (entry) {
    return entry.method === "POST" && entry.endpoint.includes("edge.microsoft.com");
  }));
  assert.ok(bodies.some(function (entry) {
    return JSON.parse(entry.body)[0].length <= 12;
  }));
});

test("Tencent Transmart sends its web payload and joins response text", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("title", "A title for Transmart", { id: "title" });
  const requests = [];
  context.setHTTP(async function (method, endpoint, options) {
    requests.push({ method, endpoint, options });
    return {
      status: 200,
      response: {
        auto_translation: ["腾讯译文"]
      }
    };
  });

  const result = await context.TransmartTranslationClient.translate(
    "",
    [segment],
    { cancelled: false },
    { maxChars: 100, retryDelays: [] }
  );

  assert.equal(result.get("title"), "腾讯译文");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].endpoint, /transmart/);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.header.fn, "auto_translation");
  assert.equal(payload.source.text_list[0], "A title for Transmart");
  assert.equal(payload.target.lang, "zh");
});

test("CNKI obtains one cached token, translates multiple chunks, and reports verification challenges", async function () {
  const context = loadTranslationContext();
  context.CNKITokenState.token = "";
  context.CNKITokenState.expiresAt = 0;
  context.CNKITokenState.promise = null;

  const first = makeSegment("title", "CNKI title", { id: "title-1" });
  const second = makeSegment("title", "CNKI second title", { id: "title-2" });
  let tokenCalls = 0;
  let translationCalls = 0;
  const tokens = [];
  context.setHTTP(async function (method, endpoint, options) {
    if (method === "GET") {
      tokenCalls++;
      return { status: 200, response: { data: "token-1" } };
    }
    translationCalls++;
    tokens.push(options.headers.Token);
    return {
      status: 200,
      response: {
        data: { mResult: "知网译文" }
      }
    };
  });

  const firstResult = await context.CNKITranslationClient.translate(
    "",
    [first],
    { cancelled: false },
    { maxChars: 800, retryDelays: [] }
  );
  const secondResult = await context.CNKITranslationClient.translate(
    "",
    [second],
    { cancelled: false },
    { maxChars: 800, retryDelays: [] }
  );

  assert.equal(firstResult.get("title-1"), "知网译文");
  assert.equal(secondResult.get("title-2"), "知网译文");
  assert.equal(tokenCalls, 1);
  assert.equal(translationCalls, 2);
  assert.deepEqual(tokens, ["token-1", "token-1"]);

  context.CNKITokenState.token = "";
  context.CNKITokenState.expiresAt = 0;
  context.CNKITokenState.promise = null;
  context.setHTTP(async function (method) {
    if (method === "GET") return { status: 200, response: { data: "token-2" } };
    return {
      status: 200,
      response: { data: { isInputVerificationCode: true } }
    };
  });

  await assert.rejects(
    context.CNKITranslationClient.translate(
      "",
      [first],
      { cancelled: false },
      { maxChars: 800, retryDelays: [] }
    ),
    function (error) {
      return error && error.code === "verification-required";
    }
  );
});

test("translation coordinator records a successful provider result", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("title", "Coordinator title", { id: "title" });
  let calls = 0;
  const result = await context.TranslationCoordinator.translateSegments({
    attachment: { id: 2 },
    segments: [segment],
    bypassCache: true,
    modelSpec: context.TranslationModelRegistry.gemini,
    credentials: {
      getKey: async function () {
        return "coordinator-key";
      }
    },
    translationClient: {
      translate: async function (key, segments) {
        calls++;
        assert.equal(key, "coordinator-key");
        assert.equal(segments[0].id, "title");
        return new Map([["title", "协调器译文"]]);
      }
    },
    requestOptions: {}
  });

  assert.equal(calls, 1);
  assert.equal(result.results.get("title").status, "translated");
  assert.equal(result.results.get("title").translatedText, "协调器译文");
  assert.equal(result.diagnostics.translated, 1);
});
