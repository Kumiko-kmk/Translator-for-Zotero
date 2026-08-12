const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(
  "E:/Kumiko/pythonProject/Zotero/zotero-reader-highlighter/bootstrap.js",
  "utf8"
);
const layoutSource = fs.readFileSync(
  "E:/Kumiko/pythonProject/Zotero/zotero-reader-highlighter/layout-extractor.js",
  "utf8"
);

let layout = "stacked";
let parentLanguage = "en-US";
const requestLog = [];
const storedLogins = [];
const sampleRawText = [
  [
    "Repeated article header 2019",
    "Main body paragraph on the first page explains the research problem in sufficient detail and reports a stable value of 30 MPa [12].",
    "https://doi.org/10.1016/j.soildyn.2019.105824 Received 7 April 2017; Received in revised form 16 August 2019; Accepted 16 August 2019",
    "⁎ Corresponding author. E-mail addresses: cw2707@mun.ca (C. Wang).",
    "Soil Dynamics and Earthquake Engineering 127 (2019) 105824",
    "Available online 10 September 2019 0267-7261/ © 2019 Elsevier Ltd. All rights reserved.",
    "1"
  ].join("\n"),
  [
    "Repeated article header 2019",
    "The second page contains another substantive discussion paragraph that must remain available for downstream processing and careful review.",
    "q = α × x + β × y (1)",
    "E = mc2",
    "2"
  ].join("\n"),
  [
    "Repeated article header 2019",
    "The final page reports conclusions and limitations in ordinary prose for downstream processing and reproducible scientific interpretation.",
    "3"
  ].join("\n")
].join("\f");

function makeLine(text, pageIndex, x, bottom, options = {}) {
  const chars = [];
  let cursor = x;
  const height = Number(options.height || 12);
  for (const character of text) {
    const width = character === " " ? 3 : 5;
    chars.push({
      c: character,
      rect: [cursor, bottom, cursor + width, bottom + height],
      inlineRect: [cursor, bottom, cursor + width, bottom + height],
      pageIndex,
      spaceAfter: false,
      lineBreakAfter: false,
      paragraphBreakAfter: false,
      rotation: 0
    });
    cursor += character === " " ? 3 : 6;
  }
  if (chars.length) {
    chars.at(-1).lineBreakAfter = true;
    chars.at(-1).paragraphBreakAfter = options.paragraphBreakAfter !== false;
  }
  return chars;
}

function page(chars) {
  return { chars, viewBox: [0, 0, 600, 800] };
}

const readerPageData = [page([
  ...makeLine("A Layout-Aware Study of Scientific Documents", 0, 150, 770, { height: 20 }),
  ...makeLine("The left column begins with ordinary prose", 0, 45, 720),
  ...makeLine("and remains inside its own visual flow.", 0, 45, 670),
  ...makeLine("Additional evidence stabilizes the gutter.", 0, 45, 620),
  ...makeLine("The complete left flow must come first.", 0, 45, 570),
  ...makeLine("A final sentence closes the left column.", 0, 45, 520),
  ...makeLine("Fig. 11 shows retained scientific prose", 0, 330, 720),
  ...makeLine("and confirms this is a body paragraph.", 0, 330, 670),
  ...makeLine("Additional right-column material remains.", 0, 330, 620),
  ...makeLine("The right flow follows the complete left.", 0, 330, 570),
  ...makeLine("A final sentence closes the right column.", 0, 330, 520),
  ...makeLine("Variables E, x, and α remain in prose.", 0, 45, 470),
  ...makeLine("E = mc2", 0, 140, 430),
  ...makeLine("Table 2. Mix properties and measured strengths", 0, 45, 360, { height: 10 }),
  ...makeLine("Mix", 0, 45, 340, { height: 10 }),
  ...makeLine("Water", 0, 135, 340, { height: 10 }),
  ...makeLine("Strength", 0, 225, 340, { height: 10 }),
  ...makeLine("A", 0, 45, 322, { height: 10 }),
  ...makeLine("0.42", 0, 135, 322, { height: 10 }),
  ...makeLine("31.5", 0, 225, 322, { height: 10 }),
  ...makeLine("B", 0, 45, 304, { height: 10 }),
  ...makeLine("0.38", 0, 135, 304, { height: 10 }),
  ...makeLine("35.2", 0, 225, 304, { height: 10 }),
  ...makeLine("Fig. 12. Microscopy image of the hardened specimen.", 0, 330, 340, { height: 10 }),
  ...makeLine("1", 0, 295, 12, { height: 9 })
])];

