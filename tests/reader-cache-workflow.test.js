"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadModule,
  loadSelectionTranslationContext,
  makeSelectionPosition
} = require("./helpers");

function loadWorkflowContext() {
  const context = loadSelectionTranslationContext();
  loadModule(context, "translation-workflows.js");
  return context;
}

function makePopupDocument() {
  const document = {
    nodes: [],
    createElement(tagName) {
      const node = {
        tagName: String(tagName).toUpperCase(),
        className: "",
        dataset: {},
        style: {},
        children: [],
        listeners: {},
        append(...children) {
          this.children.push(...children);
        },
        setAttribute(name, value) {
          this.attributes = this.attributes || {};
          this.attributes[name] = String(value);
        },
        addEventListener(type, handler) {
          this.listeners[type] = handler;
        },
        remove() {
          this.removed = true;
          const index = document.nodes.indexOf(this);
          if (index >= 0) document.nodes.splice(index, 1);
        }
      };
      return node;
    },
    querySelectorAll(selector) {
      if (selector !== ".reader-selection-replacer-test-popup") return [];
      return this.nodes.filter(node => node.className === "reader-selection-replacer-test-popup");
    },
    append(node) {
      this.nodes.push(node);
    }
  };
  return document;
}

test("selection popup replaces its own container and binds the latest selection", async function () {
  const context = loadWorkflowContext();
  loadModule(context, "app-controller.js");
  const app = context.SelectionReplacerTest;
  const document = makePopupDocument();
  const reader = {};
  const firstAnnotation = { text: "First selection", position: { pageIndex: 0 } };
  const secondAnnotation = { text: "Second selection", position: { pageIndex: 0 } };
  const calls = [];
  app.translateSelection = async function (...args) {
    calls.push(args);
  };
  const append = document.append.bind(document);

  app.onRenderTextSelectionPopup({
    reader, doc: document, params: { annotation: firstAnnotation }, append
  });
  app.onRenderTextSelectionPopup({
    reader, doc: document, params: { annotation: secondAnnotation }, append
  });

  const containers = document.querySelectorAll(".reader-selection-replacer-test-popup");
  assert.equal(containers.length, 1);
  const button = containers[0].children[0].children[0];
  button.listeners.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], secondAnnotation);
  assert.equal(calls[0][2], "Second selection");
});

test("Reader listeners are registered once and unregistered by their concrete handlers", function () {
  const context = loadWorkflowContext();
  loadModule(context, "app-controller.js");
  const registrations = [];
  const unregistrations = [];
  const fallbackCalls = [];
  context.Zotero.Reader = {
    registerEventListener(...args) {
      registrations.push(args);
    },
    unregisterEventListener(...args) {
      unregistrations.push(args);
    },
    _unregisterEventListenerByPluginID(pluginID) {
      fallbackCalls.push(pluginID);
    }
  };
  const app = context.SelectionReplacerTest;

  assert.equal(app.registerReaderListeners(), true);
  assert.equal(app.registerReaderListeners(), true);
  assert.equal(registrations.length, 2);
  assert.equal(app.readerEventHandlers.size, 2);

  app.unregisterReaderListeners();
  assert.equal(unregistrations.length, 2);
  assert.equal(unregistrations[0][0], "renderTextSelectionPopup");
  assert.equal(unregistrations[0][1], registrations[0][1]);
  assert.equal(unregistrations[1][0], "renderToolbar");
  assert.equal(unregistrations[1][1], registrations[1][1]);
  assert.equal(fallbackCalls.length, 0);
  assert.equal(app.readerEventHandlers.size, 0);
  assert.equal(app.readerListenersRegistered.size, 0);
});

