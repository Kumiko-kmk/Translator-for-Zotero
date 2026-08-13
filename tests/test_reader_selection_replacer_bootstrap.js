"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bootstrapPath = path.resolve(
  __dirname,
  "..",
  "zotero-reader-selection-replacer-test",
  "bootstrap.js"
);
const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Zotero: {
    Promise: { delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) },
    debug() {},
    logError() {}
  },
  Components: {
    utils: {
      cloneInto(value) { return value; },
      exportFunction(value) { return value; }
    }
  },
  Services: { scriptloader: { loadSubScript() {} } },
  APP_SHUTDOWN: "shutdown"
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(bootstrap, context, { filename: bootstrapPath });
vm.runInContext(fs.readFileSync(path.resolve(
  __dirname, "..", "zotero-reader-selection-replacer-test", "content-segments.js"
), "utf8"), context, { filename: "content-segments.js" });

const matcher = context.SelectionMatcher;
const splitReplacement = context.splitReplacement;
const replacerTest = context.SelectionReplacerTest;
const locator = context.ReaderTargetLocator;
const overlay = context.SelectionReplacerOverlay;

function makeFixture(paragraphLineCounts) {
  const chars = [];
  const lineRects = [];
  const rawParagraphs = [];
  const paragraphTexts = [];
  let offset = 0;
  let lineIndex = 0;

  for (let paragraphIndex = 0; paragraphIndex < paragraphLineCounts.length; paragraphIndex++) {
    const sourceCharIDs = [];
    const lines = [];
    for (let localLine = 0; localLine < paragraphLineCounts[paragraphIndex]; localLine++) {
      const lineText = "ABCD";
      const top = lineIndex * 20;
      const lineRect = [0, top, lineText.length * 10, top + 10];
      lineRects.push(lineRect);
      lines.push(lineText);
      for (let charIndex = 0; charIndex < lineText.length; charIndex++) {
        const id = `0:char:${offset}`;
        sourceCharIDs.push(id);
        chars.push({
          id,
          offset,
          pageIndex: 0,
          c: lineText[charIndex],
          rect: [charIndex * 10, top, charIndex * 10 + 9, top + 10],
          lineBreakAfter: charIndex === lineText.length - 1,
          paragraphBreakAfter: localLine === paragraphLineCounts[paragraphIndex] - 1
            && charIndex === lineText.length - 1,
          ignorable: false
        });
        offset++;
      }
      lineIndex++;
    }
    const text = lines.join(" ");
    paragraphTexts.push(text);
    rawParagraphs.push({
      sourceIndex: paragraphIndex,
      sourceOrder: paragraphIndex,
      text,
      sourceCharIDs,
      contentType: "body-paragraph"
    });
  }

  const position = {
    pageIndex: 0,
    rects: lineRects,
    fragments: [{ pageIndex: 0, rects: lineRects }]
  };
  return {
    pages: [{ pageIndex: 0, chars }],
    rawParagraphs,
    position,
    sourceText: paragraphTexts.join(" "),
    lineRects,
    chars
  };
}

function positionForLines(fixture, lineIndexes) {
  const rects = lineIndexes.map(index => fixture.lineRects[index]);
  return { pageIndex: 0, rects, fragments: [{ pageIndex: 0, rects }] };
}

function makePartialLineFixture({ indented = false } = {}) {
  const chars = [];
  const lineRects = [];
  const textLines = [
    indented ? "  Alpha complete line" : "Alpha complete line",
    "Beta complete line"
  ];
  let offset = 0;
  for (const [lineIndex, text] of textLines.entries()) {
    const left = indented && lineIndex === 0 ? 20 : 0;
    const top = lineIndex * 20;
    const rect = [left, top, left + text.length * 8, top + 10];
    lineRects.push(rect);
    for (const [charIndex, c] of [...text].entries()) {
      chars.push({
        id: `0:char:${offset++}`,
        offset: offset - 1,
        pageIndex: 0,
        c,
        rect: [left + charIndex * 8, top, left + charIndex * 8 + 7, top + 10],
        lineBreakAfter: charIndex === [...text].length - 1,
        ignorable: false
      });
    }
  }
  const sourceCharIDs = chars.filter(char => !/^\s+$/u.test(char.c)).map(char => char.id);
  const rawParagraphs = [{ sourceIndex: 0, sourceOrder: 0, text: textLines.join(" "), sourceCharIDs }];
  return {
    pages: [{ pageIndex: 0, chars }],
    rawParagraphs,
    chars,
    sourceText: "Alpha"
  };
}

