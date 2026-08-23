"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
let activeProvider = "deepseek";
const context = {
  console, setTimeout, clearTimeout,
  Zotero: {
    Promise: { delay: () => Promise.resolve() },
    logError() {},
    HTTP: { async request() { throw new Error("unexpected network request"); } }
  },
  Services: {
    logins: { async searchLoginsAsync() { return []; } },
    prefs: {
      getCharPref(name, fallback) {
        if (name === "extensions.reader-selection-replacer.activeTranslationProvider") {
          return activeProvider;
        }
        return fallback;
      },
      setCharPref(name, value) {
        if (name === "extensions.reader-selection-replacer.activeTranslationProvider") {
          activeProvider = value;
        }
      }
    }
  },
  Components: { Constructor() {}, interfaces: {} },
  PathUtils: { join: (...parts) => parts.join("/") }
};
context.globalThis = context;
vm.createContext(context);
context.Components.Constructor = function() {
  return function LoginInfo(origin, formActionOrigin, httpRealm,
    username, password) {
    this.origin = origin;
    this.formActionOrigin = formActionOrigin;
    this.httpRealm = httpRealm;
    this.username = username;
    this.password = password;
  };
};
context.Components.interfaces.nsILoginInfo = {};
for (const name of ["content-segments.js", "translation-service.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "plugin", name), "utf8"),
    context, { filename: name });
}

const providerIDs = ["gemini", "bing", "transmart", "cnki"];
for (const providerID of providerIDs) {
  const provider = context.TranslationProviderRegistry[providerID];
  assert.ok(provider, `${providerID} provider should be registered`);
  if (providerID === "gemini") {
    assert.strictEqual(provider.credentialMode, "api-key");
    assert.strictEqual(provider.credentials, context.GeminiCredentials);
  }
  else {
    assert.strictEqual(provider.credentialMode, "none");
    assert.strictEqual(provider.credentials, context.NoCredentials);
  }
  assert.notStrictEqual(provider.modelSpec.model, "");
}
assert.strictEqual(context.setActiveTranslationProviderID("cnki"), "cnki");
assert.strictEqual(context.getActiveTranslationProviderID(), "cnki");
assert.strictEqual(context.setActiveTranslationProviderID(""), "");
assert.strictEqual(context.getActiveTranslationProviderID(), "");
assert.strictEqual(context.setActiveTranslationProviderID("not-real"), "");
assert.strictEqual(context.getActiveTranslationProviderID(), "");
activeProvider = "deepseek";

const nistKey = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f];
const nistPlaintext = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
assert.deepStrictEqual(
  context.aes128EncryptBlock(nistPlaintext, context.aes128ExpandKey(nistKey)),
  [0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30,
    0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a]
);
assert.ok(context.cnkiEncodeText("公开测试") .length > 0);

const segment = {
  id: "provider-title",
  kind: "title",
  sourceText: "Hello scientific world.",
  sourceLanguage: "en",
  confidence: "high",
  position: { pageIndex: 0, rects: [[0, 0, 100, 20]] }
};
const selectionSegment = {
  ...segment,
  id: "selection-block",
  kind: "custom",
  sourceText: "First selected paragraph.\n\nSecond selected paragraph.",
  metadata: {
    selectionUnits: [
      { id: "unit-0", sourceText: "First selected paragraph.",
        breakAfter: "paragraph" },
      { id: "unit-1", sourceText: "Second selected paragraph.",
        breakAfter: "none" }
    ]
  }
};
assert.notStrictEqual(context.GeminiCredentials.realm, context.DeepSeekCredentials.realm);

