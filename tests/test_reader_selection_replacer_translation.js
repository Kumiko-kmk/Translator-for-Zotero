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
    "zotero-reader-selection-replacer-test", name), "utf8"), context, { filename: name });
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
const selectionSegments = context.ContentSegments.fromSelection({ paragraphs: [{
  sourceText: "Full paragraph prose", selectedText: "Selected custom prose", selectedCharIDs: ["c3"],
  selectedPosition: position, matchType: "partial", confidence: "high"
}, {
  sourceText: "Unclassified low confidence prose", selectedText: "Unclassified low confidence prose",
  selectedCharIDs: ["c4"], selectedPosition: position, matchType: "unclassified", confidence: "low"
}] });
assert.strictEqual(selectionSegments[0].kind, "custom");
assert.strictEqual(selectionSegments[0].sourceText, "Selected custom prose");
assert.strictEqual(selectionSegments[1].kind, "unclassified");
assert.strictEqual(selectionSegments[1].sourceLanguage, "en");

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
assert.strictEqual(context.DeepSeekTranslationClient.validate([selectionSegments[0]], {
  translations: [{ id: "p-0", zh: "选中的自定义段落" }]
}).get("p-0"), "选中的自定义段落");
assert.throws(() => context.DeepSeekTranslationClient.validate([selectionSegments[0]], {
  translations: [{ id: "p-0", zh: "自定义段落<br>不允许换行" }]
}), /自定义段落译文/u);
assert.match(context.DeepSeekTranslationClient.prompt(false, selectionSegments), /自定义段落译文/u);

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

  context.SegmentTranslationCache.get = async (_attachment, segment) => null;
  context.DeepSeekTranslationClient.translate = async (_key, batch) => {
    calls++;
    return new Map(batch.map(segment => [segment.id, `译文-${segment.id}`]));
  };
  const selectionResult = await context.TranslationCoordinator.translateSegments({
    attachment: { libraryID: 1, key: "ATT" },
    segments: selectionSegments
  });
  assert.strictEqual(selectionResult.results.get("p-0").status, "translated");
  assert.strictEqual(selectionResult.results.get("u-1").status, "translated");
  assert.strictEqual(selectionResult.diagnostics.translated, 2);
  assert.strictEqual(calls, 3);
  assert.strictEqual(context.SegmentTranslationCache.promptVersion(selectionSegments[0]),
    "selection-translation-v1");

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
  assert.deepStrictEqual(JSON.parse(qwenRequest.options.body), {
    model: "qwen-mt-plus",
    messages: [{ role: "user", content: "A Qwen title" }],
    translation_options: { source_lang: "English", target_lang: "Chinese" }
  });

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
