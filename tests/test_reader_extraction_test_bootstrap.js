const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const root = process.env.ZOTERO_TEST_ROOT || "E:/Kumiko/pythonProject/Zotero";
const pluginRoot = `${root}/zotero-reader-extraction-test`;
const extractorSource = fs.readFileSync(`${pluginRoot}/page-data-body-extractor.js`, "utf8");
const bootstrapSource = fs.readFileSync(`${pluginRoot}/bootstrap.js`, "utf8");

const VIEW_BOX = [0, 0, 600, 800];

function makeLine(text, pageIndex, x, bottom, options = {}) {
  const chars = [];
  let cursor = x;
  const height = Number(options.height || 12);
  for (const character of text) {
    if (character === " ") {
      if (chars.length) chars.at(-1).spaceAfter = true;
      cursor += Number(options.spaceWidth || 3);
      continue;
    }
    const width = /[ilI.,'()]/u.test(character) ? 2 : 4;
    chars.push({
      id: `${pageIndex}:fixture:${bottom}:${chars.length}:${cursor}`,
      c: character,
      rect: [cursor, bottom, cursor + width, bottom + height],
      inlineRect: [cursor, bottom, cursor + width, bottom + height],
      lineBreakAfter: false,
      paragraphBreakAfter: false,
      spaceAfter: false,
      ignorable: false,
      rotation: Number(options.rotation || 0)
    });
    cursor += width + 1;
  }
  if (chars.length) {
    chars.at(-1).lineBreakAfter = true;
    chars.at(-1).paragraphBreakAfter = options.paragraphBreakAfter !== false;
  }
  return chars;
}

function makePage(pageIndex, groups) {
  return {
    pageIndex,
    chars: groups.flat(),
    viewBox: VIEW_BOX,
    metric: { pageIndex, width: 600, height: 800, rotation: 0, viewBox: VIEW_BOX }
  };
}

const pages = [
  makePage(0, [
    makeLine("Repeated journal header 2025", 0, 210, 780, { height: 9 }),
    makeLine("A Layout Aware Scientific Study", 0, 130, 745, { height: 20 }),
    makeLine("Alice Smith and Bob Jones", 0, 190, 720, { height: 11 }),
    makeLine("Abstract", 0, 50, 690, { height: 14 }),
    makeLine("This abstract is handled by another Zotero interface.", 0, 50, 670),
    makeLine("1 Introduction", 0, 50, 640, { height: 14 }),
    makeLine("The left column begins with ordinary body prose", 0, 45, 610),
    makeLine("and retains variables E x and alpha in the sentence", 0, 45, 593),
    makeLine("without applying a minimum paragraph threshold", 0, 45, 576),
    makeLine("The reading order remains inside the left flow", 0, 45, 559),
    makeLine("The validated procedure therefore ends with prepa-", 0, 45, 542),
    makeLine("ration before entering the right column", 0, 330, 610),
    makeLine("which follows only after the complete left column", 0, 330, 593),
    makeLine("Fig. 11 shows a normal scientific discussion", 0, 330, 576),
    makeLine("that must remain as continuous body prose.", 0, 330, 559),
    makeLine("A short body paragraph remains.", 0, 330, 525),
    makeLine("1", 0, 298, 12, { height: 9 })
  ]),
  makePage(1, [
    makeLine("Repeated journal header 2026", 1, 210, 780, { height: 9 }),
    makeLine("2 Methods", 1, 45, 740, { height: 14 }),
    makeLine("The second page keeps inline stress sigma = A + B in prose,", 1, 45, 710),
    makeLine("and the surrounding natural language remains complete.", 1, 45, 693),
    makeLine("sigma = A + B epsilon", 1, 120, 655),
    makeLine("(16)", 1, 270, 655),
    makeLine("The prose after the display equation remains complete.", 1, 45, 620),
    makeLine("Additional evidence follows the equation normally.", 1, 45, 603),
    makeLine("Table 1. Material properties", 1, 45, 555, { height: 9 }),
    makeLine("Mix", 1, 45, 535, { height: 9 }),
    makeLine("Water", 1, 135, 535, { height: 9 }),
    makeLine("Strength", 1, 225, 535, { height: 9 }),
    makeLine("A", 1, 45, 517, { height: 9 }),
    makeLine("0.42", 1, 135, 517, { height: 9 }),
    makeLine("31.5", 1, 225, 517, { height: 9 }),
    makeLine("B", 1, 45, 499, { height: 9 }),
    makeLine("0.38", 1, 135, 499, { height: 9 }),
    makeLine("35.2", 1, 225, 499, { height: 9 }),
    makeLine("The right column starts with retained body prose", 1, 330, 710),
    makeLine("and remains ordered after the left column is complete.", 1, 330, 693),
    makeLine("Image labels are isolated from this normal paragraph.", 1, 330, 620),
    makeLine("The analysis continues below the omitted figure.", 1, 330, 603),
    makeLine("A", 1, 390, 470, { height: 8 }),
    makeLine("B", 1, 470, 450, { height: 8 }),
    makeLine("Fig. 12. Failure pattern of the specimen.", 1, 335, 420, { height: 9 }),
    makeLine("2", 1, 298, 12, { height: 9 })
  ]),
  makePage(2, [
    makeLine("Repeated journal header 2027", 2, 210, 780, { height: 9 }),
    makeLine("3 Results", 2, 45, 735, { height: 14 }),
    makeLine("The final retained section reports the principal result", 2, 45, 705),
    makeLine("and ends before the reference section begins.", 2, 45, 688),
    makeLine("References", 2, 45, 640, { height: 14 }),
    makeLine("Smith A. 2025. This reference must never be retained.", 2, 45, 610),
    makeLine("3", 2, 298, 12, { height: 9 })
  ])
];

const context = {
  APP_SHUTDOWN: 2,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  PathUtils: { join: (...parts) => parts.join("/") },
  Components: {
    utils: {
      exportFunction: handler => handler,
      cloneInto: value => value
    }
  },
  Services: { scriptloader: { loadSubScript() {} } },
  Zotero: {
    initializationPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    Promise: { delay: () => Promise.resolve() },
    Reader: { _readers: [], registerEventListener() {}, _unregisterEventListenerByPluginID() {} },
    Items: { async getAsync() { return null; } },
    debug() {},
    logError() {}
  }
};

vm.createContext(context);
vm.runInContext(extractorSource, context, { filename: "page-data-body-extractor.js" });
vm.runInContext(bootstrapSource, context, { filename: "bootstrap.js" });

const extractor = context.ReaderPageDataBodyExtractor;
const plugin = context.ReaderExtractionTest;
assert.ok(extractor);
assert.ok(plugin);
assert.ok(context.ReaderExtractionOverlay);
assert.equal(extractor._test.isNumberedHeading("1.2 Numerical analysis"), true);
assert.equal(extractor._test.isNumberedHeading("0.25 m while holding the parameters constant"), false);
assert.equal(extractor._test.isNumberedHeading("1200 kg material density is used"), false);

(async () => {
  const result = extractor.extract({
    pages,
    outlineHints: [
      { title: "1 Introduction", pageIndex: 0 },
      { title: "2 Methods", pageIndex: 1 },
      { title: "References", pageIndex: 2 }
    ]
  });
  const joined = result.raw.map(paragraph => paragraph.text).join("\n");

  assert.equal(result.layoutDiagnostics[0].columnCount, 2);
  assert.equal(result.layoutDiagnostics[2].columnCount, 1);
  assert.equal(result.characterConservation.unassignedCharacterCount, 0);
  assert.equal(result.characterConservation.duplicateCharacterCount, 0);
  assert.equal(result.bodyBoundary.start.reason, "recognized-start-heading");
  assert.match(joined, /variables E x and alpha/);
  assert.match(joined, /inline stress sigma = A \+ B in prose/);
  assert.match(joined, /Fig\. 11 shows a normal scientific discussion/);
  assert.match(joined, /A short body paragraph remains\./);
  assert.match(joined, /preparation before entering the right column/);
  assert.match(joined, /prose after the display equation remains complete/);
  assert.match(joined, /final retained section reports the principal result/);
  assert.doesNotMatch(joined, /Layout Aware Scientific Study|Alice Smith|abstract is handled|sigma = A \+ B epsilon|Material properties|Water|Failure pattern|reference must never/i);
  assert.doesNotMatch(joined, /\(16\)|31\.5|35\.2/);
  assert.ok(result.raw.every(paragraph => paragraph.contentType === "body-paragraph"));
  assert.ok(result.raw.every(paragraph => paragraph.sourceCharIDs.length > 0));
  assert.ok(result.raw.flatMap(paragraph => paragraph.position.fragments)
    .every(fragment => fragment.coordinateSource === "zotero-page-char" && fragment.rects.length));
  assert.ok(result.retainedAmbiguities.some(item => item.reason === "caption-like-prose"));

  const reasons = new Map(result.exclusions.map(exclusion => [exclusion.reason, exclusion.count]));
  for (const reason of [
    "front-matter", "section-heading", "terminal-section", "display-formula",
    "table-content", "table-caption", "figure-caption", "figure-label",
    "page-number", "repeated-header"
  ]) assert.ok(reasons.has(reason), `missing exclusion reason ${reason}`);

  const crossPage = extractor.extract({ pages: [
    makePage(0, [
      makeLine("Repeated running header", 0, 210, 780, { height: 9 }),
      makeLine("1 Introduction", 0, 50, 730, { height: 14 }),
      makeLine("A single column paragraph begins with sufficient context", 0, 50, 690),
      makeLine("and continues through several ordinary body lines", 0, 50, 673),
      makeLine("before reaching the physical end of the first page", 0, 50, 656),
      makeLine("without terminal punctuation at the flow boundary", 0, 50, 639),
      makeLine("1", 0, 298, 12, { height: 9 })
    ]),
    makePage(1, [
      makeLine("Repeated running header", 1, 210, 780, { height: 9 }),
      makeLine("and resumes at the beginning of the following page", 1, 50, 730),
      makeLine("where the reconstructed paragraph remains continuous.", 1, 50, 713),
      makeLine("A second independent paragraph is also retained.", 1, 50, 675),
      makeLine("2", 1, 298, 12, { height: 9 })
    ])
  ] });
  assert.ok(crossPage.raw.some(paragraph => paragraph.mergeReasons.includes("page-continuation")
    && paragraph.position.fragments.length === 2));

  const measurementCase = extractor.extract({ pages: [
    makePage(0, [
      makeLine("1 Introduction", 0, 50, 730, { height: 14 }),
      makeLine("The load duration ranged from a quarter metre to two metres", 0, 50, 690),
      makeLine("0.25 m while holding the material parameters as constant. The", 0, 50, 673, { height: 13 }),
      makeLine("density of foam concrete is set as 1200 kg per cubic metre", 0, 50, 656),
      makeLine("and the remaining parameters are determined from Table 1.", 0, 50, 639)
    ])
  ] });
  const measurementText = measurementCase.raw.map(paragraph => paragraph.text).join("\n");
  assert.match(measurementText, /0\.25 m while holding the material parameters as constant\. The/);
  assert.doesNotMatch(JSON.stringify(measurementCase.exclusions), /0\.25 m while holding/);

  const captionLikeBodyCase = extractor.extract({ pages: [
    makePage(0, [
      makeLine("1 Introduction", 0, 50, 730, { height: 14 }),
      makeLine("The evolution of the axial deformation measured during the test", 0, 50, 690),
      makeLine("and the associated strain suction path are depicted in", 0, 50, 673),
      makeLine("Fig. 6. These results evidence that the amount of", 0, 50, 656),
      makeLine("elastoplastic strain build-up during a cycle depends on stress.", 0, 50, 639),
      makeLine("The discussion continues as an ordinary body paragraph.", 0, 50, 622),
      makeLine("Fig. 7. Stress-strain response of the specimen.", 0, 120, 520, { height: 9 })
    ])
  ] });
  const captionLikeBodyText = captionLikeBodyCase.raw.map(paragraph => paragraph.text).join("\n");
  assert.match(captionLikeBodyText, /Fig\. 6\. These results evidence that the amount of/);
  assert.doesNotMatch(captionLikeBodyText, /Fig\. 7\. Stress-strain response/);
  assert.doesNotMatch(
    JSON.stringify(captionLikeBodyCase.exclusions.filter(item => item.reason === "figure-caption")),
    /Fig\. 6\. These results evidence/
  );
  assert.ok(captionLikeBodyCase.retainedAmbiguities.some(item =>
    item.reason === "caption-like-prose" && /Fig\. 6\./.test(item.sampleText)
  ));

  const rotated = extractor._test.preparePage(makePage(0, [
    makeLine("Rotated label", 0, 50, 700, { rotation: 90 })
  ]));
  extractor._test.clusterPageLines(rotated);
  assert.equal(rotated.items.length, 0);
  assert.ok(rotated.rejectedItems.every(item => item.reason === "rotated-or-vertical-text"));

  const viewport = {
    width: 600,
    height: 800,
    rotation: 0,
    viewBox: VIEW_BOX,
    convertToViewportPoint: (x, y) => [x, 800 - y]
  };
  function makeDOMNode(ownerDocument) {
    return {
      ownerDocument,
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      setAttribute() {},
      append(node) {
        node.parentNode = this;
        this.children.push(node);
      },
      replaceChildren() {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      },
      getElementsByClassName() { return []; },
      getBoundingClientRect: () => ({ left: 100, top: 200 })
    };
  }
  const viewerPages = pages.map(() => {
    const ownerDocument = { createElement: () => makeDOMNode(ownerDocument) };
    return { div: makeDOMNode(ownerDocument), viewport };
  });
  const pdfDocument = {
    numPages: pages.length,
    async getPageData({ pageIndex }) {
      return { chars: pages[pageIndex].chars, viewBox: VIEW_BOX };
    },
    async getOutline() {
      return [{ title: "1 Introduction", dest: [0] }, { title: "References", dest: [2] }];
    }
  };
  const view = {
    _iframeWindow: { PDFViewerApplication: { pdfDocument, pdfViewer: { _pages: viewerPages } } },
    getClientRect(rect) { return [rect[0] + 100, rect[1] + 200, rect[2] + 100, rect[3] + 200]; }
  };
  const reader = {
    itemID: 42,
    _item: { id: 42, key: "ATTACH", libraryID: 1, isPDFAttachment: () => true },
    _internalReader: { _primaryView: view }
  };
  const snapshot = await plugin.getReaderSnapshot(reader);
  assert.equal(snapshot.extractionSource, "zotero-page-data");
  assert.equal(snapshot.extractionMode, "page-data-body-paragraphs");
  assert.equal(snapshot.characterConservation.unassignedCharacterCount, 0);
  assert.equal(snapshot.pageMetrics.length, 3);
  assert.equal(JSON.stringify(context.ReaderExtractionOverlay.convertRect({ view }, [50, 100, 150, 120], 0)),
    JSON.stringify([50, 100, 150, 120]));

  const overlaySession = {
    view,
    overlayLayers: new Map(),
    highlightedRectCount: 0,
    boundaryMarkerCount: 0
  };
  context.ReaderExtractionOverlay.renderParagraph(overlaySession, snapshot.raw[0]);
  const overlayNodes = [...overlaySession.overlayLayers.values()].flatMap(layer => layer.children);
  const startMarkers = overlayNodes.filter(node => node.dataset.boundary === "start");
  const endMarkers = overlayNodes.filter(node => node.dataset.boundary === "end");
  assert.equal(startMarkers.length, 1);
  assert.equal(endMarkers.length, 1);
  assert.equal(overlaySession.boundaryMarkerCount, 2);
  assert.match(startMarkers[0].style.background, /0, 190, 255/);
  assert.match(endMarkers[0].style.background, /255, 70, 110/);

  await assert.rejects(
    () => plugin.getReaderSnapshot({
      itemID: 99,
      _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: {} } } } }
    }),
    error => error.code === "page-data-api-unavailable"
  );

  assert.match(bootstrapSource, /pdfDocument\.getPageData\(request\)/);
  assert.doesNotMatch(bootstrapSource, /getTextContent|pdfDocument\.getPage\(|_loadSDT|readAloud|getStructTree|getOperatorList/);
  assert.doesNotMatch(extractorSource, /getTextContent|TextItem|readAloud|fetch\(|XMLHttpRequest|chat\/completions/);
  console.log("reader extraction getPageData-only smoke test passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
