"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const bootstrapPath = path.join(root, "plugin", "bootstrap.js");
const extractorPath = path.join(root, "plugin", "page-data-body-extractor.js");
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Zotero: {
    Promise: { delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) },
    debug() {},
    logError() {},
    Items: {}
  },
  Components: {
    utils: {
      cloneInto(value) { return value; },
      exportFunction(value) { return value; }
    }
  },
  Services: { scriptloader: { loadSubScript() {} } },
  APP_SHUTDOWN: "shutdown"
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(bootstrapPath, "utf8"), context, { filename: bootstrapPath });
vm.runInContext(fs.readFileSync(extractorPath, "utf8"), context, { filename: extractorPath });

function makePage(pageIndex, lines) {
  const chars = [];
  let offset = 0;
  for (const line of lines) {
    for (let index = 0; index < line.text.length; index++) {
      const x = 60 + index * 8;
      const top = line.top;
      const height = line.height || 10;
      chars.push({
        id: `${pageIndex}:char:${offset}`,
        offset,
        pageIndex,
        c: line.text[index],
        rect: [x, 800 - top - height, x + 7, 800 - top],
        viewportRect: [x, top, x + 7, top + height],
        lineBreakAfter: index === line.text.length - 1,
        paragraphBreakAfter: !!line.paragraphBreakAfter,
        ignorable: false
      });
      offset++;
    }
  }
  return {
    pageIndex,
    viewBox: [0, 0, 600, 800],
    metric: { pageIndex, width: 600, height: 800, rotation: 0, viewBox: [0, 0, 600, 800] },
    chars
  };
}

function makeLayoutPage(pageIndex, lines) {
  const chars = [];
  let offset = 0;
  for (const line of lines) {
    let x = line.x;
    for (const value of [...line.text]) {
      const width = value === " " ? 3 : (line.charWidth || 5);
      chars.push({
        id: `${pageIndex}:char:${offset}`,
        offset,
        pageIndex,
        c: value,
        rect: [x, 800 - line.top - line.height, x + width, 800 - line.top],
        viewportRect: [x, line.top, x + width, line.top + line.height],
        lineBreakAfter: false,
        paragraphBreakAfter: false,
        spaceAfter: false,
        ignorable: false
      });
      x += width;
      offset++;
    }
    const last = chars.at(-1);
    if (last) last.lineBreakAfter = true;
  }
  return {
    pageIndex,
    viewBox: [0, 0, 600, 800],
    metric: { pageIndex, width: 600, height: 800, rotation: 0, viewBox: [0, 0, 600, 800] },
    chars
  };
}

const locator = context.ReaderTargetLocator;
const recoveryPage = makeLayoutPage(0, [
  { text: "1 Introduction", x: 45, top: 80, height: 16 },
  { text: "Left column line one has enough prose", x: 45, top: 120, height: 12 },
  { text: "Left column line two continues prose", x: 45, top: 140, height: 12 },
  { text: "Left column line three ends prose", x: 45, top: 160, height: 12 },
  { text: "Right column line one has enough prose", x: 330, top: 120, height: 12 },
  { text: "Right column line two continues prose", x: 330, top: 140, height: 12 },
  { text: "Right column line three ends prose", x: 330, top: 160, height: 12 }
]);
const withoutRecovery = context.ReaderPageDataBodyExtractor.extract({ pages: [recoveryPage] });
assert.strictEqual(withoutRecovery.layoutDiagnostics[0].columnDetection, "single");
const withRecovery = context.ReaderPageDataBodyExtractor.extract({
  pages: [recoveryPage],
  selectionContext: {
    columnHints: [{
      pageIndex: 0,
      leftRatio: 0.46,
      rightRatio: 0.54,
      centerRatio: 0.5,
      top: 115,
      bottom: 177,
      lineCount: 6,
      confidence: "high"
    }]
  }
});
assert.strictEqual(withRecovery.layoutDiagnostics[0].columnDetection, "selection-recovery");
assert.ok(withRecovery.layoutDiagnostics[0].recoveredLineCount >= 6);
assert.ok(withRecovery.layoutDiagnostics[0].bands.some(band => band.columnCount === 2));

