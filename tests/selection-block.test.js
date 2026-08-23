"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const context = { console };
context.globalThis = context;
vm.createContext(context);
for (const file of ["page-text-index.js", "selection-block.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "plugin", file), "utf8"), context,
    { filename: file });
}

const selectionBlock = context.ReaderSelectionBlock;

{
  const groups = selectionBlock.groupRects([
    [40, 20, 280, 32], [40, 38, 260, 50], [65, 56, 230, 68], [40, 74, 150, 86]
  ]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].column, "single");
}

{
  const groups = selectionBlock.groupRects([
    [40, 20, 280, 32], [42, 38, 275, 50],
    [335, 20, 570, 32], [337, 38, 565, 50]
  ]);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(Array.from(groups, group => group.column), ["left", "right"]);
  assert.deepStrictEqual(Array.from(selectionBlock.boundingRect(groups[0].rects)),
    [40, 20, 280, 50]);
  assert.deepStrictEqual(Array.from(selectionBlock.boundingRect(groups[1].rects)),
    [335, 20, 570, 50]);
}

{
  const groups = selectionBlock.groupRects([
    [30, 10, 570, 24], [40, 35, 280, 47], [335, 35, 570, 47]
  ]);
  assert.strictEqual(groups.length, 1,
    "a full-width selected line must collapse mixed layout to one block");
}

{
  const position = {
    pageIndex: 0,
    rects: [[40, 700, 280, 712], [335, 700, 570, 712]],
    fragments: [
      { pageIndex: 0, rects: [[40, 700, 280, 712], [335, 700, 570, 712]] },
      { pageIndex: 1, rects: [[40, 80, 280, 92], [335, 80, 570, 92]] }
    ]
  };
  const result = selectionBlock.create({ position, sourceText: "Cross-page selected source" });
  assert.strictEqual(result.mode, "selection-block");
  assert.strictEqual(result.position.version, 2);
  assert.strictEqual(result.position.coordinateSpace, "pdf");
  assert.strictEqual(result.blocks.length, 4);
  assert.deepStrictEqual(Array.from(result.blocks, block =>
    `${block.pageIndex}:${block.column}`), ["0:left", "0:right", "1:left", "1:right"]);
  assert.strictEqual(result.diagnostics.pageCount, 2);
  assert.strictEqual(result.diagnostics.rawRectCount, 4);
  assert.strictEqual(result.distribution.pageWeights.length, 2);
  assert.strictEqual(result.distribution.blockWeights.length, 4);
  assert.ok(result.distribution.pageWeights.every(page => page.weight > 0));
}

{
  const position = { pageIndex: 0, rects: [[20, 20, 280, 32]],
    fragments: [{ pageIndex: 0, rects: [[20, 20, 280, 32]] }] };
  const result = selectionBlock.create({ position,
    sourceText: "First source paragraph.\n\nSecond source paragraph.\n\nThird source paragraph." });
  assert.deepStrictEqual(Array.from(result.units, unit => unit.sourceText), [
    "First source paragraph.", "Second source paragraph.", "Third source paragraph."
  ]);
  assert.deepStrictEqual(Array.from(result.units, unit => unit.breakAfter),
    ["paragraph", "paragraph", "none"]);
  assert.strictEqual(result.diagnostics.explicitBreakCount, 2);
}

