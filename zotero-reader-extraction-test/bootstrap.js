const PLUGIN_ID = "reader-text-extraction-test@local.kumiko";
const PLUGIN_VERSION = "0.10.2";
const BUTTON_ID = "reader-text-extraction-test-button";
const EXPORT_BUTTON_ID = "reader-text-extraction-test-export-button";
const LAYER_CLASS = "paper-assistant-extraction-test-layer";
const HIGHLIGHT_CLASS = "paper-assistant-extraction-test-highlight";
const BOUNDARY_CLASS = "paper-assistant-extraction-test-boundary";
const HIGHLIGHT_BACKGROUND = "rgba(255, 221, 0, 0.42)";
const HIGHLIGHT_BORDER = "1px solid rgba(205, 150, 0, 0.72)";
const PARAGRAPH_START_COLOR = "rgba(0, 190, 255, 0.96)";
const PARAGRAPH_END_COLOR = "rgba(255, 70, 110, 0.96)";
const SNAPSHOT_SCHEMA = "reader-text-extraction-test.v10";
const EXTRACTION_MODE = "page-data-body-paragraphs";
const EXTRACTION_SOURCE = "zotero-page-data";

function sleep(milliseconds) {
  return Zotero.Promise?.delay
    ? Zotero.Promise.delay(milliseconds)
    : new Promise(resolve => setTimeout(resolve, milliseconds));
}