const crossPage = [
  {
    pageIndex: 0,
    chars: [
      { id: "0:char:0", offset: 0, pageIndex: 0, c: "Cross page", rect: [0, 0, 80, 10], lineBreakAfter: true },
      { id: "0:char:1", offset: 1, pageIndex: 0, c: "abstract", rect: [0, 20, 60, 30], lineBreakAfter: true }
    ]
  },
  {
    pageIndex: 1,
    chars: [
      { id: "1:char:0", offset: 0, pageIndex: 1, c: "text continues", rect: [0, 0, 100, 10], lineBreakAfter: true }
    ]
  }
];
const crossMatch = locator.matchText({
  kind: "abstract",
  text: "Cross page abstract text continues"
}, crossPage);
assert.ok(crossMatch);
assert.strictEqual(crossMatch.confidence, "high");
assert.strictEqual(crossMatch.position.fragments.length, 2);

const frontPage = makePage(0, [
  { text: "Synthetic Article Title", top: 25, height: 20 },
  { text: "Alice Example", top: 80, height: 10 },
  { text: "Abstract", top: 115, height: 12 },
  { text: "This is the abstract text.", top: 140, height: 10 },
  { text: "It has two lines.", top: 155, height: 10 },
  { text: "Keywords: clay model", top: 180, height: 10 },
  { text: "Introduction", top: 195, height: 12 },
  { text: "This is body text for the test.", top: 220, height: 10 }
]);
const frontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({ pages: [frontPage] });
assert.ok(frontMatter.titleCandidates.length >= 1);
assert.match(frontMatter.titleCandidates[0].text, /Synthetic Article Title/);
assert.strictEqual(frontMatter.abstractCandidates.length, 1);
assert.match(frontMatter.abstractCandidates[0].text, /This is the abstract text/);
assert.doesNotMatch(frontMatter.abstractCandidates[0].text, /Keywords/iu);
assert.strictEqual(frontMatter.abstractCandidates[0].position.fragments[0].rects.length, 2);

const multiParagraphAbstractLines = [
  "The paper reports on numerical assessment of the blast response of a heterogeneous composite structure using LS-DYNA solver.",
  "The experimentally observed effect of heterogeneity on the overall response of the structure is numerically assessed.",
  "Multiple approaches to the introduction of material heterogeneity are proposed, modelled and tested.",
  "The numerical results are confronted with the authors original experimental program on a full-scale concrete structure subjected to a near field explosion.",
  "Tests were carried out on a total of three specimens and all specimens were subjected to the same close-in blast loading.",
  "The paper aims to verify and explain the experimental findings, which are supported by PDV measurements."
];
const multiParagraphPage = makeLayoutPage(0, [
  { text: "Multi-paragraph abstract article", x: 40, top: 25, height: 20, charWidth: 4.2 },
  { text: "Abstract", x: 40, top: 80, height: 12, charWidth: 4.2 },
  ...multiParagraphAbstractLines.map((text, index) => ({
    text, x: index >= 3 ? 68 : 40,
    top: 110 + index * 18 + (index === 3 ? 12 : 0), height: 10, charWidth: 3.1
  })),
  { text: "1 Introduction", x: 40, top: 250, height: 12, charWidth: 4.2 },
  { text: "The main body begins after the complete abstract.", x: 40, top: 280, height: 10, charWidth: 3.1 }
]);
const multiParagraphFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [multiParagraphPage]
});
const multiParagraphFallback = context.ReaderTargetLocator.layoutFallbackTargets({
  abstractText: multiParagraphAbstractLines.join(" ")
}, multiParagraphFrontMatter, new Set(["title"]), [multiParagraphPage])
  .find(target => target.kind === "abstract");
assert.ok(multiParagraphFallback);
assert.strictEqual(multiParagraphFallback.sourceLineIDs.length, multiParagraphAbstractLines.length);
assert.strictEqual(multiParagraphFallback.position.fragments[0].rects.length, multiParagraphAbstractLines.length);
const multiParagraphMetadataTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: `<p>${multiParagraphAbstractLines.join(" ")}</p>`
}, [multiParagraphPage], multiParagraphFrontMatter).find(target => target.kind === "abstract");
assert.ok(multiParagraphMetadataTarget);
assert.strictEqual(multiParagraphMetadataTarget.sourceLineIDs.length, multiParagraphAbstractLines.length);
assert.strictEqual(multiParagraphMetadataTarget.position.fragments[0].rects.length, multiParagraphAbstractLines.length);

