(function (global) {
  "use strict";

  const CONFIG = Object.freeze({
    edgeRatio: 0.12,
    gutterSearchLeft: 0.35,
    gutterSearchRight: 0.65,
    minimumGutterWidth: 0.03,
    maximumGutterOccupancy: 0.10,
    minimumColumnLines: 4,
    minimumColumnOverlap: 0.25,
    verticalBandGapLines: 2.2,
    sameFlowFontTolerance: 0.20,
    crossFlowFontTolerance: 0.15,
    lineGapMultiplier: 1.7,
    paragraphIndentEm: 0.8,
    crossFlowFillRatio: 0.80
  });

  function median(values) {
    const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeEdgeKey(value) {
    return normalizeText(value).toLocaleLowerCase()
      .replace(/\b(?:page|p)\.?\s*\d{1,5}\b/giu, " ")
      .replace(/\b\d{1,5}\b/gu, " ")
      .replace(/\b[ivxlcdm]{1,12}\b/giu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function copyRect(rect) {
    if (!rect || Number(rect.length || 0) < 4) return null;
    const result = [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])];
    return result.every(Number.isFinite) && result[2] > result[0] && result[3] > result[1]
      ? result : null;
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

  function rectGeometry(rect, width, height) {
    if (!rect || !(width > 0) || !(height > 0)) return null;
    return {
      left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
      width: rect[2] - rect[0], height: rect[3] - rect[1],
      centerX: (rect[0] + rect[2]) / 2,
      centerY: (rect[1] + rect[3]) / 2,
      leftRatio: rect[0] / width,
      rightRatio: rect[2] / width,
      topRatio: rect[1] / height,
      bottomRatio: rect[3] / height
    };
  }

  function verticalOverlap(left, right) {
    return Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  }

  function textUnitCount(value) {
    return [...String(value || "")].length;
  }

  function isStandalonePageNumber(value) {
    return /^(?:(?:page|p\.?|页码?)\s*)?[-()\[\]\s]*(?:\d{1,5}|[ivxlcdm]{1,12})(?:\s*\/\s*\d{1,5})?[-()\[\]\s]*$/iu
      .test(normalizeText(value));
  }

  function isReferenceHeading(value) {
    return /^(?:references|bibliography|works\s+cited|literature\s+cited|参考文献|参考资料)\s*[:：]?$/iu
      .test(normalizeText(value));
  }

  function isAbstractMarker(value) {
    return /^(?:(?:abstract|summary)\b|(?:摘要|内容摘要)(?:\s*[:：]|\s|$))/iu
      .test(normalizeText(value));
  }

  function isKeywordLine(value) {
    return /^(?:key\s*words?|keywords?|index\s+terms|关键词|关键字)\s*[:：]/iu
      .test(normalizeText(value));
  }

  function startsLocalizedCaption(value) {
    return /^(?:(?:fig(?:ure)?|table|scheme|chart|plate)\s*[.：:]?\s*[A-Z]?\d+|(?:图|表)\s*[一二三四五六七八九十百零〇\d]+)/iu
      .test(normalizeText(value));
  }

  function parseCaptionLead(value) {
    const text = normalizeText(value);
    const match = text.match(
      /^(fig(?:ure)?\.?|table|scheme|chart|plate)\s*([A-Z]?\d+(?:[.-]\d+)?)(?:\s*([.:\-\u2013\u2014])\s*|\s+)(.*)$/iu
    );
    if (!match) return startsLocalizedCaption(text) ? {
      kind: /^table\b/iu.test(text) ? "table" : "figure",
      label: text,
      separator: "",
      remainder: "",
      proseContinuation: false,
      strong: false
    } : null;
    const kind = /^table$/iu.test(match[1]) ? "table" : "figure";
    const remainder = normalizeText(match[4]);
    const proseContinuation = /^(?:shows?|illustrates?|presents?|depicts?|compares?|demonstrates?|reveals?|provides?|indicates?|summari[sz]es?|reports?|lists?|gives?|contains?)\b/iu
      .test(remainder);
    return {
      kind,
      label: `${match[1]} ${match[2]}`,
      separator: match[3] || "",
      remainder,
      proseContinuation,
      strong: !!match[3] && !proseContinuation
    };
  }

  function isCommonHeading(value) {
    const text = normalizeText(value);
    if (/^(?:introduction|background|methods?|materials?(?:\s+and\s+methods?)?|results?|discussion|conclusions?|limitations?|acknowledg(?:e)?ments?|引言|绪论|背景|方法|材料与方法|结果|讨论|结论|局限性|致谢)(?:\s|$)/iu.test(text)) {
      return true;
    }
    const numbered = text.match(/^\d+(?:\.\d+)*\.?\s+(.+)$/u);
    return !!numbered && /\p{L}/u.test(numbered[1]);
  }

  function endsWithTerminal(value) {
    return /[.!?。！？][\])}'"”’]*\s*$/u.test(String(value || ""));
  }

  function startsList(value) {
    return /^(?:[•●▪◦*-]|\(?\d+(?:\.\d+)*[.)、]|\(?[a-zA-Z][.)]|\(?[一二三四五六七八九十]+[、)])\s+/u
      .test(normalizeText(value));
  }

  function getTextStats(value) {
    const chars = [...normalizeText(value)].filter(char => !/\s/u.test(char));
    const letters = chars.filter(char => /\p{L}/u.test(char)).length;
    const digits = chars.filter(char => /\p{N}/u.test(char)).length;
    const operators = chars.filter(char => /[=+\-×÷<>≤≥∑∫√^~±]/u.test(char)).length;
    return {
      charCount: chars.length,
      letterRatio: chars.length ? letters / chars.length : 0,
      digitRatio: chars.length ? digits / chars.length : 0,
      operatorRatio: chars.length ? operators / chars.length : 0,
      numericTokenCount: (normalizeText(value).match(/\b\d+(?:[.,]\d+)?\b/gu) || []).length
    };
  }

  function makePosition(lines) {
    const pageMap = new Map();
    for (const line of lines || []) {
      if (!line.pdfRect) continue;
      if (!pageMap.has(line.pageIndex)) pageMap.set(line.pageIndex, []);
      pageMap.get(line.pageIndex).push(line.pdfRect);
    }
    const fragments = [...pageMap.entries()].sort((a, b) => a[0] - b[0])
      .map(([pageIndex, rects]) => ({ pageIndex, rects: rects.map(copyRect).filter(Boolean) }));
    const pageIndex = fragments[0]?.pageIndex || 0;
    return {
      pageIndex,
      rects: fragments[0]?.rects || [],
      nextPageRects: fragments[1]?.pageIndex === pageIndex + 1 ? fragments[1].rects : [],
      fragments
    };
  }

  function createExclusion(reason, lines, text, extra = {}) {
    const sourceLines = lines || [];
    return {
      reason,
      text: normalizeText(text ?? sourceLines.map(line => line.text).join(" ")),
      pageIndexes: [...new Set(sourceLines.map(line => line.pageIndex))].sort((a, b) => a - b),
      sourceLineIDs: sourceLines.map(line => line.id),
      charIDs: [...new Set(sourceLines.flatMap(line => line.charIDs || []))],
      position: makePosition(sourceLines),
      ...extra
    };
  }

  function regionContainsGlyph(region, glyph) {
    const rect = copyRect(region?.viewportRect);
    if (!rect || !glyph?.geometry) return false;
    const tolerance = Math.max(1, Math.min(glyph.geometry.width, glyph.geometry.height) * 0.25);
    return glyph.geometry.centerX >= rect[0] - tolerance
      && glyph.geometry.centerX <= rect[2] + tolerance
      && glyph.geometry.centerY >= rect[1] - tolerance
      && glyph.geometry.centerY <= rect[3] + tolerance;
  }

  function createGlyphExclusion(reason, glyphs, extra = {}) {
    const source = [...(glyphs || [])].sort((left, right) =>
      left.geometry.top - right.geometry.top || left.geometry.left - right.geometry.left);
    const byPage = new Map();
    for (const glyph of source) {
      if (!byPage.has(glyph.pageIndex)) byPage.set(glyph.pageIndex, []);
      byPage.get(glyph.pageIndex).push(glyph.pdfRect);
    }
    const fragments = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([pageIndex, rects]) => ({
      pageIndex,
      rects: [boundingRect(rects)].filter(Boolean)
    }));
    return {
      reason,
      text: normalizeText(source.map(glyph => glyph.c).join("")),
      pageIndexes: [...byPage.keys()].sort((a, b) => a - b),
      sourceLineIDs: [],
      charIDs: source.map(glyph => glyph.id),
      position: {
        pageIndex: fragments[0]?.pageIndex || 0,
        rects: fragments[0]?.rects || [],
        fragments
      },
      ...extra
    };
  }

  function buildLineText(glyphs, typicalWidth) {
    let text = "";
    let largeGapCount = 0;
    let previous = null;
    for (const glyph of glyphs) {
      const value = String(glyph.c || "");
      const gap = previous ? glyph.geometry.left - previous.geometry.right : 0;
      const explicitWhitespace = /^\s+$/u.test(value);
      if (previous && !explicitWhitespace && !/\s$/u.test(text)) {
        const addSpace = previous.spaceAfter || gap > Math.max(1, typicalWidth * 0.62);
        if (addSpace && !/^[,.;:!?%)\]}。；：！？、]/u.test(value)) text += " ";
        if (gap > typicalWidth * 1.6) largeGapCount++;
      }
      text += explicitWhitespace ? " " : value;
      previous = glyph;
    }
    return { text: text.replace(/\s+/g, " ").trim(), largeGapCount };
  }

  function clusterPageLines(page) {
    const width = Number(page.metric?.width || 0);
    const height = Number(page.metric?.height || 0);
    const exclusions = [];
    const glyphs = [];
    const semanticGroups = new Map();
    for (const char of page.chars || []) {
      if (char.ignorable || !String(char.c || "")) continue;
      const rotation = ((Number(char.rotation || 0) % 360) + 360) % 360;
      if (Math.abs(rotation % 180) > 1) {
        exclusions.push({ reason: "rotated-text", charIDs: [char.id], text: String(char.c || "") });
        continue;
      }
      const viewportRect = copyRect(char.viewportRect);
      const pdfRect = copyRect(char.rect);
      const geometry = rectGeometry(viewportRect, width, height);
      if (!geometry || !pdfRect) {
        exclusions.push({ reason: "unpositioned-character", charIDs: [char.id], text: String(char.c || "") });
        continue;
      }
      const glyph = { ...char, viewportRect, pdfRect, geometry, pageIndex: page.pageIndex };
      const semanticRegion = (page.exclusionRegions || []).find(region => regionContainsGlyph(region, glyph));
      if (semanticRegion) {
        const key = String(semanticRegion.id || `${semanticRegion.reason}:${page.pageIndex}`);
        if (!semanticGroups.has(key)) semanticGroups.set(key, { region: semanticRegion, glyphs: [] });
        semanticGroups.get(key).glyphs.push(glyph);
        continue;
      }
      glyphs.push(glyph);
    }
    for (const { region, glyphs: excludedGlyphs } of semanticGroups.values()) {
      exclusions.push(createGlyphExclusion(region.reason || "zotero-sdt-excluded", excludedGlyphs, {
        source: "zotero-sdt",
        semanticType: String(region.semanticType || "")
      }));
    }
    const typicalHeight = median(glyphs.map(glyph => glyph.geometry.height)) || 1;
    glyphs.sort((a, b) => a.geometry.centerY - b.geometry.centerY
      || a.geometry.left - b.geometry.left);
    const rows = [];
    for (const glyph of glyphs) {
      let best = null;
      let bestDistance = Infinity;
      for (const row of rows) {
        const overlap = verticalOverlap(row.geometry, glyph.geometry);
        const minimumHeight = Math.max(1, Math.min(row.geometry.height, glyph.geometry.height));
        const centerDistance = Math.abs(row.geometry.centerY - glyph.geometry.centerY);
        const compatible = overlap / minimumHeight >= 0.50
          || centerDistance <= Math.max(row.geometry.height, glyph.geometry.height, typicalHeight) * 0.50;
        if (compatible && centerDistance < bestDistance) {
          best = row;
          bestDistance = centerDistance;
        }
      }
      if (!best) {
        best = { glyphs: [], geometry: { ...glyph.geometry } };
        rows.push(best);
      }
      best.glyphs.push(glyph);
      const rect = boundingRect(best.glyphs.map(item => item.viewportRect));
      best.geometry = rectGeometry(rect, width, height);
    }

    const lines = [];
    let lineOffset = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      row.glyphs.sort((a, b) => a.geometry.left - b.geometry.left);
      const typicalWidth = median(row.glyphs.map(glyph => glyph.geometry.width)) || 1;
      const splitGap = Math.max(width * 0.04, typicalWidth * 4);
      const segments = [];
      let current = [];
      for (const glyph of row.glyphs) {
        const previous = current[current.length - 1];
        if (previous && glyph.geometry.left - previous.geometry.right > splitGap) {
          segments.push(current);
          current = [];
        }
        current.push(glyph);
      }
      if (current.length) segments.push(current);
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        const viewportRect = boundingRect(segment.map(glyph => glyph.viewportRect));
        const pdfRect = boundingRect(segment.map(glyph => glyph.pdfRect));
        const geometry = rectGeometry(viewportRect, width, height);
        const mapped = buildLineText(segment, typicalWidth);
        const line = {
          id: `${page.pageIndex}:line:${lineOffset++}`,
          pageIndex: page.pageIndex,
          text: mapped.text,
          charIDs: segment.map(glyph => glyph.id),
          pdfRect,
          geometry,
          lineHeight: geometry?.height || typicalHeight,
          paragraphHintAfter: segment.some(glyph => glyph.paragraphBreakAfter),
          largeGapCount: mapped.largeGapCount,
          visualRowID: `${page.pageIndex}:row:${rowIndex}`,
          visualSegmentIndex: segmentIndex,
          visualSegmentCount: segments.length,
          typicalGlyphWidth: typicalWidth,
          columnIndex: 0,
          flowKey: "",
          flowLeft: 0,
          flowRight: width,
          transitionBefore: "page-start"
        };
        if (!line.text) exclusions.push(createExclusion("blank-text", [line], ""));
        else lines.push(line);
      }
    }
    lines.sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left);
    return { lines, exclusions };
  }

  function detectGutter(lines, page) {
    const width = Number(page.metric?.width || 0);
    const height = Number(page.metric?.height || 0);
    const candidates = lines.filter(line => {
      const ratio = line.geometry.width / Math.max(1, width);
      return line.text.length >= 12 && ratio >= 0.15 && ratio <= 0.58
        && line.geometry.topRatio >= 0.04 && line.geometry.bottomRatio <= 0.96;
    });
    if (candidates.length < CONFIG.minimumColumnLines * 2) return null;
    const goodBins = [];
    for (let bin = Math.ceil(CONFIG.gutterSearchLeft * 100);
      bin <= Math.floor(CONFIG.gutterSearchRight * 100); bin++) {
      const x = width * bin / 100;
      const crossing = candidates.filter(line => line.geometry.left < x && line.geometry.right > x).length;
      const left = candidates.filter(line => line.geometry.right <= x).length;
      const right = candidates.filter(line => line.geometry.left >= x).length;
      if (crossing / candidates.length <= CONFIG.maximumGutterOccupancy
        && left >= CONFIG.minimumColumnLines && right >= CONFIG.minimumColumnLines) goodBins.push(bin);
    }
    const runs = [];
    let run = [];
    for (const bin of goodBins) {
      if (run.length && bin !== run[run.length - 1] + 1) { runs.push(run); run = []; }
      run.push(bin);
    }
    if (run.length) runs.push(run);
    runs.sort((a, b) => b.length - a.length);
    for (const candidate of runs) {
      const leftRatio = candidate[0] / 100;
      const rightRatio = candidate[candidate.length - 1] / 100;
      if (rightRatio - leftRatio < CONFIG.minimumGutterWidth) continue;
      const center = width * (leftRatio + rightRatio) / 2;
      const leftLines = candidates.filter(line => line.geometry.right <= center);
      const rightLines = candidates.filter(line => line.geometry.left >= center);
      const overlapTop = Math.max(
        Math.min(...leftLines.map(line => line.geometry.top)),
        Math.min(...rightLines.map(line => line.geometry.top))
      );
      const overlapBottom = Math.min(
        Math.max(...leftLines.map(line => line.geometry.bottom)),
        Math.max(...rightLines.map(line => line.geometry.bottom))
      );
      if ((overlapBottom - overlapTop) / Math.max(1, height) >= CONFIG.minimumColumnOverlap) {
        return { leftRatio, rightRatio, centerRatio: (leftRatio + rightRatio) / 2 };
      }
    }
    return null;
  }

  function findVerticalSections(lines, bodyLineHeight, pageHeight) {
    if (!lines.length) return [];
    const ordered = [...lines].sort((a, b) => a.geometry.top - b.geometry.top);
    const threshold = Math.max(bodyLineHeight * CONFIG.verticalBandGapLines, pageHeight * 0.035);
    const sections = [];
    let current = [ordered[0]];
    let bottom = ordered[0].geometry.bottom;
    for (let index = 1; index < ordered.length; index++) {
      const line = ordered[index];
      const gap = line.geometry.top - bottom;
      if (gap > threshold) {
        sections.push(current);
        current = [];
      }
      current.push(line);
      bottom = Math.max(bottom, line.geometry.bottom);
    }
    if (current.length) sections.push(current);
    return sections;
  }

  function orderPageLines(page, lines, bodyLineHeight) {
    const width = Number(page.metric?.width || 0);
    const height = Number(page.metric?.height || 0);
    const gutter = detectGutter(lines, page);
    const sections = findVerticalSections(lines, bodyLineHeight, height);
    const ordered = [];
    const bands = [];
    let previous = null;
    const pushLine = (line, columnIndex, flowKey, flowLeft, flowRight, transition) => {
      line.columnIndex = columnIndex;
      line.flowKey = flowKey;
      line.flowLeft = flowLeft;
      line.flowRight = flowRight;
      line.transitionBefore = previous ? transition : "page-start";
      ordered.push(line);
      previous = line;
    };
    sections.forEach((section, sectionIndex) => {
      const top = Math.min(...section.map(line => line.geometry.top));
      const bottom = Math.max(...section.map(line => line.geometry.bottom));
      if (!gutter) {
        const sorted = [...section].sort((a, b) => a.geometry.top - b.geometry.top
          || a.geometry.left - b.geometry.left);
        sorted.forEach((line, index) => pushLine(line, 0, `${page.pageIndex}:${sectionIndex}:0`, 0, width,
          index ? "same-flow" : "band-break"));
        bands.push({ topRatio: top / height, bottomRatio: bottom / height, columnCount: 1,
          readingOrderLineIDs: sorted.map(line => line.id) });
        return;
      }
      const gutterLeft = gutter.leftRatio * width;
      const gutterRight = gutter.rightRatio * width;
      const spanning = section.filter(line => line.geometry.left < gutterLeft
        && line.geometry.right > gutterRight && line.geometry.width / width >= 0.55)
        .sort((a, b) => a.geometry.top - b.geometry.top);
      const pieces = [];
      let segmentTop = -Infinity;
      for (const span of spanning) {
        pieces.push({ type: "columns", lines: section.filter(line => !spanning.includes(line)
          && line.geometry.centerY >= segmentTop && line.geometry.centerY < span.geometry.top) });
        pieces.push({ type: "spanning", lines: [span] });
        segmentTop = span.geometry.bottom;
      }
      pieces.push({ type: "columns", lines: section.filter(line => !spanning.includes(line)
        && line.geometry.centerY >= segmentTop) });
      const bandOrder = [];
      pieces.forEach((piece, pieceIndex) => {
        if (!piece.lines.length) return;
        if (piece.type === "spanning") {
          piece.lines.forEach(line => {
            pushLine(line, -1, `${page.pageIndex}:${sectionIndex}:span:${pieceIndex}`, 0, width, "band-break");
            bandOrder.push(line.id);
          });
          return;
        }
        const center = gutter.centerRatio * width;
        const left = piece.lines.filter(line => line.geometry.centerX < center)
          .sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left);
        const right = piece.lines.filter(line => line.geometry.centerX >= center)
          .sort((a, b) => a.geometry.top - b.geometry.top || a.geometry.left - b.geometry.left);
        left.forEach((line, index) => {
          pushLine(line, 0, `${page.pageIndex}:${sectionIndex}:${pieceIndex}:0`, 0, gutterLeft,
            index ? "same-flow" : "band-break");
          bandOrder.push(line.id);
        });
        right.forEach((line, index) => {
          pushLine(line, 1, `${page.pageIndex}:${sectionIndex}:${pieceIndex}:1`, gutterRight, width,
            index ? "same-flow" : (left.length ? "column-break" : "band-break"));
          bandOrder.push(line.id);
        });
      });
      bands.push({ topRatio: top / height, bottomRatio: bottom / height, columnCount: 2,
        readingOrderLineIDs: bandOrder });
    });
    return {
      lines: ordered,
      diagnostic: {
        pageIndex: page.pageIndex,
        columnCount: gutter ? 2 : 1,
        gutter: gutter ? {
          leftRatio: Number(gutter.leftRatio.toFixed(4)),
          rightRatio: Number(gutter.rightRatio.toFixed(4)),
          centerRatio: Number(gutter.centerRatio.toFixed(4))
        } : null,
        bands
      }
    };
  }

  function findRepeatedEdgeLineIDs(pageLines) {
    const groups = new Map();
    for (const line of pageLines.flat()) {
      const edge = line.geometry.topRatio < CONFIG.edgeRatio
        ? "top" : line.geometry.bottomRatio > 1 - CONFIG.edgeRatio ? "bottom" : null;
      if (!edge || line.text.length < 3 || line.text.length > 240) continue;
      const key = normalizeEdgeKey(line.text);
      if (!key) continue;
      const groupKey = `${edge}:${key}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(line);
    }
    const repeated = new Set();
    for (const items of groups.values()) {
      if (new Set(items.map(line => line.pageIndex)).size < 2) continue;
      const ratios = items.map(line => line.geometry.topRatio);
      if (Math.max(...ratios) - Math.min(...ratios) > 0.02) continue;
      items.forEach(line => repeated.add(line.id));
    }
    return repeated;
  }

  function computeFlowProfiles(lines, bodyLineHeight) {
    const groups = new Map();
    for (const line of lines) {
      if (!groups.has(line.flowKey)) groups.set(line.flowKey, []);
      groups.get(line.flowKey).push(line);
    }
    const result = new Map();
    for (const [key, items] of groups) {
      const gaps = [];
      for (let index = 1; index < items.length; index++) {
        const gap = items[index].geometry.top - items[index - 1].geometry.bottom;
        if (gap >= 0 && gap <= bodyLineHeight * 3) gaps.push(gap);
      }
      const lefts = items.map(line => line.geometry.left).sort((a, b) => a - b);
      const baselineIndex = Math.min(lefts.length - 1, Math.floor(lefts.length * 0.2));
      result.set(key, {
        normalGap: median(gaps) || bodyLineHeight * 0.35,
        baselineLeft: lefts[baselineIndex] ?? items[0].flowLeft
      });
    }
    return result;
  }

  function isHeadingLine(line, bodyLineHeight) {
    if (isReferenceHeading(line.text) || isAbstractMarker(line.text)) return true;
    const short = line.text.length <= 160 && !endsWithTerminal(line.text);
    return short && (isCommonHeading(line.text) || line.lineHeight >= bodyLineHeight * 1.10);
  }

  function isEquationLine(line) {
    const text = normalizeText(line?.text);
    const stats = getTextStats(text);
    const proseWords = text.match(/\p{L}{2,}/gu) || [];
    const proseSyntax = proseWords.length >= 2
      && /\b(?:the|this|that|these|those|where|which|is|are|was|were|denotes?|represents?|respectively|and|or|with|for|from|into|of|to|in|as)\b/iu.test(text);
    if (proseSyntax || proseWords.length >= 5 || stats.charCount > 180) return false;
    const hasMathRelation = /(?:=|≈|≃|≅|≡|≤|≥|<|>|∝|→|↔|∑|∫|√|±|∂|∇)/u.test(text);
    const hasEquationNumber = /\(\s*\d+[a-z]?\s*\)\s*$/iu.test(text);
    const operatorDense = stats.operatorRatio >= 0.08;
    return (hasMathRelation || hasEquationNumber)
      && (operatorDense || stats.letterRatio < 0.45)
      && (proseWords.length <= 3 || stats.letterRatio < 0.35);
  }

  function isTableLine(line) {
    const stats = getTextStats(line?.text);
    return stats.numericTokenCount >= 3 && stats.digitRatio >= 0.30
      && Number(line?.largeGapCount || 0) >= 2;
  }

  function makeVisualRows(lines) {
    const groups = new Map();
    for (const line of lines || []) {
      const key = `${line.flowKey}|${line.visualRowID || line.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    return [...groups.values()].map(segments => {
      segments.sort((left, right) => left.geometry.left - right.geometry.left);
      const first = segments[0];
      const text = segments.map(line => line.text).join(" | ");
      const flowWidth = Math.max(1, first.flowRight - first.flowLeft);
      return {
        key: `${first.flowKey}|${first.visualRowID || first.id}`,
        pageIndex: first.pageIndex,
        flowKey: first.flowKey,
        flowLeft: first.flowLeft,
        flowRight: first.flowRight,
        top: Math.min(...segments.map(line => line.geometry.top)),
        bottom: Math.max(...segments.map(line => line.geometry.bottom)),
        left: Math.min(...segments.map(line => line.geometry.left)),
        right: Math.max(...segments.map(line => line.geometry.right)),
        segments,
        text,
        stats: getTextStats(text),
        starts: segments.map(line => (line.geometry.left - first.flowLeft) / flowWidth),
        directEvidence: segments.some(isTableLine)
          || (segments.length >= 2 && (getTextStats(text).numericTokenCount >= 1 || segments.length >= 3))
      };
    }).sort((left, right) => left.pageIndex - right.pageIndex
      || left.flowKey.localeCompare(right.flowKey) || left.top - right.top || left.left - right.left);
  }

  function rowsHaveAlignedCells(left, right) {
    if (left.flowKey !== right.flowKey || left.segments.length < 2 || right.segments.length < 2) return false;
    if (Math.abs(left.segments.length - right.segments.length) > 1) return false;
    const unmatched = [...right.starts];
    let matches = 0;
    for (const start of left.starts) {
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < unmatched.length; index++) {
        const distance = Math.abs(start - unmatched[index]);
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      }
      if (bestIndex >= 0 && bestDistance <= 0.06) {
        matches++;
        unmatched.splice(bestIndex, 1);
      }
    }
    return matches >= Math.min(2, left.segments.length, right.segments.length);
  }

  function detectTableLineReasons(lines, bodyLineHeight) {
    const rows = makeVisualRows(lines);
    const reasons = new Map();
    const mark = (row, reason) => row.segments.forEach(line => reasons.set(line.id, reason));
    const byFlow = new Map();
    for (const row of rows) {
      if (!byFlow.has(row.flowKey)) byFlow.set(row.flowKey, []);
      byFlow.get(row.flowKey).push(row);
      const lead = parseCaptionLead(row.text);
      if (lead?.kind === "table" && !lead.proseContinuation) mark(row, "table-caption");
      if (row.segments.some(isTableLine)) mark(row, "table-content");
    }
    for (const flowRows of byFlow.values()) {
      flowRows.sort((left, right) => left.top - right.top);
      for (let index = 1; index < flowRows.length; index++) {
        const previous = flowRows[index - 1];
        const current = flowRows[index];
        const gap = current.top - previous.bottom;
        if (gap < -bodyLineHeight * 0.5 || gap > bodyLineHeight * 2.4) continue;
        if (!rowsHaveAlignedCells(previous, current)) continue;
        if (previous.directEvidence || current.directEvidence
          || (previous.segments.length >= 2 && current.segments.length >= 2)) {
          mark(previous, "table-content");
          mark(current, "table-content");
        }
      }
    }
    const captions = rows.filter(row => row.segments.some(line => reasons.get(line.id) === "table-caption"));
    for (const caption of captions) {
      const nearbySeeds = rows.filter(row => row.pageIndex === caption.pageIndex
        && row.top >= caption.bottom - bodyLineHeight * 0.4
        && row.top - caption.bottom <= bodyLineHeight * 12
        && row.segments.some(line => reasons.get(line.id) === "table-content")
        && Math.max(0, Math.min(row.right, caption.right) - Math.max(row.left, caption.left))
          / Math.max(1, Math.min(row.right - row.left, caption.right - caption.left)) >= 0.15);
      if (!nearbySeeds.length) continue;
      const tableBottom = Math.max(...nearbySeeds.map(row => row.bottom));
      for (const row of rows) {
        if (row.pageIndex !== caption.pageIndex || row.top < caption.bottom - bodyLineHeight * 0.4
          || row.bottom > tableBottom + bodyLineHeight * 0.5) continue;
        const proseLike = row.segments.length === 1 && row.stats.letterRatio >= 0.68
          && row.stats.numericTokenCount === 0 && row.text.length >= 80
          && row.segments[0].largeGapCount === 0;
        if (!proseLike) mark(row, "table-content");
      }
    }
    return reasons;
  }

  function isStructuralLine(line, bodyLineHeight) {
    const captionLead = parseCaptionLead(line.text);
    return isHeadingLine(line, bodyLineHeight) || startsList(line.text)
      || isEquationLine(line) || isTableLine(line)
      || (!!captionLead && !captionLead.proseContinuation
        && (captionLead.strong || line.lineHeight <= bodyLineHeight * 0.95));
  }

  function shouldMergeLines(previous, current, flowProfiles, bodyLineHeight) {
    if (!previous || !current) return { merge: false, reason: "start" };
    if (isStructuralLine(previous, bodyLineHeight) || isStructuralLine(current, bodyLineHeight)) {
      return { merge: false, reason: "structural-boundary" };
    }
    const fontDifference = Math.abs(previous.lineHeight - current.lineHeight)
      / Math.max(1, previous.lineHeight, current.lineHeight);
    const sameFlow = previous.flowKey === current.flowKey;
    if (sameFlow) {
      if (fontDifference > CONFIG.sameFlowFontTolerance) return { merge: false, reason: "font-change" };
      const profile = flowProfiles.get(current.flowKey) || {
        normalGap: bodyLineHeight * 0.35,
        baselineLeft: current.flowLeft
      };
      const normalGap = profile.normalGap;
      const gap = current.geometry.top - previous.geometry.bottom;
      if (gap > Math.max(normalGap * CONFIG.lineGapMultiplier, bodyLineHeight * 0.9)) {
        return { merge: false, reason: "large-line-gap" };
      }
      const indent = current.geometry.left - profile.baselineLeft;
      const columnWidth = Math.max(1, previous.flowRight - previous.flowLeft);
      const fill = (previous.geometry.right - previous.flowLeft) / columnWidth;
      if (indent > bodyLineHeight * CONFIG.paragraphIndentEm
        && (endsWithTerminal(previous.text) || previous.paragraphHintAfter)) {
        return { merge: false, reason: "first-line-indent" };
      }
      if (previous.paragraphHintAfter && endsWithTerminal(previous.text) && fill < 0.8
        && (gap > normalGap * 1.15 || gap > bodyLineHeight * 0.8)) {
        return { merge: false, reason: "paragraph-hint" };
      }
      return { merge: true, reason: "same-column-continuation" };
    }
    const transition = current.transitionBefore;
    if (transition !== "column-break" && transition !== "page-break") {
      return { merge: false, reason: transition || "flow-break" };
    }
    if (fontDifference > CONFIG.crossFlowFontTolerance) return { merge: false, reason: "cross-flow-font-change" };
    const currentProfile = flowProfiles.get(current.flowKey);
    const indent = current.geometry.left - (currentProfile?.baselineLeft ?? current.flowLeft);
    if (indent > bodyLineHeight * CONFIG.paragraphIndentEm) return { merge: false, reason: "cross-flow-indent" };
    const columnWidth = Math.max(1, previous.flowRight - previous.flowLeft);
    const fill = (previous.geometry.right - previous.flowLeft) / columnWidth;
    const hyphenated = /\p{L}-\s*$/u.test(previous.text) && /^\p{Ll}/u.test(current.text);
    if (hyphenated || !endsWithTerminal(previous.text) || fill >= CONFIG.crossFlowFillRatio) {
      return { merge: true, reason: transition === "page-break" ? "page-continuation" : "column-continuation" };
    }
    return { merge: false, reason: "completed-flow" };
  }

  function joinLineText(previous, current) {
    const left = String(previous || "").replace(/\s+$/u, "");
    const right = String(current || "").replace(/^\s+/u, "");
    if (/\p{L}-$/u.test(left) && /^\p{Ll}/u.test(right)) {
      return { text: left.slice(0, -1) + right, dehyphenated: true };
    }
    if (!left) return { text: right, dehyphenated: false };
    if (!right) return { text: left, dehyphenated: false };
    const noSpace = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left)
      && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right);
    return { text: left + (noSpace ? "" : " ") + right, dehyphenated: false };
  }

  function shouldContinueCaptionParagraph(paragraph, line, bodyLineHeight) {
    if (!paragraph?.lines?.length || paragraph.lines.length >= 5) return false;
    const lead = parseCaptionLead(paragraph.lines[0].text);
    if (!lead || lead.proseContinuation) return false;
    const previous = paragraph.lines[paragraph.lines.length - 1];
    if (previous.flowKey !== line.flowKey || parseCaptionLead(line.text)
      || isHeadingLine(line, bodyLineHeight) || startsList(line.text)
      || isEquationLine(line) || isTableLine(line)) return false;
    const fontDifference = Math.abs(previous.lineHeight - line.lineHeight)
      / Math.max(1, previous.lineHeight, line.lineHeight);
    const gap = line.geometry.top - previous.geometry.bottom;
    const terminalContinuation = !endsWithTerminal(paragraph.text)
      || /^[a-z(\[]/u.test(normalizeText(line.text))
      || line.geometry.left - line.flowLeft > bodyLineHeight * 1.2
      || line.geometry.width / Math.max(1, line.flowRight - line.flowLeft) < 0.82;
    return fontDifference <= 0.25 && gap >= -bodyLineHeight * 0.4
      && gap <= bodyLineHeight * 1.5 && terminalContinuation;
  }

  function buildParagraphs(lines, bodyLineHeight) {
    const flowProfiles = computeFlowProfiles(lines, bodyLineHeight);
    const paragraphs = [];
    let current = null;
    for (const line of lines) {
      const previous = current?.lines?.[current.lines.length - 1] || null;
      const captionContinuation = shouldContinueCaptionParagraph(current, line, bodyLineHeight);
      const decision = captionContinuation
        ? { merge: true, reason: "caption-continuation" }
        : current && parseCaptionLead(current.lines[0]?.text)
          ? { merge: false, reason: "caption-end" }
        : shouldMergeLines(previous, line, flowProfiles, bodyLineHeight);
      if (!current || !decision.merge) {
        current = {
          id: `paragraph:${paragraphs.length}`,
          lines: [line],
          text: line.text,
          mergeTransitions: [],
          transformedHyphenCount: 0,
          breakBeforeReason: decision.reason,
          gapBefore: previous ? line.geometry.top - previous.geometry.bottom : null
        };
        paragraphs.push(current);
      }
      else {
        const joined = joinLineText(current.text, line.text);
        current.text = joined.text;
        current.lines.push(line);
        current.mergeTransitions.push({
          fromLineID: previous.id,
          toLineID: line.id,
          reason: decision.reason
        });
        if (joined.dehyphenated) current.transformedHyphenCount++;
      }
    }
    return paragraphs;
  }

  function classifyParagraphs(paragraphs, bodyLineHeight) {
    for (const paragraph of paragraphs) {
      paragraph.lineHeight = median(paragraph.lines.map(line => line.lineHeight)) || bodyLineHeight;
      paragraph.stats = getTextStats(paragraph.text);
      paragraph.pageIndexes = [...new Set(paragraph.lines.map(line => line.pageIndex))];
      paragraph.firstLine = paragraph.lines[0];
      paragraph.lastLine = paragraph.lines[paragraph.lines.length - 1];
      paragraph.widthRatio = Math.max(...paragraph.lines.map(line =>
        line.geometry.width / Math.max(1, line.flowRight - line.flowLeft)));
    }
    const firstPageParagraphs = paragraphs.filter(paragraph => paragraph.pageIndexes[0] === 0);
    const titleCandidates = firstPageParagraphs.filter(paragraph => {
      const first = paragraph.firstLine;
      return paragraph.text.length >= 12 && paragraph.text.length <= 350
        && paragraph.lines.length <= 5 && first.geometry.topRatio < 0.55
        && !isAbstractMarker(paragraph.text) && !isReferenceHeading(paragraph.text)
        && !/\S+@\S+|\b(?:orcid|https?:\/\/|www\.)\b/iu.test(paragraph.text);
    });
    titleCandidates.forEach((paragraph, index) => {
      paragraph.titleScore = Math.max(0, paragraph.lineHeight / Math.max(1, bodyLineHeight) - 1) * 4
        + Math.max(0, 0.55 - paragraph.firstLine.geometry.topRatio) * 2
        + (paragraph.lines.length >= 2 ? 0.8 : 0)
        + (paragraph.text.length >= 20 && paragraph.text.length <= 220 ? 0.5 : 0) - index * 0.01;
    });
    titleCandidates.sort((a, b) => b.titleScore - a.titleScore);
    const title = titleCandidates[0] || null;
    const abstractIndex = paragraphs.findIndex(paragraph => isAbstractMarker(paragraph.text));
    const referenceIndex = paragraphs.findIndex(paragraph => isReferenceHeading(paragraph.text));
    const sectionIndexes = new Set();
    paragraphs.forEach((paragraph, index) => {
      if (paragraph === title || isAbstractMarker(paragraph.text) || isReferenceHeading(paragraph.text)) return;
      if (paragraph.lines.length <= 2 && paragraph.text.length <= 160 && !endsWithTerminal(paragraph.text)
        && (isCommonHeading(paragraph.text) || paragraph.lineHeight >= bodyLineHeight * 1.10)) {
        sectionIndexes.add(index);
      }
    });
    const firstSectionAfterAbstract = abstractIndex < 0 ? -1
      : [...sectionIndexes].filter(index => index > abstractIndex).sort((a, b) => a - b)[0] ?? -1;
    return paragraphs.map((paragraph, index) => {
      let contentType = "body-paragraph";
      let excludedReason = null;
      if (referenceIndex >= 0 && index >= referenceIndex) excludedReason = "reference-section";
      else if (paragraph === title) contentType = "title";
      else if (isAbstractMarker(paragraph.text)) {
        contentType = /^(?:abstract|summary|摘要|内容摘要)\s*[:：]?\s*$/iu.test(paragraph.text)
          ? "abstract-heading" : "abstract-paragraph";
      }
      else if (sectionIndexes.has(index)) contentType = "section-heading";
      else if (abstractIndex >= 0 && index > abstractIndex
        && (firstSectionAfterAbstract < 0 || index < firstSectionAfterAbstract)) contentType = "abstract-paragraph";
      else if (isKeywordLine(paragraph.text)) excludedReason = "keywords";
      else if (/\S+@\S+|\b(?:orcid|https?:\/\/|www\.)\b/iu.test(paragraph.text)) {
        excludedReason = "author-affiliation-metadata";
      }
      else if (title && abstractIndex >= 0 && paragraph.pageIndexes[0] === 0
        && index > paragraphs.indexOf(title) && index < abstractIndex
        && paragraph.lines.length <= 2) excludedReason = "front-matter-metadata";
      else {
        const captionLead = parseCaptionLead(paragraph.text);
        const captionLayout = paragraph.lines.length <= 4
          && (paragraph.lineHeight <= bodyLineHeight * 0.98
            || Number(paragraph.gapBefore || 0) > bodyLineHeight * 0.8
            || paragraph.widthRatio < 0.88
            || paragraph.firstLine.geometry.left - paragraph.firstLine.flowLeft > bodyLineHeight * 0.8);
        const confirmedCaption = captionLead && !captionLead.proseContinuation
          && ((captionLead.strong && paragraph.lines.length <= 5) || captionLayout);
        if (confirmedCaption) excludedReason = captionLead.kind === "table"
          ? "table-caption" : "figure-caption";
        else if (paragraph.lines.length <= 2 && paragraph.lines.every(isEquationLine)) excludedReason = "equation";
        else if (paragraph.lines.length <= 2 && paragraph.lines.some(isTableLine)) excludedReason = "table-row";
        else if (paragraph.lastLine.geometry.bottomRatio > 0.75
          && paragraph.lineHeight < bodyLineHeight * 0.80 && paragraph.lines.length <= 3) {
          excludedReason = "footnote-like";
        }
      }
      return { paragraph, index, contentType, excludedReason };
    });
  }

  function extract(pages) {
    const pageLines = [];
    const exclusions = [];
    const unitCountByID = new Map();
    let ignoredCharacterCount = 0;
    for (const page of pages || []) {
      for (const char of page.chars || []) {
        if (char.ignorable || !String(char.c || "")) { ignoredCharacterCount += textUnitCount(char.c); continue; }
        unitCountByID.set(char.id, textUnitCount(char.c));
      }
      const clustered = clusterPageLines(page);
      pageLines.push(clustered.lines);
      for (const exclusion of clustered.exclusions) exclusions.push(exclusion);
    }
    const bodyLineHeight = median(pageLines.flat().filter(line => line.geometry.topRatio >= 0.04
      && line.geometry.bottomRatio <= 0.96).map(line => line.lineHeight)) || 1;
    const repeatedEdgeLineIDs = findRepeatedEdgeLineIDs(pageLines);
    const retainedByPage = pageLines.map(lines => {
      const retained = [];
      for (const line of lines) {
        const edge = line.geometry.topRatio < CONFIG.edgeRatio
          || line.geometry.bottomRatio > 1 - CONFIG.edgeRatio;
        if (edge && isStandalonePageNumber(line.text)) {
          exclusions.push(createExclusion("page-number", [line]));
        }
        else if (repeatedEdgeLineIDs.has(line.id)) {
          exclusions.push(createExclusion("repeated-edge-noise", [line]));
        }
        else retained.push(line);
      }
      return retained;
    });
    const layoutDiagnostics = [];
    const orderedLines = [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const ordered = orderPageLines(pages[pageIndex], retainedByPage[pageIndex], bodyLineHeight);
      if (orderedLines.length && ordered.lines.length) ordered.lines[0].transitionBefore = "page-break";
      orderedLines.push(...ordered.lines);
      ordered.diagnostic.inputLineCount = pageLines[pageIndex].length;
      ordered.diagnostic.readingLineCount = ordered.lines.length;
      ordered.diagnostic.excludedEdgeLineCount = pageLines[pageIndex].length - retainedByPage[pageIndex].length;
      const visualRows = new Map();
      for (const line of ordered.lines) {
        if (!visualRows.has(line.visualRowID)) visualRows.set(line.visualRowID, new Set());
        visualRows.get(line.visualRowID).add(line.columnIndex);
      }
      ordered.diagnostic.crossColumnVisualRowCount = [...visualRows.values()]
        .filter(columns => columns.has(0) && columns.has(1)).length;
      ordered.diagnostic.crossColumnLineMergeCount = 0;
      ordered.diagnostic.unassignedLineIDs = [];
      layoutDiagnostics.push(ordered.diagnostic);
    }
    const tableLineReasons = detectTableLineReasons(orderedLines, bodyLineHeight);
    const tableGroups = new Map();
    for (const line of orderedLines) {
      const reason = tableLineReasons.get(line.id);
      if (!reason) continue;
      const key = `${reason}:${line.pageIndex}:${line.flowKey}`;
      if (!tableGroups.has(key)) tableGroups.set(key, { reason, lines: [] });
      tableGroups.get(key).lines.push(line);
    }
    for (const group of tableGroups.values()) {
      exclusions.push(createExclusion(group.reason, group.lines,
        group.lines.map(line => line.text).join(" "), { source: "layout-table-region" }));
    }
    for (const diagnostic of layoutDiagnostics) {
      diagnostic.excludedTableLineCount = orderedLines.filter(line =>
        line.pageIndex === diagnostic.pageIndex && tableLineReasons.has(line.id)).length;
    }
    const paragraphLines = orderedLines.filter(line => !tableLineReasons.has(line.id));
    const paragraphs = buildParagraphs(paragraphLines, bodyLineHeight);
    const classified = classifyParagraphs(paragraphs, bodyLineHeight);
    const raw = [];
    const paragraphDiagnostics = [];
    for (const item of classified) {
      const paragraph = item.paragraph;
      const charIDs = [...new Set(paragraph.lines.flatMap(line => line.charIDs))];
      const diagnostic = {
        paragraphIndex: item.index,
        included: !item.excludedReason,
        contentType: item.excludedReason ? null : item.contentType,
        excludedReason: item.excludedReason,
        sourceLineIDs: paragraph.lines.map(line => line.id),
        pageIndexes: paragraph.pageIndexes,
        columnIndexes: [...new Set(paragraph.lines.map(line => line.columnIndex))],
        mergeTransitions: paragraph.mergeTransitions,
        breakBeforeReason: paragraph.breakBeforeReason,
        transformedHyphenCount: paragraph.transformedHyphenCount,
        sampleText: paragraph.text.slice(0, 240)
      };
      paragraphDiagnostics.push(diagnostic);
      if (item.excludedReason) {
        exclusions.push(createExclusion(item.excludedReason, paragraph.lines, paragraph.text,
          { paragraphIndex: item.index }));
      }
      else {
        raw.push({
          sourceIndex: raw.length,
          sourceOrder: item.index,
          text: paragraph.text,
          contentType: item.contentType,
          charIDs,
          position: makePosition(paragraph.lines)
        });
      }
    }
    const assignmentCounts = new Map();
    const assign = charIDs => {
      for (const id of charIDs || []) assignmentCounts.set(id, (assignmentCounts.get(id) || 0) + 1);
    };
    raw.forEach(paragraph => assign(paragraph.charIDs));
    exclusions.forEach(exclusion => assign(exclusion.charIDs));
    let includedCharacterCount = 0;
    let excludedCharacterCount = 0;
    let unassignedCharacterCount = 0;
    let duplicateCharacterCount = 0;
    for (const [id, count] of unitCountByID) {
      const assignments = assignmentCounts.get(id) || 0;
      if (!assignments) unassignedCharacterCount += count;
      else if (assignments > 1) duplicateCharacterCount += count * (assignments - 1);
    }
    for (const paragraph of raw) {
      includedCharacterCount += paragraph.charIDs.reduce((sum, id) => sum + (unitCountByID.get(id) || 0), 0);
      delete paragraph.charIDs;
    }
    for (const exclusion of exclusions) {
      excludedCharacterCount += (exclusion.charIDs || []).reduce((sum, id) => sum + (unitCountByID.get(id) || 0), 0);
      delete exclusion.charIDs;
    }
    return {
      raw,
      layoutDiagnostics,
      paragraphDiagnostics,
      exclusions,
      textConservation: {
        inputCharacterCount: [...unitCountByID.values()].reduce((sum, count) => sum + count, 0)
          + ignoredCharacterCount,
        includedCharacterCount,
        excludedCharacterCount,
        ignoredCharacterCount,
        transformedHyphenCount: paragraphs.reduce((sum, paragraph) => sum + paragraph.transformedHyphenCount, 0),
        unassignedCharacterCount,
        duplicateCharacterCount
      },
      summary: {
        bodyLineHeight: Number(bodyLineHeight.toFixed(3)),
        includedParagraphCount: raw.length,
        excludedItemCount: exclusions.length,
        includedCountsByType: raw.reduce((result, paragraph) => {
          result[paragraph.contentType] = (result[paragraph.contentType] || 0) + 1;
          return result;
        }, {}),
        excludedCountsByReason: exclusions.reduce((result, exclusion) => {
          result[exclusion.reason] = (result[exclusion.reason] || 0) + 1;
          return result;
        }, {})
      }
    };
  }

  global.ReaderBodyLayoutExtractor = { CONFIG, extract, normalizeText };
})(typeof globalThis !== "undefined" ? globalThis : this);