{
  const originalProjectRect = context.ReaderPageTextIndex.projectRect;
  context.ReaderPageTextIndex.projectRect = ({ pageIndex, pdfRect }) => ({
    valid: true, pageIndex, pdfRect: pdfRect.slice(), unitRect: pdfRect.slice(),
    pixelRect: pdfRect.slice(), scale: 1, viewportSignature: "selection-structure-test",
    roundTripError: 0, failureReason: ""
  });
  try {
    const position = { pageIndex: 0,
      rects: [[20, 20, 280, 32], [20, 36, 270, 48],
        [45, 78, 280, 90], [20, 94, 270, 106]],
      fragments: [{ pageIndex: 0,
        rects: [[20, 20, 280, 32], [20, 36, 270, 48],
          [45, 78, 280, 90], [20, 94, 270, 106]] }] };
    const result = selectionBlock.create({ view: {}, position,
      sourceText: "First visual line\nfinishes the first section.\n"
        + "Indented second section\ncontinues here." });
    assert.strictEqual(result.diagnostics.geometryAvailable, true);
    assert.ok(result.diagnostics.geometryBreakCount >= 1);
    assert.ok(result.units.length >= 2);
    assert.strictEqual(result.units.map(unit => unit.sourceText).join(" "),
      "First visual line finishes the first section. Indented second section continues here.");

    const wrappedPosition = { pageIndex: 0,
      rects: [[20, 20, 280, 32], [20, 36, 275, 48],
        [20, 52, 278, 64], [20, 68, 260, 80]],
      fragments: [{ pageIndex: 0,
        rects: [[20, 20, 280, 32], [20, 36, 275, 48],
          [20, 52, 278, 64], [20, 68, 260, 80]] }] };
    const wrapped = selectionBlock.create({ view: {}, position: wrappedPosition,
      sourceText: "A normally wrapped line\ncontinues without a paragraph\n"
        + "and remains in the same unit\nuntil its final line." });
    assert.strictEqual(wrapped.units.length, 1,
      "ordinary visual wrapping must not create hard structure units");

    const widePagePosition = { pageIndex: 0,
      rects: [[25, 20, 1280, 44], [25, 52, 1260, 76], [25, 84, 880, 108],
        [70, 116, 1280, 140], [25, 148, 1260, 172]],
      fragments: [{ pageIndex: 0,
        rects: [[25, 20, 1280, 44], [25, 52, 1260, 76], [25, 84, 880, 108],
          [70, 116, 1280, 140], [25, 148, 1260, 172]] }] };
    const widePage = selectionBlock.create({ view: {}, position: widePagePosition,
      sourceText: "The first paragraph begins here\nand continues on another line\n"
        + "before ending on a short line.\nBefore reviewing the theorem, notation is introduced\n"
        + "and the second paragraph continues." });
    assert.deepStrictEqual(Array.from(widePage.units, unit => unit.sourceText), [
      "The first paragraph begins here and continues on another line before ending on a short line.",
      "Before reviewing the theorem, notation is introduced and the second paragraph continues."
    ], "a two-character first-line indent on a wide page must remain a hard break");
    assert.strictEqual(widePage.diagnostics.geometryTextMapping, "visual-line-exact");
    assert.ok(widePage.diagnostics.geometryEvidence.some(entry =>
      entry.reasons.includes("indent-after-short-line")));

    const formulaPosition = { pageIndex: 0,
      rects: [[20, 20, 280, 32], [20, 36, 250, 48],
        [100, 72, 200, 84], [20, 110, 280, 122], [20, 126, 260, 138]],
      fragments: [{ pageIndex: 0,
        rects: [[20, 20, 280, 32], [20, 36, 250, 48],
          [100, 72, 200, 84], [20, 110, 280, 122], [20, 126, 260, 138]] }] };
    const formula = selectionBlock.create({ view: {}, position: formulaPosition,
      sourceText: "Introductory prose\nends before the equation.\n"
        + "Centered equation\nFollowing prose begins\nand continues." });
    assert.ok(formula.units.length >= 3);
    assert.ok(formula.diagnostics.geometryEvidence.some(entry =>
      entry.reasons.some(reason => reason.startsWith("isolated-centered-block"))));

    context.ReaderPageTextIndex.projectRect = ({ pageIndex, pdfRect }) => pageIndex === 0
      ? { valid: true, pageIndex, pdfRect: pdfRect.slice(), unitRect: pdfRect.slice(),
        pixelRect: pdfRect.slice(), scale: 1, viewportSignature: "partial-projection",
        roundTripError: 0, failureReason: "" }
      : { valid: false, pending: true, pageIndex, pdfRect: pdfRect.slice(),
        failureReason: "viewport-unavailable" };
    const partialProjection = selectionBlock.create({ view: {}, position: {
      ...widePagePosition,
      fragments: [widePagePosition.fragments[0], { pageIndex: 1,
        rects: [[25, 20, 1280, 44], [25, 52, 900, 76]] }]
    }, sourceText: "The first paragraph begins here\nand continues on another line\n"
      + "before ending on a short line.\nBefore reviewing the theorem, notation is introduced\n"
      + "and the second paragraph continues.\nThe next page starts here\nand continues." });
    assert.strictEqual(partialProjection.diagnostics.geometryAvailable, true,
      "one pending page must not disable valid geometry evidence on another page");
    assert.ok(partialProjection.units.length >= 2);
  }
  finally {
    context.ReaderPageTextIndex.projectRect = originalProjectRect;
  }
}

console.log("selection block tests passed");
