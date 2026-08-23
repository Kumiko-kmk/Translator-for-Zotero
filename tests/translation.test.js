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
      getBoolPref() { return false; },
      setBoolPref() {},
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
  vm.runInContext(fs.readFileSync(path.join(root,
    "plugin", name), "utf8"), context, { filename: name });
}

const position = { pageIndex: 0, rects: [[1, 2, 100, 20]],
  fragments: [{ pageIndex: 0, rects: [[1, 2, 100, 20]] }] };
const segments = context.ContentSegments.fromTargets([
  { kind: "title", text: "A Reliable Scientific Title", position,
    pageIndexes: [0], confidence: "high", sourceCharIDs: ["c1"] },
  { kind: "abstract", text: "这是中文摘要。", position,
    pageIndexes: [0], confidence: "high", sourceCharIDs: ["c2"] }
]);
assert.strictEqual(segments[0].sourceLanguage, "en");
assert.strictEqual(segments[1].sourceLanguage, "zh-CN");
const selectionSegments = context.ContentSegments.fromSelectionBlock({
  mode: "selection-block",
  sourceText: "Selected custom prose.\n\nSecond source unit.",
  position,
  blocks: [{ pageIndex: 0, column: "single", rects: position.rects }],
  units: [
    { id: "unit-0", sourceText: "Selected custom prose.", breakAfter: "paragraph" },
    { id: "unit-1", sourceText: "Second source unit.", breakAfter: "none" }
  ],
  distribution: { pageWeights: [{ pageIndex: 0, weight: 1 }],
    blockWeights: [{ id: "page-0-single-0", pageIndex: 0, weight: 1 }] }
});
assert.strictEqual(selectionSegments[0].kind, "custom");
assert.strictEqual(selectionSegments[0].sourceText,
  "Selected custom prose.\n\nSecond source unit.");
assert.strictEqual(selectionSegments[0].id, "selection-block");
assert.strictEqual(selectionSegments[0].metadata.selectionMode, "selection-block");
assert.strictEqual(selectionSegments[0].metadata.selectionUnits.length, 2);
const parsed = context.DeepSeekTranslationClient.parse(
  '```json\n{"translations":[{"id":"title","zh":"可靠的科学标题"}]}\n```');
const validated = context.DeepSeekTranslationClient.validate([segments[0]], parsed);
assert.strictEqual(validated.get("title"), "可靠的科学标题");
assert.strictEqual(context.DeepSeekTranslationClient.validate([segments[0]], {
  translations: [{ id: "title", zh: "短标题<br>不应换行" }]
}).get("title"), "短标题<br>不应换行");
assert.strictEqual(context.DeepSeekTranslationClient.validate([segments[0]], {
  translations: [{ id: "title", zh: "明显偏短<br>但仍是结构有效且应保留的标题译文断句" }]
}).get("title"), "明显偏短<br>但仍是结构有效且应保留的标题译文断句");
assert.strictEqual(context.DeepSeekTranslationClient.validate([segments[0]], {
  translations: [{ id: "title", zh: "钢渣部分替代粗骨料对纤维增强混凝土曲梁<br>在静载和冲击荷载下性能的影响" }]
}).get("title"), "钢渣部分替代粗骨料对纤维增强混凝土曲梁<br>在静载和冲击荷载下性能的影响");
assert.throws(() => context.DeepSeekTranslationClient.validate([segments[0]], {
  translations: [{ id: "title", zh: "这是一个很长的标题<br>包含重复<br>换行标记所以无效" }]
}), /多个换行标记/u);
assert.throws(() => context.DeepSeekTranslationClient.validate([segments[0]], {
  translations: [{ id: "title", zh: "这是一个很长的标题并且包含<b>非法标签</b>所以无效" }]
}), /HTML/u);
assert.throws(() => context.DeepSeekTranslationClient.validate([
  { ...segments[0], id: "abstract", kind: "abstract" }
], { translations: [{ id: "abstract", zh: "摘要正文<br>不得换行" }] }), /摘要译文/u);
assert.throws(() => context.DeepSeekTranslationClient.validate([segments[0]],
  { translations: [{ id: "unexpected", zh: "错误" }] }));