const biasedAbstractPage = makePage(0, [
  { text: "Biased Abstract Article", top: 25, height: 20 },
  { text: "Abstract", top: 80, height: 12 },
  { text: "The opening sentence establishes the problem and the scope of this study.", top: 105, height: 10 },
  { text: "materials that are widely used in protective structures were selected for this study.", top: 120, height: 10 },
  { text: "The results demonstrate that the proposed configuration improves resistance.", top: 135, height: 10 },
  { text: "Keywords: impact resistance", top: 155, height: 10 },
  { text: "Introduction", top: 175, height: 12 },
  { text: "The main text begins here.", top: 200, height: 10 }
]);
const biasedFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [biasedAbstractPage]
});
assert.strictEqual(biasedFrontMatter.abstractCandidates.length, 1);
assert.match(biasedFrontMatter.abstractCandidates[0].text, /materials that are widely used/iu);
assert.match(biasedFrontMatter.abstractCandidates[0].text, /proposed configuration improves resistance/iu);
assert.strictEqual(biasedFrontMatter.abstractCandidates[0].position.fragments[0].rects.length, 3);
assert.strictEqual(biasedFrontMatter.bodyStart.text, "Introduction");

const titleText = "Effects of steel fiber on the impact performance of ultra-high performance concrete using steel ball aggregates";
const abstractText = [
  "In this paper, a solid steel ball was used as an equal volume replacement for standard sand.",
  "The effect of different steel fiber content on flexural properties was investigated.",
  "The results indicated that steel fibers effectively improved flexural performance under impact loads.",
  "The relationship between strength and potential energy was established and validated."
];
const layoutPage = makeLayoutPage(0, [
  { text: "Effects of steel fiber on the impact performance of ultra-high performance", x: 40, top: 160, height: 20, charWidth: 5.4 },
  { text: "concrete using steel ball aggregates", x: 40, top: 178, height: 20, charWidth: 5.4 },
  { text: "Danying Gao, Yunqing Diao, Shun Zhang, Bo Ma", x: 40, top: 220, height: 10, charWidth: 4.2 },
   { text: "Zhiqiang Gu a", x: 40, top: 232, height: 10, charWidth: 4.2 },
   { text: "Abstract", x: 20, top: 285, height: 10, charWidth: 4.2 },
   { text: "ARTICLE INFO", x: 20, top: 300, height: 10, charWidth: 4.2 },
  { text: "Keywords: steel fiber", x: 20, top: 320, height: 10, charWidth: 4.2 },
  { text: "impact flexure", x: 20, top: 340, height: 10, charWidth: 4.2 },
  { text: "residual properties", x: 20, top: 360, height: 10, charWidth: 4.2 },
  { text: "1. Introduction", x: 20, top: 470, height: 12, charWidth: 4.2 },
  { text: "The risk of in-service structures is significant.", x: 20, top: 500, height: 10, charWidth: 4.2 },
  { text: "A B S T R A C T", x: 320, top: 300, height: 10, charWidth: 4.2 },
  ...abstractText.map((text, index) => ({ text, x: 320, top: 320 + index * 18, height: 10, charWidth: 3.2 }))
]);
const layoutFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({ pages: [layoutPage] });
assert.strictEqual(layoutFrontMatter.abstractHeading.text, "A B S T R A C T");
assert.match(layoutFrontMatter.titleCandidates[0].text, /steel ball aggregates/);
assert.doesNotMatch(layoutFrontMatter.titleCandidates[0].text, /Zhiqiang Gu/iu);
assert.strictEqual(layoutFrontMatter.titleCandidates[0].sourceLineIDs.length, 2);
assert.strictEqual(layoutFrontMatter.titleCandidates[0].position.fragments[0].rects.length, 2);
assert.strictEqual(layoutFrontMatter.abstractCandidates.length, 1);
assert.doesNotMatch(layoutFrontMatter.abstractCandidates[0].text, /Keywords|ARTICLE INFO/iu);
assert.match(layoutFrontMatter.abstractCandidates[0].text, /steel fiber content/iu);
assert.strictEqual(layoutFrontMatter.abstractCandidates[0].position.fragments[0].rects.length, 4);
const layoutTargets = context.ReaderTargetLocator.metadataTargets({
  title: titleText,
  abstractText: `<p>${abstractText.join(" ")}</p>`
}, [layoutPage], layoutFrontMatter);
assert.strictEqual(layoutTargets.length, 2);
assert.strictEqual(layoutTargets[0].kind, "title");
assert.strictEqual(layoutTargets[1].kind, "abstract");
assert.strictEqual(layoutTargets[0].sourceLineIDs.length, 2);
assert.strictEqual(layoutTargets[0].position.fragments[0].rects.length, 2);
assert.strictEqual(layoutTargets[0].matchMethod, "metadata-segmented");
assert.ok(layoutTargets[0].metadataCoverage >= 0.72);
assert.strictEqual(layoutTargets[1].sourceLineIDs.length, 4);
assert.strictEqual(layoutTargets[1].matchMethod, "metadata-segmented");
assert.ok(layoutTargets[1].metadataCoverage >= 0.60);
assert.strictEqual(layoutTargets[1].position.fragments[0].rects.length, 4);

