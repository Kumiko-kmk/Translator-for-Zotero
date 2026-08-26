"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadTextContext,
  loadTranslationContext,
  loadSelectionTranslationContext,
  makePosition,
  makeSelectionPosition,
  makeReaderView,
  makeViewport,
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

test("selection layout classifies layouts without rejecting fallback selections", function () {
  const context = loadTextContext();

  const supportedPosition = makeSelectionPosition(0, [
    [20, 100, 180, 112],
    [20, 130, 180, 142]
  ], { flowID: "flow-1", lineIDs: ["line-1", "line-2"] });
  const supportedLayout = context.ReaderPageTextIndex.classifySelectionLayout({
    view: null, position: supportedPosition
  });
  assert.equal(supportedLayout.supported, true);
  assert.equal(supportedLayout.reason, "supported");
  assert.equal(Array.from(supportedLayout.pageIndexes).join(","), "0");
  assert.equal(Array.from(supportedLayout.flowIDs).join(","), "flow-1");
  assert.equal(Array.from(supportedLayout.lineIDs).join(","), "line-1,line-2");

  const match = context.ReaderSelectionBlock.create({
    view: null,
    position: supportedPosition,
    sourceText: "First paragraph.\n\nSecond paragraph."
  });
  assert.equal(match.blocks.length, 1);
  assert.equal(match.blocks[0].column, "single");
  assert.equal(match.units.length, 2);

  const crossPagePosition = {
    fragments: [
      { pageIndex: 0, flowID: "flow-1", lineIDs: ["line-1"], rects: [[20, 100, 180, 112]] },
      { pageIndex: 1, flowID: "flow-1", lineIDs: ["line-2"], rects: [[20, 100, 180, 112]] }
    ]
  };
  const crossPage = context.ReaderPageTextIndex.classifySelectionLayout({
    view: null, position: crossPagePosition
  });
  assert.equal(crossPage.supported, false);
  assert.equal(crossPage.reason, "cross-page");
  const crossPageMatch = context.ReaderSelectionBlock.create({
    view: null, position: crossPagePosition, sourceText: "Cross page text"
  });
  assert.equal(crossPageMatch.blocks.length, 2);
  assert.equal(context.ContentSegments.fromSelectionBlock(crossPageMatch).length, 1);

  const crossColumnPosition = {
    fragments: [
      { pageIndex: 0, flowID: "flow-left", lineIDs: ["line-left"], rects: [[20, 100, 80, 112]] },
      { pageIndex: 0, flowID: "flow-right", lineIDs: ["line-right"], rects: [[120, 100, 180, 112]] }
    ]
  };
  const crossColumn = context.ReaderPageTextIndex.classifySelectionLayout({
    view: null, position: crossColumnPosition
  });
  assert.equal(crossColumn.supported, false);
  assert.equal(crossColumn.reason, "cross-column");
  const crossColumnMatch = context.ReaderSelectionBlock.create({
    view: null, position: crossColumnPosition, sourceText: "Cross column text"
  });
  assert.equal(crossColumnMatch.blocks.length, 1);
  assert.equal(crossColumnMatch.blocks[0].column, "unknown");
  assert.equal(context.ContentSegments.fromSelectionBlock(crossColumnMatch).length, 1);

  const unknownPosition = makePosition(0, [[20, 100, 180, 112]]);
  const unknown = context.ReaderPageTextIndex.classifySelectionLayout({
    view: null, position: unknownPosition
  });
  assert.equal(unknown.supported, false);
  assert.equal(unknown.reason, "layout-unknown");
  const unknownMatch = context.ReaderSelectionBlock.create({
    view: null, position: unknownPosition, sourceText: "Unknown layout"
  });
  assert.equal(unknownMatch.blocks.length, 1);
  assert.equal(context.ContentSegments.fromSelectionBlock(unknownMatch).length, 1);

  const rotated = context.ReaderPageTextIndex.classifySelectionLayout({
    view: makeReaderView(makeViewport(90, 2)), position: supportedPosition
  });
  assert.equal(rotated.reason, "supported");
});

