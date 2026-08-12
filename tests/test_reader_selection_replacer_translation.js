"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const context = {
  console, setTimeout, clearTimeout,
  Zotero: {
    Promise: { delay: () => Promise.resolve() },
    logError() {},
    HTTP: { async request() { throw new Error("unexpected network request"); } }
  },
  Services: {
    logins: { async searchLoginsAsync() { return []; } },
    prefs: { getBoolPref() { return false; }, setBoolPref() {} }
  },
  Components: { Constructor() {}, interfaces: {} },
  PathUtils: { join: (...parts) => parts.join("/") }
};
context.globalThis = context;
vm.createContext(context);
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
assert.strictEqual(context.ContentSegments.fromSelection({ paragraphs: [{
  sourceText: "Selected custom prose", selectedCharIDs: ["c3"],
  selectedPosition: position, matchType: "partial", confidence: "high"
}] })[0].kind, "custom");

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

(async () => {
  const originalGet = context.SegmentTranslationCache.get;
  const originalPut = context.SegmentTranslationCache.put;
  const originalKey = context.DeepSeekCredentials.getKey;
  const originalTranslate = context.DeepSeekTranslationClient.translate;
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

  context.SegmentTranslationCache.get = originalGet;
  context.SegmentTranslationCache.put = originalPut;
  context.DeepSeekCredentials.getKey = originalKey;
  context.DeepSeekTranslationClient.translate = originalTranslate;
  console.log("selection replacer translation tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