const technicalPaperTitle = "Optimisation of strength reduction finite element method codes for slope stability analysis";
const technicalPaperAbstractLines = [
  "One of the modern methods for estimating the factor of safety for the stability of slopes is the strength reduction method.",
  "In recent times, computer codes have utilised the strength reduction method in conjunction with finite element analysis.",
  "This paper explores the implementation of a strength reduction finite element method with FORTRAN and Python codes in",
  "conjunction with the computer-aided engineering package Abaqus, incorporating a modified strength reduction definition,",
  "allowing for a refinement of the factor of safety search space. The computational efficiency of the modified method is com-",
  "pared with the traditional technique, for both 2D and 3D analysis. The algorithm results are compared for contrasting FEM",
  "element types and geometries and benchmarked against proprietary geotechnical finite element solvers."
];
const technicalPaperPage = makeLayoutPage(0, [
  { text: "Innovative Infrastructure Solutions (2018) 3:38", x: 30, top: 25, height: 11, charWidth: 3.5 },
  { text: "https://doi.org/10.1007/s41062-018-0148-1", x: 30, top: 45, height: 11, charWidth: 3.5 },
  { text: "TECHNICAL PAPERS", x: 30, top: 80, height: 15, charWidth: 4.2 },
  { text: "Optimisation of strength reduction finite element method codes", x: 30, top: 145, height: 20, charWidth: 4.8 },
  { text: "for slope stability analysis", x: 30, top: 170, height: 20, charWidth: 4.8 },
  { text: "Ashley P. Dyson, Ali Tolooi yavan", x: 30, top: 215, height: 11, charWidth: 3.6 },
  { text: "Received: 26 January 2018 / Accepted: 11 April 2018", x: 30, top: 235, height: 10, charWidth: 3.0 },
  { text: "Abstract", x: 30, top: 260, height: 12, charWidth: 3.8 },
  ...technicalPaperAbstractLines.map((text, index) => ({
    text, x: 30, top: 280 + index * 17, height: 10,
    charWidth: index === technicalPaperAbstractLines.length - 1 ? 2.0 : 4.2
  })),
  { text: "Keywords Strength reduction method Finite element method Slope stability", x: 30, top: 404, height: 10, charWidth: 3.6 },
  { text: "Introduction and background", x: 30, top: 425, height: 12, charWidth: 4.0 },
  { text: "Computational slope stability methods in geotechnical engineering", x: 30, top: 445, height: 10, charWidth: 3.2 },
  { text: "algorithms used by finite element programs for slope analysis", x: 325, top: 445, height: 10, charWidth: 3.2 },
  { text: "have received considerable attention in recent times", x: 30, top: 461, height: 10, charWidth: 3.2 },
  { text: "the strength reduction method is widely applied", x: 325, top: 461, height: 10, charWidth: 3.2 },
  { text: "with the aim of preventing serious subsidence events", x: 30, top: 477, height: 10, charWidth: 3.2 },
  { text: "the numerical algorithms are compared in this study", x: 325, top: 477, height: 10, charWidth: 3.2 }
]);
const technicalPaperFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [technicalPaperPage]
});
const technicalTitleCandidate = technicalPaperFrontMatter.titleCandidates
  .find(candidate => candidate.text.includes("slope stability analysis"));
assert.ok(technicalTitleCandidate);
assert.strictEqual(technicalTitleCandidate.sourceLineIDs.length, 2);
const technicalTitleTarget = context.ReaderTargetLocator.metadataLayoutTarget(
  "title", technicalPaperTitle, [technicalPaperPage], technicalPaperFrontMatter
);
assert.ok(technicalTitleTarget);
assert.strictEqual(technicalTitleTarget.sourceLineIDs.length, 2);
assert.strictEqual(technicalTitleTarget.position.fragments[0].rects.length, 2);
assert.ok(technicalTitleTarget.metadataCoverage >= 0.72);
assert.strictEqual(technicalPaperFrontMatter.abstractFlow.mode, "span");
assert.strictEqual(technicalPaperFrontMatter.abstractFlow.columnIndex, -1);
assert.strictEqual(technicalPaperFrontMatter.abstractFlow.confidence, "high");
assert.strictEqual(technicalPaperFrontMatter.abstractCandidates[0].sourceLineIDs.length,
  technicalPaperAbstractLines.length);
