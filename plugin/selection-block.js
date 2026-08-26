(function (global) {
  "use strict";

  function copyRect(value) {
    if (!value || Number(value.length || 0) < 4) return null;
    const rect = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
    if (!rect.every(Number.isFinite)) return null;
    const normalized = [
      Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])
    ];
    return normalized[2] > normalized[0] && normalized[3] > normalized[1]
      ? normalized : null;
  }

  function median(values) {
    const ordered = [...(values || [])].filter(Number.isFinite).sort((left, right) => left - right);
    return ordered.length ? ordered[Math.floor(ordered.length / 2)] : 0;
  }

  function boundingRect(rects) {
    const valid = (rects || []).map(copyRect).filter(Boolean);
    if (!valid.length) return null;
    return [
      Math.min(...valid.map(rect => rect[0])),
      Math.min(...valid.map(rect => rect[1])),
      Math.max(...valid.map(rect => rect[2])),
      Math.max(...valid.map(rect => rect[3]))
    ];
  }

  function rectArea(rect) {
    return rect ? Math.max(1, rect[2] - rect[0] - 8)
      * Math.max(1, rect[3] - rect[1] - 6) : 0;
  }

  function projectedEntries(view, pageIndex, rects, sourceOffset = 0) {
    return (rects || []).map((pdfRect, sourceIndex) => {
      const projection = view && global.ReaderPageTextIndex?.projectRect
        ? global.ReaderPageTextIndex.projectRect({ view, pageIndex, pdfRect }) : null;
      return {
        pageIndex,
        sourceIndex: sourceOffset + sourceIndex,
        pdfRect: pdfRect.slice(),
        layoutRect: projection?.valid ? projection.pixelRect.slice() : pdfRect.slice(),
        projected: Boolean(projection?.valid),
        projectionFailure: projection && !projection.valid ? projection.failureReason : ""
      };
    });
  }

  function normalizeSourceText(sourceText) {
    return String(sourceText || "").replace(/\r\n?/gu, "\n").trim();
  }

  function geometricBreakRatios(blocks) {
    const rows = [];
    for (const block of blocks || []) {
      const ordered = [...block.entries].sort((left, right) =>
        left.layoutRect[1] - right.layoutRect[1]
        || left.layoutRect[0] - right.layoutRect[0]
        || left.sourceIndex - right.sourceIndex);
      for (const entry of ordered) rows.push({ ...entry, blockID: block.id });
    }
    const weights = rows.map(row => Math.max(1,
      (row.layoutRect[2] - row.layoutRect[0])
      / Math.max(1, row.layoutRect[3] - row.layoutRect[1])));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const validBlockIDs = new Set((blocks || []).filter(block =>
      block.entries.length >= 2 && block.entries.every(entry => entry.projected))
      .map(block => block.id));
    if (!(totalWeight > 0) || !validBlockIDs.size) {
      return { ratios: [], boundaries: [], evidence: [], rowCount: rows.length,
        geometryAvailable: false };
    }
    const breakAfter = new Map();
    const addBreak = (row, reason) => {
      const index = rows.indexOf(row);
      if (index < 0 || index >= rows.length - 1) return;
      if (!breakAfter.has(index)) breakAfter.set(index, new Set());
      breakAfter.get(index).add(reason);
    };
    for (const block of blocks || []) {
      if (!validBlockIDs.has(block.id)) continue;
      const ordered = rows.filter(row => row.blockID === block.id);
      if (ordered.length < 2) continue;
      const bounds = boundingRect(ordered.map(row => row.layoutRect));
      const heights = ordered.map(row => row.layoutRect[3] - row.layoutRect[1]);
      const typicalHeight = median(heights) || 1;
      const gaps = ordered.slice(1).map((row, index) =>
        Math.max(0, row.layoutRect[1] - ordered[index].layoutRect[3]));
      const ordinaryGap = median(gaps.filter(value => value <= typicalHeight))
        || Math.max(1, typicalHeight * 0.25);
      const columnWidth = Math.max(1, bounds[2] - bounds[0]);
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const gap = Math.max(0, current.layoutRect[1] - previous.layoutRect[3]);
        const previousWidth = previous.layoutRect[2] - previous.layoutRect[0];
        const indent = current.layoutRect[0] - bounds[0];
        const strongGap = gap >= Math.max(typicalHeight * 0.85, ordinaryGap * 2.2);
        const indentThreshold = Math.max(typicalHeight * 1.15,
          Math.min(columnWidth * 0.03, typicalHeight * 1.8));
        const indentedStart = indent >= indentThreshold
          && previousWidth <= columnWidth * 0.90;
        if (strongGap) addBreak(previous, "large-line-gap");
        else if (indentedStart) addBreak(previous, "indent-after-short-line");
      }
      for (let index = 0; index < ordered.length; index++) {
        const row = ordered[index];
        const width = row.layoutRect[2] - row.layoutRect[0];
        const centered = Math.abs((row.layoutRect[0] + row.layoutRect[2]) / 2
          - (bounds[0] + bounds[2]) / 2) <= columnWidth * 0.12;
        const beforeGap = index > 0
          ? Math.max(0, row.layoutRect[1] - ordered[index - 1].layoutRect[3]) : 0;
        const afterGap = index < ordered.length - 1
          ? Math.max(0, ordered[index + 1].layoutRect[1] - row.layoutRect[3]) : 0;
        const isolated = width <= columnWidth * 0.72 && centered
          && Math.max(beforeGap, afterGap) >= Math.max(ordinaryGap * 1.8,
            typicalHeight * 0.55);
        if (!isolated) continue;
        if (index > 0) addBreak(ordered[index - 1], "isolated-centered-block-before");
        addBreak(row, "isolated-centered-block-after");
      }
    }
    let cumulative = 0;
    const ratios = [];
    const boundaries = [];
    const evidence = [];
    for (let index = 0; index < rows.length; index++) {
      cumulative += weights[index];
      const reasons = breakAfter.get(index);
      if (!reasons) continue;
      ratios.push(cumulative / totalWeight);
      const boundary = { pageIndex: rows[index].pageIndex, rowIndex: index,
        ratio: cumulative / totalWeight, reasons: [...reasons] };
      boundaries.push(boundary);
      evidence.push(boundary);
    }
    return { ratios, boundaries, evidence, rowCount: rows.length,
      geometryAvailable: true };
  }

  function snapGeometryBreak(text, ratio) {
    const target = Math.max(1, Math.min(text.length - 1, Math.round(text.length * ratio)));
    const radius = Math.max(12, Math.round(text.length * 0.10));
    const candidates = [];
    for (let index = Math.max(1, target - radius);
      index <= Math.min(text.length - 1, target + radius); index++) {
      const left = text[index - 1] || "";
      const right = text[index] || "";
      let priority = 5;
      if (left === "\n" || right === "\n") priority = 0;
      else if (/[.!?。！？]/u.test(left)) priority = 1;
      else if (/[;；:：]/u.test(left)) priority = 2;
      else if (/[,，、]/u.test(left)) priority = 3;
      else if (/\s/u.test(left) || /\s/u.test(right)) priority = 4;
      else continue;
      candidates.push({ index, priority, distance: Math.abs(index - target) });
    }
    candidates.sort((left, right) => left.priority - right.priority
      || left.distance - right.distance || left.index - right.index);
    return candidates[0]?.index || 0;
  }

  function buildUnits(sourceText, geometry) {
    const sentinel = "\uE000";
    const working = normalizeSourceText(sourceText)
      .replace(/[ \t]*\n[ \t]*\n+[ \t]*/gu, sentinel);
    if (!working) return { units: [], diagnostics: { explicitBreakCount: 0,
      geometryBreakCount: 0, rejectedGeometryBreakCount: 0, geometryEvidence: [] } };
    const breaks = new Map();
    for (let index = working.indexOf(sentinel); index >= 0;
      index = working.indexOf(sentinel, index + 1)) breaks.set(index, "explicit-blank-line");
    const lineBoundaryOffsets = [];
    for (let index = 0; index < working.length; index++) {
      if (working[index] === "\n" || working[index] === sentinel) {
        lineBoundaryOffsets.push(index);
      }
    }
    const exactLineMapping = Number(geometry.rowCount || 0) > 1
      && lineBoundaryOffsets.length === Number(geometry.rowCount) - 1;
    const geometryBoundaries = geometry.boundaries || (geometry.ratios || [])
      .map(ratio => ({ ratio, rowIndex: -1, reasons: [] }));
    let rejectedGeometryBreakCount = 0;
    for (const boundary of geometryBoundaries) {
      const mappedOffset = exactLineMapping && boundary.rowIndex >= 0
        ? lineBoundaryOffsets[boundary.rowIndex] : 0;
      const offset = mappedOffset || snapGeometryBreak(working, boundary.ratio);
      if (!offset) {
        rejectedGeometryBreakCount++;
        continue;
      }
      if (working[offset] === sentinel || working[offset - 1] === sentinel) continue;
      if (![...breaks.keys()].some(value => Math.abs(value - offset) <= 2)) {
        breaks.set(offset, "geometry");
      }
    }
    const units = [];
    let cursor = 0;
    for (const offset of [...breaks.keys()].sort((left, right) => left - right)) {
      const value = working.slice(cursor, offset).replace(/\s+/gu, " ").trim();
      if (value) units.push({ id: `unit-${units.length}`, sourceText: value,
        breakAfter: "paragraph" });
      cursor = offset + (working[offset] === sentinel ? 1 : 0);
    }
    const tail = working.slice(cursor).replace(new RegExp(sentinel, "gu"), " ")
      .replace(/\s+/gu, " ").trim();
    if (tail) units.push({ id: `unit-${units.length}`, sourceText: tail,
      breakAfter: "none" });
    if (units.length) units[units.length - 1].breakAfter = "none";
    return {
      units,
      diagnostics: {
        explicitBreakCount: [...breaks.values()].filter(value =>
          value === "explicit-blank-line").length,
        geometryBreakCount: [...breaks.values()].filter(value => value === "geometry").length,
        rejectedGeometryBreakCount,
        geometryTextMapping: exactLineMapping ? "visual-line-exact" : "weighted-ratio",
        geometryEvidence: geometry.evidence || []
      }
    };
  }

  function create({ view = null, position, sourceText }) {
    const normalizedPosition = global.ReaderPageTextIndex.positionV2(position);
    const text = normalizeSourceText(sourceText);
    const classify = global.ReaderPageTextIndex?.classifySelectionLayout;
    const emptyLayout = {
      supported: false,
      reason: "layout-unknown",
      pageIndexes: [],
      flowIDs: [],
      lineIDs: []
    };
    const layoutSupport = normalizedPosition && classify
      ? classify.call(global.ReaderPageTextIndex, { view, position: normalizedPosition })
      : emptyLayout;
    if (!normalizedPosition || !text) {
      return { mode: "selection-block", sourceText: text, position: normalizedPosition,
        layoutSupport: normalizedPosition ? layoutSupport : {
          ...emptyLayout,
          reason: "invalid"
        },
        blocks: [], units: [], distribution: { pageWeights: [], blockWeights: [] },
        diagnostics: { pageCount: 0, blockCount: 0, rawRectCount: 0 } };
    }
    // Layout classification is diagnostic only.  A selection can be genuinely
    // cross-page/cross-column, or Zotero can simply omit enough flow metadata
    // to prove that it is single-column.  In both cases retain the original
    // selection and use one fallback block per page instead of dropping it.
    const byPage = new Map();
    let sourceOffset = 0;
    for (const fragment of normalizedPosition.fragments) {
      if (!byPage.has(fragment.pageIndex)) byPage.set(fragment.pageIndex, []);
      byPage.get(fragment.pageIndex).push(...projectedEntries(
        view, fragment.pageIndex, fragment.rects, sourceOffset));
      sourceOffset += fragment.rects.length;
    }
    const blocks = [];
    for (const [pageIndex, entries] of [...byPage.entries()]
      .sort((left, right) => left[0] - right[0])) {
      const layoutRect = boundingRect(entries.map(entry => entry.layoutRect));
      if (!layoutRect || !entries.length) continue;
      blocks.push({
        id: `page-${pageIndex}-selection`,
        pageIndex,
        // Do not claim that a fallback block is a verified single column.
        // The block still keeps all geometry so translation/rendering can
        // proceed even when the classifier reports an ambiguous layout.
        column: layoutSupport?.supported === true ? "single" : "unknown",
        rects: entries.map(entry => entry.pdfRect.slice()),
        entries,
        layoutRect,
        weight: rectArea(layoutRect)
      });
    }
    const geometry = geometricBreakRatios(blocks);
    const structured = buildUnits(text, geometry);
    const blockWeights = blocks.map(block => ({ id: block.id, pageIndex: block.pageIndex,
      column: block.column, weight: block.weight }));
    const pageWeights = [...new Set(blocks.map(block => block.pageIndex))].map(pageIndex => ({
      pageIndex,
      weight: blockWeights.filter(block => block.pageIndex === pageIndex)
        .reduce((sum, block) => sum + block.weight, 0)
    }));
    return {
      mode: "selection-block",
      sourceText: text,
      position: normalizedPosition,
      blocks: blocks.map(({ entries, layoutRect, ...block }) => block),
      units: structured.units,
      distribution: { pageWeights, blockWeights },
      diagnostics: {
        pageCount: new Set(normalizedPosition.fragments.map(fragment => fragment.pageIndex)).size,
        blockCount: blocks.length,
        rawRectCount: normalizedPosition.fragments
          .reduce((sum, fragment) => sum + fragment.rects.length, 0),
        layoutReason: layoutSupport?.reason || "layout-unknown",
        columnPageIndexes: [],
        layoutFallback: layoutSupport?.supported !== true,
        geometryAvailable: geometry.geometryAvailable,
        ...structured.diagnostics
      },
      layoutSupport
    };
  }

  global.ReaderSelectionBlock = { create, boundingRect,
    _test: { copyRect, median, rectArea, snapGeometryBreak, buildUnits,
      geometricBreakRatios } };
})(typeof globalThis !== "undefined" ? globalThis : this);