var ReaderExtractionOverlay = {
  sessions: new WeakMap(),

  attach(session) {
    const win = session.view?._iframeWindow;
    const eventBus = win?.PDFViewerApplication?.eventBus;
    this.removeExistingLayers(session);
    session.overlayEventHandlers = [];
    const requestLayout = () => this.scheduleRefresh(session, 40);
    if (eventBus && win) {
      let exported = requestLayout;
      try { exported = Components.utils.exportFunction(requestLayout, win); }
      catch (_) {}
      for (const eventName of [
        "pagerendered", "scalechanging", "rotationchanging",
        "pagesloaded", "updateviewarea"
      ]) {
        try {
          eventBus.on(eventName, exported);
          session.overlayEventHandlers.push([eventName, exported]);
        }
        catch (_) {}
      }
    }
    session.overlayPoller = setInterval(() => {
      if (session.cancelled) return;
      const signature = this.getLayoutSignature(session);
      const detached = [...(session.overlayLayers?.values?.() || [])]
        .some(layer => !layer.isConnected);
      if (signature !== session.overlayLayoutSignature || detached) {
        session.overlayLayoutSignature = signature;
        this.scheduleRefresh(session, 0);
      }
    }, 1200);
    session.overlayLayoutSignature = this.getLayoutSignature(session);
    this.sessions.set(session.reader, session);
    this.scheduleRefresh(session, 0);
  },

  removeExistingLayers(session) {
    const pages = session.view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages || [];
    for (const page of pages) {
      const layers = page?.div?.getElementsByClassName?.(LAYER_CLASS) || [];
      while (layers.length) layers[0].remove();
    }
    session.overlayLayers ||= new Map();
    session.overlayLayers.clear();
  },

  detach(session) {
    if (!session) return;
    const eventBus = session.view?._iframeWindow?.PDFViewerApplication?.eventBus;
    for (const [eventName, handler] of session.overlayEventHandlers || []) {
      try { eventBus?.off?.(eventName, handler); }
      catch (_) {}
    }
    if (session.overlayPoller) clearInterval(session.overlayPoller);
    if (session.overlayTimer) clearTimeout(session.overlayTimer);
    if (session.overlaySettleTimer) clearTimeout(session.overlaySettleTimer);
    session.overlayEventHandlers = [];
    session.overlayPoller = null;
    for (const layer of session.overlayLayers?.values?.() || []) layer.remove?.();
    session.overlayLayers?.clear?.();
    this.sessions.delete(session.reader);
  },

  scheduleRefresh(session, delay = 40) {
    if (session.cancelled) return;
    clearTimeout(session.overlayTimer);
    clearTimeout(session.overlaySettleTimer);
    session.overlayTimer = setTimeout(() => this.renderAll(session), delay);
    session.overlaySettleTimer = setTimeout(() => this.renderAll(session), delay + 180);
  },

  getLayoutSignature(session) {
    const viewer = session.view?._iframeWindow?.PDFViewerApplication?.pdfViewer;
    if (!viewer) return "unavailable";
    let signature = `${String(viewer.currentScale || "")}|${String(viewer.pagesRotation || 0)}`;
    for (const page of viewer._pages || []) {
      const viewport = page?.viewport;
      signature += `|${Number(viewport?.width || 0).toFixed(2)}x` +
        `${Number(viewport?.height || 0).toFixed(2)}@${Number(viewport?.rotation || 0)}`;
    }
    return signature;
  },

  getPage(session, pageIndex) {
    return session.view?._iframeWindow?.PDFViewerApplication
      ?.pdfViewer?._pages?.[pageIndex] || null;
  },

  ensureLayer(session, pageIndex) {
    session.overlayLayers ||= new Map();
    const page = this.getPage(session, pageIndex);
    if (!page?.div) return null;
    let layer = session.overlayLayers.get(pageIndex);
    if (layer?.parentNode !== page.div) {
      layer?.remove?.();
      layer = page.div.ownerDocument.createElement("div");
      layer.className = LAYER_CLASS;
      this.style(layer, {
        position: "absolute",
        inset: "0",
        zIndex: "40",
        pointerEvents: "none",
        overflow: "hidden"
      });
      page.div.append(layer);
      session.overlayLayers.set(pageIndex, layer);
    }
    return layer;
  },

  convertRect(session, rect, pageIndex) {
    const page = this.getPage(session, pageIndex);
    const win = session.view?._iframeWindow;
    if (!page?.div || !win || typeof session.view?.getClientRect !== "function") return null;
    let foreignRect = rect;
    try {
      foreignRect = Components.utils.cloneInto(
        [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])], win);
    }
    catch (_) {}
    const client = session.view.getClientRect(foreignRect, pageIndex);
    const pageRect = page.div.getBoundingClientRect();
    const value = [
      Number(client[0]) - Number(pageRect.left),
      Number(client[1]) - Number(pageRect.top),
      Number(client[2]) - Number(pageRect.left),
      Number(client[3]) - Number(pageRect.top)
    ];
    return value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1]
      ? value : null;
  },

  getParagraphFragments(paragraph) {
    return (paragraph?.position?.fragments || []).flatMap(fragment =>
      (fragment?.rects || []).map(rect => ({
        pageIndex: Number(fragment.pageIndex || 0),
        rect
      })));
  },

  renderAll(session) {
    if (session.cancelled || !session.view) return;
    session.overlayLayoutSignature = this.getLayoutSignature(session);
    for (const layer of session.overlayLayers?.values?.() || []) layer.replaceChildren();
    session.highlightedRectCount = 0;
    session.boundaryMarkerCount = 0;
    for (const paragraph of session.raw || []) this.renderParagraph(session, paragraph);
    ReaderExtractionTest.refreshStatus(session);
  },

  renderParagraph(session, paragraph) {
    const fragments = this.getParagraphFragments(paragraph);
    for (const fragment of fragments) {
      const converted = this.convertRect(session, fragment.rect, fragment.pageIndex);
      if (!converted) continue;
      const layer = this.ensureLayer(session, fragment.pageIndex);
      if (!layer) continue;
      const highlight = layer.ownerDocument.createElement("div");
      highlight.className = HIGHLIGHT_CLASS;
      highlight.dataset.sourceIndex = String(paragraph.sourceIndex ?? "");
      highlight.dataset.pageIndex = String(fragment.pageIndex);
      highlight.title = String(paragraph.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
      this.style(highlight, {
        position: "absolute",
        boxSizing: "border-box",
        left: Math.max(0, converted[0]) + "px",
        top: Math.max(0, converted[1]) + "px",
        width: Math.max(1, converted[2] - converted[0]) + "px",
        height: Math.max(1, converted[3] - converted[1]) + "px",
        background: HIGHLIGHT_BACKGROUND,
        border: HIGHLIGHT_BORDER,
        borderRadius: "2px",
        pointerEvents: "none"
      });
      layer.append(highlight);
      session.highlightedRectCount++;
    }
    if (fragments.length) {
      this.renderBoundaryMarker(session, paragraph, fragments[0], "start");
      this.renderBoundaryMarker(session, paragraph, fragments[fragments.length - 1], "end");
    }
  },

  renderBoundaryMarker(session, paragraph, fragment, boundary) {
    const converted = this.convertRect(session, fragment.rect, fragment.pageIndex);
    if (!converted) return;
    const layer = this.ensureLayer(session, fragment.pageIndex);
    if (!layer) return;
    const marker = layer.ownerDocument.createElement("div");
    marker.className = `${BOUNDARY_CLASS} ${BOUNDARY_CLASS}-${boundary}`;
    marker.dataset.sourceIndex = String(paragraph.sourceIndex ?? "");
    marker.dataset.pageIndex = String(fragment.pageIndex);
    marker.dataset.boundary = boundary;
    marker.title = `正文段落 ${Number(paragraph.sourceIndex ?? 0) + 1} ${boundary === "start" ? "开始" : "结束"}`;
    const markerTop = boundary === "start" ? converted[1] - 2 : converted[3];
    this.style(marker, {
      position: "absolute",
      boxSizing: "border-box",
      left: Math.max(0, converted[0] - 2) + "px",
      top: Math.max(0, markerTop) + "px",
      width: Math.max(4, converted[2] - converted[0] + 4) + "px",
      height: "2px",
      background: boundary === "start" ? PARAGRAPH_START_COLOR : PARAGRAPH_END_COLOR,
      borderRadius: "1px",
      boxShadow: "0 0 2px rgba(0, 0, 0, 0.65)",
      pointerEvents: "none"
    });
    layer.append(marker);
    session.boundaryMarkerCount = Number(session.boundaryMarkerCount || 0) + 1;
  },

  style(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  }
};