assert.doesNotMatch(technicalPaperFrontMatter.abstractCandidates[0].text,
  /Keywords|Introduction and background/iu);
const technicalAbstractTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: technicalPaperAbstractLines.join(" ").replace("com- pared", "compared")
}, [technicalPaperPage], technicalPaperFrontMatter).find(target => target.kind === "abstract");
assert.ok(technicalAbstractTarget);
assert.strictEqual(technicalAbstractTarget.sourceLineIDs.length, technicalPaperAbstractLines.length);
assert.strictEqual(technicalAbstractTarget.position.fragments[0].rects.length,
  technicalPaperAbstractLines.length);

const wideSearchFrontMatter = JSON.parse(JSON.stringify(technicalPaperFrontMatter));
wideSearchFrontMatter.titleCandidates = [];
wideSearchFrontMatter.abstractHeading = {
  ...wideSearchFrontMatter.abstractHeading,
  lineID: wideSearchFrontMatter.layoutLines.find(line => line.text === "Abstract").id
};
const wideSearchTitleTarget = context.ReaderTargetLocator.metadataTargets({
  title: technicalPaperTitle
}, [technicalPaperPage], wideSearchFrontMatter).find(target => target.kind === "title");
assert.ok(wideSearchTitleTarget);
assert.strictEqual(wideSearchTitleTarget.sourceLineIDs.length, 2);

const truncatedFrontMatter = JSON.parse(JSON.stringify(layoutFrontMatter));
const truncatedAbstract = truncatedFrontMatter.abstractCandidates[0];
const keptLineCount = 2;
truncatedAbstract.text = truncatedAbstract.text.split(/\s+/u).slice(0, 18).join(" ");
truncatedAbstract.sourceLineIDs = truncatedAbstract.sourceLineIDs.slice(0, keptLineCount);
truncatedAbstract.sourceLineCharIDs = truncatedAbstract.sourceLineCharIDs.slice(0, keptLineCount);
truncatedAbstract.sourceCharIDs = truncatedAbstract.sourceLineCharIDs.flat();
truncatedAbstract.lineCount = keptLineCount;
truncatedAbstract.position.fragments[0].rects = truncatedAbstract.position.fragments[0].rects
  .slice(0, keptLineCount);
truncatedAbstract.position.fragments[0].lineCharCounts = truncatedAbstract.position.fragments[0].lineCharCounts
  .slice(0, keptLineCount);
const expandedTargets = context.ReaderTargetLocator.metadataTargets({
  title: titleText,
  abstractText: abstractText.join(" ")
}, [layoutPage], truncatedFrontMatter);
const expandedAbstract = expandedTargets.find(target => target.kind === "abstract");
assert.ok(expandedAbstract);
assert.strictEqual(expandedAbstract.matchMethod, "metadata-segmented");
assert.strictEqual(expandedAbstract.sourceLineIDs.length, 4);
assert.strictEqual(expandedAbstract.position.fragments[0].rects.length, 4);
assert.strictEqual(expandedAbstract.completeness, "verified");

const falseBodyStartFrontMatter = JSON.parse(JSON.stringify(layoutFrontMatter));
const thirdAbstractLineID = falseBodyStartFrontMatter.abstractCandidates[0].sourceLineIDs[2];
const thirdAbstractLine = falseBodyStartFrontMatter.layoutLines
  .find(line => line.id === thirdAbstractLineID);
falseBodyStartFrontMatter.bodyStart = {
  text: thirdAbstractLine.text,
  pageIndex: thirdAbstractLine.pageIndex,
  lineID: thirdAbstractLine.id,
  columnIndex: thirdAbstractLine.columnIndex
};
const falseBodyStartTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: abstractText.join(" ")
}, [layoutPage], falseBodyStartFrontMatter).find(target => target.kind === "abstract");
assert.ok(falseBodyStartTarget);
assert.strictEqual(falseBodyStartTarget.sourceLineIDs.length, abstractText.length);
assert.strictEqual(falseBodyStartTarget.completeness, "verified");
assert.strictEqual(falseBodyStartTarget.finalMetadataCoverage, 1);

const offsetScrambledPage = JSON.parse(JSON.stringify(layoutPage));
offsetScrambledPage.chars.forEach((char, index, chars) => {
  char.offset = chars.length - index;
});
const offsetScrambledTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: abstractText.join(" ")
}, [offsetScrambledPage], layoutFrontMatter).find(target => target.kind === "abstract");
assert.ok(offsetScrambledTarget);
assert.strictEqual(offsetScrambledTarget.sourceLineIDs.length, abstractText.length);
assert.strictEqual(offsetScrambledTarget.completeness, "verified");