const context = {
  APP_SHUTDOWN: 2,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  PathUtils: { join: (...parts) => parts.join("/") },
  Components: {
    interfaces: { nsILoginInfo: {} },
    utils: {
      exportFunction: handler => handler,
      cloneInto: value => value
    },
    Constructor: function Constructor() {
      return class LoginInfo {
        constructor(origin, formActionOrigin, httpRealm, username, password) {
          Object.assign(this, { origin, formActionOrigin, httpRealm, username, password });
        }
      };
    }
  },
  Services: {
    logins: {
      async searchLoginsAsync({ origin, httpRealm }) {
        return storedLogins.filter(login => login.origin === origin && login.httpRealm === httpRealm);
      },
      async addLoginAsync(login) { storedLogins.push(login); },
      removeLogin(login) { storedLogins.splice(storedLogins.indexOf(login), 1); }
    }
  },
  Zotero: {
    initializationPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    Promise: { delay: () => Promise.resolve() },
    Utilities: {
      Internal: {
        md5(value) {
          return `hash-${value.length}`;
        }
      }
    },
    Prefs: {
      get: name => name === "layout" ? layout : undefined,
      set: (name, value) => {
        if (name === "layout") layout = value;
      }
    },
    Reader: {
      _readers: [],
      registerEventListener() {},
      _unregisterEventListenerByPluginID() {}
    },
    ItemPaneManager: {
      registerSection: () => "reader-text-highlighter-pane",
      unregisterSection() {}
    },
    Items: {
      get: () => null,
      async getAsync() {
        return { getField: () => parentLanguage };
      }
    },
    PDFWorker: {
      async getFullText(itemID, maxPages, isPriority) {
        assert.equal(itemID, 42);
        assert.equal(maxPages, null);
        assert.equal(isPriority, true);
        return { text: sampleRawText, extractedPages: 3, totalPages: 3 };
      }
    },
    HTTP: {
      async request(method, url, options) {
        requestLog.push({ method, url, options });
        return { status: 200, response: { data: [{ id: "deepseek-v4-flash" }] } };
      }
    },
    ProgressWindow: class {},
    debug() {},
    logError() {}
  }
};
vm.createContext(context);
vm.runInContext(layoutSource, context, { filename: "layout-extractor.js" });
vm.runInContext(source, context, { filename: "bootstrap.js" });

const extractor = context.ReaderTextExtractor;
const credentials = context.DeepSeekCredentials;
const overlay = context.ReaderOverlay;
assert.ok(extractor);
assert.ok(credentials);
assert.ok(overlay);