function makeCrossPageFixture() {
  const pages = [];
  const fragments = [];
  const sourceCharIDs = [];
  const paragraphLines = [];
  let sourceText = [];
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const chars = [];
    const rects = [];
    for (let localLine = 0; localLine < 2; localLine++) {
      const text = "ABCD";
      const top = localLine * 20;
      const rect = [0, top, 40, top + 10];
      rects.push(rect);
      paragraphLines.push(text);
      sourceText.push(text);
      for (let charIndex = 0; charIndex < text.length; charIndex++) {
        const offset = localLine * text.length + charIndex;
        const id = `${pageIndex}:char:${offset}`;
        sourceCharIDs.push(id);
        chars.push({
          id,
          offset,
          pageIndex,
          c: text[charIndex],
          rect: [charIndex * 10, top, charIndex * 10 + 9, top + 10],
          lineBreakAfter: charIndex === text.length - 1,
          paragraphBreakAfter: pageIndex === 1 && localLine === 1
            && charIndex === text.length - 1,
          ignorable: false
        });
      }
    }
    pages.push({ pageIndex, chars });
    fragments.push({ pageIndex, rects });
  }
  return {
    pages,
    rawParagraphs: [{
      sourceIndex: 0,
      sourceOrder: 0,
      text: paragraphLines.join(" "),
      sourceCharIDs,
      contentType: "body-paragraph"
    }],
    position: { pageIndex: 0, rects: fragments[0].rects, fragments },
    sourceText: sourceText.join(" ")
  };
}

{
  const fixture = makeFixture([8]);
  const match = matcher.analyze(fixture);
  assert.strictEqual(match.diagnostics.rawRectCount, 8);
  assert.strictEqual(match.diagnostics.paragraphCount, 1);
  assert.strictEqual(match.diagnostics.fullParagraphCount, 1);
  assert.strictEqual(match.diagnostics.partialParagraphCount, 0);
  assert.strictEqual(match.paragraphs[0].matchType, "full");
  assert.strictEqual(match.paragraphs[0].selectedRectCount, 8);
  assert.strictEqual(match.paragraphs[0].selectedPosition.fragments[0].rects.length, 8);
}

{
  const fixture = makePartialLineFixture();
  const firstLine = fixture.pages[0].chars.filter(char => char.rect[1] === 0);
  const selected = firstLine.slice(0, 5);
  const position = {
    pageIndex: 0,
    rects: [[0, 0, 40, 10]],
    fragments: [{ pageIndex: 0, rects: [[0, 0, 40, 10]] }]
  };
  const match = matcher.analyze({ ...fixture, position, sourceText: "Alpha" });
  const paragraph = match.paragraphs[0];
  assert.strictEqual(paragraph.selectedText, "Alpha");
  assert.strictEqual(paragraph.translationText, "Alpha complete line");
  assert.ok(paragraph.translationPosition.fragments[0].rects[0][2] > 40);
  const segment = context.ContentSegments.fromSelection(match)[0];
  assert.strictEqual(segment.sourceText, "Alpha complete line");
  assert.strictEqual(segment.metadata.selectedText, "Alpha");
}

{
  const indented = matcher.analyze({
    ...makePartialLineFixture({ indented: true }),
    position: { pageIndex: 0, rects: [[20, 0, 60, 10]],
      fragments: [{ pageIndex: 0, rects: [[20, 0, 60, 10]] }] },
    sourceText: "Alpha"
  });
  assert.strictEqual(indented.paragraphs[0].translationIndentFirstBlock, true);
  const plain = matcher.analyze({
    ...makePartialLineFixture(),
    position: { pageIndex: 0, rects: [[0, 0, 40, 10]],
      fragments: [{ pageIndex: 0, rects: [[0, 0, 40, 10]] }] },
    sourceText: "Alpha"
  });
  assert.strictEqual(plain.paragraphs[0].translationIndentFirstBlock, false);
}

{
  const fixture = makeFixture([4, 3]);
  const match = matcher.analyze(fixture);
  assert.strictEqual(match.diagnostics.rawRectCount, 7);
  assert.strictEqual(match.diagnostics.paragraphCount, 2);
  assert.strictEqual(match.diagnostics.fullParagraphCount, 2);
  assert.deepStrictEqual(Array.from(match.paragraphs, paragraph => paragraph.sourceIndex), [0, 1]);
}

