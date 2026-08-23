(function (global) {
  "use strict";

  const { copyPosition, buildPositionFromChars } = global.TranslatorCore;

  var ReaderMetadataLoader = {
    async getItem(itemID) {
      if (!itemID) return null;
      if (typeof Zotero.Items?.getAsync === "function") return Zotero.Items.getAsync(itemID);
      return Zotero.Items?.get?.(itemID) || null;
    },

    async read(reader) {
      const attachment = reader?._item || await this.getItem(reader?.itemID);
      const parentID = attachment?.parentID || attachment?.parentItemID || null;
      const parent = parentID ? await this.getItem(parentID) : null;
      const readField = name => {
        try { return String(parent?.getField?.(name) || "").trim(); }
        catch (_) { return ""; }
      };
      const title = readField("title");
      const abstractText = readField("abstractNote");
      return {
        title,
        abstractText,
        source: parent ? "parent-item" : "none",
        parentItemID: parent ? parentID : null
      };
    }
  };

  const FRONT_MATTER_PAGE_INDEX = 0;
  const FRONT_MATTER_MATCH_THRESHOLDS = Object.freeze({
    title: 0.72,
    abstract: 0.60,
    high: 0.85
  });

  function decodeMetadataEntities(value) {
    return String(value || "")
      .replace(/&nbsp;/giu, " ")
      .replace(/&amp;/giu, "&")
      .replace(/&lt;/giu, "<")
      .replace(/&gt;/giu, ">")
      .replace(/&quot;/giu, '"')
      .replace(/&#(\d+);/gu, (_, code) => {
        const point = Number(code);
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point) : "";
      })
      .replace(/&#x([0-9a-f]+);/giu, (_, code) => {
        const point = Number.parseInt(code, 16);
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point) : "";
      });
  }

  function normalizeFrontMatterText(value) {
    return decodeMetadataEntities(value)
      .replace(/<[^>]*>/gu, " ")
      .normalize("NFKC")
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/[“”„‟]/gu, '"')
      .replace(/[‘’‚‛]/gu, "'")
      .replace(/[\u00ad\u200b-\u200d\ufeff]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function normalizeFrontMatterHeading(value) {
    const text = normalizeFrontMatterText(value);
    const parts = text.split(/\s+/u).filter(Boolean);
    if (parts.length >= 3 && parts.every(part => [...part].length === 1
      && /\p{L}/u.test(part))) return parts.join("");
    return text;
  }

  function stripOptionalAbstractHeading(value) {
    const text = normalizeFrontMatterText(value);
    return /^(?:abstract|summary|鎽樿|鍐呭鎽樿)(?:\s+|$)/iu.test(
      normalizeFrontMatterHeading(text))
      ? text.replace(/^(?:abstract|summary|鎽樿|鍐呭鎽樿)\s*/iu, "")
      : text;
  }

  function trimMetadataAnchorRange(text, start, end) {
    let left = Math.max(0, start);
    let right = Math.min(text.length, end);
    while (left < right && /\s/u.test(text[left])) left++;
    while (right > left && /\s/u.test(text[right - 1])) right--;
    while (left > 0 && !/\s/u.test(text[left - 1])) left--;
    while (right < text.length && !/\s/u.test(text[right])) right++;
    return [left, right];
  }

  function makeMetadataAnchors(value, kind = "abstract") {
    const text = stripOptionalAbstractHeading(value);
    if (!text) return [];
    if (text.length <= (kind === "title" ? 48 : 96)) {
      return [{ text, start: 0, end: text.length }];
    }
    const width = kind === "title"
      ? Math.min(44, Math.max(24, Math.floor(text.length / 2)))
      : Math.min(48, Math.max(32, Math.floor(text.length / 4)));
    const ranges = kind === "title" && text.length <= 96
      ? [
        [0, width],
        [text.length - width, text.length]
      ]
      : [
        [0, width],
        [Math.floor(text.length / 2) - Math.floor(width / 2),
          Math.floor(text.length / 2) + Math.ceil(width / 2)],
        [text.length - width, text.length]
      ];
    const trimmedRanges = ranges.map(([start, end]) => trimMetadataAnchorRange(text, start, end));
    const seen = new Set();
    return trimmedRanges.map(([start, end]) => ({
      text: text.slice(start, end), start, end
    })).filter(anchor => anchor.text.length >= 12 && !seen.has(anchor.text)
      && seen.add(anchor.text));
  }

  function buildFrontMatterTextIndex(pages) {
    const tokens = [];
    const sourceIDs = [];
    const chars = [];
    const orderedPages = [...(pages || [])].sort((left, right) => left.pageIndex - right.pageIndex);
    let previousPage = null;
    for (const page of orderedPages) {
      if (previousPage !== null) {
        tokens.push(" ");
        sourceIDs.push(null);
      }
      const pageChars = [...(page.chars || [])].sort((left, right) => left.offset - right.offset);
      const nextNonSpace = [];
      let nextText = "";
      for (let index = pageChars.length - 1; index >= 0; index--) {
        nextNonSpace[index] = nextText;
        if (String(pageChars[index].c || "")
          && !/^\s+$/u.test(String(pageChars[index].c || ""))) {
          nextText = String(pageChars[index].c || "");
        }
      }
      chars.push(...pageChars);
      for (let index = 0; index < pageChars.length; index++) {
        const char = pageChars[index];
        if (char.ignorable) continue;
        let value = String(char.c || "").normalize("NFKC")
          .replace(/[\u2010-\u2015\u2212]/gu, "-")
          .replace(/[“”„‟]/gu, '"')
          .replace(/[‘’‚‛]/gu, "'")
          .replace(/[\u00ad\u200b-\u200d\ufeff]/gu, "");
        if (/-$/u.test(value) && char.lineBreakAfter
          && /^\p{Ll}/u.test(nextNonSpace[index] || "")) value = value.slice(0, -1);
        for (const token of [...value.toLocaleLowerCase()]) {
          tokens.push(token);
          sourceIDs.push(char.id);
        }
        if (char.lineBreakAfter || char.paragraphBreakAfter || char.spaceAfter) {
          tokens.push(" ");
          sourceIDs.push(char.id);
        }
      }
      previousPage = page.pageIndex;
    }
    const compactTokens = [];
    const compactIDs = [];
    let pendingSpace = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (/\s/u.test(token)) {
        if (compactTokens.length && !pendingSpace) {
          compactTokens.push(" ");
          compactIDs.push(sourceIDs[index]);
        }
        pendingSpace = true;
        continue;
      }
      compactTokens.push(token);
      compactIDs.push(sourceIDs[index]);
      pendingSpace = false;
    }
    while (compactTokens[0] === " ") {
      compactTokens.shift();
      compactIDs.shift();
    }
    while (compactTokens.at(-1) === " ") {
      compactTokens.pop();
      compactIDs.pop();
    }
    return { tokens: compactTokens, sourceIDs: compactIDs, chars };
  }

  function findFrontMatterSequence(haystack, needle, fromIndex = 0) {
    if (!needle.length || needle.length > haystack.length) return null;
    outer: for (let index = Math.max(0, Number(fromIndex || 0));
      index <= haystack.length - needle.length; index++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (haystack[index + offset] !== needle[offset]) continue outer;
      }
      return [index, index + needle.length];
    }
    return null;
  }

  function buildFrontMatterVisualTextIndex(region, pages) {
    if (!region?.lines?.length) return null;
    let offset = 0;
    const visualPages = [];
    const pageGroups = new Map();
    for (const line of [...region.lines].sort(frontMatterLocatorLineSort)) {
      const pageIndex = Number(line.pageIndex || 0);
      if (!pageGroups.has(pageIndex)) pageGroups.set(pageIndex, []);
      const textChars = [...String(line.text || "")];
      const itemIDs = (line.itemIDs || []).map(String);
      textChars.forEach((value, index) => pageGroups.get(pageIndex).push({
        id: itemIDs[Math.min(itemIDs.length - 1,
          Math.floor(index * itemIDs.length / Math.max(1, textChars.length)))] || String(line.id),
        pageIndex,
        c: value,
        offset: offset++,
        lineBreakAfter: index === textChars.length - 1,
        paragraphBreakAfter: false,
        ignorable: false
      }));
    }
    for (const [pageIndex, chars] of [...pageGroups.entries()].sort((a, b) => a[0] - b[0])) {
      visualPages.push({ pageIndex, chars });
    }
    return buildFrontMatterTextIndex(visualPages);
  }

  function filterFrontMatterPages(pages, sourceCharIDs) {
    const allowed = new Set((sourceCharIDs || []).map(String));
    return (pages || []).map(page => ({
      ...page,
      chars: (page.chars || []).filter(char => allowed.has(String(char.id))
        || /^\s+$/u.test(String(char.c || "")))
    })).filter(page => page.chars.length);
  }

  function matchMetadataRegion(text, region, pages, kind) {
    const anchors = makeMetadataAnchors(text, kind);
    if (!anchors.length || !region?.sourceCharIDs?.length) return null;
    const index = (kind === "abstract" ? buildFrontMatterVisualTextIndex(region, pages) : null)
      || buildFrontMatterTextIndex(filterFrontMatterPages(pages, region.sourceCharIDs));
    const matched = [];
    const matchedAnchorCharIDs = [];
    const sourceCharIDs = new Set();
    let searchStart = 0;
    for (const anchor of anchors) {
      const needle = [...anchor.text];
      const range = findFrontMatterSequence(index.tokens, needle,
        kind === "abstract" ? searchStart : 0);
      if (!range) continue;
      if (kind === "abstract") searchStart = range[1];
      const hitIDs = index.sourceIDs.slice(range[0], range[1]).filter(Boolean);
      matched.push({ ...anchor, tokenStart: range[0], tokenEnd: range[1] });
      matchedAnchorCharIDs.push(hitIDs);
      for (const id of hitIDs) sourceCharIDs.add(id);
    }
    const targetText = stripOptionalAbstractHeading(text);
    const covered = matched.reduce((sum, anchor) => sum + Math.max(0, anchor.end - anchor.start), 0);
    const directCoverage = Math.min(1, covered / Math.max(1, targetText.length));
    const spanCoverage = matched.length >= 2
      ? (Math.max(...matched.map(anchor => anchor.end))
        - Math.min(...matched.map(anchor => anchor.start))) / Math.max(1, targetText.length)
      : 0;
    const coverage = Math.min(1, Math.max(directCoverage, spanCoverage));
    const threshold = FRONT_MATTER_MATCH_THRESHOLDS[kind];
    const requiredAnchors = Math.min(2, anchors.length);
    if (matched.length < requiredAnchors || coverage < threshold) return null;
    return {
      sourceCharIDs: [...sourceCharIDs],
      matchedAnchorCount: matched.length,
      anchorCount: anchors.length,
      matchedAnchors: matched.map(anchor => ({ start: anchor.start, end: anchor.end })),
      matchedAnchorCharIDs,
      metadataCoverage: coverage,
      confidence: matched.length === anchors.length && coverage >= FRONT_MATTER_MATCH_THRESHOLDS.high
        ? "high" : "medium"
    };
  }

  function buildFrontMatterTarget(kind, text, region, pages, match, matchMethod) {
    let sourceCharIDs = [...new Set((region?.sourceCharIDs || []).map(String))];
    let sourceLineIDs = [...new Set((region?.sourceLineIDs || []).map(String))];
    let position = copyPosition(region?.position);
    if (kind === "title" && matchMethod === "metadata-segmented" && match?.sourceCharIDs?.length) {
      const matched = new Set(match.sourceCharIDs.map(String));
      const lineCharIDs = Array.isArray(region?.sourceLineCharIDs)
        ? region.sourceLineCharIDs : [];
      const hitIndexes = lineCharIDs.map((ids, index) =>
        ids.some(id => matched.has(String(id))) ? index : -1
      ).filter(index => index >= 0);
      if (hitIndexes.length && hitIndexes.length <= sourceLineIDs.length) {
        const first = Math.min(...hitIndexes);
        const last = Math.max(...hitIndexes);
        const selectedLineCharIDs = lineCharIDs.slice(first, last + 1);
        const selectedLineIDs = sourceLineIDs.slice(first, last + 1);
        const selectedChars = [...new Set(selectedLineCharIDs.flat().map(String))];
        if (selectedChars.length >= 2 && selectedLineIDs.length) {
          sourceCharIDs = selectedChars;
          sourceLineIDs = selectedLineIDs;
          position = null;
        }
      }
    }
    if (!position) {
      const selected = new Set(sourceCharIDs);
      const chars = (pages || []).flatMap(page => page.chars || [])
        .filter(char => selected.has(String(char.id)) && !char.ignorable);
      position = buildPositionFromChars(chars);
    }
    if (!position) return null;
    return {
      kind,
      text: String(text || region?.text || ""),
      sourceCharIDs,
      sourceLineIDs,
      position,
      confidence: match?.confidence || region?.confidence || "low",
      matchMethod,
      metadataCoverage: Number(match?.metadataCoverage || 0),
      matchedAnchorCount: Number(match?.matchedAnchorCount || 0),
      pageIndexes: [...new Set((region?.pageIndexes || []).map(Number))].sort((a, b) => a - b)
    };
  }

  function frontMatterLocatorLineSort(left, right) {
    return Number(left?.pageIndex || 0) - Number(right?.pageIndex || 0)
      || Number(left?.geometry?.top || 0) - Number(right?.geometry?.top || 0)
      || Number(left?.geometry?.left || 0) - Number(right?.geometry?.left || 0);
  }

  function frontMatterLocatorLineSide(line) {
    const pageWidth = Math.max(1, Number(
      line?.pageWidth || line?.geometry?.right || line?.flowRight || 1
    ));
    const rect = line?.geometry;
    const gutter = Number(line?.pageGutter);
    if (rect && Number.isFinite(gutter) && gutter > 0 && gutter < pageWidth) {
      if (rect.left < gutter && rect.right > gutter) return -1;
      const tolerance = Math.max(pageWidth * 0.012, Number(line?.fontHeight || 1) * 0.75);
      if (rect.centerX <= gutter - tolerance) return 0;
      if (rect.centerX >= gutter + tolerance) return 1;
    }
    if (line?.columnIndex === 0 || line?.columnIndex === 1) return line.columnIndex;
    const width = Number(rect?.width
      || Number(rect?.right || 0) - Number(rect?.left || 0));
    if (width / pageWidth >= 0.82) return -1;
    const center = (Number(rect?.left || 0) + Number(rect?.right || 0))
      / 2 / pageWidth;
    if (center <= 0.42) return 0;
    if (center >= 0.58) return 1;
    return Number.isInteger(line?.columnIndex) ? line.columnIndex : -1;
  }

  function abstractLocatorBoundary(value) {
    const text = normalizeFrontMatterText(value);
    const compact = normalizeFrontMatterHeading(text).replace(/\s+/gu, "");
    return /^(?:keywords?|key\s*words?|article\s*info|articleinfo)\b/iu.test(text)
      || /^(?:keywords?|key\s*words?|articleinfo)[:：]/iu.test(compact)
      || /^(?:copyright|©|all\s+rights\s+reserved|received|accepted|available\s+online|published\s+online)\b/iu.test(text)
      || /^(?:\d+(?:\.\d+)*\.?\s+)?(?:introduction|background|methodology|materials?(?:\s+and\s+methods?)?|methods?|results?|discussion|conclusions?)\s*$/iu.test(text);
  }

  function abstractLocatorLineAfter(line, anchor) {
    if (!line || !anchor) return false;
    return Number(line.pageIndex || 0) > Number(anchor.pageIndex || 0)
      || (Number(line.pageIndex || 0) === Number(anchor.pageIndex || 0)
        && Number(line.geometry?.top || 0) > Number(anchor.geometry?.bottom || 0));
  }

  function abstractFlowBandFromLine(line, side) {
    if (!line) return null;
    const pageWidth = Math.max(1, Number(line.pageWidth || line.geometry?.right || 1));
    const gutter = Number(line.pageGutter);
    const hasGutter = Number.isFinite(gutter) && gutter > 0 && gutter < pageWidth;
    if (side === 0) {
      return {
        left: 0,
        right: hasGutter ? gutter : Number(line.flowRight || pageWidth)
      };
    }
    if (side === 1) {
      return {
        left: hasGutter ? gutter : Number(line.flowLeft || 0),
        right: pageWidth
      };
    }
    return {
      left: Number(line.geometry?.left || 0),
      right: Number(line.geometry?.right || pageWidth)
    };
  }

  function abstractSpanSeedPair(lines, heading = null) {
    const candidates = [...(lines || [])]
      .filter(line => line?.geometry && frontMatterLocatorLineSide(line) === -1)
      .sort(frontMatterLocatorLineSort)
      .slice(0, 2);
    if (candidates.length < 2) return [];
    const [first, second] = candidates;
    if (Number(first.pageIndex || 0) !== Number(second.pageIndex || 0)) return [];
    const gutterValue = first.pageGutter ?? second.pageGutter;
    if (gutterValue === null || gutterValue === undefined
      || !Number.isFinite(Number(gutterValue))) return [];
    const pageWidth = Math.max(1, Number(first.pageWidth || second.pageWidth || 1));
    const height = Math.max(1, Number(first.fontHeight || 1), Number(second.fontHeight || 1));
    const leftTolerance = Math.max(pageWidth * 0.025, height * 2);
    if (Number(first.geometry.width || 0) / pageWidth < 0.62
      || Number(second.geometry.width || 0) / pageWidth < 0.62
      || Math.abs(Number(first.geometry.left || 0) - Number(second.geometry.left || 0)) > leftTolerance
      || Number(second.geometry.top || 0) < Number(first.geometry.top || 0) - height * 0.35) return [];
    if (heading?.geometry
      && Math.abs(Number(first.geometry.left || 0) - Number(heading.geometry.left || 0)) > leftTolerance) {
      return [];
    }
    return candidates;
  }

  function abstractSpanPageBand(seedLines, pageIndex) {
    const pageSeeds = (seedLines || []).filter(line =>
      Number(line.pageIndex || 0) === Number(pageIndex || 0));
    const seeds = pageSeeds.length ? pageSeeds : seedLines;
    if (!seeds?.length) return null;
    const lefts = seeds.map(line => Number(line.geometry?.left || 0));
    const rights = seeds.map(line => Number(line.geometry?.right || 0));
    return {
      pageIndex: Number(pageIndex || 0),
      left: Math.min(...lefts),
      right: Math.max(...rights),
      columnIndex: -1,
      anchorLeft: lefts.reduce((sum, value) => sum + value, 0) / lefts.length,
      anchorRight: rights.reduce((sum, value) => sum + value, 0) / rights.length
    };
  }

  function resolveAbstractFlow(frontMatter, seedLines = []) {
    const stored = frontMatter?.abstractFlow;
    if (stored && stored.confidence !== "low" && Array.isArray(stored.pageBands)) return stored;
    const layoutLines = (frontMatter?.layoutLines || [])
      .filter(line => line?.id && line.geometry && Array.isArray(line.itemIDs) && line.itemIDs.length)
      .sort(frontMatterLocatorLineSort);
    const heading = frontMatter?.abstractHeading?.lineID
      ? layoutLines.find(line => line.id === frontMatter.abstractHeading.lineID) : null;
    const seeds = [heading, ...(seedLines || [])].filter(Boolean);
    if (!seeds.length) return null;
    const spanSeeds = abstractSpanSeedPair(seedLines, heading);
    if (spanSeeds.length === 2) {
      const pageIndexes = [...new Set(layoutLines.map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b);
      return {
        mode: "span",
        columnIndex: -1,
        seedLineIDs: [heading, ...spanSeeds].filter(Boolean).map(line => String(line.id)),
        pageBands: pageIndexes.map(pageIndex => abstractSpanPageBand(spanSeeds, pageIndex)),
        confidence: "high"
      };
    }
    const headingSide = heading ? frontMatterLocatorLineSide(heading) : -1;
    const sideCounts = new Map();
    for (const line of seeds) {
      const side = frontMatterLocatorLineSide(line);
      if (side >= 0) sideCounts.set(side, (sideCounts.get(side) || 0) + 1);
    }
    const dominantSide = [...sideCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    const columnIndex = headingSide >= 0 ? headingSide
      : (Number.isInteger(dominantSide) ? dominantSide : -1);
    const matchingSeeds = seeds.filter(line => frontMatterLocatorLineSide(line) === columnIndex);
    if (columnIndex < 0 || matchingSeeds.length < 2) return null;
    const pageIndexes = [...new Set(layoutLines.map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b);
    const pageBands = pageIndexes.map(pageIndex => {
      const pageLines = layoutLines.filter(line => Number(line.pageIndex || 0) === pageIndex);
      const pageSeed = matchingSeeds.find(line => Number(line.pageIndex || 0) === pageIndex)
        || pageLines.find(line => frontMatterLocatorLineSide(line) === columnIndex)
        || matchingSeeds[0];
      const band = abstractFlowBandFromLine(pageSeed, columnIndex);
      return {
        pageIndex,
        left: band?.left ?? 0,
        right: band?.right ?? Number(pageSeed.pageWidth || 1),
        columnIndex
      };
    });
    return {
      mode: "column",
      columnIndex,
      seedLineIDs: matchingSeeds.slice(0, 3).map(line => String(line.id)),
      pageBands,
      confidence: matchingSeeds.length >= 3 ? "high" : "medium"
    };
  }

  function abstractFlowLineMatches(line, flow, anchor = null) {
    if (!line || !flow || !line.geometry) return false;
    const expectedSide = Number(flow.columnIndex);
    const lineSide = frontMatterLocatorLineSide(line);
    const band = (flow.pageBands || []).find(value =>
      Number(value.pageIndex || 0) === Number(line.pageIndex || 0))
      || abstractFlowBandFromLine(anchor || line, expectedSide);
    if (!band) return false;
    const lineRect = line.geometry;
    const bandWidth = Math.max(1, Number(band.right) - Number(band.left));
    const lineWidth = Math.max(1, Number(lineRect.right) - Number(lineRect.left));
    const overlap = Math.max(0, Math.min(Number(lineRect.right), Number(band.right))
      - Math.max(Number(lineRect.left), Number(band.left)));
    const overlapRatio = overlap / Math.min(lineWidth, bandWidth);
    const center = (Number(lineRect.left) + Number(lineRect.right)) / 2;
    const centerWithinBand = center >= Number(band.left) - Number(line.fontHeight || 1) * 2
      && center <= Number(band.right) + Number(line.fontHeight || 1) * 2;
    if (flow.mode === "span") {
      if (lineSide === 1) return false;
      const pageWidth = Math.max(1, Number(line.pageWidth || lineRect.right || 1));
      const fontHeight = Math.max(1, Number(line.fontHeight || 1));
      const anchorLeft = Number(band.anchorLeft ?? band.left);
      const leftAligned = Math.abs(Number(lineRect.left) - anchorLeft)
        <= Math.max(pageWidth * 0.025, fontHeight * 2);
      const sufficientlyWide = lineWidth >= Math.max(fontHeight * 4, bandWidth * 0.10);
      return leftAligned && sufficientlyWide && overlapRatio >= 0.35 && centerWithinBand;
    }
    if (expectedSide >= 0 && lineSide >= 0 && lineSide !== expectedSide) return false;
    if (expectedSide < 0 && lineSide >= 0) return false;
    if (expectedSide < 0) return overlapRatio >= 0.35 && centerWithinBand;
    if (lineSide === expectedSide) return overlapRatio >= 0.18 && centerWithinBand;
    return overlapRatio >= 0.50 && centerWithinBand;
  }

  function makeAbstractLayoutRegion(frontMatter) {
    const layoutLines = (frontMatter?.layoutLines || [])
      .filter(line => line?.id && Array.isArray(line.itemIDs) && line.itemIDs.length)
      .sort(frontMatterLocatorLineSort);
    const headingInfo = frontMatter?.abstractHeading;
    if (!layoutLines.length || !headingInfo) return null;
    const heading = layoutLines.find(line => line.id === headingInfo.lineID);
    if (!heading) return null;
    const candidate = frontMatter?.abstractCandidates?.[0] || null;
    const flow = resolveAbstractFlow(frontMatter, candidate?.sourceLineIDs
      ?.map(id => layoutLines.find(line => line.id === id)).filter(Boolean));
    if (!flow || flow.confidence === "low") return null;
    const bodyStartInfo = frontMatter?.bodyStart;
    const bodyStart = bodyStartInfo?.lineID
      ? layoutLines.find(line => line.id === bodyStartInfo.lineID) : null;
    const bodyStartInFlow = bodyStart && abstractFlowLineMatches(bodyStart, flow, heading);
    const lines = [];
    let boundaryReason = null;
    let boundaryLineID = null;
    for (const line of layoutLines) {
      if (!abstractLocatorLineAfter(line, heading)) continue;
      const bodyStartReached = bodyStart && (Number(line.pageIndex || 0) > Number(bodyStart.pageIndex || 0)
        || (Number(line.pageIndex || 0) === Number(bodyStart.pageIndex || 0)
          && Number(line.geometry?.top || 0) >= Number(bodyStart.geometry?.top || 0)));
      const previousLine = lines.at(-1);
      const crossFlowBoundaryGap = bodyStartReached && previousLine
        ? Number(bodyStart.geometry?.top || 0) - Number(previousLine.geometry?.bottom || 0) : -Infinity;
      const crossFlowBodyStart = bodyStartReached && lines.length >= 2
        && crossFlowBoundaryGap >= Math.max(
          Number(bodyStart.fontHeight || 1), Number(previousLine?.fontHeight || 1)
        ) * 1.5;
      if (bodyStartReached && (bodyStartInFlow || crossFlowBodyStart)) {
        boundaryReason = "body-start";
        boundaryLineID = String(bodyStart.id);
        break;
      }
      if (!abstractFlowLineMatches(line, flow, heading)) continue;
      if (abstractLocatorBoundary(line.text)) {
        boundaryReason = "abstract-boundary";
        boundaryLineID = String(line.id);
        break;
      }
      if (line.exclusionReason) continue;
      lines.push(line);
    }
    if (!lines.length) return null;
    return {
      abstractFlow: flow,
      lines,
      sourceCharIDs: [...new Set(lines.flatMap(line => line.itemIDs.map(String)))],
      sourceLineIDs: lines.map(line => String(line.id)),
      sourceLineCharIDs: lines.map(line => line.itemIDs.map(String)),
      pageIndexes: [...new Set(lines.map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b),
      boundaryReason,
      boundaryLineID,
      position: null
    };
  }

  function narrowAbstractLayoutRegion(region, match, text) {
    const matchedIDs = new Set((match?.sourceCharIDs || []).map(String));
    const hitIndexes = region.lines.map((line, index) =>
      line.itemIDs.some(id => matchedIDs.has(String(id))) ? index : -1
    ).filter(index => index >= 0);
    const anchors = match?.matchedAnchors || [];
    const hasTailAnchor = anchors.some(anchor =>
      Number(anchor.end || 0) >= stripOptionalAbstractHeading(text).length * 0.82);
    if (hitIndexes.length < 2 || !hasTailAnchor) return region;
    const first = Math.min(...hitIndexes);
    const last = Math.max(...hitIndexes);
    const lines = region.lines.slice(first, last + 1);
    return {
      ...region,
      lines,
      sourceCharIDs: [...new Set(lines.flatMap(line => line.itemIDs.map(String)))],
      sourceLineIDs: lines.map(line => String(line.id)),
      sourceLineCharIDs: lines.map(line => line.itemIDs.map(String)),
      pageIndexes: [...new Set(lines.map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b)
    };
  }

  function makeFrontMatterLineRegion(lines) {
    const ordered = [...(lines || [])]
      .filter(line => line?.id && Array.isArray(line.itemIDs) && line.itemIDs.length)
      .sort(frontMatterLocatorLineSort);
    if (!ordered.length) return null;
    return {
      text: ordered.map(line => String(line.text || "")).join(" "),
      lines: ordered,
      sourceCharIDs: [...new Set(ordered.flatMap(line => line.itemIDs.map(String)))],
      sourceLineIDs: ordered.map(line => String(line.id)),
      sourceLineCharIDs: ordered.map(line => line.itemIDs.map(String)),
      pageIndexes: [...new Set(ordered.map(line => Number(line.pageIndex || 0)))].sort((a, b) => a - b),
      position: null
    };
  }

  function frontMatterLineSameFlow(left, right) {
    if (!left || !right) return false;
    const leftSide = frontMatterLocatorLineSide(left);
    const rightSide = frontMatterLocatorLineSide(right);
    if (leftSide >= 0 && rightSide >= 0) return leftSide === rightSide;
    if (Number(left.pageIndex || 0) !== Number(right.pageIndex || 0)) {
      return leftSide === rightSide || leftSide < 0 || rightSide < 0;
    }
    const leftRect = left.geometry;
    const rightRect = right.geometry;
    if (!leftRect || !rightRect) return leftSide === rightSide;
    const leftWidth = Math.max(1, Number(leftRect.right) - Number(leftRect.left));
    const rightWidth = Math.max(1, Number(rightRect.right) - Number(rightRect.left));
    const overlap = Math.max(0, Math.min(Number(leftRect.right), Number(rightRect.right))
      - Math.max(Number(leftRect.left), Number(rightRect.left)));
    if (leftSide === -1 || rightSide === -1) {
      return overlap / Math.min(leftWidth, rightWidth) >= 0.25;
    }
    return false;
  }

  function metadataAnchorLineEntries(region, match) {
    const lineByCharID = new Map();
    for (const line of region?.lines || []) {
      for (const id of line.itemIDs || []) lineByCharID.set(String(id), line);
    }
    return (match?.matchedAnchorCharIDs || []).map((ids, index) => {
      const lines = [...new Set((ids || []).map(id => lineByCharID.get(String(id))).filter(Boolean))]
        .sort(frontMatterLocatorLineSort);
      return {
        anchor: match?.matchedAnchors?.[index] || null,
        lines,
        firstLine: lines[0] || null,
        lastLine: lines.at(-1) || null
      };
    }).filter(entry => entry.firstLine && entry.lastLine);
  }

  function chooseMetadataAnchorGroup(entries, kind = "title") {
    const allowSingle = kind === "title";
    let best = null;
    for (const seed of entries || []) {
      const group = entries.filter(entry => frontMatterLineSameFlow(seed.firstLine, entry.firstLine))
        .sort((left, right) => frontMatterLocatorLineSort(left.firstLine, right.firstLine));
      if (group.length < (allowSingle ? 1 : 2)) continue;
      const score = group.length * 100
        - Number(group.at(-1).lastLine.pageIndex || 0)
        - Number(group.at(-1).lastLine.geometry?.top || 0) / 100000;
      if (!best || score > best.score) best = { entries: group, score };
    }
    return best?.entries || [];
  }

  function frontMatterLineBefore(left, right) {
    return frontMatterLocatorLineSort(left, right) < 0;
  }

  function makeMetadataSearchRegion(frontMatter, kind) {
    const layoutLines = (frontMatter?.layoutLines || [])
      .filter(line => line?.id && Array.isArray(line.itemIDs) && line.itemIDs.length
        && !line.exclusionReason)
      .sort(frontMatterLocatorLineSort);
    if (!layoutLines.length) return null;
    if (kind !== "title") return makeFrontMatterLineRegion(layoutLines);

    const heading = frontMatter?.abstractHeading?.lineID
      ? layoutLines.find(line => line.id === frontMatter.abstractHeading.lineID) : null;
    const bodyStart = frontMatter?.bodyStart?.lineID
      ? layoutLines.find(line => line.id === frontMatter.bodyStart.lineID) : null;
    const cutoff = heading || bodyStart;
    const lines = layoutLines.filter(line => Number(line.pageIndex || 0) <= 1
      && (!cutoff || frontMatterLineBefore(line, cutoff)));
    return makeFrontMatterLineRegion(lines);
  }

  function makeAbstractMetadataSearchRegions(frontMatter) {
    const lines = (frontMatter?.layoutLines || [])
      .filter(line => line?.id && Array.isArray(line.itemIDs) && line.itemIDs.length
        && !line.exclusionReason && Number(line.pageIndex || 0) === FRONT_MATTER_PAGE_INDEX)
      .sort(frontMatterLocatorLineSort);
    const regions = [];
    const add = candidateLines => {
      const region = makeFrontMatterLineRegion(candidateLines);
      if (!region) return;
      const key = region.sourceLineIDs.join("|");
      if (!regions.some(value => value.sourceLineIDs.join("|") === key)) regions.push(region);
    };
    const storedFlow = frontMatter?.abstractFlow;
    if (storedFlow && storedFlow.confidence !== "low") {
      add(lines.filter(line => abstractFlowLineMatches(line, storedFlow)));
    }
    add(lines.filter(line => frontMatterLocatorLineSide(line) === -1));
    add(lines.filter(line => frontMatterLocatorLineSide(line) === 0));
    add(lines.filter(line => frontMatterLocatorLineSide(line) === 1));
    if (!regions.length) add(lines);
    return regions;
  }

  function makeTitleMetadataSearchRegions(frontMatter) {
    const primary = makeMetadataSearchRegion(frontMatter, "title");
    const layoutLines = (frontMatter?.layoutLines || [])
      .filter(line => line?.id && Array.isArray(line.itemIDs) && line.itemIDs.length
        && !line.exclusionReason && Number(line.pageIndex || 0) <= 1)
      .sort(frontMatterLocatorLineSort);
    const wide = makeFrontMatterLineRegion(layoutLines);
    const regions = [];
    for (const region of [primary, wide]) {
      if (!region || !region.lines?.length) continue;
      const key = region.sourceLineIDs.join("|");
      if (!regions.some(candidate => candidate.sourceLineIDs.join("|") === key)) {
        regions.push(region);
      }
    }
    return regions;
  }

  function makeMetadataMatchedLineRegion(frontMatter, baseRegion, match, text, kind) {
    const group = chooseMetadataAnchorGroup(metadataAnchorLineEntries(baseRegion, match), kind);
    if (group.length < (kind === "title" ? 1 : 2)) return null;
    const anchorLines = group.flatMap(entry => [entry.firstLine, entry.lastLine]).filter(Boolean);
    const abstractFlow = kind === "abstract"
      ? resolveAbstractFlow(frontMatter, anchorLines) : null;
    if (kind === "abstract" && (!abstractFlow || abstractFlow.confidence === "low")) return null;
    const firstLine = group[0].firstLine;
    const lastLine = group.at(-1).lastLine;
    const firstIndex = baseRegion.lines.findIndex(line => line.id === firstLine.id);
    let lastIndex = baseRegion.lines.findIndex(line => line.id === lastLine.id);
    if (firstIndex < 0 || lastIndex < firstIndex) return null;

    const bodyStart = frontMatter?.bodyStart?.lineID
      ? baseRegion.lines.find(line => line.id === frontMatter.bodyStart.lineID) : null;
    const bodyStartSameFlow = bodyStart && (kind === "abstract"
      ? abstractFlowLineMatches(bodyStart, abstractFlow, firstLine)
      : frontMatterLineSameFlow(firstLine, bodyStart));
    if (kind === "abstract" && bodyStartSameFlow && !frontMatterLineBefore(firstLine, bodyStart)) return null;

    const metadataText = stripOptionalAbstractHeading(text);
    const hasTailAnchor = (match?.matchedAnchors || []).some(anchor =>
      Number(anchor.end || 0) >= metadataText.length * 0.82);
    if (kind === "abstract" && !hasTailAnchor) {
      for (let index = lastIndex + 1; index < baseRegion.lines.length; index++) {
        const line = baseRegion.lines[index];
        if (bodyStartSameFlow && !frontMatterLineBefore(line, bodyStart)) break;
        if (kind === "abstract"
          ? !abstractFlowLineMatches(line, abstractFlow, firstLine)
          : !frontMatterLineSameFlow(line, firstLine)) continue;
        if (abstractLocatorBoundary(line.text)) break;
        lastIndex = index;
      }
    }

    if (kind === "abstract" && bodyStartSameFlow && !hasTailAnchor) {
      const bodyStartIndex = baseRegion.lines.findIndex(line => line.id === bodyStart.id);
      if (bodyStartIndex >= 0 && lastIndex >= bodyStartIndex) lastIndex = bodyStartIndex - 1;
    }
    if (lastIndex < firstIndex) return null;

    const lines = baseRegion.lines.slice(firstIndex, lastIndex + 1)
      .filter(line => (kind === "abstract"
        ? abstractFlowLineMatches(line, abstractFlow, firstLine)
        : frontMatterLineSameFlow(line, firstLine))
        && !line.exclusionReason);
    if (kind === "abstract" && lines.length < 2) return null;
    const region = makeFrontMatterLineRegion(lines);
    return kind === "abstract" && region ? {
      ...region,
      abstractFlow,
      boundaryReason: hasTailAnchor ? "metadata-tail" : (bodyStartSameFlow ? "body-start" : null)
    } : region;
  }

  function frontMatterWords(value) {
    return normalizeFrontMatterText(value).match(/[\p{L}\p{N}]+/gu) || [];
  }

  function orderedWordCoverage(metadataText, regionText) {
    const expected = frontMatterWords(stripOptionalAbstractHeading(metadataText));
    const actual = frontMatterWords(regionText);
    if (!expected.length || !actual.length) return 0;
    const previous = new Uint32Array(actual.length + 1);
    for (const word of expected) {
      const current = new Uint32Array(actual.length + 1);
      for (let index = 1; index <= actual.length; index++) {
        current[index] = word === actual[index - 1]
          ? previous[index - 1] + 1
          : Math.max(previous[index], current[index - 1]);
      }
      previous.set(current);
    }
    return previous[actual.length] / expected.length;
  }

  function buildValidatedAbstractTarget(text, region, pages, initialMatch, matchMethod) {
    if (!region?.lines?.length || region.lines.some(line => line.exclusionReason)) return null;
    const finalMatch = matchMetadataRegion(text, region, pages, "abstract");
    const anchors = makeMetadataAnchors(text, "abstract");
    const matched = finalMatch?.matchedAnchors || [];
    const hasPrefix = matched.some(anchor => Number(anchor.start || 0)
      <= stripOptionalAbstractHeading(text).length * 0.18);
    const hasTail = matched.some(anchor => Number(anchor.end || 0)
      >= stripOptionalAbstractHeading(text).length * 0.82);
    const allAnchors = Boolean(finalMatch && matched.length === anchors.length && hasPrefix && hasTail);
    const regionText = region.lines.map(line => String(line.text || "")).join(" ");
    const wordCoverage = orderedWordCoverage(text, regionText);
    const reliableBoundary = ["metadata-tail", "body-start", "abstract-boundary"]
      .includes(region.boundaryReason);
    const inferred = !allAnchors && Boolean(finalMatch && hasPrefix
      && matched.length >= 2 && reliableBoundary && wordCoverage >= 0.85);
    if (!allAnchors && !inferred) return null;
    const target = buildFrontMatterTarget("abstract", text, region, pages,
      finalMatch || initialMatch, matchMethod);
    if (!target) return null;
    return {
      ...target,
      confidence: allAnchors ? "high" : "medium",
      completeness: allAnchors ? "verified" : "inferred",
      boundaryReason: region.boundaryReason || (hasTail ? "metadata-tail" : null),
      matchedAnchorCount: Number(finalMatch?.matchedAnchorCount || 0),
      metadataCoverage: allAnchors
        ? Number(finalMatch?.metadataCoverage || 0) : wordCoverage,
      finalMetadataCoverage: allAnchors
        ? Number(finalMatch?.metadataCoverage || 0) : wordCoverage,
      sourceLineCount: region.lines.length
    };
  }

  var ReaderTargetLocator = {
    matchText(target, pages) {
      const region = {
        text: String(target?.text || ""),
        sourceCharIDs: (pages || []).flatMap(page => (page.chars || []).map(char => String(char.id))),
        pageIndexes: (pages || []).map(page => Number(page.pageIndex || 0))
      };
      const match = matchMetadataRegion(target?.text, region, pages, target?.kind || "title");
      if (!match) return null;
      const matchedRegion = {
        ...region,
        sourceCharIDs: match.sourceCharIDs,
        position: null
      };
      return buildFrontMatterTarget(target?.kind || "title", target?.text, matchedRegion, pages,
        match, "metadata-segmented");
    },

    metadataCandidates(kind, frontMatter) {
      if (kind === "title") return frontMatter?.titleCandidates || [];
      return frontMatter?.abstractCandidates || [];
    },

    metadataAbstractTarget(text, pages, frontMatter) {
      const region = makeAbstractLayoutRegion(frontMatter);
      if (!region) return null;
      const match = matchMetadataRegion(text, region, pages, "abstract");
      if (match) {
        const narrowed = narrowAbstractLayoutRegion(region, match, text);
        const validated = buildValidatedAbstractTarget(text, narrowed, pages,
          match, "metadata-segmented");
        if (validated) return validated;
      }
      const regionText = region.lines.map(line => String(line.text || "")).join(" ");
      const finalCoverage = orderedWordCoverage(text, regionText);
      if (!region.boundaryReason || finalCoverage < 0.85) return null;
      const inferred = buildFrontMatterTarget("abstract", text, region, pages,
        null, "metadata-segmented");
      return inferred ? {
        ...inferred,
        confidence: "medium",
        completeness: "inferred",
        boundaryReason: region.boundaryReason,
        finalMetadataCoverage: finalCoverage,
        metadataCoverage: finalCoverage,
        sourceLineCount: region.lines.length
      } : null;
    },

    metadataLayoutTarget(kind, text, pages, frontMatter) {
      const regions = kind === "title"
        ? makeTitleMetadataSearchRegions(frontMatter)
        : makeAbstractMetadataSearchRegions(frontMatter);
      const abstractTargets = [];
      for (const searchRegion of regions) {
        if (!searchRegion) continue;
        const match = matchMetadataRegion(text, searchRegion, pages, kind);
        if (!match) continue;
        const region = makeMetadataMatchedLineRegion(frontMatter, searchRegion, match, text, kind);
        if (!region) continue;
        const target = kind === "abstract"
          ? buildValidatedAbstractTarget(text, region, pages, match, "metadata-segmented")
          : buildFrontMatterTarget(kind, text, region, pages, match, "metadata-segmented");
        if (!target) continue;
        if (kind !== "abstract") return target;
        abstractTargets.push(target);
      }
      if (kind !== "abstract" || !abstractTargets.length) return null;
      abstractTargets.sort((left, right) =>
        Number(right.finalMetadataCoverage || right.metadataCoverage || 0)
          - Number(left.finalMetadataCoverage || left.metadataCoverage || 0)
        || Number(right.matchedAnchorCount || 0) - Number(left.matchedAnchorCount || 0)
        || Number(right.sourceLineCount || right.sourceLineIDs?.length || 0)
          - Number(left.sourceLineCount || left.sourceLineIDs?.length || 0));
      const best = abstractTargets[0];
      const runnerUp = abstractTargets[1];
      if (runnerUp) {
        const coverageGap = Math.abs(
          Number(best.finalMetadataCoverage || best.metadataCoverage || 0)
          - Number(runnerUp.finalMetadataCoverage || runnerUp.metadataCoverage || 0)
        );
        const differentRegion = best.sourceLineIDs.join("|") !== runnerUp.sourceLineIDs.join("|");
        if (differentRegion && coverageGap < 0.03
          && Number(best.matchedAnchorCount || 0) === Number(runnerUp.matchedAnchorCount || 0)) {
          return null;
        }
      }
      return best;
    },

    metadataHeadinglessAbstractTarget(text, pages, frontMatter) {
      return this.metadataLayoutTarget("abstract", text, pages, frontMatter);
    },

    abstractLayoutFallbackTarget(text, pages, frontMatter) {
      const region = makeAbstractLayoutRegion(frontMatter);
      const candidate = frontMatter?.abstractCandidates?.[0] || null;
      if (!frontMatter?.abstractHeading || !region || region.lines.length < 2
        || region.abstractFlow?.confidence !== "high" || !region.boundaryReason
        || (candidate?.lineCount && region.lines.length < Number(candidate.lineCount))) return null;
      const targetText = text || candidate?.text || "";
      const validated = buildValidatedAbstractTarget(targetText, region, pages,
        null, "layout-fallback");
      if (validated) return validated;
      const regionText = region.lines.map(line => String(line.text || "")).join(" ");
      const finalCoverage = orderedWordCoverage(targetText, regionText);
      if (!region.boundaryReason || finalCoverage < 0.85) return null;
      const inferred = buildFrontMatterTarget("abstract", targetText, region, pages,
        null, "layout-fallback");
      return inferred ? {
        ...inferred,
        confidence: "medium",
        completeness: "inferred",
        boundaryReason: region.boundaryReason,
        finalMetadataCoverage: finalCoverage,
        metadataCoverage: finalCoverage,
        sourceLineCount: region.lines.length
      } : null;
    },

    metadataTargets(metadata, pages, frontMatter) {
      const targets = [];
      for (const [kind, text] of [["title", metadata?.title], ["abstract", metadata?.abstractText]]) {
        if (!text) continue;
        if (kind === "title") {
          const layoutTarget = this.metadataLayoutTarget(kind, text, pages, frontMatter);
          if (layoutTarget) {
            targets.push(layoutTarget);
            continue;
          }
        }
        if (kind === "abstract") {
          const expanded = this.metadataAbstractTarget(text, pages, frontMatter);
          if (expanded) {
            targets.push(expanded);
            continue;
          }
          if (!frontMatter?.abstractHeading) {
            const headingless = this.metadataHeadinglessAbstractTarget(text, pages, frontMatter);
            if (headingless) {
              targets.push(headingless);
              continue;
            }
          }
          else {
            const repaired = this.metadataLayoutTarget("abstract", text, pages, frontMatter);
            if (repaired) {
              targets.push(repaired);
              continue;
            }
          }
        }
        if (kind === "abstract") continue;
        const candidates = this.metadataCandidates(kind, frontMatter);
        const ranked = candidates.map(candidate => ({
          candidate,
          match: matchMetadataRegion(text, candidate, pages, kind)
        })).filter(entry => entry.match)
          .sort((left, right) => right.match.metadataCoverage - left.match.metadataCoverage
            || right.match.matchedAnchorCount - left.match.matchedAnchorCount
            || Number(right.candidate.score || 0) - Number(left.candidate.score || 0));
        const best = ranked[0];
        if (best) {
          const target = buildFrontMatterTarget(kind, text, best.candidate, pages,
            best.match, "metadata-segmented");
          if (target) targets.push(target);
        }
      }
      return targets;
    },

    layoutFallbackTargets(metadata, frontMatter, existingKinds, pages) {
      const targets = [];
      for (const kind of ["title", "abstract"]) {
        if (existingKinds.has(kind)) continue;
        const text = metadata?.[kind === "abstract" ? "abstractText" : "title"] || "";
        const candidate = this.metadataCandidates(kind, frontMatter)[0];
        if (!candidate) continue;
        const strong = kind === "title"
          ? Number(candidate.score || 0) >= 6
          : candidate.confidence === "medium" && Number(candidate.lineCount || 0) >= 2;
        if (!strong) continue;
        if (kind === "abstract") {
          const expandedTarget = this.abstractLayoutFallbackTarget(text || candidate.text,
            pages, frontMatter);
          if (expandedTarget) {
            targets.push(expandedTarget);
          }
          continue;
        }
        const target = buildFrontMatterTarget(kind, text || candidate.text, candidate, pages,
          null, "layout-fallback");
        if (target) targets.push(target);
      }
      return targets;
    },

    async locate(view, metadata) {
      const pageCount = ReaderPageTextIndex.getPageCount(view);
      if (!pageCount) throw new Error("PDF 页面尚未完成初始化");
      const pages = await ReaderPageTextIndex.loadIndexes(view, [FRONT_MATTER_PAGE_INDEX]);
      let frontMatter;
      try {
        frontMatter = ReaderFrontMatterExtractor.extractFrontMatter({ pages });
      }
      catch (error) {
        Zotero.logError?.(error);
        return {
          metadata,
          targets: [],
          pages,
          diagnostics: {
            scannedPageCount: pages.length,
            pageCount,
            titleFound: false,
            abstractFound: false,
            textLayer: pages.some(page => (page.chars || []).some(char => String(char.c || "").trim()))
              ? "available" : "empty",
            frontMatterError: String(error?.message || error)
          }
        };
      }
      const targets = this.metadataTargets(metadata, pages, frontMatter);
      const existingKinds = new Set(targets.map(target => target.kind));
      targets.push(...this.layoutFallbackTargets(metadata, frontMatter, existingKinds, pages));
      return {
        metadata,
        targets,
        pages,
        frontMatter,
        diagnostics: {
          scannedPageCount: pages.length,
          pageCount,
          titleFound: targets.some(target => target.kind === "title"),
          abstractFound: targets.some(target => target.kind === "abstract"),
          textLayer: pages.some(page => (page.chars || []).some(char => String(char.c || "").trim()))
            ? "available" : "empty",
          targetMethods: Object.fromEntries(targets.map(target => [target.kind, target.matchMethod])),
          targetCoverage: Object.fromEntries(targets.map(target => [
            target.kind, Number(target.metadataCoverage || 0).toFixed(3)
          ])),
          targetCompleteness: Object.fromEntries(targets.map(target => [
            target.kind, target.completeness || null
          ])),
          abstractRejection: metadata?.abstractText
            && !targets.some(target => target.kind === "abstract")
            ? "completeness-validation-failed" : null
        }
      };
    }
  };

  global.ReaderMetadataLoader = ReaderMetadataLoader;
  global.ReaderTargetLocator = ReaderTargetLocator;
})(globalThis);