test("selection layout uses page text-flow metadata instead of viewport geometry", function () {
  const context = loadTextContext();
  const view = {
    _pdfPages: {
      0: {
        chars: [
          { rect: [20, 100, 80, 112], lineID: "line-1", flowID: "flow-1" },
          { rect: [20, 80, 80, 92], lineID: "line-2", flowID: "flow-1" }
        ]
      }
    },
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: { numPages: 1 },
        pdfViewer: { _pages: [] }
      }
    }
  };
  const position = makePosition(0, [
    [20, 100, 80, 112],
    [20, 80, 80, 92]
  ]);
  const supported = context.ReaderPageTextIndex.classifySelectionLayout({ view, position });
  assert.equal(supported.reason, "supported");
  assert.equal(Array.from(supported.flowIDs).join(","), "flow-1");
  assert.equal(Array.from(supported.lineIDs).join(","), "line-1,line-2");

  view._pdfPages[0].chars[1].flowID = "flow-2";
  const crossColumn = context.ReaderPageTextIndex.classifySelectionLayout({ view, position });
  assert.equal(crossColumn.reason, "cross-column");

  delete view._pdfPages[0].chars[0].flowID;
  delete view._pdfPages[0].chars[1].flowID;
  const unknown = context.ReaderPageTextIndex.classifySelectionLayout({ view, position });
  assert.equal(unknown.reason, "layout-unknown");
});

test("selection block parsing preserves explicit paragraph breaks and distribution", function () {
  const context = loadTextContext();
  const position = makeSelectionPosition(0, [
    [20, 100, 180, 112],
    [20, 130, 180, 142]
  ], { flowID: "flow-1", lineIDs: ["line-1", "line-2"] });
  const match = context.ReaderSelectionBlock.create({
    view: null,
    position,
    sourceText: "First paragraph.\n\nSecond paragraph."
  });

  assert.equal(match.mode, "selection-block");
  assert.equal(match.blocks.length, 1);
  assert.equal(match.diagnostics.pageCount, 1);
  assert.equal(match.diagnostics.rawRectCount, 2);
  assert.equal(match.diagnostics.explicitBreakCount, 1);
  assert.equal(match.units.length, 2);
  assert.equal(match.units[0].sourceText, "First paragraph.");
  assert.equal(match.units[0].breakAfter, "paragraph");
  assert.equal(match.units[1].sourceText, "Second paragraph.");
  assert.equal(match.units[1].breakAfter, "none");
  assert.equal(match.distribution.pageWeights.length, 1);

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
      position: makeSelectionPosition(0, [
        [20, 10, 180, 20],
        [20, 25, 180, 35],
        [20, 80, 180, 90]
      ], { flowID: "flow-1", lineIDs: ["line-1", "line-2", "line-3"] }),
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
    position: makeSelectionPosition(0, [
      [20, 100, 180, 112],
      [20, 130, 180, 142]
    ], { flowID: "flow-1", lineIDs: ["line-1", "line-2"] }),
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

test("translation coordinator translates custom selections when layout is conservative", async function () {
  const context = loadTranslationContext();
  let cacheGets = 0;
  let cachePuts = 0;
  context.SegmentTranslationCache.ensureAttachment = async function () {
    return { fileFingerprint: "hash:test", usable: true };
  };
  context.SegmentTranslationCache.get = async function () {
    cacheGets++;
    return null;
  };
  context.SegmentTranslationCache.put = async function () {
    cachePuts++;
    return { recordID: "fallback-record" };
  };
  let networkCalls = 0;
  const segment = makeSegment("custom", "Unsupported cross-column selection", {
    metadata: {
      layoutSupport: { supported: false, reason: "cross-column" }
    }
  });
  const result = await context.TranslationCoordinator.translateSegments({
    attachment: { id: 1 },
    segments: [segment],
    modelSpec: context.TranslationModelRegistry.deepseek,
    credentials: { getKey: async function () { return "test-key"; } },
    translationClient: {
      translate: async function () {
        networkCalls++;
        return new Map([[segment.id, {
          translatedText: "跨栏译文",
          translatedUnits: []
        }]]);
      }
    }
  });
  assert.equal(result.results.get(segment.id).status, "translated");
  assert.equal(result.results.get(segment.id).translatedText, "跨栏译文");
  assert.equal(cacheGets, 1);
  assert.equal(cachePuts, 1);
  assert.equal(networkCalls, 1);
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
