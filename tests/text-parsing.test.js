"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadTextContext,
  loadTranslationContext,
  loadSelectionTranslationContext,
  makePosition,
  makeSegment
} = require("./helpers");

test("language detection distinguishes English, Chinese, and low-signal text", function () {
  const context = loadTranslationContext();

  assert.equal(
    context.ContentSegments.detectLanguage("Reliable scientific title"),
    "en"
  );
  assert.equal(
    context.ContentSegments.detectLanguage("这是一个中文摘要内容"),
    "zh-CN"
  );
  assert.equal(context.ContentSegments.detectLanguage("123 + ="), "unknown");
  assert.equal(
    context.ContentSegments.detectLanguage("English 中文"),
    "unknown"
  );
});

test("content segment normalization filters unusable targets and preserves metadata", function () {
  const context = loadTranslationContext();
  const position = makePosition(0, [[40, 700, 260, 720]]);
  const segments = context.ContentSegments.fromTargets([
    {
      kind: "title",
      text: "A Synthetic Title",
      sourceCharIDs: ["0:char:1"],
      sourceLineIDs: ["0:line:1"],
      position,
      pageIndexes: [0],
      confidence: "high",
      matchMethod: "metadata-segmented",
      metadataCoverage: 0.98,
      completeness: "verified"
    },
    {
      kind: "abstract",
      text: "   ",
      sourceCharIDs: [],
      sourceLineIDs: [],
      position: null
    }
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, "title");
  assert.equal(segments[0].sourceText, "A Synthetic Title");
  assert.equal(segments[0].sourceLanguage, "en");
  assert.equal(segments[0].metadata.matchMethod, "metadata-segmented");
  assert.equal(segments[0].metadata.metadataCoverage, 0.98);
  assert.equal(segments[0].metadata.completeness, "verified");
});

test("selection block grouping handles single, two-column, and full-width layouts", function () {
  const context = loadTextContext();

  const single = context.ReaderSelectionBlock.groupRects([
    [10, 10, 40, 20]
  ]);
  assert.equal(single.length, 1);
  assert.equal(single[0].column, "single");

  const columns = context.ReaderSelectionBlock.groupRects([
    [10, 10, 50, 20],
    [10, 30, 50, 40],
    [120, 10, 160, 20],
    [120, 30, 160, 40]
  ]);
  assert.equal(columns.length, 2);
  assert.equal(
    columns.map(function (group) { return group.column; }).join(","),
    "left,right"
  );

  const fullWidth = context.ReaderSelectionBlock.groupRects([
    [10, 10, 180, 20],
    [10, 30, 180, 40],
    [10, 50, 180, 60]
  ]);
  assert.equal(fullWidth.length, 1);
  assert.equal(fullWidth[0].column, "single");
});

test("selection block parsing preserves explicit paragraph breaks and distribution", function () {
  const context = loadTextContext();
  const position = {
    fragments: [
      {
        pageIndex: 0,
        rects: [
          [20, 100, 180, 112],
          [20, 130, 180, 142]
        ]
      },
      {
        pageIndex: 1,
        rects: [[20, 100, 180, 112]]
      }
    ]
  };
  const match = context.ReaderSelectionBlock.create({
    view: null,
    position,
    sourceText: "First paragraph.\n\nSecond paragraph."
  });

  assert.equal(match.mode, "selection-block");
  assert.equal(match.blocks.length, 2);
  assert.equal(match.diagnostics.pageCount, 2);
  assert.equal(match.diagnostics.rawRectCount, 3);
  assert.equal(match.diagnostics.explicitBreakCount, 1);
  assert.equal(match.units.length, 2);
  assert.equal(match.units[0].sourceText, "First paragraph.");
  assert.equal(match.units[0].breakAfter, "paragraph");
  assert.equal(match.units[1].sourceText, "Second paragraph.");
  assert.equal(match.units[1].breakAfter, "none");
  assert.equal(match.distribution.pageWeights.length, 2);

  const selectionSegments = context.ContentSegments.fromSelectionBlock(match);
  assert.equal(selectionSegments.length, 1);
  assert.equal(selectionSegments[0].kind, "custom");
  assert.equal(selectionSegments[0].metadata.selectionMode, "selection-block");
  assert.equal(selectionSegments[0].metadata.selectionUnits.length, 2);
  assert.equal(selectionSegments[0].sourceLanguage, "en");
});

test("selection geometry detects a visual paragraph boundary", function () {
  const context = loadTextContext();
  const originalProjectRect = context.ReaderPageTextIndex.projectRect;
  context.ReaderPageTextIndex.projectRect = function (input) {
    return {
      valid: true,
      pageIndex: input.pageIndex,
      pixelRect: input.pdfRect.slice()
    };
  };

  try {
    const result = context.ReaderSelectionBlock.create({
      view: {},
      position: makePosition(0, [
        [20, 10, 180, 20],
        [20, 25, 180, 35],
        [20, 80, 180, 90]
      ]),
      sourceText: "First visual line\nSecond visual line\nThird visual paragraph."
    });

    assert.equal(result.diagnostics.geometryAvailable, true);
    assert.ok(result.diagnostics.geometryBreakCount >= 1);
    assert.ok(result.units.length >= 2);
    assert.ok(result.units.some(function (unit) {
      return unit.sourceText.includes("Third visual paragraph.");
    }));
  }
  finally {
    context.ReaderPageTextIndex.projectRect = originalProjectRect;
  }
});

test("DeepSeek response parsing and validation enforce segment and unit contracts", function () {
  const context = loadTranslationContext();
  const client = context.DeepSeekTranslationClient;
  const title = makeSegment("title", "A long synthetic title", { id: "title" });
  const abstract = makeSegment("abstract", "A synthetic abstract", { id: "abstract" });

  const fence = String.fromCharCode(96).repeat(3);
  const parsed = client.parse(
    "prefix\n" + fence + "json\n{\"translations\":[{\"id\":\"title\",\"zh\":\"可靠标题<br>第二部分\"}]}\n" + fence
  );
  const titleResult = client.validate([title], parsed);
  assert.equal(titleResult.get("title"), "可靠标题<br>第二部分");

  const abstractResult = client.validate([abstract], {
    translations: [{ id: "abstract", zh: "这是摘要译文" }]
  });
  assert.equal(abstractResult.get("abstract"), "这是摘要译文");

  assert.throws(
    function () {
      client.validate([title], {
        translations: [{ id: "title", zh: "第一段<br>第二段<br>第三段" }]
      });
    },
    function (error) {
      return error && error.code === "multiple-title-breaks";
    }
  );
  assert.throws(
    function () {
      client.validate([title], {
        translations: [{ id: "title", zh: "<b>标题</b>" }]
      });
    },
    function (error) {
      return error && error.code === "invalid-title-html";
    }
  );
  assert.throws(
    function () {
      client.validate([abstract], {
        translations: [{ id: "abstract", zh: "摘要<br>第二行" }]
      });
    },
    function (error) {
      return error && error.code === "invalid-abstract-html";
    }
  );
  assert.throws(
    function () {
      client.parse("not json");
    },
    function (error) {
      return error && error.code === "invalid-json";
    }
  );
});

test("selection translation validation requires ordered Chinese units and cache envelopes round-trip", function () {
  const context = loadSelectionTranslationContext();
  const selectionMatch = context.ReaderSelectionBlock.create({
    view: null,
    position: makePosition(0, [
      [20, 100, 180, 112],
      [20, 130, 180, 142]
    ]),
    sourceText: "First selected unit.\n\nSecond selected unit."
  });
  const selection = context.ContentSegments.fromSelectionBlock(selectionMatch)[0];
  const units = selection.metadata.selectionUnits;

  const value = context.DeepSeekTranslationClient.validate([selection], {
    translations: [{
      id: selection.id,
      units: units.map(function (unit, index) {
        return {
          id: unit.id,
          zh: index === 0 ? "第一段译文" : "第二段译文"
        };
      })
    }]
  });
  const translated = value.get(selection.id);
  assert.equal(translated.translatedUnits.length, 2);
  assert.equal(translated.translatedText, "第一段译文\n\n第二段译文");
  assert.equal(translated.translatedUnits[0].breakAfter, "paragraph");

  assert.throws(
    function () {
      context.DeepSeekTranslationClient.validate([selection], {
        translations: [{
          id: selection.id,
          units: [
            { id: units[1].id, zh: "错误顺序" },
            { id: units[0].id, zh: "第二段译文" }
          ]
        }]
      });
    },
    function (error) {
      return error && error.code === "invalid-selection-unit";
    }
  );

  const encoded = context.encodeCachedTranslation(selection, translated);
  const decoded = context.decodeCachedTranslation(selection, encoded);
  assert.equal(decoded.translatedText, translated.translatedText);
  assert.equal(decoded.translatedUnits.length, 2);
  assert.equal(decoded.translatedUnits[1].id, units[1].id);
});

test("translation coordinator skips ineligible segments and reports missing credentials", async function () {
  const context = loadTranslationContext();
  const segment = makeSegment("title", "A title", { id: "title" });

  const noProvider = await context.TranslationCoordinator.translateSegments({
    attachment: { id: 1 },
    segments: [segment],
    modelSpec: null
  });
  assert.equal(noProvider.results.get("title").status, "skipped");
  assert.equal(noProvider.results.get("title").errorCode, "no-provider");
  assert.equal(noProvider.diagnostics.total, 1);
  assert.equal(noProvider.diagnostics.cached, 0);
  assert.equal(noProvider.diagnostics.translated, 0);
  assert.equal(noProvider.diagnostics.skipped, 1);
  assert.equal(noProvider.diagnostics.failed, 0);

  const missingKey = await context.TranslationCoordinator.translateSegments({
    attachment: { id: 1 },
    segments: [segment],
    sourceLanguage: "en",
    modelSpec: context.TranslationModelRegistry.deepseek,
    credentials: { getKey: async function () { return ""; } },
    translationClient: {
      translate: async function () {
        throw new Error("should not call client");
      }
    },
    bypassCache: true
  });
  assert.equal(missingKey.results.get("title").status, "failed");
  assert.equal(missingKey.results.get("title").errorCode, "missing-key");
  assert.equal(missingKey.diagnostics.failed, 1);
});
