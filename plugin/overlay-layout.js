(function (global) {
  "use strict";

  const {
    PARAGRAPH_TRANSLATION_INDENT,
    boundingRect,
    positionFragments
  } = global.TranslatorCore;

  const TranslatorOverlayLayout = {
    selectionBlockParts(state, position) {
      const byPage = new Map();
      const diagnostics = { pages: [], projections: [], failureReasons: [] };
      for (const fragment of positionFragments(position)) {
        const pageIndex = Number(fragment.pageIndex || 0);
        if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
        for (const pdfRect of fragment.rects || []) {
          const projection = this.projectRect(state, pdfRect, pageIndex,
            { ignorePageFilter: true });
          diagnostics.projections.push({
            pageIndex,
            pdfRect: Array.isArray(pdfRect) ? pdfRect.slice() : pdfRect,
            valid: Boolean(projection?.valid),
            pending: Boolean(projection?.pending),
            pixelRect: projection?.pixelRect?.slice?.() || null,
            unitRect: projection?.unitRect?.slice?.() || null,
            viewportSignature: projection?.viewportSignature || "",
            roundTripError: Number(projection?.roundTripError),
            failureReason: projection?.failureReason || "projection-unavailable"
          });
          if (!projection?.valid) {
            diagnostics.failureReasons.push(projection?.failureReason || "projection-unavailable");
            continue;
          }
          byPage.get(pageIndex).push(projection);
        }
      }
      const failed = diagnostics.projections.filter(value => !value.valid);
      if (failed.length || !diagnostics.projections.length) {
        const pending = failed.length > 0 && failed.every(value => value.pending);
        return {
          status: pending ? "geometry-pending" : "geometry-invalid",
          parts: [],
          diagnostics
        };
      }
      const parts = [];
      for (const [pageIndex, projections] of [...byPage.entries()]
        .sort((left, right) => left[0] - right[0])) {
        if (!projections.length) continue;
        diagnostics.pages.push(pageIndex);
        const queues = new Map();
        for (const projection of projections) {
          const key = projection.pixelRect.join(",");
          if (!queues.has(key)) queues.set(key, []);
          queues.get(key).push(projection);
        }
        const groups = ReaderSelectionBlock.groupRects(
          projections.map(projection => projection.pixelRect));
        for (const group of groups) {
          const members = [];
          for (const pixelRect of group.rects) {
            const queue = queues.get(pixelRect.join(","));
            const projection = queue?.shift?.();
            if (projection) members.push(projection);
          }
          const rect = boundingRect(members.map(value => value.pixelRect));
          const unitRect = boundingRect(members.map(value => value.unitRect));
          if (!rect || !unitRect || members.length !== group.rects.length) {
            diagnostics.failureReasons.push("projection-group-mismatch");
            return { status: "geometry-invalid", parts: [], diagnostics };
          }
          parts.push({
            pageIndex,
            column: group.column,
            rect,
            unitRect,
            sourceRects: members.map(value => value.pixelRect.slice()),
            sourcePdfRects: members.map(value => value.pdfRect.slice()),
            viewportSignature: members[0].viewportSignature,
            scale: members[0].scale,
            sourceCharCount: 0
          });
        }
      }
      if (!parts.length) {
        diagnostics.failureReasons.push("position-empty");
        return { status: "geometry-invalid", parts: [], diagnostics };
      }
      return { status: "ready", parts, diagnostics };
    },

    measureSelectionFlowPrefix(state, part, chars, length, fontSize, lineHeight) {
      const layer = this.ensureLayer(state, part.pageIndex);
      if (!layer || length <= 0) return { fits: false };
      const node = layer.ownerDocument.createElement("div");
      const width = Math.max(1, part.rect[2] - part.rect[0]);
      const height = Math.max(1, part.rect[3] - part.rect[1]);
      node.textContent = chars.slice(0, length).join("");
      this.style(node, {
        position: "absolute", left: "-100000px", top: "0", width: `${width}px`,
        height: "auto", boxSizing: "border-box", padding: "3px 4px",
        whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "normal",
        fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
        visibility: "hidden", pointerEvents: "none"
      });
      layer.append(node);
      const measured = this.measureTextLayout({
        node, containerWidth: width, containerHeight: height,
        fontSize, lineHeight, mode: "block"
      });
      node.remove?.();
      return measured;
    },

    selectionGraphemes(text) {
      const value = String(text || "");
      try {
        if (typeof Intl?.Segmenter === "function") {
          return [...new Intl.Segmenter(undefined, { granularity: "grapheme" })
            .segment(value)].map(entry => entry.segment);
        }
      }
      catch (_) {}
      return [...value];
    },

    selectionBreakIndex(chars, target, minimum, maximum) {
      const low = Math.max(1, Number(minimum || 1));
      const high = Math.min(chars.length - 1, Number(maximum || chars.length - 1));
      if (high < low) return Math.max(0, Math.min(chars.length, target));
      const radius = Math.max(6, Math.round(chars.length * 0.08));
      const start = Math.max(low, target - radius);
      const end = Math.min(high, target + radius);
      const candidates = [];
      for (let index = start; index <= end; index++) {
        const left = chars[index - 1] || "";
        const previous = chars[index - 2] || "";
        const right = chars[index] || "";
        let priority = 5;
        if (previous === "\n" && left === "\n") priority = 0;
        else if (/[.!?。！？]/u.test(left)) priority = 1;
        else if (/[;；:：]/u.test(left)) priority = 2;
        else if (/[,，、]/u.test(left)) priority = 3;
        else if (/\s/u.test(left) || /\s/u.test(right)) priority = 4;
        candidates.push({ index, priority, distance: Math.abs(index - target) });
      }
      candidates.sort((left, right) => left.priority - right.priority
        || left.distance - right.distance || left.index - right.index);
      return candidates[0]?.index || Math.max(low, Math.min(high, target));
    },

    allocateSelectionChunks(parts, text) {
      const chars = this.selectionGraphemes(text);
      if (!parts.length) return [];
      if (!chars.length) return parts.map(() => "");
      const weights = parts.map(part => {
        const rect = part?.rect || [0, 0, 1, 1];
        return Math.max(1, rect[2] - rect[0] - 8)
          * Math.max(1, rect[3] - rect[1] - 6);
      });
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      const chunks = [];
      let offset = 0;
      let cumulativeWeight = 0;
      for (let index = 0; index < parts.length - 1; index++) {
        cumulativeWeight += weights[index];
        const remainingParts = parts.length - index - 1;
        const minimum = offset + 1;
        const maximum = chars.length - remainingParts;
        if (maximum < minimum) {
          chunks.push(offset < chars.length ? chars[offset++] : "");
          continue;
        }
        const target = Math.max(minimum, Math.min(maximum,
          Math.round(chars.length * cumulativeWeight / Math.max(1, totalWeight))));
        const boundary = this.selectionBreakIndex(chars, target, minimum, maximum);
        chunks.push(chars.slice(offset, boundary).join(""));
        offset = boundary;
      }
      chunks.push(chars.slice(offset).join(""));
      while (chunks.length < parts.length) chunks.push("");
      return chunks;
    },

    fitSelectionFlowBlock(state, part, text) {
      const chars = this.selectionGraphemes(text);
      if (!chars.length) return { rendered: true, fontSize: 0, lineHeight: 1.05,
        verticalUsage: 0, minimumFontSize: 0, failureReason: "" };
      const heights = (part.sourceRects || []).map(rect => Math.max(1, rect[3] - rect[1]))
        .sort((left, right) => left - right);
      const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
      const minimum = Math.max(6, Math.min(56, medianHeight * 0.55));
      const maximum = Math.max(minimum, Math.min(56, medianHeight * 1.8));
      const rect = part.rect || [0, 0, 1, 1];
      const availableHeight = Math.max(1, rect[3] - rect[1] - 6);
      const signature = ["selection-flow-v4", part.viewportSignature || "",
        rect.map(value => Number(value).toFixed(2)).join(","),
        (part.sourceRects || []).map(value => value.map(number =>
          Number(number).toFixed(2)).join(",")).join(";"), text].join("|");
      const cached = state?.selectionLayoutCache?.get?.(signature);
      if (cached) return { ...cached, cacheHit: true, measureCount: 0 };
      let measureCount = 0;
      const measure = (fontSize, lineHeight) => {
        measureCount++;
        return this.measureSelectionFlowPrefix(state, part, chars, chars.length,
          fontSize, lineHeight);
      };
      const minimumMeasure = measure(minimum, 1.05);
      if (!minimumMeasure.fits) return { rendered: false, fontSize: minimum,
        lineHeight: 1.05, verticalUsage: 0, minimumFontSize: minimum,
        failureReason: "minimum-font-overflow", measureCount };
      let low = minimum;
      let high = maximum;
      for (let iteration = 0; iteration < 8; iteration++) {
        const middle = (low + high) / 2;
        if (measure(middle, 1.05).fits) low = middle;
        else high = middle;
      }
      const maximumFittingFont = low;
      const fonts = [...new Set([minimum, medianHeight, maximumFittingFont * 0.78,
        maximumFittingFont * 0.9, maximumFittingFont].map(value =>
        Number(Math.max(minimum, Math.min(maximumFittingFont, value)).toFixed(3))))]
        .sort((left, right) => left - right);
      const candidates = [];
      for (const fontSize of fonts) {
        const compact = measure(fontSize, 1.05);
        if (!compact.fits) continue;
        let lineLow = 1.05;
        let lineHigh = 2.4;
        for (let iteration = 0; iteration < 7; iteration++) {
          const middle = (lineLow + lineHigh) / 2;
          const probe = measure(fontSize, middle);
          const probeUsage = Number(probe.contentHeight || 0) / availableHeight;
          if (probe.fits && (!probe.contentHeight || probeUsage <= 0.94)) lineLow = middle;
          else lineHigh = middle;
        }
        const measured = measure(fontSize, lineLow);
        const contentHeight = Number(measured.contentHeight || 0);
        const verticalUsage = contentHeight > 0
          ? Math.min(1, contentHeight / availableHeight) : 0.94;
        const score = Math.abs(verticalUsage - 0.94) * 10
          + Math.abs(fontSize - medianHeight) / Math.max(1, medianHeight) * 0.08
          + Math.abs(lineLow - 1.35) * 0.02;
        candidates.push({ rendered: true, fontSize, lineHeight: lineLow,
          verticalUsage, minimumFontSize: minimum, failureReason: "", score,
          ...measured });
      }
      candidates.sort((left, right) => left.score - right.score
        || right.verticalUsage - left.verticalUsage || right.fontSize - left.fontSize);
      const selected = candidates[0] || { rendered: true, fontSize: minimum,
        lineHeight: 1.05, verticalUsage: 0, minimumFontSize: minimum,
        failureReason: "", ...minimumMeasure };
      const result = { ...selected, fontSize: Number(selected.fontSize.toFixed(2)),
        lineHeight: Number(selected.lineHeight.toFixed(3)),
        verticalUsage: Number(selected.verticalUsage.toFixed(3)),
        measureCount, cacheHit: false };
      delete result.score;
      state?.selectionLayoutCache?.set?.(signature, { ...result });
      return result;
    },

    flowSelectionText(state, parts, text) {
      if (!parts.length) return { rendered: false, chunks: [], failureReason: "position-empty" };
      if (!String(text || "")) return {
        rendered: true, chunks: parts.map(() => ""), layouts: parts.map(() => ({
          rendered: true, fontSize: 0, lineHeight: 1.05, verticalUsage: 0 })),
        fontSize: 0, lineHeight: 1.05,
        failureReason: ""
      };
      const chunks = this.allocateSelectionChunks(parts, text);
      const layouts = [];
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        let layout = this.fitSelectionFlowBlock(state, parts[partIndex], chunks[partIndex]);
        if (!layout.rendered && partIndex < parts.length - 1) {
          const chars = this.selectionGraphemes(chunks[partIndex]);
          let low = 1;
          let high = chars.length - 1;
          let best = 0;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (this.measureSelectionFlowPrefix(state, parts[partIndex], chars, middle,
              layout.minimumFontSize || 6, 1.05).fits) {
              best = middle;
              low = middle + 1;
            }
            else high = middle - 1;
          }
          if (best > 0) {
            const boundary = this.selectionBreakIndex(chars, best, 1, best);
            const suffix = chars.slice(boundary).join("");
            chunks[partIndex] = chars.slice(0, boundary).join("");
            chunks[partIndex + 1] = suffix + chunks[partIndex + 1];
            layout = this.fitSelectionFlowBlock(state, parts[partIndex], chunks[partIndex]);
          }
        }
        if (!layout.rendered) return {
          rendered: false, chunks: parts.map(() => ""), layouts: [],
          fontSize: Number(layout.fontSize || 0), lineHeight: Number(layout.lineHeight || 1.05),
          failureReason: layout.failureReason || "minimum-font-overflow"
        };
        layouts.push(layout);
      }
      return {
        rendered: true, chunks, layouts,
        fontSize: Number(layouts[0]?.fontSize || 0),
        lineHeight: Number(layouts[0]?.lineHeight || 1.05), failureReason: "",
        distribution: parts.map((part, index) => ({ pageIndex: part.pageIndex,
          chunkLength: this.selectionGraphemes(chunks[index]).length,
          area: Math.max(1, part.rect[2] - part.rect[0] - 8)
            * Math.max(1, part.rect[3] - part.rect[1] - 6),
          verticalUsage: layouts[index]?.verticalUsage || 0 }))
      };
    },

    renderSelectionTranslations(state, record) {
      const segment = record.segments?.[0] || null;
      if (!segment) return;
      const translation = record.translations?.get?.(segment.id) || null;
      const blockLayout = this.selectionBlockParts(state,
        segment.position || record.match?.position);
      record.geometryStatus = blockLayout.status;
      record.geometryDiagnostics = blockLayout.diagnostics;
      SelectionReplacerTest.updateSelectionGeometryStatus?.(state.reader, record.recordID,
        blockLayout.status, blockLayout.diagnostics);
      const parts = blockLayout.parts;
      if (blockLayout.status !== "ready" || !parts.length) return;
      const translatedText = ["cached", "translated"].includes(translation?.status)
        ? String(translation.translatedText || "") : "";
      const flowLayout = translatedText
        ? this.flowSelectionText(state, parts, translatedText)
        : { rendered: true, chunks: parts.map(() => ""), fontSize: 0, lineHeight: 1.2,
          failureReason: "" };
      const selection = { sourceText: record.match?.sourceText || segment.sourceText,
        selectedText: record.match?.sourceText || segment.sourceText,
        matchType: "selection-block", translationIndentFirstBlock: false };
      const results = parts.map((part, partIndex) => {
        if (state.renderPageFilter !== undefined
          && Number(part.pageIndex) !== Number(state.renderPageFilter)) return null;
        return this.renderTranslatedSelectionTarget(state, part, selection, segment, 0,
          partIndex, 0, translation, flowLayout.chunks[partIndex] || "", record, flowLayout);
      }).filter(Boolean);
      record.selectionLayoutResults ||= new Map();
      record.selectionLayoutResults.set(segment.id, results);
    },

    selectionPlacement(part) {
      const rect = part?.unitRect;
      if (!Array.isArray(rect) || rect.length < 4 || !rect.every(Number.isFinite)
        || !(rect[2] > rect[0]) || !(rect[3] > rect[1])) return null;
      const css = value => Number(value.toFixed(6));
      return {
        left: `calc(${css(rect[0])}px * var(--scale-factor))`,
        top: `calc(${css(rect[1])}px * var(--scale-factor))`,
        width: `calc(${css(rect[2] - rect[0])}px * var(--scale-factor))`,
        height: `calc(${css(rect[3] - rect[1])}px * var(--scale-factor))`
      };
    },

    mergeTargetParts(parts) {
      const byPage = new Map();
      for (const part of parts || []) {
        if (!byPage.has(part.pageIndex)) byPage.set(part.pageIndex, []);
        byPage.get(part.pageIndex).push(part);
      }
      return [...byPage.entries()].sort((left, right) => left[0] - right[0])
        .map(([pageIndex, pageParts]) => ({
          pageIndex,
          rect: boundingRect(pageParts.map(part => part.rect)),
          sourceRects: pageParts.map(part => part.rect)
        })).filter(part => part.rect);
    },

    mergeTitleParts(parts) {
      const byPage = new Map();
      for (const part of parts || []) {
        if (!byPage.has(part.pageIndex)) byPage.set(part.pageIndex, []);
        byPage.get(part.pageIndex).push(part);
      }
      return [...byPage.entries()].sort((left, right) => left[0] - right[0])
        .map(([pageIndex, pageParts]) => {
          const ordered = [...pageParts].sort((left, right) => left.rect[1] - right.rect[1]);
          const anchor = [...ordered].sort((left, right) =>
            (right.rect[2] - right.rect[0]) - (left.rect[2] - left.rect[0]))[0];
          if (!anchor) return null;
          return {
            pageIndex,
            rect: [
              Math.min(anchor.rect[0], ...ordered.map(part => part.rect[0])),
              ordered[0].rect[1],
              Math.max(anchor.rect[2], ...ordered.map(part => part.rect[2])),
              ordered[ordered.length - 1].rect[3]
            ],
            sourceRects: ordered.map(part => part.rect)
          };
        }).filter(Boolean);
    },

    titleBreakParts(text) {
      const normalized = String(text || "").trim();
      const marked = normalized.split(/<\s*br\s*\/?>/iu).map(value => value.trim());
      if (marked.length === 2 && marked.every(Boolean)) {
        return { lines: marked, breakSource: "deepseek" };
      }
      const plain = normalized.replace(/<\s*br\s*\/?>/giu, "").trim();
      return { lines: [plain], breakSource: "none" };
    },

    measureTextLayout({ node, containerWidth, containerHeight, fontSize, lineHeight,
      mode = "block", lineNodes = [] }) {
      const titleMode = mode === "title";
      const paddingX = 8;
      const paddingY = titleMode ? 0 : 6;
      const availableWidth = Math.max(1, containerWidth - paddingX);
      const availableHeight = Math.max(1, containerHeight - paddingY);
      node.style.fontSize = `${fontSize}px`;
      node.style.lineHeight = String(lineHeight);
      let contentWidth = 0;
      let contentHeight = 0;
      if (titleMode) {
        for (const line of lineNodes) {
          line.style.fontSize = `${fontSize}px`;
          line.style.lineHeight = String(lineHeight);
        }
        contentWidth = Math.max(0, ...lineNodes.map(line =>
          Number(line.scrollWidth || line.getBoundingClientRect?.()?.width || 0)));
        // Title lines are measured as independent nowrap nodes.  Do not use the
        // flex container's scrollHeight: it includes the parent box and can make
        // an otherwise valid single line look vertically clipped.
        contentHeight = lineNodes.length * fontSize * lineHeight;
      }
      else {
        contentWidth = Math.max(0, Number(node.scrollWidth || 0) - paddingX);
        contentHeight = Math.max(0, Number(node.scrollHeight || 0) - paddingY);
      }
      const horizontalOverflow = contentWidth > availableWidth + 1;
      const verticalOverflow = contentHeight > availableHeight + 1;
      return { fits: !horizontalOverflow && !verticalOverflow,
        contentWidth, contentHeight, availableWidth, availableHeight,
        horizontalOverflow, verticalOverflow };
    },

    visualLineCount(node, fontSize, lineHeight) {
      const doc = node?.ownerDocument;
      const range = doc?.createRange?.();
      if (range && node.firstChild) {
        range.selectNodeContents(node);
        const rects = [...range.getClientRects?.() || []].filter(rect => rect.width > 0);
        const tops = [];
        for (const rect of rects) {
          if (!tops.some(top => Math.abs(top - rect.top) < 1)) tops.push(rect.top);
        }
        if (tops.length) return tops.length;
      }
      const naturalHeight = Math.max(0, Number(node?.scrollHeight || 0) - 6);
      return Math.max(1, Math.round(naturalHeight / Math.max(1, fontSize * lineHeight)));
    },

    fitTitleText({ node, containerWidth, containerHeight, sourceRects, translatedText }) {
      const rawTitle = String(translatedText || "");
      const shortTitle = rawTitle.length < 16;
      const layout = shortTitle
        ? { lines: [rawTitle.replace(/<\s*br\s*\/?>/giu, "")],
          breakSource: "short-title-forced-single" }
        : this.titleBreakParts(rawTitle);
      node.textContent = "";
      const doc = node.ownerDocument;
      this.style(node, {
        position: "absolute", inset: "0",
        width: "100%", height: "100%", boxSizing: "border-box", padding: "0 4px",
        margin: "0", overflow: "hidden", whiteSpace: "normal", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        textAlign: "center"
      });
      const lineNodes = layout.lines.map(text => {
        const line = doc.createElement("div");
        line.className = "reader-selection-replacer-title-line";
        line.textContent = text;
        this.style(line, { display: "block", width: "max-content", maxWidth: "none",
          padding: "0", margin: "0", whiteSpace: "nowrap", overflow: "visible",
          overflowWrap: "normal", wordBreak: "normal", boxSizing: "content-box" });
        node.append(line);
        return line;
      });
      const heights = (sourceRects || []).map(rect => Math.max(1, rect[3] - rect[1]))
        .sort((left, right) => left - right);
      const medianHeight = heights[Math.floor(heights.length / 2)] || containerHeight;
      const lineCount = Math.max(1, layout.lines.length);
      const lineMin = 1.05;
      const heightLimitedMaximum = Math.max(0.5, containerHeight / (lineCount * lineMin));
      const minimum = Math.max(0.5, Math.min(10, heightLimitedMaximum));
      const maximum = Math.max(minimum, Math.min(40, medianHeight * 1.35,
        heightLimitedMaximum));
      const measure = (fontSize, lineHeight) => this.measureTextLayout({ node,
        containerWidth, containerHeight, fontSize, lineHeight, mode: "title", lineNodes });
      if (!(node?.isConnected !== false) || !(containerWidth > 1) || !(containerHeight > 1)) {
        return { rendered: false, layoutMode: "diagnostic", lines: layout.lines,
          fontSize: 0, lineHeight: 0, breakSource: layout.breakSource,
          sourceRectCount: heights.length, mergedRectCount: 1,
          failureReason: "container-unavailable" };
      }
      const minimumMeasure = measure(minimum, lineMin);
      if (!minimumMeasure.fits) {
        return { rendered: false, layoutMode: "diagnostic", lines: layout.lines,
          fontSize: minimum, lineHeight: lineMin, breakSource: layout.breakSource,
          sourceRectCount: heights.length, mergedRectCount: 1,
          ...minimumMeasure, failureReason: "minimum-font-overflow" };
      }
      let low = minimum;
      let high = maximum;
      for (let iteration = 0; iteration < 9; iteration++) {
        const middle = (low + high) / 2;
        if (measure(middle, lineMin).fits) low = middle;
        else high = middle;
      }
      let lineLow = lineMin;
      if (lineCount > 1) {
        let lineHigh = 1.22;
        for (let iteration = 0; iteration < 8; iteration++) {
          const middle = (lineLow + lineHigh) / 2;
          if (measure(low, middle).fits) lineLow = middle;
          else lineHigh = middle;
        }
      }
      const finalMeasure = measure(low, lineLow);
      return { rendered: true,
        layoutMode: layout.lines.length === 1 ? "title-single" : "title-ds-two-line",
        lines: layout.lines, fontSize: Number(low.toFixed(2)),
        lineHeight: Number(lineLow.toFixed(3)), breakSource: layout.breakSource,
        visualLineCount: lineNodes.length, ...finalMeasure,
        sourceRectCount: heights.length, mergedRectCount: 1, failureReason: "" };
    },

    fitAbstractText({ node, containerWidth, containerHeight, sourceRects, translatedText,
      indentFirstBlock = false }) {
      const heights = (sourceRects || []).map(rect => Math.max(1, rect[3] - rect[1]))
        .sort((left, right) => left - right);
      const medianHeight = heights[Math.floor(heights.length / 2)] || containerHeight;
      const minimum = Math.max(8, Math.min(40, medianHeight * 0.78));
      const maximum = Math.max(minimum, Math.min(40, medianHeight * 2.10));
      const availableHeight = Math.max(1, containerHeight - 6);
      const text = String(translatedText || "").trim();
      node.textContent = indentFirstBlock && text
        ? `${PARAGRAPH_TRANSLATION_INDENT}${text}` : text;
      node.style.whiteSpace = "pre-wrap";
      node.style.overflowWrap = "break-word";
      node.style.wordBreak = "normal";
      node.style.letterSpacing = "normal";
      node.style.display = "block";
      node.style.width = "100%";
      node.style.height = "auto";
      node.style.margin = "0";
      node.style.boxSizing = "border-box";
      const measure = (fontSize, lineHeight) => {
        return this.measureTextLayout({ node, containerWidth, containerHeight,
          fontSize, lineHeight, mode: "block" });
      };
      const failure = (reason, fontSize = 0, lineHeight = 0) => ({
        rendered: false, layoutMode: "diagnostic", fontSize, lineHeight,
        paragraphSpacing: 0, renderedLineCount: 0, verticalUsage: 0,
        sourceRectCount: heights.length, mergedRectCount: 1, failureReason: reason
      });
      if (!(node?.isConnected !== false) || !(containerWidth > 1) || !(containerHeight > 1)) {
        return failure("container-unavailable");
      }
      if (!measure(minimum, 1.10).fits) return failure("minimum-font-overflow", minimum, 1.10);
      let sizeLow = minimum;
      let sizeHigh = maximum;
      for (let iteration = 0; iteration < 10; iteration++) {
        const middle = (sizeLow + sizeHigh) / 2;
        if (measure(middle, 1.10).fits) sizeLow = middle;
        else sizeHigh = middle;
      }
      const fontSize = sizeLow;
      const compact = measure(fontSize, 1.10);
      const renderedLineCount = this.visualLineCount(node, fontSize, 1.10);
      const lineMaximum = renderedLineCount <= 1 ? 1.10
        : renderedLineCount === 2 ? 1.65 : 2.20;
      let lineLow = 1.10;
      let lineHigh = lineMaximum;
      for (let iteration = 0; iteration < 9; iteration++) {
        const middle = (lineLow + lineHigh) / 2;
        if (measure(fontSize, middle).fits) lineLow = middle;
        else lineHigh = middle;
      }
      const finalMeasure = measure(fontSize, lineLow);
      const visualLineCount = this.visualLineCount(node, fontSize, lineLow);
      const verticalUsage = Math.min(1, finalMeasure.contentHeight / availableHeight);
      return {
        rendered: true, layoutMode: "abstract-fit",
        fontSize: Number(fontSize.toFixed(2)), lineHeight: Number(lineLow.toFixed(3)),
        visualLineCount,
        verticalUsage: Number(verticalUsage.toFixed(3)),
        ...finalMeasure,
        sourceRectCount: heights.length, mergedRectCount: 1, failureReason: ""
      };
    },

    fitSelectionText({ node, containerWidth, containerHeight, sourceRects, translatedText,
      indentFirstBlock = false, paragraphLayout = false, continuesParagraph = false,
      layoutCache = null, layoutSignature = "" }) {
      const heights = (sourceRects || []).map(rect => Math.max(1, rect[3] - rect[1]))
        .sort((left, right) => left - right);
      const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
      const minimum = Math.max(5, Math.min(14, medianHeight * 0.42));
      const preferredMinimum = Math.max(minimum, Math.min(30, medianHeight * 0.85));
      const preferredMaximum = Math.max(preferredMinimum, Math.min(30, medianHeight * 1.45));
      const availableHeight = Math.max(1, containerHeight - 6);
      const text = String(translatedText || "");
      node.textContent = indentFirstBlock && text
        ? `${PARAGRAPH_TRANSLATION_INDENT}${text}` : text;
      this.style(node, {
        position: "absolute", top: "0", left: "0", width: "100%", height: "auto",
        boxSizing: "border-box", padding: "3px 4px", margin: "0", overflow: "hidden",
        whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "normal",
        letterSpacing: "normal", display: "block",
        textAlign: paragraphLayout ? "justify" : "left",
        textAlignLast: paragraphLayout && continuesParagraph ? "justify" : "auto"
      });
      const cached = layoutSignature && layoutCache?.get?.(layoutSignature);
      if (cached) {
        node.style.fontSize = `${cached.fontSize}px`;
        node.style.lineHeight = String(cached.lineHeight);
        return { ...cached, cacheHit: true, measureCount: 0 };
      }
      let measureCount = 0;
      const measure = (fontSize, lineHeight) => {
        measureCount++;
        return this.measureTextLayout({ node, containerWidth, containerHeight,
          fontSize, lineHeight, mode: "block" });
      };
      const failure = (reason, fontSize = 0, lineHeight = 0) => ({
        rendered: false, layoutMode: "diagnostic", fontSize, lineHeight,
        renderedLineCount: 0, verticalUsage: 0, sourceRectCount: heights.length,
        mergedRectCount: 1, failureReason: reason, cacheHit: false, measureCount
      });
      if (!(node?.isConnected !== false) || !(containerWidth > 1) || !(containerHeight > 1)) {
        return failure("container-unavailable");
      }
      const candidates = [...new Set([
        minimum, preferredMinimum, medianHeight,
        medianHeight * 1.15, medianHeight * 1.30, preferredMaximum
      ].map(value => Number(Math.max(minimum, Math.min(30, preferredMaximum, value)).toFixed(3))))]
        .sort((left, right) => left - right);
      const measured = [];
      for (const fontSize of candidates.slice(0, 6)) {
        const compact = measure(fontSize, 1.08);
        if (!compact.fits) continue;
        const lineCount = this.visualLineCount(node, fontSize, 1.08);
        const compactUsage = compact.contentHeight / availableHeight;
        const desiredLineHeight = Math.max(1.08, Math.min(3.00,
          1.08 * 0.95 / Math.max(0.01, compactUsage)));
        const predictedUsage = Math.min(1, compactUsage * desiredLineHeight / 1.08);
        const score = Math.abs(predictedUsage - 0.95) * 8
          + Math.abs(fontSize - medianHeight) / Math.max(1, medianHeight) * 0.30
          + Math.abs(desiredLineHeight - 1.35) * 0.08;
        measured.push({ fontSize, compact, lineCount, desiredLineHeight,
          predictedUsage, score });
      }
      if (!measured.length) {
        const minimumMeasure = measureCount
          ? this.measureTextLayout({ node, containerWidth, containerHeight,
            fontSize: minimum, lineHeight: 1.08, mode: "block" })
          : measure(minimum, 1.08);
        return { ...failure("minimum-font-overflow", minimum, 1.08), ...minimumMeasure };
      }
      measured.sort((left, right) => left.score - right.score
        || Math.abs(left.fontSize - medianHeight) - Math.abs(right.fontSize - medianHeight));
      const selected = measured[0];
      const fontSize = selected.fontSize;
      let lineHeight = selected.desiredLineHeight;
      let finalMeasure = measure(fontSize, lineHeight);
      let verticalUsage = finalMeasure.contentHeight / availableHeight;
      if (measureCount < 8 && (!finalMeasure.fits || verticalUsage < 0.90
        || verticalUsage > 0.98)) {
        const correction = 0.95 / Math.max(0.01, verticalUsage);
        lineHeight = Math.max(1.08, Math.min(3.00,
          lineHeight * correction * (finalMeasure.fits ? 1 : 0.96)));
        finalMeasure = measure(fontSize, lineHeight);
        verticalUsage = finalMeasure.contentHeight / availableHeight;
      }
      if (!finalMeasure.fits) {
        return { ...failure("minimum-font-overflow", fontSize, lineHeight), ...finalMeasure };
      }
      const visualLineCount = this.visualLineCount(node, fontSize, lineHeight);
      const renderedLineCount = visualLineCount;
      const result = {
        rendered: true, layoutMode: "selection-fit",
        fontSize: Number(fontSize.toFixed(2)), lineHeight: Number(lineHeight.toFixed(3)),
        visualLineCount, renderedLineCount,
        verticalUsage: Number(Math.min(1, verticalUsage).toFixed(3)), ...finalMeasure,
        sourceRectCount: heights.length, mergedRectCount: 1, failureReason: "",
        cacheHit: false, measureCount
      };
      if (layoutSignature && layoutCache?.set) layoutCache.set(layoutSignature, { ...result });
      return result;
    },
  };

  global.TranslatorOverlayLayout = Object.freeze(TranslatorOverlayLayout);
})(globalThis);