(async () => {
  const attachment = {
    id: 42,
    key: "ATTACH",
    libraryID: 1,
    parentID: 7,
    isPDFAttachment: () => true
  };
  const fullText = await extractor.extractFullText(attachment);
  assert.equal(fullText.extractedPages, 3);
  assert.equal(fullText.totalPages, 3);
  assert.match(fullText.text, /first page explains/);
  assert.match(fullText.text, /second page contains/);
  assert.match(fullText.text, /final page reports/);
  assert.doesNotMatch(fullText.text, /Repeated article header/);
  assert.doesNotMatch(fullText.text, /doi\.org|Corresponding author|Available online/);
  assert.doesNotMatch(fullText.text, /q = α|E = mc2/);

  const foreignView = {
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: readerPageData.length,
          async getPageData({ pageIndex }) { return readerPageData[pageIndex]; }
        },
        pdfViewer: {
          _pages: Array.from({ length: readerPageData.length }, () => ({
            viewport: {
              width: 600,
              height: 800,
              rotation: 0,
              viewBox: [0, 0, 600, 800],
              convertToViewportPoint(x, y) { return [x, 800 - y]; }
            }
          }))
        }
      }
    }
  };
  const snapshot = await extractor.getReaderParagraphs({
    _internalReader: {
      _primaryView: foreignView,
      _sdt: {
        structure: {
          content: [
            {
              type: "table",
              content: [{ text: "Table 2 Mix Water Strength A 0.42 31.5 B 0.38 35.2" }],
              anchor: { pageRects: [[0, 40, 290, 300, 375]] }
            },
            {
              type: "caption",
              content: [{ text: "Fig. 12. Microscopy image of the hardened specimen." }],
              anchor: { pageRects: [[0, 325, 330, 600, 355]] }
            },
            {
              type: "math",
              content: [{ text: "E = mc2" }],
              anchor: { pageRects: [[0, 130, 425, 240, 450]] }
            }
          ]
        }
      }
    }
  });
  assert.equal(snapshot.extractionSource, "zotero-page-chars");
  assert.equal(snapshot.coordinateSystem, "viewport-top-down");
  assert.equal(snapshot.layoutDiagnostics[0].columnCount, 2);
  assert.ok(snapshot.layoutDiagnostics[0].crossColumnVisualRowCount >= 4);
  assert.equal(snapshot.layoutDiagnostics[0].crossColumnLineMergeCount, 0);
  assert.equal(snapshot.textConservation.unassignedCharacterCount, 0);
  assert.equal(snapshot.textConservation.duplicateCharacterCount, 0);
  const snapshotText = snapshot.raw.map(item => item.text).join("\n");
  assert.match(snapshotText, /left column begins/);
  assert.match(snapshotText, /Fig\. 11 shows retained scientific prose/);
  assert.match(snapshotText, /Variables E, x, and α remain in prose/);
  assert.doesNotMatch(snapshotText, /E = mc2/);
  assert.ok(snapshotText.indexOf("left column begins") < snapshotText.indexOf("Fig. 11 shows"));
  assert.doesNotMatch(snapshotText, /Table 2|0\.42|31\.5|Fig\. 12/);
  assert.ok(snapshot.exclusions.some(item => item.reason === "zotero-sdt-table"));
  assert.ok(snapshot.exclusions.some(item => item.reason === "zotero-sdt-caption"));
  assert.ok(snapshot.exclusions.some(item => item.reason === "zotero-sdt-math"));
  assert.equal(snapshot.sdtDiagnostics.mathBlockCount, 1);
  const geometryParagraphs = extractor.makeParagraphs(snapshot.raw, attachment, snapshot.pageMetrics);
  const geometryCandidates = geometryParagraphs.filter(item => item.eligible);
  assert.ok(geometryCandidates.some(item => /Fig\. 11 shows/.test(item.text)));
  assert.ok(geometryCandidates.every(item => !/Table 2|Fig\. 12/.test(item.text)));
  await assert.rejects(
    () => extractor.getCharacterSnapshot({
      _iframeWindow: { PDFViewerApplication: { pdfDocument: { numPages: 1 } } }
    }, []),
    /getPageData/
  );

  const panelState = {
    body: { isConnected: true },
    preview: { value: "" },
    previewLabel: { textContent: "" }
  };

  let exportedPath = "";
  let exportedText = "";
  context.Zotero.DataDirectory = { dir: "/zotero-data" };
  context.IOUtils = {
    async writeUTF8(path, value) {
      exportedPath = path;
      exportedText = value;
    }
  };
  const originalShowMessage = extractor.showMessage;
  extractor.showMessage = () => {};
  const exportButton = { textContent: "导出", disabled: false };
  await extractor.exportRawSegmentation({
    itemID: 42,
    _item: attachment,
    _internalReader: { _primaryView: foreignView }
  }, exportButton, panelState);
  assert.match(exportedPath, /paper-assistant-segments-ATTACH-/);
  const exportedPayload = JSON.parse(exportedText);
  assert.equal(exportedPayload.schema, "reader-text-highlighter.segmentation.v2");
  assert.equal(exportedPayload.extractionSource, "zotero-page-chars");
  assert.ok(exportedPayload.raw.length >= 2);
  assert.ok(Array.isArray(exportedPayload.layoutDiagnostics));
  assert.equal(exportedPayload.textConservation.unassignedCharacterCount, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(exportedPayload, "reconstructed"), false);
  const exportedRawText = exportedPayload.raw.map(item => item.text).join("\n");
  assert.match(exportedRawText, /Variables E, x, and α remain in prose/);
  assert.doesNotMatch(exportedRawText, /Table 2|0\.42|31\.5|Fig\. 12|E = mc2/);
  assert.ok(exportedPayload.exclusions.some(item =>
    ["table-caption", "table-content"].includes(item.reason)));
  assert.ok(exportedPayload.exclusions.some(item => /Fig\. 12/.test(item.text)));
  assert.ok(exportedPayload.exclusions.some(item => item.reason === "equation"));
  assert.equal(Object.prototype.hasOwnProperty.call(exportedPayload.raw[0], "zh"), false);
  assert.equal(exportButton.disabled, false);
  extractor.showMessage = originalShowMessage;

  extractor.setPanelPreview(42, fullText, panelState);
  assert.equal(panelState.preview.value, fullText.text);
  assert.match(panelState.previewLabel.textContent, /3\/3/);
  assert.match(panelState.previewLabel.textContent, /过滤/);

  assert.equal(extractor.isFigureOrTableCaption("Table 1. Numerical accuracy"), true);
  assert.equal(extractor.isFigureOrTableCaption("Fig. 1. Experimental apparatus"), true);
  assert.equal(extractor.isFigureOrTableCaption("Fig. 11 shows the retained body paragraph"), false);

  const bodyLayout = overlay.getTextLayout(
    { eligible: true, reason: "", text: "A regular body paragraph" },
    0
  );
  assert.equal(bodyLayout.indent, true);
  assert.equal(bodyLayout.lineHeight, "1.45");
  const captionLayout = overlay.getTextLayout(
    { eligible: false, reason: "table-caption", text: "Table 1. Caption" },
    0
  );
  assert.equal(captionLayout.indent, false);
  assert.equal(captionLayout.lineHeight, "1.18");

  parentLanguage = "eng";
  let language = await extractor.detectDocumentLanguage(attachment, geometryCandidates);
  assert.equal(language.isEnglish, true);
  assert.equal(language.source, "metadata");
  parentLanguage = "fr";
  language = await extractor.detectDocumentLanguage(attachment, geometryCandidates);
  assert.equal(language.isEnglish, false);
  parentLanguage = "unknown";
  const longEnglish = Array.from({ length: 25 }, (_, i) => ({
    text: `This valid English paragraph number ${i} contains sufficient scientific words for reliable automatic language detection and analysis.`
  }));
  language = await extractor.detectDocumentLanguage(attachment, longEnglish);
  assert.equal(language.isEnglish, true);

  await credentials.validateKey("sk-test");
  assert.equal(requestLog.at(-1).method, "GET");
  assert.match(requestLog.at(-1).url, /\/models$/);
  assert.equal(requestLog.at(-1).options.headers.Authorization, "Bearer sk-test");

  await credentials.saveKey("sk-local-only");
  assert.equal(await credentials.getKey(), "sk-local-only");
  await credentials.deleteKey();
  assert.equal(await credentials.getKey(), "");

  const retryStatuses = [429, 500, 200];
  context.Zotero.HTTP.request = async () => ({
    status: retryStatuses.shift(),
    response: { choices: [{ message: { content: "{}" } }] }
  });
  const completion = await extractor.requestCompletion("secret", { model: "x" }, {
    cancelled: false,
    pendingRequest: null
  });
  assert.ok(completion.choices);
  assert.equal(retryStatuses.length, 0);

  context.Zotero.HTTP.request = async () => ({ status: 401, response: {} });
  await assert.rejects(
    extractor.requestCompletion("expired", {}, { cancelled: false }),
    error => error.status === 401
  );

  let networkAttempts = 0;
  context.Zotero.HTTP.request = async () => {
    networkAttempts++;
    throw new Error("timeout");
  };
  await assert.rejects(
    extractor.requestCompletion("secret", {}, { cancelled: false }),
    /timeout/
  );
  assert.equal(networkAttempts, 4);
  await assert.rejects(
    extractor.requestCompletion("secret", {}, { cancelled: true }),
    /取消/
  );

  const validationBatch = [{
    id: "stable-1",
    text: "The RC strength reached 30 MPa [12] according to Smith et al. (2020)."
  }];
  const validationEntries = extractor.prepareTranslationEntries(validationBatch);
  assert.equal(validationEntries[0].requestID, "p0");
  assert.match(validationEntries[0].text, /__PA0_/);
  const fencedContent = extractor.parseTranslationContent(
    "模型结果如下：\n```json\n{\"translations\":[{\"id\":\"p0\",\"zh\":\"中文 {括号} \\\"引号\\\"\"}]}\n```\n"
  );
  assert.equal(fencedContent.translations[0].zh, "中文 {括号} \"引号\"");
  assert.throws(
    () => extractor.parseTranslationContent('{"translations":[{"id":"p0" "zh":"坏"}]}'),
    error => error.code === "invalid-json" && error.name === "TranslationContentError"
  );
  assert.throws(
    () => extractor.parseTranslationContent(""),
    error => error.code === "empty-response"
  );
  assert.throws(
    () => extractor.parseTranslationContent('{"result":[]}'),
    error => error.code === "invalid-translation-schema"
  );
  let validation = extractor.validateTranslationRows(validationEntries, {
    translations: [{ id: "p0", zh: `中文译文 ${validationEntries[0].text}` }]
  });
  assert.equal(validation.invalid.length, 0);
  assert.match(validation.translations.get("stable-1"), /30 MPa/);
  assert.match(validation.translations.get("stable-1"), /\[12\]/);
  validation = extractor.validateTranslationRows(validationEntries, {
    translations: [{ id: "p0", zh: "中文译文但缺少保真占位符" }]
  });
  assert.equal(validation.invalid.length, 1);
  assert.match(validation.invalid[0].reason, /^missing-placeholders:/);

  let translationAttempts = 0;
  const repairPayloadSizes = [];
  const originalRequestCompletion = extractor.requestCompletion;
  extractor.requestCompletion = async (_key, payload) => {
    translationAttempts++;
    const request = JSON.parse(payload.messages[1].content);
    repairPayloadSizes.push(request.paragraphs.length);
    const translations = request.paragraphs.map(paragraph => ({
      id: paragraph.id,
      zh: translationAttempts === 1
        ? "中文但丢失占位符"
        : `中文译文 ${paragraph.text}`
    }));
    return { choices: [{ message: { content: JSON.stringify({ translations }) } }] };
  };
  const translated = await extractor.translateBatch(
    "secret",
    validationBatch,
    { cancelled: false }
  );
  assert.equal(translationAttempts, 2);
  assert.deepEqual(repairPayloadSizes, [1, 1]);
  assert.equal(translated.failures.size, 0);
  assert.match(translated.translations.get("stable-1"), /30 MPa/);
  extractor.requestCompletion = originalRequestCompletion;

  let malformedAttempts = 0;
  extractor.requestCompletion = async () => {
    malformedAttempts++;
    const content = malformedAttempts === 1
      ? '{"translations":[{"id":"p0" "zh":"错误 JSON"}]}'
      : JSON.stringify({ translations: [{ id: "p0", zh: "修复后的中文译文" }] });
    return { choices: [{ message: { content } }] };
  };
  const malformedRetried = await extractor.translateBatch(
    "secret",
    [{ id: "malformed", text: "This paragraph triggers a malformed response." }],
    { cancelled: false }
  );
  assert.equal(malformedAttempts, 2);
  assert.equal(malformedRetried.failures.size, 0);
  assert.equal(malformedRetried.translations.get("malformed"), "修复后的中文译文");
  extractor.requestCompletion = originalRequestCompletion;

  const contentRetryBatch = [
    { id: "retry-1", text: "The first source paragraph contains enough English prose for translation." },
    { id: "retry-2", text: "The second source paragraph contains enough English prose for translation." }
  ];
  let contentRetryAttempts = 0;
  const contentRetryPayloads = [];
  extractor.requestCompletion = async (_key, payload) => {
    contentRetryAttempts++;
    const request = JSON.parse(payload.messages[1].content);
    contentRetryPayloads.push(request.paragraphs.map(paragraph => paragraph.id));
    if (contentRetryAttempts === 1) {
      return {
        choices: [{ message: { content: JSON.stringify({ translations: [
          { id: "p0", zh: "第一段中文译文" },
          { id: "p1", zh: "" }
        ] }) } }]
      };
    }
    if (contentRetryAttempts < 4) {
      return {
        choices: [{ message: { content: JSON.stringify({ translations: [
          { id: "p1", zh: "" }
        ] }) } }]
      };
    }
    return {
      choices: [{ message: { content: JSON.stringify({ translations: [
        { id: "p1", zh: "第二段中文译文" }
      ] }) } }]
    };
  };
  const contentRetried = await extractor.translateBatch(
    "secret",
    contentRetryBatch,
    { cancelled: false }
  );
  assert.equal(contentRetryAttempts, 4);
  assert.deepEqual(contentRetryPayloads, [["p0", "p1"], ["p1"], ["p1"], ["p1"]]);
  assert.equal(contentRetried.failures.size, 0);
  assert.equal(contentRetried.translations.get("retry-1"), "第一段中文译文");
  assert.equal(contentRetried.translations.get("retry-2"), "第二段中文译文");

  let exhaustedAttempts = 0;
  extractor.requestCompletion = async () => {
    exhaustedAttempts++;
    return { choices: [{ message: { content: JSON.stringify({ translations: [{ id: "p0", zh: "" }] }) } }] };
  };
  const exhausted = await extractor.translateBatch(
    "secret",
    [{ id: "exhausted", text: "This paragraph remains empty in every model response." }],
    { cancelled: false }
  );
  assert.equal(exhaustedAttempts, 4);
  const exhaustedFailure = exhausted.failures.get("exhausted");
  assert.equal(exhaustedFailure.attempts, 4);
  assert.equal(exhaustedFailure.reason, "retry-exhausted:missing-or-empty");
  extractor.requestCompletion = originalRequestCompletion;

  const unordered = [
    { id: "late", order: 2, text: "late paragraph" },
    { id: "early", order: 0, text: "early paragraph" },
    { id: "middle", order: 1, text: "middle paragraph" }
  ];
  const orderedBatches = extractor.makeTranslationBatches(unordered);
  assert.equal(
    JSON.stringify(orderedBatches.flat().map(paragraph => paragraph.id)),
    JSON.stringify(["early", "middle", "late"])
  );

  const originalCacheGet = context.TranslationCache.get;
  const originalCachePut = context.TranslationCache.put;
  const originalRenderParagraph = overlay.renderParagraph;
  const originalRefreshAllPanels = extractor.refreshAllPanels;
  const originalTranslateBatch = extractor.translateBatch;
  const queueRequestOrder = [];
  const queueRenderOrder = [];
  context.TranslationCache.get = async () => null;
  context.TranslationCache.put = async () => {};
  extractor.refreshAllPanels = () => {};
  overlay.renderParagraph = (_session, paragraph) => queueRenderOrder.push(paragraph.id);
  extractor.translateBatch = async (_key, batch) => {
    queueRequestOrder.push(batch[0].id);
    await new Promise(resolve => setTimeout(resolve, batch[0].order === 0 ? 10 : 0));
    return {
      translations: new Map(batch.map(paragraph => [paragraph.id, `中文 ${paragraph.id}`])),
      failures: new Map()
    };
  };
  const queueParagraphs = Array.from({ length: 25 }, (_, index) => ({
    id: `queue-${index}`,
    order: index,
    text: `Queue paragraph ${index}`
  }));
  const queueSession = {
    candidates: queueParagraphs,
    failed: [],
    failureDetails: new Map(),
    cancelled: false,
    paused: false,
    authFailed: false,
    finished: false,
    completed: 0,
    cached: 0,
    total: queueParagraphs.length
  };
  await extractor.runTranslationQueue(queueSession, "secret");
  assert.deepEqual(queueRequestOrder, ["queue-0", "queue-5", "queue-10", "queue-15", "queue-20"]);
  assert.deepEqual(queueRenderOrder, queueParagraphs.map(paragraph => paragraph.id));
  context.TranslationCache.get = originalCacheGet;
  context.TranslationCache.put = originalCachePut;
  overlay.renderParagraph = originalRenderParagraph;
  extractor.refreshAllPanels = originalRefreshAllPanels;
  extractor.translateBatch = originalTranslateBatch;

  for (const badResult of [
    { translations: [] },
    { translations: [{ id: "p0", zh: "" }] },
    { translations: [{ id: "unexpected", zh: "中文译文" }] }
  ]) {
    assert.equal(
      extractor.validateTranslationRows(validationEntries, badResult).invalid.length,
      1
    );
  }

  const splitSource = "第一部分应位于第一页。第二部分应位于第二页。";
  const split = overlay.splitText(splitSource, [{ weight: 1 }, { weight: 1 }]);
  assert.equal(split.join(""), splitSource);
  assert.ok(split[0].length && split[1].length);

  const pageDiv = { getBoundingClientRect: () => ({ left: 100, top: 200 }) };
  const geometrySession = {
    view: {
      _iframeWindow: {
        PDFViewerApplication: { pdfViewer: { _pages: [null, null, null, { div: pageDiv }] } }
      },
      getClientRect(rect, pageIndex) {
        assert.equal(pageIndex, 3);
        assert.equal(JSON.stringify(rect), "[10,20,30,40]");
        return [110, 220, 310, 260];
      }
    }
  };
  assert.equal(
    JSON.stringify(overlay.convertRect(geometrySession, [10, 20, 30, 40], 3)),
    "[10,20,210,60]"
  );

  const fragmentPages = [0, 1, 2].map(() => ({ div: pageDiv }));
  const fragmentSession = {
    view: {
      _iframeWindow: {
        PDFViewerApplication: { pdfViewer: { _pages: fragmentPages } }
      },
      getClientRect(rect) { return [rect[0], rect[1], rect[2], rect[3]]; }
    }
  };
  const fragmentLayout = overlay.getLayoutParts(fragmentSession, {
    position: {
      pageIndex: 0,
      rects: [[10, 10, 100, 22]],
      fragments: [
        { pageIndex: 0, rects: [[10, 10, 100, 22]], sourceCharCount: 12 },
        { pageIndex: 0, rects: [[220, 10, 310, 22]], sourceCharCount: 20 },
        { pageIndex: 1, rects: [[10, 700, 310, 712]], sourceCharCount: 14 }
      ]
    }
  });
  assert.equal(JSON.stringify(fragmentLayout.map(part => part.pageIndex)), "[0,0,1]");
  const weightedSplit = overlay.splitText(
    "第一栏译文。第二栏译文。跨页译文。",
    fragmentLayout.map(part => ({ weight: 1, sourceCharCount: part.sourceCharCount }))
  );
  assert.equal(weightedSplit.join(""), "第一栏译文。第二栏译文。跨页译文。");
  assert.equal(weightedSplit.length, 3);

  const clusters = overlay.clusterRects([
    [10, 10, 100, 22],
    [10, 24, 100, 36],
    [220, 10, 310, 22],
    [220, 24, 310, 36]
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(
    JSON.stringify([clusters[0].left, clusters[0].top, clusters[0].right, clusters[0].bottom]),
    "[10,10,100,36]"
  );
  assert.equal(
    JSON.stringify([clusters[1].left, clusters[1].top, clusters[1].right, clusters[1].bottom]),
    "[220,10,310,36]"
  );

  const oversizedMetrics = overlay.getPartMetrics({
    bounds: { top: 20, bottom: 820 },
    rects: [[10, 20, 1610, 820]]
  }, 2);
  assert.equal(oversizedMetrics.oversized, true);
  assert.equal(oversizedMetrics.rawHeight, 800);
  assert.equal(oversizedMetrics.lineHeight, 24);

  const regularMetrics = overlay.getPartMetrics({
    bounds: { top: 20, bottom: 82 },
    rects: [[10, 20, 310, 38], [10, 42, 310, 60], [10, 64, 310, 82]]
  }, 1.5);
  assert.equal(regularMetrics.oversized, false);
  assert.equal(regularMetrics.lineHeight, 18);

  const colorSession = {
    view: {
      _theme: { background: "#303846", foreground: "#f4f4f4" },
      _iframeWindow: {
        PDFViewerApplication: { pdfViewer: { _pages: [{ div: {} }] } }
      }
    }
  };
  assert.equal(
    JSON.stringify(overlay.getPageColors(colorSession, 0)),
    '{"background":"#303846","foreground":"#f4f4f4"}'
  );

  const fitStyle = {};
  const fitTextNode = {
    style: fitStyle,
    get clientHeight() { return Number.parseFloat(fitStyle.height) || 0; },
    get clientWidth() { return 200; },
    get scrollHeight() { return (Number.parseFloat(fitStyle.fontSize) || 0) * 4; },
    get scrollWidth() { return 180; }
  };
  const fitRecord = {
    root: { style: {} }, textNode: fitTextNode, expand: { style: {} },
    minFont: 6, maxFont: 40, maxHeight: 100, overflowing: false
  };
  overlay.fitText(fitRecord);
  assert.ok(Number.parseFloat(fitStyle.fontSize) > 24.9);
  assert.ok(Number.parseFloat(fitStyle.fontSize) < 25.3);
  assert.equal(fitRecord.root.style.height, "100px");

  assert.match(
    extractor.explainFailureReason("missing-placeholders:__PA0_0__"),
    /占位符缺失/
  );

  const pane = { open: false };
  const itemDetails = {
    pinnedPane: null,
    renderCustomSections() {},
    getEnabledPane: paneID => paneID === "reader-text-highlighter-pane" ? pane : null,
    async scrollToPane(paneID, behavior) {
      assert.equal(paneID, "reader-text-highlighter-pane");
      assert.equal(behavior, "instant");
    }
  };
  let layoutUpdated = false;
  const mainWindow = {
    Zotero_Tabs: { selectedID: "tab-test" },
    ZoteroContextPane: { collapsed: true },
    ZoteroPane: { updateLayout() { layoutUpdated = true; } },
    document: { getElementById: id => id === "tab-test-context" ? itemDetails : null }
  };
  context.Zotero.getMainWindow = () => mainWindow;
  const reader = {
    tabID: "tab-test",
    itemID: 42,
    async setContextPaneOpen(open) { assert.equal(open, true); }
  };
  extractor.revealItemPane(reader);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(layout, "standard");
  assert.equal(layoutUpdated, true);
  assert.equal(mainWindow.ZoteroContextPane.collapsed, false);
  assert.equal(pane.open, true);
  assert.equal(itemDetails.pinnedPane, "reader-text-highlighter-pane");

  console.log("reader translation bootstrap smoke test passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