{
  const fixture = makeFixture([8]);
  const selectedLines = [0, 1];
  const match = matcher.analyze({
    ...fixture,
    position: positionForLines(fixture, selectedLines),
    sourceText: selectedLines.map(() => "ABCD").join(" ")
  });
  assert.strictEqual(match.diagnostics.rawRectCount, 2);
  assert.strictEqual(match.diagnostics.paragraphCount, 1);
  assert.strictEqual(match.diagnostics.fullParagraphCount, 0);
  assert.strictEqual(match.diagnostics.partialParagraphCount, 1);
  assert.strictEqual(match.paragraphs[0].matchType, "partial");
  assert.strictEqual(match.paragraphs[0].selectedText, "ABCD ABCD");
}

{
  const match = matcher.analyze(makeCrossPageFixture());
  assert.strictEqual(match.diagnostics.paragraphCount, 1);
  assert.strictEqual(match.paragraphs[0].selectedRectCount, 4);
  assert.strictEqual(match.paragraphs[0].selectedPosition.fragments.length, 2);
}

{
  const fixture = makeFixture([3]);
  const omittedIDs = new Set(fixture.pages[0].chars.slice(4, 8).map(char => char.id));
  const rawParagraphs = fixture.rawParagraphs.map(paragraph => ({
    ...paragraph,
    sourceCharIDs: paragraph.sourceCharIDs.filter(id => !omittedIDs.has(id))
  }));
  const match = matcher.analyze({ ...fixture, rawParagraphs });
  const unclassified = match.paragraphs.filter(paragraph => paragraph.matchType === "unclassified");
  assert.strictEqual(unclassified.length, 1);
  assert.strictEqual(match.diagnostics.unclassifiedGroupCount, 1);
  assert.strictEqual(match.selectedCharCount,
    match.diagnostics.classifiedCharCount + match.diagnostics.unclassifiedCharCount);
  const assignedIDs = match.paragraphs.flatMap(paragraph => paragraph.selectedCharIDs);
  assert.strictEqual(new Set(assignedIDs).size, assignedIDs.length);
  assert.strictEqual(new Set(assignedIDs).size, match.selectedCharCount);
}

{
  const fixture = makeFixture([3]);
  const target = locator.matchText({ kind: "title", text: "ABCD ABCD" }, fixture.pages);
  assert.ok(target);
  assert.strictEqual(target.confidence, "high");
  assert.strictEqual(target.matchMethod, "metadata-segmented");
  assert.strictEqual(target.position.fragments[0].rects.length, 2);
}

{
  const parts = Array.from({ length: 8 }, (_, index) => ({
    rect: [0, index * 20, 100, index * 20 + 10],
    sourceCharCount: 4
  }));
  assert.deepStrictEqual(Array.from(splitReplacement("测试", parts)), [
    "测试", "", "", "", "", "", "", ""
  ]);
}

assert.match(
  replacerTest.formatDiagnostics({
    rawRectCount: 8,
    paragraphCount: 1,
    fullParagraphCount: 0,
    partialParagraphCount: 1,
    confidence: "high"
  }),
  /原始矩形：8.*命中段落：1.*部分段落：1.*识别置信度：高/u
);

assert.strictEqual(
  replacerTest.formatAutoStatusV2({
    targets: [{
      kind: "title",
      confidence: "high",
      matchMethod: "metadata-segmented",
      metadataCoverage: 1
    }]
  }),
  "标题: high/metadata 100% | 摘要: unlocated"
);

{
  const merged = overlay.mergeTargetParts([
    { pageIndex: 0, rect: [10, 20, 100, 35] },
    { pageIndex: 0, rect: [12, 40, 160, 55] },
    { pageIndex: 1, rect: [5, 8, 80, 18] }
  ]);
  assert.deepStrictEqual(Array.from(merged, part => ({
    pageIndex: part.pageIndex,
    rect: Array.from(part.rect),
    sourceRectCount: part.sourceRects.length
  })), [
    { pageIndex: 0, rect: [10, 20, 160, 55], sourceRectCount: 2 },
    { pageIndex: 1, rect: [5, 8, 80, 18], sourceRectCount: 1 }
  ]);
}