const inferredTailMetadata = abstractText.join(" ")
  .replace("established and validated", "established then independently validated");
const inferredTailTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: inferredTailMetadata
}, [layoutPage], layoutFrontMatter).find(target => target.kind === "abstract");
assert.ok(inferredTailTarget);
assert.strictEqual(inferredTailTarget.sourceLineIDs.length, abstractText.length);
assert.strictEqual(inferredTailTarget.completeness, "inferred");
assert.ok(inferredTailTarget.finalMetadataCoverage >= 0.85);
const expandedFallbackTargets = context.ReaderTargetLocator.layoutFallbackTargets({
  abstractText: "metadata text with formatting differences"
}, truncatedFrontMatter, new Set(["title"]), [layoutPage]);
const expandedFallback = expandedFallbackTargets.find(target => target.kind === "abstract");
assert.strictEqual(expandedFallback, undefined);
assert.strictEqual(context.ReaderTargetLocator.metadataTargets({
  title: "A title that is not present in the PDF text layer",
  abstractText: "A completely unrelated abstract that has no matching anchors"
}, [layoutPage], layoutFrontMatter).length, 0);
const fallbackTargets = context.ReaderTargetLocator.layoutFallbackTargets({
  title: "A title that is not present in the PDF text layer",
  abstractText: "A completely unrelated abstract that has no matching anchors"
}, layoutFrontMatter, new Set(["title"]), [layoutPage]);
assert.strictEqual(fallbackTargets.length, 0);

const splitColumnAbstractLines = [
  "Spall damage is a typical damage mode of concrete structures under blast or high velocity impact loads.",
  "Blast and impact loads generate a stress wave propagating in the structure.",
  "The present study investigates generic reinforced concrete columns subjected to blast loads.",
  "Three-dimensional numerical models predict concrete spalling under blast loads.",
  "The numerical simulations are verified with blast testing data reported by other researchers.",
  "Empirical relations are suggested to predict concrete spall damage."
];
const splitColumnPage = makeLayoutPage(0, [
  { text: "ARTICLE INFO", x: 20, top: 70, height: 12, charWidth: 4.2 },
  { text: "A B S T R A C T", x: 320, top: 70, height: 12, charWidth: 4.2 },
  { text: "Article history:", x: 20, top: 135, height: 10, charWidth: 3.0 },
  { text: "Received 20 July 2013", x: 20, top: 152, height: 10, charWidth: 2.8 },
  { text: "Received in revised form 24 November 2013", x: 20, top: 169, height: 10, charWidth: 2.0 },
  ...splitColumnAbstractLines.map((text, index) => ({
    text,
    x: index >= 3 ? 340 : 320,
    top: index < 3 ? 135 + index * 17 : 220 + (index - 3) * 17,
    height: 10,
    charWidth: 2.0
  })),
  { text: "Keywords:", x: 20, top: 245, height: 10, charWidth: 3.0 },
  { text: "concrete column", x: 20, top: 262, height: 10, charWidth: 3.0 },
  { text: "spall damage", x: 20, top: 279, height: 10, charWidth: 3.0 },
  { text: "1 Introduction", x: 320, top: 300, height: 12, charWidth: 3.8 }
]);
const splitColumnFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [splitColumnPage]
});
assert.ok(splitColumnFrontMatter.abstractFlow);
assert.strictEqual(splitColumnFrontMatter.abstractFlow.columnIndex, 1);
assert.strictEqual(splitColumnFrontMatter.abstractFlow.confidence, "high");
assert.strictEqual(splitColumnFrontMatter.abstractCandidates.length, 1);
assert.strictEqual(splitColumnFrontMatter.abstractCandidates[0].sourceLineIDs.length,
  splitColumnAbstractLines.length);
assert.doesNotMatch(splitColumnFrontMatter.abstractCandidates[0].text,
  /ARTICLE INFO|Article history|Received|Keywords/iu);
assert.match(splitColumnFrontMatter.abstractCandidates[0].text,
  /Empirical relations are suggested/iu);
const splitColumnTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: splitColumnAbstractLines.join(" ")
}, [splitColumnPage], splitColumnFrontMatter).find(target => target.kind === "abstract");
assert.ok(splitColumnTarget);
assert.deepStrictEqual(splitColumnTarget.sourceLineIDs,
  splitColumnFrontMatter.abstractCandidates[0].sourceLineIDs);