test("Reader listener cleanup falls back to plugin ID on older Zotero APIs", function () {
  const context = loadWorkflowContext();
  loadModule(context, "app-controller.js");
  const fallbackCalls = [];
  context.Zotero.Reader = {
    registerEventListener() {},
    _unregisterEventListenerByPluginID(pluginID) {
      fallbackCalls.push(pluginID);
    }
  };
  const app = context.SelectionReplacerTest;
  app.registerReaderListeners();
  app.unregisterReaderListeners();
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0], context.TranslatorCore.PLUGIN_ID);
});

test("Reader hydration rebuilds a persisted selection as a cached overlay", async function () {
  const context = loadWorkflowContext();
  const match = context.ReaderSelectionBlock.create({
    view: null,
    position: makeSelectionPosition(0, [
      [20, 100, 180, 112],
      [20, 130, 180, 142]
    ], { flowID: "flow-1", lineIDs: ["line-1", "line-2"] }),
    sourceText: "First persisted unit.\n\nSecond persisted unit."
  });
  const segment = context.ContentSegments.fromSelectionBlock(match)[0];
  const attachment = {
    id: 11,
    libraryID: 3,
    key: "ATTACHMENT",
    parentID: 12,
    attachmentHash: "stable-pdf"
  };
  const identity = {
    libraryID: 3,
    attachmentKey: "ATTACHMENT",
    attachmentItemID: 11,
    parentItemID: 12,
    fileFingerprint: "hash:stable-pdf",
    usable: true
  };
  const cache = context.SegmentTranslationCache;
  const key = cache.key(attachment, segment, "zh-CN", null, identity);
  const translated = {
    translatedText: "第一段译文\n\n第二段译文",
    translatedUnits: segment.metadata.selectionUnits.map((unit, index) => ({
      id: unit.id,
      translatedText: index === 0 ? "第一段译文" : "第二段译文",
      breakAfter: unit.breakAfter
    }))
  };
  const row = {
    recordID: key.recordID,
    sourceText: segment.sourceText,
    sourceUnits: segment.metadata.selectionUnits,
    position: segment.position,
    positionSignature: key.positionSignature,
    translatedText: context.encodeCachedTranslation(segment, translated),
    provider: "gemini",
    model: "gemini-2.5-flash",
    promptVersion: cache.promptVersion(segment)
  };
  cache.listForAttachment = async () => [row];
  cache.get = async () => row;
  const attached = [];
  context.SelectionReplacerOverlay = {
    attach: (...args) => attached.push(args)
  };

  await context.TranslatorWorkflows.restorePersistedSelections(
    {}, {}, attachment, identity);
  assert.equal(attached.length, 1);
  assert.equal(attached[0][3].recordID, key.recordID);
  assert.equal(attached[0][3].translationPending, false);
  assert.equal(attached[0][3].translations.get("selection-block").status, "cached");
  assert.equal(
    attached[0][3].translations.get("selection-block").translatedText,
    "第一段译文\n\n第二段译文"
  );
});

test("Reader hydration skips malformed positions and unit mismatches without throwing", async function () {
  const context = loadWorkflowContext();
  const cache = context.SegmentTranslationCache;
  cache.listForAttachment = async () => [
    {
      recordID: "broken-position",
      sourceText: "Broken selection",
      sourceUnits: [{ id: "unit-0", sourceText: "Broken selection", breakAfter: "none" }],
      position: { fragments: [{ pageIndex: 0, rects: [[1, 2]] }] },
      positionSignature: "not-the-signature",
      translatedText: "{broken",
      promptVersion: "selection-translation-v4-layout-structure"
    }
  ];
  cache.get = async () => null;
  const attached = [];
  context.SelectionReplacerOverlay = { attach: (...args) => attached.push(args) };
  await assert.doesNotReject(() => context.TranslatorWorkflows.restorePersistedSelections(
    {}, {}, { id: 1, libraryID: 1, key: "A" }, {
      libraryID: 1,
      attachmentKey: "A",
      fileFingerprint: "hash:x",
      usable: true
    }
  ));
  assert.equal(attached.length, 0);
});