{
  const parts = [
    { pageIndex: 0, rect: [20, 20, 180, 30], sourceCharCount: 40 },
    { pageIndex: 0, rect: [20, 34, 175, 44], sourceCharCount: 38 },
    { pageIndex: 0, rect: [320, 20, 480, 30], sourceCharCount: 40 },
    { pageIndex: 0, rect: [320, 34, 475, 44], sourceCharCount: 38 }
  ];
  const merged = overlay.mergeSelectionParts(parts);
  assert.strictEqual(merged.length, 2);
  assert.deepStrictEqual(Array.from(merged, part => Array.from(part.rect)), [
    [20, 20, 180, 44], [320, 20, 480, 44]
  ]);
  assert.deepStrictEqual(Array.from(merged, part => part.sourceRects.length), [2, 2]);
  assert.strictEqual(merged.every(part => part.rect[2] - part.rect[0] < 200), true);

  const translated = "左栏译文。右栏译文，包含更多内容。";
  const chunks = overlay.splitSelectionTranslation(translated, merged);
  assert.strictEqual(chunks.join(""), translated);
  assert.strictEqual(chunks.length, 2);
  assert.ok(chunks[0].length > 0 && chunks[1].length > 0);
}

{
  const parts = [
    { pageIndex: 0, rect: [20, 20, 180, 30], sourceCharCount: 20 },
    { pageIndex: 0, rect: [20, 34, 175, 44], sourceCharCount: 20 },
    { pageIndex: 0, rect: [320, 20, 480, 30], sourceCharCount: 20 },
    { pageIndex: 0, rect: [320, 34, 475, 44], sourceCharCount: 20 },
    { pageIndex: 0, rect: [20, 50, 480, 60], sourceCharCount: 60 }
  ];
  const merged = overlay.mergeSelectionParts(parts);
  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(Array.from(merged, part => Array.from(part.rect)), [
    [20, 20, 180, 44], [320, 20, 480, 44], [20, 50, 480, 60]
  ]);
}

{
  const node = {
    isConnected: true,
    style: {},
    scrollWidth: 180,
    scrollHeight: 32
  };
  const fitted = overlay.fitSelectionText({ node,
    containerWidth: 200, containerHeight: 50,
    translatedText: "选区段落译文自动换行",
    sourceRects: [[0, 0, 200, 12], [0, 15, 200, 27]],
    indentFirstBlock: true });
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(fitted.layoutMode, "selection-fit");
  assert.strictEqual(node.style.textAlign, "left");
  assert.strictEqual(node.style.whiteSpace, "pre-wrap");
  assert.strictEqual(node.style.overflowWrap, "break-word");
  assert.strictEqual(node.textContent, "　　选区段落译文自动换行");
}

{
  const merged = overlay.mergeTitleParts([
    { pageIndex: 0, rect: [10, 20, 180, 35] },
    { pageIndex: 0, rect: [12, 40, 140, 55] }
  ]);
  assert.deepStrictEqual(Array.from(merged[0].rect), [10, 20, 180, 55]);
  assert.strictEqual(merged[0].sourceRects.length, 2);
  assert.deepStrictEqual(Array.from(overlay.titleBreakParts("简短标题").lines), ["简短标题"]);
  const dsBreak = overlay.titleBreakParts(
    "钢渣部分替代粗骨料对纤维增强混凝土曲梁<br>在静载和冲击荷载下性能的影响");
  assert.strictEqual(dsBreak.breakSource, "deepseek");
  assert.strictEqual(dsBreak.lines.length, 2);
  const unmarked = overlay.titleBreakParts("这是一个超过二十四个有效字符但没有换行标记的中文学术论文标题");
  assert.strictEqual(unmarked.breakSource, "none");
  assert.strictEqual(unmarked.lines.length, 1);
}

{
  const node = {
    isConnected: true,
    style: {},
    get scrollWidth() {
      return Number.parseFloat(this.style.fontSize || "8") > 22 ? 220 : 180;
    },
    get scrollHeight() {
      return Number.parseFloat(this.style.fontSize || "8")
        * Number(this.style.lineHeight || 1) * 4;
    }
  };
  const fitted = overlay.fitAbstractText({ node,
    containerWidth: 200, containerHeight: 100, translatedText: "摘要译文连续文本",
    sourceRects: [[0, 0, 200, 12], [0, 15, 200, 27], [0, 30, 200, 42]],
    indentFirstBlock: true });
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(fitted.layoutMode, "abstract-fit");
  assert.ok(fitted.fontSize > 12 * 1.45);
  assert.ok(fitted.lineHeight >= 1.1 && fitted.lineHeight <= 2.2);
  assert.ok(fitted.verticalUsage > 0.9);
  assert.strictEqual(node.style.display, "block");
  assert.strictEqual(node.style.wordBreak, "normal");
  assert.strictEqual(node.style.overflowWrap, "break-word");
  assert.strictEqual(node.textContent, "　　摘要译文连续文本");
}