const structuredSelection = context.DeepSeekTranslationClient.validate([selectionSegments[0]], {
  translations: [{ id: "selection-block", units: [
    { id: "unit-0", zh: "选中的自定义段落" },
    { id: "unit-1", zh: "第二个翻译单元" }
  ] }]
}).get("selection-block");
assert.strictEqual(structuredSelection.translatedText,
  "选中的自定义段落\n\n第二个翻译单元");
assert.deepStrictEqual(Array.from(structuredSelection.translatedUnits, unit => unit.id),
  ["unit-0", "unit-1"]);
assert.throws(() => context.DeepSeekTranslationClient.validate([selectionSegments[0]], {
  translations: [{ id: "selection-block", units: [
    { id: "unit-0", zh: "自定义段落<br>不允许换行" },
    { id: "unit-1", zh: "第二单元" }
  ] }]
}), /自定义段落译文/u);
assert.throws(() => context.DeepSeekTranslationClient.validate([selectionSegments[0]], {
  translations: [{ id: "selection-block", units: [
    { id: "unit-1", zh: "顺序错误" }, { id: "unit-0", zh: "顺序错误" }
  ] }]
}), /无效译文单元/u);
assert.match(context.DeepSeekTranslationClient.prompt(false, selectionSegments), /unit id/u);
const cacheEnvelope = context.encodeCachedTranslation(selectionSegments[0], structuredSelection);
const decodedEnvelope = context.decodeCachedTranslation(selectionSegments[0], cacheEnvelope);
assert.strictEqual(decodedEnvelope.translatedText,
  "选中的自定义段落\n\n第二个翻译单元");
assert.strictEqual(decodedEnvelope.translatedUnits.length, 2);
const qwenModel = context.TranslationModelRegistry.qwenMTPlus;
assert.strictEqual(JSON.stringify(qwenModel), JSON.stringify({
  provider: "qwen-mt",
  model: "qwen-mt-plus",
  label: "Qwen-MT Plus"
}));
assert.strictEqual(context.QwenMTPlusTranslationClient.provider, "qwen-mt");
assert.strictEqual(context.QwenMTPlusTranslationClient.model, "qwen-mt-plus");
assert.strictEqual(
  context.TranslationProviderRegistry["qwen-mt"].requestOptions().baseURL,
  "https://dashscope.aliyuncs.com/compatible-mode/v1"
);
assert.strictEqual(JSON.stringify(context.QwenMTPlusTranslationClient.buildPayload({
  sourceText: "A reliable scientific title",
  sourceLanguage: "en"
})), JSON.stringify({
  model: "qwen-mt-plus",
  messages: [{ role: "user", content: "A reliable scientific title" }],
  translation_options: { source_lang: "English", target_lang: "Chinese" }
}));
assert.strictEqual(context.QwenMTPlusTranslationClient.extractText({
  choices: [{ message: { content: "可靠的科学标题" } }]
}), "可靠的科学标题");
assert.strictEqual(context.QwenMTPlusTranslationClient.extractText({
  output: { choices: [{ message: { content: "可靠的科学标题" } }] }
}), "可靠的科学标题");
const deepSeekCacheKey = context.SegmentTranslationCache.key(
  { libraryID: 1, key: "ATT" }, segments[0], "zh-CN");
const qwenCacheKey = context.SegmentTranslationCache.key(
  { libraryID: 1, key: "ATT" }, segments[0], "zh-CN", qwenModel);
assert.strictEqual(deepSeekCacheKey.provider, "deepseek");
assert.strictEqual(qwenCacheKey.provider, "qwen-mt");
assert.strictEqual(qwenCacheKey.model, "qwen-mt-plus");
assert.notStrictEqual(deepSeekCacheKey.model, qwenCacheKey.model);
const structuredCacheKey = context.SegmentTranslationCache.key(
  { libraryID: 1, key: "ATT" }, selectionSegments[0], "zh-CN");
