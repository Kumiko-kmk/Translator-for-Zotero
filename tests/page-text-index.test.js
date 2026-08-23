"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = { console };
context.globalThis = context;
vm.createContext(context);
const sourcePath = path.resolve(__dirname, "..", "plugin", "page-text-index.js");
vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: sourcePath });
const pageIndex = context.ReaderPageTextIndex;

function apply(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function inverse(matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant
  ];
}

function makeViewport(rotation, scale = 1) {
  const viewBox = [10, 20, 210, 120];
  const unitMatrices = {
    0: [1, 0, 0, -1, -10, 120],
    90: [0, 1, 1, 0, -20, -10],
    180: [-1, 0, 0, 1, 210, -20],
    270: [0, -1, -1, 0, 120, 210]
  };
  const transform = unitMatrices[rotation].map(value => value * scale);
  const inverted = inverse(transform);
  const rotated = rotation === 90 || rotation === 270;
  return {
    transform,
    scale,
    rotation,
    viewBox,
    width: (rotated ? 100 : 200) * scale,
    height: (rotated ? 200 : 100) * scale,
    convertToViewportPoint(x, y) { return apply(transform, x, y); },
    convertToPdfPoint(x, y) { return apply(inverted, x, y); }
  };
}

function makeView(viewport, pageTop = 0) {
  let boundingRectCalls = 0;
  const page = {
    viewport,
    div: {
      getBoundingClientRect() {
        boundingRectCalls++;
        return { left: 100, top: pageTop, right: 100 + viewport.width,
          bottom: pageTop + viewport.height };
      }
    }
  };
  const view = {
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: { numPages: 1 },
        pdfViewer: { _pages: [page] }
      }
    }
  };
  return { view, boundingRectCalls: () => boundingRectCalls };
}

function closeRect(actual, expected, tolerance = 1e-8) {
  assert.strictEqual(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance,
      `${value} differs from ${expected[index]} at ${index}`);
  });
}

const expectedByRotation = {
  0: [10, 70, 50, 90],
  90: [10, 10, 30, 50],
  180: [150, 10, 190, 30],
  270: [70, 150, 90, 190]
};

for (const rotation of [0, 90, 180, 270]) {
  for (const scale of [1, 1.5, 2]) {
    const viewport = makeViewport(rotation, scale);
    const { view, boundingRectCalls } = makeView(viewport, -760);
    const projected = pageIndex.projectRect({
      view,
      pageIndex: 0,
      pdfRect: [20, 30, 60, 50]
    });
    assert.strictEqual(projected.valid, true, `${rotation}deg @ ${scale}`);
    closeRect(Array.from(projected.unitRect), expectedByRotation[rotation]);
    closeRect(Array.from(projected.pixelRect),
      expectedByRotation[rotation].map(value => value * scale));
    assert.ok(projected.roundTripError <= 0.5);
    assert.strictEqual(boundingRectCalls(), 0,
      "projection must not read scroll-dependent DOM client coordinates");
  }
}

{
  const viewport = makeViewport(0, 1.5);
  const above = makeView(viewport, -760);
  const below = makeView(viewport, 940);
  const first = pageIndex.projectRect({ view: above.view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  const second = pageIndex.projectRect({ view: below.view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  closeRect(Array.from(first.pixelRect), Array.from(second.pixelRect));
  assert.strictEqual(above.boundingRectCalls(), 0);
  assert.strictEqual(below.boundingRectCalls(), 0);
}

{
  const { view } = makeView(makeViewport(0, 1));
  const first = pageIndex.projectRect({ view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  const cached = pageIndex.projectRect({ view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  assert.strictEqual(first.cacheHit, false);
  assert.strictEqual(cached.cacheHit, true);
  pageIndex.clearProjection(view, 0);
  const afterClear = pageIndex.projectRect({ view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  assert.strictEqual(afterClear.cacheHit, false);
}

{
  const fixture = makeView(makeViewport(0, 1));
  const first = pageIndex.projectRect({ view: fixture.view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  fixture.view._iframeWindow.PDFViewerApplication.pdfViewer._pages[0].viewport
    = makeViewport(0, 2);
  const scaled = pageIndex.projectRect({ view: fixture.view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  closeRect(Array.from(first.unitRect), Array.from(scaled.unitRect));
  closeRect(Array.from(scaled.pixelRect), Array.from(first.pixelRect).map(value => value * 2));
  assert.strictEqual(scaled.cacheHit, false,
    "a changed viewport signature must not reuse stale pixel geometry");
}

{
  const { view } = makeView(makeViewport(0, 1));
  const invalid = pageIndex.projectRect({ view, pageIndex: 0,
    pdfRect: [0, 0, 5, 5] });
  assert.strictEqual(invalid.valid, false);
  assert.strictEqual(invalid.pending, false);
  assert.strictEqual(invalid.failureReason, "projection-out-of-bounds");
}

{
  const { view } = makeView(makeViewport(0, 1));
  view._iframeWindow.PDFViewerApplication.pdfViewer._pages[0].viewport = null;
  const pending = pageIndex.projectRect({ view, pageIndex: 0,
    pdfRect: [20, 30, 60, 50] });
  assert.strictEqual(pending.valid, false);
  assert.strictEqual(pending.pending, true);
  assert.strictEqual(pending.failureReason, "viewport-unavailable");
}

console.log("page text index projection tests passed");