{
  const node = {
    isConnected: true,
    style: {},
    scrollWidth: 180,
    scrollHeight: 32
  };
  const fitted = overlay.fitSelectionText({ node,
    containerWidth: 200, containerHeight: 50,
    translatedText: "后续栏位译文",
    sourceRects: [[0, 0, 200, 12]],
    indentFirstBlock: false });
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(node.textContent, "后续栏位译文");
}

{
  const node = { style: {}, textContent: "" };
  const status = overlay.renderTranslationStatus(node, "selection", "正在翻译…", "pending");
  assert.strictEqual(status.rendered, true);
  assert.strictEqual(node.textContent, "正在翻译…");
  assert.strictEqual(node.textContent.startsWith("　　"), false);
}

{
  const reader = {};
  const view = { _iframeWindow: {} };
  const first = overlay.attach(reader, view, [{ kind: "title" }], {
    mode: "diagnostic", recordID: "front-matter", translations: new Map()
  });
  const selection = overlay.attach(reader, view, { paragraphs: [] }, {
    mode: "selection-translation", recordID: "selection-test-1",
    segments: [], translations: new Map(), translationPending: false
  });
  assert.strictEqual(first, selection);
  assert.deepStrictEqual(Array.from(selection.records.keys()), [
    "front-matter", "selection-test-1"
  ]);
  overlay.attach(reader, view, [{ kind: "title" }], {
    mode: "diagnostic", recordID: "front-matter", translations: new Map()
  });
  assert.deepStrictEqual(Array.from(selection.records.keys()), [
    "front-matter", "selection-test-1"
  ]);
  overlay.remove(reader);
  assert.strictEqual(overlay.states.has(reader), false);
}

{
  const node = { isConnected: true, style: {}, scrollWidth: 400, scrollHeight: 400 };
  const fitted = overlay.fitAbstractText({ node,
    containerWidth: 150, containerHeight: 30, translatedText: "过长摘要译文",
    sourceRects: [[0, 0, 150, 15]] });
  assert.strictEqual(fitted.rendered, false);
  assert.strictEqual(fitted.failureReason, "minimum-font-overflow");
}

{
  const node = { isConnected: true, style: {}, scrollWidth: 400, scrollHeight: 400 };
  const measured = overlay.measureTextLayout({ node,
    containerWidth: 400, containerHeight: 500, fontSize: 10, lineHeight: 1.1,
    mode: "block" });
  assert.strictEqual(measured.availableWidth, 392);
  assert.strictEqual(measured.availableHeight, 494);
  assert.strictEqual(measured.fits, true);
}

{
  const makeLine = () => ({
    style: {},
    textContent: "",
    get scrollWidth() {
      return String(this.textContent || "").length
        * Number.parseFloat(this.style.fontSize || "0") * 0.8;
    }
  });
  const node = {
    isConnected: true,
    style: {},
    ownerDocument: { createElement: () => makeLine() },
    children: [],
    append(child) { this.children.push(child); },
    textContent: ""
  };
  const fitted = overlay.fitTitleText({ node,
    containerWidth: 200, containerHeight: 14,
    translatedText: "单行标题", sourceRects: [[0, 0, 200, 14]] });
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(fitted.layoutMode, "title-single");
  assert.strictEqual(fitted.lines.length, 1);
  assert.strictEqual(fitted.breakSource, "short-title-forced-single");
  assert.strictEqual(fitted.lineHeight, 1.05);
  assert.ok(fitted.fontSize <= 14 / 1.05 + 0.01);
  assert.strictEqual(fitted.verticalOverflow, false);
  assert.strictEqual(node.style.position, "absolute");
  assert.strictEqual(node.style.inset, "0");
  assert.strictEqual(node.style.width, "100%");
  assert.strictEqual(node.style.height, "100%");
  assert.strictEqual(node.style.justifyContent, "center");
  assert.strictEqual(node.children.length, 1);
  assert.strictEqual(node.children[0].style.whiteSpace, "nowrap");
}

