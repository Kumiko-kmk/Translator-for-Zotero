(function (global) {
  "use strict";

  const states = new WeakMap();

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

  function copyViewBox(value) {
    const rect = copyRect(value);
    return rect && rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
  }

  function applyMatrix(matrix, x, y) {
    return [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5]
    ];
  }

  function invertMatrix(matrix) {
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
    return [
      matrix[3] / determinant,
      -matrix[1] / determinant,
      -matrix[2] / determinant,
      matrix[0] / determinant,
      (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
      (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant
    ];
  }

  function transformRect(matrix, rect) {
    if (!matrix || !rect) return null;
    const points = [
      applyMatrix(matrix, rect[0], rect[1]),
      applyMatrix(matrix, rect[0], rect[3]),
      applyMatrix(matrix, rect[2], rect[1]),
      applyMatrix(matrix, rect[2], rect[3])
    ];
    const result = [
      Math.min(...points.map(point => point[0])),
      Math.min(...points.map(point => point[1])),
      Math.max(...points.map(point => point[0])),
      Math.max(...points.map(point => point[1]))
    ];
    return result.every(Number.isFinite) && result[2] > result[0] && result[3] > result[1]
      ? result : null;
  }

  function viewportScale(viewport) {
    const declared = Number(viewport?.scale || 0);
    if (declared > 0) return declared;
    const transform = viewport?.transform;
    if (Array.isArray(transform) && transform.length >= 4) {
      const horizontal = Math.hypot(Number(transform[0]), Number(transform[1]));
      const vertical = Math.hypot(Number(transform[2]), Number(transform[3]));
      const inferred = Math.max(horizontal, vertical);
      if (inferred > 0) return inferred;
    }
    return 1;
  }

  function viewportMatrix(viewport) {
    if (Array.isArray(viewport?.transform) && viewport.transform.length >= 6) {
      const matrix = viewport.transform.slice(0, 6).map(Number);
      if (matrix.every(Number.isFinite) && invertMatrix(matrix)) return matrix;
    }
    if (typeof viewport?.convertToViewportPoint === "function") {
      try {
        const origin = viewport.convertToViewportPoint(0, 0).map(Number);
        const unitX = viewport.convertToViewportPoint(1, 0).map(Number);
        const unitY = viewport.convertToViewportPoint(0, 1).map(Number);
        const matrix = [
          unitX[0] - origin[0], unitX[1] - origin[1],
          unitY[0] - origin[0], unitY[1] - origin[1],
          origin[0], origin[1]
        ];
        if (matrix.every(Number.isFinite) && invertMatrix(matrix)) return matrix;
      }
      catch (_) {}
    }
    return null;
  }

  function normalizedViewportMatrix(viewport, viewBox, rotation) {
    const scale = viewportScale(viewport);
    const pixelMatrix = viewportMatrix(viewport);
    if (pixelMatrix) {
      const matrix = pixelMatrix.map(value => Number(value) / scale);
      if (matrix.every(Number.isFinite) && invertMatrix(matrix)) return matrix;
    }
    if (viewBox && Number(rotation || 0) % 360 === 0) {
      return [1, 0, 0, -1, -viewBox[0], viewBox[3]];
    }
    return null;
  }

  function viewportSignature(viewport) {
    if (!viewport) return "";
    return JSON.stringify({
      transform: viewportMatrix(viewport),
      scale: viewportScale(viewport),
      rotation: ((Number(viewport.rotation || 0) % 360) + 360) % 360,
      width: Number(viewport.width || 0),
      height: Number(viewport.height || 0),
      viewBox: copyViewBox(viewport.viewBox)
    });
  }

  function copyProjection(value, cacheHit = false) {
    if (!value) return null;
    return {
      ...value,
      pdfRect: value.pdfRect?.slice?.() || null,
      unitRect: value.unitRect?.slice?.() || null,
      pixelRect: value.pixelRect?.slice?.() || null,
      cacheHit
    };
  }

  const FLOW_METADATA_KEYS = [
    "flowID", "flowId", "flowKey", "textFlowID", "textFlowId", "textFlow", "flow"
  ];
  const LINE_METADATA_KEYS = [
    "lineID", "lineId", "sourceLineID", "sourceLineId", "lineKey", "lineIndex"
  ];

  function normalizeMetadataID(value) {
    if (value === null || value === undefined || typeof value === "object") return null;
    const result = String(value).trim();
    return result && !["null", "undefined"].includes(result.toLowerCase()) ? result : null;
  }

  function metadataID(value, keys) {
    for (const key of keys || []) {
      const result = normalizeMetadataID(value?.[key]);
      if (result) return result;
    }
    return null;
  }

  function metadataIDs(values, keys) {
    const result = [];
    for (const value of values || []) {
      const id = metadataID(value, keys);
      if (id && !result.includes(id)) result.push(id);
    }
    return result;
  }

  function normalizeIDList(values) {
    return (Array.isArray(values) ? values : [])
      .map(normalizeMetadataID).filter(Boolean);
  }

  function uniqueNumbers(values) {
    const result = [];
    for (const value of values || []) {
      const number = Number(value);
      if (Number.isInteger(number) && !result.includes(number)) result.push(number);
    }
    return result;
  }

  function selectionLayoutResult(supported, reason, pageIndexes = [], flowIDs = [], lineIDs = []) {
    return {
      supported: Boolean(supported),
      reason,
      pageIndexes: uniqueNumbers(pageIndexes),
      flowIDs: [...new Set((flowIDs || []).map(normalizeMetadataID).filter(Boolean))],
      lineIDs: [...new Set((lineIDs || []).map(normalizeMetadataID).filter(Boolean))]
    };
  }

  function projectionFailure(pageIndex, pdfRect, failureReason, diagnostics = {}) {
    return {
      valid: false,
      pending: ["page-unavailable", "viewport-unavailable"].includes(failureReason),
      pageIndex: Number(pageIndex),
      pdfRect: copyRect(pdfRect),
      unitRect: null,
      pixelRect: null,
      scale: 0,
      viewportSignature: "",
      roundTripError: Infinity,
      failureReason,
      diagnostics
    };
  }

  function positionFragments(position) {
    const fragments = Array.isArray(position?.fragments)
      ? position.fragments.map(fragment => ({
        pageIndex: Number(fragment?.pageIndex ?? position?.pageIndex ?? 0),
        flowID: normalizeMetadataID(fragment?.flowID),
        rects: (fragment?.rects || []).map(copyRect).filter(Boolean),
        lineIDs: normalizeIDList(fragment?.lineIDs),
        lineCharCounts: [...(fragment?.lineCharCounts || [])].map(Number)
      })).filter(fragment => fragment.rects.length)
      : [];
    if (!fragments.length) {
      const first = (position?.rects || []).map(copyRect).filter(Boolean);
      if (first.length) fragments.push({
        pageIndex: Number(position?.pageIndex || 0), flowID: null,
        rects: first, lineIDs: [], lineCharCounts: []
      });
      const next = (position?.nextPageRects || []).map(copyRect).filter(Boolean);
      if (next.length) fragments.push({
        pageIndex: Number(position?.pageIndex || 0) + 1, flowID: null,
        rects: next, lineIDs: [], lineCharCounts: []
      });
    }
    return fragments;
  }

  function positionV2(position, fragments = null) {
    const values = fragments || positionFragments(position);
    if (!values.length) return null;
    return {
      version: 2,
      coordinateSpace: "pdf",
      pageIndex: values[0].pageIndex,
      rects: values[0].rects.map(rect => rect.slice()),
      fragments: values.map(fragment => ({
        pageIndex: fragment.pageIndex,
        flowID: normalizeMetadataID(fragment.flowID),
        rects: fragment.rects.map(rect => rect.slice()),
        lineIDs: normalizeIDList(fragment.lineIDs),
        lineCharCounts: [...(fragment.lineCharCounts || [])]
      }))
    };
  }

  function getApplication(view) {
    return view?._iframeWindow?.PDFViewerApplication || null;
  }

  function getPageCount(view) {
    const application = getApplication(view);
    return Math.max(
      Number(application?.pdfDocument?.numPages || 0),
      Number(application?.pdfViewer?._pages?.length || 0)
    );
  }

  function stateFor(view) {
    const application = getApplication(view);
    const pdfDocument = application?.pdfDocument;
    if (!view || !pdfDocument) throw new Error("PDF 视图尚未完成初始化");
    const pageCount = getPageCount(view);
    let state = states.get(view);
    if (!state || state.pdfDocument !== pdfDocument || state.pageCount !== pageCount) {
      state = {
        pdfDocument,
        pageCount,
        pages: new Map(),
        projections: new Map(),
        projectionSignatures: new Map()
      };
      states.set(view, state);
    }
    return state;
  }

  function hasPageViewport(view, pageIndex) {
    const index = Number(pageIndex);
    const pageView = getApplication(view)?.pdfViewer?._pages?.[index] || null;
    return Boolean(Number.isInteger(index) && index >= 0 && pageView?.viewport);
  }

  function projectRect({ view, pageIndex, pdfRect }) {
    const index = Number(pageIndex);
    const sourceRect = copyRect(pdfRect);
    if (!Number.isInteger(index) || index < 0) {
      return projectionFailure(index, pdfRect, "page-index-invalid");
    }
    if (!sourceRect) return projectionFailure(index, pdfRect, "pdf-rect-invalid");
    let state;
    try { state = stateFor(view); }
    catch (_) { return projectionFailure(index, sourceRect, "page-unavailable"); }
    if (index >= state.pageCount) {
      return projectionFailure(index, sourceRect, "page-index-out-of-range");
    }
    const pageView = getApplication(view)?.pdfViewer?._pages?.[index] || null;
    if (!pageView?.div) return projectionFailure(index, sourceRect, "page-unavailable");
    const viewport = pageView.viewport || null;
    if (!viewport) return projectionFailure(index, sourceRect, "viewport-unavailable");
    const signature = viewportSignature(viewport);
    if (!signature) return projectionFailure(index, sourceRect, "viewport-invalid");
    if (state.projectionSignatures.get(index) !== signature) {
      state.projectionSignatures.set(index, signature);
      for (const key of [...state.projections.keys()]) {
        if (key.startsWith(`${index}:`)) state.projections.delete(key);
      }
    }
    const cacheKey = `${index}:${signature}:${sourceRect.join(",")}`;
    const cached = state.projections.get(cacheKey);
    if (cached) return copyProjection(cached, true);
    const scale = viewportScale(viewport);
    const pixelMatrix = viewportMatrix(viewport);
    const unitMatrix = normalizedViewportMatrix(viewport,
      copyViewBox(viewport.viewBox), viewport.rotation);
    const inverse = invertMatrix(pixelMatrix);
    if (!(scale > 0) || !pixelMatrix || !unitMatrix || !inverse) {
      return projectionFailure(index, sourceRect, "viewport-transform-invalid",
        { signature });
    }
    let pixelRect = transformRect(pixelMatrix, sourceRect);
    let unitRect = transformRect(unitMatrix, sourceRect);
    if (!pixelRect || !unitRect) {
      return projectionFailure(index, sourceRect, "projection-invalid", { signature });
    }
    let roundTrip = null;
    if (typeof viewport.convertToPdfPoint === "function") {
      try {
        const points = [
          viewport.convertToPdfPoint(pixelRect[0], pixelRect[1]),
          viewport.convertToPdfPoint(pixelRect[0], pixelRect[3]),
          viewport.convertToPdfPoint(pixelRect[2], pixelRect[1]),
          viewport.convertToPdfPoint(pixelRect[2], pixelRect[3])
        ].map(point => point.map(Number));
        roundTrip = [
          Math.min(...points.map(point => point[0])),
          Math.min(...points.map(point => point[1])),
          Math.max(...points.map(point => point[0])),
          Math.max(...points.map(point => point[1]))
        ];
      }
      catch (_) {}
    }
    roundTrip ||= transformRect(inverse, pixelRect);
    const roundTripError = roundTrip
      ? Math.max(...sourceRect.map((value, offset) => Math.abs(value - roundTrip[offset])))
      : Infinity;
    if (!Number.isFinite(roundTripError) || roundTripError > 0.5) {
      return projectionFailure(index, sourceRect, "round-trip-error",
        { signature, roundTripError });
    }
    const width = Number(viewport.width || 0);
    const height = Number(viewport.height || 0);
    if (!(width > 0) || !(height > 0)) {
      return projectionFailure(index, sourceRect, "viewport-bounds-invalid", { signature });
    }
    const tolerance = 1;
    if (pixelRect[0] < -tolerance || pixelRect[1] < -tolerance
      || pixelRect[2] > width + tolerance || pixelRect[3] > height + tolerance) {
      return projectionFailure(index, sourceRect, "projection-out-of-bounds", {
        signature, pageBounds: [0, 0, width, height], pixelRect: pixelRect.slice()
      });
    }
    pixelRect = [
      Math.max(0, pixelRect[0]), Math.max(0, pixelRect[1]),
      Math.min(width, pixelRect[2]), Math.min(height, pixelRect[3])
    ];
    unitRect = pixelRect.map(value => value / scale);
    if (!(pixelRect[2] > pixelRect[0] && pixelRect[3] > pixelRect[1]
      && unitRect[2] > unitRect[0] && unitRect[3] > unitRect[1])) {
      return projectionFailure(index, sourceRect, "projection-degenerate", { signature });
    }
    const result = {
      valid: true,
      pending: false,
      pageIndex: index,
      pdfRect: sourceRect,
      unitRect,
      pixelRect,
      scale,
      viewportSignature: signature,
      roundTripError,
      failureReason: "",
      diagnostics: { pageBounds: [0, 0, width, height] }
    };
    state.projections.set(cacheKey, result);
    return copyProjection(result, false);
  }

  function clearProjection(view, pageIndex = null) {
    const state = states.get(view);
    if (!state) return;
    if (pageIndex === null || pageIndex === undefined) {
      state.projections?.clear?.();
      state.projectionSignatures?.clear?.();
      return;
    }
    const index = Number(pageIndex);
    state.projectionSignatures?.delete?.(index);
    for (const key of [...(state.projections?.keys?.() || [])]) {
      if (key.startsWith(`${index}:`)) state.projections.delete(key);
    }
  }

  async function readPage(view, pageIndex) {
    const state = stateFor(view);
    const application = getApplication(view);
    if (!(pageIndex >= 0 && pageIndex < state.pageCount)) {
      throw new Error(`PDF 页码越界：${pageIndex}`);
    }
    const pageView = application?.pdfViewer?._pages?.[pageIndex] || null;
    const viewport = pageView?.viewport || null;
    const viewportViewBox = copyViewBox(viewport?.viewBox);
    const viewportRotation = ((Number(viewport?.rotation || 0) % 360) + 360) % 360;
    const viewportSignature = JSON.stringify({
      rotation: viewportRotation,
      viewBox: viewportViewBox,
      matrix: normalizedViewportMatrix(viewport, viewportViewBox, viewportRotation)
    });
    const cached = state.pages.get(pageIndex);
    if (cached?.viewportSignature === viewportSignature) return cached;
    state.pages.delete(pageIndex);
    let request = { pageIndex };
    try { request = Components.utils.cloneInto(request, view._iframeWindow); }
    catch (_) {}
    const foreignPage = await state.pdfDocument.getPageData(request);
    if (!foreignPage?.chars) throw new Error(`第 ${pageIndex + 1} 页没有字符数据`);
    const viewBox = copyViewBox(foreignPage.viewBox) || copyViewBox(viewport?.viewBox);
    if (!viewBox) throw new Error(`第 ${pageIndex + 1} 页 viewBox 无效`);
    const rotation = ((Number(viewport?.rotation || 0) % 360) + 360) % 360;
    const matrix = normalizedViewportMatrix(viewport, viewBox, rotation);
    const inverse = invertMatrix(matrix);
    const layoutBounds = matrix ? transformRect(matrix, viewBox) : null;
    const diagnostics = {
      pageIndex,
      coordinateValid: Boolean(matrix && inverse && layoutBounds),
      invalidCharacterCount: 0,
      roundTripMaximumError: 0,
      rotation
    };
    const chars = [];
    for (let offset = 0; offset < foreignPage.chars.length; offset++) {
      const foreign = foreignPage.chars[offset];
      if (!foreign) continue;
      const pdfRect = copyRect(foreign.inlineRect || foreign.rect);
      const layoutRect = transformRect(matrix, pdfRect);
      if (!pdfRect || !layoutRect) {
        diagnostics.invalidCharacterCount++;
        continue;
      }
      const roundTrip = transformRect(inverse, layoutRect);
      if (!roundTrip) {
        diagnostics.invalidCharacterCount++;
        continue;
      }
      const error = Math.max(...pdfRect.map((value, index) => Math.abs(value - roundTrip[index])));
      diagnostics.roundTripMaximumError = Math.max(diagnostics.roundTripMaximumError, error);
      chars.push({
        id: `${pageIndex}:char:${offset}`,
        offset,
        pageIndex,
        c: String(foreign.c || ""),
        rect: pdfRect,
        pdfRect,
        viewportRect: layoutRect,
        layoutRect,
        lineBreakAfter: !!foreign.lineBreakAfter,
        paragraphBreakAfter: !!foreign.paragraphBreakAfter,
        spaceAfter: !!foreign.spaceAfter,
        ignorable: !!foreign.ignorable,
        rotation: Number(foreign.rotation || 0),
        fontName: String(foreign.fontName || ""),
        flowID: metadataID(foreign, FLOW_METADATA_KEYS),
        lineID: metadataID(foreign, LINE_METADATA_KEYS)
      });
    }
    diagnostics.coordinateValid = diagnostics.coordinateValid
      && diagnostics.roundTripMaximumError <= 0.5
      && chars.length > 0;
    const page = {
      pageIndex,
      chars,
      lines: Array.isArray(foreignPage.lines) ? foreignPage.lines : [],
      flowID: metadataID(foreignPage, FLOW_METADATA_KEYS),
      viewBox,
      metric: {
        pageIndex,
        width: layoutBounds ? layoutBounds[2] - layoutBounds[0] : 0,
        height: layoutBounds ? layoutBounds[3] - layoutBounds[1] : 0,
        rotation,
        viewBox
      },
      geometry: { matrix, inverse, layoutBounds, diagnostics }
    };
    page.viewportSignature = viewportSignature;
    state.pages.set(pageIndex, page);
    return page;
  }

  async function loadIndexes(view, pageIndexes) {
    const pages = [];
    for (const pageIndex of [...new Set(pageIndexes || [])]
      .map(Number).filter(Number.isInteger).sort((left, right) => left - right)) {
      pages.push(await readPage(view, pageIndex));
    }
    return pages;
  }

  function collectionValue(collection, index) {
    if (!collection) return null;
    try {
      if (typeof collection.get === "function") return collection.get(index) || null;
      return collection[index] || null;
    }
    catch (_) {
      return null;
    }
  }

  function pageDataFor(view, pageIndex) {
    const state = states.get(view);
    const application = getApplication(view);
    const pdfViewer = application?.pdfViewer;
    return state?.pages?.get?.(pageIndex)
      || collectionValue(view?._pdfPages, pageIndex)
      || collectionValue(view?._internalReader?._pdfPages, pageIndex)
      || collectionValue(pdfViewer?._pdfPages, pageIndex)
      || collectionValue(pdfViewer?._pageData, pageIndex)
      || null;
  }

  function rectangleIntersectionArea(left, right) {
    const a = copyRect(left);
    const b = copyRect(right);
    if (!a || !b) return 0;
    const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function rectangleArea(rect) {
    const value = copyRect(rect);
    return value ? Math.max(1, value[2] - value[0])
      * Math.max(1, value[3] - value[1]) : 0;
  }

  function resolveLineChars(line, pageChars) {
    const values = Array.isArray(line?.chars) ? line.chars : [];
    return values.map(value => typeof value === "number"
      ? pageChars?.[value] : value).filter(Boolean);
  }

  function consistentMetadataID(values, keys) {
    let id = null;
    for (const value of values || []) {
      const candidate = metadataID(value, keys);
      if (!candidate) continue;
      if (id && id !== candidate) return { id: null, conflict: true };
      id = candidate;
    }
    return { id, conflict: false };
  }

  function lineRecord(pageIndex, index, line, chars, pageFlowID = null) {
    const charLine = consistentMetadataID(chars, LINE_METADATA_KEYS);
    const charFlow = consistentMetadataID(chars, FLOW_METADATA_KEYS);
    const lineID = metadataID(line, [...LINE_METADATA_KEYS, "id"])
      || charLine.id
      || `${pageIndex}:selection-line:${index}`;
    const lineFlow = metadataID(line, FLOW_METADATA_KEYS);
    const rect = copyRect(line?.rect || line?.bbox || line?.bounds)
      || boundingRect(chars.map(char => char?.pdfRect || char?.rect));
    return {
      id: lineID,
      flowID: lineFlow || charFlow.id || pageFlowID || null,
      flowConflict: charFlow.conflict
        || Boolean(lineFlow && charFlow.id && lineFlow !== charFlow.id),
      lineConflict: charLine.conflict,
      rect,
      order: index
    };
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

  function pageLineRecords(page, pageIndex) {
    const pageChars = Array.isArray(page?.chars) ? page.chars : [];
    const rawLines = Array.isArray(page?.lines) ? page.lines : [];
    const pageFlowID = metadataID(page, FLOW_METADATA_KEYS);
    if (rawLines.length) {
      const records = rawLines.map((line, index) => lineRecord(pageIndex, index, line,
        resolveLineChars(line, pageChars), pageFlowID)).filter(record => record.rect);
      if (records.length) return records.map((record, index) => ({ ...record, order: index }));
    }
    if (!pageChars.length) return [];

    const groups = [];
    let current = null;
    const finish = () => {
      if (current?.chars?.length) groups.push(current);
      current = null;
    };
    for (const char of pageChars) {
      if (!char) continue;
      const lineID = metadataID(char, LINE_METADATA_KEYS);
      const flowID = metadataID(char, FLOW_METADATA_KEYS);
      const key = lineID ? `${flowID || ""}\u0000${lineID}` : null;
      if (!current || (key && current.key !== key)
        || (!key && current.explicitLineID)) {
        finish();
        current = { key, explicitLineID: Boolean(lineID), chars: [] };
      }
      current.chars.push(char);
      if (!lineID && (char.lineBreakAfter || char.hasEOL || char.eol)) finish();
    }
    finish();
    return groups.map((group, index) => lineRecord(pageIndex, index, null, group.chars,
      pageFlowID))
      .filter(record => record.rect);
  }

  function matchRectToLine(rect, records, usedIndexes) {
    const selectedArea = rectangleArea(rect);
    if (!(selectedArea > 0)) return null;
    const candidates = [];
    for (let index = 0; index < records.length; index++) {
      if (usedIndexes.has(index)) continue;
      const lineRect = records[index].rect;
      const intersection = rectangleIntersectionArea(rect, lineRect);
      if (!(intersection > 0)) continue;
      const lineArea = rectangleArea(lineRect);
      const overlap = intersection / Math.max(1, Math.min(selectedArea, lineArea));
      const vertical = Math.max(0, Math.min(rect[3], lineRect[3])
        - Math.max(rect[1], lineRect[1])) / Math.max(1, Math.min(
          rect[3] - rect[1], lineRect[3] - lineRect[1]));
      const horizontal = Math.max(0, Math.min(rect[2], lineRect[2])
        - Math.max(rect[0], lineRect[0])) / Math.max(1, Math.min(
          rect[2] - rect[0], lineRect[2] - lineRect[0]));
      candidates.push({ index, score: overlap * 0.65 + vertical * 0.25 + horizontal * 0.10,
        overlap, vertical, horizontal });
    }
    candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    const best = candidates[0];
    const next = candidates[1];
    if (!best || best.overlap < 0.20 || best.vertical < 0.35
      || (next && next.overlap >= 0.20 && Math.abs(best.score - next.score) < 0.04)) {
      return null;
    }
    return best.index;
  }

  function classifySelectionLayout({ view = null, position = null } = {}) {
    const rawFragments = Array.isArray(position?.fragments) ? position.fragments : null;
    const hasTopLevelPageIndex = position?.pageIndex !== null
      && position?.pageIndex !== undefined && String(position.pageIndex).trim() !== "";
    const fragmentsHavePageIndexes = rawFragments?.length
      ? rawFragments.every(fragment => fragment?.pageIndex !== null
        && fragment?.pageIndex !== undefined && String(fragment.pageIndex).trim() !== "")
      : true;
    const malformedRawFragment = Boolean(rawFragments?.length && rawFragments.some(fragment => {
      if (!fragment || !Array.isArray(fragment.rects)) return true;
      return fragment.rects.length > 0
        && fragment.rects.map(copyRect).filter(Boolean).length !== fragment.rects.length;
    }));
    const hasAnyPageIndex = hasTopLevelPageIndex
      || Boolean(rawFragments?.length && fragmentsHavePageIndexes);
    if (!hasAnyPageIndex || malformedRawFragment) {
      return selectionLayoutResult(false, "invalid");
    }
    const fragments = positionFragments(position);
    const pageIndexes = fragments.map(fragment => fragment.pageIndex);
    const flowIDs = metadataIDs(fragments, ["flowID"]);
    const lineIDs = fragments.flatMap(fragment => fragment.lineIDs || []);
    if (!fragments.length || pageIndexes.some(index => !Number.isInteger(index) || index < 0)) {
      return selectionLayoutResult(false, "invalid", pageIndexes, flowIDs, lineIDs);
    }
    const uniquePageIndexes = uniqueNumbers(pageIndexes);
    if (uniquePageIndexes.length > 1) {
      return selectionLayoutResult(false, "cross-page", uniquePageIndexes, flowIDs, lineIDs);
    }
    const pageIndex = uniquePageIndexes[0];
    const pageCount = getPageCount(view);
    if (pageCount > 0 && pageIndex >= pageCount) {
      return selectionLayoutResult(false, "invalid", uniquePageIndexes, flowIDs, lineIDs);
    }
    if (flowIDs.length > 1) {
      return selectionLayoutResult(false, "cross-column", uniquePageIndexes, flowIDs, lineIDs);
    }

    const page = pageDataFor(view, pageIndex);
    const records = pageLineRecords(page, pageIndex);
    const recordByID = new Map(records.map(record => [record.id, record]));
    const selected = [];
    const usedRecordIndexes = new Set();
    let hasExplicitLineIDs = false;
    for (const fragment of fragments) {
      const fragmentLineIDs = fragment.lineIDs || [];
      if (fragmentLineIDs.length && fragmentLineIDs.length !== fragment.rects.length) {
        return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes, flowIDs, lineIDs);
      }
      if (fragmentLineIDs.length) {
        hasExplicitLineIDs = true;
        for (let index = 0; index < fragment.rects.length; index++) {
          const id = normalizeMetadataID(fragmentLineIDs[index]);
          if (!id) return selectionLayoutResult(false, "layout-unknown",
            uniquePageIndexes, flowIDs, lineIDs);
          const record = records.length ? recordByID.get(id) : null;
          if (records.length && !record) {
            return selectionLayoutResult(false, "layout-unknown",
              uniquePageIndexes, flowIDs, lineIDs);
          }
          selected.push({ id, rect: fragment.rects[index], record,
            fragmentFlowID: fragment.flowID });
        }
        continue;
      }
      if (!records.length) {
        return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes, flowIDs, lineIDs);
      }
      for (const rect of fragment.rects) {
        const recordIndex = matchRectToLine(rect, records, usedRecordIndexes);
        if (recordIndex === null) {
          return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes, flowIDs, lineIDs);
        }
        usedRecordIndexes.add(recordIndex);
        const record = records[recordIndex];
        selected.push({ id: record.id, rect, record, fragmentFlowID: fragment.flowID });
      }
    }
    if (!selected.length) {
      return selectionLayoutResult(false, "invalid", uniquePageIndexes, flowIDs, lineIDs);
    }

    const selectedLineIDs = selected.map(value => value.id);
    if (new Set(selectedLineIDs).size !== selectedLineIDs.length) {
      return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes,
        flowIDs, selectedLineIDs);
    }
    const selectedFlowIDs = [];
    for (const value of selected) {
      const lineFlowID = value.record?.flowConflict ? null : value.record?.flowID;
      const fragmentFlowID = normalizeMetadataID(value.fragmentFlowID);
      if (fragmentFlowID && lineFlowID && fragmentFlowID !== lineFlowID) {
        return selectionLayoutResult(false, "cross-column", uniquePageIndexes,
          [...flowIDs, lineFlowID], selectedLineIDs);
      }
      const flowID = fragmentFlowID || lineFlowID;
      if (!flowID || value.record?.flowConflict || value.record?.lineConflict) {
        return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes,
          selectedFlowIDs, selectedLineIDs);
      }
      if (!selectedFlowIDs.includes(flowID)) selectedFlowIDs.push(flowID);
    }
    if (selectedFlowIDs.length > 1) {
      return selectionLayoutResult(false, "cross-column", uniquePageIndexes,
        selectedFlowIDs, selectedLineIDs);
    }

    if (records.length) {
      const selectedIndexes = selected.map(value => value.record?.order);
      if (selectedIndexes.some(index => !Number.isInteger(index))) {
        return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes,
          selectedFlowIDs, selectedLineIDs);
      }
      for (let index = 1; index < selectedIndexes.length; index++) {
        if (selectedIndexes[index] <= selectedIndexes[index - 1]
          || selectedIndexes[index] !== selectedIndexes[index - 1] + 1) {
          return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes,
            selectedFlowIDs, selectedLineIDs);
        }
      }
      const first = selectedIndexes[0];
      const last = selectedIndexes[selectedIndexes.length - 1];
      for (let index = first; index <= last; index++) {
        const record = records[index];
        if (!record || record.flowConflict || record.lineConflict
          || record.flowID !== selectedFlowIDs[0]) {
          return selectionLayoutResult(false,
            record?.flowID && record.flowID !== selectedFlowIDs[0]
              ? "cross-column" : "layout-unknown",
            uniquePageIndexes, selectedFlowIDs, selectedLineIDs);
        }
      }
    }

    // If the caller supplied line IDs and no page text index is available, the
    // position itself is the only reliable text-flow order we have. It is
    // still safe to accept it because flow and line metadata were explicit.
    if (!records.length && (!hasExplicitLineIDs || !selectedFlowIDs.length)) {
      return selectionLayoutResult(false, "layout-unknown", uniquePageIndexes,
        selectedFlowIDs, selectedLineIDs);
    }
    return selectionLayoutResult(true, "supported", uniquePageIndexes,
      selectedFlowIDs, selectedLineIDs);
  }

  function selectionPageIndexes(position, pageCount) {
    return [...new Set(positionFragments(position).map(fragment => fragment.pageIndex))]
      .filter(index => index >= 0 && index < pageCount)
      .sort((left, right) => left - right);
  }

  global.ReaderPageTextIndex = {
    getPageCount,
    loadPage: readPage,
    loadIndexes,
    selectionPageIndexes,
    classifySelectionLayout,
    positionFragments,
    positionV2,
    hasPageViewport,
    projectRect,
    clearProjection,
    transformRect,
    invertMatrix,
    clear(view) { if (view) states.delete(view); },
    _test: {
      copyRect,
      applyMatrix,
      viewportMatrix,
      viewportSignature,
      normalizedViewportMatrix,
      viewportScale
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