const splitColumnTargetText = splitColumnTarget.sourceLineIDs
  .map(id => splitColumnFrontMatter.layoutLines.find(line => line.id === id)?.text || "")
  .join(" ");
assert.doesNotMatch(splitColumnTargetText,
  /ARTICLE INFO|Article history|Received|Keywords/iu);

const ambiguousFlowFrontMatter = JSON.parse(JSON.stringify(splitColumnFrontMatter));
ambiguousFlowFrontMatter.abstractFlow = null;
ambiguousFlowFrontMatter.layoutLines.forEach(line => {
  line.columnIndex = -1;
  line.pageGutter = null;
  line.geometry = {
    ...line.geometry,
    left: 0,
    right: 600,
    width: 600,
    centerX: 300
  };
});
const ambiguousFlowTargets = context.ReaderTargetLocator.metadataTargets({
  abstractText: splitColumnAbstractLines.join(" ")
}, [splitColumnPage], ambiguousFlowFrontMatter);
assert.strictEqual(ambiguousFlowTargets.filter(target => target.kind === "abstract").length, 0);

const headinglessTitle = "Study on the threshold value of disaster-causing factors of engineering slope cutting in red-layer areas";
const headinglessMetadataTitle = headinglessTitle.replace("disaster-causing", "disaster‑causing");
const headinglessAbstractLines = [
  "Slope cutting is becoming more common in engineering construction to obtain a large floor area.",
  "Slope cutting disrupts a slope's inherent stability, causing instability and sliding.",
  "To solve the problem of geological disasters caused by artificial slope cutting, this study analyzes the disaster factors.",
  "The results demonstrate that cutting height and gradient influence the stability of different slopes.",
  "These findings provide a basis for disaster prevention in red-layer areas."
];
const headinglessMetadataAbstract = headinglessAbstractLines.join(" ").replace("slope's", "slope’s");
const headinglessPage = makeLayoutPage(0, [
  { text: "Frontiers in Earth Science", x: 20, top: 25, height: 12, charWidth: 4.2 },
  { text: "OPEN ACCESS", x: 20, top: 220, height: 10, charWidth: 4.2 },
  { text: "EDITED BY Jingren Zhou", x: 20, top: 250, height: 10, charWidth: 3.8 },
  { text: "SPECIALTY SECTION", x: 20, top: 330, height: 10, charWidth: 3.8 },
  { text: "Study on the threshold value of", x: 320, top: 160, height: 20, charWidth: 4.2 },
  { text: "disaster-causing factors of", x: 320, top: 182, height: 20, charWidth: 4.2 },
  { text: "engineering slope cutting in", x: 320, top: 204, height: 20, charWidth: 4.2 },
  { text: "red-layer areas", x: 320, top: 226, height: 20, charWidth: 4.2 },
  { text: "Yuangu Pan, Kezhu Chen, Meiben Gao, Zhonggeng Wu", x: 320, top: 230, height: 11, charWidth: 3.6 },
  { text: "Sichuan University and Engineering Research Center", x: 320, top: 260, height: 9, charWidth: 3.0 },
  ...headinglessAbstractLines.map((text, index) => ({
    text, x: 320, top: 330 + index * 18, height: 10, charWidth: 3.1
  })),
  { text: "1 Introduction", x: 320, top: 440, height: 12, charWidth: 3.8 },
  { text: "The main text begins after the unlabelled abstract.", x: 320, top: 470, height: 10, charWidth: 3.1 }
]);
const headinglessFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [headinglessPage]
});
assert.strictEqual(headinglessFrontMatter.abstractHeading, null);
assert.strictEqual(headinglessFrontMatter.abstractCandidates.length, 0);
const headinglessTargets = context.ReaderTargetLocator.metadataTargets({
  title: `<p>${headinglessMetadataTitle}</p>`,
  abstractText: `<p>${headinglessMetadataAbstract}</p>`
}, [headinglessPage], headinglessFrontMatter);
const headinglessTitleTarget = headinglessTargets.find(target => target.kind === "title");
const headinglessAbstractTarget = headinglessTargets.find(target => target.kind === "abstract");
assert.ok(headinglessTitleTarget);
assert.strictEqual(headinglessTitleTarget.matchMethod, "metadata-segmented");
assert.strictEqual(headinglessTitleTarget.sourceLineIDs.length, 4);
assert.strictEqual(headinglessTitleTarget.position.fragments[0].rects.length, 4);
assert.ok(headinglessAbstractTarget);
assert.strictEqual(headinglessAbstractTarget.matchMethod, "metadata-segmented");
assert.strictEqual(headinglessAbstractTarget.sourceLineIDs.length, headinglessAbstractLines.length);
assert.strictEqual(headinglessAbstractTarget.position.fragments[0].rects.length, headinglessAbstractLines.length);