test("Reader hydration restores persisted cross-page selections through the fallback block", async function () {
  const context = loadWorkflowContext();
  const cache = context.SegmentTranslationCache;
  const attachment = { id: 11, libraryID: 3, key: "ATTACHMENT", parentID: 12 };
  const identity = {
    libraryID: 3,
    attachmentKey: "ATTACHMENT",
    attachmentItemID: 11,
    parentItemID: 12,
    fileFingerprint: "hash:x",
    usable: true
  };
  const position = {
    fragments: [
      { pageIndex: 0, flowID: "flow-1", lineIDs: ["line-1"], rects: [[1, 2, 20, 12]] },
      { pageIndex: 1, flowID: "flow-1", lineIDs: ["line-2"], rects: [[1, 2, 20, 12]] }
    ]
  };
  const match = context.ReaderSelectionBlock.create({
    view: null, position, sourceText: "Cross page selection"
  });
  const segment = context.ContentSegments.fromSelectionBlock(match)[0];
  const key = cache.key(attachment, segment, "zh-CN", null, identity);
  const row = {
    recordID: key.recordID,
    sourceText: segment.sourceText,
    sourceUnits: segment.metadata.selectionUnits,
    position: segment.position,
    positionSignature: key.positionSignature,
    translatedText: context.encodeCachedTranslation(segment, {
      translatedText: "旧译文",
      translatedUnits: [{ id: "unit-0", translatedText: "旧译文", breakAfter: "none" }]
    })
  };
  let cacheGets = 0;
  cache.listForAttachment = async () => [row];
  cache.get = async () => {
    cacheGets++;
    return row;
  };
  const attached = [];
  context.SelectionReplacerOverlay = { attach: (...args) => attached.push(args) };

  await context.TranslatorWorkflows.restorePersistedSelections(
    {}, {}, attachment, identity
  );
  assert.equal(cacheGets, 1);
  assert.equal(attached.length, 1);
  assert.equal(attached[0][2].blocks.length, 2);
  assert.equal(attached[0][3].translations.get("selection-block").status, "cached");
});

test("translateSelection continues with cross-page layout fallback", async function () {
  const context = loadWorkflowContext();
  loadModule(context, "app-controller.js");
  const app = context.SelectionReplacerTest;
  const view = {
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: { numPages: 2 },
        pdfViewer: { _pages: [] }
      }
    }
  };
  const reader = { _internalReader: { _primaryView: view } };
  const position = {
    fragments: [
      { pageIndex: 0, flowID: "flow-1", lineIDs: ["line-1"], rects: [[1, 2, 20, 12]] },
      { pageIndex: 1, flowID: "flow-1", lineIDs: ["line-2"], rects: [[1, 2, 20, 12]] }
    ]
  };
  let contextCalls = 0;
  app.getReaderCacheContext = async function () {
    contextCalls++;
    return {
      attachment: { id: 11, libraryID: 3, key: "ATTACHMENT" },
      identity: { fileFingerprint: "hash:x", usable: true },
      view
    };
  };
  let translationCalls = 0;
  context.TranslationCoordinator.translateSegments = async function ({ segments }) {
    translationCalls++;
    return {
      results: new Map([[segments[0].id, {
        segmentID: segments[0].id,
        status: "translated",
        translatedText: "跨页译文",
        translatedUnits: [],
        recordID: ""
      }]]),
      diagnostics: { translated: 1, cached: 0, failed: 0, skipped: 0 }
    };
  };
  let overlayCalls = 0;
  context.SelectionReplacerOverlay = {
    states: new Map(),
    attach: function () { overlayCalls++; }
  };
  const status = { textContent: "" };
  const button = { disabled: false };

  await app.translateSelection(reader, { position }, "Cross page selection", status, button);
  assert.equal(status.textContent, "划选翻译完成：1/1");
  assert.equal(button.disabled, false);
  assert.equal(contextCalls, 1);
  assert.equal(translationCalls, 1);
  assert.equal(overlayCalls, 2);
});