(async () => {
  const requests = [];
  activeProvider = "";
  const noProvider = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [segment]
  });
  assert.strictEqual(noProvider.results.get(segment.id).status, "skipped");
  assert.strictEqual(noProvider.results.get(segment.id).errorCode, "no-provider");
  assert.strictEqual(requests.length, 0);
  activeProvider = "deepseek";
  context.Zotero.HTTP.request = async (method, endpoint, options) => {
    requests.push({ method, endpoint, options });
    if (endpoint.startsWith("https://generativelanguage.googleapis.com")) {
      return { status: 200, response: {
        candidates: [{ content: { parts: [{ text: "Gemini译文" }] } }]
      } };
    }
    if (endpoint.startsWith("https://edge.microsoft.com")) {
      return { status: 200, response: [{ translations: [{ text: "Bing译文" }] }] };
    }
    if (endpoint === "https://transmart.qq.com/api/imt") {
      return { status: 200, response: { auto_translation: ["Transmart译文"] } };
    }
    if (endpoint === "https://dict.cnki.net/fyzs-front-api/getToken") {
      return { status: 200, response: { code: 200, data: "cnki-token" } };
    }
    if (endpoint === "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation") {
      return { status: 200, response: { data: { mResult: "CNKI译文" } } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const geminiResult = await context.GeminiTranslationClient.translate(
    "gemini-secret", [segment], { cancelled: false }, { retryDelays: [] });
  assert.strictEqual(geminiResult.get(segment.id), "Gemini译文");
  const geminiRequest = requests.at(-1);
  assert.strictEqual(geminiRequest.method, "POST");
  assert.match(geminiRequest.endpoint,
    /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/u);
  assert.ok(!geminiRequest.endpoint.includes("gemini-secret"));
  assert.strictEqual(geminiRequest.options.headers["x-goog-api-key"], "gemini-secret");
  const geminiPayload = JSON.parse(geminiRequest.options.body);
  assert.match(geminiPayload.contents[0].parts[0].text, /Hello scientific world/u);
  assert.match(geminiPayload.contents[0].parts[0].text, /Simplified Chinese/u);
  await assert.rejects(
    context.GeminiTranslationClient.translate("", [segment], { cancelled: false },
      { retryDelays: [] }),
    error => error.code === "missing-key"
  );

  const bingResult = await context.BingTranslationClient.translate(
    "", [segment], { cancelled: false }, { retryDelays: [] });
  assert.strictEqual(bingResult.get(segment.id), "Bing译文");
  const bingRequest = requests.at(-1);
  assert.strictEqual(bingRequest.method, "POST");
  assert.match(bingRequest.endpoint, /from=en/u);
  assert.match(bingRequest.endpoint, /to=zh-CN/u);
  assert.deepStrictEqual(JSON.parse(bingRequest.options.body), [segment.sourceText]);

  const transmartResult = await context.TransmartTranslationClient.translate(
    "", [segment], { cancelled: false }, { retryDelays: [] });
  assert.strictEqual(transmartResult.get(segment.id), "Transmart译文");
  const transmartRequest = requests.at(-1);
  assert.strictEqual(transmartRequest.method, "POST");
  const transmartPayload = JSON.parse(transmartRequest.options.body);
  assert.strictEqual(transmartPayload.header.fn, "auto_translation");
  assert.deepStrictEqual(transmartPayload.source.text_list, [segment.sourceText]);
  assert.strictEqual(transmartPayload.target.lang, "zh");

  context.CNKITokenState.token = "";
  context.CNKITokenState.expiresAt = 0;
  const cnkiResult = await context.CNKITranslationClient.translate(
    "", [segment], { cancelled: false }, { retryDelays: [] });
  assert.strictEqual(cnkiResult.get(segment.id), "CNKI译文");
  const cnkiRequest = requests.at(-1);
  assert.strictEqual(cnkiRequest.method, "POST");
  const cnkiPayload = JSON.parse(cnkiRequest.options.body);
  assert.ok(cnkiPayload.words);
  assert.strictEqual(cnkiPayload.translateType, null);
  assert.strictEqual(cnkiRequest.options.headers.Token, "cnki-token");

  const structuredProviders = [
    ["Gemini", context.GeminiTranslationClient, "gemini-secret", "Gemini译文"],
    ["Bing", context.BingTranslationClient, "", "Bing译文"],
    ["Transmart", context.TransmartTranslationClient, "", "Transmart译文"],
    ["CNKI", context.CNKITranslationClient, "", "CNKI译文"]
  ];
  for (const [label, client, apiKey, unitText] of structuredProviders) {
    const translated = await client.translate(apiKey, [selectionSegment],
      { cancelled: false }, { retryDelays: [] });
    const value = translated.get(selectionSegment.id);
    assert.strictEqual(value.translatedText, `${unitText}\n\n${unitText}`,
      `${label} should preserve the hard paragraph break`);
    assert.strictEqual(JSON.stringify(Array.from(value.translatedUnits, unit => unit.id)),
      JSON.stringify(["unit-0", "unit-1"]),
      `${label} should preserve selection unit order and IDs`);
  }

  const providerHTTP = context.Zotero.HTTP.request;
  let failedUnitCalls = 0;
  context.Zotero.HTTP.request = async (...args) => {
    failedUnitCalls++;
    if (failedUnitCalls === 2) throw new Error("second unit failed");
    return providerHTTP(...args);
  };
  await assert.rejects(
    context.GeminiTranslationClient.translate("gemini-secret", [selectionSegment],
      { cancelled: false }, { retryDelays: [] }),
    /second unit failed/u,
    "a failed unit must fail the whole selection instead of returning partial text"
  );
  context.Zotero.HTTP.request = providerHTTP;

  const originalGet = context.SegmentTranslationCache.get;
  const originalPut = context.SegmentTranslationCache.put;
  context.SegmentTranslationCache.get = async () => null;
  context.SegmentTranslationCache.put = async () => {};
  context.Zotero.HTTP.request = async (method, endpoint) => {
    if (method === "POST" && endpoint.startsWith("https://generativelanguage.googleapis.com")) {
      return { status: 200, response: {
        candidates: [{ content: { parts: [{ text: "协调器译文" }] } }]
      } };
    }
    throw new Error(`unexpected coordinator request: ${method} ${endpoint}`);
  };
  const coordinated = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [segment],
    modelSpec: context.TranslationModelRegistry.gemini,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    credentials: { async getKey() { return "gemini-secret"; } }
  });
  assert.strictEqual(coordinated.results.get(segment.id).status, "translated");
  assert.strictEqual(coordinated.results.get(segment.id).translatedText, "协调器译文");
  assert.strictEqual(coordinated.results.get(segment.id).provider, "gemini");
  context.SegmentTranslationCache.get = originalGet;
  context.SegmentTranslationCache.put = originalPut;

  const originalGeminiTranslate = context.GeminiTranslationClient.translate;
  const originalBingTranslate = context.BingTranslationClient.translate;
  let fallbackCalls = 0;
  context.SegmentTranslationCache.get = async () => null;
  context.SegmentTranslationCache.put = async () => {};
  context.GeminiTranslationClient.translate = async () => {
    throw Object.assign(new Error("Gemini HTTP 503"), {
      status: 503, code: "provider-rate-limited"
    });
  };
  context.BingTranslationClient.translate = async () => {
    fallbackCalls++;
    return new Map([[segment.id, "不应自动降级"]]);
  };
  const failed = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [segment],
    modelSpec: context.TranslationModelRegistry.gemini,
    credentials: { async getKey() { return "gemini-secret"; } }
  });
  assert.strictEqual(failed.results.get(segment.id).status, "failed");
  assert.strictEqual(fallbackCalls, 0);
  context.GeminiTranslationClient.translate = originalGeminiTranslate;
  context.BingTranslationClient.translate = originalBingTranslate;
  context.SegmentTranslationCache.get = originalGet;
  context.SegmentTranslationCache.put = originalPut;

  console.log("translation provider contract tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