const headinglessSpanLines = [
  "A full-width unlabelled abstract starts with a metadata sentence that identifies the research problem and study scope.",
  "The proposed implementation combines numerical analysis with a reproducible computational workflow for engineering use.",
  "Results from several benchmark models demonstrate stable performance under the evaluated loading and boundary conditions.",
  "The findings provide practical guidance for applying the method to future infrastructure assessment and design projects."
];
const headinglessSpanPage = makeLayoutPage(0, [
  { text: "Headingless full-width abstract article", x: 30, top: 80, height: 20, charWidth: 4.6 },
  { text: "Example Author", x: 30, top: 120, height: 11, charWidth: 3.6 },
  ...headinglessSpanLines.map((text, index) => ({
    text, x: 30, top: 180 + index * 18, height: 10, charWidth: 4.2
  })),
  { text: "1 Introduction", x: 30, top: 270, height: 12, charWidth: 4.0 },
  { text: "The first body column begins here with technical discussion", x: 30, top: 300, height: 10, charWidth: 3.2 },
  { text: "The second body column continues the technical discussion", x: 325, top: 300, height: 10, charWidth: 3.2 },
  { text: "Further details are presented in the left body column", x: 30, top: 318, height: 10, charWidth: 3.2 },
  { text: "Additional evidence is presented in the right body column", x: 325, top: 318, height: 10, charWidth: 3.2 },
  { text: "The body contains equations and supporting explanations", x: 30, top: 336, height: 10, charWidth: 3.2 },
  { text: "The analysis continues with implementation considerations", x: 325, top: 336, height: 10, charWidth: 3.2 }
]);
const headinglessSpanFrontMatter = context.ReaderPageDataBodyExtractor.extractFrontMatter({
  pages: [headinglessSpanPage]
});
assert.strictEqual(headinglessSpanFrontMatter.abstractHeading, null);
const headinglessSpanTarget = context.ReaderTargetLocator.metadataTargets({
  abstractText: headinglessSpanLines.join(" ")
}, [headinglessSpanPage], headinglessSpanFrontMatter).find(target => target.kind === "abstract");
assert.ok(headinglessSpanTarget);
assert.strictEqual(headinglessSpanTarget.sourceLineIDs.length, headinglessSpanLines.length);
assert.strictEqual(headinglessSpanTarget.position.fragments[0].rects.length,
  headinglessSpanLines.length);

context.Zotero.Items.getAsync = async itemID => itemID === 42 ? {
  getField(name) {
    return { title: "Metadata Title", abstractNote: "Metadata Abstract" }[name] || "";
  }
} : null;
context.ReaderMetadataLoader.read({
  itemID: 7,
  _item: { parentItemID: 42 }
}).then(metadata => {
  assert.deepStrictEqual({
    title: metadata.title,
    abstractText: metadata.abstractText,
    source: metadata.source,
    parentItemID: metadata.parentItemID
  }, {
    title: "Metadata Title",
    abstractText: "Metadata Abstract",
    source: "parent-item",
    parentItemID: 42
  });
  return context.ReaderMetadataLoader.read({
    itemID: 8,
    _item: {
      getField(name) {
        return { title: "Attachment Title", abstractNote: "Attachment Abstract" }[name] || "";
      }
    }
  });
}).then(metadata => {
  assert.deepStrictEqual({
    title: metadata.title,
    abstractText: metadata.abstractText,
    source: metadata.source,
    parentItemID: metadata.parentItemID
  }, {
    title: "",
    abstractText: "",
    source: "none",
    parentItemID: null
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(metadata, "attachment"), false);

  const requestedPageIndexes = [];
  const view = {
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: 3,
          async getPageData(request) {
            requestedPageIndexes.push(request.pageIndex);
            return { viewBox: frontPage.viewBox, chars: frontPage.chars };
          }
        }
      }
    }
  };
  return context.ReaderTargetLocator.locate(view, { title: "", abstractText: "" })
    .then(result => {
      assert.deepStrictEqual(requestedPageIndexes, [0]);
      assert.strictEqual(result.pages.length, 1);
      assert.strictEqual(result.pages[0].pageIndex, 0);
      assert.strictEqual(result.diagnostics.scannedPageCount, 1);
    });
}).then(() => {
  console.log("selection replacer front matter tests passed");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
