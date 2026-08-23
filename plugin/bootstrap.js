"use strict";

const PLUGIN_ID = "reader-selection-replacer-test@local.kumiko";
const PLUGIN_VERSION = "1.2.0";
const POPUP_CLASS = "reader-selection-replacer-test-popup";
const PANE_ID = "reader-selection-replacer-test-pane";
const PANEL_LOCALE_FILE = "reader-selection-replacer-test.ftl";
const LEGACY_TOOLBAR_IDS = Object.freeze([
  "reader-selection-replacer-test-auto-button",
  "reader-selection-replacer-test-auto-button-key",
  "reader-selection-replacer-test-auto-status"
]);
const LAYER_CLASS = "reader-selection-replacer-test-layer";
const PARAGRAPH_TRANSLATION_INDENT = "　　";
const TRANSLATION_FAILURE_COUNTDOWN_SECONDS = 5;
const TRANSLATION_FAILURE_MESSAGE = "翻译失败，请手动重试";
const ITEM_PANE_REGISTRATION_RETRY_DELAY = 250;
const ITEM_PANE_REGISTRATION_MAX_RETRIES = 40;
const PARAGRAPH_MARK_COLORS = [
  "#0ea5e9", "#f97316", "#22c55e", "#a855f7", "#eab308", "#ec4899"
];
const AUTO_TARGET_COLORS = Object.freeze({
  title: "#2563eb",
  abstract: "#f97316"
});
const AUTO_TARGET_LABELS = Object.freeze({
  title: "标题",
  abstract: "摘要"
});
const TRANSLATION_PROVIDER_UI = Object.freeze([
  Object.freeze({
    id: "qwen-mt",
    label: "Qwen",
    icon: "icons/qwen-symbol-hd.png",
    fallback: "Q",
    color: "#8c73fc"
  }),
  Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    icon: "icons/deepseek-symbol-hd.png",
    fallback: "D",
    color: "#052cba"
  }),
  Object.freeze({
    id: "gemini",
    label: "Gemini",
    icon: "icons/gemini-symbol-hd.png",
    fallback: "✦",
    color: "#3d0191"
  }),
  Object.freeze({
    id: "bing",
    label: "Bing",
    icon: "icons/bing-symbol-hd.png",
    fallback: "b",
    color: "#02c684"
  }),
  Object.freeze({
    id: "transmart",
    label: "Transmart",
    icon: "icons/transmart-symbol-hd.png",
    fallback: "T",
    color: "#00b0fd"
  }),
  Object.freeze({
    id: "cnki",
    label: "CNKI",
    icon: "icons/cnki-symbol-hd.png",
    fallback: "知",
    color: "#a8010b"
  })
]);
const TRANSLATION_PROVIDER_UI_BY_ID = Object.freeze(
  Object.fromEntries(TRANSLATION_PROVIDER_UI.map(value => [value.id, value]))
);
const PANEL_STYLE_ID = "reader-selection-replacer-test-provider-panel-style";

function createPanelLocalization() {
  const LocalizationConstructor = globalThis.Localization
    || (typeof Localization === "undefined" ? null : Localization);
  if (typeof LocalizationConstructor !== "function") return null;
  try {
    return new LocalizationConstructor([PANEL_LOCALE_FILE], true);
  }
  catch (error) {
    Zotero.logError?.(error);
    return null;
  }
}

function insertPanelLocalizationIntoMainWindows() {
  for (const win of Zotero.getMainWindows?.() || []) {
    try {
      win.MozXULElement?.insertFTLIfNeeded?.(PANEL_LOCALE_FILE);
    }
    catch (error) {
      Zotero.logError?.(error);
    }
  }
}

function copyRects(rects) {
  const result = [];
  for (const rect of rects || []) {
    if (!rect || Number(rect.length || 0) < 4) continue;
    const value = [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])];
    if (value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1]) {
      result.push(value);
    }
  }
  return result;
}

function boundingRect(rects) {
  const valid = (rects || []).filter(Boolean);
  if (!valid.length) return null;
  return [
    Math.min(...valid.map(rect => rect[0])),
    Math.min(...valid.map(rect => rect[1])),
    Math.max(...valid.map(rect => rect[2])),
    Math.max(...valid.map(rect => rect[3]))
  ];
}

function copyPosition(position) {
  if (!position || typeof position !== "object") return null;
  const fragments = Array.isArray(position.fragments)
    ? position.fragments.map(fragment => ({
      pageIndex: Number(fragment?.pageIndex ?? position.pageIndex ?? 0),
      flowID: fragment?.flowID == null ? null : String(fragment.flowID),
      rects: copyRects(fragment?.rects),
      lineIDs: Array.isArray(fragment?.lineIDs)
        ? fragment.lineIDs.map(value => String(value)) : [],
      lineCharCounts: Array.isArray(fragment?.lineCharCounts)
        ? fragment.lineCharCounts.map(value => Math.max(0, Number(value) || 0)) : []
    })).filter(fragment => fragment.rects.length)
    : [];
  if (!fragments.length) {
    const pageIndex = Number(position.pageIndex || 0);
    const rects = copyRects(position.rects);
    if (rects.length) fragments.push({ pageIndex, rects });
    const nextPageRects = copyRects(position.nextPageRects);
    if (nextPageRects.length) fragments.push({ pageIndex: pageIndex + 1, rects: nextPageRects });
  }
  if (!fragments.length) return null;
  const firstPage = Number(fragments[0].pageIndex || 0);
  return {
    version: Number(position.version) === 2 ? 2 : undefined,
    coordinateSpace: position.coordinateSpace === "pdf" ? "pdf" : undefined,
    pageIndex: firstPage,
    rects: copyRects(fragments.find(fragment => fragment.pageIndex === firstPage)?.rects),
    fragments
  };
}

function positionFragments(position) {
  return Array.isArray(position?.fragments) ? position.fragments : [];
}