const changedStructureCacheKey = context.SegmentTranslationCache.key(
  { libraryID: 1, key: "ATT" }, { ...selectionSegments[0], metadata: {
    ...selectionSegments[0].metadata,
    selectionUnits: [{ id: "unit-0", sourceText: selectionSegments[0].sourceText,
      breakAfter: "none" }]
  } }, "zh-CN");
assert.notStrictEqual(structuredCacheKey.sourceHash, changedStructureCacheKey.sourceHash,
  "selection cache identity must change when hard-break units change");
(async () => {
  const originalGet = context.SegmentTranslationCache.get;
  const originalPut = context.SegmentTranslationCache.put;
  const originalKey = context.DeepSeekCredentials.getKey;
  const originalTranslate = context.DeepSeekTranslationClient.translate;
  const originalLoginSearch = context.Services.logins.searchLoginsAsync;
  const originalLoginAdd = context.Services.logins.addLoginAsync;
  const originalLoginRemove = context.Services.logins.removeLogin;
  const loginStore = [];
  context.Services.logins.searchLoginsAsync = async query => loginStore.filter(login =>
    login.origin === query.origin && login.httpRealm === query.httpRealm);
  context.Services.logins.addLoginAsync = async login => {
    loginStore.push(login);
  };
  context.Services.logins.removeLogin = login => {
    const index = loginStore.indexOf(login);
    if (index >= 0) loginStore.splice(index, 1);
  };
  await context.DeepSeekCredentials.saveKey("deepseek-secret");
  await context.QwenCredentials.saveKey("qwen-secret");
  assert.strictEqual(loginStore.length, 2);
  assert.notStrictEqual(
    context.DeepSeekCredentials.realm,
    context.QwenCredentials.realm
  );
  assert.deepStrictEqual(
    loginStore.map(login => [login.httpRealm, login.password]),
    [
      ["Paper Assistant DeepSeek API", "deepseek-secret"],
      ["Paper Assistant Qwen API", "qwen-secret"]
    ]
  );
  let validationRequest = null;
  context.Zotero.HTTP.request = async (method, endpoint, options) => {
    validationRequest = { method, endpoint, options };
    return { status: 200,
      response: { choices: [{ message: { content: "validation translation" } }] } };
  };
  assert.strictEqual(await context.QwenCredentials.validateKey("qwen-secret", {}), true);
  assert.strictEqual(validationRequest.method, "POST");
  assert.strictEqual(validationRequest.endpoint,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.strictEqual(validationRequest.options.timeout, 5000);

  let deepSeekValidationRequest = null;
  context.Zotero.HTTP.request = async (method, endpoint, options) => {
    deepSeekValidationRequest = { method, endpoint, options };
    return { status: 200, response: { data: [{ id: "deepseek-v4-flash" }] } };
  };
  assert.strictEqual(await context.DeepSeekCredentials.validateKey("deepseek-secret"), true);
  assert.strictEqual(deepSeekValidationRequest.options.timeout, 5000);
  context.Services.logins.searchLoginsAsync = originalLoginSearch;
  context.Services.logins.addLoginAsync = originalLoginAdd;
  context.Services.logins.removeLogin = originalLoginRemove;
  context.SegmentTranslationCache.get = async (_attachment, segment) =>
    segment.id === "title" ? { translatedText: "缓存标题" } : null;
  context.SegmentTranslationCache.put = async () => {};
  context.DeepSeekCredentials.getKey = async () => "secret";
  let calls = 0;
  context.DeepSeekTranslationClient.translate = async (_key, batch) => {
    calls++;
    return new Map([[batch[0].id, "新摘要译文"]]);
  };
  const result = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [segments[0], { ...segments[0], id: "abstract", kind: "abstract" }]
  });
  assert.strictEqual(result.results.get("title").status, "cached");
  assert.strictEqual(result.results.get("abstract").status, "translated");
  assert.strictEqual(calls, 1);

  context.SegmentTranslationCache.get = async () => null;
  let cachedSelectionEnvelope = "";
  context.SegmentTranslationCache.put = async (_attachment, segment, _target, value) => {
    if (segment.id === "selection-block") cachedSelectionEnvelope = value;
  };
  context.DeepSeekTranslationClient.translate = async (_key, batch) => {
    calls++;
    return new Map(batch.map(segment => [segment.id, segment.id === "selection-block"
      ? structuredSelection : `译文-${segment.id}`]));
  };
  const selectionResult = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: selectionSegments
  });
  assert.strictEqual(selectionResult.results.get("selection-block").status, "translated");
  assert.strictEqual(selectionResult.results.get("selection-block").translatedUnits.length, 2);
  assert.strictEqual(selectionResult.diagnostics.translated, 1);
  assert.strictEqual(calls, 2);
  assert.strictEqual(JSON.parse(cachedSelectionEnvelope).version, 1);
  assert.strictEqual(context.SegmentTranslationCache.promptVersion(selectionSegments[0]),
    "selection-translation-v4-layout-structure");

  let qwenRequest = null;
  context.Zotero.HTTP.request = async (method, endpoint, options) => {
    qwenRequest = { method, endpoint, options };
    return { status: 200, response: { choices: [{ message: { content: "Qwen 标题译文" } }] } };
  };
  const qwenTranslated = await context.QwenMTPlusTranslationClient.translate(
    "qwen-secret",
    [{ ...segments[0], id: "qwen-title", sourceText: "A Qwen title" }],
    {},
    { baseURL: "https://ignored.example/compatible-mode/v1", targetLanguage: "zh-CN" }
  );
  assert.strictEqual(qwenTranslated.get("qwen-title"), "Qwen 标题译文");
  assert.strictEqual(qwenRequest.method, "POST");
  assert.strictEqual(qwenRequest.endpoint,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.strictEqual(qwenRequest.options.timeout, 10000);
  assert.deepStrictEqual(JSON.parse(qwenRequest.options.body), {
    model: "qwen-mt-plus",
    messages: [{ role: "user", content: "A Qwen title" }],
    translation_options: { source_lang: "English", target_lang: "Chinese" }
  });

  const qwenUnitRequests = [];
  context.Zotero.HTTP.request = async (_method, _endpoint, options) => {
    const body = JSON.parse(options.body);
    qwenUnitRequests.push(body.messages[0].content);
    return { status: 200, response: { choices: [{ message: {
      content: body.messages[0].content.startsWith("Selected")
        ? "千问第一单元" : "千问第二单元"
    } }] } };
  };
  const qwenSelection = await context.QwenMTPlusTranslationClient.translate(
    "qwen-secret", selectionSegments, {}, { targetLanguage: "zh-CN" });
  assert.deepStrictEqual(qwenUnitRequests,
    ["Selected custom prose.", "Second source unit."]);
  assert.strictEqual(qwenSelection.get("selection-block").translatedText,
    "千问第一单元\n\n千问第二单元");
  assert.strictEqual(qwenSelection.get("selection-block").translatedUnits.length, 2);

  let qwenFailureCalls = 0;
  context.Zotero.HTTP.request = async () => {
    qwenFailureCalls++;
    throw new Error("timeout");
  };
  await assert.rejects(
    context.QwenMTPlusTranslationClient.request(
      "qwen-secret",
      [{ ...segments[0], id: "qwen-timeout" }],
      { cancelled: false },
      {}
    ),
    /timeout/u
  );
  assert.strictEqual(qwenFailureCalls, 1);

  for (const status of [401, 403]) {
    context.Zotero.HTTP.request = async () => ({ status, response: {} });
    await assert.rejects(
      context.QwenMTPlusTranslationClient.request(
        "qwen-secret",
        [{ ...segments[0], id: `qwen-auth-${status}` }],
        { cancelled: false },
        {}
      ),
      error => error.status === status && /API Key 无效/u.test(error.message)
    );
    await assert.rejects(
      context.DeepSeekTranslationClient.request(
        "deepseek-secret",
        [{ ...segments[0], id: `deepseek-auth-${status}` }],
        { cancelled: false },
        false
      ),
      error => error.status === status && /API Key 无效/u.test(error.message)
    );
  }

  context.Zotero.HTTP.request = async (method, endpoint, options) => {
    qwenRequest = { method, endpoint, options };
    return { status: 200, response: { choices: [{ message: { content: "Qwen 标题译文" } }] } };
  };

  const qwenResult = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [{ ...segments[0], id: "qwen-title", sourceText: "A Qwen title" }],
    modelSpec: qwenModel,
    credentials: { async getKey() { return "qwen-secret"; } },
    translationClient: context.QwenMTPlusTranslationClient,
    requestOptions: {
      baseURL: "https://qwen.example/compatible-mode/v1",
      targetLanguage: "zh-CN"
    }
  });
  assert.strictEqual(qwenResult.results.get("qwen-title").status, "translated");
  assert.strictEqual(qwenResult.results.get("qwen-title").provider, "qwen-mt");
  assert.strictEqual(qwenResult.results.get("qwen-title").model, "qwen-mt-plus");

  const qwenSelectionOrder = [];
  const qwenSelectionResult = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [
      { ...selectionSegments[0], id: "qwen-selection-first" },
      { ...selectionSegments[0], id: "qwen-selection-second" }
    ],
    bypassCache: true,
    modelSpec: qwenModel,
    credentials: { async getKey() { return "qwen-secret"; } },
    translationClient: {
      async translate(_key, batch) {
        assert.strictEqual(batch.length, 1);
        qwenSelectionOrder.push(batch[0].id);
        return new Map([[batch[0].id, `Qwen 选区译文-${batch[0].id}`]]);
      }
    },
    requestOptions: { targetLanguage: "zh-CN" }
  });
  assert.strictEqual(JSON.stringify(qwenSelectionOrder),
    JSON.stringify(["qwen-selection-first", "qwen-selection-second"]));
  assert.strictEqual(qwenSelectionResult.results.get("qwen-selection-first").status, "translated");
  assert.strictEqual(qwenSelectionResult.results.get("qwen-selection-second").status, "translated");

  const originalQwenKey = context.QwenCredentials.getKey;
  const originalQwenTranslate = context.QwenMTPlusTranslationClient.translate;
  activeProvider = "qwen-mt";
  context.QwenCredentials.getKey = async () => "qwen-active-secret";
  context.QwenMTPlusTranslationClient.translate = async (_key, batch) =>
    new Map([[batch[0].id, "active qwen translation"]]);
  const activeQwenResult = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: [{
      ...segments[0],
      id: "active-qwen-title",
      sourceText: "Active Qwen title"
    }]
  });
  assert.strictEqual(
    activeQwenResult.results.get("active-qwen-title").status,
    "translated"
  );
  assert.strictEqual(
    activeQwenResult.results.get("active-qwen-title").provider,
    "qwen-mt"
  );
  assert.strictEqual(
    activeQwenResult.results.get("active-qwen-title").model,
    "qwen-mt-plus"
  );
  context.QwenCredentials.getKey = originalQwenKey;
  context.QwenMTPlusTranslationClient.translate = originalQwenTranslate;
  activeProvider = "deepseek";

  context.SegmentTranslationCache.get = originalGet;
  context.SegmentTranslationCache.put = originalPut;
  context.DeepSeekCredentials.getKey = originalKey;
  context.DeepSeekTranslationClient.translate = originalTranslate;
  context.Zotero.HTTP.request = async () => { throw new Error("unexpected network request"); };
  console.log("selection replacer translation tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
