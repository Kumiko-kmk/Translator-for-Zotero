"use strict";

const PLUGIN_ID = "reader-selection-replacer-test@local.kumiko";
const PLUGIN_VERSION = "0.4.12";
const POPUP_CLASS = "reader-selection-replacer-test-popup";
const TOOLBAR_BUTTON_ID = "reader-selection-replacer-test-auto-button";
const TOOLBAR_STATUS_ID = "reader-selection-replacer-test-auto-status";
const LAYER_CLASS = "reader-selection-replacer-test-layer";
const PARAGRAPH_TRANSLATION_INDENT = "　　";
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

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200d\ufeff]/gu, "")
    .replace(/(\p{L})-\s+(?=\p{Ll})/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
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

function copyViewBox(value) {
  if (!value || Number(value.length || 0) < 4) return null;
  const viewBox = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  return viewBox.every(Number.isFinite) && viewBox[2] > viewBox[0] && viewBox[3] > viewBox[1]
    ? viewBox : null;
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

function rectangleArea(rect) {
  return Math.max(0, Number(rect?.[2]) - Number(rect?.[0]))
    * Math.max(0, Number(rect?.[3]) - Number(rect?.[1]));
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  return width * height;
}

function pointInRect(point, rect) {
  return point[0] >= rect[0] && point[0] <= rect[2]
    && point[1] >= rect[1] && point[1] <= rect[3];
}

function copyPosition(position) {
  if (!position || typeof position !== "object") return null;
  const fragments = Array.isArray(position.fragments)
    ? position.fragments.map(fragment => ({
      pageIndex: Number(fragment?.pageIndex ?? position.pageIndex ?? 0),
      rects: copyRects(fragment?.rects)
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
    pageIndex: firstPage,
    rects: copyRects(fragments.find(fragment => fragment.pageIndex === firstPage)?.rects),
    fragments
  };
}

function positionFragments(position) {
  return Array.isArray(position?.fragments) ? position.fragments : [];
}

function countPositionRects(position) {
  return positionFragments(position).reduce((sum, fragment) => sum + fragment.rects.length, 0);
}

function selectionRectEntries(position) {
  const entries = [];
  for (const fragment of positionFragments(position)) {
    for (const rect of fragment.rects || []) {
      entries.push({ pageIndex: Number(fragment.pageIndex || 0), rect });
    }
  }
  return entries;
}

function getViewportRect(viewport, rect, viewBox) {
  if (!rect) return null;
  if (typeof viewport?.convertToViewportPoint === "function") {
    try {
      const first = viewport.convertToViewportPoint(rect[0], rect[1]);
      const second = viewport.convertToViewportPoint(rect[2], rect[3]);
      const converted = [
        Math.min(Number(first[0]), Number(second[0])),
        Math.min(Number(first[1]), Number(second[1])),
        Math.max(Number(first[0]), Number(second[0])),
        Math.max(Number(first[1]), Number(second[1]))
      ];
      if (converted.every(Number.isFinite)) return converted;
    }
    catch (_) {}
  }
  if (!viewBox) return null;
  return [
    rect[0] - viewBox[0],
    viewBox[3] - rect[3],
    rect[2] - viewBox[0],
    viewBox[3] - rect[1]
  ];
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

var SelectionMatcher = {
  isSelectedChar(char, entriesByPage) {
    const entries = entriesByPage.get(Number(char.pageIndex || 0)) || [];
    const charArea = Math.max(1, rectangleArea(char.rect));
    const center = [
      (char.rect[0] + char.rect[2]) / 2,
      (char.rect[1] + char.rect[3]) / 2
    ];
    return entries.some(entry => pointInRect(center, entry.rect)
      || intersectionArea(char.rect, entry.rect) / charArea >= 0.18);
  },

  reconstructText(chars) {
    return normalizeComparableText([...chars]
      .sort((left, right) => Number(left.pageIndex || 0) - Number(right.pageIndex || 0)
        || Number(left.offset || 0) - Number(right.offset || 0))
      .map(char => `${char.c}${char.lineBreakAfter ? " " : ""}`).join(""));
  },

  makeLineGroups(chars) {
    const ordered = [...chars].sort((left, right) =>
      Number(left.pageIndex || 0) - Number(right.pageIndex || 0)
      || Number(left.offset || 0) - Number(right.offset || 0)
    );
    const pages = new Map();
    for (const char of ordered) {
      if (!pages.has(char.pageIndex)) pages.set(char.pageIndex, []);
      pages.get(char.pageIndex).push(char);
    }
    const groups = [];
    for (const [pageIndex, pageChars] of pages) {
      const lines = [];
      for (const char of pageChars) {
        const previous = lines.at(-1)?.chars.at(-1) || null;
        const previousHeight = previous ? Math.max(1, previous.rect[3] - previous.rect[1]) : 1;
        const charHeight = Math.max(1, char.rect[3] - char.rect[1]);
        const verticalOverlap = previous
          ? Math.max(0, Math.min(previous.rect[3], char.rect[3])
            - Math.max(previous.rect[1], char.rect[1]))
          / Math.max(1, Math.min(previousHeight, charHeight)) : 0;
        const baselineDistance = previous
          ? Math.abs(((previous.rect[1] + previous.rect[3]) / 2)
            - ((char.rect[1] + char.rect[3]) / 2)) : Infinity;
        const horizontalGap = previous ? Math.max(0, char.rect[0] - previous.rect[2]) : 0;
        const sameLine = previous && !previous.lineBreakAfter
          && (verticalOverlap >= 0.35 || baselineDistance <= Math.max(1.2, charHeight * 0.45))
          && horizontalGap <= Math.max(1, charHeight * 8);
        if (!sameLine) lines.push({ pageIndex, chars: [] });
        lines.at(-1).chars.push(char);
      }
      for (const line of lines) {
        const rect = boundingRect(line.chars.map(char => char.rect));
        if (!rect) continue;
        groups.push({
          pageIndex,
          rect,
          sourceCharCount: line.chars.filter(char => !/^\s+$/u.test(char.c)).length,
          charIDs: line.chars.map(char => char.id)
        });
      }
    }
    return groups;
  },

  sameVisualLine(char, rect) {
    if (!char?.rect || !rect) return false;
    const charHeight = Math.max(1, char.rect[3] - char.rect[1]);
    const lineHeight = Math.max(1, rect[3] - rect[1]);
    const verticalOverlap = Math.max(0, Math.min(char.rect[3], rect[3])
      - Math.max(char.rect[1], rect[1])) / Math.max(1, Math.min(charHeight, lineHeight));
    const baselineDistance = Math.abs(((char.rect[1] + char.rect[3]) / 2)
      - ((rect[1] + rect[3]) / 2));
    return verticalOverlap >= 0.35
      || baselineDistance <= Math.max(1.2, Math.min(charHeight, lineHeight) * 0.45);
  },

  splitVisualLineRuns(chars) {
    const ordered = [...(chars || [])].filter(char => char?.rect).sort((left, right) =>
      left.rect[0] - right.rect[0] || left.rect[2] - right.rect[2]
      || Number(left.offset || 0) - Number(right.offset || 0));
    if (!ordered.length) return [];
    const heights = ordered.map(char => Math.max(1, char.rect[3] - char.rect[1]))
      .sort((left, right) => left - right);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const maximumGap = Math.max(1, medianHeight * 3.2);
    const runs = [];
    for (const char of ordered) {
      const previous = runs.at(-1)?.at(-1) || null;
      const gap = previous ? char.rect[0] - previous.rect[2] : 0;
      if (!previous || previous.lineBreakAfter || gap > maximumGap) runs.push([]);
      runs.at(-1).push(char);
    }
    return runs;
  },

  buildPositionFromLineGroups(groups) {
    const valid = (groups || []).filter(group => group?.rect);
    if (!valid.length) return null;
    const byPage = new Map();
    for (const group of valid) {
      if (!byPage.has(group.pageIndex)) byPage.set(group.pageIndex, []);
      byPage.get(group.pageIndex).push(group);
    }
    const fragments = [...byPage.entries()].sort((left, right) => left[0] - right[0])
      .map(([pageIndex, pageGroups]) => ({
        pageIndex,
        rects: pageGroups.map(group => group.rect),
        sourceCharCount: pageGroups.reduce((sum, group) => sum
          + Number(group.sourceCharCount || 0), 0),
        lineCharCounts: pageGroups.map(group => Number(group.sourceCharCount || 0))
      }));
    return {
      pageIndex: fragments[0].pageIndex,
      rects: fragments[0].rects,
      fragments
    };
  },

  firstLineHasIndent(line, otherLines = []) {
    const orderedChars = [...(line?.chars || [])].filter(char => char?.rect).sort((left, right) =>
      left.rect[0] - right.rect[0] || Number(left.offset || 0) - Number(right.offset || 0));
    const firstTextIndex = orderedChars.findIndex(char => !/^\s+$/u.test(String(char.c || "")));
    if (firstTextIndex > 0 && orderedChars.slice(0, firstTextIndex)
      .some(char => /^\s+$/u.test(String(char.c || "")))) return true;
    const firstLeft = Number(line?.rect?.[0] || 0);
    const comparable = (otherLines || [])
      .filter(other => other?.rect && other.pageIndex === line.pageIndex && other !== line
        && !other.rect.every((value, index) => value === line.rect[index]))
      .map(other => ({
        overlap: Math.max(0, Math.min(line.rect[2], other.rect[2])
          - Math.max(line.rect[0], other.rect[0])),
        width: Math.max(1, Math.min(
          line.rect[2] - line.rect[0], other.rect[2] - other.rect[0]
        )),
        left: Number(other.rect[0] || 0),
        distance: Math.abs(Number(other.rect[0] || 0) - firstLeft)
      }))
      .filter(candidate => candidate.overlap / candidate.width >= 0.42)
      .sort((left, right) => left.distance - right.distance);
    const height = Math.max(1, Number(line?.rect?.[3] || 0) - Number(line?.rect?.[1] || 0));
    if (!comparable.length) return false;
    const baseline = Math.min(...comparable.map(candidate => candidate.left));
    return firstLeft - baseline >= Math.max(1.5, height * 0.55);
  },

  completeSelectionLines(selectedChars, allChars, sourceCharIDs = null) {
    const selected = (selectedChars || []).filter(char => char?.rect);
    const pageChars = (allChars || []).filter(char => char?.rect);
    const selectedIDs = new Set(selected.map(char => String(char.id)));
    const sourceIDs = sourceCharIDs ? new Set([...sourceCharIDs].map(String)) : null;
    const baseChars = sourceIDs
      ? pageChars.filter(char => sourceIDs.has(String(char.id)))
      : selected;
    const allBaseGroups = this.makeLineGroups(baseChars);
    const baseGroups = allBaseGroups
      .map((group, index) => ({ group, sourceLineIndex: index }))
      .filter(entry => entry.group.charIDs
        .some(id => selectedIDs.has(String(id))));
    const lines = [];
    for (const { group: baseGroup, sourceLineIndex } of baseGroups) {
      const sameRow = pageChars.filter(char => Number(char.pageIndex || 0)
        === Number(baseGroup.pageIndex || 0) && this.sameVisualLine(char, baseGroup.rect));
      const runs = this.splitVisualLineRuns(sameRow)
        .filter(run => run.some(char => selectedIDs.has(String(char.id))));
      for (const run of runs) {
        // Once a selected character identifies a visual line, keep every
        // character from that line, while keeping classified paragraphs
        // inside their own extracted paragraph boundary.
        const lineChars = sourceIDs
          ? run.filter(char => sourceIDs.has(String(char.id))
            || /^\s+$/u.test(String(char.c || "")))
          : run;
        const rect = boundingRect(lineChars.map(char => char.rect));
        if (!rect || !lineChars.some(char => !/^\s+$/u.test(String(char.c || "")))) continue;
        lines.push({
          pageIndex: Number(baseGroup.pageIndex || 0),
          rect,
          chars: lineChars,
          charIDs: lineChars.map(char => String(char.id)),
          sourceCharCount: lineChars.filter(char => !char.ignorable
            && !/^\s+$/u.test(String(char.c || ""))).length,
          sourceLineIndex,
          text: this.reconstructText(lineChars)
        });
      }
    }
    lines.sort((left, right) => left.pageIndex - right.pageIndex
      || left.rect[1] - right.rect[1] || left.rect[0] - right.rect[0]
      || left.sourceLineIndex - right.sourceLineIndex);
    const position = this.buildPositionFromLineGroups(lines);
    const firstLine = lines.find(line => line.sourceLineIndex === 0) || null;
    const comparisonLines = this.makeLineGroups(pageChars)
      .filter(group => group.pageIndex === firstLine?.pageIndex);
    const indentFirstBlock = Boolean(firstLine
      && this.firstLineHasIndent(firstLine, comparisonLines));
    return {
      lines,
      text: this.reconstructText(lines.flatMap(line => line.chars)),
      charIDs: [...new Set(lines.flatMap(line => line.charIDs)
        .filter(id => !/^\s+$/u.test(String((pageChars.find(char => String(char.id) === id)?.c) || ""))))],
      lineIDs: lines.map((line, index) => `${line.pageIndex}:selection-line:${index}`),
      position,
      indentFirstBlock
    };
  },

  makeUnclassifiedParagraphs(chars, startingOrder = 0, allChars = chars) {
    const lineGroups = this.makeLineGroups(chars);
    const paragraphs = [];
    let current = null;
    for (const group of lineGroups) {
      const groupChars = chars.filter(char => group.charIDs.includes(char.id));
      const previous = current?.groups?.at(-1) || null;
      const previousHeight = previous ? Math.max(1, previous.rect[3] - previous.rect[1]) : 1;
      const height = Math.max(1, group.rect[3] - group.rect[1]);
      const samePage = previous && previous.pageIndex === group.pageIndex;
      const verticalGap = previous ? Math.max(0, group.rect[1] - previous.rect[3]) : Infinity;
      const horizontalOverlap = previous ? Math.max(0,
        Math.min(previous.rect[2], group.rect[2]) - Math.max(previous.rect[0], group.rect[0])) : 0;
      const minimumWidth = previous ? Math.max(1,
        Math.min(previous.rect[2] - previous.rect[0], group.rect[2] - group.rect[0])) : 1;
      const continuous = samePage && verticalGap <= Math.max(previousHeight, height) * 1.6
        && horizontalOverlap / minimumWidth >= 0.25;
      if (!current || !continuous) {
        current = { groups: [], chars: [] };
        paragraphs.push(current);
      }
      current.groups.push(group);
      current.chars.push(...groupChars);
    }
    return paragraphs.map((paragraph, index) => {
      const selectedPosition = this.buildPosition(paragraph.chars);
      return {
        sourceIndex: null,
        sourceOrder: startingOrder + index,
        sourceText: this.reconstructText(paragraph.chars),
        selectedText: this.reconstructText(paragraph.chars),
        selectedCharIDs: paragraph.chars
          .filter(char => !char.ignorable && !/^\s+$/u.test(char.c)).map(char => char.id),
        selectedRectCount: countPositionRects(selectedPosition),
        selectedPosition,
        matchType: "unclassified",
        confidence: "low",
        ...(() => {
          const completed = this.completeSelectionLines(paragraph.chars, allChars);
          return {
            translationText: completed.text || this.reconstructText(paragraph.chars),
            translationCharIDs: completed.charIDs,
            translationLineIDs: completed.lineIDs,
            translationPosition: completed.position || selectedPosition,
            translationIndentFirstBlock: completed.indentFirstBlock
          };
        })()
      };
    }).filter(paragraph => paragraph.selectedPosition && paragraph.selectedCharIDs.length);
  },

  buildSelectionContext(position, pages) {
    const entriesByPage = new Map();
    for (const entry of selectionRectEntries(position)) {
      if (!entriesByPage.has(entry.pageIndex)) entriesByPage.set(entry.pageIndex, []);
      entriesByPage.get(entry.pageIndex).push(entry);
    }
    const selectedChars = (pages || []).flatMap(page => page.chars || [])
      .filter(char => char.rect && this.isSelectedChar(char, entriesByPage));
    const selectedCharIDs = selectedChars.map(char => String(char.id));
    const hints = [];
    for (const page of pages || []) {
      const pageChars = selectedChars.filter(char => Number(char.pageIndex || 0) === page.pageIndex);
      const groups = this.makeLineGroups(pageChars);
      if (groups.length < 6) continue;
      const lineRects = groups.map(group => {
        const ids = new Set(group.charIDs.map(String));
        const rect = boundingRect(pageChars.filter(char => ids.has(String(char.id)))
          .map(char => char.viewportRect).filter(Boolean));
        return rect ? { rect, pageIndex: page.pageIndex } : null;
      }).filter(Boolean);
      if (lineRects.length < 6) continue;
      const pageWidth = Math.max(1, Number(page.metric?.width || 0));
      const candidates = [];
      for (let bin = 64; bin <= 136; bin++) {
        const ratio = bin / 200;
        const x = pageWidth * ratio;
        const crossing = lineRects.filter(line => line.rect[0] < x && line.rect[2] > x).length;
        const left = lineRects.filter(line => line.rect[2] <= x);
        const right = lineRects.filter(line => line.rect[0] >= x);
        if (left.length < 2 || right.length < 2
          || crossing > 1 || crossing / lineRects.length > 0.15) continue;
        const overlapTop = Math.max(Math.min(...left.map(line => line.rect[1])),
          Math.min(...right.map(line => line.rect[1])));
        const overlapBottom = Math.min(Math.max(...left.map(line => line.rect[3])),
          Math.max(...right.map(line => line.rect[3])));
        if (overlapBottom <= overlapTop) continue;
        candidates.push({ ratio, left, right });
      }
      if (!candidates.length) continue;
      const longest = [];
      let current = [];
      for (const candidate of candidates) {
        if (current.length && candidate.ratio - current.at(-1).ratio > 0.006) {
          longest.push(current);
          current = [];
        }
        current.push(candidate);
      }
      if (current.length) longest.push(current);
      longest.sort((left, right) => right.length - left.length);
      const run = longest[0];
      if (!run || run.at(-1).ratio - run[0].ratio < 0.025) continue;
      const centerRatio = (run[0].ratio + run.at(-1).ratio) / 2;
      const heights = lineRects.map(line => line.rect[3] - line.rect[1]).sort((a, b) => a - b);
      const typicalHeight = Math.max(1, heights[Math.floor(heights.length / 2)] || 1);
      const gapWidth = (run.at(-1).ratio - run[0].ratio) * pageWidth;
      if (gapWidth < typicalHeight * 1.5) continue;
      hints.push({
        pageIndex: page.pageIndex,
        leftRatio: run[0].ratio,
        rightRatio: run.at(-1).ratio,
        centerRatio,
        top: Math.min(...lineRects.map(line => line.rect[1])),
        bottom: Math.max(...lineRects.map(line => line.rect[3])),
        lineCount: lineRects.length,
        confidence: "high"
      });
    }
    return {
      selectedCharIDs,
      selectedPageIndexes: [...new Set(selectedChars.map(char => Number(char.pageIndex || 0)))],
      selectedLineRects: this.makeLineGroups(selectedChars).map(group => ({
        pageIndex: group.pageIndex, rect: group.rect
      })),
      columnHints: hints
    };
  },

  buildPosition(chars) {
    const groups = this.makeLineGroups(chars);
    if (!groups.length) return null;
    const byPage = new Map();
    for (const group of groups) {
      if (!byPage.has(group.pageIndex)) byPage.set(group.pageIndex, []);
      byPage.get(group.pageIndex).push(group);
    }
    const fragments = [...byPage.entries()].sort((left, right) => left[0] - right[0])
      .map(([pageIndex, pageGroups]) => ({
        pageIndex,
        rects: pageGroups.map(group => group.rect),
        sourceCharCount: pageGroups.reduce((sum, group) => sum + group.sourceCharCount, 0),
        lineCharCounts: pageGroups.map(group => group.sourceCharCount)
      }));
    return {
      pageIndex: fragments[0].pageIndex,
      rects: fragments[0].rects,
      fragments
    };
  },

  analyze({ position, sourceText, pages, rawParagraphs }) {
    const entriesByPage = new Map();
    for (const entry of selectionRectEntries(position)) {
      if (!entriesByPage.has(entry.pageIndex)) entriesByPage.set(entry.pageIndex, []);
      entriesByPage.get(entry.pageIndex).push(entry);
    }
    const allChars = (pages || []).flatMap(page => page.chars || []);
    const selectedChars = allChars.filter(char => char.rect
      && this.isSelectedChar(char, entriesByPage));
    const selectedIDs = new Set(selectedChars
      .filter(char => !char.ignorable && !/^\s+$/u.test(char.c))
      .map(char => char.id));
    const selectedText = this.reconstructText(selectedChars);
    const expectedText = normalizeComparableText(sourceText);
    const exactTextMatch = Boolean(expectedText && selectedText && expectedText === selectedText);
    const looseTextMatch = Boolean(expectedText && selectedText
      && expectedText.replace(/\s+/gu, "") === selectedText.replace(/\s+/gu, ""));
    const paragraphCharIDs = new Set();
    const paragraphs = [];
    for (const paragraph of rawParagraphs || []) {
      const sourceCharIDs = new Set((paragraph.sourceCharIDs || []).map(String));
      const selectedParagraphChars = selectedChars.filter(char => sourceCharIDs.has(char.id));
      const selectedParagraphIDs = selectedParagraphChars
        .filter(char => !char.ignorable && !/^\s+$/u.test(char.c))
        .map(char => char.id);
      if (!selectedParagraphIDs.length) continue;
      for (const id of sourceCharIDs) paragraphCharIDs.add(id);
      const selectedPosition = this.buildPosition(selectedParagraphChars);
      if (!selectedPosition) continue;
      const completed = this.completeSelectionLines(
        selectedParagraphChars, allChars, sourceCharIDs
      );
      const full = selectedParagraphIDs.length >= sourceCharIDs.size;
      paragraphs.push({
        sourceIndex: Number(paragraph.sourceIndex || 0),
        sourceOrder: Number(paragraph.sourceOrder || paragraph.sourceIndex || 0),
        sourceText: String(paragraph.text || ""),
        selectedText: this.reconstructText(selectedParagraphChars),
        selectedCharIDs: selectedParagraphIDs,
        selectedRectCount: countPositionRects(selectedPosition),
        selectedPosition,
        matchType: full ? "full" : "partial",
        confidence: exactTextMatch || looseTextMatch ? "high" : "low",
        translationText: completed.text || this.reconstructText(selectedParagraphChars),
        translationCharIDs: completed.charIDs,
        translationLineIDs: completed.lineIDs,
        translationPosition: completed.position || selectedPosition,
        translationIndentFirstBlock: completed.indentFirstBlock
      });
    }
    paragraphs.sort((left, right) => left.sourceOrder - right.sourceOrder);
    const unclassifiedChars = selectedChars.filter(char => selectedIDs.has(char.id)
      && !paragraphCharIDs.has(char.id));
    const unclassifiedParagraphs = this.makeUnclassifiedParagraphs(unclassifiedChars,
      paragraphs.length ? Math.max(...paragraphs.map(paragraph => paragraph.sourceOrder)) + 1 : 0,
      allChars);
    paragraphs.push(...unclassifiedParagraphs);
    paragraphs.sort((left, right) => left.sourceOrder - right.sourceOrder);
    const unclassifiedCharCount = unclassifiedChars.length;
    const classifiedCharCount = selectedIDs.size - unclassifiedCharCount;
    const confidence = !selectedIDs.size || !paragraphs.length
      ? "low"
      : (!exactTextMatch && !looseTextMatch) ? "low"
        : unclassifiedCharCount ? "medium" : "high";
    return {
      paragraphs,
      selectedCharCount: selectedIDs.size,
      selectedText,
      diagnostics: {
        rawRectCount: countPositionRects(position),
        paragraphCount: paragraphs.length,
        fullParagraphCount: paragraphs.filter(paragraph => paragraph.matchType === "full").length,
        partialParagraphCount: paragraphs.filter(paragraph => paragraph.matchType === "partial").length,
        unclassifiedGroupCount: unclassifiedParagraphs.length,
        classifiedCharCount,
        confidence,
        exactTextMatch,
        looseTextMatch,
        unclassifiedCharCount
      }
    };
  }
};

var ReaderPageDataLoader = {
  getPageCount(view) {
    const application = view?._iframeWindow?.PDFViewerApplication;
    return Math.max(
      Number(application?.pdfDocument?.numPages || 0),
      Number(application?.pdfViewer?._pages?.length || 0)
    );
  },

  getSelectionPageIndexes(position, pageCount) {
    const indexes = selectionRectEntries(position).map(entry => entry.pageIndex)
      .filter(index => index >= 0 && index < pageCount);
    if (!indexes.length) return [];
    const first = Math.max(0, Math.min(...indexes) - 1);
    const last = Math.min(pageCount - 1, Math.max(...indexes) + 1);
    return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  },

  async loadPage(view, pageIndex) {
    const application = view?._iframeWindow?.PDFViewerApplication;
    const pdfDocument = application?.pdfDocument;
    if (typeof pdfDocument?.getPageData !== "function") {
      throw new Error("当前 Zotero Reader 不提供 getPageData 字符接口");
    }
    let request = { pageIndex };
    try { request = Components.utils.cloneInto(request, view._iframeWindow); }
    catch (_) {}
    const foreignPage = await pdfDocument.getPageData(request);
    if (!foreignPage?.chars) throw new Error(`第 ${pageIndex + 1} 页没有字符数据`);
    const pageView = application?.pdfViewer?._pages?.[pageIndex];
    const viewport = pageView?.viewport || null;
    const viewBox = copyViewBox(foreignPage.viewBox) || copyViewBox(viewport?.viewBox);
    const metric = {
      pageIndex,
      width: Number(viewport?.width || (viewBox ? viewBox[2] - viewBox[0] : 0)),
      height: Number(viewport?.height || (viewBox ? viewBox[3] - viewBox[1] : 0)),
      rotation: Number(viewport?.rotation || 0),
      viewBox
    };
    const chars = [];
    for (let offset = 0; offset < foreignPage.chars.length; offset++) {
      const foreign = foreignPage.chars[offset];
      if (!foreign) continue;
      const rect = copyRects([foreign.inlineRect || foreign.rect])[0] || null;
      if (!rect) continue;
      chars.push({
        id: `${pageIndex}:char:${offset}`,
        offset,
        pageIndex,
        c: String(foreign.c || ""),
        rect,
        viewportRect: getViewportRect(viewport, rect, viewBox),
        lineBreakAfter: !!foreign.lineBreakAfter,
        paragraphBreakAfter: !!foreign.paragraphBreakAfter,
        spaceAfter: !!foreign.spaceAfter,
        ignorable: !!foreign.ignorable,
        rotation: Number(foreign.rotation || 0)
      });
    }
    return { pageIndex, chars, viewBox, metric };
  },

  async load(view, position) {
    const pageCount = this.getPageCount(view);
    const pageIndexes = this.getSelectionPageIndexes(position, pageCount);
    if (!pageIndexes.length) throw new Error("选区没有有效页码");
    return this.loadIndexes(view, pageIndexes);
  },

  async loadIndexes(view, pageIndexes, cache = new Map()) {
    const pages = [];
    for (const pageIndex of [...new Set(pageIndexes)].sort((left, right) => left - right)) {
      if (!cache.has(pageIndex)) cache.set(pageIndex, await this.loadPage(view, pageIndex));
      pages.push(cache.get(pageIndex));
    }
    return pages;
  }
};

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
    position = SelectionMatcher.buildPosition(chars);
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
    const pageCount = ReaderPageDataLoader.getPageCount(view);
    if (!pageCount) throw new Error("PDF 页面尚未完成初始化");
    const pages = await ReaderPageDataLoader.loadIndexes(view, [FRONT_MATTER_PAGE_INDEX], new Map());
    let frontMatter;
    try {
      frontMatter = ReaderPageDataBodyExtractor.extractFrontMatter({ pages });
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

function makeFallbackMatch(position) {
  return {
    paragraphs: [{
      sourceIndex: null,
      sourceOrder: 0,
      sourceText: "",
      selectedCharIDs: [],
      selectedRectCount: countPositionRects(position),
      selectedPosition: position,
      matchType: "unknown",
      confidence: "low"
    }],
    diagnostics: {
      rawRectCount: countPositionRects(position),
      paragraphCount: null,
      fullParagraphCount: 0,
      partialParagraphCount: 0,
      confidence: "low"
    },
    fallback: true
  };
}

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
          SelectionReplacerTest.toolbarStatus?.delete(state.reader);
          return;
        }
        this.schedule(state, 0);
      }, 1200);
    }
    state.view = view || state.view;
    const mode = options.mode || "replacement";
    const recordID = String(options.recordID ||
      (mode === "diagnostic" ? "front-matter" : mode === "selection-translation"
        ? `selection-${state.nextSequence + 1}` : "replacement"));
    const previous = state.records.get(recordID);
    state.records.set(recordID, {
      recordID,
      mode,
      data,
      match: data?.paragraphs ? data : null,
      targets: Array.isArray(data) ? data : [],
      segments: options.segments || [],
      translations: options.translations || new Map(),
      translationPending: Boolean(options.translationPending),
      replacement: String(options.replacement || ""),
      sequence: previous?.sequence ?? state.nextSequence++
    });
    this.schedule(state, 0);
    return state;
  },

  removeRecord(reader, recordID) {
    const state = this.states.get(reader);
    if (!state || !recordID) return false;
    const removed = state.records.delete(String(recordID));
    if (removed) this.schedule(state, 0);
    return removed;
  },

  bindEvents(state) {
    const win = state.view?._iframeWindow;
    const eventBus = win?.PDFViewerApplication?.eventBus;
    if (!eventBus || !win) return;
    const requestLayout = () => this.schedule(state, 40);
    let exported = requestLayout;
    try { exported = Components.utils.exportFunction(requestLayout, win); }
    catch (_) {}
    for (const eventName of [
      "pagerendered", "scalechanging", "rotationchanging",
      "pagesloaded", "updateviewarea"
    ]) {
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
    const eventBus = state.view?._iframeWindow?.PDFViewerApplication?.eventBus;
    for (const [eventName, handler] of state.eventHandlers) {
      try { eventBus?.off?.(eventName, handler); }
      catch (_) {}
    }
    for (const layer of state.overlayLayers.values()) layer.remove?.();
    state.overlayLayers.clear();
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
    clearTimeout(state.settleTimer);
    state.renderTimer = setTimeout(() => this.render(state), delay);
    state.settleTimer = setTimeout(() => this.render(state), delay + 180);
  },

  getPage(state, pageIndex) {
    return state.view?._iframeWindow?.PDFViewerApplication
      ?.pdfViewer?._pages?.[pageIndex] || null;
  },

  ensureLayer(state, pageIndex) {
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

  convertRect(state, rect, pageIndex) {
    const page = this.getPage(state, pageIndex);
    const win = state.view?._iframeWindow;
    if (!page?.div || !win || typeof state.view?.getClientRect !== "function") return null;
    let foreignRect = rect;
    try { foreignRect = Components.utils.cloneInto(rect, win); }
    catch (_) {}
    let client;
    try { client = state.view.getClientRect(foreignRect, pageIndex); }
    catch (error) {
      Zotero.logError?.(error);
      return null;
    }
    const pageRect = page.div.getBoundingClientRect();
    const converted = [
      Number(client?.[0]) - Number(pageRect.left),
      Number(client?.[1]) - Number(pageRect.top),
      Number(client?.[2]) - Number(pageRect.left),
      Number(client?.[3]) - Number(pageRect.top)
    ];
    return converted.every(Number.isFinite) && converted[2] > converted[0] && converted[3] > converted[1]
      ? converted : null;
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

  render(state) {
    if (state.cancelled || !state.view) return;
    for (const layer of state.overlayLayers.values()) layer.replaceChildren();
    for (const record of [...state.records.values()].sort((left, right) =>
      left.sequence - right.sequence)) {
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
            if (rect) {
              parts.push({
                pageIndex: Number(fragment.pageIndex || 0),
                rect,
                sourceCharCount: Number(lineCounts[index] || 0)
              });
            }
          }
        }
        if (!parts.length) return;
        const chunks = splitReplacement(record.replacement, parts);
        parts.forEach((part, partIndex) => {
          this.renderPart(state, part, chunks[partIndex] || "", paragraph, paragraphIndex,
            partIndex, displayIndex);
        });
      });
    }
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
          state, part, target, targetIndex, partIndex, translatedText, translation));
        record.targetLayoutResults ||= new Map();
        record.targetLayoutResults.set(target.kind, results);
        if (results.length) continue;
      }
      parts.forEach((part, partIndex) => this.renderTargetPart(state, part, target,
        targetIndex, partIndex));
    }
  },

  renderSelectionTranslations(state, record) {
    const paragraphs = record.match?.paragraphs || [];
    const displayCounts = { paragraph: 0, unclassified: 0 };
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const unclassified = paragraph.matchType === "unclassified";
      const displayKind = unclassified ? "unclassified" : "paragraph";
      const displayIndex = displayCounts[displayKind]++;
      const segment = (record.segments || []).find(value =>
        Number(value?.metadata?.selectionParagraphIndex) === paragraphIndex) || null;
      const translation = segment ? record.translations?.get?.(segment.id) : null;
      const parts = [];
      const position = segment?.position || paragraph.translationPosition
        || paragraph.selectedPosition;
      for (const fragment of positionFragments(position)) {
        const lineCounts = fragment.lineCharCounts || [];
        for (let index = 0; index < (fragment.rects || []).length; index++) {
          const rect = this.convertRect(state, fragment.rects[index], fragment.pageIndex);
          if (rect) {
            parts.push({
              pageIndex: Number(fragment.pageIndex || 0),
              rect,
              sourceCharCount: Number(lineCounts[index] || 0)
            });
          }
        }
      }
      const merged = this.mergeSelectionParts(parts);
      if (!merged.length) return;
      const translatedText = ["cached", "translated"].includes(translation?.status)
        ? String(translation.translatedText || "") : "";
      const chunks = translatedText
        ? this.splitSelectionTranslation(translatedText, merged)
        : merged.map(() => "");
      const results = merged.map((part, partIndex) => this.renderTranslatedSelectionTarget(
        state, part, paragraph, segment, paragraphIndex, partIndex, displayIndex,
        translation, chunks[partIndex] || "", record));
      record.selectionLayoutResults ||= new Map();
      if (segment) record.selectionLayoutResults.set(segment.id, results);
    });
  },

  clusterSelectionSequence(parts, pageIndex, columnIndex = null) {
    const ordered = [...(parts || [])].sort((left, right) =>
      left.rect[1] - right.rect[1] || left.rect[0] - right.rect[0]
      || Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0));
    if (!ordered.length) return [];
    const heights = ordered.map(part => Math.max(1, part.rect[3] - part.rect[1]))
      .sort((left, right) => left - right);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const groups = [];
    for (const part of ordered) {
      const rect = part.rect;
      const width = Math.max(1, rect[2] - rect[0]);
      const previous = groups.at(-1);
      const overlap = previous
        ? Math.max(0, Math.min(previous.right, rect[2]) - Math.max(previous.left, rect[0])) : 0;
      const overlapRatio = previous
        ? overlap / Math.max(1, Math.min(previous.width, width)) : 0;
      const verticalGap = previous ? rect[1] - previous.bottom : 0;
      const contiguous = previous && overlapRatio >= 0.42
        && verticalGap <= medianHeight * 2.2 && verticalGap >= -medianHeight;
      let group = previous;
      if (!contiguous) {
        group = {
          pageIndex,
          columnIndex,
          parts: [],
          sourceRects: [],
          sourceCharCount: 0,
          left: rect[0], top: rect[1], right: rect[2], bottom: rect[3], width
        };
        groups.push(group);
      }
      group.parts.push(part);
      group.sourceRects.push(rect);
      group.sourceCharCount += Math.max(0, Number(part.sourceCharCount || 0));
      group.left = Math.min(group.left, rect[0]);
      group.top = Math.min(group.top, rect[1]);
      group.right = Math.max(group.right, rect[2]);
      group.bottom = Math.max(group.bottom, rect[3]);
      group.width = group.right - group.left;
    }
    return groups.map(group => ({
      pageIndex: group.pageIndex,
      columnIndex: group.columnIndex,
      rect: [group.left, group.top, group.right, group.bottom],
      sourceRects: group.sourceRects,
      sourceCharCount: group.sourceCharCount,
      sourceParts: group.parts,
      sourceIndex: Math.min(...group.parts.map(part => Number(part.sourceIndex ?? 0)))
    }));
  },

  selectionColumnBoundary(parts) {
    const ordered = (parts || []).filter(part => part?.rect);
    if (ordered.length < 4) return null;
    const heights = ordered.map(part => Math.max(1, part.rect[3] - part.rect[1]))
      .sort((left, right) => left - right);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const widths = ordered.map(part => Math.max(1, part.rect[2] - part.rect[0]))
      .sort((left, right) => left - right);
    const medianWidth = widths[Math.floor(widths.length / 2)] || medianHeight * 10;
    const candidates = ordered
      .filter(part => part.rect[2] - part.rect[0] <= medianWidth * 1.8)
      .sort((left, right) => ((left.rect[0] + left.rect[2]) / 2)
        - ((right.rect[0] + right.rect[2]) / 2));
    if (candidates.length < 4) return null;
    let best = null;
    for (let index = 1; index < candidates.length; index++) {
      const left = candidates[index - 1];
      const right = candidates[index];
      const gap = right.rect[0] - left.rect[2];
      if (gap < medianHeight * 1.5) continue;
      const leftParts = candidates.slice(0, index);
      const rightParts = candidates.slice(index);
      if (leftParts.length < 2 || rightParts.length < 2) continue;
      const overlapTop = Math.max(Math.min(...leftParts.map(part => part.rect[1])),
        Math.min(...rightParts.map(part => part.rect[1])));
      const overlapBottom = Math.min(Math.max(...leftParts.map(part => part.rect[3])),
        Math.max(...rightParts.map(part => part.rect[3])));
      if (overlapBottom <= overlapTop) continue;
      if (!best || gap > best.gap) {
        best = { boundary: (left.rect[2] + right.rect[0]) / 2, gap };
      }
    }
    return best?.boundary ?? null;
  },

  mergeSelectionParts(parts) {
    const byPage = new Map();
    for (const [sourceIndex, part] of (parts || []).entries()) {
      if (!part?.rect) continue;
      if (!byPage.has(part.pageIndex)) byPage.set(part.pageIndex, []);
      byPage.get(part.pageIndex).push({ ...part, sourceIndex });
    }
    const merged = [];
    for (const [pageIndex, pageParts] of [...byPage.entries()]
      .sort((left, right) => left[0] - right[0])) {
      const boundary = this.selectionColumnBoundary(pageParts);
      if (boundary === null) {
        merged.push(...this.clusterSelectionSequence(pageParts, pageIndex));
        continue;
      }
      const columns = [[], [], []];
      for (const part of pageParts) {
        const crossesGutter = part.rect[0] < boundary && part.rect[2] > boundary;
        const columnIndex = crossesGutter ? 2 : part.rect[2] <= boundary ? 0 : 1;
        columns[columnIndex].push(part);
      }
      // Keep source order inside a column, but emit left and right columns as
      // separate flows so a two-column paragraph cannot become one page-wide box.
      merged.push(...this.clusterSelectionSequence(columns[0], pageIndex, 0));
      merged.push(...this.clusterSelectionSequence(columns[1], pageIndex, 1));
      merged.push(...this.clusterSelectionSequence(columns[2], pageIndex, -1));
    }
    return merged.sort((left, right) => left.pageIndex - right.pageIndex
      || left.sourceIndex - right.sourceIndex
      || left.rect[1] - right.rect[1]
      || Number(left.columnIndex ?? 0) - Number(right.columnIndex ?? 0));
  },

  splitSelectionTranslation(text, parts) {
    const chars = [...String(text || "")];
    if (!parts.length) return [];
    if (!chars.length) return parts.map(() => "");
    if (parts.length === 1) return [chars.join("")];
    const weights = parts.map(part => Math.max(1,
      Number(part.sourceCharCount || 0)
        || (part.sourceRects || []).length));
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
      const target = Math.max(offset + 1, Math.min(chars.length - 1,
        Math.round(chars.length * cumulative / totalWeight)));
      const from = Math.max(offset + 1, target - 24);
      const to = Math.min(chars.length - 1, target + 24);
      let splitAt = target;
      for (let cursor = from; cursor < chars.length - 1 && cursor <= to; cursor++) {
        if (/[。！？；，.!?;,:]/u.test(chars[cursor])
          && Math.abs(cursor - target) < Math.abs(splitAt - target)) {
          splitAt = cursor + 1;
        }
      }
      chunks.push(chars.slice(offset, splitAt).join(""));
      offset = splitAt;
    }
    while (chunks.length < parts.length) chunks.push("");
    return chunks;
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
    indentFirstBlock = false }) {
    const heights = (sourceRects || []).map(rect => Math.max(1, rect[3] - rect[1]))
      .sort((left, right) => left - right);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const minimum = Math.max(5, Math.min(14, medianHeight * 0.42));
    const maximum = Math.max(minimum, Math.min(28, medianHeight * 1.08));
    const availableHeight = Math.max(1, containerHeight - 6);
    const text = String(translatedText || "");
    node.textContent = indentFirstBlock && text
      ? `${PARAGRAPH_TRANSLATION_INDENT}${text}` : text;
    this.style(node, {
      position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
      boxSizing: "border-box", padding: "3px 4px", margin: "0", overflow: "hidden",
      whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "normal",
      letterSpacing: "normal", display: "block", textAlign: "left"
    });
    const measure = (fontSize, lineHeight) => this.measureTextLayout({
      node, containerWidth, containerHeight, fontSize, lineHeight, mode: "block"
    });
    const failure = (reason, fontSize = 0, lineHeight = 0) => ({
      rendered: false, layoutMode: "diagnostic", fontSize, lineHeight,
      renderedLineCount: 0, verticalUsage: 0, sourceRectCount: heights.length,
      mergedRectCount: 1, failureReason: reason
    });
    if (!(node?.isConnected !== false) || !(containerWidth > 1) || !(containerHeight > 1)) {
      return failure("container-unavailable");
    }
    const minimumMeasure = measure(minimum, 1.10);
    if (!minimumMeasure.fits) {
      return { ...failure("minimum-font-overflow", minimum, 1.10), ...minimumMeasure };
    }
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
      : renderedLineCount === 2 ? 1.55 : 1.90;
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
      rendered: true, layoutMode: "selection-fit",
      fontSize: Number(fontSize.toFixed(2)), lineHeight: Number(lineLow.toFixed(3)),
      visualLineCount, renderedLineCount,
      verticalUsage: Number(verticalUsage.toFixed(3)), ...compact, ...finalMeasure,
      sourceRectCount: heights.length, mergedRectCount: 1, failureReason: ""
    };
  },

  renderTranslatedTarget(state, part, target, targetIndex, partIndex, translatedText,
    translation = null) {
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
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-auto-part merged-translation";
    root.dataset.targetKind = target.kind;
    root.dataset.targetIndex = String(targetIndex);
    root.dataset.partIndex = String(partIndex);
    root.dataset.translationStatus = String(translation?.status || "missing");
    root.dataset.translationError = String(translation?.errorCode || "");
    this.style(root, {
      position: "absolute", boxSizing: "border-box", left: `${Math.max(0, left)}px`,
      top: `${Math.max(0, top)}px`, width: `${width}px`, height: `${height}px`,
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
    let fitted;
    if (!translatedText) {
      fitted = this.renderTranslationStatus(textNode, target.kind,
        target.kind === "title" ? "标题翻译失败" : "摘要翻译失败",
        translation?.errorCode || "missing-translation");
    }
    else if (target.kind === "title") {
      fitted = this.fitTitleText({ node: textNode, containerWidth: width,
        containerHeight: height, sourceRects: part.sourceRects, translatedText });
      if (!fitted.rendered) {
        const layoutFailure = fitted;
        const status = this.renderTranslationStatus(textNode, target.kind,
          "标题无法排版", layoutFailure.failureReason);
        fitted = { ...status, ...layoutFailure, rendered: true,
          layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
      }
    }
    else if (target.kind === "abstract") {
      fitted = this.fitAbstractText({ node: textNode, containerWidth: width,
        containerHeight: height, sourceRects: part.sourceRects, translatedText,
        indentFirstBlock: partIndex === 0 });
      if (!fitted.rendered) {
        const layoutFailure = fitted;
        const status = this.renderTranslationStatus(textNode, target.kind,
          "摘要无法排版", layoutFailure.failureReason);
        fitted = { ...status, ...layoutFailure, rendered: true,
          layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
      }
    }
    else fitted = this.renderTranslationStatus(textNode, target.kind,
      "译文无法排版", "unsupported-target-kind");
    const displayStatus = translatedText && !String(fitted.layoutMode || "").endsWith("-status")
      ? "success" : "failure";
    const decoration = this.translationDecoration(target.kind, displayStatus);
    root.style.border = decoration.border;
    root.dataset.translationDisplayStatus = displayStatus;
    if (decoration.showBadge) {
      const badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-auto-badge";
      badge.textContent = decoration.badgeText;
      this.style(badge, { position: "absolute", left: "0", top: "0", zIndex: "3",
        padding: "0 3px", color: "#ffffff", background: accent,
        font: "10px/14px sans-serif", whiteSpace: "nowrap", pointerEvents: "none" });
      root.append(badge);
    }
    return { ...fitted, node: root };
  },

  renderTranslatedSelectionTarget(state, part, paragraph, segment, paragraphIndex,
    partIndex, displayIndex, translation = null, translatedChunk = "", record = null) {
    const layer = this.ensureLayer(state, part.pageIndex);
    if (!layer) return { rendered: false, layoutMode: "diagnostic", fontSize: 0,
      lineHeight: 0, sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
      failureReason: "page-layer-unavailable", node: null };
    const doc = layer.ownerDocument;
    const [left, top, right, bottom] = part.rect;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const unclassified = paragraph.matchType === "unclassified";
    const accent = unclassified ? "#f59e0b"
      : PARAGRAPH_MARK_COLORS[paragraphIndex % PARAGRAPH_MARK_COLORS.length];
    const label = `${unclassified ? "U" : "P"}${displayIndex + 1}`;
    const colors = this.pageColors(state, part.pageIndex);
    const translationSucceeded = ["cached", "translated"].includes(translation?.status);
    const translatedText = translationSucceeded ? String(translatedChunk || "") : "";
    const root = doc.createElement("div");
    root.className = "reader-selection-replacer-test-part merged-translation";
    root.dataset.paragraphIndex = String(paragraphIndex);
    root.dataset.partIndex = String(partIndex);
    root.dataset.segmentID = String(segment?.id || "");
    root.dataset.translationStatus = String(translation?.status
      || (record?.translationPending ? "pending" : "missing"));
    root.dataset.translationError = String(translation?.errorCode || "");
    root.title = `选区段落 ${label}：${String(paragraph.selectedText || paragraph.sourceText || "")
      .replace(/\s+/gu, " ").trim().slice(0, 240)}`;
    this.style(root, {
      position: "absolute", boxSizing: "border-box",
      left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`,
      width: `${width}px`, height: `${height}px`, overflow: "hidden",
      border: `1px solid ${accent}`, background: colors.background,
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
    let fitted;
    if (record?.translationPending && !translation) {
      fitted = this.renderTranslationStatus(textNode, "selection", "正在翻译…", "pending");
    }
    else if (!translationSucceeded) {
      const message = translation?.status === "skipped" ? "段落未翻译" : "段落翻译失败";
      fitted = this.renderTranslationStatus(textNode, "selection", message,
        translation?.errorCode || "missing-translation");
    }
    else if (!translatedText) {
      textNode.textContent = "";
      fitted = { rendered: true, layoutMode: "selection-empty", lines: [], fontSize: 0,
        lineHeight: 0, sourceRectCount: part.sourceRects.length, mergedRectCount: 1,
        failureReason: "" };
    }
    else {
      fitted = this.fitSelectionText({ node: textNode, containerWidth: width,
        containerHeight: height, sourceRects: part.sourceRects, translatedText,
        indentFirstBlock: partIndex === 0
          && Boolean(paragraph.translationIndentFirstBlock
            || segment?.metadata?.translationIndentFirstBlock) });
      if (!fitted.rendered) {
        const layoutFailure = fitted;
        const status = this.renderTranslationStatus(textNode, "selection",
          "段落无法排版", layoutFailure.failureReason);
        fitted = { ...status, ...layoutFailure, rendered: true,
          layoutMode: status.layoutMode, failureReason: layoutFailure.failureReason };
      }
    }
    if (partIndex === 0) {
      const badge = doc.createElement("span");
      badge.className = "reader-selection-replacer-test-paragraph-badge";
      badge.textContent = label;
      this.style(badge, {
        position: "absolute", left: "0", top: "0", zIndex: "3", padding: "0 2px",
        color: "#ffffff", background: accent, font: "9px/12px sans-serif",
        whiteSpace: "nowrap", pointerEvents: "none"
      });
      root.append(badge);
    }
    return { ...fitted, node: root };
  },

  translationDecoration(kind, status) {
    if (kind === "title") {
      return { border: "none", showBadge: false, badgeText: "" };
    }
    if (kind === "abstract" && status === "success") {
      return { border: "none", showBadge: false, badgeText: "" };
    }
    if (kind === "abstract") {
      return { border: "1px dashed #f97316", showBadge: true, badgeText: "摘要状态" };
    }
    return { border: "2px solid #2563eb", showBadge: true, badgeText: "标题译文" };
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
      left: `${Math.max(0, left)}px`,
      top: `${Math.max(0, top)}px`,
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
      left: `${Math.max(0, left)}px`,
      top: `${Math.max(0, top)}px`,
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
  },

  style(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  }
};

var SelectionReplacerTest = {
  toolbarStatus: new Map(),
  autoSessions: new Map(),
  selectionSessions: new Map(),
  selectionTaskCounter: 0,
  startingReaders: new Set(),

  async init(rootURI) {
    if (typeof ReaderPageDataBodyExtractor === "undefined") {
      Services.scriptloader.loadSubScript(
        `${rootURI}page-data-body-extractor.js`,
        globalThis,
        "UTF-8"
      );
    }
    for (const script of ["content-segments.js", "translation-service.js"]) {
      Services.scriptloader.loadSubScript(`${rootURI}${script}`, globalThis, "UTF-8");
    }
    SegmentTranslationCache.init();
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this.onRenderTextSelectionPopup.bind(this),
      PLUGIN_ID
    );
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.onRenderToolbar.bind(this),
      PLUGIN_ID
    );
    Promise.resolve().then(() => {
      for (const reader of Zotero.Reader?._readers || []) this.autoMarkReader(reader);
    }).catch(error => Zotero.logError?.(error));
    (Zotero.uiReadyPromise || Promise.resolve())
      .then(() => this.promptForAPIKeyOnce()).catch(error => Zotero.logError?.(error));
    Zotero.debug?.(`[${PLUGIN_ID}] started v${PLUGIN_VERSION}`);
  },

  shutdown() {
    Zotero.Reader._unregisterEventListenerByPluginID?.(PLUGIN_ID);
    for (const reader of SelectionReplacerOverlay.states.keys()) {
      SelectionReplacerOverlay.remove(reader);
    }
    this.autoSessions.clear();
    for (const session of this.selectionSessions.values()) session.cancelled = true;
    this.selectionSessions.clear();
    this.startingReaders.clear();
    this.toolbarStatus.clear();
    SegmentTranslationCache.close().catch(error => Zotero.logError?.(error));
    Zotero.debug?.(`[${PLUGIN_ID}] stopped`);
  },

  setToolbarStatus(reader, text) {
    const status = this.toolbarStatus.get(reader);
    if (status?.isConnected !== false) {
      if (status) status.textContent = text;
    }
  },

  async promptForAPIKeyOnce(force = false) {
    const existing = await DeepSeekCredentials.getKey();
    if (existing && !force) return true;
    if (!force && Services.prefs.getBoolPref(API_KEY_PROMPTED_PREF, false)) return false;
    Services.prefs.setBoolPref(API_KEY_PROMPTED_PREF, true);
    const input = { value: "" };
    const accepted = Services.prompt.promptPassword(
      Zotero.getMainWindow?.(),
      existing ? "更换 DeepSeek API Key" : "配置 DeepSeek API Key",
       "论文标题、摘要和用户主动划选的段落会发送到 DeepSeek，并可能产生 API 费用。密钥仅保存在 Zotero 本机登录管理器中。",
      input, null, {}
    );
    if (!accepted) return false;
    try {
      await DeepSeekCredentials.validateKey(input.value);
      await DeepSeekCredentials.saveKey(input.value);
      input.value = "";
      for (const reader of Zotero.Reader?._readers || []) this.autoMarkReader(reader, true);
      return true;
    }
    catch (error) {
      input.value = "";
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline("DeepSeek 配置失败");
      progress.addDescription(String(error?.message || error));
      progress.show();
      progress.startCloseTimer(8000);
      return false;
    }
  },

  async waitForPDFView(reader) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const view = reader?._internalReader?._primaryView || null;
      const pdfDocument = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (view && typeof view.getClientRect === "function"
        && typeof pdfDocument?.getPageData === "function") return view;
      const delay = Zotero.Promise?.delay
        ? Zotero.Promise.delay(50)
        : new Promise(resolve => setTimeout(resolve, 50));
      await delay;
    }
    throw new Error("等待 Zotero PDF Reader 初始化超时");
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

  onRenderToolbar({ reader, doc, append }) {
    if (!reader || !doc || typeof append !== "function") return;
    let button = doc.getElementById(TOOLBAR_BUTTON_ID);
    if (!button) {
      button = doc.createElement("button");
      button.id = TOOLBAR_BUTTON_ID;
      button.type = "button";
      button.className = "toolbar-button wide-button";
      button.textContent = "重译标题/摘要";
      button.title = "重新读取 Zotero 元数据并翻译 PDF 标题和摘要";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.autoMarkReader(reader, true, button));
      append(button);
    }
    const keyButtonID = `${TOOLBAR_BUTTON_ID}-key`;
    if (!doc.getElementById(keyButtonID)) {
      const keyButton = doc.createElement("button");
      keyButton.id = keyButtonID;
      keyButton.type = "button";
      keyButton.className = "toolbar-button";
      keyButton.textContent = "DeepSeek Key";
      keyButton.title = "配置或更换 DeepSeek API Key";
      keyButton.addEventListener("click", () => this.promptForAPIKeyOnce(true));
      append(keyButton);
    }
    let status = doc.getElementById(TOOLBAR_STATUS_ID);
    if (!status) {
      status = doc.createElement("span");
      status.id = TOOLBAR_STATUS_ID;
      status.style.fontSize = "11px";
      status.style.opacity = "0.78";
      status.style.marginInlineStart = "6px";
      append(status);
    }
    this.toolbarStatus.set(reader, status);
    if (!this.autoSessions.has(reader) && !this.startingReaders.has(reader)) {
      Promise.resolve().then(() => this.autoMarkReader(reader, false, button))
        .catch(error => Zotero.logError?.(error));
    }
  },

  async autoMarkReader(reader, force = false, button = null) {
    if (!reader) return null;
    if (!force && (this.autoSessions.has(reader) || this.startingReaders.has(reader))) {
      return this.autoSessions.get(reader) || null;
    }
    if (this.startingReaders.has(reader)) return null;
    if (force) {
      const previous = this.autoSessions.get(reader);
      if (previous) previous.cancelled = true;
      this.autoSessions.delete(reader);
      SelectionReplacerOverlay.removeRecord(reader, "front-matter");
    }
    this.startingReaders.add(reader);
    if (button) button.disabled = true;
    this.setToolbarStatus(reader, "正在识别标题/摘要…");
    try {
      const view = await this.waitForPDFView(reader);
      const metadata = await ReaderMetadataLoader.read(reader);
      const result = await ReaderTargetLocator.locate(view, metadata);
      const segments = ContentSegments.fromTargets(result.targets);
      const attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
      const session = { reader, view, result, segments, attachment, cancelled: false };
      this.autoSessions.set(reader, session);
      if (result.targets.length) {
        SelectionReplacerOverlay.attach(reader, view, result.targets,
          { mode: "diagnostic", recordID: "front-matter", segments,
            translations: new Map() });
      }
      this.setToolbarStatus(reader, this.formatAutoStatusV2(result));
      const translation = await TranslationCoordinator.translateSegments({
        attachment, segments, session, bypassCache: force
      });
      session.translation = translation;
      if (!session.cancelled && result.targets.length) {
        SelectionReplacerOverlay.attach(reader, view, result.targets, {
          mode: "diagnostic", recordID: "front-matter", segments,
          translations: translation.results
        });
      }
      const translated = translation.diagnostics.translated + translation.diagnostics.cached;
      this.setToolbarStatus(reader,
        `${this.formatAutoStatusV2(result)} | 译文 ${translated}/${segments.length}`);
      Zotero.debug?.(`[${PLUGIN_ID}] automatic front matter analysis: ${JSON.stringify({
        itemID: reader.itemID,
        metadataSource: metadata.source,
        parentItemID: metadata.parentItemID,
        diagnostics: result.diagnostics,
        targets: result.targets.map(target => ({
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
      Zotero.logError?.(error);
      this.setToolbarStatus(reader, `标题/摘要识别失败：${error?.message || error}`);
      this.autoSessions.set(reader, { reader, error });
      return null;
    }
    finally {
      this.startingReaders.delete(reader);
      if (button) button.disabled = false;
    }
  },

  formatDiagnostics(diagnostics) {
    const confidence = {
      high: "高",
      medium: "中",
      low: "低"
    }[diagnostics?.confidence] || "未知";
    const paragraphCount = diagnostics?.paragraphCount === null
      ? "未知" : String(diagnostics?.paragraphCount ?? 0);
    const unclassified = Number(diagnostics?.unclassifiedCharCount || 0);
    return `原始矩形：${diagnostics?.rawRectCount ?? 0}`
      + ` · 命中段落：${paragraphCount}`
      + ` · 完整段落：${diagnostics?.fullParagraphCount ?? 0}`
      + ` · 部分段落：${diagnostics?.partialParagraphCount ?? 0}`
      + ` · 识别置信度：${confidence}`
      + (unclassified ? ` · 未分类字符：${unclassified}` : "");
  },

  async translateSelection(reader, annotation, sourceText, status, button) {
    const position = copyPosition(annotation?.position)
      || copyPosition(reader?._internalReader?.getSelectionPosition?.());
    const view = reader?._internalReader?._primaryView || null;
    if (!position) {
      status.textContent = "未读取到选区位置";
      return;
    }
    if (!view || typeof view.getClientRect !== "function") {
      status.textContent = "未找到 PDF 视图";
      return;
    }
    status.textContent = "正在读取字符和段落…";
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
    const session = { reader, cancelled: false,
      recordID: `selection-${++this.selectionTaskCounter}` };
    this.selectionSessions.set(reader, session);
    try {
      let match;
      try {
        const pages = await ReaderPageDataLoader.load(view, position);
        const selectionContext = SelectionMatcher.buildSelectionContext(position, pages);
        const rawParagraphs = ReaderPageDataBodyExtractor.extract({
          pages,
          outlineHints: [],
          selectionContext
        }).raw || [];
        match = SelectionMatcher.analyze({
          position,
          sourceText,
          pages,
          rawParagraphs
        });
      }
      catch (error) {
        Zotero.logError?.(error);
        match = makeFallbackMatch(position);
        match.diagnostics.fallbackReason = String(error?.message || error);
      }
      if (match.fallback || !match.paragraphs.length) {
        match = makeFallbackMatch(position);
        status.textContent = "无法识别正文段落";
      }
      else {
        status.textContent = this.formatDiagnostics(match.diagnostics);
      }
      match.segments = ContentSegments.fromSelection(match);
      session.view = view;
      session.match = match;
      session.segments = match.segments;
      session.attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
      if (this.selectionSessions.get(reader) !== session || session.cancelled) return;
      if (!match.segments.length) {
        status.textContent = "未找到可翻译的英文段落";
        return;
      }
      SelectionReplacerOverlay.attach(reader, view, match, {
        mode: "selection-translation",
        recordID: session.recordID,
        segments: match.segments,
        translations: new Map(),
        translationPending: true
      });
      status.textContent = `正在翻译 ${match.segments.length} 个段落…`;
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
      const translated = translation.diagnostics.translated + translation.diagnostics.cached;
      status.textContent = `段落翻译完成：${translated}/${match.segments.length}`
        + (translation.diagnostics.failed ? ` · 失败 ${translation.diagnostics.failed}` : "")
        + (translation.diagnostics.skipped ? ` · 跳过 ${translation.diagnostics.skipped}` : "");
      Zotero.debug?.(`[${PLUGIN_ID}] selection analysis: ${JSON.stringify({
        sourceText,
        diagnostics: match.diagnostics,
        translation: translation.diagnostics,
        paragraphs: match.paragraphs.map(paragraph => ({
          sourceIndex: paragraph.sourceIndex,
          matchType: paragraph.matchType,
          confidence: paragraph.confidence,
          selectedRectCount: paragraph.selectedRectCount,
          selectedText: paragraph.selectedText || paragraph.sourceText || ""
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
    container.style.alignItems = "center";
    container.style.gap = "4px";

    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "翻译";
    button.title = "翻译当前选区中识别到的段落";
    button.setAttribute("aria-label", button.title);

    const status = doc.createElement("span");
    status.style.fontSize = "11px";
    status.style.opacity = "0.75";

    button.addEventListener("click", () => {
      this.translateSelection(reader, annotation, sourceText, status, button)
        .catch(error => {
          Zotero.logError?.(error);
          status.textContent = `处理失败：${error?.message || error}`;
          button.disabled = false;
        });
    });

    container.append(button, status);
    append(container);
  }
};

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await SelectionReplacerTest.init(rootURI);
}

function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) SelectionReplacerTest.shutdown();
}

function install() {}
function uninstall() {}
