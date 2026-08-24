"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadTextContext,
  makeLayoutPage,
  makePosition,
  makeReaderView,
  makeViewport
} = require("./helpers");

test("page text index projects PDF rectangles for every rotation", function () {
  const context = loadTextContext();
  const expected = new Map([
    [0, [10, 70, 50, 90]],
    [90, [710, 10, 730, 50]],
    [180, [550, 710, 590, 730]],
    [270, [70, 550, 90, 590]]
  ]);

  for (const rotation of [0, 90, 180, 270]) {
    const viewport = makeViewport(rotation, 1);
    const view = makeReaderView(viewport);
    const result = context.ReaderPageTextIndex.projectRect({
      view,
      pageIndex: 0,
      pdfRect: [10, 710, 50, 730]
    });

    assert.equal(result.valid, true, JSON.stringify(result));
    assert.deepEqual(Array.from(result.pixelRect), expected.get(rotation));
  }
});

test("page text index caches valid projections and reports recoverable viewport failures", function () {
  const context = loadTextContext();
  const viewport = makeViewport(0, 1);
  const view = makeReaderView(viewport);

  const first = context.ReaderPageTextIndex.projectRect({
    view,
    pageIndex: 0,
    pdfRect: [20, 700, 80, 730]
  });
  const second = context.ReaderPageTextIndex.projectRect({
    view,
    pageIndex: 0,
    pdfRect: [20, 700, 80, 730]
  });

  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(second.cacheHit, true);

  const outside = context.ReaderPageTextIndex.projectRect({
    view,
    pageIndex: 0,
    pdfRect: [-50, 700, -10, 730]
  });
  assert.equal(outside.valid, false);
  assert.equal(outside.failureReason, "projection-out-of-bounds");

  const unavailableView = makeReaderView(viewport);
  unavailableView._iframeWindow.PDFViewerApplication.pdfViewer._pages[0].viewport = null;
  const pending = context.ReaderPageTextIndex.projectRect({
    view: unavailableView,
    pageIndex: 0,
    pdfRect: [20, 700, 80, 730]
  });
  assert.equal(pending.valid, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.failureReason, "viewport-unavailable", JSON.stringify(pending));
});

test("front matter extraction identifies title, abstract, and body boundary", function () {
  const context = loadTextContext();
  const page = makeLayoutPage(0, [
    { text: "Synthetic Article Title", x: 165, top: 25, height: 20, charWidth: 7, fontName: "TitleFont" },
    { text: "Alice Example", x: 240, top: 55, height: 10 },
    { text: "Abstract", x: 40, top: 85, height: 12, fontName: "HeadingFont" },
    { text: "This is a synthetic abstract.", x: 40, top: 110, height: 10 },
    { text: "It has two lines.", x: 40, top: 128, height: 10, paragraphBreakAfter: true },
    { text: "Keywords: clay model", x: 40, top: 155, height: 10 },
    { text: "1 Introduction", x: 40, top: 180, height: 12, fontName: "HeadingFont" },
    { text: "The body begins here.", x: 40, top: 205, height: 10 },
    { text: "More body text follows.", x: 40, top: 223, height: 10 }
  ]);

  const frontMatter = context.ReaderFrontMatterExtractor.extractFrontMatter({
    pages: [page]
  });

  assert.ok(frontMatter.titleCandidates.length >= 1);
  assert.match(frontMatter.titleCandidates[0].text, /Synthetic Article Title/);
  assert.ok(frontMatter.abstractCandidates.length >= 1);
  assert.match(frontMatter.abstractCandidates[0].text, /This is a synthetic abstract/);
  assert.match(frontMatter.abstractCandidates[0].text, /It has two lines/);
  assert.doesNotMatch(frontMatter.abstractCandidates[0].text, /Keywords|Introduction/);
  assert.ok(frontMatter.bodyStart);
  assert.match(frontMatter.bodyStart.text, /Introduction/);
  assert.ok(frontMatter.layoutLines.length >= 6);
});

test("metadata target locator builds positioned title and abstract targets", function () {
  const context = loadTextContext();
  const page = makeLayoutPage(0, [
    { text: "Synthetic Article Title", x: 165, top: 25, height: 20, charWidth: 7, fontName: "TitleFont" },
    { text: "Alice Example", x: 240, top: 55, height: 10 },
    { text: "Abstract", x: 40, top: 85, height: 12, fontName: "HeadingFont" },
    { text: "This is a synthetic abstract.", x: 40, top: 110, height: 10 },
    { text: "It has two lines.", x: 40, top: 128, height: 10 },
    { text: "Keywords: clay model", x: 40, top: 155, height: 10 },
    { text: "1 Introduction", x: 40, top: 180, height: 12, fontName: "HeadingFont" },
    { text: "The body begins here.", x: 40, top: 205, height: 10 }
  ]);
  const frontMatter = context.ReaderFrontMatterExtractor.extractFrontMatter({
    pages: [page]
  });
  const targets = context.ReaderTargetLocator.metadataTargets({
    title: "Synthetic Article Title",
    abstractText: "This is a synthetic abstract. It has two lines."
  }, [page], frontMatter);

  const kinds = targets.map(function (target) { return target.kind; });
  assert.ok(kinds.includes("title"));
  assert.ok(kinds.includes("abstract"));

  for (const target of targets) {
    assert.ok(target.position);
    assert.ok(Array.isArray(target.position.fragments));
    assert.ok(target.position.fragments.length >= 1);
    assert.ok(target.sourceCharIDs.length >= 1);
    assert.equal(target.text.length > 0, true);
  }
});

test("metadata matching can span adjacent pages", function () {
  const context = loadTextContext();
  const pages = [
    makeLayoutPage(0, [
      { text: "Cross page abstract", x: 40, top: 110, height: 10 }
    ]),
    makeLayoutPage(1, [
      { text: "text continues", x: 40, top: 110, height: 10 }
    ])
  ];

  const target = context.ReaderTargetLocator.matchText({
    kind: "abstract",
    text: "Cross page abstract text continues"
  }, pages);

  assert.ok(target);
  assert.equal(target.kind, "abstract");
  assert.equal(target.position.fragments.length, 2);
  assert.equal(target.pageIndexes.length, 2);
  assert.ok(target.metadataCoverage >= 0.85);
});

test("selection page indexes preserve cross-page order", function () {
  const context = loadTextContext();
  const position = {
    fragments: [
      { pageIndex: 2, rects: [[10, 10, 30, 20]] },
      { pageIndex: 3, rects: [[10, 10, 30, 20]] },
      { pageIndex: 5, rects: [[10, 10, 30, 20]] }
    ]
  };

  assert.deepEqual(
    Array.from(context.ReaderPageTextIndex.selectionPageIndexes(position, 6)),
    [2, 3, 5]
  );
  assert.deepEqual(
    context.ReaderPageTextIndex.positionV2(position).fragments.map(function (item) {
      return item.pageIndex;
    }),
    [2, 3, 5]
  );
});

test("empty or malformed extraction inputs fail with stable error codes", function () {
  const context = loadTextContext();

  assert.throws(
    function () {
      context.ReaderFrontMatterExtractor.extractFrontMatter({ pages: [] });
    },
    function (error) {
      return error && error.code === "empty-pdf";
    }
  );

  assert.throws(
    function () {
      context.ReaderFrontMatterExtractor.extractFrontMatter({
        pages: [makeLayoutPage(0, [])]
      });
    },
    function (error) {
      return error && error.code === "pdf-text-layer-empty";
    }
  );

  assert.equal(
    context.ReaderTargetLocator.matchText({ kind: "title", text: "" }, []),
    null
  );
});