function splitReplacement(text, parts) {
  const chars = [...String(text || "")];
  if (!parts.length) return [];
  if (!chars.length) return parts.map(() => "");
  if (chars.length <= parts.length) {
    return [chars.join(""), ...parts.slice(1).map(() => "")];
  }

  const weights = parts.map(part => Math.max(
    1,
    Number(part.sourceCharCount || 0)
      || ((part.rect[2] - part.rect[0]) * (part.rect[3] - part.rect[1]))
  ));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < parts.length; index++) {
    if (index === parts.length - 1) {
      chunks.push(chars.slice(offset).join(""));
      break;
    }
    const cumulative = weights.slice(0, index + 1)
      .reduce((sum, value) => sum + value, 0);
    const end = Math.max(offset, Math.min(
      chars.length,
      Math.round(chars.length * cumulative / totalWeight)
    ));
    chunks.push(chars.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function buildPositionFromChars(chars) {
  const byPage = new Map();
  const ordered = [...(chars || [])].filter(char => char?.rect)
    .sort((left, right) => Number(left.pageIndex || 0) - Number(right.pageIndex || 0)
      || Number(left.offset || 0) - Number(right.offset || 0));
  let current = null;
  for (const char of ordered) {
    const pageIndex = Number(char.pageIndex || 0);
    if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
    if (!current || current.pageIndex !== pageIndex) {
      current = { pageIndex, chars: [] };
      byPage.get(pageIndex).push(current);
    }
    current.chars.push(char);
    if (char.lineBreakAfter) current = null;
  }
  const fragments = [...byPage.entries()].sort((a, b) => a[0] - b[0])
    .map(([pageIndex, lines]) => {
      const entries = lines.map((line, index) => ({
        line,
        rect: boundingRect(line.chars.map(char => char.rect)),
        lineID: `${pageIndex}:metadata-line:${index}`
      })).filter(entry => entry.rect);
      return {
        pageIndex,
        flowID: null,
        rects: entries.map(entry => entry.rect),
        lineIDs: entries.map(entry => entry.lineID),
        lineCharCounts: entries.map(entry => entry.line.chars
          .filter(char => !/^\s+$/u.test(String(char.c || ""))).length)
      };
    }).filter(fragment => fragment.rects.length);
  if (!fragments.length) return null;
  return {
    version: 2,
    coordinateSpace: "pdf",
    pageIndex: fragments[0].pageIndex,
    rects: copyRects(fragments[0].rects),
    fragments
  };
}

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

var SelectionReplacerOverlay = {
  states: new Map(),

  attach(reader, view, data, options = {}) {
    let state = this.states.get(reader);
    if (!state || state.cancelled) {
      state = {
        reader,
        view,
        records: new Map(),
        nextSequence: 0,
        cancelled: false,
        overlayLayers: new Map(),
        pageControlHosts: new Map(),
        pageDisplayModes: new Map(),
        activePageIndexes: new Set(),
        currentPageIndex: null,
        dirtyPages: new Set(),
        pageRecordIndex: new Map(),
        geometryRevision: 0,
        selectionLayoutCache: new Map(),
        translationSelectionActive: false,
        failureTimers: new Map(),
        eventHandlers: [],
        renderTimer: null,
        settleTimer: null,
        poller: null
      };
      this.states.set(reader, state);
      this.removeExistingLayers(view);
      this.bindEvents(state);
      state.poller = setInterval(() => {
        if (state.cancelled) return;
        if (Array.isArray(Zotero.Reader?._readers)
          && !Zotero.Reader._readers.includes(state.reader)) {
          this.remove(state.reader);
          SelectionReplacerTest.autoSessions?.delete(state.reader);
          SelectionReplacerTest.selectionSessions?.delete(state.reader);
          SelectionReplacerTest.readerStatus?.delete(state.reader);
          SelectionReplacerTest.refreshAllPanels?.();
          return;
        }
      }, 1200);
    }
    if (view && state.view !== view) {
      ReaderPageTextIndex.clearProjection(state.view);
      state.view = view;
      state.geometryRevision = Number(state.geometryRevision || 0) + 1;
    }
    const mode = options.mode || "replacement";
    const recordID = String(options.recordID ||
      (mode === "diagnostic" ? "front-matter" : mode === "selection-translation"
        ? `selection-${state.nextSequence + 1}` : "replacement"));
    const previous = state.records.get(recordID);
    if (previous) this.clearFailureCountdowns(state, previous);
    const nextRecord = {
      recordID,
      mode,
      data,
      match: mode === "selection-translation" ? data : (data?.paragraphs ? data : null),
      targets: Array.isArray(data) ? data : [],
      segments: options.segments || [],
      translations: options.translations || new Map(),
      translationPending: Boolean(options.translationPending),
      geometryStatus: previous?.geometryStatus || "unknown",
      geometryDiagnostics: previous?.geometryDiagnostics || null,
      failureCountdowns: new Map(),
      replacement: String(options.replacement || ""),
      sequence: previous?.sequence ?? state.nextSequence++
    };
    nextRecord.pageIndexes = this.recordPageIndexes(nextRecord);
    state.records.set(recordID, nextRecord);
    this.reindexRecord(state, recordID, previous?.pageIndexes || [], nextRecord.pageIndexes);
    this.markPagesDirty(state, [...(previous?.pageIndexes || []), ...nextRecord.pageIndexes]);
    this.schedule(state, 0);
    return state;
  },

  removeRecord(reader, recordID) {
    const state = this.states.get(reader);
    if (!state || !recordID) return false;
    const key = String(recordID);
    const record = state.records.get(key);
    if (record) this.clearFailureCountdowns(state, record);
    const removed = state.records.delete(key);
    if (removed) {
      this.reindexRecord(state, key, record?.pageIndexes || [], []);
      this.markPagesDirty(state, record?.pageIndexes || []);
      this.schedule(state, 0);
    }
    return removed;
  },

  now() {
    return Date.now();
  },

  clearFailureTimer(state, timerKey) {
    if (!state?.failureTimers || !timerKey) return;
    const timer = state.failureTimers.get(timerKey);
    if (timer !== undefined) clearTimeout(timer);
    state.failureTimers.delete(timerKey);
  },

  clearFailureCountdowns(state, record) {
    if (!record) return;
    for (const countdown of record.failureCountdowns?.values?.() || []) {
      this.clearFailureTimer(state, countdown.timerKey);
    }
    record.failureCountdowns?.clear?.();
  },

  scheduleFailureCountdown(state, record, displayKey, countdown) {
    if (!state || state.cancelled || !record || !countdown) return;
    this.clearFailureTimer(state, countdown.timerKey);
    const delay = Math.max(1, Math.min(1000, countdown.expiresAt - this.now()));
    const timer = setTimeout(() => {
      const currentRecord = state.records.get(record.recordID);
      const currentCountdown = currentRecord?.failureCountdowns?.get?.(displayKey);
      if (state.cancelled || currentRecord !== record || currentCountdown !== countdown) return;
      if (countdown.expiresAt <= this.now()) {
        countdown.expired = true;
        this.clearFailureTimer(state, countdown.timerKey);
        this.schedule(state, 0);
        return;
      }
      this.schedule(state, 0);
      this.scheduleFailureCountdown(state, record, displayKey, countdown);
    }, delay);
    state.failureTimers.set(countdown.timerKey, timer);
  },

  getFailureCountdown(state, record, displayKey) {
    if (!state || !record || !displayKey) return { active: false, expired: false };
    if (!(record.failureCountdowns instanceof Map)) record.failureCountdowns = new Map();
    let countdown = record.failureCountdowns.get(displayKey);
    if (!countdown) {
      countdown = {
        timerKey: `${record.recordID}:${displayKey}`,
        expiresAt: this.now() + TRANSLATION_FAILURE_COUNTDOWN_SECONDS * 1000,
        expired: false
      };
      record.failureCountdowns.set(displayKey, countdown);
      this.scheduleFailureCountdown(state, record, displayKey, countdown);
    }
    if (countdown.expired || countdown.expiresAt <= this.now()) {
      countdown.expired = true;
      this.clearFailureTimer(state, countdown.timerKey);
      return { active: false, expired: true, remaining: 0, message: "" };
    }
    const remaining = Math.max(1, Math.ceil((countdown.expiresAt - this.now()) / 1000));
    return {
      active: true,
      expired: false,
      remaining,
      message: `${TRANSLATION_FAILURE_MESSAGE}（${remaining}S）`
    };
  },

  isFailureExpired(record, displayKey) {
    return Boolean(record?.failureCountdowns?.get?.(displayKey)?.expired);
  },

  hiddenFailureResult(part, failureReason = "failure-countdown-expired") {
    return {
      rendered: false,
      layoutMode: "failure-expired",
      lines: [],
      fontSize: 0,
      lineHeight: 0,
      breakSource: "none",
      sourceRectCount: part?.sourceRects?.length || 0,
      mergedRectCount: 1,
      failureReason,
      node: null
    };
  },

  bindEvents(state) {
    const win = state.view?._iframeWindow;
    const eventBus = win?.PDFViewerApplication?.eventBus;
    if (!eventBus || !win) return;
    const handlers = {
      pagerendered: event => {
        const pageIndex = Math.max(0, Number(event?.pageNumber || 1) - 1);
        ReaderPageTextIndex.clearProjection(state.view, pageIndex);
        state.geometryRevision = Number(state.geometryRevision || 0) + 1;
        state.selectionLayoutCache?.clear?.();
        if (!state.activePageIndexes.has(pageIndex)) return;
        this.markPagesDirty(state, [pageIndex]);
        this.schedule(state, 40);
      },
      scalechanging: () => this.invalidateActiveGeometry(state),
      rotationchanging: () => this.invalidateActiveGeometry(state),
      pagesloaded: () => {
        ReaderPageTextIndex.clearProjection(state.view);
        state.geometryRevision = Number(state.geometryRevision || 0) + 1;
        state.selectionLayoutCache?.clear?.();
        state.currentPageIndex = this.currentPageIndex(state);
        this.markPagesDirty(state, this.renderWindow(state));
        this.schedule(state, 40);
      },
      updateviewarea: event => {
        const pageIndex = Math.max(0, Number(event?.location?.pageNumber
          || event?.pageNumber || this.currentPageIndex(state) + 1) - 1);
        if (pageIndex === state.currentPageIndex) return;
        state.currentPageIndex = pageIndex;
        this.schedule(state, 20);
      }
    };
    for (const [eventName, handler] of Object.entries(handlers)) {
      let exported = handler;
      try { exported = Components.utils.exportFunction(handler, win); }
      catch (_) {}
      try {
        eventBus.on(eventName, exported);
        state.eventHandlers.push([eventName, exported]);
      }
      catch (_) {}
    }
  },

  remove(reader) {
    const state = this.states.get(reader);
    if (!state) return;
    state.cancelled = true;
    if (state.renderTimer) clearTimeout(state.renderTimer);
    if (state.settleTimer) clearTimeout(state.settleTimer);
    if (state.poller) clearInterval(state.poller);
    for (const record of state.records.values()) this.clearFailureCountdowns(state, record);
    for (const timer of state.failureTimers.values()) clearTimeout(timer);
    state.failureTimers.clear();
    const eventBus = state.view?._iframeWindow?.PDFViewerApplication?.eventBus;
    for (const [eventName, handler] of state.eventHandlers) {
      try { eventBus?.off?.(eventName, handler); }
      catch (_) {}
    }
    for (const layer of state.overlayLayers.values()) layer.remove?.();
    state.overlayLayers.clear();
    for (const host of state.pageControlHosts?.values?.() || []) host.remove?.();
    state.pageControlHosts?.clear?.();
    this.states.delete(reader);
  },

  removeExistingLayers(view) {
    const pages = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages || [];
    for (const page of pages) {
      const layers = page?.div?.getElementsByClassName?.(LAYER_CLASS) || [];
      while (layers.length) layers[0].remove();
    }
  },

  schedule(state, delay = 40) {
    if (state.cancelled) return;
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(() => this.render(state), delay);
  },

  currentPageIndex(state) {
    const viewer = state.view?._iframeWindow?.PDFViewerApplication?.pdfViewer;
    return Math.max(0, Number(viewer?.currentPageNumber || 1) - 1);
  },

  renderWindow(state) {
    const count = ReaderPageTextIndex.getPageCount(state.view);
    const current = Number.isInteger(state.currentPageIndex)
      ? state.currentPageIndex : this.currentPageIndex(state);
    return [current - 1, current, current + 1]
      .filter(pageIndex => pageIndex >= 0 && pageIndex < count);
  },

  markPagesDirty(state, pageIndexes) {
    state.dirtyPages ||= new Set();
    for (const value of pageIndexes || []) {
      const pageIndex = Number(value);
      if (Number.isInteger(pageIndex) && pageIndex >= 0) state.dirtyPages.add(pageIndex);
    }
  },

  invalidateActiveGeometry(state) {
    state.geometryRevision = Number(state.geometryRevision || 0) + 1;
    ReaderPageTextIndex.clearProjection(state.view);
    state.selectionLayoutCache?.clear?.();
    this.markPagesDirty(state, state.activePageIndexes || []);
    this.schedule(state, 40);
  },

  recordPageIndexes(record) {
    const indexes = new Set();
    const addPosition = position => {
      for (const fragment of positionFragments(position)) {
        const pageIndex = Number(fragment?.pageIndex);
        if (Number.isInteger(pageIndex) && pageIndex >= 0) indexes.add(pageIndex);
      }
    };
    for (const target of record?.targets || []) addPosition(target?.position);
    for (const paragraph of record?.match?.paragraphs || []) {
      addPosition(paragraph?.translationPosition || paragraph?.selectedPosition);
    }
    for (const segment of record?.segments || []) addPosition(segment?.position);
    return [...indexes];
  },

  reindexRecord(state, recordID, previousPages, nextPages) {
    state.pageRecordIndex ||= new Map();
    for (const pageIndex of previousPages || []) {
      const values = state.pageRecordIndex.get(Number(pageIndex));
      values?.delete?.(recordID);
      if (!values?.size) state.pageRecordIndex.delete(Number(pageIndex));
    }
    for (const pageIndex of nextPages || []) {
      const numeric = Number(pageIndex);
      if (!state.pageRecordIndex.has(numeric)) state.pageRecordIndex.set(numeric, new Set());
      state.pageRecordIndex.get(numeric).add(recordID);
    }
  },

  getPage(state, pageIndex) {
    return state.view?._iframeWindow?.PDFViewerApplication
      ?.pdfViewer?._pages?.[pageIndex] || null;
  },

  ensureLayer(state, pageIndex) {
    if (state.activePageIndexes?.size && !state.activePageIndexes.has(Number(pageIndex))) return null;
    const page = this.getPage(state, pageIndex);
    if (!page?.div) return null;
    let layer = state.overlayLayers.get(pageIndex);
    if (layer?.parentNode !== page.div) {
      layer?.remove?.();
      layer = page.div.ownerDocument.createElement("div");
      layer.className = LAYER_CLASS;
      this.style(layer, {
        position: "absolute",
        inset: "0",
        zIndex: "45",
        pointerEvents: "none",
        overflow: "hidden"
      });
      page.div.append(layer);
      state.overlayLayers.set(pageIndex, layer);
    }
    return layer;
  },

  projectRect(state, rect, pageIndex, options = {}) {
    if (!options.ignorePageFilter && state.renderPageFilter !== undefined
      && Number(pageIndex) !== state.renderPageFilter) {
      return null;
    }
    return ReaderPageTextIndex.projectRect({
      view: state.view,
      pageIndex: Number(pageIndex),
      pdfRect: rect
    });
  },

  convertRect(state, rect, pageIndex) {
    const projection = this.projectRect(state, rect, pageIndex);
    return projection?.valid ? projection.pixelRect.slice() : null;
  },

  pageColors(state, pageIndex) {
    const page = this.getPage(state, pageIndex);
    const doc = page?.div?.ownerDocument;
    const view = doc?.defaultView;
    const root = doc?.documentElement;
    const rootStyle = root && view?.getComputedStyle?.(root);
    const pageStyle = page?.div && view?.getComputedStyle?.(page.div);
    const usable = value => {
      const normalized = String(value || "").trim().toLowerCase();
      return normalized && normalized !== "transparent" && normalized !== "rgba(0, 0, 0, 0)";
    };
    return {
      background: [
        pageStyle?.backgroundColor,
        rootStyle?.getPropertyValue?.("--background-color"),
        rootStyle?.backgroundColor
      ].find(usable) || "#ffffff",
      foreground: [
        rootStyle?.getPropertyValue?.("--text-color"),
        rootStyle?.color
      ].find(usable) || "#111111"
    };
  },

  syncActiveWindow(state) {
    if (!Number.isInteger(state.currentPageIndex)) {
      state.currentPageIndex = this.currentPageIndex(state);
    }
    const next = new Set(this.renderWindow(state));
    const previous = state.activePageIndexes || new Set();
    for (const pageIndex of previous) {
      if (next.has(pageIndex)) continue;
      state.overlayLayers.get(pageIndex)?.remove?.();
      state.overlayLayers.delete(pageIndex);
      state.pageControlHosts.get(pageIndex)?.remove?.();
      state.pageControlHosts.delete(pageIndex);
    }
    state.activePageIndexes = next;
    for (const pageIndex of next) {
      if (!previous.has(pageIndex)) this.markPagesDirty(state, [pageIndex]);
      this.ensureLayer(state, pageIndex);
    }
    return next;
  },

  recordsForPage(state, pageIndex) {
    const ids = state.pageRecordIndex?.get?.(Number(pageIndex));
    if (!ids?.size) return [];
    return [...ids].map(id => state.records.get(id)).filter(Boolean)
      .sort((left, right) => left.sequence - right.sequence);
  },

  renderRecordsForPage(state, pageIndex) {
    const orderedRecords = this.recordsForPage(state, pageIndex);
    for (const record of orderedRecords) {
      state.renderRecordID = record.recordID;
      if (record.mode === "diagnostic") {
        this.renderTargets(state, record);
        continue;
      }
      if (record.mode === "selection-translation") {
        this.renderSelectionTranslations(state, record);
        continue;
      }
      const paragraphs = record.match?.paragraphs || [];
      const displayCounts = { paragraph: 0, unclassified: 0 };
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const displayKind = paragraph.matchType === "unclassified" ? "unclassified" : "paragraph";
        const displayIndex = displayCounts[displayKind]++;
        const parts = [];
        for (const fragment of positionFragments(paragraph.selectedPosition)) {
          const lineCounts = fragment.lineCharCounts || [];
          for (let index = 0; index < fragment.rects.length; index++) {
            const rect = this.convertRect(state, fragment.rects[index], fragment.pageIndex);
            if (rect) parts.push({ pageIndex: Number(fragment.pageIndex || 0), rect,
              sourceCharCount: Number(lineCounts[index] || 0) });
          }
        }
        if (!parts.length) return;
        const chunks = splitReplacement(record.replacement, parts);
        parts.forEach((part, partIndex) => this.renderPart(state, part,
          chunks[partIndex] || "", paragraph, paragraphIndex, partIndex, displayIndex));
      });
    }
    delete state.renderRecordID;
  },

  render(state) {
    if (state.cancelled || !state.view) return;
    if (state.translationSelectionActive || this.hasActiveTranslationSelection(state)) return;
    const active = this.syncActiveWindow(state);
    for (const pageIndex of active) {
      if (!state.dirtyPages.has(pageIndex)) continue;
      const layer = state.overlayLayers.get(pageIndex);
      if (!layer) continue;
      state.renderExistingNodes = new Map([...(layer.children || [])]
        .filter(node => node?.dataset?.overlayKey)
        .map(node => [node.dataset.overlayKey, node]));
      state.renderSeenNodeKeys = new Set();
      state.renderPageFilter = pageIndex;
      this.renderRecordsForPage(state, pageIndex);
      for (const node of [...(layer.children || [])]) {
        const key = node?.dataset?.overlayKey;
        if (!key || !state.renderSeenNodeKeys.has(key)) node.remove?.();
      }
      delete state.renderExistingNodes;
      delete state.renderSeenNodeKeys;
      state.dirtyPages.delete(pageIndex);
    }
    delete state.renderPageFilter;
    this.renderPageDisplayControls(state);
  },

  reuseOverlayNode(state, key, signature) {
    const node = state.renderExistingNodes?.get?.(key);
    if (!node || node.dataset?.overlaySignature !== signature) return null;
    state.renderSeenNodeKeys?.add?.(key);
    return node;
  },

  registerOverlayNode(state, node, key, signature = "") {
    if (!node || !key) return node;
    const previous = state.renderExistingNodes?.get?.(key);
    if (previous && previous !== node) previous.remove?.();
    node.dataset.overlayKey = key;
    node.dataset.overlaySignature = signature;
    state.renderSeenNodeKeys?.add?.(key);
    return node;
  },

  renderTargets(state, record) {
    for (const [targetIndex, target] of (record.targets || []).entries()) {
      const parts = [];
      for (const fragment of positionFragments(target.position)) {
        for (const rect of fragment.rects || []) {
          const converted = this.convertRect(state, rect, fragment.pageIndex);
          if (converted) parts.push({ pageIndex: fragment.pageIndex, rect: converted,
            sourceCharCount: Math.max(1, Math.round((converted[2] - converted[0]) / 8)) });
        }
      }
      const translation = record.translations?.get?.(target.kind);
      const translatedText = ["cached", "translated"].includes(translation?.status)
        ? translation.translatedText : "";
      if (["title", "abstract"].includes(target.kind)) {
        const merged = target.kind === "title"
          ? this.mergeTitleParts(parts) : this.mergeTargetParts(parts);
        const results = merged.map((part, partIndex) => this.renderTranslatedTarget(
          state, part, target, targetIndex, partIndex, translatedText, translation, record));
        record.targetLayoutResults ||= new Map();
        record.targetLayoutResults.set(target.kind, results);
        if (results.length) continue;
      }
      parts.forEach((part, partIndex) => this.renderTargetPart(state, part, target,
        targetIndex, partIndex));
    }
  },

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

  translationDisplayKey({ targetKind = "", targetIndex = 0, partIndex = 0,
    segmentID = "" } = {}) {
    if (segmentID) return `selection:${segmentID}:${partIndex}`;
    return `auto:${targetKind}:${targetIndex}:${partIndex}`;
  },

  pageShowsOriginal(state, pageIndex) {
    return state?.pageDisplayModes?.get?.(Number(pageIndex || 0)) === "original";
  },

  hasActiveTranslationSelection(state) {
    const selection = state?.view?._iframeWindow?.document?.getSelection?.();
    if (!selection || selection.isCollapsed || !String(selection.toString?.() || "")) return false;
    const insideTranslation = node => {
      let current = node?.nodeType === 3 ? node.parentNode : node;
      while (current) {
        if (current.classList?.contains?.("reader-selection-replacer-translation-text")) return true;
        current = current.parentNode;
      }
      return false;
    };
    return insideTranslation(selection.anchorNode) || insideTranslation(selection.focusNode);
  },

  configureTranslationSelection(root, textNode, enabled, showingOriginal = false,
    state = null, pageIndex = 0) {
    if (!root || !textNode) return;
    const selectable = Boolean(enabled && !showingOriginal);
    root.style.pointerEvents = selectable ? "auto" : "none";
    root.style.cursor = selectable ? "text" : "default";
    root.style.userSelect = selectable ? "text" : "none";
    root.style.MozUserSelect = selectable ? "text" : "none";
    textNode.style.pointerEvents = selectable ? "auto" : "none";
    textNode.style.cursor = selectable ? "text" : "default";
    textNode.style.userSelect = selectable ? "text" : "none";
    textNode.style.webkitUserSelect = selectable ? "text" : "none";
    textNode.style.MozUserSelect = selectable ? "text" : "none";
    textNode.setAttribute?.("draggable", "false");
    if (!selectable || !root.addEventListener || root._selectionReplacerSelectionConfigured) return;
    root._selectionReplacerSelectionConfigured = true;
    root.addEventListener("mousedown", event => {
      if (event && event.button !== undefined && Number(event.button) !== 0) return;
      if (state) state.translationSelectionActive = true;
      event?.stopPropagation?.();
      const page = state ? this.getPage(state, pageIndex) : null;
      const textLayers = [...(page?.div?.querySelectorAll?.(".textLayer") || [])];
      const saved = textLayers.map(layer => ({ layer,
        pointerEvents: layer.style.pointerEvents,
        userSelect: layer.style.userSelect,
        mozUserSelect: layer.style.MozUserSelect }));
      for (const { layer } of saved) {
        layer.style.pointerEvents = "none";
        layer.style.userSelect = "none";
        layer.style.MozUserSelect = "none";
      }
      const doc = root.ownerDocument;
      const finish = () => {
        for (const savedLayer of saved) {
          savedLayer.layer.style.pointerEvents = savedLayer.pointerEvents;
          savedLayer.layer.style.userSelect = savedLayer.userSelect;
          savedLayer.layer.style.MozUserSelect = savedLayer.mozUserSelect;
        }
        if (state) state.translationSelectionActive = false;
      };
      doc?.addEventListener?.("mouseup", finish, { capture: true, once: true });
      doc?.defaultView?.addEventListener?.("blur", finish, { once: true });
    });
    root.addEventListener("selectstart", event => event?.stopPropagation?.());
  },

  pageHasSuccessfulTranslation(state, pageIndex) {
    return this.recordsForPage(state, pageIndex).some(record =>
      [...(record.translations?.values?.() || [])].some(result =>
        ["cached", "translated"].includes(result?.status)
          && Boolean(String(result?.translatedText || "").trim())));
  },

  stylePageControlButton(button) {
    this.style(button, {
      boxSizing: "border-box", minWidth: "64px", height: "25px",
      padding: "2px 8px", border: "1px solid rgba(255, 255, 255, 0.55)",
      borderRadius: "4px", color: "#ffffff", background: "rgba(37, 99, 235, 0.92)",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.28)", font: "12px/19px sans-serif",
      whiteSpace: "nowrap", pointerEvents: "auto", cursor: "pointer",
      userSelect: "none", webkitUserSelect: "none", MozUserSelect: "none"
    });
  },

  makePageControlBar(state, pageIndex, doc, edge) {
    const root = doc.createElement("div");
    root.className = `reader-selection-replacer-page-controls ${edge}`;
    this.style(root, { position: "absolute", left: "8px", zIndex: "2",
      display: "flex", alignItems: "center", gap: "5px", pointerEvents: "none",
      userSelect: "none", webkitUserSelect: "none", MozUserSelect: "none" });
    root.style[edge === "bottom" ? "bottom" : "top"] = "8px";
    const displayButton = doc.createElement("button");
    displayButton.type = "button";
    displayButton.className = "reader-selection-replacer-page-display-toggle";
    this.stylePageControlButton(displayButton);
    displayButton.addEventListener("click", event => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const showingOriginal = this.pageShowsOriginal(state, pageIndex);
      state.pageDisplayModes.set(pageIndex, showingOriginal ? "translation" : "original");
      this.applyPageDisplayModeFast(state, pageIndex);
      this.renderPageDisplayControls(state);
    });
    root.append(displayButton);
    return { root, displayButton };
  },

  ensurePageControlHost(state, pageIndex) {
    const page = this.getPage(state, pageIndex);
    if (!page?.div?.ownerDocument?.createElement) return null;
    let host = state.pageControlHosts.get(pageIndex);
    if (host?.parentNode !== page.div) {
      host?.remove?.();
      host = page.div.ownerDocument.createElement("div");
      host.className = "reader-selection-replacer-page-controls-host";
      this.style(host, { position: "absolute", inset: "0", zIndex: "65",
        pointerEvents: "none", overflow: "hidden", userSelect: "none",
        webkitUserSelect: "none", MozUserSelect: "none" });
      const top = this.makePageControlBar(state, pageIndex, host.ownerDocument, "top");
      const bottom = this.makePageControlBar(state, pageIndex, host.ownerDocument, "bottom");
      host._selectionReplacerBars = [top, bottom];
      host.append(top.root);
      host.append(bottom.root);
      page.div.append(host);
      state.pageControlHosts.set(pageIndex, host);
    }
    return host;
  },

  applyPageDisplayModeFast(state, pageIndex) {
    const layer = state.overlayLayers.get(Number(pageIndex));
    if (!layer) return;
    const roots = layer.querySelectorAll
      ? [...layer.querySelectorAll('[data-translation-display-status="success"]')]
      : [...(layer.children || [])].filter(node =>
        node?.dataset?.translationDisplayStatus === "success");
    const showingOriginal = this.pageShowsOriginal(state, pageIndex);
    for (const root of roots) {
      const textNode = root.querySelector?.(".reader-selection-replacer-translation-text")
        || [...(root.children || [])].find(node =>
          node?.className === "reader-selection-replacer-translation-text");
      const badge = root.querySelector?.(".reader-selection-replacer-test-paragraph-badge,"
        + ".reader-selection-replacer-test-auto-badge") || null;
      this.applyTranslationDisplay(root, textNode, badge, showingOriginal,
        root.dataset?.translationBackground || this.pageColors(state, pageIndex).background);
      root.dataset.translationDisplayMode = showingOriginal ? "original" : "translation";
      this.configureTranslationSelection(root, textNode, true, showingOriginal,
        state, pageIndex);
    }
  },

  renderPageDisplayControls(state) {
    for (const pageIndex of state?.activePageIndexes || []) {
      const host = this.ensurePageControlHost(state, pageIndex);
      if (!host) continue;
      const successful = this.pageHasSuccessfulTranslation(state, pageIndex);
      const showingOriginal = this.pageShowsOriginal(state, pageIndex);
      for (const bar of host._selectionReplacerBars || []) {
        const displayButton = bar.displayButton;
        displayButton.style.display = successful ? "" : "none";
        displayButton.textContent = showingOriginal ? "显示译文" : "显示原文";
        displayButton.title = showingOriginal ? "显示本页全部译文" : "显示本页 PDF 原文";
        displayButton.setAttribute?.("aria-pressed", showingOriginal ? "true" : "false");
        bar.root.style.display = successful ? "flex" : "none";
      }
    }
  },

  applyTranslationDisplay(root, textNode, badge, showingOriginal, background) {
    if (!root || !textNode) return;
    root.style.background = showingOriginal ? "transparent" : background;
    if (showingOriginal) {
      textNode.style.display = "none";
      textNode.style.visibility = "hidden";
      if (badge) badge.style.display = "none";
      return;
    }
    textNode.style.display = "";
    textNode.style.visibility = "visible";
    if (badge) badge.style.display = "";
  },

  renderTranslatedTarget(state, part, target, targetIndex, partIndex, translatedText,
    translation = null, record = null) {
    const displayKey = this.translationDisplayKey({ targetKind: target.kind,
      targetIndex, partIndex });
    if (this.isFailureExpired(record, displayKey)) return this.hiddenFailureResult(part);
    const layer = this.ensureLayer(state, part.pageIndex);
    if (!layer) return { rendered: false, layoutMode: "diagnostic", fontSize: 0,
      lineHeight: 0, sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
      failureReason: "page-layer-unavailable", node: null };
    const doc = layer.ownerDocument;
    const [left, top, right, bottom] = part.rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const accent = AUTO_TARGET_COLORS[target.kind] || PARAGRAPH_MARK_COLORS[targetIndex];
    const colors = this.pageColors(state, part.pageIndex);
    const translationPending = Boolean(record?.translationPending
      && (!translation || ["failed", "skipped"].includes(translation.status)));
    const overlayKey = `auto:${record?.recordID || state.renderRecordID || ""}`
      + `:${target.kind}:${targetIndex}:${partIndex}`;
    const overlaySignature = [Number(state.geometryRevision || 0),
      part.rect.map(value => Number(value).toFixed(2)).join(","),
      translation?.status || "missing", translationPending ? 1 : 0,
      target.kind,
      translatedText].join("|");
    if (["cached", "translated"].includes(translation?.status) && translatedText) {
      const reused = this.reuseOverlayNode(state, overlayKey, overlaySignature);
      if (reused) return { ...(reused._translationLayoutResult || {
        rendered: true, layoutMode: `${target.kind}-fit`, sourceRectCount: part.sourceRects.length,
        mergedRectCount: 1, failureReason: "", cacheHit: true, measureCount: 0
      }), node: reused };
    }
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-auto-part merged-translation";
    root.dataset.targetKind = target.kind;
    root.dataset.targetIndex = String(targetIndex);
    root.dataset.partIndex = String(partIndex);
    root.dataset.translationStatus = String(translation?.status || "missing");
    root.dataset.translationError = String(translation?.errorCode || "");
    root.dataset.translationBackground = colors.background;
    this.style(root, {
      position: "absolute", boxSizing: "border-box", left: `${left}px`,
      top: `${top}px`, width: `${width}px`, height: `${height}px`,
      overflow: "hidden", border: "none", background: colors.background,
      pointerEvents: "none"
    });
    const textNode = doc.createElement("div");
    textNode.className = "reader-selection-replacer-translation-text";
    textNode.textContent = target.kind === "title"
      ? translatedText.replace(/<\s*br\s*\/?>/giu, "\n") : translatedText;
    this.style(textNode, {
      position: "absolute", top: "0", left: "0", right: "0",
      boxSizing: "border-box", padding: "3px 4px",
      overflow: "visible", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      wordBreak: "break-word", color: colors.foreground,
      fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
      fontWeight: target.kind === "title" ? "600" : "400",
      textAlign: target.kind === "title" ? "center" : "left",
      display: target.kind === "title" ? "flex" : "block",
      flexDirection: target.kind === "title" ? "column" : "initial",
      justifyContent: target.kind === "title" ? "center" : "initial",
      height: target.kind === "title" ? "100%" : "auto",
      pointerEvents: "none"
    });
    root.append(textNode);
    layer.append(root);
    let badge = null;
    const renderDisplay = showingOriginal => {
      this.applyTranslationDisplay(root, textNode, badge, showingOriginal, colors.background);
      if (showingOriginal) {
        root.dataset.translationDisplayMode = "original";
        return { rendered: true, layoutMode: "original-page", lines: [],
          fontSize: 0, lineHeight: 0, sourceRectCount: part.sourceRects.length,
          mergedRectCount: 1, failureReason: "" };
      }
      const displayText = translatedText;
      let displayFitted;
       if (translationPending) {
         displayFitted = this.renderTranslationStatus(textNode, target.kind,
           "正在翻译…", "pending");
       }
       else if (!displayText) {
        displayFitted = this.renderTranslationStatus(textNode, target.kind,
          target.kind === "title" ? "标题翻译失败" : "摘要翻译失败",
          translation?.errorCode || "missing-translation");
      }
      else if (target.kind === "title") {
        displayFitted = this.fitTitleText({ node: textNode, containerWidth: width,
          containerHeight: height, sourceRects: part.sourceRects,
          translatedText: displayText });
        if (!displayFitted.rendered) {
          const layoutFailure = displayFitted;
          const status = this.renderTranslationStatus(textNode, target.kind,
            "标题无法排版", layoutFailure.failureReason);
          displayFitted = { ...status, ...layoutFailure, rendered: true,
            layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
        }
      }
      else if (target.kind === "abstract") {
        displayFitted = this.fitAbstractText({ node: textNode, containerWidth: width,
          containerHeight: height, sourceRects: part.sourceRects,
          translatedText: displayText,
          indentFirstBlock: !showingOriginal && partIndex === 0 });
        if (!displayFitted.rendered) {
          const layoutFailure = displayFitted;
          const status = this.renderTranslationStatus(textNode, target.kind,
            "摘要无法排版", layoutFailure.failureReason);
          displayFitted = { ...status, ...layoutFailure, rendered: true,
            layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
        }
      }
      else displayFitted = this.renderTranslationStatus(textNode, target.kind,
        "译文无法排版", "unsupported-target-kind");
      root.dataset.translationDisplayMode = showingOriginal ? "original" : "translation";
      return displayFitted;
    };
    const translationFitted = renderDisplay(false);
    const displayStatus = ["cached", "translated"].includes(translation?.status)
      && translatedText && !String(translationFitted.layoutMode || "").endsWith("-status")
      ? "success" : "failure";
    const terminalFailure = !translationPending && displayStatus !== "success";
    const failureCountdown = terminalFailure
      ? this.getFailureCountdown(state, record, displayKey) : null;
    if (failureCountdown?.expired) {
      root.remove?.();
      return this.hiddenFailureResult(part);
    }
    const showingOriginal = Boolean(displayStatus === "success"
      && this.pageShowsOriginal(state, part.pageIndex));
    let fitted = showingOriginal ? renderDisplay(true) : translationFitted;
    if (failureCountdown?.active) {
      fitted = this.renderTranslationStatus(textNode, target.kind,
        failureCountdown.message,
        translationFitted.failureReason || translation?.errorCode || "translation-failed");
    }
    const decoration = this.translationDecoration(target.kind, displayStatus);
    root.style.border = decoration.border;
    root.dataset.translationDisplayStatus = displayStatus;
    if (decoration.showBadge) {
      badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-auto-badge";
      badge.textContent = decoration.badgeText;
      this.style(badge, { position: "absolute", left: "0", top: "0", zIndex: "3",
        padding: "0 3px", color: "#ffffff", background: accent,
        font: "10px/14px sans-serif", whiteSpace: "nowrap", pointerEvents: "none",
        userSelect: "none", webkitUserSelect: "none" });
      badge.style.display = fitted.layoutMode === "original-page" ? "none" : "";
      root.append(badge);
    }
    this.configureTranslationSelection(root, textNode,
      displayStatus === "success", showingOriginal, state, part.pageIndex);
    const result = { ...fitted, node: root };
    root._translationLayoutResult = { ...fitted, node: undefined };
    this.registerOverlayNode(state, root, overlayKey, overlaySignature);
    return result;
  },

  renderTranslatedSelectionTarget(state, part, paragraph, segment, paragraphIndex,
    partIndex, displayIndex, translation = null, translatedChunk = "", record = null,
    flowLayout = null) {
    const displayKey = this.translationDisplayKey({ segmentID: segment?.id || "",
      partIndex });
    if (this.isFailureExpired(record, displayKey)) return this.hiddenFailureResult(part);
    const layer = this.ensureLayer(state, part.pageIndex);
    if (!layer) return { rendered: false, layoutMode: "diagnostic", fontSize: 0,
      lineHeight: 0, sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
      failureReason: "page-layer-unavailable", node: null };
    const doc = layer.ownerDocument;
    const [left, top, right, bottom] = part.rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const placement = this.selectionPlacement(part);
    if (!placement) return { rendered: false, layoutMode: "diagnostic", fontSize: 0,
      lineHeight: 0, sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
      failureReason: "page-local-position-invalid", node: null };
    const selectionBlock = paragraph.matchType === "selection-block";
    const accent = selectionBlock ? "#f59e0b"
      : PARAGRAPH_MARK_COLORS[paragraphIndex % PARAGRAPH_MARK_COLORS.length];
    const label = `S${displayIndex + 1}`;
    const colors = this.pageColors(state, part.pageIndex);
    const translationSucceeded = ["cached", "translated"].includes(translation?.status);
    const translatedText = translationSucceeded ? String(translatedChunk || "") : "";
    const blockFlowLayout = flowLayout?.layouts?.[partIndex] || flowLayout;
    const translationPending = Boolean(record?.translationPending
      && (!translation || ["failed", "skipped"].includes(translation.status)));
    const statusOwner = partIndex === 0;
    const indentFirstBlock = false;
    const paragraphLayout = false;
    const continuesParagraph = false;
    const overlayKey = `selection:${record?.recordID || state.renderRecordID || ""}`
      + `:${segment?.id || paragraphIndex}:${partIndex}`;
    const overlaySignature = [Number(state.geometryRevision || 0),
      part.rect.map(value => Number(value).toFixed(2)).join(","),
      part.unitRect.map(value => Number(value).toFixed(4)).join(","),
      part.viewportSignature || "",
      translation?.status || "missing", translationPending ? 1 : 0,
      paragraph.matchType, continuesParagraph ? 1 : 0, indentFirstBlock ? 1 : 0,
      blockFlowLayout?.fontSize || 0, blockFlowLayout?.lineHeight || 0,
      translatedText].join("|");
    if (translationSucceeded && translatedText) {
      const reused = this.reuseOverlayNode(state, overlayKey, overlaySignature);
      if (reused) return { ...(reused._selectionLayoutResult || {
        rendered: true, layoutMode: "selection-fit", sourceRectCount: part.sourceRects.length,
        mergedRectCount: 1, failureReason: "", cacheHit: true, measureCount: 0
      }), node: reused };
    }
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-part merged-translation";
    root.dataset.paragraphIndex = String(paragraphIndex);
    root.dataset.partIndex = String(partIndex);
    root.dataset.segmentID = String(segment?.id || "");
    root.dataset.translationStatus = String(translation?.status
      || (record?.translationPending ? "pending" : "missing"));
    root.dataset.translationError = String(translation?.errorCode || "");
    root.dataset.translationBackground = colors.background;
    root.title = `划选翻译 ${label}：${String(paragraph.selectedText || paragraph.sourceText || "")
      .replace(/\s+/gu, " ").trim().slice(0, 240)}`;
    this.style(root, {
      position: "absolute", boxSizing: "border-box",
      ...placement,
      overflow: "hidden",
      border: "none", background: colors.background,
      pointerEvents: "none"
    });
    const textNode = doc.createElement("div");
    textNode.className = "reader-selection-replacer-translation-text";
    this.style(textNode, {
      position: "absolute", top: "0", left: "0", right: "0",
      boxSizing: "border-box", padding: "3px 4px", overflow: "hidden",
      whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word",
      color: colors.foreground,
      fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
      fontWeight: "400", textAlign: "left", display: "block",
      pointerEvents: "none"
    });
    root.append(textNode);
    layer.append(root);
    let badge = null;
    const renderDisplay = showingOriginal => {
      this.applyTranslationDisplay(root, textNode, badge, showingOriginal, colors.background);
      if (showingOriginal) {
        root.dataset.translationDisplayMode = "original";
        return { rendered: true, layoutMode: "original-page", lines: [],
          fontSize: 0, lineHeight: 0, sourceRectCount: part.sourceRects.length,
          mergedRectCount: 1, failureReason: "" };
      }
      const displayText = translatedText;
      textNode.style.textAlignLast = "auto";
      let displayFitted;
       if (translationPending) {
        displayFitted = statusOwner
          ? this.renderTranslationStatus(textNode, "selection", "正在翻译划选内容…", "pending")
          : { rendered: true, layoutMode: "selection-empty", lines: [], fontSize: 0,
            lineHeight: 0, sourceRectCount: part.sourceRects.length,
            mergedRectCount: 1, failureReason: "" };
      }
      else if (!translationSucceeded) {
        if (statusOwner) {
          const message = translation?.status === "skipped" ? "划选内容未翻译" : "翻译失败";
          displayFitted = this.renderTranslationStatus(textNode, "selection", message,
            translation?.errorCode || "missing-translation");
        }
        else {
          textNode.textContent = "";
          displayFitted = { rendered: true, layoutMode: "selection-empty", lines: [],
            fontSize: 0, lineHeight: 0, sourceRectCount: part.sourceRects.length,
            mergedRectCount: 1, failureReason: "" };
        }
      }
      else if (!displayText) {
        textNode.textContent = "";
        displayFitted = { rendered: true, layoutMode: "selection-empty", lines: [],
          fontSize: 0, lineHeight: 0, sourceRectCount: part.sourceRects.length,
          mergedRectCount: 1, failureReason: "" };
      }
      else if (flowLayout && !flowLayout.rendered) {
        const layoutFailure = {
          rendered: false, layoutMode: "diagnostic",
          fontSize: Number(flowLayout.fontSize || 0),
          lineHeight: Number(flowLayout.lineHeight || 0),
          sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
          failureReason: flowLayout.failureReason || "minimum-font-overflow"
        };
        if (statusOwner) {
          const status = this.renderTranslationStatus(textNode, "selection",
            "划选译文无法排版", layoutFailure.failureReason);
          displayFitted = { ...status, ...layoutFailure, rendered: true,
            layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
        }
        else {
          textNode.textContent = "";
          displayFitted = { ...layoutFailure, rendered: true,
            layoutMode: "selection-empty" };
        }
      }
      else if (blockFlowLayout?.fontSize > 0) {
        textNode.textContent = indentFirstBlock && displayText
          ? `${PARAGRAPH_TRANSLATION_INDENT}${displayText}` : displayText;
        this.style(textNode, {
          position: "absolute", top: "0", left: "0", width: "100%", height: "auto",
          boxSizing: "border-box", padding: "3px 4px", margin: "0", overflow: "hidden",
          whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "normal",
          textAlign: paragraphLayout ? "justify" : "left",
          textAlignLast: "auto",
          fontSize: `${blockFlowLayout.fontSize}px`,
          lineHeight: String(blockFlowLayout.lineHeight)
        });
        const measured = this.measureTextLayout({
          node: textNode, containerWidth: width, containerHeight: height,
          fontSize: blockFlowLayout.fontSize,
          lineHeight: blockFlowLayout.lineHeight, mode: "block"
        });
        displayFitted = {
          rendered: measured.fits,
          layoutMode: measured.fits ? "selection-flow" : "diagnostic",
          fontSize: blockFlowLayout.fontSize,
          lineHeight: blockFlowLayout.lineHeight,
          sourceRectCount: part.sourceRects.length,
          mergedRectCount: 1,
          failureReason: measured.fits ? "" : "measured-flow-overflow",
          ...measured
        };
        if (!displayFitted.rendered) {
          const layoutFailure = displayFitted;
          if (statusOwner) {
            const status = this.renderTranslationStatus(textNode, "selection",
              "划选译文无法排版", layoutFailure.failureReason);
            displayFitted = { ...status, ...layoutFailure, rendered: true,
              layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
          }
          else {
            textNode.textContent = "";
            displayFitted = { ...layoutFailure, rendered: true,
              layoutMode: "selection-empty" };
          }
        }
      }
      else {
        const layoutSignature = [record?.recordID || "", segment?.id || "", partIndex,
          Number(state.geometryRevision || 0), Number(width.toFixed(2)), Number(height.toFixed(2)),
          indentFirstBlock ? 1 : 0, paragraphLayout ? 1 : 0, continuesParagraph ? 1 : 0,
          part.sourceRects.map(rect => rect.map(value => Number(value).toFixed(2)).join(",")).join(";"),
          displayText].join("|");
        displayFitted = this.fitSelectionText({ node: textNode, containerWidth: width,
          containerHeight: height, sourceRects: part.sourceRects,
          translatedText: displayText,
          indentFirstBlock, paragraphLayout, continuesParagraph,
          layoutCache: state.selectionLayoutCache, layoutSignature });
        if (!displayFitted.rendered) {
          const layoutFailure = displayFitted;
          if (statusOwner) {
            const status = this.renderTranslationStatus(textNode, "selection",
              "划选译文无法排版", layoutFailure.failureReason);
            displayFitted = { ...status, ...layoutFailure, rendered: true,
              layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
          }
          else {
            textNode.textContent = "";
            displayFitted = { ...layoutFailure, rendered: true,
              layoutMode: "selection-empty" };
          }
        }
      }
      root.dataset.translationDisplayMode = showingOriginal ? "original" : "translation";
      return displayFitted;
    };
    const translationFitted = renderDisplay(false);
    const displayStatus = translationSucceeded && flowLayout?.rendered !== false
      && !String(translationFitted.layoutMode || "").endsWith("-status")
      ? "success" : "failure";
    const terminalFailure = statusOwner && !translationPending && displayStatus !== "success";
    const failureCountdown = terminalFailure
      ? this.getFailureCountdown(state, record, displayKey) : null;
    if (failureCountdown?.expired) {
      root.remove?.();
      return this.hiddenFailureResult(part);
    }
    const showingOriginal = Boolean(displayStatus === "success"
      && this.pageShowsOriginal(state, part.pageIndex));
    let fitted = showingOriginal ? renderDisplay(true) : translationFitted;
    if (failureCountdown?.active) {
      fitted = this.renderTranslationStatus(textNode, "selection",
        failureCountdown.message,
        translationFitted.failureReason || translation?.errorCode || "translation-failed");
    }
    if (partIndex === 0) {
      badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-paragraph-badge";
      badge.textContent = label;
      this.style(badge, {
        position: "absolute", left: "0", top: "0", zIndex: "3", padding: "0 2px",
        color: "#ffffff", background: accent, font: "9px/12px sans-serif",
        whiteSpace: "nowrap", pointerEvents: "none",
        userSelect: "none", webkitUserSelect: "none"
      });
      badge.style.display = fitted.layoutMode === "original-page" ? "none" : "";
      root.append(badge);
    }
    root.dataset.translationDisplayStatus = displayStatus;
    this.configureTranslationSelection(root, textNode,
      displayStatus === "success", showingOriginal, state, part.pageIndex);
    const result = { ...fitted, node: root };
    root._selectionLayoutResult = { ...fitted, node: undefined };
    this.registerOverlayNode(state, root, overlayKey, overlaySignature);
    return result;
  },

  translationDecoration(kind, status) {
    if (kind === "title") {
      return { border: "none", showBadge: false, badgeText: "" };
    }
    if (kind === "abstract" && status === "success") {
      return { border: "none", showBadge: false, badgeText: "" };
    }
    if (kind === "abstract") {
      return { border: "none", showBadge: true, badgeText: "摘要状态" };
    }
    return { border: "none", showBadge: true, badgeText: "标题译文" };
  },

  renderTranslationStatus(node, kind, message, failureReason) {
    node.textContent = message;
    node.style.display = "flex";
    node.style.height = "100%";
    node.style.alignItems = "center";
    node.style.justifyContent = "center";
    node.style.whiteSpace = "nowrap";
    node.style.fontSize = kind === "title" ? "14px" : "12px";
    node.style.lineHeight = "1.2";
    return { rendered: true, layoutMode: `${kind}-status`, lines: [message],
      fontSize: kind === "title" ? 14 : 12, lineHeight: 1.2,
      breakSource: "none", sourceRectCount: 0, mergedRectCount: 1,
      failureReason: failureReason || "" };
  },

  renderTargetPart(state, part, target, targetIndex, partIndex) {
    const layer = this.ensureLayer(state, part.pageIndex);
    if (!layer) return;
    const doc = layer.ownerDocument;
    const [left, top, right, bottom] = part.rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const accent = AUTO_TARGET_COLORS[target.kind] || PARAGRAPH_MARK_COLORS[targetIndex];
    const label = AUTO_TARGET_LABELS[target.kind] || target.kind;
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-auto-part";
    root.dataset.targetKind = target.kind;
    root.dataset.targetIndex = String(targetIndex);
    root.dataset.partIndex = String(partIndex);
    root.title = `${label}：${String(target.text || "").replace(/\s+/gu, " ").trim().slice(0, 240)}`;
    this.style(root, {
      position: "absolute",
      boxSizing: "border-box",
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      border: `${target.confidence === "low" ? "1px dashed" : "2px solid"} ${accent}`,
      background: target.kind === "title"
        ? "rgba(37, 99, 235, 0.15)" : "rgba(249, 115, 22, 0.15)",
      pointerEvents: "none"
    });
    if (partIndex === 0) {
      const badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-auto-badge";
      badge.textContent = label;
      this.style(badge, {
        position: "absolute",
        left: "0",
        top: "0",
        zIndex: "3",
        padding: "0 3px",
        color: "#ffffff",
        background: accent,
        font: "10px/14px sans-serif",
        whiteSpace: "nowrap",
        pointerEvents: "none"
      });
      root.append(badge);
    }
    layer.append(root);
    this.registerOverlayNode(state, root,
      `target:${state.renderRecordID || ""}:${target.kind}:${targetIndex}:${partIndex}`,
      `${Number(state.geometryRevision || 0)}:${part.rect.join(",")}:${target.confidence || ""}`);
  },

  renderPart(state, part, text, paragraph, paragraphIndex, partIndex, displayIndex) {
    const layer = this.ensureLayer(state, part.pageIndex);
    if (!layer) return;
    const doc = layer.ownerDocument;
    const [left, top, right, bottom] = part.rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const colors = this.pageColors(state, part.pageIndex);
    const unclassified = paragraph.matchType === "unclassified";
    const accent = unclassified ? "#f59e0b"
      : PARAGRAPH_MARK_COLORS[paragraphIndex % PARAGRAPH_MARK_COLORS.length];
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-part";
    root.dataset.paragraphIndex = String(paragraphIndex);
    root.dataset.partIndex = String(partIndex);
    root.title = `选区段落 ${paragraphIndex + 1}：${String(paragraph.sourceText || "")
      .replace(/\s+/gu, " ").trim().slice(0, 200)}`;
    this.style(root, {
      position: "absolute",
      boxSizing: "border-box",
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      border: `1px solid ${accent}`,
      pointerEvents: "none"
    });

    const cover = doc.createElement("div");
    cover.className = "reader-selection-replacer-test-cover";
    this.style(cover, {
      position: "absolute",
      inset: "0",
      background: colors.background,
      pointerEvents: "none"
    });
    root.append(cover);

    if (text) {
      const textNode = doc.createElement("div");
      textNode.className = "reader-selection-replacer-test-text";
      textNode.textContent = text;
      this.style(textNode, {
        position: "absolute",
        inset: "0",
        display: "flex",
        alignItems: "center",
        boxSizing: "border-box",
        padding: "0 1px",
        overflow: "hidden",
        whiteSpace: "nowrap",
        color: colors.foreground,
        background: "transparent",
        fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
        fontSize: `${Math.max(8, Math.min(24, height * 0.78))}px`,
        lineHeight: "1",
        pointerEvents: "none"
      });
      root.append(textNode);
    }

    if (partIndex === 0) {
      const badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-paragraph-badge";
      badge.textContent = `${unclassified ? "U" : "P"}${displayIndex + 1}`;
      this.style(badge, {
        position: "absolute",
        left: "0",
        top: "0",
        zIndex: "3",
        padding: "0 2px",
        color: "#ffffff",
        background: accent,
        font: "9px/12px sans-serif",
        pointerEvents: "none"
      });
      root.append(badge);
    }
    layer.append(root);
    this.registerOverlayNode(state, root,
      `replacement:${state.renderRecordID || ""}:${paragraphIndex}:${partIndex}`,
      `${Number(state.geometryRevision || 0)}:${part.rect.join(",")}:${text}`);
  },

  style(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  }
};

var SelectionReplacerTest = {
  rootURI: "",
  registeredPaneID: null,
  localization: null,
  panelStates: new Set(),
  readerStatus: new Map(),
  credentialState: "unknown",
  activeProviderID: "",
  providerStates: new Map(),
  autoSessions: new Map(),
  selectionSessions: new Map(),
  latestTranslationPreviews: new Map(),
  translationPreviewRevision: 0,
  selectionTaskCounter: 0,
  startingReaders: new Set(),
  readerListenersRegistered: new Set(),
  paneRegistrationRetryTimer: null,
  paneRegistrationRetryCount: 0,

  async init(rootURI) {
    this.rootURI = rootURI;
    await (Zotero.uiReadyPromise || Promise.resolve());
    this.localization = createPanelLocalization();
    insertPanelLocalizationIntoMainWindows();
    for (const script of [
      "page-text-index.js",
      "selection-block.js",
      "front-matter-extractor.js",
      "content-segments.js",
      "translation-service.js"
    ]) {
      Services.scriptloader.loadSubScript(`${rootURI}${script}`, globalThis, "UTF-8");
    }
    SegmentTranslationCache.init();
    this.registerItemPane();
    this.registerReaderListeners();
    Promise.resolve().then(() => {
      if (!this.activeProviderID) return;
      for (const reader of Zotero.Reader?._readers || []) this.autoMarkReader(reader);
    }).catch(error => Zotero.logError?.(error));
    (Zotero.uiReadyPromise || Promise.resolve())
      .then(async () => {
        this.activeProviderID = globalThis.getActiveTranslationProviderID?.()
          || this.activeProviderID;
        if (this.activeProviderID) await this.revalidateProviderKey(this.activeProviderID);
        const provider = this.getProvider(this.activeProviderID);
        const providerState = this.activeProviderID
          ? this.getProviderState(this.activeProviderID) : null;
        if (provider?.credentialMode === "none" || providerState?.status === "configured") {
          this.restartActiveReaders();
        }
        this.refreshAllPanels();
    }).catch(error => Zotero.logError?.(error));
    Zotero.debug?.(`[${PLUGIN_ID}] started v${PLUGIN_VERSION}`);
  },

  registerReaderListeners() {
    const reader = Zotero.Reader;
    if (!reader?.registerEventListener) return false;
    const listeners = [
      ["renderTextSelectionPopup", this.onRenderTextSelectionPopup.bind(this)],
      ["renderToolbar", this.onRenderToolbar.bind(this)]
    ];
    for (const [eventName, listener] of listeners) {
      if (this.readerListenersRegistered.has(eventName)) continue;
      try {
        reader.registerEventListener(eventName, listener, PLUGIN_ID);
        this.readerListenersRegistered.add(eventName);
      }
      catch (error) {
        Zotero.logError?.(error);
        return false;
      }
    }
    return this.readerListenersRegistered.size === listeners.length;
  },

  onMainWindowLoad(window) {
    try {
      window?.MozXULElement?.insertFTLIfNeeded?.(PANEL_LOCALE_FILE);
    }
    catch (error) {
      Zotero.logError?.(error);
    }
    insertPanelLocalizationIntoMainWindows();
    this.registerItemPane();
    this.registerReaderListeners();
    this.refreshAllPanels();
  },

  clearPaneRegistrationRetry() {
    if (this.paneRegistrationRetryTimer !== null) {
      clearTimeout(this.paneRegistrationRetryTimer);
      this.paneRegistrationRetryTimer = null;
    }
    this.paneRegistrationRetryCount = 0;
  },

  schedulePaneRegistrationRetry() {
    if (this.registeredPaneID || this.paneRegistrationRetryTimer !== null) return;
    if (this.paneRegistrationRetryCount >= ITEM_PANE_REGISTRATION_MAX_RETRIES) {
      Zotero.debug?.(`[${PLUGIN_ID}] item pane registration deferred until the next main window load`);
      return;
    }
    this.paneRegistrationRetryCount += 1;
    this.paneRegistrationRetryTimer = setTimeout(() => {
      this.paneRegistrationRetryTimer = null;
      if (!this.registeredPaneID) this.registerItemPane();
    }, ITEM_PANE_REGISTRATION_RETRY_DELAY);
  },

  shutdown() {
    this.clearPaneRegistrationRetry();
    Zotero.Reader._unregisterEventListenerByPluginID?.(PLUGIN_ID);
    if (this.registeredPaneID) {
      Zotero.ItemPaneManager?.unregisterSection?.(this.registeredPaneID);
    }
    for (const reader of SelectionReplacerOverlay.states.keys()) {
      SelectionReplacerOverlay.remove(reader);
    }
    this.autoSessions.clear();
    for (const session of this.selectionSessions.values()) session.cancelled = true;
    this.selectionSessions.clear();
    this.latestTranslationPreviews.clear();
    this.translationPreviewRevision = 0;
    this.startingReaders.clear();
    this.readerListenersRegistered.clear();
    this.readerStatus.clear();
    this.panelStates.clear();
    this.localization = null;
    this.registeredPaneID = null;
    SegmentTranslationCache.close().catch(error => Zotero.logError?.(error));
    Zotero.debug?.(`[${PLUGIN_ID}] stopped`);
  },

  setReaderStatus(reader, text) {
    if (!reader) return;
    this.readerStatus.set(reader, String(text || ""));
    this.refreshAllPanels();
  },

  getReaderForItem(itemID) {
    const mainWindow = Zotero.getMainWindow?.();
    const tabID = mainWindow?.Zotero_Tabs?.selectedID;
    const activeReader = tabID ? Zotero.Reader?.getByTabID?.(tabID) : null;
    const matches = reader => {
      if (!reader) return false;
      if (!itemID || reader.itemID === itemID) return true;
      const attachment = Zotero.Items?.get?.(reader.itemID);
      const parentID = attachment?.parentID || attachment?.parentItemID;
      return parentID === itemID;
    };
    if (matches(activeReader)) return activeReader;
    return (Zotero.Reader?._readers || []).find(matches) || null;
  },

  registerItemPane() {
    if (this.registeredPaneID) return this.registeredPaneID;
    const manager = Zotero.ItemPaneManager;
    if (!manager?.registerSection) {
      this.schedulePaneRegistrationRetry();
      return null;
    }
    try {
      this.registeredPaneID = manager.registerSection({
        paneID: PANE_ID,
        pluginID: PLUGIN_ID,
        header: {
          l10nID: "reader-selection-replacer-test-pane-header",
          icon: `${this.rootURI}icons/translator-for-zotero-16.svg`
        },
        sidenav: {
          l10nID: "reader-selection-replacer-test-pane-sidenav",
          icon: `${this.rootURI}icons/translator-for-zotero-20.svg`
        },
        onItemChange: ({ item, tabType, setEnabled }) => {
          setEnabled(tabType === "reader" || Boolean(item?.isPDFAttachment?.()));
        },
        onRender: props => this.renderItemPane(props)
      });
    }
    catch (error) {
      Zotero.logError?.(error);
      this.registeredPaneID = null;
      this.schedulePaneRegistrationRetry();
      return null;
    }
    if (!this.registeredPaneID) {
      this.schedulePaneRegistrationRetry();
      return null;
    }
    this.clearPaneRegistrationRetry();
    return this.registeredPaneID;
  },

  legacyRenderItemPane({ doc, body, item, tabType }) {
    if (!doc || !body) return;
    body.replaceChildren?.();
    const container = doc.createElement("div");
    this.stylePanel(container, {
      display: "flex", flexDirection: "column", gap: "9px",
      padding: "10px 12px 16px", color: "var(--fill-primary, inherit)",
      fontSize: "13px"
    });

    const heading = doc.createElement("strong");
    heading.textContent = "Translator for Zotero";
    const disclosure = doc.createElement("p");
    disclosure.textContent = "标题、摘要和用户主动划选的正文会发送到 DeepSeek；调用可能产生 API 费用。API Key 仅保存在 Zotero 本机登录管理器中。";
    this.stylePanel(disclosure, { margin: "0", lineHeight: "1.45", opacity: "0.78" });

    const apiStatus = doc.createElement("div");
    const apiInput = doc.createElement("input");
    apiInput.type = "password";
    apiInput.autocomplete = "new-password";
    apiInput.placeholder = "输入 DeepSeek API Key";
    apiInput.setAttribute("aria-label", "DeepSeek API Key");
    this.stylePanel(apiInput, {
      boxSizing: "border-box", width: "100%", minHeight: "30px",
      padding: "5px 7px", color: "inherit",
      background: "var(--material-sidepane, rgba(127,127,127,.06))",
      border: "1px solid var(--fill-quinary, rgba(127,127,127,.28))",
      borderRadius: "5px", font: "inherit"
    });
    const apiActions = doc.createElement("div");
    const saveKey = this.makePanelButton(doc, "保存并验证");
    const validateKey = this.makePanelButton(doc, "验证当前密钥");
    const deleteKey = this.makePanelButton(doc, "删除密钥", true);
    apiActions.append(saveKey, validateKey, deleteKey);
    this.stylePanel(apiActions, { display: "flex", flexWrap: "wrap", gap: "6px" });

    const frontMatterStatus = doc.createElement("div");
    const titleStatus = doc.createElement("div");
    const abstractStatus = doc.createElement("div");
    const retryActions = doc.createElement("div");
    const retryTitle = this.makePanelButton(doc, "重试标题");
    const retryAbstract = this.makePanelButton(doc, "重试摘要");
    const retryAll = this.makePanelButton(doc, "全部重试");
    retryActions.append(retryTitle, retryAbstract, retryAll);
    this.stylePanel(retryActions, { display: "flex", flexWrap: "wrap", gap: "6px" });

    const message = doc.createElement("div");
    this.stylePanel(message, { minHeight: "18px", lineHeight: "1.4", opacity: "0.82" });
    const version = doc.createElement("small");
    version.textContent = `Translator for Zotero ${PLUGIN_VERSION}`;
    version.style.opacity = "0.5";
    container.append(
      heading, disclosure, apiStatus, apiInput, apiActions,
      frontMatterStatus, titleStatus, abstractStatus, retryActions, message, version
    );
    body.append(container);

    const state = {
      body, itemID: item?.id || null, tabType, apiStatus, apiInput,
      saveKey, validateKey, deleteKey, frontMatterStatus, titleStatus,
      abstractStatus, retryTitle, retryAbstract, retryAll, message
    };
    this.panelStates.add(state);
    this.updatePanelState(state);
    saveKey.addEventListener("click", () => this.saveAPIKeyFromPanel(state));
    validateKey.addEventListener("click", () => this.revalidateAPIKey(state));
    deleteKey.addEventListener("click", () => this.removeAPIKey(state));
    retryTitle.addEventListener("click", () => this.retryFrontMatter(state, ["title"]));
    retryAbstract.addEventListener("click", () => this.retryFrontMatter(state, ["abstract"]));
    retryAll.addEventListener("click", () => this.retryFrontMatter(state, ["title", "abstract"]));
  },

  stylePanel(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  },

  makePanelButton(doc, label, danger = false) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    this.stylePanel(button, {
      minHeight: "30px", border: `1px solid ${danger ? "#b44" : "#4777a8"}`,
      borderRadius: "5px", padding: "5px 8px", color: "inherit",
      background: "var(--material-button, rgba(127,127,127,.08))",
      font: "inherit", cursor: "pointer"
    });
    return button;
  },

  setPanelMessage(state, text, error = false) {
    // The sidebar intentionally has no free-form log area. Keep this method as
    // a compatibility no-op for the existing retry and legacy call sites.
  },

  normalizePreviewText(value) {
    return String(value || "")
      .replace(/<\s*br\s*\/?>/giu, "\n")
      .replace(/<[^>]*>/gu, "")
      .trim();
  },

  makeTranslationPreview(segments, results) {
    const original = [];
    const translated = [];
    for (const segment of segments || []) {
      const result = results?.get?.(segment?.id);
      if (!["cached", "translated"].includes(result?.status)) continue;
      const originalText = this.normalizePreviewText(segment?.sourceText);
      const translatedText = this.normalizePreviewText(result?.translatedText);
      if (!originalText || !translatedText) continue;
      original.push(originalText);
      translated.push(translatedText);
    }
    return {
      originalText: original.join("\n\n"),
      translatedText: translated.join("\n\n")
    };
  },

  setLatestTranslationPreview(reader, preview) {
    if (!reader) return;
    const originalText = this.normalizePreviewText(preview?.originalText);
    const translatedText = this.normalizePreviewText(preview?.translatedText);
    if (!originalText || !translatedText) {
      this.latestTranslationPreviews.delete(reader);
    }
    else {
      this.latestTranslationPreviews.set(reader, {
        itemID: reader.itemID ?? null,
        originalText,
        translatedText,
        revision: ++this.translationPreviewRevision
      });
    }
    this.refreshAllPanels();
  },

  clearLatestTranslationPreview(reader) {
    if (reader) this.latestTranslationPreviews.delete(reader);
    else this.latestTranslationPreviews.clear();
    this.refreshAllPanels();
  },

  makePreviewCopyButton(doc, type) {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.previewCopy = type;
    this.stylePanel(button, {
      position: "absolute",
      top: "6px",
      right: "6px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      padding: "0",
      border: "0",
      borderRadius: "5px",
      color: "var(--fill-secondary, #aeb0b6)",
      background: "transparent",
      cursor: "pointer",
      appearance: "none"
    });
    this.setPreviewCopyButtonState(button, false, doc);
    return button;
  },

  setPreviewCopyButtonState(button, copied, doc = button?.ownerDocument) {
    if (!button) return;
    const type = button.dataset?.previewCopy || "translated";
    const isTranslated = type === "translated";
    const l10nID = copied
      ? `reader-selection-replacer-test-pane-copy-${type}-copied`
      : `reader-selection-replacer-test-pane-copy-${type}`;
    const fallback = copied
      ? (isTranslated ? "已复制译文" : "已复制原文")
      : (isTranslated ? "复制译文" : "复制原文");
    button.replaceChildren?.();
    let icon = null;
    if (doc?.createElementNS) {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.style.width = "16px";
      svg.style.height = "16px";
      const path = doc.createElementNS(svgNS, "path");
      path.setAttribute("d", copied
        ? "M5 12.5 9.5 17 19 7"
        : "M9 5h10v14H9zM5 19H4V3h12v2");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.9");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
      icon = svg;
    }
    else if (doc?.createElement) {
      icon = doc.createElement("span");
      icon.textContent = copied ? "✓" : "⧉";
      icon.setAttribute("aria-hidden", "true");
    }
    if (icon) button.append?.(icon);
    this.setPanelAttributes(button, l10nID, { "aria-label": fallback }, doc);
  },

  makeTranslationPreviewBox(doc, type) {
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("data-translation-preview-box", type);
    this.stylePanel(wrapper, {
      position: "relative",
      width: "100%",
      boxSizing: "border-box"
    });
    const text = doc.createElement("textarea");
    text.setAttribute("data-translation-preview-text", type);
    text.readOnly = true;
    text.spellcheck = false;
    text.wrap = "soft";
    text.value = "";
    this.stylePanel(text, {
      display: "block",
      boxSizing: "border-box",
      width: "100%",
      minHeight: "72px",
      maxHeight: "220px",
      margin: "0",
      padding: "8px 36px 8px 10px",
      border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
      borderRadius: "8px",
      color: "var(--fill-secondary, #c4c6cc)",
      background: "transparent",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "1.4",
      resize: "none",
      overflow: "auto"
    });
    const copyButton = this.makePreviewCopyButton(doc, type);
    wrapper.append(text, copyButton);
    return { wrapper, text, copyButton };
  },

  updateTranslationPreviewPanel(state) {
    if (!state?.translatedPreviewText || !state?.originalPreviewText) return;
    const reader = this.getReaderForItem(state.itemID);
    const candidate = reader ? this.latestTranslationPreviews.get(reader) : null;
    const sameItem = candidate && reader
      && String(candidate.itemID ?? "") === String(reader.itemID ?? "");
    const preview = sameItem ? candidate : null;
    const translatedText = preview?.translatedText || "";
    const originalText = preview?.originalText || "";
    const signature = `${preview?.revision || 0}\u0000${translatedText}\u0000${originalText}`;
    if (state.previewSignature !== signature) {
      state.translatedPreviewText.value = translatedText;
      state.originalPreviewText.value = originalText;
      this.setPreviewCopyButtonState(state.translatedCopyButton, false,
        state.translatedPreviewText.ownerDocument);
      this.setPreviewCopyButtonState(state.originalCopyButton, false,
        state.originalPreviewText.ownerDocument);
      state.previewSignature = signature;
    }
    state.translatedCopyButton.disabled = !translatedText;
    state.originalCopyButton.disabled = !originalText;
    state.translatedCopyButton.style.opacity = translatedText ? "0.85" : "0.45";
    state.originalCopyButton.style.opacity = originalText ? "0.85" : "0.45";
  },

  copyPreviewText(state, type) {
    const isTranslated = type === "translated";
    const textElement = isTranslated
      ? state?.translatedPreviewText : state?.originalPreviewText;
    const button = isTranslated
      ? state?.translatedCopyButton : state?.originalCopyButton;
    const text = String(textElement?.value || "").trim();
    if (!text || !button || button.disabled) return false;
    let clipboardError = null;
    try {
      const classes = globalThis.Components?.classes;
      const interfaces = globalThis.Components?.interfaces;
      const helper = classes?.["@mozilla.org/widget/clipboardhelper;1"]
        ?.getService?.(interfaces?.nsIClipboardHelper);
      if (helper?.copyString) {
        helper.copyString(text);
        this.setPreviewCopyButtonState(button, true, textElement.ownerDocument);
        return true;
      }
    }
    catch (error) {
      clipboardError = error;
    }
    const doc = textElement.ownerDocument;
    const clipboard = doc?.defaultView?.navigator?.clipboard
      || globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText === "function") {
      return Promise.resolve(clipboard.writeText(text)).then(() => {
        this.setPreviewCopyButtonState(button, true, doc);
        return true;
      }).catch(error => {
        Zotero.logError?.(error);
        return false;
      });
    }
    if (clipboardError) Zotero.logError?.(clipboardError);
    return false;
  },

  async legacySaveAPIKeyFromPanel(state) {
    const apiKey = String(state?.apiInput?.value || "").trim();
    if (!apiKey) {
      this.setPanelMessage(state, "请输入 API Key。", true);
      return false;
    }
    this.credentialState = "validating";
    this.refreshAllPanels();
    try {
      await DeepSeekCredentials.validateKey(apiKey);
      await DeepSeekCredentials.saveKey(apiKey);
      state.apiInput.value = "";
      this.credentialState = "configured";
      this.setPanelMessage(state, "DeepSeek API Key 已验证并保存。", false);
      this.refreshAllPanels();
      for (const reader of Zotero.Reader?._readers || []) {
        const session = this.autoSessions.get(reader);
        const failed = Boolean(session?.error
          || session?.translation?.diagnostics?.failed);
        if (failed) {
          this.autoSessions.delete(reader);
          this.autoMarkReader(reader).catch(error => Zotero.logError?.(error));
        }
      }
      return true;
    }
    catch (error) {
      state.apiInput.value = "";
      this.credentialState = "invalid";
      this.setPanelMessage(state, String(error?.message || error), true);
      this.refreshAllPanels();
      return false;
    }
  },

  async legacyRevalidateAPIKey(state = null) {
    const apiKey = await DeepSeekCredentials.getKey();
    if (!apiKey) {
      this.credentialState = "missing";
      this.setPanelMessage(state, "尚未配置 API Key。", true);
      this.refreshAllPanels();
      return false;
    }
    this.credentialState = "validating";
    this.refreshAllPanels();
    try {
      await DeepSeekCredentials.validateKey(apiKey);
      this.credentialState = "configured";
      this.setPanelMessage(state, "DeepSeek API Key 验证成功。", false);
      this.refreshAllPanels();
      return true;
    }
    catch (error) {
      this.credentialState = "invalid";
      this.setPanelMessage(state, String(error?.message || error), true);
      this.refreshAllPanels();
      return false;
    }
  },

  async legacyRemoveAPIKey(state = null) {
    await DeepSeekCredentials.deleteKey();
    this.credentialState = "missing";
    this.setPanelMessage(state, "DeepSeek API Key 已删除；已有缓存和覆盖层未清除。", false);
    this.refreshAllPanels();
    return true;
  },

  refreshAllPanels() {
    for (const state of [...this.panelStates]) {
      if (state.body?.isConnected === false) this.panelStates.delete(state);
      else {
        this.updatePanelState(state);
      }
    }
  },

  legacyUpdatePanelState(state) {
    const apiLabels = {
      unknown: "API：正在检查本机密钥…",
      missing: "API：未配置。翻译不会启动。",
      validating: "API：正在验证…",
      configured: `API：已安全配置，模型 ${DEEPSEEK_MODEL}`,
      invalid: "API：验证失败，请更换或重新验证密钥。"
    };
    state.apiStatus.textContent = apiLabels[this.credentialState] || apiLabels.unknown;
    state.saveKey.textContent = this.credentialState === "configured"
      ? "更换并验证" : "保存并验证";
    const reader = this.getReaderForItem(state.itemID);
    const session = reader ? this.autoSessions.get(reader) : null;
    state.frontMatterStatus.textContent = this.readerStatus.get(reader)
      || "标题/摘要：等待打开 PDF";
    state.titleStatus.textContent = this.formatAutoTargetStatus(session, "title");
    state.abstractStatus.textContent = this.formatAutoTargetStatus(session, "abstract");
    const busy = Boolean(reader && this.startingReaders.has(reader));
    state.retryTitle.disabled = !reader || busy;
    state.retryAbstract.disabled = !reader || busy;
    state.retryAll.disabled = !reader || busy;
    state.validateKey.disabled = this.credentialState === "validating";
    state.saveKey.disabled = this.credentialState === "validating";
  },

  getProvider(providerID = this.activeProviderID) {
    if (!providerID) return null;
    return globalThis.getTranslationProvider?.(providerID)
      || globalThis.TranslationProviderRegistry?.[providerID]
      || null;
  },

  getProviderState(providerID = this.activeProviderID) {
    const id = String(providerID || "");
    if (!this.providerStates.has(id)) {
      this.providerStates.set(id, {
        status: "missing",
        message: "",
        validationToken: 0
      });
    }
    return this.providerStates.get(id);
  },

  setProviderState(providerID, status, message = "") {
    const state = this.getProviderState(providerID);
    state.status = status;
    state.message = String(message || "");
    if (providerID === this.activeProviderID) this.credentialState = status;
    return state;
  },

  setPanelText(element, l10nID, fallback, doc = element?.ownerDocument) {
    if (!element) return;
    element.setAttribute?.("data-l10n-id", l10nID);
    element.textContent = fallback;
    doc?.l10n?.setAttributes?.(element, l10nID);
  },

  setPanelAttributes(element, l10nID, attributes, doc = element?.ownerDocument) {
    if (!element) return;
    element.setAttribute?.("data-l10n-id", l10nID);
    element.setAttribute?.("data-l10n-attrs", Object.keys(attributes).join(","));
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute?.(name, value);
    }
    doc?.l10n?.setAttributes?.(element, l10nID);
  },

  maskAPIKey(apiKey) {
    const value = String(apiKey || "").trim();
    if (!value) return "";
    if (value.length <= 7) return "*".repeat(value.length);
    const prefixLength = 4;
    const suffixLength = 3;
    return value.slice(0, prefixLength)
      + "*".repeat(value.length - prefixLength - suffixLength)
      + value.slice(-suffixLength);
  },

  providerRequestOptions(provider) {
    try {
      return provider?.requestOptions?.() || {};
    }
    catch (error) {
      return { error };
    }
  },

  providerStatusText(provider, state) {
    switch (state?.status) {
      case "configured":
        return "验证成功 · " + (provider?.modelSpec?.model || provider?.label || "");
      case "validating":
        return "正在验证…";
      case "invalid": {
        const message = String(state?.message || "").trim();
        if (/API Key 无效|密钥无效/iu.test(message)) return "API Key 无效";
        if (/timeout|timed out|超时/iu.test(message)) return "请求超时，请重试";
        const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/iu);
        if (httpStatus) return `HTTP ${httpStatus[1]}`;
        return message ? `验证失败：${message.slice(0, 80)}` : "验证失败";
      }
      case "unknown":
        return "正在检查";
      case "missing":
      default:
        return "未输入";
    }
  },

  providerStatusColor(status) {
    if (status === "configured") return "#16a34a";
    if (status === "invalid") return "#dc2626";
    return "#9ca3af";
  },

  makeStatusLamp(doc) {
    const lamp = doc.createElement("span");
    lamp.setAttribute("aria-hidden", "true");
    this.stylePanel(lamp, {
      display: "inline-block",
      width: "9px",
      height: "9px",
      borderRadius: "50%",
      flex: "0 0 auto",
      background: "#9ca3af",
      boxShadow: "0 0 0 1px rgba(0,0,0,.18)"
    });
    return lamp;
  },

  makeRetryButton(doc) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "↻";
    button.title = "重试验证";
    button.setAttribute("aria-label", "重试验证");
    this.stylePanel(button, {
      width: "24px",
      height: "24px",
      padding: "0",
      border: "0",
      borderRadius: "50%",
      color: "inherit",
      background: "transparent",
      fontSize: "18px",
      lineHeight: "22px",
      cursor: "pointer"
    });
    return button;
  },

  getProviderUI(providerID) {
    return TRANSLATION_PROVIDER_UI_BY_ID[providerID] || null;
  },

  ensureProviderPanelStyle(doc) {
    const styleParent = doc?.head || doc?.documentElement;
    if (!doc?.createElement || !styleParent?.append) return;
    if (doc.getElementById?.(PANEL_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      [data-provider-cards="true"] {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 160px));
        justify-content: center;
        gap: 10px;
      }
      [data-provider-card="true"] {
        min-width: 0;
      }
      @media (max-width: 520px) {
        [data-provider-card="true"] {
          min-height: 60px !important;
          height: 60px !important;
          padding: 6px 8px !important;
        }
        [data-provider-card-label="true"] {
          display: none !important;
        }
        [data-provider-card-logo="true"] {
          width: 28px !important;
          height: 28px !important;
          flex-basis: 28px !important;
        }
      }
    `;
    styleParent.append(style);
  },

  makeProviderLogo(doc, providerID, size = 42) {
    const metadata = this.getProviderUI(providerID) || {
      icon: "",
      fallback: "?"
    };
    const image = doc.createElement("img");
    image.src = `${this.rootURI}${metadata.icon}`;
    this.setPanelAttributes(
      image,
      `reader-selection-replacer-test-pane-provider-${providerID}-icon`,
      { alt: `${metadata.fallback} 图标` },
      doc
    );
    image.setAttribute("aria-hidden", "true");
    image.setAttribute("data-provider-logo", providerID);
    image.setAttribute("data-provider-card-logo", "true");
    this.stylePanel(image, {
      display: "block",
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "10px",
      border: "0",
      objectFit: "cover",
      boxSizing: "border-box",
      padding: "0",
      overflow: "hidden",
      background: "transparent",
      flex: `0 0 ${size}px`
    });

    const fallback = doc.createElement("span");
    fallback.textContent = metadata.fallback;
    fallback.setAttribute("aria-hidden", "true");
    fallback.setAttribute("data-provider-logo-fallback", providerID);
    this.stylePanel(fallback, {
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "10px",
      border: "0",
      flex: `0 0 ${size}px`,
      color: "var(--fill-primary, inherit)",
      background: "var(--material-button-hover, rgba(127,127,127,.22))",
      fontSize: size > 30 ? "18px" : "13px",
      fontWeight: "600"
    });
    image.addEventListener("error", () => {
      image.style.display = "none";
      fallback.style.display = "inline-flex";
    });

    const wrapper = doc.createElement("span");
    this.stylePanel(wrapper, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: `${size}px`,
      height: `${size}px`,
      flex: `0 0 ${size}px`
    });
    wrapper.append(image, fallback);
    return wrapper;
  },

  makeProviderCard(doc, metadata) {
    const button = this.makePanelButton(doc, "");
    button.dataset.provider = metadata.id;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("data-provider-card", "true");
    button.setAttribute("aria-label", metadata.label);
    this.stylePanel(button, {
      minHeight: "72px",
      height: "72px",
      padding: "8px 12px",
      border: "0",
      borderRadius: "12px",
      background: metadata.color,
      color: "#f2f3f7",
      textAlign: "left",
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: "10px",
      boxSizing: "border-box",
      boxShadow: "0 2px 4px rgba(0,0,0,.18)",
      cursor: "pointer",
      position: "relative"
    });

    const logo = this.makeProviderLogo(doc, metadata.id, 42);
    const check = doc.createElement("span");
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    check.setAttribute("data-provider-card-check", metadata.id);
    this.stylePanel(check, {
      visibility: "hidden",
      position: "absolute",
      top: "8px",
      right: "10px",
      color: "#f2f3f7",
      fontSize: "21px",
      lineHeight: "1",
      fontWeight: "600"
    });
    const label = doc.createElement("strong");
    label.setAttribute("data-provider-card-label", "true");
    this.setPanelText(label,
      `reader-selection-replacer-test-pane-provider-${metadata.id}`,
      metadata.label, doc);
    this.stylePanel(label, {
      display: "block",
      fontSize: "17px",
      lineHeight: "1.15",
      fontWeight: "700",
      letterSpacing: "-.02em"
    });

    button.append(logo, label, check);
    return button;
  },

  renderItemPane({ doc, body, item, tabType }) {
    if (!doc || !body) return;
    for (const oldState of [...this.panelStates]) {
      if (oldState.body === body) this.panelStates.delete(oldState);
    }
    body.replaceChildren?.();

    this.ensureProviderPanelStyle(doc);
    const container = doc.createElement("div");
    container.setAttribute("data-provider-panel", "true");
    this.stylePanel(container, {
      display: "flex",
      flexDirection: "column",
      gap: "0",
      padding: "0",
      color: "var(--fill-primary, inherit)",
      fontSize: "14px",
      boxSizing: "border-box",
      width: "100%",
      marginTop: "12px"
    });

    const providerPanel = doc.createElement("div");
    this.stylePanel(providerPanel, {
      display: "flex",
      flexDirection: "column",
      gap: "0",
      border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
      borderRadius: "11px",
      background: "rgba(127,127,127,.03)",
      overflow: "hidden"
    });
    const providerHeader = doc.createElement("button");
    providerHeader.type = "button";
    providerHeader.setAttribute("aria-expanded", "true");
    this.stylePanel(providerHeader, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      width: "100%",
      minHeight: "48px",
      padding: "6px 12px",
      border: "0",
      borderBottom: "1px solid var(--fill-quinary, rgba(0,0,0,.35))",
      borderRadius: "0",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      cursor: "pointer"
    });
    const providerTitle = doc.createElement("span");
    this.stylePanel(providerTitle, {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minWidth: "0",
      color: "var(--fill-secondary, #aeb0b6)",
      fontSize: "15px",
      fontWeight: "600"
    });
    const providerHeaderLogo = doc.createElement("span");
    const providerHeaderLabel = doc.createElement("span");
    providerTitle.append(providerHeaderLogo, providerHeaderLabel);
    const providerChevron = doc.createElement("span");
    providerChevron.textContent = "⌃";
    providerChevron.setAttribute("aria-hidden", "true");
    this.stylePanel(providerChevron, { fontSize: "18px", opacity: "0.7" });
    providerHeader.append(providerTitle, providerChevron);

    const providerContent = doc.createElement("div");
    this.stylePanel(providerContent, {
      display: "block",
      padding: "10px 14px 14px"
    });
    const providerButtons = doc.createElement("div");
    providerButtons.setAttribute("data-provider-cards", "true");
    this.stylePanel(providerButtons, {
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: "10px"
    });
    for (const metadata of TRANSLATION_PROVIDER_UI) {
      providerButtons.append(this.makeProviderCard(doc, metadata));
    }

    const divider = doc.createElement("div");
    this.stylePanel(divider, {
      height: "1px",
      margin: "16px 0 14px",
      background: "var(--fill-quinary, rgba(0,0,0,.42))"
    });

    const inputSection = doc.createElement("div");
    this.stylePanel(inputSection, {
      display: "flex",
      flexDirection: "column",
      gap: "9px"
    });
    const apiInput = doc.createElement("input");
    apiInput.type = "password";
    apiInput.readOnly = false;
    apiInput.autocomplete = "new-password";
    apiInput.spellcheck = false;
    this.stylePanel(apiInput, {
      boxSizing: "border-box",
      width: "100%",
      minHeight: "50px",
      padding: "8px 12px",
      color: "var(--fill-secondary, #9ca3af)",
      background: "transparent",
      border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
      borderRadius: "8px",
      font: "inherit",
      textAlign: "center",
      fontFamily: "monospace"
    });
    const statusRow = doc.createElement("div");
    this.stylePanel(statusRow, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      minHeight: "24px",
      color: "var(--fill-secondary, inherit)",
      padding: "0 3px"
    });
    const statusLamp = this.makeStatusLamp(doc);
    const apiStatus = doc.createElement("span");
    const retryValidation = this.makeRetryButton(doc);
    statusRow.append(statusLamp, apiStatus, retryValidation);
    inputSection.append(apiInput, statusRow);

    const actions = doc.createElement("div");
    this.stylePanel(actions, {
      display: "flex",
      justifyContent: "space-between",
      gap: "16px"
    });
    const resetKey = this.makePanelButton(doc, "重置", true);
    const saveKey = this.makePanelButton(doc, "保存");
    this.setPanelText(resetKey,
      "reader-selection-replacer-test-pane-reset", "重置", doc);
    this.setPanelText(saveKey,
      "reader-selection-replacer-test-pane-save", "保存", doc);
    this.stylePanel(resetKey, {
      flex: "1 1 0",
      minHeight: "46px",
      border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
      borderRadius: "8px",
      background: "transparent",
      fontSize: "16px"
    });
    this.stylePanel(saveKey, {
      flex: "1 1 0",
      minHeight: "46px",
      border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
      borderRadius: "8px",
      background: "transparent",
      fontSize: "16px"
    });
    actions.append(resetKey, saveKey);

    providerContent.append(providerButtons, divider, inputSection, actions);
    providerPanel.append(providerHeader, providerContent);
    const previewSection = doc.createElement("div");
    previewSection.setAttribute("data-translation-preview", "true");
    this.stylePanel(previewSection, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      width: "100%",
      marginTop: "10px"
    });
    const translatedPreview = this.makeTranslationPreviewBox(doc, "translated");
    const originalPreview = this.makeTranslationPreviewBox(doc, "original");
    previewSection.append(translatedPreview.wrapper, originalPreview.wrapper);
    container.append(providerPanel, previewSection);
    body.append(container);

    const providerCardMap = new Map(
      [...providerButtons.children].map(button => [button.dataset.provider, button])
    );
    const state = {
      body,
      itemID: item?.id || null,
      tabType,
      container,
      providerPanel,
      providerHeader,
      providerHeaderLogo,
      providerHeaderLabel,
      providerChevron,
      providerContent,
      providerButtons,
      providerCardMap,
      previewSection,
      translatedPreviewText: translatedPreview.text,
      originalPreviewText: originalPreview.text,
      translatedCopyButton: translatedPreview.copyButton,
      originalCopyButton: originalPreview.copyButton,
      divider,
      inputSection,
      apiInput,
      statusRow,
      statusLamp,
      apiStatus,
      retryValidation,
      actions,
      resetKey,
      saveKey,
      providerID: this.activeProviderID || "",
      savedKey: "",
      loadToken: 0,
      previewSignature: ""
    };
    state.qwenButton = providerCardMap.get("qwen-mt");
    state.deepSeekButton = providerCardMap.get("deepseek");
    this.panelStates.add(state);
    providerHeader.addEventListener("click", () => {
      const expanded = providerHeader.getAttribute("aria-expanded") !== "false";
      providerHeader.setAttribute("aria-expanded", String(!expanded));
      providerContent.style.display = expanded ? "none" : "block";
      providerChevron.textContent = expanded ? "⌄" : "⌃";
    });
    for (const [providerID, button] of providerCardMap) {
      button.addEventListener("click", () => this.selectProviderForPanels(providerID));
    }
    translatedPreview.copyButton.addEventListener("click",
      () => this.copyPreviewText(state, "translated"));
    originalPreview.copyButton.addEventListener("click",
      () => this.copyPreviewText(state, "original"));
    apiInput.addEventListener("input", () => {
      state.inputDirty = true;
      state.maskedPreview = false;
    });
    saveKey.addEventListener("click", () => this.saveAPIKeyFromPanel(state));
    resetKey.addEventListener("click", () => this.removeAPIKey(state));
    retryValidation.addEventListener("click", () => this.revalidateAPIKey(state));

    this.updatePanelState(state);
    if (this.activeProviderID) this.loadProviderIntoPanel(state, true);
  },

  async selectProviderForPanels(providerID) {
    const id = TRANSLATION_PROVIDER_UI_BY_ID[providerID] ? providerID : "";
    const previousID = this.activeProviderID;
    this.activeProviderID = globalThis.setActiveTranslationProviderID?.(id) || id;
    if (previousID !== this.activeProviderID) {
      this.latestTranslationPreviews.clear();
      this.refreshAllPanels();
    }
    await Promise.all([...this.panelStates].map(state => {
      state.providerID = this.activeProviderID;
      return this.loadProviderIntoPanel(state, true);
    }));
    this.refreshAllPanels();
    const provider = this.getProvider(this.activeProviderID);
    const providerState = this.activeProviderID
      ? this.getProviderState(this.activeProviderID) : null;
    if (provider?.credentialMode === "none" || providerState?.status === "configured") {
      this.restartActiveReaders();
    }
  },

  async loadProviderIntoPanel(state, validate = true) {
    if (!state) return false;
    const token = ++state.loadToken;
    state.providerID = this.activeProviderID;
    state.savedKey = "";
    state.apiInput.value = "";
    state.inputDirty = false;
    state.maskedPreview = false;
    if (state.providerID) this.setProviderState(state.providerID, "missing", "");
    this.updatePanelState(state);
    if (!state.providerID) return false;
    const provider = this.getProvider(state.providerID);
    if (!provider) return false;
    if (provider.credentialMode === "none") return true;
    const credentials = provider.credentials;
    if (!credentials?.getKey) return false;
    let apiKey = "";
    try {
      apiKey = String(await credentials.getKey() || "").trim();
    }
    catch (error) {
      this.setProviderState(state.providerID, "invalid", String(error?.message || error));
      this.updatePanelState(state);
      return false;
    }
    if (token !== state.loadToken) return false;
    state.savedKey = apiKey;
    this.updatePanelState(state);
    if (!apiKey || !validate) {
      this.setProviderState(state.providerID, apiKey ? "unknown" : "missing", "");
      this.updatePanelState(state);
      return Boolean(apiKey);
    }
    return this.revalidateAPIKey(state, { apiKey, saveOnSuccess: false });
  },

  async revalidateProviderKey(providerID = this.activeProviderID) {
    const provider = this.getProvider(providerID);
    if (!provider) return false;
    const credentials = provider.credentials;
    const state = this.setProviderState(provider.id, "missing", "");
    if (!credentials?.getKey) return false;
    const apiKey = String(await credentials.getKey() || "").trim();
    if (!apiKey) {
      state.status = "missing";
      this.refreshAllPanels();
      return false;
    }
    const requestOptions = this.providerRequestOptions(provider);
    state.status = "validating";
    this.refreshAllPanels();
    try {
      await credentials.validateKey(apiKey, requestOptions);
      state.status = "configured";
      state.message = "";
      this.refreshAllPanels();
      return true;
    }
    catch (error) {
      state.status = "invalid";
      state.message = String(error?.message || error);
      this.refreshAllPanels();
      return false;
    }
  },

  async saveAPIKeyFromPanel(state) {
    if (!state) return false;
    const provider = this.getProvider(state.providerID);
    if (!provider || provider.credentialMode !== "api-key") return false;
    const credentials = provider.credentials;
    const inputKey = state.inputDirty
      ? String(state.apiInput?.value || "").trim()
      : "";
    const apiKey = inputKey || state.savedKey
      || String(await credentials?.getKey?.() || "").trim();
    if (!apiKey) {
      this.setProviderState(state.providerID, "missing", "请输入 API Key。");
      this.setPanelMessage(state, "请输入 API Key。", false);
      this.updatePanelState(state);
      return false;
    }
    return this.revalidateAPIKey(state, { apiKey, saveOnSuccess: Boolean(inputKey) });
  },

  async revalidateAPIKey(state = null, options = {}) {
    const providerID = state?.providerID || this.activeProviderID;
    const provider = this.getProvider(providerID);
    if (!provider || provider.credentialMode !== "api-key") return false;
    const credentials = provider.credentials;
    const inputKey = state?.inputDirty
      ? String(state.apiInput?.value || "").trim()
      : "";
    const apiKey = String(options.apiKey || inputKey || state?.savedKey
      || await credentials?.getKey?.() || "").trim();
    if (!apiKey) {
      this.setProviderState(providerID, "missing", "请输入 API Key。");
      if (state) this.setPanelMessage(state, "请输入 API Key。", false);
      this.updatePanelState(state);
      return false;
    }
    const requestOptions = this.providerRequestOptions(provider);
    const providerState = this.setProviderState(providerID, "validating", "");
    const token = ++providerState.validationToken;
    this.refreshAllPanels();
    try {
      await credentials.validateKey(apiKey, requestOptions);
      if (token !== providerState.validationToken) return false;
      const shouldSave = options.saveOnSuccess !== false
        && Boolean(inputKey)
        && inputKey !== state?.savedKey;
      if (shouldSave) {
        await credentials.saveKey(inputKey);
        if (state) state.savedKey = inputKey;
      }
      if (state && shouldSave) {
        state.apiInput.value = "";
        state.inputDirty = false;
        state.maskedPreview = true;
      }
      providerState.status = "configured";
      providerState.message = "";
      if (state) this.setPanelMessage(state,
        provider.label + " API Key 验证成功。", false);
      this.refreshAllPanels();
      if (shouldSave) this.restartActiveReaders();
      else this.restartFailedAutoSessions();
      return true;
    }
    catch (error) {
      if (token !== providerState.validationToken) return false;
      providerState.status = "invalid";
      providerState.message = String(error?.message || error);
      if (state) this.setPanelMessage(state, providerState.message, true);
      this.refreshAllPanels();
      return false;
    }
  },

  async removeAPIKey(state = null) {
    const providerID = state?.providerID || this.activeProviderID;
    const provider = this.getProvider(providerID);
    if (!provider || provider.credentialMode !== "api-key") return false;
    const confirmed = Services.prompt?.confirm
      ? Services.prompt.confirm(null, "Translator for Zotero", "确定删除当前模型的 API Key？")
      : true;
    if (!confirmed) return false;
    try {
      await provider.credentials?.deleteKey?.();
      if (state) {
        state.savedKey = "";
        state.apiInput.value = "";
        state.inputDirty = false;
        state.maskedPreview = false;
      }
      this.setProviderState(providerID, "missing", "");
      if (state) this.setPanelMessage(state, provider.label + " API Key 已删除。", false);
      this.refreshAllPanels();
      return true;
    }
    catch (error) {
      this.setProviderState(providerID, "invalid", String(error?.message || error));
      if (state) this.setPanelMessage(state, String(error?.message || error), true);
      this.refreshAllPanels();
      return false;
    }
  },

  restartFailedAutoSessions() {
    for (const reader of Zotero.Reader?._readers || []) {
      const session = this.autoSessions.get(reader);
      const failed = Boolean(session?.error || session?.translation?.diagnostics?.failed);
      if (failed) {
        this.autoSessions.delete(reader);
        this.autoMarkReader(reader).catch(error => Zotero.logError?.(error));
      }
    }
  },

  restartActiveReaders() {
    if (!this.activeProviderID) return;
    for (const reader of Zotero.Reader?._readers || []) {
      const session = this.autoSessions.get(reader);
      if (session) session.cancelled = true;
      this.autoSessions.delete(reader);
      this.autoMarkReader(reader, { force: true }).catch(error => Zotero.logError?.(error));
    }
  },

  updatePanelState(state) {
    if (!state) return;
    const doc = state.container?.ownerDocument || state.body?.ownerDocument;
    const providerID = state.providerID || this.activeProviderID || "";
    const provider = this.getProvider(providerID);
    const metadata = this.getProviderUI(providerID);
    const providerState = provider ? this.getProviderState(providerID)
      : { status: "missing", message: "" };
    for (const [cardID, button] of state.providerCardMap || []) {
      const selected = cardID === providerID;
      const card = this.getProviderUI(cardID);
      button.setAttribute("aria-pressed", String(selected));
      button.style.border = "0";
      button.style.padding = "8px 12px";
      button.style.background = card?.color || "var(--material-button, transparent)";
      button.style.boxShadow = "0 2px 4px rgba(0,0,0,.18)";
      const check = button.children?.[2];
      if (check) check.style.visibility = selected ? "visible" : "hidden";
    }
    state.providerHeaderLogo.replaceChildren?.();
    if (metadata) {
      state.providerHeaderLogo.append(this.makeProviderLogo(doc, providerID, 26));
      this.setPanelText(state.providerHeaderLabel,
        `reader-selection-replacer-test-pane-provider-${providerID}`,
        metadata.label, doc);
      state.providerHeaderLabel.style.color = "inherit";
    }
    else {
      this.setPanelText(state.providerHeaderLabel,
        "reader-selection-replacer-test-pane-no-provider", "选择翻译模型",
        doc);
      state.providerHeaderLabel.style.color = "var(--fill-secondary, #aeb0b6)";
    }
    const keyedProvider = provider?.credentialMode === "api-key";
    state.divider.style.display = keyedProvider ? "block" : "none";
    state.inputSection.style.display = keyedProvider ? "flex" : "none";
    state.actions.style.display = keyedProvider ? "flex" : "none";
    const editing = Boolean(state.inputDirty);
    const hasSavedKey = Boolean(state.savedKey);
    const inputL10nID = providerID
      ? `reader-selection-replacer-test-pane-api-key-${providerID}` : "";
    this.setPanelAttributes(state.apiInput, inputL10nID, {
      placeholder: provider ? `输入${provider.label} API Key` : "",
      "aria-label": provider ? `${provider.label} API Key` : ""
    });
    if (hasSavedKey && !editing) {
      state.apiInput.readOnly = true;
      state.apiInput.type = "text";
      state.apiInput.value = this.maskAPIKey(state.savedKey);
      state.apiInput.placeholder = "";
      state.apiInput.style.color = "var(--fill-secondary, #9ca3af)";
      state.maskedPreview = true;
    }
    else {
      state.apiInput.readOnly = false;
      state.apiInput.type = "password";
      state.apiInput.style.color = "inherit";
      if (!editing) state.apiInput.value = "";
      state.maskedPreview = false;
    }
    state.apiInput.setAttribute("aria-readonly", String(Boolean(state.apiInput.readOnly)));
    state.apiStatus.textContent = provider
      ? this.providerStatusText(provider, providerState) : "";
    state.statusLamp.style.background = this.providerStatusColor(providerState.status);
    state.retryValidation.style.visibility =
      keyedProvider && providerState.status === "invalid" ? "visible" : "hidden";
    state.retryValidation.disabled = providerState.status === "validating";
    state.saveKey.disabled = !keyedProvider || providerState.status === "validating";
    state.resetKey.disabled = !keyedProvider || providerState.status === "validating";
    this.updateTranslationPreviewPanel(state);
  },

  formatAutoTargetStatus(session, kind) {
    const label = AUTO_TARGET_LABELS[kind] || kind;
    if (!session) return `${label}：未开始`;
    if (session.error) return `${label}：处理失败`;
    const target = (session.result?.targets || []).find(value => value.kind === kind);
    if (!target) return `${label}：未定位`;
    const translation = session.translation?.results?.get?.(kind);
    if (["cached", "translated"].includes(translation?.status)) {
      return `${label}：已完成${translation.status === "cached" ? "（缓存）" : ""}`;
    }
    if (translation?.status === "failed") return `${label}：翻译失败`;
    if (translation?.status === "skipped") return `${label}：未翻译`;
    return `${label}：等待翻译`;
  },

  async retryFrontMatter(state, targetKinds) {
    const reader = this.getReaderForItem(state?.itemID);
    if (!reader) {
      this.setPanelMessage(state, "当前没有可用的 PDF Reader。", true);
      return null;
    }
    this.setPanelMessage(state, `正在重试${targetKinds.length === 2 ? "标题和摘要" : AUTO_TARGET_LABELS[targetKinds[0]]}…`);
    try {
      const session = await this.autoMarkReader(reader, { force: true, targetKinds });
      const attempt = session?.translationAttempt;
      const diagnostics = attempt?.diagnostics;
      if (diagnostics?.failed) {
        this.setPanelMessage(state,
          `重试完成：${diagnostics.failed} 个目标失败；已有译文已保留。`, true);
      }
      else {
        const completed = (diagnostics?.translated || 0) + (diagnostics?.cached || 0);
        this.setPanelMessage(state, `重试完成：${completed}/${targetKinds.length} 个目标可用。`);
      }
      this.refreshAllPanels();
      return session;
    }
    catch (error) {
      this.setPanelMessage(state, String(error?.message || error), true);
      return null;
    }
  },

  async waitForPDFView(reader) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const view = reader?._internalReader?._primaryView || null;
      const application = view?._iframeWindow?.PDFViewerApplication;
      const pdfDocument = application?.pdfDocument;
      const pages = application?.pdfViewer?._pages || [];
      if (view && typeof pdfDocument?.getPageData === "function"
        && pages.some(page => page?.viewport)) return view;
      const delay = Zotero.Promise?.delay
        ? Zotero.Promise.delay(50)
        : new Promise(resolve => setTimeout(resolve, 50));
      await delay;
    }
    throw new Error("等待 Zotero PDF Reader 初始化超时");
  },

  updateSelectionGeometryStatus(reader, recordID, geometryStatus, diagnostics) {
    const session = this.selectionSessions.get(reader);
    if (!session || session.cancelled || session.recordID !== recordID) return;
    const previous = session.geometryStatus;
    session.geometryStatus = geometryStatus;
    session.geometryDiagnostics = diagnostics;
    const status = session.statusElement;
    if (!status) return;
    if (geometryStatus === "geometry-invalid") {
      status.textContent = "无法定位划选范围";
    }
    else if (geometryStatus === "geometry-pending" && !session.translation) {
      status.textContent = "正在等待页面定位…";
    }
    else if (geometryStatus === "ready" && previous === "geometry-pending"
      && !session.translation) {
      status.textContent = "正在翻译划选内容…";
    }
  },

  formatAutoStatusV2(result) {
    const confidence = { high: "high", medium: "medium", low: "low" };
    const byKind = new Map((result?.targets || []).map(target => [target.kind, target]));
    const format = kind => {
      const target = byKind.get(kind);
      if (!target) {
        const detail = kind === "abstract"
          && result?.diagnostics?.abstractRejection === "completeness-validation-failed"
          ? " (completeness validation failed)" : "";
        return `${AUTO_TARGET_LABELS[kind]}: unlocated${detail}`;
      }
      const method = target.matchMethod === "metadata-segmented" ? "metadata" : "layout";
      const coverage = target.metadataCoverage > 0
        ? ` ${Math.round(target.metadataCoverage * 100)}%` : "";
      const completeness = target.completeness ? `/${target.completeness}` : "";
      return `${AUTO_TARGET_LABELS[kind]}: ${confidence[target.confidence] || "unknown"}/${method}${completeness}${coverage}`;
    };
    return `${format("title")} | ${format("abstract")}`;
  },

  onRenderToolbar({ reader, doc }) {
    if (!reader) return;
    const toolbarDocument = doc
      || reader?._internalReader?._primaryView?._iframeWindow?.document;
    for (const id of LEGACY_TOOLBAR_IDS) {
      toolbarDocument?.getElementById?.(id)?.remove?.();
    }
    if (!this.autoSessions.has(reader) && !this.startingReaders.has(reader)) {
      Promise.resolve().then(() => this.autoMarkReader(reader))
        .catch(error => Zotero.logError?.(error));
    }
  },

  async autoMarkReader(reader, options = {}) {
    if (!reader) return null;
    if (!this.activeProviderID) {
      this.setReaderStatus(reader, "请先选择翻译模型");
      return null;
    }
    const config = typeof options === "boolean" ? { force: options } : (options || {});
    const force = Boolean(config.force);
    const targetKinds = Array.isArray(config.targetKinds) && config.targetKinds.length
      ? new Set(config.targetKinds.map(String)) : null;
    if (!force && (this.startingReaders.has(reader)
      || (this.autoSessions.has(reader) && !this.autoSessions.get(reader)?.error))) {
      return this.autoSessions.get(reader) || null;
    }
    if (this.startingReaders.has(reader)) return null;
    const previous = this.autoSessions.get(reader);
    if (force) {
      if (previous) previous.cancelled = true;
    }
    this.startingReaders.add(reader);
    this.clearLatestTranslationPreview(reader);
    this.setReaderStatus(reader, "正在识别标题/摘要…");
    let session = null;
    try {
      const view = await this.waitForPDFView(reader);
      if (!SelectionReplacerOverlay.states.has(reader)) {
        SelectionReplacerOverlay.attach(reader, view, [], {
          mode: "diagnostic", recordID: "front-matter", segments: [],
          translations: new Map(), translationPending: true
        });
      }
      const metadata = await ReaderMetadataLoader.read(reader);
      const located = await ReaderTargetLocator.locate(view, metadata);
      const attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
      const previousRecord = SelectionReplacerOverlay.states.get(reader)?.records?.get("front-matter");
      const oldTargets = previous?.result?.targets || previousRecord?.targets || [];
      const targetMap = new Map(oldTargets.map(target => [target.kind, target]));
      for (const target of located.targets || []) targetMap.set(target.kind, target);
      const targets = [...targetMap.values()];
      const requestedTargets = targetKinds
        ? targets.filter(target => targetKinds.has(target.kind))
        : targets;
      const segments = ContentSegments.fromTargets(requestedTargets);
      const retainedResults = new Map(previous?.translation?.results
        || previousRecord?.translations || []);
      session = {
        reader, view, result: { ...located, targets }, segments, attachment,
        cancelled: false, retryKinds: targetKinds
      };
      this.autoSessions.set(reader, session);
      if (targets.length) {
        SelectionReplacerOverlay.attach(reader, view, targets,
          { mode: "diagnostic", recordID: "front-matter", segments,
            translations: retainedResults, translationPending: true });
      }
      this.setReaderStatus(reader, this.formatAutoStatusV2({ ...located, targets }));
      const translation = await TranslationCoordinator.translateSegments({
        attachment, segments, session, bypassCache: force
      });
      if (session.cancelled) return session;
      const combinedResults = new Map(retainedResults);
      for (const [segmentID, result] of translation.results) {
        const previousResult = combinedResults.get(segmentID);
        if (["failed", "skipped"].includes(result.status)
          && ["cached", "translated"].includes(previousResult?.status)) {
          continue;
        }
        combinedResults.set(segmentID, result);
      }
      session.translation = translation;
      session.translationAttempt = translation;
      session.translation.results = combinedResults;
      this.setLatestTranslationPreview(reader,
        this.makeTranslationPreview(segments, combinedResults));
      if (targets.length) {
        SelectionReplacerOverlay.attach(reader, view, targets, {
          mode: "diagnostic", recordID: "front-matter", segments,
          translations: combinedResults
        });
      }
      const translated = translation.diagnostics.translated + translation.diagnostics.cached;
      this.setReaderStatus(reader,
        `${this.formatAutoStatusV2({ ...located, targets })} | 译文 ${translated}/${segments.length}`);
      Zotero.debug?.(`[${PLUGIN_ID}] automatic front matter analysis: ${JSON.stringify({
        itemID: reader.itemID,
        metadataSource: metadata.source,
        parentItemID: metadata.parentItemID,
        diagnostics: located.diagnostics,
        targets: targets.map(target => ({
          kind: target.kind,
          confidence: target.confidence,
          matchMethod: target.matchMethod,
          metadataCoverage: target.metadataCoverage,
          pageIndexes: target.pageIndexes,
          pageIndex: target.position?.pageIndex
        }))
      })}`);
      return session;
    }
    catch (error) {
      if (session?.cancelled) return session;
      Zotero.logError?.(error);
      this.setReaderStatus(reader, `标题/摘要识别失败：${error?.message || error}`);
      this.autoSessions.set(reader, { reader, error, result: previous?.result || null,
        translation: previous?.translation || null });
      return null;
    }
    finally {
      if (!session || this.autoSessions.get(reader) === session) {
        this.startingReaders.delete(reader);
        this.refreshAllPanels();
      }
    }
  },

  async translateSelection(reader, annotation, sourceText, status, button) {
    if (!this.activeProviderID) {
      status.textContent = "请先选择翻译模型";
      return;
    }
    const position = copyPosition(annotation?.position)
      || copyPosition(reader?._internalReader?.getSelectionPosition?.());
    const view = reader?._internalReader?._primaryView || null;
    if (!position) {
      status.textContent = "未读取到选区位置";
      return;
    }
    if (!view || !view?._iframeWindow?.PDFViewerApplication?.pdfViewer) {
      status.textContent = "未找到 PDF 视图";
      return;
    }
    status.textContent = "正在准备划选内容…";
    button.disabled = true;
    const previous = this.selectionSessions.get(reader);
    if (previous) previous.cancelled = true;
    if (previous?.recordID) {
      const previousState = SelectionReplacerOverlay.states.get(reader);
      const previousRecord = previousState?.records?.get(previous.recordID);
      if (previousRecord?.translationPending) {
        SelectionReplacerOverlay.removeRecord(reader, previous.recordID);
      }
    }
    const session = { reader, cancelled: false, statusElement: status,
      recordID: `selection-${++this.selectionTaskCounter}` };
    this.selectionSessions.set(reader, session);
    this.clearLatestTranslationPreview(reader);
    try {
      const match = ReaderSelectionBlock.create({ view, position, sourceText });
      match.segments = ContentSegments.fromSelectionBlock(match);
      session.view = view;
      session.match = match;
      session.segments = match.segments;
      session.attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
      if (this.selectionSessions.get(reader) !== session || session.cancelled) return;
      if (!match.segments.length) {
        status.textContent = "未找到可翻译的划选内容";
        return;
      }
      SelectionReplacerOverlay.attach(reader, view, match, {
        mode: "selection-translation",
        recordID: session.recordID,
        segments: match.segments,
        translations: new Map(),
        translationPending: true
      });
      status.textContent = "正在翻译划选内容…";
      const translation = await TranslationCoordinator.translateSegments({
        attachment: session.attachment,
        segments: match.segments,
        session,
        bypassCache: false
      });
      if (this.selectionSessions.get(reader) !== session || session.cancelled) return;
      session.translation = translation;
      SelectionReplacerOverlay.attach(reader, view, match, {
        mode: "selection-translation",
        recordID: session.recordID,
        segments: match.segments,
        translations: translation.results,
        translationPending: false
      });
      this.setLatestTranslationPreview(reader,
        this.makeTranslationPreview(match.segments, translation.results));
      const translated = translation.diagnostics.translated + translation.diagnostics.cached;
      status.textContent = session.geometryStatus === "geometry-invalid"
        ? "无法定位划选范围"
        : `划选翻译完成：${translated}/${match.segments.length}`
          + (translation.diagnostics.failed ? ` · 失败 ${translation.diagnostics.failed}` : "")
          + (translation.diagnostics.skipped ? ` · 跳过 ${translation.diagnostics.skipped}` : "");
      Zotero.debug?.(`[${PLUGIN_ID}] selection analysis: ${JSON.stringify({
        sourceText,
        diagnostics: match.diagnostics,
        geometryStatus: session.geometryStatus || "unknown",
        geometryDiagnostics: session.geometryDiagnostics || null,
        translation: translation.diagnostics,
        blocks: match.blocks.map(block => ({
          pageIndex: block.pageIndex,
          column: block.column,
          rectCount: block.rects.length
        }))
      })}`);
    }
    finally {
      button.disabled = false;
      if (this.selectionSessions.get(reader) === session) this.selectionSessions.delete(reader);
    }
  },

  onRenderTextSelectionPopup({ reader, doc, params, append }) {
    if (!reader || !doc || typeof append !== "function") return;
    const annotation = params?.annotation;
    const sourceText = String(annotation?.text || "").trim();
    if (!sourceText) return;

    const container = doc.createElement("div");
    container.className = POPUP_CLASS;
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.alignItems = "center";
    container.style.justifyContent = "center";
    container.style.width = "100%";
    container.style.gap = "6px";
    container.style.padding = "8px 0 0";

    const buttonRow = doc.createElement("div");
    buttonRow.style.display = "flex";
    buttonRow.style.width = "calc(100% - 32px)";
    buttonRow.style.maxWidth = "440px";
    buttonRow.style.gap = "6px";
    buttonRow.style.margin = "0 auto";

    const makeTranslationButton = (label, title) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.style.display = "block";
      button.style.boxSizing = "border-box";
      button.style.flex = "1 1 0";
      button.style.minWidth = "0";
      button.style.width = "auto";
      button.style.height = "42px";
      button.style.minHeight = "42px";
      button.style.maxHeight = "42px";
      button.style.margin = "0";
      button.style.padding = "2px 10px";
      button.style.border = "1px solid var(--fill-quinary, rgba(255,255,255,.28))";
      button.style.borderRadius = "8px";
      button.style.background = "var(--material-button, rgba(127,127,127,.12))";
      button.style.color = "var(--fill-primary, #f4f4f4)";
      button.style.font = "inherit";
      button.style.fontSize = "14px";
      button.style.lineHeight = "1.2";
      button.style.textAlign = "center";
      button.style.cursor = "pointer";
      button.style.appearance = "none";
      return button;
    };

    const button = makeTranslationButton("翻译", "翻译当前划选内容");
    const forceSingleButton = makeTranslationButton(
      "翻译（强制单段）", "强制单段翻译接口预留，暂未启用"
    );
    forceSingleButton.disabled = true;
    forceSingleButton.setAttribute("data-translation-mode", "force-single-segment");
    forceSingleButton.setAttribute("aria-disabled", "true");
    buttonRow.append(button, forceSingleButton);

    const status = doc.createElement("span");
    status.style.fontSize = "11px";
    status.style.opacity = "0.75";
    status.style.width = "100%";
    status.style.textAlign = "center";

    button.addEventListener("click", () => {
      this.translateSelection(reader, annotation, sourceText, status, button)
        .catch(error => {
          Zotero.logError?.(error);
          status.textContent = `处理失败：${error?.message || error}`;
          button.disabled = false;
        });
    });

    container.append(buttonRow, status);
    append(container);
  }
};

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await SelectionReplacerTest.init(rootURI);
}

function onMainWindowLoad({ window }) {
  SelectionReplacerTest.onMainWindowLoad(window);
}

function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) SelectionReplacerTest.shutdown();
}

function install() {}
function uninstall() {}
