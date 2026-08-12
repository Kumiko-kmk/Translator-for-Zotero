(function (global) {
  "use strict";

  const CONFIG = Object.freeze({
    edgeRatio: 0.10,
    gutterLeft: 0.32,
    gutterRight: 0.68,
    minimumGutterWidth: 0.025,
    maximumGutterOccupancy: 0.15,
    minimumColumnLines: 4,
    minimumColumnOverlap: 0.08,
    pageBandGapLines: 2.2,
    lineGapMultiplier: 1.7,
    bodyHeightTolerance: 0.24,
    crossFlowHeightTolerance: 0.16,
    paragraphIndentEm: 0.85,
    crossFlowFillRatio: 0.80,
    maximumSamplesPerReason: 3
  });

  function median(values) {
    const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200d\ufeff]/gu, "")
      .replace(/[‐‑‒–—―]/gu, "-")
      .replace(/[“”„‟]/gu, '"')
      .replace(/[‘’‚‛]/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function normalizeEdgeKey(value) {
    return normalizeText(value).toLocaleLowerCase()
      .replace(/\b(?:page|p)\.?\s*\d{1,5}\b/giu, " # ")
      .replace(/\b\d{1,5}\b/gu, " # ")
      .replace(/\b[ivxlcdm]{1,12}\b/giu, " # ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function compactSpacedHeading(value) {
    const parts = normalizeText(value).split(/\s+/u).filter(Boolean);
    if (parts.length >= 3 && parts.every(part => [...part].length === 1
      && /\p{L}/u.test(part))) return parts.join("");
    return normalizeText(value);
  }

  function canonicalHeading(value) {
    return compactSpacedHeading(value).toLocaleLowerCase()
      .replace(/^\s*\d+(?:\.\d+)*\.?\s*/u, "")
      .replace(/[\s:：.]+$/gu, "")
      .trim();
  }

  function textStats(value) {
    const text = normalizeText(value);
    const chars = [...text].filter(character => !/\s/u.test(character));
    const letters = chars.filter(character => /\p{L}/u.test(character)).length;
    const digits = chars.filter(character => /\p{N}/u.test(character)).length;
    const operators = chars.filter(character => /[=+\-×÷<>≤≥∑∫√^~±∞≈≠∂]/u.test(character)).length;
    const words = text.match(/[\p{L}]{2,}/gu) || [];
    return {
      chars: chars.length,
      letters,
      digits,
      operators,
      words: words.length,
      letterRatio: chars.length ? letters / chars.length : 0,
      digitRatio: chars.length ? digits / chars.length : 0,
      operatorRatio: chars.length ? operators / chars.length : 0,
      numericTokens: (text.match(/(?:^|\s)[+-]?\d+(?:[.,]\d+)?(?=\s|$)/gu) || []).length
    };
  }

  function boundingRect(rects) {
    const valid = (rects || []).filter(rect => rect && rect.length >= 4
      && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]);
    if (!valid.length) return null;
    return [
      Math.min(...valid.map(rect => rect[0])),
      Math.min(...valid.map(rect => rect[1])),
      Math.max(...valid.map(rect => rect[2])),
      Math.max(...valid.map(rect => rect[3]))
    ];
  }

  function geometry(rect, pageWidth, pageHeight) {
    if (!rect || !(pageWidth > 0) || !(pageHeight > 0)) return null;
    return {
      left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
      width: rect[2] - rect[0], height: rect[3] - rect[1],
      centerX: (rect[0] + rect[2]) / 2,
      centerY: (rect[1] + rect[3]) / 2,
      leftRatio: rect[0] / pageWidth,
      rightRatio: rect[2] / pageWidth,
      topRatio: rect[1] / pageHeight,
      bottomRatio: rect[3] / pageHeight
    };
  }

  function verticalOverlap(left, right) {
    if (!left || !right) return 0;
    return Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  }

  function horizontalOverlap(left, right) {
    return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  }

  function isStandalonePageNumber(value) {
    return /^(?:(?:page|p\.?|页码?)\s*)?[-()\[\]\s]*(?:\d{1,5}|[ivxlcdm]{1,12})(?:\s*\/\s*\d{1,5})?[-()\[\]\s]*$/iu
      .test(normalizeText(value));
  }

  function isTerminalHeading(value) {
    return /^(?:references|bibliography|works\s+cited|literature\s+cited|acknowledg(?:e)?ments?|funding|author\s+contributions?|data\s+availability|conflicts?\s+of\s+interest|appendix|supplementary\s+materials?|参考文献|致谢|基金项目|作者贡献|数据可用性|附录)(?:\s|$)/iu
      .test(canonicalHeading(value));
  }

  function isStartHeading(value) {
    return /^(?:introduction|background|materials?(?:\s+and\s+methods?)?|methods?|methodology|experimental(?:\s+program)?|theoretical\s+background|引言|绪论|背景|材料与方法|方法|试验方法)(?:\s|$)/iu
      .test(canonicalHeading(value));
  }

  function isAbstractHeading(value) {
    return /^(?:abstract|summary|摘要|内容摘要)$/iu.test(canonicalHeading(value));
  }

  function parseNumberedHeading(value) {
    const text = normalizeText(value);
    const match = text.match(/^((?:\d+(?:\.\d+){0,3}\.?|[IVXLC]+\.?))\s+(.+)$/iu);
    if (!match) return null;
    const prefix = match[1];
    const remainder = normalizeText(match[2]);
    if (!remainder || remainder.length > 150 || endsTerminal(remainder)) return null;
    if (/^\d/u.test(prefix)) {
      const components = prefix.replace(/\.$/u, "").split(".").map(Number);
      if (!components.length || components.some(component => !Number.isInteger(component))) return null;
      if (components[0] === 0 || components[0] > 99) return null;
      if (/^(?:mm|cm|dm|m|km|mg|g|kg|pa|kpa|mpa|gpa|hz|khz|mhz|s|ms|min|h|day|days|%|°c|k)\b/iu
        .test(remainder)) return null;
    }
    if (/^\p{Ll}/u.test(remainder)) return null;
    if (/[.!?。！？]\s+[\p{Lu}\p{Script=Han}]/u.test(remainder)) return null;
    const stats = textStats(remainder);
    if (stats.words > 16) return null;
    return { prefix, remainder };
  }

  function isNumberedHeading(value) {
    return !!parseNumberedHeading(value);
  }

  function isLikelyHeading(line, bodyHeight) {
    const text = normalizeText(line.text);
    if (!text || text.length > 180 || textStats(text).words > 18) return false;
    if (isStartHeading(text) || isTerminalHeading(text) || isAbstractHeading(text)) {
      const flowWidth = Math.max(1, line.flowRight - line.flowLeft);
      return text.length <= 110 && !endsTerminal(text)
        && (isNumberedHeading(text) || line.fontHeight >= bodyHeight * 1.03
          || line.bodyFontFraction < 0.72 || line.geometry.width / flowWidth < 0.56);
    }
    if (!isNumberedHeading(text)) return false;
    const flowWidth = Math.max(1, line.flowRight - line.flowLeft);
    const widthRatio = line.geometry.width / flowWidth;
    const strongFontDifference = line.fontHeight >= bodyHeight * 1.08
      || (!line.bodyFontFraction && line.fontHeight >= bodyHeight * 1.05)
      || line.bodyFontFraction < 0.50;
    return widthRatio < 0.72 || (strongFontDifference && widthRatio < 0.90);
  }

  function captionLead(value) {
    const text = normalizeText(value);
    const match = text.match(/^(fig(?:ure)?\.?|table|scheme|chart|plate|图|表)\s*([A-Z]?\d+(?:[.\-]\d+)?|[一二三四五六七八九十百零〇]+)(?:\s*([.:：\-])\s*|\s+)(.*)$/iu);
    if (!match) return null;
    const remainder = normalizeText(match[4]);
    const directContinuation = /^(?:shows?|illustrates?|presents?|depicts?|compares?|demonstrates?|reveals?|provides?|indicates?|summari[sz]es?|reports?|lists?|gives?|contains?|is|are|was|were)\b/iu
      .test(remainder);
    const sentenceContinuation = /^(?:this|these|those|the|we|our|it|they)\b.{0,100}\b(?:evidence(?:s|d)?|show(?:s|ed)?|indicate(?:s|d)?|demonstrate(?:s|d)?|confirm(?:s|ed)?|reveal(?:s|ed)?|suggest(?:s|ed)?|depend(?:s|ed)?|increase(?:s|d)?|decrease(?:s|d)?|is|are|was|were|has|have|had|can|may|will)\b/iu
      .test(remainder);
    const proseContinuation = directContinuation || sentenceContinuation;
    return {
      kind: /^(?:table|表)$/iu.test(match[1]) ? "table" : "figure",
      remainder,
      proseContinuation,
      strongSeparator: !!match[3]
    };
  }

  function endsTerminal(value) {
    return /[.!?。！？][\])}'"”’]*\s*$/u.test(String(value || ""));
  }

  function lineJoin(left, right, previousLine, currentLine) {
    let previous = String(left || "").replace(/\s+$/u, "");
    const next = String(right || "").replace(/^\s+/u, "");
    const previousWord = previous.match(/([\p{L}]{2,})-$/u)?.[1] || "";
    const softHyphen = /\u00ad$/u.test(previous);
    const standaloneHyphen = previousLine?.items?.[previousLine.items.length - 1]?.rawText === "-";
    const flowWidth = Math.max(1, previousLine.flowRight - previousLine.flowLeft);
    const fill = (previousLine.geometry.right - previousLine.flowLeft) / flowWidth;
    const commonCompoundStem = /^(?:well|high|low|state|long|short|cross|non|self|co|pre|post|re|multi|two|three|four|five|six|seven|eight|nine|ten)$/iu
      .test(previousWord);
    const likelyWrappedHyphen = /^\p{Ll}/u.test(next) && previousWord
      && !commonCompoundStem
      && (softHyphen || ((standaloneHyphen || previousLine?.hasEOL)
        && fill >= 0.70 && previousWord.length >= 4));
    if (likelyWrappedHyphen) {
      previous = previous.replace(/[\u00ad-]$/u, "");
      return { text: previous + next, dehyphenated: true };
    }
    previous = previous.replace(/\u00ad$/u, "");
    if (!previous) return { text: next, dehyphenated: false };
    if (!next) return { text: previous, dehyphenated: false };
    const noSpace = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous)
      && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next);
    return { text: previous + (noSpace ? "" : " ") + next, dehyphenated: false };
  }

  function copyRect(value) {
    if (!value || Number(value.length || 0) < 4) return null;
    const rect = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
    return rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
  }

  function fallbackViewportRect(pdfRect, viewBox) {
    if (!pdfRect || !viewBox) return null;
    return [
      pdfRect[0] - viewBox[0],
      viewBox[3] - pdfRect[3],
      pdfRect[2] - viewBox[0],
      viewBox[3] - pdfRect[1]
    ];
  }

  function makePageChar(raw, index, page) {
    const rawText = String(raw?.c || "");
    const id = String(raw?.id || `${page.pageIndex}:char:${index}`);
    if (raw?.ignorable) return { rejected: true, id, rawText, reason: "zotero-ignorable-character" };
    if (!rawText || /^\s+$/u.test(rawText)) return { ignored: true };
    const pdfRect = copyRect(raw?.rect);
    const viewportRect = copyRect(raw?.viewportRect) || fallbackViewportRect(pdfRect, page.viewBox);
    const charGeometry = geometry(viewportRect, page.viewport.width, page.viewport.height);
    if (!pdfRect || !charGeometry || charGeometry.width <= 0.01 || charGeometry.height <= 0.01) {
      return { rejected: true, id, rawText, reason: "invalid-character-geometry" };
    }
    const rotation = ((Number(raw?.rotation || 0) % 360) + 360) % 360;
    const vertical = Math.min(Math.abs(rotation), Math.abs(rotation - 180), Math.abs(rotation - 360)) > 12;
    const fontHeight = charGeometry.height;
    return {
      id,
      offset: Number(raw?.offset ?? index),
      pageIndex: page.pageIndex,
      rawText,
      text: rawText,
      fontName: String(raw?.fontName || `height:${Math.round(fontHeight * 2) / 2}`),
      fontFamily: "",
      fontHeight,
      direction: "ltr",
      vertical,
      rotation,
      hasEOL: !!raw?.lineBreakAfter,
      lineBreakAfter: !!raw?.lineBreakAfter,
      paragraphBreakAfter: !!raw?.paragraphBreakAfter,
      spaceAfter: !!raw?.spaceAfter,
      baseline: [charGeometry.left, charGeometry.bottom],
      viewportRect,
      pdfRect,
      geometry: charGeometry
    };
  }

  function preparePage(input) {
    const viewBox = copyRect(input?.viewBox || input?.metric?.viewBox);
    const width = Number(input?.metric?.width || (viewBox ? viewBox[2] - viewBox[0] : 0));
    const height = Number(input?.metric?.height || (viewBox ? viewBox[3] - viewBox[1] : 0));
    const page = {
      pageIndex: Number(input?.pageIndex || 0),
      viewBox,
      viewport: {
        width,
        height,
        rotation: Number(input?.metric?.rotation || 0)
      },
      items: [], rejectedItems: [], ignoredItemCount: 0, lines: []
    };
    if (!(width > 0) || !(height > 0) || !viewBox) {
      throw Object.assign(new Error(`第 ${page.pageIndex + 1} 页尺寸或 viewBox 无效。`),
        { code: "invalid-page-viewbox" });
    }
    const chars = input?.chars || [];
    for (let index = 0; index < chars.length; index++) {
      const mapped = makePageChar(chars[index], index, page);
      if (mapped.ignored) page.ignoredItemCount++;
      else if (mapped.rejected) page.rejectedItems.push(mapped);
      else page.items.push(mapped);
    }
    return page;
  }

  function buildLineText(items, typicalHeight) {
    let text = "";
    let previous = null;
    let largeGapCount = 0;
    for (const item of items) {
      const value = item.text;
      if (!value) continue;
      const gap = previous ? item.geometry.left - previous.geometry.right : 0;
      if (previous && !/\s$/u.test(text) && !/^\s/u.test(value)) {
        const addSpace = gap > Math.max(0.8, typicalHeight * 0.12)
          || previous.spaceAfter || /\s$/u.test(previous.rawText) || /^\s/u.test(item.rawText);
        if (addSpace && !/^[,.;:!?%)\]}。；：！？、]/u.test(value)) text += " ";
        if (gap > typicalHeight * 1.8) largeGapCount++;
      }
      text += value;
      previous = item;
    }
    return { text: normalizeText(text), largeGapCount };
  }

  function makeLine(page, items, rowIndex, segmentIndex, segmentCount, offset) {
    const viewportRect = boundingRect(items.map(item => item.viewportRect));
    const lineGeometry = geometry(viewportRect, page.viewport.width, page.viewport.height);
    const typicalHeight = median(items.map(item => item.fontHeight)) || lineGeometry.height;
    const mapped = buildLineText(items, typicalHeight);
    const fontWeights = new Map();
    for (const item of items) {
      const weight = Math.max(1, [...normalizeText(item.text)].filter(character => /\p{L}|\p{N}/u.test(character)).length);
      fontWeights.set(item.fontName, (fontWeights.get(item.fontName) || 0) + weight);
    }
    const primaryFont = [...fontWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    return {
      id: `${page.pageIndex}:line:${offset}`,
      pageIndex: page.pageIndex,
      pageWidth: page.viewport.width,
      pageHeight: page.viewport.height,
      text: mapped.text,
      items,
      itemIDs: items.map(item => item.id),
      pdfRects: items.map(item => item.pdfRect),
      viewportRect,
      geometry: lineGeometry,
      fontHeight: typicalHeight,
      primaryFont,
      bodyFontFraction: 0,
      baselineSpread: Math.max(...items.map(item => item.baseline[1]))
        - Math.min(...items.map(item => item.baseline[1])),
      hasEOL: items.some(item => item.hasEOL),
      paragraphHintAfter: items.some(item => item.paragraphBreakAfter),
      largeGapCount: mapped.largeGapCount,
      visualRowID: `${page.pageIndex}:row:${rowIndex}`,
      segmentIndex,
      segmentCount,
      columnIndex: 0,
      flowKey: `${page.pageIndex}:0:0`,
      flowLeft: 0,
      flowRight: page.viewport.width,
      transitionBefore: "page-start",
      exclusionReason: null,
      orderIndex: -1
    };
  }

  function clusterPageLines(page) {
    const horizontal = [];
    for (const item of page.items) {
      if (item.vertical) page.rejectedItems.push({ ...item, reason: "rotated-or-vertical-text" });
      else horizontal.push(item);
    }
    page.items = horizontal;
    const typicalHeight = median(horizontal.map(item => item.fontHeight)) || 1;
    horizontal.sort((left, right) => left.geometry.top - right.geometry.top
      || left.geometry.left - right.geometry.left);
    const rows = [];
    for (const item of horizontal) {
      let best = null;
      let bestDistance = Infinity;
      for (const row of rows) {
        const overlap = verticalOverlap(row.geometry, item.geometry);
        const minimumHeight = Math.max(1, Math.min(row.geometry.height, item.geometry.height));
        const baselineDistance = Math.abs(row.baseline - item.baseline[1]);
        const compatible = overlap / minimumHeight >= 0.52
          || baselineDistance <= Math.max(1.2, Math.min(row.height, item.fontHeight) * 0.38);
        if (compatible && baselineDistance < bestDistance) {
          best = row;
          bestDistance = baselineDistance;
        }
      }
      if (!best) {
        best = { items: [], geometry: { ...item.geometry }, baseline: item.baseline[1], height: item.fontHeight };
        rows.push(best);
      }
      best.items.push(item);
      best.geometry = geometry(boundingRect(best.items.map(value => value.viewportRect)),
        page.viewport.width, page.viewport.height);
      best.baseline = median(best.items.map(value => value.baseline[1]));
      best.height = median(best.items.map(value => value.fontHeight));
    }
    const lines = [];
    let offset = 0;
    rows.sort((left, right) => left.geometry.top - right.geometry.top);
    rows.forEach((row, rowIndex) => {
      row.items.sort((left, right) => left.geometry.left - right.geometry.left);
      const rowHeight = median(row.items.map(item => item.fontHeight)) || typicalHeight;
      const splitGap = Math.max(page.viewport.width * 0.012, rowHeight * 1.25);
      const segments = [];
      let current = [];
      for (const item of row.items) {
        const previous = current[current.length - 1];
        const gap = previous ? item.geometry.left - previous.geometry.right : 0;
        if (previous && gap > splitGap) {
          segments.push(current);
          current = [];
        }
        current.push(item);
      }
      if (current.length) segments.push(current);
      segments.forEach((segment, segmentIndex) => {
        const line = makeLine(page, segment, rowIndex, segmentIndex, segments.length, offset++);
        if (line.text && line.geometry) lines.push(line);
        else {
          for (const item of segment) page.rejectedItems.push({
            ...item,
            reason: "blank-after-normalization"
          });
        }
      });
    });
    const clusteredIDs = new Set(lines.flatMap(line => line.itemIDs));
    const rejectedIDs = new Set(page.rejectedItems.map(item => item.id));
    for (const item of page.items) {
      if (!clusteredIDs.has(item.id) && !rejectedIDs.has(item.id)) {
        page.rejectedItems.push({ ...item, reason: "unclustered-text-item" });
      }
    }
    page.items = page.items.filter(item => clusteredIDs.has(item.id));
    page.lines = lines;
  }

  function estimateBodyStyle(pages) {
    const heightClusters = new Map();
    for (const page of pages) {
      for (const line of page.lines) {
        if (line.geometry.topRatio < CONFIG.edgeRatio || line.geometry.bottomRatio > 1 - CONFIG.edgeRatio) continue;
        const stats = textStats(line.text);
        if (stats.letters < 4) continue;
        const key = (Math.round(line.fontHeight * 2) / 2).toFixed(1);
        if (!heightClusters.has(key)) heightClusters.set(key, { height: Number(key), score: 0, pages: new Set() });
        const cluster = heightClusters.get(key);
        cluster.score += Math.min(240, stats.letters) * clamp(line.geometry.width / page.viewport.width, 0.08, 0.7);
        cluster.pages.add(page.pageIndex);
      }
    }
    const ranked = [...heightClusters.values()].sort((left, right) =>
      (right.score * (1 + Math.min(1, right.pages.size / Math.max(1, pages.length))))
      - (left.score * (1 + Math.min(1, left.pages.size / Math.max(1, pages.length)))));
    const bodyHeight = ranked[0]?.height || median(pages.flatMap(page => page.lines.map(line => line.fontHeight))) || 1;
    const fontWeights = new Map();
    for (const page of pages) {
      for (const line of page.lines) {
        if (Math.abs(line.fontHeight - bodyHeight) / Math.max(1, bodyHeight) > CONFIG.bodyHeightTolerance) continue;
        for (const item of line.items) {
          const letters = [...normalizeText(item.text)].filter(character => /\p{L}/u.test(character)).length;
          fontWeights.set(item.fontName, (fontWeights.get(item.fontName) || 0) + letters);
        }
      }
    }
    const total = [...fontWeights.values()].reduce((sum, value) => sum + value, 0);
    const bodyFonts = new Set();
    let covered = 0;
    for (const [font, weight] of [...fontWeights.entries()].sort((a, b) => b[1] - a[1])) {
      if (!font) continue;
      bodyFonts.add(font);
      covered += weight;
      if (covered >= total * 0.86) break;
    }
    for (const page of pages) {
      for (const line of page.lines) {
        const bodyItems = line.items.filter(item => bodyFonts.has(item.fontName));
        line.bodyFontFraction = bodyItems.length / Math.max(1, line.items.length);
      }
    }
    return {
      height: bodyHeight,
      fonts: [...bodyFonts],
      heightClusters: ranked.slice(0, 6).map(cluster => ({
        height: cluster.height,
        score: Number(cluster.score.toFixed(2)),
        pageCount: cluster.pages.size
      }))
    };
  }

  function markRepeatedEdges(pages) {
    const groups = new Map();
    for (const page of pages) {
      for (const line of page.lines) {
        const atTop = line.geometry.topRatio < CONFIG.edgeRatio;
        const atBottom = line.geometry.bottomRatio > 1 - CONFIG.edgeRatio;
        if (!atTop && !atBottom) continue;
        if (isStandalonePageNumber(line.text)) {
          line.exclusionReason = "page-number";
          continue;
        }
        const keyText = normalizeEdgeKey(line.text);
        if (!keyText || keyText === "#") continue;
        const key = `${atTop ? "top" : "bottom"}:${keyText}`;
        if (!groups.has(key)) groups.set(key, { lines: [], pages: new Set() });
        groups.get(key).lines.push(line);
        groups.get(key).pages.add(page.pageIndex);
      }
    }
    const minimum = Math.max(2, Math.ceil(pages.length * 0.35));
    for (const group of groups.values()) {
      if (group.pages.size < minimum) continue;
      for (const line of group.lines) line.exclusionReason = line.geometry.topRatio < CONFIG.edgeRatio
        ? "repeated-header" : "repeated-footer";
    }
  }

  function detectGutter(page, bodyStyle) {
    const candidates = page.lines.filter(line => !line.exclusionReason
      && Math.abs(line.fontHeight - bodyStyle.height) / Math.max(1, bodyStyle.height) <= 0.30
      && line.geometry.width / page.viewport.width >= 0.12
      && line.geometry.width / page.viewport.width <= 0.58
      && textStats(line.text).letters >= 5);
    if (candidates.length < CONFIG.minimumColumnLines * 2) return null;
    const good = [];
    for (let bin = Math.ceil(CONFIG.gutterLeft * 200); bin <= Math.floor(CONFIG.gutterRight * 200); bin++) {
      const ratio = bin / 200;
      const x = page.viewport.width * ratio;
      const crossing = candidates.filter(line => line.geometry.left < x && line.geometry.right > x).length;
      const left = candidates.filter(line => line.geometry.right <= x).length;
      const right = candidates.filter(line => line.geometry.left >= x).length;
      if (crossing / candidates.length <= CONFIG.maximumGutterOccupancy
        && left >= CONFIG.minimumColumnLines && right >= CONFIG.minimumColumnLines) good.push(ratio);
    }
    const runs = [];
    let current = [];
    for (const ratio of good) {
      if (current.length && ratio - current[current.length - 1] > 0.006) {
        runs.push(current);
        current = [];
      }
      current.push(ratio);
    }
    if (current.length) runs.push(current);
    runs.sort((left, right) => right.length - left.length);
    for (const run of runs) {
      const leftRatio = run[0];
      const rightRatio = run[run.length - 1];
      if (rightRatio - leftRatio < CONFIG.minimumGutterWidth) continue;
      const center = page.viewport.width * (leftRatio + rightRatio) / 2;
      const leftLines = candidates.filter(line => line.geometry.right <= center);
      const rightLines = candidates.filter(line => line.geometry.left >= center);
      const overlapTop = Math.max(Math.min(...leftLines.map(line => line.geometry.top)),
        Math.min(...rightLines.map(line => line.geometry.top)));
      const overlapBottom = Math.min(Math.max(...leftLines.map(line => line.geometry.bottom)),
        Math.max(...rightLines.map(line => line.geometry.bottom)));
      if ((overlapBottom - overlapTop) / page.viewport.height >= CONFIG.minimumColumnOverlap) {
        return { leftRatio, rightRatio, centerRatio: (leftRatio + rightRatio) / 2 };
      }
    }
    return null;
  }

  function findPageBands(page, bodyHeight) {
    const intervals = page.lines.filter(line => !line.exclusionReason)
      .map(line => [line.geometry.top, line.geometry.bottom])
      .sort((left, right) => left[0] - right[0]);
    if (!intervals.length) return [{ top: 0, bottom: page.viewport.height }];
    const merged = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval[0] > last[1]) merged.push([...interval]);
      else last[1] = Math.max(last[1], interval[1]);
    }
    const boundaries = [0];
    const threshold = Math.max(bodyHeight * CONFIG.pageBandGapLines, page.viewport.height * 0.025);
    for (let index = 1; index < merged.length; index++) {
      if (merged[index][0] - merged[index - 1][1] > threshold) {
        boundaries.push((merged[index][0] + merged[index - 1][1]) / 2);
      }
    }
    boundaries.push(page.viewport.height);
    return boundaries.slice(0, -1).map((top, index) => ({ top, bottom: boundaries[index + 1] }));
  }

  function selectionRecoveryGutter(page, bodyStyle, selectionContext) {
    const hint = (selectionContext?.columnHints || []).find(candidate =>
      Number(candidate.pageIndex) === page.pageIndex && candidate.confidence === "high");
    if (!hint) return null;
    const leftRatio = Number(hint.leftRatio);
    const rightRatio = Number(hint.rightRatio);
    const top = Number(hint.top);
    const bottom = Number(hint.bottom);
    if (!(leftRatio >= CONFIG.gutterLeft && rightRatio <= CONFIG.gutterRight
      && rightRatio - leftRatio >= CONFIG.minimumGutterWidth
      && bottom > top && Number(hint.lineCount) >= 6)) return null;
    return {
      leftRatio,
      rightRatio,
      centerRatio: Number(hint.centerRatio || (leftRatio + rightRatio) / 2),
      top: Math.max(0, top - bodyStyle.height),
      bottom: Math.min(page.viewport.height, bottom + bodyStyle.height)
    };
  }

  function splitBandsForSelectionRecovery(bands, recovery, pageHeight) {
    if (!recovery) return bands;
    const boundaries = new Set([0, pageHeight, recovery.top, recovery.bottom]);
    for (const band of bands) {
      boundaries.add(band.top);
      boundaries.add(band.bottom);
    }
    const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.slice(0, -1).map((top, index) => ({ top, bottom: sorted[index + 1] }))
      .filter(band => band.bottom - band.top > 0.01);
  }

  function orderPage(page, bodyStyle, selectionContext = null) {
    const globalGutter = detectGutter(page, bodyStyle);
    const recovery = globalGutter ? null : selectionRecoveryGutter(page, bodyStyle, selectionContext);
    const gutter = globalGutter || recovery;
    const bands = splitBandsForSelectionRecovery(findPageBands(page, bodyStyle.height),
      recovery, page.viewport.height);
    const ordered = [];
    const diagnostics = [];
    const push = (line, bandIndex, columnIndex, flowLeft, flowRight, transition) => {
      line.columnIndex = columnIndex;
      line.flowKey = `${page.pageIndex}:${bandIndex}:${columnIndex}`;
      line.flowLeft = flowLeft;
      line.flowRight = flowRight;
      line.transitionBefore = ordered.length ? transition : "page-start";
      ordered.push(line);
    };
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex++) {
      const band = bands[bandIndex];
      const lines = page.lines.filter(line => line.geometry.centerY >= band.top
        && line.geometry.centerY < band.bottom);
      const activeGutter = globalGutter || (recovery
        && band.bottom > recovery.top && band.top < recovery.bottom ? recovery : null);
      if (!activeGutter) {
        const sorted = [...lines].sort((left, right) => left.geometry.top - right.geometry.top
          || left.geometry.left - right.geometry.left);
        sorted.forEach((line, index) => push(line, bandIndex, 0, 0, page.viewport.width,
          index ? "same-flow" : "band-break"));
        diagnostics.push({
          bandIndex, topRatio: band.top / page.viewport.height,
          bottomRatio: band.bottom / page.viewport.height, columnCount: 1,
          readingOrderLineIDs: sorted.map(line => line.id)
        });
        continue;
      }
      const gutterLeft = activeGutter.leftRatio * page.viewport.width;
      const gutterRight = activeGutter.rightRatio * page.viewport.width;
      const spanning = lines.filter(line => line.geometry.left < gutterLeft
        && line.geometry.right > gutterRight && line.geometry.width / page.viewport.width >= 0.48);
      const spanningBlocks = [];
      for (const line of [...spanning].sort((a, b) => a.geometry.top - b.geometry.top)) {
        const last = spanningBlocks[spanningBlocks.length - 1];
        if (!last || line.geometry.top - last.bottom > bodyStyle.height * 1.2) {
          spanningBlocks.push({ top: line.geometry.top, bottom: line.geometry.bottom, lines: [line] });
        }
        else {
          last.lines.push(line);
          last.bottom = Math.max(last.bottom, line.geometry.bottom);
        }
      }
      let zoneTop = band.top;
      const readingIDs = [];
      const emitColumns = (top, bottom, zoneIndex) => {
        const source = lines.filter(line => !spanning.includes(line)
          && line.geometry.centerY >= top && line.geometry.centerY < bottom);
        const left = source.filter(line => line.geometry.centerX < activeGutter.centerRatio * page.viewport.width)
          .sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left);
        const right = source.filter(line => line.geometry.centerX >= activeGutter.centerRatio * page.viewport.width)
          .sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left);
        left.forEach((line, index) => {
          push(line, `${bandIndex}.${zoneIndex}`, 0, 0, gutterLeft,
            index ? "same-flow" : "band-break");
          readingIDs.push(line.id);
        });
        right.forEach((line, index) => {
          push(line, `${bandIndex}.${zoneIndex}`, 1, gutterRight, page.viewport.width,
            index ? "same-flow" : left.length ? "column-break" : "band-break");
          readingIDs.push(line.id);
        });
      };
      spanningBlocks.forEach((block, blockIndex) => {
        emitColumns(zoneTop, block.top, blockIndex);
        const overlapping = lines.filter(line => !spanning.includes(line)
          && line.geometry.centerY >= block.top && line.geometry.centerY < block.bottom);
        [...block.lines, ...overlapping]
          .sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left)
          .forEach((line, index) => {
            push(line, `${bandIndex}.span.${blockIndex}`, -1, 0, page.viewport.width,
              index ? "same-flow" : "band-break");
            readingIDs.push(line.id);
          });
        zoneTop = block.bottom;
      });
      emitColumns(zoneTop, band.bottom, spanningBlocks.length);
      diagnostics.push({
        bandIndex, topRatio: band.top / page.viewport.height,
        bottomRatio: band.bottom / page.viewport.height,
        columnCount: 2, spanningBlockCount: spanningBlocks.length,
        readingOrderLineIDs: readingIDs
      });
    }
    return {
      lines: ordered,
      diagnostic: {
        pageIndex: page.pageIndex,
        width: page.viewport.width,
        height: page.viewport.height,
        rotation: page.viewport.rotation,
        columnCount: gutter ? 2 : 1,
        columnDetection: globalGutter ? "global" : recovery ? "selection-recovery" : "single",
        selectionGutter: recovery ? {
          leftRatio: Number(recovery.leftRatio.toFixed(4)),
          rightRatio: Number(recovery.rightRatio.toFixed(4)),
          centerRatio: Number(recovery.centerRatio.toFixed(4)),
          topRatio: Number((recovery.top / page.viewport.height).toFixed(4)),
          bottomRatio: Number((recovery.bottom / page.viewport.height).toFixed(4))
        } : null,
        recoveredLineCount: recovery ? ordered.filter(line => line.columnIndex === 0
          || line.columnIndex === 1).length : 0,
        gutter: gutter ? {
          leftRatio: Number(gutter.leftRatio.toFixed(4)),
          rightRatio: Number(gutter.rightRatio.toFixed(4)),
          centerRatio: Number(gutter.centerRatio.toFixed(4))
        } : null,
        bands: diagnostics,
        inputCharacterCount: page.items.length + page.rejectedItems.length,
        visualLineCount: page.lines.length
      }
    };
  }

  function isFormulaSeed(line, bodyHeight) {
    const stats = textStats(line.text);
    const flowWidth = Math.max(1, line.flowRight - line.flowLeft);
    const widthRatio = line.geometry.width / flowWidth;
    const equationNumber = /^\(?\s*\d{1,4}[a-z]?\s*\)?$/iu.test(normalizeText(line.text));
    const mathSymbols = ([...line.text].filter(character => /[=+−×÷<>≤≥∑∫√^~±∞≈≠∂α-ωΑ-Ω]/u.test(character))).length;
    const strongOperators = ([...line.text].filter(character => /[=×÷<>≤≥∑∫√^~±∞≈≠∂]/u.test(character))).length;
    const multiBaseline = line.baselineSpread > bodyHeight * 0.30
      || Math.max(...line.items.map(item => item.fontHeight))
        - Math.min(...line.items.map(item => item.fontHeight)) > bodyHeight * 0.32;
    const flowCenter = (line.flowLeft + line.flowRight) / 2;
    const centered = Math.abs(line.geometry.centerX - flowCenter) / flowWidth <= 0.13;
    const prose = (stats.words >= 7 && stats.letterRatio >= 0.56 && widthRatio >= 0.48)
      || (stats.words >= 4 && stats.letterRatio >= 0.62
        && /(?:\bwhere\b|\bwith\b|\bfor\b|\bis\b|\bare\b|[,.])/.test(normalizeText(line.text)));
    if (prose) return { seed: false, equationNumber };
    const geometricEvidence = centered || multiBaseline || widthRatio <= 0.55;
    const operatorFormula = (strongOperators >= 2 || stats.operators >= 3
      || (strongOperators >= 1 && stats.operatorRatio >= 0.11))
      && stats.words <= 5 && widthRatio <= 0.82 && geometricEvidence;
    const symbolFormula = mathSymbols >= 3 && stats.words <= 5
      && widthRatio <= 0.76 && geometricEvidence;
    const stackedFormula = multiBaseline && stats.words <= 5
      && (stats.operators || stats.digits || mathSymbols) && widthRatio <= 0.82;
    return { seed: operatorFormula || symbolFormula || stackedFormula, equationNumber };
  }

  function markFormulaRegions(orderedLines, bodyStyle) {
    const rowGroups = new Map();
    for (const line of orderedLines) {
      const key = `${line.visualRowID}:${line.flowKey}`;
      if (!rowGroups.has(key)) rowGroups.set(key, []);
      rowGroups.get(key).push(line);
    }
    const seeds = new Set();
    for (const lines of rowGroups.values()) {
      const analyses = lines.map(line => ({ line, ...isFormulaSeed(line, bodyStyle.height) }));
      const hasFormula = analyses.some(item => item.seed);
      const hasNumber = analyses.some(item => item.equationNumber);
      if (!hasFormula && !hasNumber) continue;
      if (hasFormula) {
        for (const item of analyses) {
          if (item.seed || item.equationNumber || textStats(item.line.text).words <= 3) seeds.add(item.line);
        }
      }
    }
    for (const seed of [...seeds]) {
      for (const line of orderedLines) {
        if (line.pageIndex !== seed.pageIndex || line.flowKey !== seed.flowKey || seeds.has(line)) continue;
        const verticalGap = line.geometry.top > seed.geometry.bottom
          ? line.geometry.top - seed.geometry.bottom
          : seed.geometry.top > line.geometry.bottom ? seed.geometry.top - line.geometry.bottom : 0;
        if (verticalGap > bodyStyle.height * 1.25) continue;
        const overlap = horizontalOverlap(line.geometry, seed.geometry);
        const sameCenter = Math.abs(line.geometry.centerX - seed.geometry.centerX) < bodyStyle.height * 5;
        const analysis = isFormulaSeed(line, bodyStyle.height);
        const stats = textStats(line.text);
        if ((overlap > 0 || sameCenter) && (analysis.seed || analysis.equationNumber
          || (stats.words <= 2 && stats.chars <= 24))) seeds.add(line);
      }
    }
    for (const line of seeds) {
      if (!line.exclusionReason) line.exclusionReason = "display-formula";
    }
  }

  function alignedAnchors(left, right, tolerance) {
    const leftAnchors = left.lines.map(line => line.geometry.left);
    const rightAnchors = right.lines.map(line => line.geometry.left);
    return leftAnchors.filter(anchor => rightAnchors.some(value => Math.abs(value - anchor) <= tolerance)).length;
  }

  function markTables(orderedLines, bodyStyle) {
    const visualRows = new Map();
    for (const line of orderedLines) {
      if (line.exclusionReason) continue;
      const key = `${line.visualRowID}:${line.flowKey}`;
      if (!visualRows.has(key)) visualRows.set(key, {
        pageIndex: line.pageIndex, flowKey: line.flowKey, top: line.geometry.top,
        bottom: line.geometry.bottom, lines: []
      });
      visualRows.get(key).lines.push(line);
    }
    const rowsByFlow = new Map();
    for (const row of visualRows.values()) {
      row.lines.sort((a, b) => a.geometry.left - b.geometry.left);
      row.text = row.lines.map(line => line.text).join(" ");
      row.stats = textStats(row.text);
      row.shortFraction = row.lines.filter(line => normalizeText(line.text).length <= 28).length
        / Math.max(1, row.lines.length);
      row.candidate = row.lines.length >= 3 && row.shortFraction >= 0.5
        && (row.stats.numericTokens >= 2 || row.stats.digitRatio >= 0.20
          || row.lines.every(line => line.geometry.width < bodyStyle.height * 12));
      const key = `${row.pageIndex}:${row.flowKey}`;
      if (!rowsByFlow.has(key)) rowsByFlow.set(key, []);
      rowsByFlow.get(key).push(row);
    }
    for (const rows of rowsByFlow.values()) {
      rows.sort((a, b) => a.top - b.top);
      let run = [];
      const flush = () => {
        if (run.length >= 3) {
          for (const row of run) for (const line of row.lines) {
            if (!line.exclusionReason) line.exclusionReason = "table-content";
          }
        }
        run = [];
      };
      for (const row of rows) {
        const previous = run[run.length - 1];
        const compatible = row.candidate && (!previous
          || (row.top - previous.bottom <= bodyStyle.height * 2
            && alignedAnchors(previous, row, bodyStyle.height * 1.2) >= 2));
        if (!compatible) flush();
        if (row.candidate) run.push(row);
      }
      flush();
    }
  }

  function markCaptionsAndFigureLabels(orderedLines, bodyStyle) {
    const captions = [];
    for (const line of orderedLines) {
      if (line.exclusionReason) continue;
      const lead = captionLead(line.text);
      if (!lead || lead.proseContinuation) continue;
      const previous = orderedLines.slice(0, line.orderIndex).reverse().find(candidate =>
        !candidate.exclusionReason && candidate.pageIndex === line.pageIndex
        && candidate.flowKey === line.flowKey) || null;
      if (previous) {
        const gap = line.geometry.top - previous.geometry.bottom;
        const heightDifference = Math.abs(previous.fontHeight - line.fontHeight)
          / Math.max(1, previous.fontHeight, line.fontHeight);
        const previousFlowWidth = Math.max(1, previous.flowRight - previous.flowLeft);
        const previousFill = (previous.geometry.right - previous.flowLeft) / previousFlowWidth;
        const continuous = gap <= bodyStyle.height * 1.35 && heightDifference <= 0.24
          && (!endsTerminal(previous.text) || previousFill >= 0.82
            || /(?:\bin|\bsee|\bshown|\bdepicted|\bpresented)\s*$/iu.test(previous.text));
        if (continuous) {
          line.retainedCaptionReason = "preceding-body-continuation";
          continue;
        }
      }
      const flowWidth = Math.max(1, line.flowRight - line.flowLeft);
      const isolated = line.geometry.width / flowWidth < 0.90
        || line.fontHeight <= bodyStyle.height * 0.96;
      if (!isolated && !lead.strongSeparator) continue;
      line.exclusionReason = lead.kind === "table" ? "table-caption" : "figure-caption";
      captions.push(line);
      let count = 0;
      for (const next of orderedLines) {
        if (next.orderIndex <= line.orderIndex || next.pageIndex !== line.pageIndex
          || next.flowKey !== line.flowKey || next.exclusionReason) continue;
        if (next.geometry.top - line.geometry.bottom > bodyStyle.height * 3.2 || count >= 2) break;
        const stats = textStats(next.text);
        if (next.fontHeight <= bodyStyle.height * 0.98 && stats.words <= 18
          && next.geometry.width / flowWidth < 0.92) {
          next.exclusionReason = line.exclusionReason;
          count++;
        }
        else break;
      }
    }
    for (const caption of captions.filter(line => line.exclusionReason === "figure-caption")) {
      for (const line of orderedLines) {
        const sameSide = (line.geometry.centerX < caption.flowRight / 2)
          === (caption.geometry.centerX < caption.flowRight / 2);
        if (line.pageIndex !== caption.pageIndex || !sameSide
          || line.exclusionReason || line.geometry.bottom > caption.geometry.top
          || caption.geometry.top - line.geometry.bottom > bodyStyle.height * 8) continue;
        const stats = textStats(line.text);
        const sparse = stats.words <= 4 && (line.fontHeight < bodyStyle.height * 0.96
          || line.geometry.width < (line.flowRight - line.flowLeft) * 0.48);
        if (sparse) line.exclusionReason = "figure-label";
      }
    }
  }

  function markFootnotes(orderedLines, bodyStyle, pages) {
    for (const line of orderedLines) {
      if (line.exclusionReason) continue;
      const page = pages[line.pageIndex];
      if (!page) continue;
      const explicitFootnote = /^(?:[*∗†‡]|\d{1,2})?\s*(?:corresponding\s+author|e-?mail\b)/iu
        .test(normalizeText(line.text));
      if ((line.geometry.bottomRatio > 0.78 && line.fontHeight < bodyStyle.height * 0.82
        && line.geometry.width / page.viewport.width < 0.72)
        || (explicitFootnote && normalizeText(line.text).length <= 160
          && line.geometry.width / page.viewport.width < 0.78)) {
        line.exclusionReason = "footnote";
      }
    }
  }

  function markPublisherMetadata(orderedLines, bodyStyle) {
    for (const line of orderedLines) {
      if (line.exclusionReason) continue;
      const text = normalizeText(line.text);
      const metadata = /(?:https?:\/\/|www\.|doi(?:\.org|\s*:)|\b\S+@\S+\b|\borcid\b|©|copyright|all\s+rights\s+reserved|see\s+front\s+matter|available\s+online|received\s+\d|accepted\s+\d|article\s+history)/iu
        .test(text);
      if (metadata && (line.fontHeight <= bodyStyle.height * 0.98
        || line.geometry.topRatio < 0.16 || line.geometry.bottomRatio > 0.82
        || text.length <= 180)) line.exclusionReason = "publisher-metadata";
    }
  }

  function collectRetainedAmbiguities(orderedLines, bodyStyle) {
    const retained = [];
    for (const line of orderedLines) {
      if (line.exclusionReason) continue;
      const stats = textStats(line.text);
      const formula = isFormulaSeed(line, bodyStyle.height);
      const caption = captionLead(line.text);
      let reason = "";
      const evidence = [];
      if (!formula.seed && stats.operators >= 1 && stats.words <= 7
        && line.geometry.width < (line.flowRight - line.flowLeft) * 0.82) {
        reason = "possible-display-formula";
        evidence.push("operator-and-compact-layout");
      }
      else if (caption) {
        reason = caption.proseContinuation ? "caption-like-prose" : "possible-caption";
        evidence.push(line.retainedCaptionReason || (caption.proseContinuation
          ? "natural-language-continuation" : "caption-prefix-only"));
      }
      else if (line.largeGapCount >= 2 && (stats.numericTokens >= 2 || stats.digitRatio >= 0.22)) {
        reason = "possible-table-row";
        evidence.push("aligned-gaps-and-numeric-cells");
      }
      if (!reason) continue;
      retained.push({
        reason,
        pageIndex: line.pageIndex,
        lineID: line.id,
        evidence,
        sampleText: normalizeText(line.text).slice(0, 220)
      });
    }
    return retained;
  }

  function outlineMatchScore(line, hint) {
    if (line.pageIndex !== hint.pageIndex) return 0;
    const left = canonicalHeading(line.text);
    const right = canonicalHeading(hint.title);
    if (!left || !right) return 0;
    if (left === right) return 3;
    if (left.includes(right) || right.includes(left)) return 2;
    return 0;
  }

  function markBodyBoundaries(orderedLines, bodyStyle, outlineHints) {
    const available = orderedLines.filter(line => !line.exclusionReason);
    const startCandidates = available.filter(line => isStartHeading(line.text)
      && isLikelyHeading(line, bodyStyle.height));
    let startLine = startCandidates[0] || null;
    let reason = startLine ? "recognized-start-heading" : "";
    if (!startLine) {
      const bodyOutline = (outlineHints || []).filter(hint => isStartHeading(hint.title));
      const ranked = available.flatMap(line => bodyOutline.map(hint => ({
        line, score: outlineMatchScore(line, hint)
      }))).filter(item => item.score).sort((a, b) => b.score - a.score || a.line.orderIndex - b.line.orderIndex);
      startLine = ranked[0]?.line || null;
      if (startLine) reason = "pdf-outline";
    }
    if (!startLine) {
      startLine = available.find(line => isNumberedHeading(line.text)
        && isLikelyHeading(line, bodyStyle.height)) || null;
      if (startLine) reason = "numbered-heading";
    }
    if (!startLine) {
      const error = new Error("无法可靠确定章节正文起点；为避免把标题、作者或摘要误作正文，已停止提取。");
      error.code = "body-boundary-unresolved";
      throw error;
    }
    const terminal = available.find(line => line.orderIndex > startLine.orderIndex
      && isTerminalHeading(line.text) && isLikelyHeading(line, bodyStyle.height)) || null;
    for (const line of orderedLines) {
      if (line.orderIndex < startLine.orderIndex && !line.exclusionReason) line.exclusionReason = "front-matter";
      else if (line === startLine && !line.exclusionReason) line.exclusionReason = "section-heading";
      else if (terminal && line.orderIndex >= terminal.orderIndex && !line.exclusionReason) {
        line.exclusionReason = "terminal-section";
      }
      else if (line.orderIndex > startLine.orderIndex && (!terminal || line.orderIndex < terminal.orderIndex)
        && !line.exclusionReason && isLikelyHeading(line, bodyStyle.height)) {
        line.exclusionReason = "section-heading";
      }
    }
    return {
      start: { lineID: startLine.id, pageIndex: startLine.pageIndex, reason, text: startLine.text.slice(0, 180) },
      end: terminal ? {
        lineID: terminal.id, pageIndex: terminal.pageIndex,
        reason: "terminal-heading", text: terminal.text.slice(0, 180)
      } : null
    };
  }

  function computeFlowProfiles(lines, bodyHeight) {
    const groups = new Map();
    for (const line of lines) {
      if (!groups.has(line.flowKey)) groups.set(line.flowKey, []);
      groups.get(line.flowKey).push(line);
    }
    const profiles = new Map();
    for (const [key, source] of groups) {
      const ordered = [...source].sort((a, b) => a.geometry.top - b.geometry.top);
      const gaps = [];
      for (let index = 1; index < ordered.length; index++) {
        const gap = ordered[index].geometry.top - ordered[index - 1].geometry.bottom;
        if (gap >= -bodyHeight * 0.35 && gap <= bodyHeight * 1.4) gaps.push(gap);
      }
      profiles.set(key, {
        baselineLeft: median(source.map(line => line.geometry.left)) || source[0]?.flowLeft || 0,
        normalGap: median(gaps) || bodyHeight * 0.35
      });
    }
    return profiles;
  }

  function shouldMerge(previous, current, profiles, bodyHeight) {
    if (!previous || !current) return { merge: false, reason: "start" };
    if (current.blockingBoundaryBefore) return { merge: false, reason: "excluded-boundary" };
    const heightDifference = Math.abs(previous.fontHeight - current.fontHeight)
      / Math.max(1, previous.fontHeight, current.fontHeight);
    const sameFlow = previous.flowKey === current.flowKey;
    if (sameFlow) {
      if (heightDifference > CONFIG.bodyHeightTolerance) return { merge: false, reason: "font-change" };
      const profile = profiles.get(current.flowKey) || { baselineLeft: current.flowLeft, normalGap: bodyHeight * 0.35 };
      const gap = current.geometry.top - previous.geometry.bottom;
      if (gap > Math.max(profile.normalGap * CONFIG.lineGapMultiplier, bodyHeight * 0.95)) {
        return { merge: false, reason: "large-line-gap" };
      }
      const indent = current.geometry.left - profile.baselineLeft;
      const flowWidth = Math.max(1, previous.flowRight - previous.flowLeft);
      const fill = (previous.geometry.right - previous.flowLeft) / flowWidth;
      if (indent > bodyHeight * CONFIG.paragraphIndentEm && endsTerminal(previous.text) && fill < 0.92) {
        return { merge: false, reason: "first-line-indent" };
      }
      if (previous.hasEOL && endsTerminal(previous.text) && fill < 0.72
        && gap > profile.normalGap * 1.12) return { merge: false, reason: "completed-paragraph" };
      return { merge: true, reason: "same-flow-continuation" };
    }
    const transition = current.pageIndex !== previous.pageIndex ? "page-break"
      : previous.flowKey !== current.flowKey ? "column-break" : current.transitionBefore;
    if (!new Set(["column-break", "page-break"]).has(transition)) {
      return { merge: false, reason: transition || "flow-break" };
    }
    if (heightDifference > CONFIG.crossFlowHeightTolerance) return { merge: false, reason: "cross-flow-font-change" };
    const profile = profiles.get(current.flowKey) || { baselineLeft: current.flowLeft };
    if (current.geometry.left - profile.baselineLeft > bodyHeight * CONFIG.paragraphIndentEm) {
      return { merge: false, reason: "cross-flow-indent" };
    }
    const flowWidth = Math.max(1, previous.flowRight - previous.flowLeft);
    const fill = (previous.geometry.right - previous.flowLeft) / flowWidth;
    const hyphen = /[\u00ad-]$/u.test(previous.text) && /^\p{Ll}/u.test(current.text);
    if (hyphen || !endsTerminal(previous.text) || fill >= CONFIG.crossFlowFillRatio) {
      return { merge: true, reason: transition === "page-break"
        ? "page-continuation" : "column-continuation" };
    }
    return { merge: false, reason: "completed-flow" };
  }

  function compactRects(items) {
    const sorted = [...items].sort((left, right) => left.geometry.left - right.geometry.left);
    const groups = [];
    for (const item of sorted) {
      const last = groups[groups.length - 1];
      if (!last || item.geometry.left - last.viewportRight > Math.max(1, item.fontHeight * 0.55)) {
        groups.push({ items: [item], viewportRight: item.geometry.right });
      }
      else {
        last.items.push(item);
        last.viewportRight = Math.max(last.viewportRight, item.geometry.right);
      }
    }
    return groups.map(group => boundingRect(group.items.map(item => item.pdfRect))).filter(Boolean);
  }

  function paragraphPosition(lines) {
    const byPage = new Map();
    for (const line of lines) {
      if (!byPage.has(line.pageIndex)) byPage.set(line.pageIndex, []);
      byPage.get(line.pageIndex).push(...compactRects(line.items));
    }
    const fragments = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([pageIndex, rects]) => ({
      pageIndex, rects, coordinateSource: "zotero-page-char"
    }));
    return {
      pageIndex: fragments[0]?.pageIndex || 0,
      rects: fragments[0]?.rects || [],
      fragments
    };
  }

  function joinFrontMatterLines(lines) {
    let text = "";
    let previous = null;
    let transformedHyphenCount = 0;
    for (const line of lines || []) {
      if (!text) {
        text = line.text;
        previous = line;
        continue;
      }
      const joined = lineJoin(text, line.text, previous, line);
      text = joined.text;
      if (joined.dehyphenated) transformedHyphenCount++;
      previous = line;
    }
    return { text: normalizeText(text), transformedHyphenCount };
  }

  function isFrontMatterNoise(value) {
    return /(?:https?:\/\/|www\.|doi(?:\.org|\s*:)|\b\S+@\S+\b|\borcid\b|copyright|all\s+rights\s+reserved|received\s+\d|accepted\s+\d|corresponding\s+author|university|department|faculty|school|college|institute|关键词|关键词：)/iu
      .test(normalizeText(value));
  }

  function isFrontMatterArtifactLine(line, bodyStyle) {
    const text = normalizeText(line?.text);
    const compact = text.replace(/\s+/gu, "");
    return compact.length <= 2
      && /[\p{L}\p{N}]/u.test(compact)
      && line.geometry.width <= Math.max(line.fontHeight * 1.8, bodyStyle.height * 2)
      && (line.fontHeight >= bodyStyle.height * 1.35
        || line.geometry.leftRatio > 0.72 || line.geometry.rightRatio < 0.28);
  }

  function isFrontMatterLine(line) {
    return Boolean(line && (!line.exclusionReason || line.exclusionReason === "front-matter"));
  }

  function frontMatterLineSort(left, right) {
    return left.pageIndex - right.pageIndex
      || left.geometry.top - right.geometry.top
      || left.geometry.left - right.geometry.left
      || left.orderIndex - right.orderIndex;
  }

  function frontMatterColumnSide(line) {
    const pageWidth = Math.max(1, Number(
      line?.pageWidth || line?.geometry?.right || line?.flowRight || 1
    ));
    const rect = line?.geometry;
    const gutter = Number(line?.pageGutter);
    if (rect && Number.isFinite(gutter) && gutter > 0 && gutter < pageWidth) {
      const crossesGutter = rect.left < gutter && rect.right > gutter;
      if (crossesGutter) return -1;
      const tolerance = Math.max(pageWidth * 0.012, Number(line?.fontHeight || 1) * 0.75);
      if (rect.centerX <= gutter - tolerance) return 0;
      if (rect.centerX >= gutter + tolerance) return 1;
    }
    if (line?.columnIndex === 0 || line?.columnIndex === 1) return line.columnIndex;
    const widthRatio = rect?.width / pageWidth;
    if (widthRatio >= 0.82) return -1;
    const centerRatio = Number(rect?.centerX || 0) / pageWidth;
    if (centerRatio <= 0.42) return 0;
    if (centerRatio >= 0.58) return 1;
    return line.columnIndex === -1 ? -1 : line.columnIndex;
  }

  function frontMatterRegionCompatible(left, right) {
    if (!left || !right || left.pageIndex !== right.pageIndex) return false;
    const leftSide = frontMatterColumnSide(left);
    const rightSide = frontMatterColumnSide(right);
    if (leftSide >= 0 && rightSide >= 0 && leftSide !== rightSide) return false;
    const flowWidth = Math.max(1, left.flowRight - left.flowLeft, right.flowRight - right.flowLeft);
    if (Math.abs(left.geometry.left - right.geometry.left)
      <= Math.max(left.fontHeight, right.fontHeight, 1) * 3 ||
      Math.abs(left.geometry.right - right.geometry.right) <= flowWidth * 0.04) return true;
    if (left.flowKey && right.flowKey && left.flowKey === right.flowKey) return true;
    if (left.columnIndex === right.columnIndex) return true;
    if (left.columnIndex === -1 || right.columnIndex === -1) {
      const overlap = horizontalOverlap(left.geometry, right.geometry);
      return overlap / Math.max(1, Math.min(left.geometry.width, right.geometry.width)) >= 0.30;
    }
    return false;
  }

  function frontMatterAuthorLike(value) {
    const text = normalizeText(value);
    const commaCount = (text.match(/,/gu) || []).length;
    const personName = /\b[A-Z][\p{Ll}]{1,}\s+[A-Z][\p{Ll}]{1,}\b/u.test(text);
    return /(?:https?:\/\/|www\.|\b\S+@\S+\b|\b(?:university|department|faculty|school|college|institute|laboratory|centre|center)\b|\borcid\b)/iu
      .test(text) || (commaCount >= 2 && textStats(text).words >= 3)
      || (commaCount >= 1 && personName);
  }

  function frontMatterAuthorNameLike(value) {
    const tokens = normalizeText(value)
      .replace(/[,*†‡§\[\](){}]/gu, " ")
      .split(/\s+/u)
      .filter(Boolean);
    if (tokens.length < 2 || tokens.length > 3) return false;
    return tokens.slice(0, 2).every(token => /^[A-Z][\p{Ll}]{1,}$/u.test(token))
      && (tokens.length === 2 || /^[a-z]$/u.test(tokens[2]));
  }

  function frontMatterTrailingAuthorNameLike(line, allLines) {
    if (!frontMatterAuthorNameLike(line?.text)) return false;
    const previous = allLines.filter(candidate => candidate.pageIndex === line.pageIndex
      && candidate.geometry.top < line.geometry.top)
      .sort((left, right) => right.geometry.top - left.geometry.top)[0];
    return Boolean(previous && (frontMatterAuthorLike(previous.text)
      || line.fontHeight < previous.fontHeight * 0.88));
  }

  function frontMatterBlock(lines, bodyStyle) {
    const ordered = [...lines].sort(frontMatterLineSort);
    const joined = joinFrontMatterLines(ordered);
    const rect = boundingRect(ordered.map(line => [
      line.geometry.left, line.geometry.top, line.geometry.right, line.geometry.bottom
    ]));
    const maxFlowWidth = Math.max(1, ...ordered.map(line => line.flowRight - line.flowLeft));
    const centered = ordered.every(line =>
      Math.abs(line.geometry.centerX - (line.flowLeft + line.flowRight) / 2)
        <= Math.max(bodyStyle.height * 3, (line.flowRight - line.flowLeft) * 0.18));
    const sourceCharIDs = [...new Set(ordered.flatMap(line => line.itemIDs))];
    const sourceLineIDs = ordered.map(line => line.id);
    return {
      text: joined.text,
      sourceCharIDs,
      sourceLineIDs,
      pageIndexes: [...new Set(ordered.map(line => line.pageIndex))].sort((a, b) => a - b),
      pageIndex: ordered[0]?.pageIndex ?? 0,
      columnIndex: ordered.every(line => line.columnIndex === ordered[0]?.columnIndex)
        ? ordered[0]?.columnIndex ?? 0 : -1,
      flowKeys: [...new Set(ordered.map(line => line.flowKey).filter(Boolean))],
      lineCount: ordered.length,
      fontHeight: median(ordered.map(line => line.fontHeight)),
      widthRatio: rect ? rect[2] - rect[0] : 0,
      flowWidth: maxFlowWidth,
      centered,
      geometry: rect ? {
        left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
        width: rect[2] - rect[0], height: rect[3] - rect[1]
      } : null,
      position: frontMatterPosition(ordered),
      lines: ordered
    };
  }

  function frontMatterPosition(lines) {
    const byPage = new Map();
    const sourceLineIDs = [];
    for (const line of [...(lines || [])].sort(frontMatterLineSort)) {
      const rect = boundingRect((line.items || []).map(item => item.pdfRect));
      if (!rect) continue;
      if (!byPage.has(line.pageIndex)) byPage.set(line.pageIndex, []);
      byPage.get(line.pageIndex).push({
        rect,
        sourceCharCount: (line.items || []).filter(item => !/^\s+$/u.test(item.rawText || item.text)).length,
        sourceLineID: line.id
      });
      sourceLineIDs.push(line.id);
    }
    const fragments = [...byPage.entries()].sort((left, right) => left[0] - right[0])
      .map(([pageIndex, entries]) => ({
        pageIndex,
        rects: entries.map(entry => entry.rect),
        sourceCharCount: entries.reduce((sum, entry) => sum + entry.sourceCharCount, 0),
        lineCharCounts: entries.map(entry => entry.sourceCharCount),
        sourceLineIDs: entries.map(entry => entry.sourceLineID)
      }));
    return {
      pageIndex: fragments[0]?.pageIndex || 0,
      rects: fragments[0]?.rects || [],
      fragments,
      sourceLineIDs
    };
  }

  function buildFrontMatterBlocks(orderedLines, bodyStyle) {
    const lines = orderedLines.filter(isFrontMatterLine).sort(frontMatterLineSort);
    const blocks = [];
    for (const line of lines) {
      const last = blocks.at(-1);
      const previous = last?.lines?.at(-1) || null;
      const gap = previous && previous.pageIndex === line.pageIndex
        ? line.geometry.top - previous.geometry.bottom : Infinity;
      const fontDifference = previous
        ? Math.abs(previous.fontHeight - line.fontHeight)
          / Math.max(1, previous.fontHeight, line.fontHeight) : Infinity;
      const headingBoundary = previous && (isAbstractHeading(previous.text)
        || isAbstractHeading(line.text) || isStartHeading(previous.text)
        || isStartHeading(line.text) || isTerminalHeading(previous.text)
        || isTerminalHeading(line.text));
      const authorBoundary = previous && (frontMatterAuthorLike(previous.text)
        !== frontMatterAuthorLike(line.text));
      const compatible = previous && !headingBoundary && !authorBoundary
        && frontMatterRegionCompatible(previous, line)
        && gap <= Math.max(bodyStyle.height * 2.4, line.fontHeight * 2.8, 18)
        && fontDifference <= 0.35;
      if (!compatible) blocks.push({ lines: [line] });
      else last.lines.push(line);
    }
    return blocks.map(block => frontMatterBlock(block.lines, bodyStyle));
  }

  function frontMatterBefore(left, right) {
    return left.pageIndex < right.pageIndex
      || (left.pageIndex === right.pageIndex && left.geometry.top < right.geometry.top);
  }

  function findFrontMatterBodyStart(lines, bodyStyle, bodyBoundary) {
    const fromBoundary = bodyBoundary?.start?.lineID
      ? lines.find(line => line.id === bodyBoundary.start.lineID) : null;
    if (fromBoundary) return fromBoundary;
    const direct = lines.filter(line => !line.exclusionReason
      && isStartHeading(line.text) && isLikelyHeading(line, bodyStyle.height))
      .sort(frontMatterLineSort)[0];
    if (direct) return direct;
    return lines.filter(line => !line.exclusionReason
      && !frontMatterAuthorLike(line.text)
      && !isFrontMatterNoise(line.text)
      && isNumberedHeading(line.text) && isLikelyHeading(line, bodyStyle.height))
      .sort(frontMatterLineSort)[0] || null;
  }

  function abstractSpanSeedCompatible(line, heading) {
    if (!line?.geometry || !heading?.geometry || line.pageIndex !== heading.pageIndex) return false;
    const pageWidth = Math.max(1, Number(line.pageWidth || heading.pageWidth || 1));
    const gutter = Number(line.pageGutter ?? heading.pageGutter);
    if (!(Number.isFinite(gutter) && gutter > 0 && gutter < pageWidth)) return false;
    const height = Math.max(1, Number(line.fontHeight || heading.fontHeight || 1));
    const crossesGutter = line.geometry.left < gutter - height * 0.5
      && line.geometry.right > gutter + height * 0.5;
    const leftTolerance = Math.max(pageWidth * 0.025, height * 2);
    return crossesGutter
      && line.geometry.width / pageWidth >= 0.62
      && Math.abs(line.geometry.left - heading.geometry.left) <= leftTolerance;
  }

  function abstractSpanSeedPair(lines, heading) {
    const seeds = (lines || []).slice(0, 2);
    if (seeds.length < 2 || !seeds.every(line => abstractSpanSeedCompatible(line, heading))) return [];
    const [first, second] = seeds;
    const pageWidth = Math.max(1, Number(first.pageWidth || heading.pageWidth || 1));
    const height = Math.max(1, Number(first.fontHeight || 1), Number(second.fontHeight || 1));
    const leftTolerance = Math.max(pageWidth * 0.025, height * 2);
    const verticalGap = second.geometry.top - first.geometry.bottom;
    return Math.abs(first.geometry.left - second.geometry.left) <= leftTolerance
      && verticalGap >= -height * 0.35 && verticalGap <= height * 2.2 ? seeds : [];
  }

  function abstractSpanTailCompatible(line, heading, acceptedLines) {
    const seeds = abstractSpanSeedPair(acceptedLines, heading);
    if (!seeds.length || !line?.geometry || line.pageIndex !== heading.pageIndex) return false;
    const pageWidth = Math.max(1, Number(line.pageWidth || heading.pageWidth || 1));
    const height = Math.max(1, Number(line.fontHeight || 1));
    const anchorLeft = median(seeds.map(seed => seed.geometry.left));
    const anchorRight = Math.max(...seeds.map(seed => seed.geometry.right));
    const bandWidth = Math.max(1, anchorRight - anchorLeft);
    const leftTolerance = Math.max(pageWidth * 0.025, height * 2);
    const previous = acceptedLines.at(-1);
    const verticalGap = previous ? line.geometry.top - previous.geometry.bottom : Infinity;
    const overlap = Math.max(0, Math.min(line.geometry.right, anchorRight)
      - Math.max(line.geometry.left, anchorLeft));
    return Math.abs(line.geometry.left - anchorLeft) <= leftTolerance
      && line.geometry.width >= Math.max(height * 4, bandWidth * 0.10)
      && overlap / Math.min(Math.max(1, line.geometry.width), bandWidth) >= 0.35
      && verticalGap >= -height * 0.35 && verticalGap <= height * 2.2;
  }

  function abstractContinuationRegion(line, heading, pageLines) {
    const headingSide = frontMatterColumnSide(heading);
    const lineSide = frontMatterColumnSide(line);
    if (headingSide >= 0) {
      if (lineSide >= 0) return headingSide === lineSide;
      if (abstractSpanSeedCompatible(line, heading)) return true;
      const bandLeft = headingSide === 0 ? 0 : Number(heading.pageGutter || heading.flowLeft || 0);
      const bandRight = headingSide === 0
        ? Number(heading.pageGutter || heading.flowRight || heading.pageWidth)
        : Number(heading.pageWidth || heading.flowRight);
      const band = {
        left: bandLeft,
        right: Math.max(bandLeft + 1, bandRight)
      };
      const lineWidth = Math.max(1, line.geometry.right - line.geometry.left);
      const overlap = horizontalOverlap(line.geometry, band);
      return overlap / Math.min(lineWidth, band.right - band.left) >= 0.35
        && (line.geometry.centerX >= band.left - line.fontHeight * 2
          && line.geometry.centerX <= band.right + line.fontHeight * 2);
    }
    const sideCounts = new Map();
    for (const candidate of pageLines || []) {
      const side = frontMatterColumnSide(candidate);
      if (side >= 0) sideCounts.set(side, (sideCounts.get(side) || 0) + 1);
    }
    const dominantSide = [...sideCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (Number.isInteger(dominantSide) && lineSide >= 0) return lineSide === dominantSide;
    return line.pageIndex === heading.pageIndex && frontMatterRegionCompatible(line, heading);
  }

  function isAbstractBodyBoundary(value) {
    const text = normalizeText(value);
    const compact = compactSpacedHeading(text);
    return /^(?:keywords?|key\s*words?|article\s*info|articleinfo)\b/iu.test(text)
      || /^(?:copyright|©|all\s+rights\s+reserved)\b/iu.test(text)
      || /^(?:received|accepted|available\s+online|published\s+online)\b/iu.test(text)
      || /^(?:keywords?|key\s*words?|articleinfo)[:：]/iu.test(compact);
  }

  function trimPublisherTailLine(line) {
    const items = line?.items || [];
    let markerIndex = -1;
    for (let index = 0; index < items.length; index++) {
      const raw = String(items[index].rawText || items[index].text || "");
      const preview = items.slice(index, index + 28)
        .map(item => String(item.rawText || item.text || "")).join("");
      if (/©|copyright/iu.test(raw) || /^(?:copyright|all\s+rights\s+reserved)\b/iu.test(preview)) {
        markerIndex = index;
        break;
      }
    }
    if (markerIndex <= 0) return null;
    const keptItems = items.slice(0, markerIndex);
    const viewportRect = boundingRect(keptItems.map(item => item.viewportRect));
    const pdfRect = boundingRect(keptItems.map(item => item.pdfRect));
    if (!viewportRect || !pdfRect) return null;
    const typicalHeight = median(keptItems.map(item => item.fontHeight)) || line.fontHeight;
    const mapped = buildLineText(keptItems, typicalHeight);
    return {
      ...line,
      text: mapped.text,
      items: keptItems,
      itemIDs: keptItems.map(item => item.id),
      pdfRects: keptItems.map(item => item.pdfRect),
      viewportRect,
      geometry: geometry(viewportRect, line.pageWidth, line.pageHeight),
      fontHeight: typicalHeight,
      largeGapCount: mapped.largeGapCount,
      hasEOL: true,
      paragraphHintAfter: false
    };
  }

  function collectAbstractBodyLines(orderedLines, heading, bodyStart, bodyStyle) {
    if (!heading) return [];
    const lines = orderedLines.filter(isFrontMatterLine).sort(frontMatterLineSort);
    const pageGroups = new Map();
    for (const line of lines) {
      if (!pageGroups.has(line.pageIndex)) pageGroups.set(line.pageIndex, []);
      pageGroups.get(line.pageIndex).push(line);
    }
    const result = [];
    for (const line of lines) {
      if (line.pageIndex < heading.pageIndex
        || (line.pageIndex === heading.pageIndex && line.geometry.top <= heading.geometry.bottom)) continue;
      if (bodyStart && (line.pageIndex > bodyStart.pageIndex
        || (line.pageIndex === bodyStart.pageIndex
          && line.geometry.top >= bodyStart.geometry.top - bodyStyle.height * 0.25))) break;
      if (!abstractContinuationRegion(line, heading, pageGroups.get(line.pageIndex) || [])
        && !abstractSpanTailCompatible(line, heading, result)) continue;
      if (isAbstractBodyBoundary(line.text)) break;
      if (isAbstractHeading(line.text) || isTerminalHeading(line.text)) break;
      if (isLikelyHeading(line, bodyStyle.height)) break;
      if (line.exclusionReason && line.exclusionReason !== "front-matter") {
        const trimmed = line.exclusionReason === "publisher-metadata"
          ? trimPublisherTailLine(line) : null;
        if (trimmed) result.push(trimmed);
        continue;
      }
      result.push(line);
    }
    return result;
  }

  function abstractFlowBand(line, side) {
    if (!line) return null;
    const pageWidth = Math.max(1, Number(line.pageWidth || line.geometry?.right || 1));
    const gutter = Number(line.pageGutter);
    const hasGutter = Number.isFinite(gutter) && gutter > 0 && gutter < pageWidth;
    if (side === 0) {
      return { left: 0, right: hasGutter
        ? gutter : Number(line.flowRight || pageWidth / 2) };
    }
    if (side === 1) {
      return { left: hasGutter
        ? gutter : Number(line.flowLeft || pageWidth / 2), right: pageWidth };
    }
    return {
      left: Number(line.geometry?.left || 0),
      right: Number(line.geometry?.right || pageWidth)
    };
  }

  function buildAbstractFlow(heading, bodyLines, layoutLines) {
    if (!heading) return null;
    const spanBodySeeds = abstractSpanSeedPair(bodyLines, heading);
    const spanMode = spanBodySeeds.length === 2;
    const seeds = [heading, ...(spanMode ? spanBodySeeds : (bodyLines || []).slice(0, 2))]
      .filter(Boolean);
    const headingSide = frontMatterColumnSide(heading);
    const bodySides = (bodyLines || []).slice(0, 3)
      .map(line => frontMatterColumnSide(line)).filter(side => side >= 0);
    const sideCounts = new Map();
    for (const side of bodySides) sideCounts.set(side, (sideCounts.get(side) || 0) + 1);
    const dominantBody = [...sideCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    const columnIndex = spanMode ? -1 : (headingSide >= 0 ? headingSide
      : (Number.isInteger(dominantBody) ? dominantBody : -1));
    const bodySeedCount = bodySides.filter(side => side === columnIndex).length;
    const confidence = spanMode ? "high" : columnIndex >= 0 && bodySeedCount >= 2
      ? "high" : columnIndex >= 0 && bodySeedCount >= 1 ? "medium" : "low";
    const pages = [...new Set((layoutLines || []).map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b);
    const pageBands = pages.map(pageIndex => {
      const pageLines = (layoutLines || []).filter(line => Number(line.pageIndex || 0) === pageIndex);
      const sameSide = columnIndex >= 0
        ? pageLines.filter(line => frontMatterColumnSide(line) === columnIndex)
        : [];
      const pageSpanSeeds = spanMode
        ? spanBodySeeds.filter(line => Number(line.pageIndex || 0) === pageIndex) : [];
      const seed = seeds.find(line => Number(line.pageIndex || 0) === pageIndex
        && (columnIndex < 0 || frontMatterColumnSide(line) === columnIndex))
        || sameSide[0] || seeds[0];
      const spanAnchorLeft = pageSpanSeeds.length
        ? median(pageSpanSeeds.map(line => line.geometry.left)) : null;
      const spanAnchorRight = pageSpanSeeds.length
        ? median(pageSpanSeeds.map(line => line.geometry.right)) : null;
      const band = spanMode && pageSpanSeeds.length ? {
        left: Math.min(...pageSpanSeeds.map(line => line.geometry.left)),
        right: Math.max(...pageSpanSeeds.map(line => line.geometry.right))
      } : abstractFlowBand(seed, columnIndex);
      return {
        pageIndex,
        left: band?.left ?? 0,
        right: band?.right ?? Number(seed?.pageWidth || 1),
        columnIndex,
        anchorLeft: spanAnchorLeft ?? Number(seed?.geometry?.left || band?.left || 0),
        anchorRight: spanAnchorRight ?? Number(seed?.geometry?.right || band?.right || 1)
      };
    });
    return {
      mode: spanMode ? "span" : "column",
      columnIndex,
      seedLineIDs: seeds.map(line => String(line.id)),
      pageBands,
      confidence
    };
  }

  function serializeFrontMatterBlock(block) {
    return {
      text: block.text,
      sourceCharIDs: block.sourceCharIDs,
      sourceLineIDs: block.sourceLineIDs,
      sourceLineCharIDs: block.lines.map(line => line.itemIDs.slice()),
      pageIndexes: block.pageIndexes,
      pageIndex: block.pageIndex,
      columnIndex: block.columnIndex,
      flowKeys: block.flowKeys,
      lineCount: block.lineCount,
      fontHeight: block.fontHeight,
      widthRatio: block.geometry && block.flowWidth
        ? block.geometry.width / block.flowWidth : 0,
      centered: block.centered,
      geometry: block.geometry,
      position: block.position
    };
  }

  function serializeFrontMatterLine(line) {
    return {
      id: line.id,
      pageIndex: line.pageIndex,
      pageWidth: line.pageWidth,
      pageHeight: line.pageHeight,
      pageGutter: Number.isFinite(line.pageGutter) ? line.pageGutter : null,
      text: line.text,
      itemIDs: line.itemIDs.slice(),
      columnIndex: line.columnIndex,
      flowKey: line.flowKey,
      flowLeft: line.flowLeft,
      flowRight: line.flowRight,
      geometry: line.geometry,
      fontHeight: line.fontHeight,
      hasEOL: line.hasEOL,
      paragraphHintAfter: line.paragraphHintAfter,
      exclusionReason: line.exclusionReason || null
    };
  }

  function inferFrontMatterGutter(lines, page) {
    const candidates = lines.filter(line => line.geometry.topRatio >= 0.16
      && line.geometry.topRatio <= 0.60
      && line.geometry.width / page.viewport.width >= 0.08
      && line.geometry.width / page.viewport.width <= 0.68
      && textStats(line.text).letters >= 3);
    if (candidates.length < 6) return null;
    let best = null;
    for (const leftLine of candidates) {
      for (const rightLine of candidates) {
        const gap = rightLine.geometry.left - leftLine.geometry.right;
        if (!(gap > 0)) continue;
        if (gap < page.viewport.width * 0.05) continue;
        const center = (leftLine.geometry.right + rightLine.geometry.left) / 2;
        if (center < page.viewport.width * 0.25 || center > page.viewport.width * 0.75) continue;
        const leftCount = candidates.filter(line => line.geometry.centerX < center).length;
        const rightCount = candidates.filter(line => line.geometry.centerX >= center).length;
        if (leftCount < 2 || rightCount < 2) continue;
        const balance = Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount);
        const score = Math.min(leftCount, rightCount) * gap * (0.75 + balance * 0.25);
        if (!best || score > best.score) best = { score, gap, center };
      }
    }
    return best ? best.center : null;
  }

  function buildFrontMatterLayoutLines(pages, bodyStyle) {
    const lines = [];
    for (const page of pages || []) {
      const source = (page.items || []).filter(item => !item.vertical);
      const typicalHeight = median(source.map(item => item.fontHeight)) || bodyStyle.height || 1;
      const rows = [];
      for (const item of [...source].sort((left, right) => left.geometry.top - right.geometry.top
        || left.geometry.left - right.geometry.left)) {
        let best = null;
        let bestDistance = Infinity;
        for (const row of rows) {
          const itemOffset = Number(item.offset);
          const rowEnded = row.items.some(value => value.lineBreakAfter
            && Number(value.offset) < itemOffset);
          if (rowEnded) continue;
          const overlap = verticalOverlap(row.geometry, item.geometry)
            / Math.max(1, Math.min(row.geometry.height, item.geometry.height));
          const baselineDistance = Math.abs(row.baseline - item.baseline[1]);
          if ((overlap >= 0.50 || baselineDistance <= Math.max(1.2, item.fontHeight * 0.35))
            && baselineDistance < bestDistance) {
            best = row;
            bestDistance = baselineDistance;
          }
        }
        if (!best) {
          best = {
            items: [],
            geometry: { ...item.geometry },
            baseline: item.baseline[1],
            height: item.fontHeight
          };
          rows.push(best);
        }
        best.items.push(item);
        best.geometry = geometry(boundingRect(best.items.map(value => value.viewportRect)),
          page.viewport.width, page.viewport.height);
        best.baseline = median(best.items.map(value => value.baseline[1]));
        best.height = median(best.items.map(value => value.fontHeight));
      }
      const rawLines = [];
      rows.sort((left, right) => left.geometry.top - right.geometry.top);
      rows.forEach((row, rowIndex) => {
        row.items.sort((left, right) => left.geometry.left - right.geometry.left);
        const rowHeight = median(row.items.map(item => item.fontHeight)) || typicalHeight;
           const splitGap = Math.max(page.viewport.width * 0.035, rowHeight * 2.4);
         const segments = [];
         let current = [];
         for (const item of row.items) {
           const previous = current.at(-1);
           const gap = previous ? item.geometry.left - previous.geometry.right : 0;
           const isolatedMarker = previous && current.length >= 8
             && [...String(item.text || "").trim()].length === 1
             && /\p{L}/u.test(String(item.text || ""))
             && item.fontHeight > rowHeight * 1.15
             && gap > rowHeight * 1.2;
           if (previous && (gap > splitGap || isolatedMarker)) {
            segments.push(current);
            current = [];
          }
          current.push(item);
        }
        if (current.length) segments.push(current);
        segments.forEach((segment, segmentIndex) => {
          const line = makeLine(page, segment, rowIndex, segmentIndex, segments.length, rawLines.length);
          if (line.text && line.geometry) rawLines.push(line);
        });
      });
       const gutter = inferFrontMatterGutter(rawLines, page);
       for (const line of rawLines) {
         const hasGutter = Number.isFinite(gutter);
         const crossesGutter = hasGutter
           && line.geometry.left < gutter && line.geometry.right > gutter;
         const spanning = crossesGutter;
         const columnIndex = spanning ? -1 : (hasGutter && line.geometry.left >= gutter ? 1 : 0);
         line.columnIndex = columnIndex;
         line.pageGutter = hasGutter ? gutter : null;
         line.flowLeft = hasGutter && columnIndex === 1 ? gutter : 0;
         line.flowRight = hasGutter && columnIndex === 0 ? gutter : page.viewport.width;
        line.flowKey = `${page.pageIndex}:front:${columnIndex}`;
        line.orderIndex = lines.length;
        lines.push(line);
      }
    }
    markPublisherMetadata(lines, bodyStyle);
    return lines;
  }

  function buildFrontMatterV2(orderedLines, bodyStyle, bodyBoundary = null, pages = null) {
    const titleLayoutLines = pages?.length ? buildFrontMatterLayoutLines(pages, bodyStyle) : orderedLines;
    const abstractLayoutLines = titleLayoutLines;
    const available = abstractLayoutLines.filter(isFrontMatterLine);
    const bodyStart = findFrontMatterBodyStart(abstractLayoutLines, bodyStyle, bodyBoundary);
    const sorted = [...available].sort(frontMatterLineSort);
    const abstractHeadingOptions = sorted.filter(line => isAbstractHeading(line.text))
      .map(line => ({
        line,
        bodyLines: collectAbstractBodyLines(abstractLayoutLines, line, bodyStart, bodyStyle)
      }))
      .sort((left, right) => right.bodyLines.length - left.bodyLines.length
        || (right.line.pageIndex === 0 ? 1 : 0) - (left.line.pageIndex === 0 ? 1 : 0)
        || right.line.fontHeight - left.line.fontHeight
        || frontMatterLineSort(left.line, right.line));
    const abstractHeadingOption = abstractHeadingOptions[0] || null;
    const abstractHeading = abstractHeadingOption?.line || null;
    const hasPublisherHeader = titleLayoutLines.some(line => line.pageIndex === 0
      && line.geometry.topRatio < 0.22
      && /(?:contents\s+lists?|science\s*direct|journal\s+homepage|elsevier|doi(?:\.org|\s*:)|issn)/iu
        .test(line.text));
    const titleAvailable = titleLayoutLines.filter(line => isFrontMatterLine(line)
      && (!hasPublisherHeader || line.geometry.topRatio >= 0.16)
      && (!abstractHeading || frontMatterBefore(line, abstractHeading))
       && !isFrontMatterArtifactLine(line, bodyStyle)
       && !frontMatterAuthorLike(line.text)
      && !frontMatterTrailingAuthorNameLike(line, titleLayoutLines)
      && !isFrontMatterNoise(line.text)
      && !isStandalonePageNumber(line.text));
    const blocks = buildFrontMatterBlocks(titleAvailable, bodyStyle);
    const titleBlocks = blocks.filter(block => block.pageIndex <= 1
      && (!abstractHeading || block.lines.every(line => frontMatterBefore(line, abstractHeading)))
      && block.text.length >= 8 && block.text.length <= 260
      && !isFrontMatterNoise(block.text)
      && !block.lines.some(line => isStandalonePageNumber(line.text)));
    const titleCandidates = titleBlocks.map(block => {
      const maxFontHeight = Math.max(...block.lines.map(line => line.fontHeight));
      const score = (block.pageIndex === 0 ? 3 : 1)
        + (maxFontHeight >= bodyStyle.height * 1.08 ? 3 : 0)
        + (block.centered ? 2 : 0)
        + (block.text.length >= 16 ? 1 : 0)
        + (block.lineCount >= 2 ? 1 : 0)
        - (block.lines.some(line => frontMatterAuthorLike(line.text)) ? 4 : 0);
      return {
        ...serializeFrontMatterBlock(block),
        score,
        confidence: score >= 7 ? "medium" : "low",
        matchMethod: "layout-fallback"
      };
    }).sort((left, right) => right.score - left.score
      || left.pageIndex - right.pageIndex
      || left.sourceLineIDs[0].localeCompare(right.sourceLineIDs[0]));

    const abstractLines = abstractHeadingOption?.bodyLines || [];
    const abstractFlow = buildAbstractFlow(abstractHeading, abstractLines, abstractLayoutLines);
    const abstractCandidates = abstractLines.length ? [{
      ...serializeFrontMatterBlock(frontMatterBlock(abstractLines, bodyStyle)),
      abstractFlow,
      confidence: abstractLines.length >= 2 ? "medium" : "low",
      score: abstractLines.length >= 2 ? 5 : 2,
      matchMethod: "layout-fallback"
    }] : [];
    return {
      titleCandidates,
      abstractCandidates,
      blocks: blocks.map(serializeFrontMatterBlock),
      abstractHeading: abstractHeading ? {
        text: abstractHeading.text,
        pageIndex: abstractHeading.pageIndex,
        lineID: abstractHeading.id,
        columnIndex: abstractHeading.columnIndex,
        sourceCharIDs: abstractHeading.itemIDs.slice()
      } : null,
      abstractFlow,
      layoutLines: abstractLayoutLines.map(serializeFrontMatterLine),
      bodyStart: bodyStart ? {
        text: bodyStart.text,
        pageIndex: bodyStart.pageIndex,
        lineID: bodyStart.id,
        columnIndex: bodyStart.columnIndex
      } : null
    };
  }

  function extractFrontMatter(input) {
    const pages = (input?.pages || []).map(preparePage);
    if (!pages.length) {
      const error = new Error("PDF 没有可提取页面。");
      error.code = "empty-pdf";
      throw error;
    }
    for (const page of pages) clusterPageLines(page);
    const inputCharacterCount = pages.reduce((sum, page) =>
      sum + page.items.length + page.rejectedItems.length, 0);
    if (!inputCharacterCount) {
      const error = new Error("PDF 不包含可选择文本层。");
      error.code = "pdf-text-layer-empty";
      throw error;
    }
    const bodyStyle = estimateBodyStyle(pages);
    markRepeatedEdges(pages);
    const orderedLines = [];
    for (const page of pages) {
      const ordered = orderPage(page, bodyStyle);
      if (orderedLines.length && ordered.lines.length) ordered.lines[0].transitionBefore = "page-break";
      orderedLines.push(...ordered.lines);
    }
    orderedLines.forEach((line, index) => { line.orderIndex = index; });
    markFormulaRegions(orderedLines, bodyStyle);
    markTables(orderedLines, bodyStyle);
    markCaptionsAndFigureLabels(orderedLines, bodyStyle);
    markFootnotes(orderedLines, bodyStyle, pages);
    markPublisherMetadata(orderedLines, bodyStyle);
    return buildFrontMatterV2(orderedLines, bodyStyle, null, pages);
  }

  function buildParagraphs(orderedLines, bodyStyle) {
    const harmlessBetweenParagraphs = new Set([
      "page-number", "repeated-header", "repeated-footer", "publisher-metadata", "footnote"
    ]);
    let pendingBlockingBoundary = false;
    for (const line of orderedLines) {
      if (line.exclusionReason) {
        if (!harmlessBetweenParagraphs.has(line.exclusionReason)) pendingBlockingBoundary = true;
        continue;
      }
      line.blockingBoundaryBefore = pendingBlockingBoundary;
      pendingBlockingBoundary = false;
    }
    const retained = orderedLines.filter(line => !line.exclusionReason);
    const profiles = computeFlowProfiles(retained, bodyStyle.height);
    const paragraphs = [];
    let current = null;
    for (const line of retained) {
      const previous = current?.lines?.[current.lines.length - 1] || null;
      const decision = shouldMerge(previous, line, profiles, bodyStyle.height);
      if (!current || !decision.merge) {
        current = {
          lines: [line], text: line.text, mergeReasons: [],
          transformedHyphenCount: 0, breakBeforeReason: decision.reason
        };
        paragraphs.push(current);
      }
      else {
        const joined = lineJoin(current.text, line.text, previous, line);
        current.text = joined.text;
        current.lines.push(line);
        current.mergeReasons.push(decision.reason);
        if (joined.dehyphenated) current.transformedHyphenCount++;
      }
    }
    return paragraphs.map((paragraph, index) => ({
      sourceIndex: index,
      sourceOrder: paragraph.lines[0].orderIndex,
      text: normalizeText(paragraph.text),
      contentType: "body-paragraph",
      sourceCharIDs: paragraph.lines.flatMap(line => line.itemIDs),
      sourceLineIDs: paragraph.lines.map(line => line.id),
      mergeReasons: paragraph.mergeReasons,
      transformedHyphenCount: paragraph.transformedHyphenCount,
      position: paragraphPosition(paragraph.lines)
    })).filter(paragraph => paragraph.text);
  }

  function aggregateExclusions(pages, orderedLines) {
    const groups = new Map();
    const add = (reason, pageIndex, text, itemIDs) => {
      if (!groups.has(reason)) groups.set(reason, {
        reason, count: 0, pageIndexes: new Set(), samples: [], itemIDs: []
      });
      const group = groups.get(reason);
      group.count++;
      group.pageIndexes.add(pageIndex);
      group.itemIDs.push(...itemIDs);
      const sample = normalizeText(text).slice(0, 220);
      if (sample && group.samples.length < CONFIG.maximumSamplesPerReason
        && !group.samples.includes(sample)) group.samples.push(sample);
    };
    for (const line of orderedLines) {
      if (line.exclusionReason) add(line.exclusionReason, line.pageIndex, line.text, line.itemIDs);
    }
    for (const page of pages) {
      for (const item of page.rejectedItems) add(item.reason, page.pageIndex, item.rawText, [item.id]);
    }
    return [...groups.values()].sort((a, b) => a.reason.localeCompare(b.reason)).map(group => ({
      reason: group.reason,
      count: group.count,
      pageIndexes: [...group.pageIndexes].sort((a, b) => a - b),
      samples: group.samples,
      _itemIDs: [...new Set(group.itemIDs)]
    }));
  }

  function extract(input) {
    const pages = (input?.pages || []).map(preparePage);
    if (!pages.length) {
      const error = new Error("PDF 没有可提取页面。");
      error.code = "empty-pdf";
      throw error;
    }
    for (const page of pages) clusterPageLines(page);
    const inputCharacterCount = pages.reduce((sum, page) => sum + page.items.length + page.rejectedItems.length, 0);
    if (!inputCharacterCount) {
      const error = new Error("PDF 不包含可选择文本层，且本插件不启用 OCR 回退。");
      error.code = "pdf-text-layer-empty";
      throw error;
    }
    const bodyStyle = estimateBodyStyle(pages);
    markRepeatedEdges(pages);
    const layoutDiagnostics = [];
    const orderedLines = [];
    for (const page of pages) {
      const ordered = orderPage(page, bodyStyle, input?.selectionContext || null);
      if (orderedLines.length && ordered.lines.length) ordered.lines[0].transitionBefore = "page-break";
      orderedLines.push(...ordered.lines);
      layoutDiagnostics.push(ordered.diagnostic);
    }
    orderedLines.forEach((line, index) => { line.orderIndex = index; });
    markFormulaRegions(orderedLines, bodyStyle);
    markTables(orderedLines, bodyStyle);
    markCaptionsAndFigureLabels(orderedLines, bodyStyle);
    markFootnotes(orderedLines, bodyStyle, pages);
    markPublisherMetadata(orderedLines, bodyStyle);
    const bodyBoundary = markBodyBoundaries(orderedLines, bodyStyle, input?.outlineHints || []);
    const retainedAmbiguities = collectRetainedAmbiguities(orderedLines, bodyStyle);
    const frontMatter = buildFrontMatterV2(orderedLines, bodyStyle, bodyBoundary, pages);
    const raw = buildParagraphs(orderedLines, bodyStyle);
    const exclusions = aggregateExclusions(pages, orderedLines);
    const keptIDs = raw.flatMap(paragraph => paragraph.sourceCharIDs);
    const excludedIDs = exclusions.flatMap(exclusion => exclusion._itemIDs);
    const assignmentCounts = new Map();
    for (const id of [...keptIDs, ...excludedIDs]) assignmentCounts.set(id, (assignmentCounts.get(id) || 0) + 1);
    const allIDs = pages.flatMap(page => [...page.items, ...page.rejectedItems].map(item => item.id));
    const unassigned = allIDs.filter(id => !assignmentCounts.has(id));
    const duplicates = allIDs.filter(id => (assignmentCounts.get(id) || 0) > 1);
    for (const exclusion of exclusions) delete exclusion._itemIDs;
    if (unassigned.length || duplicates.length) {
      const error = new Error(`文本项守恒失败：未归属 ${unassigned.length}，重复 ${duplicates.length}。`);
      error.code = "character-conservation-failed";
      error.diagnostics = { unassignedCharIDs: unassigned.slice(0, 50), duplicateCharIDs: duplicates.slice(0, 50) };
      throw error;
    }
    for (const diagnostic of layoutDiagnostics) {
      diagnostic.bodyHeight = Number(bodyStyle.height.toFixed(3));
      diagnostic.bodyFonts = bodyStyle.fonts;
      diagnostic.keptLineCount = orderedLines.filter(line => line.pageIndex === diagnostic.pageIndex
        && !line.exclusionReason).length;
      diagnostic.excludedLineCount = orderedLines.filter(line => line.pageIndex === diagnostic.pageIndex
        && line.exclusionReason).length;
    }
    const transformedHyphenCount = raw.reduce((sum, paragraph) => sum + paragraph.transformedHyphenCount, 0);
    return {
      raw,
      frontMatter,
      layoutDiagnostics,
      exclusions,
      retainedAmbiguities,
      bodyBoundary,
      characterConservation: {
        inputCharacterCount: allIDs.length,
        keptCharacterCount: keptIDs.length,
        excludedCharacterCount: excludedIDs.length,
        ignoredWhitespaceCharacterCount: pages.reduce((sum, page) => sum + page.ignoredItemCount, 0),
        transformedHyphenCount,
        unassignedCharacterCount: 0,
        duplicateCharacterCount: 0
      },
      summary: {
        pageCount: pages.length,
        bodyHeight: Number(bodyStyle.height.toFixed(3)),
        bodyFonts: bodyStyle.fonts,
        heightClusters: bodyStyle.heightClusters,
        includedParagraphCount: raw.length,
        retainedAmbiguityCount: retainedAmbiguities.length,
        excludedLineCount: exclusions.reduce((sum, exclusion) => sum + exclusion.count, 0),
        excludedCountsByReason: Object.fromEntries(exclusions.map(exclusion => [exclusion.reason, exclusion.count]))
      }
    };
  }

  global.ReaderPageDataBodyExtractor = {
    CONFIG,
    extract,
    extractFrontMatter,
    normalizeText,
    _test: {
      preparePage,
      clusterPageLines,
      estimateBodyStyle,
      detectGutter,
      orderPage,
      isFormulaSeed,
      isNumberedHeading,
      isLikelyHeading,
      compactSpacedHeading,
      buildFrontMatterLayoutLines,
      buildFrontMatterBlocks,
      buildFrontMatterV2
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