var ReaderExtractionTest = {
  rootURI: "",
  toolbarHandler: null,
  sessions: new Map(),
  failures: new Map(),
  startingReaders: new Set(),

  async init(rootURI) {
    this.rootURI = rootURI;
    if (typeof ReaderPageDataBodyExtractor === "undefined") {
      Services.scriptloader.loadSubScript(`${rootURI}page-data-body-extractor.js`, globalThis, "UTF-8");
    }
    this.toolbarHandler = this.onRenderToolbar.bind(this);
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, PLUGIN_ID);
    Zotero.debug?.(`[${PLUGIN_ID}] started`);
  },

  shutdown() {
    Zotero.Reader._unregisterEventListenerByPluginID?.(PLUGIN_ID);
    for (const session of this.sessions.values()) this.cancelSession(session);
    this.sessions.clear();
    this.failures.clear();
    this.startingReaders.clear();
    this.toolbarHandler = null;
    Zotero.debug?.(`[${PLUGIN_ID}] stopped`);
  },

  onRenderToolbar({ reader, doc, append }) {
    if (!reader || !doc) return;
    if (!doc.getElementById(BUTTON_ID)) {
      const button = doc.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.className = "toolbar-button wide-button";
      button.textContent = "提取正文测试";
      button.title = "使用 Zotero getPageData 仅提取章节正文段落并标黄";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.extractAndHighlight(reader, true));
      append(button);
    }
    if (!doc.getElementById(EXPORT_BUTTON_ID)) {
      const button = doc.createElement("button");
      button.id = EXPORT_BUTTON_ID;
      button.type = "button";
      button.className = "toolbar-button wide-button";
      button.textContent = "导出提取 JSON";
      button.title = "导出正文、版面诊断和排除统计";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => this.exportSnapshot(reader, button));
      append(button);
    }
    sleep(0).then(() => {
      if (!this.sessions.has(reader.itemID) && !this.failures.has(reader.itemID)) {
        return this.extractAndHighlight(reader, false);
      }
    }).catch(error => this.reportError(error));
  },

  makeFailure(reader, error) {
    return {
      status: "error",
      code: String(error?.code || "page-data-extraction-failed"),
      message: String(error?.message || error),
      generatedAt: new Date().toISOString(),
      attachment: reader?._item || null,
      apiDiagnostics: {
        loaded: false,
        errorCode: String(error?.code || "page-data-extraction-failed"),
        details: error?.diagnostics || null
      }
    };
  },

  async extractAndHighlight(reader, manual = false) {
    if (!reader) return;
    const old = this.sessions.get(reader.itemID);
    if (old && !manual) return;
    if (old) this.cancelSession(old);
    this.sessions.delete(reader.itemID);
    this.failures.delete(reader.itemID);
    if (this.startingReaders.has(reader.itemID)) return;
    this.startingReaders.add(reader.itemID);
    let session = null;
    try {
      const attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
      if (!attachment?.isPDFAttachment?.()) return;
      const snapshot = await this.getReaderSnapshot(reader);
      session = {
        reader,
        attachment,
        view: snapshot.view,
        pageMetrics: snapshot.pageMetrics,
        raw: snapshot.raw,
        extractionSource: snapshot.extractionSource,
        coordinateSystem: snapshot.coordinateSystem,
        extractionMode: snapshot.extractionMode,
        layoutDiagnostics: snapshot.layoutDiagnostics,
        bodyBoundary: snapshot.bodyBoundary,
        characterConservation: snapshot.characterConservation,
        exclusions: snapshot.exclusions,
        retainedAmbiguities: snapshot.retainedAmbiguities,
        extractionSummary: snapshot.extractionSummary,
        cancelled: false,
        overlayLayers: new Map(),
        highlightedRectCount: 0,
        boundaryMarkerCount: 0,
        readerWatcher: null
      };
      this.sessions.set(reader.itemID, session);
      session.readerWatcher = setInterval(() => {
        if (!(Zotero.Reader._readers || []).includes(reader)) {
          this.cancelSession(session);
          this.sessions.delete(reader.itemID);
        }
      }, 1000);
      ReaderExtractionOverlay.attach(session);
      this.refreshStatus(session);
      const excluded = snapshot.exclusions.reduce((sum, item) => sum + Number(item.count || 0), 0);
      this.showMessage(
        "正文识别测试已完成",
        `保留 ${snapshot.raw.length} 段正文，排除 ${excluded} 个非正文块，` +
        `标黄 ${session.highlightedRectCount} 个正文字符矩形；蓝线为段首，红线为段尾。`
      );
    }
    catch (error) {
      if (!session?.cancelled) {
        this.failures.set(reader.itemID, this.makeFailure(reader, error));
        this.reportError(error);
      }
    }
    finally {
      this.startingReaders.delete(reader.itemID);
    }
  },

  async getReaderSnapshot(reader) {
    let view = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      view = reader?._internalReader?._primaryView || null;
      const pdfDocument = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (pdfDocument && typeof pdfDocument.getPageData === "function") break;
      await sleep(50);
    }
    const application = view?._iframeWindow?.PDFViewerApplication;
    const pdfDocument = application?.pdfDocument;
    if (!pdfDocument) {
      const error = new Error("等待 Zotero PDF 阅读器初始化超时。");
      error.code = "reader-initialization-timeout";
      throw error;
    }
    if (typeof pdfDocument.getPageData !== "function") {
      const error = new Error("当前 Zotero Reader 不提供 getPageData 字符接口。");
      error.code = "page-data-api-unavailable";
      throw error;
    }
    if (typeof ReaderPageDataBodyExtractor === "undefined") {
      const error = new Error("getPageData 正文提取器未加载。");
      error.code = "page-data-extractor-unavailable";
      throw error;
    }
    const pages = [];
    const pageMetrics = [];
    const pageCount = Math.max(
      Number(pdfDocument.numPages || 0),
      Number(application?.pdfViewer?._pages?.length || 0)
    );
    if (!pageCount) {
      const error = new Error("当前 PDF 没有可读取页面。");
      error.code = "empty-pdf";
      throw error;
    }
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      let request = { pageIndex };
      try { request = Components.utils.cloneInto(request, view._iframeWindow); }
      catch (_) {}
      const foreignPage = await pdfDocument.getPageData(request);
      if (!foreignPage?.chars) {
        const error = new Error(`第 ${pageIndex + 1} 页没有 getPageData 字符数据。`);
        error.code = "page-character-data-unavailable";
        throw error;
      }
      const viewport = application?.pdfViewer?._pages?.[pageIndex]?.viewport || null;
      const viewBox = this.copyViewBox(foreignPage.viewBox) || this.copyViewBox(viewport?.viewBox);
      const metric = {
        pageIndex,
        width: Number(viewport?.width || (viewBox ? viewBox[2] - viewBox[0] : 0)),
        height: Number(viewport?.height || (viewBox ? viewBox[3] - viewBox[1] : 0)),
        rotation: Number(viewport?.rotation || 0),
        viewBox,
        characterCount: Number(foreignPage.chars.length || 0)
      };
      const chars = this.copyPageCharacters(foreignPage.chars, pageIndex, viewBox, viewport, metric);
      pages.push({ pageIndex, chars, viewBox, metric });
      pageMetrics.push(metric);
    }
    const outlineHints = await this.getPDFOutlineHints(pdfDocument);
    const extracted = ReaderPageDataBodyExtractor.extract({ pages, outlineHints });
    return {
      view,
      pageMetrics,
      raw: extracted.raw,
      extractionSource: EXTRACTION_SOURCE,
      coordinateSystem: "pdf-user-space",
      extractionMode: EXTRACTION_MODE,
      layoutDiagnostics: extracted.layoutDiagnostics,
      bodyBoundary: extracted.bodyBoundary,
      characterConservation: extracted.characterConservation,
      exclusions: extracted.exclusions,
      retainedAmbiguities: extracted.retainedAmbiguities,
      extractionSummary: extracted.summary
    };
  },

  copyViewBox(value) {
    if (!value || Number(value.length || 0) < 4) return null;
    const viewBox = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
    return viewBox.every(Number.isFinite) && viewBox[2] > viewBox[0] && viewBox[3] > viewBox[1]
      ? viewBox : null;
  },

  getViewportRect(rect, viewBox, viewport) {
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
    return [rect[0] - viewBox[0], viewBox[3] - rect[3], rect[2] - viewBox[0], viewBox[3] - rect[1]];
  },

  copyPageCharacters(foreignChars, pageIndex, viewBox, viewport) {
    const chars = [];
    const count = Number(foreignChars?.length || 0);
    for (let offset = 0; offset < count; offset++) {
      const foreign = foreignChars[offset];
      if (!foreign) continue;
      const rect = this.copyRects([foreign.inlineRect || foreign.rect])[0] || null;
      chars.push({
        id: `${pageIndex}:char:${offset}`,
        c: String(foreign.c || ""),
        rect,
        viewportRect: this.getViewportRect(rect, viewBox, viewport),
        fontName: String(foreign.fontName || ""),
        lineBreakAfter: !!foreign.lineBreakAfter,
        paragraphBreakAfter: !!foreign.paragraphBreakAfter,
        spaceAfter: !!foreign.spaceAfter,
        ignorable: !!foreign.ignorable,
        rotation: Number(foreign.rotation || 0)
      });
    }
    return chars;
  },

  async getPDFOutlineHints(pdfDocument) {
    if (typeof pdfDocument?.getOutline !== "function") return [];
    let outline = null;
    try { outline = await pdfDocument.getOutline(); }
    catch (_) { return []; }
    const flattened = [];
    const visit = entries => {
      for (const entry of entries || []) {
        flattened.push(entry);
        visit(entry?.items);
      }
    };
    visit(outline);
    const hints = [];
    for (const entry of flattened.slice(0, 200)) {
      let destination = entry?.dest;
      try {
        if (typeof destination === "string" && typeof pdfDocument.getDestination === "function") {
          destination = await pdfDocument.getDestination(destination);
        }
        let pageIndex = null;
        const reference = Array.isArray(destination) ? destination[0] : null;
        if (Number.isInteger(reference)) pageIndex = Number(reference);
        else if (reference && typeof pdfDocument.getPageIndex === "function") {
          pageIndex = await pdfDocument.getPageIndex(reference);
        }
        if (Number.isInteger(pageIndex) && pageIndex >= 0) {
          hints.push({ title: String(entry?.title || ""), pageIndex });
        }
      }
      catch (_) {}
    }
    return hints;
  },

  copyRects(rects) {
    const copied = [];
    for (const rect of rects || []) {
      if (!rect || Number(rect.length || 0) < 4) continue;
      const value = [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])];
      if (value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1]) copied.push(value);
    }
    return copied;
  },

  serializeRaw(raw) {
    return (raw || []).map((paragraph, index) => ({
      sourceIndex: Number(paragraph.sourceIndex ?? index),
      sourceOrder: Number(paragraph.sourceOrder ?? paragraph.sourceIndex ?? index),
      text: String(paragraph.text || ""),
      contentType: "body-paragraph",
      sourceCharIDs: (paragraph.sourceCharIDs || []).map(String),
      sourceLineIDs: (paragraph.sourceLineIDs || []).map(String),
      mergeReasons: (paragraph.mergeReasons || []).map(String),
      transformedHyphenCount: Number(paragraph.transformedHyphenCount || 0),
      position: {
        pageIndex: Number(paragraph.position?.pageIndex || 0),
        rects: this.copyRects(paragraph.position?.rects),
        fragments: (paragraph.position?.fragments || []).map(fragment => ({
          pageIndex: Number(fragment.pageIndex || 0),
          rects: this.copyRects(fragment.rects),
          coordinateSource: String(fragment.coordinateSource || "zotero-page-char")
        }))
      }
    }));
  },

  async writePayload(reader, record) {
    const attachment = record.attachment || reader?._item || null;
    const directory = Zotero.DataDirectory?.dir;
    if (!directory) throw new Error("无法定位 Zotero 数据目录。");
    const safeKey = String(attachment?.key || reader?.itemID || "reader")
      .replace(/[^A-Za-z0-9._-]+/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = PathUtils.join(directory, `reader-extraction-test-${safeKey}-${stamp}.json`);
    const payload = record.status === "error" ? {
      schema: SNAPSHOT_SCHEMA,
      pluginVersion: PLUGIN_VERSION,
      status: "error",
      generatedAt: record.generatedAt,
      attachment: {
        id: Number(attachment?.id || reader?.itemID || 0),
        libraryID: Number(attachment?.libraryID || 0),
        key: String(attachment?.key || "")
      },
      extractionSource: EXTRACTION_SOURCE,
      extractionMode: EXTRACTION_MODE,
      error: { code: record.code, message: record.message },
      apiDiagnostics: record.apiDiagnostics,
      raw: []
    } : {
      schema: SNAPSHOT_SCHEMA,
      pluginVersion: PLUGIN_VERSION,
      status: "ok",
      generatedAt: new Date().toISOString(),
      attachment: {
        id: Number(attachment?.id || reader?.itemID || 0),
        libraryID: Number(attachment?.libraryID || 0),
        key: String(attachment?.key || "")
      },
      pageMetrics: record.pageMetrics,
      extractionSource: record.extractionSource,
      coordinateSystem: record.coordinateSystem,
      extractionMode: record.extractionMode,
      layoutDiagnostics: record.layoutDiagnostics,
      bodyBoundary: record.bodyBoundary,
      characterConservation: record.characterConservation,
      exclusions: record.exclusions,
      retainedAmbiguities: record.retainedAmbiguities,
      extractionSummary: record.extractionSummary,
      raw: this.serializeRaw(record.raw)
    };
    const serialized = JSON.stringify(payload, null, 2);
    if (typeof IOUtils !== "undefined" && typeof IOUtils.writeUTF8 === "function") {
      await IOUtils.writeUTF8(path, serialized);
    }
    else if (Zotero.File?.putContentsAsync) {
      await Zotero.File.putContentsAsync(path, serialized);
    }
    else {
      throw new Error("当前 Zotero 未提供 UTF-8 文件写入接口。");
    }
    return path;
  },

  async exportSnapshot(reader, button) {
    const record = this.sessions.get(reader?.itemID) || this.failures.get(reader?.itemID);
    if (!record) {
      this.showMessage("尚未执行正文提取", "请先点击“提取正文测试”。", true);
      return;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "导出中…";
    try {
      const path = await this.writePayload(reader, record);
      this.showMessage(record.status === "error" ? "失败诊断 JSON 已导出" : "正文提取 JSON 已导出", path);
    }
    catch (error) {
      this.reportError(error);
    }
    finally {
      button.disabled = false;
      button.textContent = original;
    }
  },

  cancelSession(session) {
    if (!session) return;
    session.cancelled = true;
    if (session.readerWatcher) clearInterval(session.readerWatcher);
    session.readerWatcher = null;
    ReaderExtractionOverlay.detach(session);
  },

  refreshStatus(session) {
    if (!session || session.cancelled) return;
    const excluded = (session.exclusions || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
    const columns = (session.layoutDiagnostics || []).filter(page => page.columnCount === 2).length;
    const message = `getPageData 正文识别：保留 ${session.raw.length} 段 · 排除 ${excluded} 行 · ` +
      `双栏页面 ${columns} · ` +
      `已标黄 ${session.highlightedRectCount} 个矩形 · 段落标记线 ${session.boundaryMarkerCount || 0} 条`;
    Zotero.debug?.(`[${PLUGIN_ID}] ${message}`);
    Zotero.debug?.(`[${PLUGIN_ID}] layout diagnostics: ${JSON.stringify(session.layoutDiagnostics || {})}`);
  },

  showMessage(headline, description, isError = false) {
    if (typeof Zotero.ProgressWindow !== "function") return;
    const progressWindow = new Zotero.ProgressWindow();
    progressWindow.changeHeadline(headline);
    progressWindow.addDescription(description);
    progressWindow.show();
    progressWindow.startCloseTimer(isError ? 8000 : 5000);
  },

  reportError(error) {
    Zotero.logError?.(error);
    this.showMessage("正文提取测试失败", error?.message || String(error), true);
  }
};

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await ReaderExtractionTest.init(rootURI);
}

function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) ReaderExtractionTest.shutdown();
}

function install() {}
function uninstall() {}