{
  const makeLine = () => ({
    style: {},
    textContent: "",
    get scrollWidth() {
      return String(this.textContent || "").length
        * Number.parseFloat(this.style.fontSize || "0") * 0.8;
    }
  });
  const node = {
    isConnected: true,
    style: {},
    ownerDocument: { createElement: () => makeLine() },
    children: [],
    append(child) { this.children.push(child); },
    textContent: ""
  };
  const fitted = overlay.fitTitleText({ node,
    containerWidth: 200, containerHeight: 24,
    translatedText: "短标题<br>测试", sourceRects: [[0, 0, 200, 24]] });
  assert.strictEqual("短标题<br>测试".length < 16, true);
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(fitted.layoutMode, "title-single");
  assert.strictEqual(fitted.breakSource, "short-title-forced-single");
  assert.deepStrictEqual(Array.from(fitted.lines), ["短标题测试"]);
  assert.strictEqual(node.children.length, 1);
  assert.strictEqual(node.children[0].textContent, "短标题测试");
  assert.strictEqual(node.children[0].style.whiteSpace, "nowrap");
}

{
  const makeLine = () => ({
    style: {},
    textContent: "",
    get scrollWidth() {
      return String(this.textContent || "").length
        * Number.parseFloat(this.style.fontSize || "0") * 0.8;
    }
  });
  const node = {
    isConnected: true,
    style: {},
    ownerDocument: { createElement: () => makeLine() },
    children: [],
    append(child) { this.children.push(child); },
    textContent: ""
  };
  const translatedText = "一二三四五六七八九十<br>十一";
  assert.strictEqual(translatedText.length, 16);
  const fitted = overlay.fitTitleText({ node,
    containerWidth: 200, containerHeight: 30,
    translatedText, sourceRects: [[0, 0, 200, 30]] });
  assert.strictEqual(fitted.rendered, true);
  assert.strictEqual(fitted.breakSource, "deepseek");
  assert.strictEqual(fitted.layoutMode, "title-ds-two-line");
  assert.deepStrictEqual(Array.from(fitted.lines), ["一二三四五六七八九十", "十一"]);
  assert.strictEqual(node.children.length, 2);
}

{
  const abstractSuccess = overlay.translationDecoration("abstract", "success");
  assert.strictEqual(abstractSuccess.border, "none");
  assert.strictEqual(abstractSuccess.showBadge, false);
  assert.strictEqual(abstractSuccess.badgeText, "");
  const abstractFailure = overlay.translationDecoration("abstract", "failure");
  assert.strictEqual(abstractFailure.border, "1px dashed #f97316");
  assert.strictEqual(abstractFailure.showBadge, true);
  assert.strictEqual(abstractFailure.badgeText, "摘要状态");
  const titleSuccess = overlay.translationDecoration("title", "success");
  assert.strictEqual(titleSuccess.border, "none");
  assert.strictEqual(titleSuccess.showBadge, false);
  assert.strictEqual(titleSuccess.badgeText, "");
  const titleFailure = overlay.translationDecoration("title", "failure");
  assert.strictEqual(titleFailure.border, "none");
  assert.strictEqual(titleFailure.showBadge, false);
  assert.strictEqual(titleFailure.badgeText, "");
}

{
  const makeElement = tagName => ({
    tagName: tagName.toUpperCase(),
    children: [],
    style: {},
    textContent: "",
    isConnected: true,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, handler) { this[`on${name}`] = handler; }
  });
  const created = [];
  const doc = { createElement(tagName) {
    const element = makeElement(tagName);
    created.push(element);
    return element;
  } };
  const appended = [];
  replacerTest.onRenderTextSelectionPopup({
    reader: {}, doc,
    params: { annotation: { text: "Selected paragraph", position: {
      pageIndex: 0, rects: [[0, 0, 10, 10]],
      fragments: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }]
    } } },
    append(element) { appended.push(element); }
  });
  assert.strictEqual(appended.length, 1);
  assert.strictEqual(created.some(element => element.tagName === "INPUT"), false);
  assert.strictEqual(appended[0].children.length, 2);
  assert.strictEqual(appended[0].children[0].textContent, "翻译");
  assert.match(appended[0].children[0].title, /翻译/u);
}

console.log("selection replacer bootstrap tests passed");
