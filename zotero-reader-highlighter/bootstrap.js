const PLUGIN_ID = "reader-text-highlighter@local.kumiko";
const PLUGIN_VERSION = "0.8.1";
const BUTTON_ID = "reader-text-highlighter-button";
const PANE_ID = "reader-text-highlighter-pane";
const ACTION_COLOR = "#2f6fbb";
const DEEPSEEK_ORIGIN = "chrome://paper-assistant";
const DEEPSEEK_REALM = "DeepSeek API";
const DEEPSEEK_USERNAME = "default";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const PROMPT_VERSION = "body-translation-v2";
const CACHE_FILE = "paper-assistant-translations.sqlite";
const SKIP_PROMPT_PREF = "extensions.reader-text-highlighter.skipAPIKeyPrompt";
const MAX_BATCH_PARAGRAPHS = 5;
const MAX_BATCH_CHARACTERS = 2600;
const TRANSLATION_CONCURRENCY = 4;
const NETWORK_RETRY_DELAYS = [1000, 3000, 8000];
const CONTENT_RETRY_DELAYS = [1000, 3000, 8000];
const CONTENT_MAX_RETRIES = 3;
const PARAGRAPH_LAYOUT_VERSION = "geometry-v3";
const SEGMENTATION_DIAGNOSTIC_SCHEMA = "reader-text-highlighter.segmentation.v2";
const BODY_TRANSLATION_LINE_HEIGHT = 1.45;
const BODY_TRANSLATION_INDENT = "　　";

function makeTranslationContentError(code, message) {
  const error = new Error(message);
  error.name = "TranslationContentError";
  error.code = code;
  return error;
}

function extractBalancedJSONCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const stack = [opening === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === "}" || character === "]") {
        if (stack[stack.length - 1] !== character) {
          stack.length = 0;
          break;
        }
        stack.pop();
        if (!stack.length) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseJSONResponse(response) {
  if (response && typeof response.response === "object") {
    return response.response;
  }
  const text = response?.responseText ?? response?.response;
  return typeof text === "string" && text ? JSON.parse(text) : {};
}

function simpleHash(text) {
  const value = String(text || "");
  try {
    return Zotero.Utilities.Internal.md5(value);
  }
  catch (_) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}

function sleep(milliseconds) {
  return Zotero.Promise?.delay
    ? Zotero.Promise.delay(milliseconds)
    : new Promise(resolve => setTimeout(resolve, milliseconds));
}

var DeepSeekCredentials = {
  async findLogin() {
    const query = { origin: DEEPSEEK_ORIGIN, httpRealm: DEEPSEEK_REALM };
    let logins = [];
    if (Services.logins.searchLoginsAsync) {
      logins = await Services.logins.searchLoginsAsync(query);
    }
    else {
      logins = Services.logins.findLogins(DEEPSEEK_ORIGIN, null, DEEPSEEK_REALM);
    }
    return logins.find(login => login.username === DEEPSEEK_USERNAME) || null;
  },

  async getKey() {
    return (await this.findLogin())?.password || "";
  },

  async saveKey(apiKey) {
    await this.deleteKey();
    const LoginInfo = new Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      Components.interfaces.nsILoginInfo,
      "init"
    );
    const login = new LoginInfo(
      DEEPSEEK_ORIGIN,
      null,
      DEEPSEEK_REALM,
      DEEPSEEK_USERNAME,
      apiKey,
      "",
      ""
    );
    if (Services.logins.addLoginAsync) {
      await Services.logins.addLoginAsync(login);
    }
    else {
      Services.logins.addLogin(login);
    }
  },

  async deleteKey() {
    const login = await this.findLogin();
    if (login) {
      Services.logins.removeLogin(login);
    }
  },

  async validateKey(apiKey) {
    if (!apiKey?.trim()) {
      throw new Error("API Key 不能为空。");
    }
    let response;
    try {
      response = await Zotero.HTTP.request(
        "GET",
        `${DEEPSEEK_BASE_URL}/models`,
        {
          headers: { Authorization: `Bearer ${apiKey.trim()}` },
          responseType: "json",
          timeout: 20000,
          successCodes: false
        }
      );
    }
    catch (error) {
      throw new Error(`无法连接 DeepSeek：${error.message || error}`);
    }
    const status = Number(response?.status || 0);
    if (status === 401 || status === 403) {
      throw new Error("API Key 无效或无权访问 DeepSeek。");
    }
    if (status < 200 || status >= 300) {
      throw new Error(`DeepSeek 验证失败（HTTP ${status || "未知"}）。`);
    }
    const data = parseJSONResponse(response);
    const modelIDs = Array.isArray(data?.data)
      ? data.data.map(model => model?.id).filter(Boolean)
      : [];
    if (!modelIDs.includes(DEEPSEEK_MODEL)) {
      throw new Error(`当前账户未返回可用模型 ${DEEPSEEK_MODEL}。`);
    }
    return true;
  }
};

var TranslationCache = {
  db: null,
  readyPromise: null,

  init() {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = (async () => {
      if (!Zotero.DBConnection || !Zotero.DataDirectory?.dir) {
        return;
      }
      const path = PathUtils.join(Zotero.DataDirectory.dir, CACHE_FILE);
      this.db = new Zotero.DBConnection(path);
      await this.db.queryAsync(`
        CREATE TABLE IF NOT EXISTS translations (
          library_id INTEGER NOT NULL,
          attachment_key TEXT NOT NULL,
          page_index INTEGER NOT NULL,
          position_signature TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          zh_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          error_message TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (
            library_id, attachment_key, page_index, position_signature,
            source_hash, model, prompt_version
          )
        )
      `);
      const columns = await this.db.queryAsync("PRAGMA table_info(translations)");
      if (!columns.some(column => column.name === "error_message")) {
        await this.db.queryAsync(
          "ALTER TABLE translations ADD COLUMN error_message TEXT NOT NULL DEFAULT ''"
        );
      }
    })().catch(error => {
      this.db = null;
      Zotero.logError(error);
    });
    return this.readyPromise;
  },

  async get(paragraph) {
    await this.init();
    if (!this.db) {
      return null;
    }
    const rows = await this.db.queryAsync(
      `SELECT zh_text AS zhText, status, error_message AS errorMessage,
              created_at AS createdAt
       FROM translations
       WHERE library_id=? AND attachment_key=? AND page_index=?
         AND position_signature=? AND source_hash=? AND model=?
         AND prompt_version=?`,
      [
        paragraph.libraryID,
        paragraph.attachmentKey,
        paragraph.pageIndex,
        paragraph.positionSignature,
        paragraph.sourceHash,
        DEEPSEEK_MODEL,
        PROMPT_VERSION
      ]
    );
    return rows?.[0] || null;
  },

  async put(paragraph, zhText, status = "complete", errorMessage = "") {
    await this.init();
    if (!this.db) {
      return;
    }
    await this.db.queryAsync(
      `INSERT OR REPLACE INTO translations (
         library_id, attachment_key, page_index, position_signature,
         source_hash, model, prompt_version, zh_text, status, error_message,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paragraph.libraryID,
        paragraph.attachmentKey,
        paragraph.pageIndex,
        paragraph.positionSignature,
        paragraph.sourceHash,
        DEEPSEEK_MODEL,
        PROMPT_VERSION,
        zhText || "",
        status,
        String(errorMessage || "").slice(0, 500),
        Date.now()
      ]
    );
  },

  async deleteForAttachment(libraryID, attachmentKey) {
    await this.init();
    if (this.db) {
      await this.db.queryAsync(
        "DELETE FROM translations WHERE library_id=? AND attachment_key=?",
        [libraryID, attachmentKey]
      );
    }
  },

  async close() {
    if (this.db) {
      await this.db.closeDatabase();
      this.db = null;
    }
    this.readyPromise = null;
  }
};

// 0.7 layout engine. Reader coordinates are converted by Zotero itself after
// cloning each rect into the PDF iframe compartment. This keeps translation
// geometry aligned with zoom, rotation, spread mode and page rerenders.
var ReaderOverlay = {
  sessions: new WeakMap(),

  attach(session) {
    const win = session.view?._iframeWindow;
    const eventBus = win?.PDFViewerApplication?.eventBus;
    this.removeExistingLayers(session);
    session.overlayEventHandlers = [];
    const requestLayout = () => this.scheduleRefresh(session, 40);
    if (eventBus && win) {
      let exported = requestLayout;
      try {
        exported = Components.utils.exportFunction(requestLayout, win);
      }
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
  },

  removeExistingLayers(session) {
    const pages = session.view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages || [];
    for (let pageIndex = 0; pageIndex < Number(pages.length || 0); pageIndex++) {
      const page = pages[pageIndex];
      const layers = page?.div?.getElementsByClassName?.("paper-assistant-translation-layer-v2") || [];
      while (layers.length) layers[0].remove();
    }
    session.overlayLayers ||= new Map();
    session.overlayLayers.clear();
    for (const paragraph of session.paragraphs || []) paragraph.overlayNodes = [];
  },

  detach(session) {
    if (!session) return;
    const eventBus = session.view?._iframeWindow?.PDFViewerApplication?.eventBus;
    for (const [eventName, handler] of session.overlayEventHandlers || []) {
      try { eventBus?.off?.(eventName, handler); } catch (_) {}
    }
    session.overlayEventHandlers = [];
    if (session.overlayPoller) clearInterval(session.overlayPoller);
    if (session.overlayTimer) clearTimeout(session.overlayTimer);
    if (session.overlaySettleTimer) clearTimeout(session.overlaySettleTimer);
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
    // PDF.js fires scalechanging before every page has its final viewport.
    session.overlaySettleTimer = setTimeout(() => this.renderAll(session), delay + 180);
  },

  getLayoutSignature(session) {
    const viewer = session.view?._iframeWindow?.PDFViewerApplication?.pdfViewer;
    if (!viewer) return "unavailable";
    let signature = String(viewer.currentScale || "") + "|" + String(viewer.pagesRotation || 0);
    const pages = viewer._pages;
    const count = Number(pages?.length || 0);
    for (let index = 0; index < count; index++) {
      const viewport = pages[index]?.viewport;
      signature += "|" + Number(viewport?.width || 0).toFixed(2) + "x" +
        Number(viewport?.height || 0).toFixed(2) + "@" + Number(viewport?.rotation || 0);
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
      layer.className = "paper-assistant-translation-layer-v2";
      this.style(layer, {
        position: "absolute", inset: "0", zIndex: "35",
        pointerEvents: "none", overflow: "hidden"
      });
      page.div.append(layer);
      session.overlayLayers.set(pageIndex, layer);
    }
    const siblings = page.div.getElementsByClassName?.("paper-assistant-translation-layer-v2") || [];
    for (let index = siblings.length - 1; index >= 0; index--) {
      if (siblings[index] !== layer) siblings[index].remove();
    }
    return layer;
  },

  convertRect(session, rect, pageIndex) {
    const page = this.getPage(session, pageIndex);
    const win = session.view?._iframeWindow;
    if (!page?.div || !win) return null;
    let foreignRect = rect;
    try {
      foreignRect = Components.utils.cloneInto(
        [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])],
        win
      );
    }
    catch (_) {}
    const client = session.view.getClientRect(foreignRect, pageIndex);
    const pageRect = page.div.getBoundingClientRect();
    return [
      Number(client[0]) - Number(pageRect.left),
      Number(client[1]) - Number(pageRect.top),
      Number(client[2]) - Number(pageRect.left),
      Number(client[3]) - Number(pageRect.top)
    ];
  },

  clusterRects(rects) {
    const ordered = rects.filter(Boolean);
    if (!ordered.length) return [];
    const heights = ordered.map(rect => Math.max(1, rect[3] - rect[1])).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
    const groups = [];
    for (const rect of ordered) {
      const width = Math.max(1, rect[2] - rect[0]);
      const previous = groups.at(-1);
      const overlap = previous
        ? Math.max(0, Math.min(previous.right, rect[2]) - Math.max(previous.left, rect[0])) : 0;
      const overlapRatio = previous
        ? overlap / Math.max(1, Math.min(previous.width, width)) : 0;
      const verticalGap = previous ? rect[1] - previous.bottom : 0;
      const contiguous = previous && overlapRatio >= 0.42 &&
        verticalGap <= medianHeight * 2.2 && verticalGap >= -medianHeight;
      let best = previous;
      if (!contiguous) {
        best = { rects: [], left: rect[0], top: rect[1], right: rect[2], bottom: rect[3], width };
        groups.push(best);
      }
      best.rects.push(rect);
      best.left = Math.min(best.left, rect[0]);
      best.top = Math.min(best.top, rect[1]);
      best.right = Math.max(best.right, rect[2]);
      best.bottom = Math.max(best.bottom, rect[3]);
      best.width = best.right - best.left;
    }
    return groups;
  },

  getPartMetrics(part, scale) {
    const rawHeight = Math.max(10, part.bounds.bottom - part.bounds.top);
    const nominalLineHeight = Math.max(8, 12 * Math.max(0.5, Number(scale) || 1));
    const heights = part.rects
      .map(rect => Math.max(1, rect[3] - rect[1]))
      .sort((a, b) => a - b);
    const rawMedian = heights[Math.floor(heights.length / 2)] || nominalLineHeight;
    const lineHeight = rawMedian < nominalLineHeight * 0.35 || rawMedian > nominalLineHeight * 2.2
      ? nominalLineHeight
      : rawMedian;
    const oversized = rawHeight > lineHeight * Math.max(4, part.rects.length * 2.4);
    return { rawHeight, lineHeight, oversized };
  },

  getPageColors(session, pageIndex) {
    const page = this.getPage(session, pageIndex);
    const doc = page?.div?.ownerDocument;
    const root = doc?.documentElement;
    const computed = root && doc?.defaultView?.getComputedStyle?.(root);
    const usable = value => {
      const normalized = String(value || "").trim().toLowerCase();
      return normalized && normalized !== "transparent" && normalized !== "rgba(0, 0, 0, 0)";
    };
    const theme = session.view?._theme || {};
    const pageStyle = page?.div && doc?.defaultView?.getComputedStyle?.(page.div);
    const backgroundCandidates = [
      theme.background,
      computed?.getPropertyValue?.("--background-color"),
      pageStyle?.backgroundColor
    ];
    const foregroundCandidates = [
      theme.foreground,
      computed?.getPropertyValue?.("--text-color"),
      computed?.color
    ];
    return {
      background: backgroundCandidates.find(usable) || "#ffffff",
      foreground: foregroundCandidates.find(usable) || "#121212"
    };
  },

  getLayoutParts(session, paragraph) {
    const position = paragraph.position;
    const sources = position.fragments?.length
      ? position.fragments.map(fragment => ({
        pageIndex: fragment.pageIndex,
        rects: fragment.rects || [],
        sourceCharCount: Number(fragment.sourceCharCount || 0)
      }))
      : [{ pageIndex: position.pageIndex, rects: position.rects || [] }];
    if (!position.fragments?.length && position.nextPageRects?.length) {
      sources.push({ pageIndex: position.pageIndex + 1, rects: position.nextPageRects });
    }
    const parts = [];
    for (const source of sources) {
      const converted = [];
      for (const rect of source.rects) {
        const value = this.convertRect(session, rect, source.pageIndex);
        if (value) converted.push(value);
      }
      const clusters = this.clusterRects(converted);
      const sourceCharCount = Number(source.sourceCharCount || 0);
      for (const cluster of clusters) {
        parts.push({
          pageIndex: source.pageIndex,
          rects: cluster.rects,
          bounds: cluster,
          weight: Math.max(1, cluster.width * (cluster.bottom - cluster.top)),
          sourceCharCount: sourceCharCount
            ? Math.max(1, sourceCharCount / Math.max(1, clusters.length)) : 0
        });
      }
    }
    return parts;
  },

  splitText(text, parts) {
    if (parts.length <= 1) return [text];
    const hasSourceWeights = parts.some(part => Number(part.sourceCharCount) > 0);
    const total = parts.reduce((sum, part) => sum +
      (hasSourceWeights ? Number(part.sourceCharCount || 0) : part.weight), 0);
    const chunks = [];
    let consumed = 0;
    let remaining = text;
    for (let index = 0; index < parts.length - 1; index++) {
      consumed += hasSourceWeights ? Number(parts[index].sourceCharCount || 0) : parts[index].weight;
      const target = Math.max(1, Math.min(remaining.length - 1,
        Math.round(text.length * consumed / total) - chunks.join("").length));
      const from = Math.max(1, target - 24);
      const to = Math.min(remaining.length - 1, target + 24);
      let splitAt = target;
      for (let cursor = from; cursor <= to; cursor++) {
        if (/[。！？；，.!?;,:]/.test(remaining[cursor])) {
          if (Math.abs(cursor - target) < Math.abs(splitAt - target)) splitAt = cursor + 1;
        }
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    chunks.push(remaining);
    return chunks;
  },

  renderAll(session) {
    if (session.cancelled || !session.view) return;
    session.overlayLayoutSignature = this.getLayoutSignature(session);
    for (const layer of session.overlayLayers?.values?.() || []) layer.replaceChildren();
    for (const paragraph of session.paragraphs || []) paragraph.overlayNodes = [];
    for (const paragraph of session.paragraphs || []) {
      if (paragraph.zh) this.renderParagraph(session, paragraph);
    }
  },

  renderParagraph(session, paragraph) {
    if (!paragraph.zh || !session.view) return;
    for (const node of paragraph.overlayNodes || []) node.root?.remove?.();
    paragraph.overlayNodes = [];
    const parts = this.getLayoutParts(session, paragraph);
    const chunks = this.splitText(paragraph.zh, parts);
    parts.forEach((part, index) => {
      const record = this.createPart(session, paragraph, part, chunks[index] || "", index);
      if (record) paragraph.overlayNodes.push(record);
    });
    this.applyOriginalState(paragraph, Boolean(paragraph.showOriginal));
  },

  createPart(session, paragraph, part, text, partIndex = 0) {
    const layer = this.ensureLayer(session, part.pageIndex);
    if (!layer) return null;
    const doc = layer.ownerDocument;
    const bounds = part.bounds;
    const scale = Number(session.view?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentScale || 1);
    const metrics = this.getPartMetrics(part, scale);
    const pageColors = this.getPageColors(session, part.pageIndex);
    const textLayout = this.getTextLayout(paragraph, partIndex);
    const rootID = `paper-assistant-${simpleHash(paragraph.id)}-${part.pageIndex}-${partIndex}`;
    doc.getElementById(rootID)?.remove?.();
    const root = doc.createElement("div");
    root.id = rootID;
    root.dataset.paragraphId = paragraph.id;
    this.style(root, {
      position: "absolute", boxSizing: "border-box",
      left: Math.max(0, bounds.left) + "px",
      top: Math.max(0, bounds.top) + "px",
      width: Math.max(12, bounds.right - bounds.left) + "px",
      height: metrics.rawHeight + "px",
      pointerEvents: "none", overflow: "visible"
    });

    const cover = doc.createElement("div");
    cover.className = "paper-assistant-source-cover";
    this.style(cover, {
      position: "absolute", inset: "-1px", zIndex: "1",
      background: pageColors.background, pointerEvents: "none"
    });
    root.append(cover);

    const textNode = doc.createElement("div");
    textNode.textContent = textLayout.indent ? BODY_TRANSLATION_INDENT + text : text;
    this.style(textNode, {
      position: "absolute", left: "0", top: "0", width: "100%", height: "auto", zIndex: "2",
      overflow: "visible", color: pageColors.foreground, background: "transparent",
      fontFamily: '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
      fontWeight: "400", lineHeight: textLayout.lineHeight, letterSpacing: "0",
      boxSizing: "border-box",
      wordBreak: "break-word", userSelect: "none", pointerEvents: "auto", cursor: "pointer"
    });
    root.append(textNode);

    const badge = doc.createElement("button");
    badge.type = "button";
    badge.textContent = "中";
    badge.title = "恢复中文翻译";
    this.style(badge, {
      display: "none", position: "absolute", right: "0", top: "0", zIndex: "4",
      minWidth: "20px", height: "20px", padding: "0 3px",
      border: "1px solid #2f6fbb", borderRadius: "4px", color: "white",
      background: ACTION_COLOR, fontSize: "11px", pointerEvents: "auto", cursor: "pointer"
    });
    root.append(badge);

    const expand = doc.createElement("button");
    expand.type = "button";
    expand.textContent = "展开";
    this.style(expand, {
      display: "none", position: "absolute", right: "0", bottom: "0", zIndex: "4",
      height: "19px", padding: "0 4px", border: "1px solid #2f6fbb",
      borderRadius: "3px", color: "white", background: ACTION_COLOR,
      fontSize: "10px", pointerEvents: "auto", cursor: "pointer"
    });
    root.append(expand);
    layer.append(root);

    const preferredFont = Math.max(6, metrics.lineHeight * 0.78);
    const minFont = Math.min(preferredFont, Math.max(5, metrics.lineHeight * 0.42));
    const maxFont = Math.max(preferredFont, metrics.lineHeight * 1.05);
    const record = {
      root, cover, textNode, badge, expand, minFont, maxFont,
      maxHeight: metrics.rawHeight, overflowing: false
    };
    this.fitText(record);

    this.addReaderListener(textNode, "click", event => {
      event.preventDefault();
      event.stopPropagation();
      paragraph.showOriginal = true;
      this.applyOriginalState(paragraph, true);
    });
    this.addReaderListener(badge, "click", event => {
      event.preventDefault();
      event.stopPropagation();
      paragraph.showOriginal = false;
      this.applyOriginalState(paragraph, false);
    });
    this.addReaderListener(expand, "click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.showExpanded(doc, paragraph.zh);
    });
    return record;
  },

  fitText(record) {
    const targetHeight = record.maxHeight;
    record.root.style.height = targetHeight + "px";
    record.textNode.style.height = targetHeight + "px";
    record.textNode.style.overflow = "hidden";
    const fits = size => {
      record.textNode.style.fontSize = size + "px";
      return record.textNode.scrollHeight <= record.textNode.clientHeight + 1 &&
        record.textNode.scrollWidth <= record.textNode.clientWidth + 1;
    };
    let low = record.minFont;
    let high = Math.max(low, record.maxFont);
    let best = low;
    for (let attempt = 0; attempt < 11; attempt++) {
      const middle = (low + high) / 2;
      if (fits(middle)) {
        best = middle;
        low = middle;
      }
      else high = middle;
    }
    fits(best);
    record.overflowing = record.textNode.scrollHeight > record.textNode.clientHeight + 1 ||
      record.textNode.scrollWidth > record.textNode.clientWidth + 1;
    record.expand.style.display = record.overflowing ? "block" : "none";
  },

  getTextLayout(paragraph, partIndex = 0) {
    const isBody = Boolean(paragraph?.eligible && !paragraph.reason &&
      !/^table\s*[A-Z]?\d+[.:\s]/i.test(String(paragraph.text || "").trim()));
    return {
      indent: isBody && partIndex === 0,
      lineHeight: isBody ? String(BODY_TRANSLATION_LINE_HEIGHT) : "1.18"
    };
  },

  applyOriginalState(paragraph, original) {
    paragraph.showOriginal = original;
    for (const record of paragraph.overlayNodes || []) {
      record.root.style.pointerEvents = "none";
      record.cover.style.display = original ? "none" : "block";
      record.textNode.style.display = original ? "none" : "block";
      record.textNode.style.pointerEvents = original ? "none" : "auto";
      record.badge.style.display = original ? "block" : "none";
      record.expand.style.display = !original && record.overflowing ? "block" : "none";
    }
  },

  addReaderListener(element, eventName, handler) {
    let listener = handler;
    try {
      listener = Components.utils.exportFunction(
        handler, element.ownerDocument.defaultView,
        { allowCrossOriginArguments: true }
      );
    }
    catch (_) {}
    element.addEventListener(eventName, listener);
  },

  style(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  },

  showExpanded(doc, text) {
    doc.getElementById("paper-assistant-expanded-v2")?.remove?.();
    const popup = doc.createElement("div");
    popup.id = "paper-assistant-expanded-v2";
    this.style(popup, {
      position: "fixed", inset: "15% 18% auto", zIndex: "10000",
      maxHeight: "65vh", overflow: "auto", padding: "18px 20px",
      border: "1px solid rgba(127,127,127,.5)", borderRadius: "8px",
      color: "CanvasText", background: "Canvas",
      boxShadow: "0 8px 30px rgba(0,0,0,.35)",
      font: '15px/1.75 "Microsoft YaHei", sans-serif', whiteSpace: "pre-wrap"
    });
    popup.textContent = text;
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    this.style(close, { float: "right", margin: "0 0 8px 12px", cursor: "pointer" });
    this.addReaderListener(close, "click", () => popup.remove());
    popup.prepend(close);
    doc.body.append(popup);
  }
};

var ReaderTextExtractor = {
  rootURI: "",
  toolbarHandler: null,
  registeredPaneID: null,
  revealedReaders: new WeakSet(),
  panelStates: new Map(),
  sessions: new Map(),
  startingReaders: new Set(),
  credentialState: "unknown",

  async init(rootURI) {
    this.rootURI = rootURI;
    if (typeof ReaderBodyLayoutExtractor === "undefined") {
      Services.scriptloader.loadSubScript(`${rootURI}layout-extractor.js`, globalThis, "UTF-8");
    }
    this.toolbarHandler = this.onRenderToolbar.bind(this);
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, PLUGIN_ID);
    this.registerItemPane();
    TranslationCache.init();
    Zotero.debug(`[${PLUGIN_ID}] started`);

    (Zotero.uiReadyPromise || Promise.resolve()).then(async () => {
      const key = await DeepSeekCredentials.getKey();
      this.credentialState = key ? "configured" : "missing";
      this.refreshAllPanels();
      if (!key && !Services.prefs.getBoolPref(SKIP_PROMPT_PREF, false)) {
        await this.promptForAPIKey(false);
      }
    }).catch(error => Zotero.logError(error));
  },

  shutdown() {
    Zotero.Reader._unregisterEventListenerByPluginID?.(PLUGIN_ID);
    if (this.registeredPaneID) {
      Zotero.ItemPaneManager.unregisterSection(this.registeredPaneID);
    }
    for (const session of this.sessions.values()) {
      this.cancelSession(session);
    }
    this.sessions.clear();
    this.startingReaders.clear();
    TranslationCache.close().catch(error => Zotero.logError(error));
    this.toolbarHandler = null;
    this.registeredPaneID = null;
    this.revealedReaders = new WeakSet();
    this.panelStates.clear();
    Zotero.debug(`[${PLUGIN_ID}] stopped`);
  },

  registerItemPane() {
    this.registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: PLUGIN_ID,
      header: {
        l10nID: "reader-text-highlighter-pane-header",
        icon: `${this.rootURI}icons/highlighter-16.svg`
      },
      sidenav: {
        l10nID: "reader-text-highlighter-pane-sidenav",
        icon: `${this.rootURI}icons/highlighter-20.svg`
      },
      onItemChange: ({ item, tabType, setEnabled }) => {
        setEnabled(tabType === "reader" || Boolean(item?.isPDFAttachment?.()));
      },
      onRender: props => this.renderItemPane(props)
    });
    if (!this.registeredPaneID) {
      throw new Error("无法注册论文助手侧栏。");
    }
    Zotero.debug(`[${PLUGIN_ID}] registered item pane section ${PANE_ID}`);
  },

  renderItemPane({ doc, body, item, tabType }) {
    body.replaceChildren();
    const container = doc.createElement("div");
    this.setStyles(container, {
      display: "flex", flexDirection: "column", gap: "9px",
      padding: "10px 12px 16px", color: "var(--fill-primary, inherit)", fontSize: "13px"
    });

    const title = doc.createElement("strong");
    title.textContent = "英文正文自动中文覆盖";
    const disclosure = doc.createElement("p");
    disclosure.textContent = "仅将筛选后的英文正文发送到 DeepSeek；调用可能产生费用。译文与 API Key 仅保存在本机。";
    this.setStyles(disclosure, { margin: "0", lineHeight: "1.45", opacity: "0.78" });

    const apiStatus = doc.createElement("div");
    const languageStatus = doc.createElement("div");
    const progress = doc.createElement("div");
    for (const element of [apiStatus, languageStatus, progress]) {
      this.setStyles(element, {
        border: "1px solid var(--fill-quinary, rgba(127,127,127,.28))",
        borderRadius: "6px", padding: "8px 9px", lineHeight: "1.4",
        background: "var(--material-sidepane, rgba(127,127,127,.06))"
      });
    }

    const apiActions = doc.createElement("div");
    const configure = this.makeButton(doc, "配置 / 更换 API Key");
    const revalidate = this.makeButton(doc, "重新验证");
    const removeKey = this.makeButton(doc, "删除密钥", true);
    apiActions.append(configure, revalidate, removeKey);
    this.setStyles(apiActions, { display: "flex", flexWrap: "wrap", gap: "6px" });

    const queueActions = doc.createElement("div");
    const pause = this.makeButton(doc, "暂停");
    const retry = this.makeButton(doc, "重试失败");
    const clearCache = this.makeButton(doc, "清除本文缓存", true);
    const retranslate = this.makeButton(doc, "重新翻译");
    queueActions.append(pause, retry, clearCache, retranslate);
    this.setStyles(queueActions, { display: "flex", flexWrap: "wrap", gap: "6px" });

    const failureDetails = doc.createElement("details");
    const failureSummary = doc.createElement("summary");
    failureSummary.textContent = "失败详情（临时诊断，0 段）";
    failureSummary.style.cursor = "pointer";
    const failureOutput = doc.createElement("pre");
    failureOutput.textContent = "当前没有失败段落。";
    this.setStyles(failureOutput, {
      boxSizing: "border-box", maxHeight: "320px", overflow: "auto",
      margin: "7px 0 0", padding: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word",
      border: "1px solid var(--fill-quinary, rgba(127,127,127,.28))",
      borderRadius: "6px", color: "inherit",
      background: "var(--material-sidepane, rgba(127,127,127,.04))",
      font: "11px/1.45 ui-monospace, monospace"
    });
    failureDetails.append(failureSummary, failureOutput);

    const details = doc.createElement("details");
    const detailsSummary = doc.createElement("summary");
    detailsSummary.textContent = "诊断：清洗后正文预览";
    detailsSummary.style.cursor = "pointer";
    const diagnosticAction = this.makeButton(doc, "刷新诊断预览");
    const segmentExportAction = this.makeButton(doc, "导出原始分段 JSON");
    diagnosticAction.style.marginTop = "8px";
    segmentExportAction.style.marginTop = "8px";
    const previewLabel = doc.createElement("div");
    previewLabel.textContent = "尚未提取";
    const preview = doc.createElement("textarea");
    preview.readOnly = true;
    preview.placeholder = "此处显示经页眉、页脚、页码、出版信息和公式过滤后的全文。";
    this.setStyles(preview, {
      boxSizing: "border-box", width: "100%", minHeight: "260px", resize: "vertical",
      marginTop: "6px", border: "1px solid var(--fill-quinary, rgba(127,127,127,.28))",
      borderRadius: "6px", padding: "8px", color: "inherit",
      background: "var(--material-sidepane, rgba(127,127,127,.04))",
      font: "12px/1.45 ui-monospace, monospace"
    });
    details.append(detailsSummary, diagnosticAction, segmentExportAction, previewLabel, preview);

    const version = doc.createElement("small");
    version.textContent = `论文助手 ${PLUGIN_VERSION}`;
    version.style.opacity = "0.5";
    container.append(
      title, disclosure, apiStatus, apiActions, languageStatus, progress,
      queueActions, failureDetails, details, version
    );
    body.append(container);

    const state = {
      body, itemID: item?.id, tabType, apiStatus, languageStatus, progress,
      configure, revalidate, removeKey, pause, retry, clearCache, retranslate,
      failureDetails, failureSummary, failureOutput, diagnosticAction, segmentExportAction,
      previewLabel, preview
    };
    if (item?.id) this.panelStates.set(item.id, state);
    this.updatePanelState(state);

    configure.addEventListener("click", () => this.promptForAPIKey(true));
    revalidate.addEventListener("click", () => this.revalidateAPIKey());
    removeKey.addEventListener("click", () => this.removeAPIKey());
    pause.addEventListener("click", () => this.togglePauseForActiveReader());
    retry.addEventListener("click", () => this.retryFailedForActiveReader());
    clearCache.addEventListener("click", () => this.clearCacheForActiveReader(false));
    retranslate.addEventListener("click", () => this.clearCacheForActiveReader(true));
    diagnosticAction.addEventListener("click", async () => {
      const reader = this.getReaderForItem(item?.isPDFAttachment?.() ? item.id : null);
      if (reader) await this.runExtraction(reader, diagnosticAction, state);
    });
    segmentExportAction.addEventListener("click", async () => {
      const reader = this.getReaderForItem(item?.isPDFAttachment?.() ? item.id : null);
      if (reader) await this.exportRawSegmentation(reader, segmentExportAction, state);
    });
  },

  makeButton(doc, label, danger = false) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    this.setStyles(button, {
      minHeight: "30px", border: `1px solid ${danger ? "#b44" : "#4777a8"}`,
      borderRadius: "5px", padding: "5px 8px", color: "inherit",
      background: "var(--material-button, rgba(127,127,127,.08))",
      font: "inherit", cursor: "pointer"
    });
    return button;
  },

  setStyles(element, styles) {
    for (const [name, value] of Object.entries(styles)) element.style[name] = value;
  },

  async promptForAPIKey(replace = false) {
    const input = { value: "" };
    const accepted = Services.prompt.promptPassword(
      Zotero.getMainWindow?.(),
      replace ? "更换 DeepSeek API Key" : "配置 DeepSeek API Key",
      "英文正文会发送到 DeepSeek，并可能产生 API 费用。密钥将保存在 Firefox/Zotero 本机登录管理器中。",
      input,
      null,
      {}
    );
    if (!accepted) {
      this.credentialState = (await DeepSeekCredentials.getKey()) ? "configured" : "missing";
      this.refreshAllPanels();
      return false;
    }
    this.credentialState = "validating";
    this.refreshAllPanels();
    try {
      await DeepSeekCredentials.validateKey(input.value);
      await DeepSeekCredentials.saveKey(input.value.trim());
      input.value = "";
      this.credentialState = "configured";
      this.refreshAllPanels();
      this.showMessage("DeepSeek 已配置", `${DEEPSEEK_MODEL} 验证成功，英文论文会自动开始翻译。`);
      for (const [itemID, session] of this.sessions) {
        this.cancelSession(session);
        this.sessions.delete(itemID);
      }
      for (const reader of Zotero.Reader._readers || []) this.autoStartReader(reader);
      return true;
    }
    catch (error) {
      input.value = "";
      this.credentialState = "invalid";
      this.refreshAllPanels();
      this.showMessage("DeepSeek 配置失败", error.message || String(error), true);
      return false;
    }
  },

  async revalidateAPIKey() {
    const key = await DeepSeekCredentials.getKey();
    if (!key) return this.promptForAPIKey(false);
    this.credentialState = "validating";
    this.refreshAllPanels();
    try {
      await DeepSeekCredentials.validateKey(key);
      this.credentialState = "configured";
      this.showMessage("验证成功", `${DEEPSEEK_MODEL} 可用。`);
    }
    catch (error) {
      this.credentialState = "invalid";
      this.showMessage("验证失败", error.message || String(error), true);
    }
    this.refreshAllPanels();
  },

  async removeAPIKey() {
    await DeepSeekCredentials.deleteKey();
    this.credentialState = "missing";
    for (const [itemID, session] of this.sessions) {
      this.cancelSession(session);
      this.sessions.delete(itemID);
    }
    this.refreshAllPanels();
  },

  refreshAllPanels() {
    for (const state of this.panelStates.values()) {
      if (state.body?.isConnected) this.updatePanelState(state);
    }
  },

  updatePanelState(state) {
    const labels = {
      unknown: "API：正在检查本机密钥…",
      missing: "API：未配置。翻译不会启动。",
      validating: "API：正在验证…",
      configured: `API：已安全配置，模型 ${DEEPSEEK_MODEL}`,
      invalid: "API：验证失败，请更换或重新验证密钥。"
    };
    state.apiStatus.textContent = labels[this.credentialState] || labels.unknown;
    const reader = this.getReaderForItem(state.itemID);
    const session = reader ? this.sessions.get(reader.itemID) : null;
    state.languageStatus.textContent = session?.languageMessage || "语言：等待打开 PDF 后判断";
    state.progress.textContent = session ? this.formatProgress(session) : "进度：尚未开始";
    state.pause.textContent = session?.paused ? "继续" : "暂停";
    state.pause.disabled = !session || session.finished;
    state.retry.disabled = !session?.failed?.length;
    this.updateFailureDiagnostics(state, session);
  },

  updateFailureDiagnostics(state, session) {
    const rows = [...(session?.failureDetails?.values?.() || [])]
      .sort((left, right) => left.time - right.time);
    state.failureSummary.textContent = `失败详情（临时诊断，${rows.length} 段）`;
    if (!rows.length) {
      state.failureOutput.textContent = "当前没有失败段落。";
      delete state.failureDetails.dataset.hasFailures;
      return;
    }
    if (!state.failureDetails.dataset.hasFailures) {
      state.failureDetails.open = true;
      state.failureDetails.dataset.hasFailures = "true";
    }
    state.failureOutput.textContent = rows.map((row, index) => {
      const request = [
        `第 ${row.page} 页`,
        `批次 ${row.batch}`,
        row.status ? `HTTP ${row.status}` : "",
        row.attempts ? `请求 ${row.attempts} 次` : ""
      ].filter(Boolean).join(" · ");
      return `${index + 1}. ${request}\n原因：${this.explainFailureReason(row.reason)}\n源文：${row.sourcePreview}`;
    }).join("\n\n");
  },

  explainFailureReason(reason) {
    const value = String(reason || "unknown");
    if (value.startsWith("retry-exhausted:")) {
      const cause = value.slice("retry-exhausted:".length);
      return `自动重试 ${CONTENT_MAX_RETRIES} 次后仍失败：${this.explainFailureReason(cause)}`;
    }
    const labels = {
      "missing-or-empty": "模型未返回该段译文或译文为空",
      "empty-response": "模型未返回任何译文内容",
      "not-chinese": "返回内容未检测到中文",
      "invalid-json": "模型返回内容无法解析为有效 JSON",
      "invalid-translation-schema": "模型返回 JSON 结构不符合译文格式",
      "translation-missing-after-repair": "修复请求后仍缺少该段译文",
      "repair-failed": "译文修复请求失败"
    };
    if (value.startsWith("missing-placeholders:")) {
      return `引用、数字、单位或缩写占位符缺失（${value.slice("missing-placeholders:".length)}）`;
    }
    return labels[value] ? `${labels[value]}（${value}）` : value;
  },

  recordFailure(session, paragraph, batchIndex, reason, error = null, attempts = 0) {
    session.failureDetails ||= new Map();
    session.failureDetails.set(paragraph.id, {
      page: Number(paragraph.pageIndex || 0) + 1,
      batch: Number(batchIndex || 0) + 1,
      reason: String(reason || "unknown"),
      status: Number(error?.status || 0),
      attempts: Number(attempts || error?.attempts || 0),
      sourcePreview: String(paragraph.text || "").replace(/\s+/g, " ").trim().slice(0, 260),
      time: Date.now()
    });
  },

  formatProgress(session) {
    if (session.cancelled) return "进度：已取消";
    if (session.startupError) return `进度：启动失败 · ${session.startupError}`;
    const state = session.paused ? "已暂停" : session.finished ? "已完成" : "翻译中";
    return `进度：${state} · ${session.completed}/${session.total} 段 · ` +
      `并行 ${session.inFlight || 0}/${TRANSLATION_CONCURRENCY} · ` +
      `缓存 ${session.cached} · 失败 ${session.failed.length}`;
  },

  getReaderForItem(itemID) {
    const mainWindow = Zotero.getMainWindow?.();
    const tabID = mainWindow?.Zotero_Tabs?.selectedID;
    const activeReader = tabID ? Zotero.Reader.getByTabID?.(tabID) : null;
    if (activeReader) {
      if (!itemID || activeReader.itemID === itemID) return activeReader;
      const attachment = Zotero.Items?.get?.(activeReader.itemID);
      if (attachment?.parentID === itemID || attachment?.parentItemID === itemID) return activeReader;
    }
    return (Zotero.Reader._readers || []).find(reader => {
      if (!itemID || reader.itemID === itemID) return true;
      const attachment = Zotero.Items?.get?.(reader.itemID);
      return attachment?.parentID === itemID || attachment?.parentItemID === itemID;
    }) || null;
  },

  onRenderToolbar({ reader, doc, append }) {
    if (!reader || !doc) return;
    this.revealItemPane(reader);
    if (!doc.getElementById(BUTTON_ID)) {
      const button = doc.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.className = "toolbar-button wide-button";
      button.textContent = "正文翻译";
      button.title = "启动或继续英文正文中文覆盖翻译";
      button.setAttribute("aria-label", button.title);
      button.style.setProperty("min-width", "72px");
      button.style.setProperty("padding-inline", "8px");
      button.style.setProperty("font-size", "12px");
      button.style.setProperty("font-weight", "600");
      button.style.setProperty("color", "#ffffff");
      button.style.setProperty("background", ACTION_COLOR);
      button.addEventListener("click", () => this.startReaderTranslation(reader, true));
      append(button);
    }
    sleep(0).then(() => this.autoStartReader(reader)).catch(error => Zotero.logError(error));
  },

  revealItemPane(reader) {
    if (!reader?.tabID || this.revealedReaders.has(reader)) return;
    this.revealedReaders.add(reader);
    sleep(0).then(async () => {
      const mainWindow = Zotero.getMainWindow?.();
      if (!mainWindow || mainWindow.Zotero_Tabs?.selectedID !== reader.tabID) {
        this.revealedReaders.delete(reader);
        return;
      }
      if (Zotero.Prefs.get("layout") === "stacked") {
        Zotero.Prefs.set("layout", "standard");
        mainWindow.ZoteroPane?.updateLayout?.();
      }
      mainWindow.ZoteroContextPane.collapsed = false;
      await reader.setContextPaneOpen?.(true);
      for (let attempt = 0; attempt < 30; attempt++) {
        const itemDetails = mainWindow.document.getElementById(`${reader.tabID}-context`);
        if (itemDetails) {
          itemDetails.renderCustomSections?.();
          const pane = itemDetails.getEnabledPane?.(PANE_ID);
          if (pane) {
            pane.open = true;
            itemDetails.pinnedPane = PANE_ID;
            await itemDetails.scrollToPane?.(PANE_ID, "instant");
            return;
          }
        }
        await sleep(100);
      }
      this.revealedReaders.delete(reader);
    }).catch(error => {
      this.revealedReaders.delete(reader);
      Zotero.logError(error);
    });
  },

  async autoStartReader(reader) {
    if (this.sessions.has(reader.itemID)) return;
    const key = await DeepSeekCredentials.getKey();
    if (!key) return;
    await this.startReaderTranslation(reader, false);
  },

  async getReaderParagraphs(reader) {
    let view = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      view = reader._internalReader?._primaryView || null;
      if (view?._iframeWindow?.PDFViewerApplication?.pdfDocument) break;
      await sleep(50);
    }
    if (!view?._iframeWindow?.PDFViewerApplication?.pdfDocument) {
      throw new Error("等待 Zotero PDF 阅读器初始化超时。");
    }
    const pageMetrics = this.getReaderPageMetrics(view);
    const semantic = await this.getSDTExclusionRegions(reader, view, pageMetrics);
    return {
      view,
      ...(await this.getCharacterSnapshot(view, pageMetrics, semantic.regionsByPage)),
      sdtDiagnostics: semantic.diagnostics
    };
  },

  getReaderPageCount(view) {
    const application = view?._iframeWindow?.PDFViewerApplication;
    return Math.max(
      Number(application?.pdfDocument?.numPages || 0),
      Number(application?.pdfViewer?._pages?.length || 0)
    );
  },

  async getPageCharacters(view, pageIndex) {
    const pdfDocument = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if (typeof pdfDocument?.getPageData !== "function") {
      throw new Error("当前 Zotero Reader 不提供 getPageData 逐字符接口，无法执行版面感知正文提取。");
    }
    let request = { pageIndex };
    try { request = Components.utils.cloneInto(request, view._iframeWindow); } catch (_) {}
    const foreignPage = await pdfDocument.getPageData(request);
    if (!foreignPage?.chars) throw new Error(`PDF 第 ${pageIndex + 1} 页没有可读取的字符数据。`);
    const chars = [];
    const foreignChars = foreignPage.chars || [];
    const count = Number(foreignChars.length || 0);
    for (let offset = 0; offset < count; offset++) {
      const foreign = foreignChars[offset];
      if (!foreign) continue;
      const rect = this.copyRects([foreign.inlineRect || foreign.rect])[0] || null;
      chars.push({
        id: `${pageIndex}:${offset}`,
        c: String(foreign.c || ""),
        rect,
        lineBreakAfter: !!foreign.lineBreakAfter,
        paragraphBreakAfter: !!foreign.paragraphBreakAfter,
        spaceAfter: !!foreign.spaceAfter,
        ignorable: !!foreign.ignorable,
        rotation: Number(foreign.rotation || 0)
      });
    }
    const viewport = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.[pageIndex]?.viewport;
    const viewBox = this.copyViewBox(foreignPage.viewBox) || this.copyViewBox(viewport?.viewBox);
    return { pageIndex, chars, viewBox };
  },

  copyViewBox(value) {
    if (!value || Number(value.length || 0) < 4) return null;
    const viewBox = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
    return viewBox.every(Number.isFinite) && viewBox[2] > viewBox[0] && viewBox[3] > viewBox[1]
      ? viewBox : null;
  },

  mergePageMetric(metric, page) {
    const viewBox = page.viewBox || metric?.viewBox || null;
    return {
      pageIndex: page.pageIndex,
      width: Number(metric?.width || (viewBox ? viewBox[2] - viewBox[0] : 0)),
      height: Number(metric?.height || (viewBox ? viewBox[3] - viewBox[1] : 0)),
      rotation: Number(metric?.rotation || 0),
      viewBox
    };
  },

  getViewportRect(view, pageIndex, rect, metric) {
    if (!rect) return null;
    const viewport = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.[pageIndex]?.viewport;
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
    const viewBox = metric?.viewBox;
    if (!viewBox) return null;
    return [rect[0] - viewBox[0], viewBox[3] - rect[3], rect[2] - viewBox[0], viewBox[3] - rect[1]];
  },

  collectSDTText(node, limit = 240) {
    let text = "";
    const visit = value => {
      if (!value || text.length >= limit) return;
      if (typeof value.text === "string") text += value.text;
      const content = value.content;
      const count = Number(content?.length || 0);
      for (let index = 0; index < count && text.length < limit; index++) visit(content[index]);
    };
    visit(node);
    return text.replace(/\s+/g, " ").trim().slice(0, limit);
  },

  async getSDTExclusionRegions(reader, view, pageMetrics) {
    const internal = reader?._internalReader;
    let sdt = internal?._sdt || null;
    if (!sdt && typeof internal?._loadSDT === "function") {
      try { internal._loadSDT(); } catch (_) {}
      for (let attempt = 0; attempt < 40 && !internal?._sdt; attempt++) await sleep(50);
      sdt = internal?._sdt || null;
    }
    const regionsByPage = Array.from({ length: this.getReaderPageCount(view) }, () => []);
    const topLevel = sdt?.structure?.content;
    if (!topLevel) {
      return {
        regionsByPage,
        diagnostics: {
          available: false,
          tableBlockCount: 0,
          captionBlockCount: 0,
          mathBlockCount: 0,
          regionCount: 0
        }
      };
    }
    let blockIndex = 0;
    let tableBlockCount = 0;
    let captionBlockCount = 0;
    let mathBlockCount = 0;
    const visit = node => {
      if (!node || typeof node !== "object") return;
      const type = String(node.type || "");
      const semanticType = type === "table" ? "table"
        : type === "caption" ? "caption" : type === "math" ? "math" : "";
      if (semanticType) {
        if (semanticType === "table") tableBlockCount++;
        else if (semanticType === "caption") captionBlockCount++;
        else mathBlockCount++;
        const pageRects = node.anchor?.pageRects;
        const count = Number(pageRects?.length || 0);
        const sampleText = this.collectSDTText(node);
        for (let index = 0; index < count; index++) {
          const source = pageRects[index];
          if (!source || Number(source.length || 0) < 5) continue;
          const pageIndex = Number(source[0]);
          const pdfRect = this.copyRects([[source[1], source[2], source[3], source[4]]])[0];
          if (!pdfRect || !regionsByPage[pageIndex]) continue;
          const viewportRect = this.getViewportRect(view, pageIndex, pdfRect, pageMetrics[pageIndex] || {});
          if (!viewportRect) continue;
          regionsByPage[pageIndex].push({
            id: `sdt:${semanticType}:${blockIndex}:${index}`,
            reason: semanticType === "table" ? "zotero-sdt-table"
              : semanticType === "caption" ? "zotero-sdt-caption" : "zotero-sdt-math",
            semanticType,
            sampleText,
            pdfRect,
            viewportRect
          });
        }
        blockIndex++;
        return;
      }
      const content = node.content;
      const count = Number(content?.length || 0);
      for (let index = 0; index < count; index++) visit(content[index]);
    };
    const count = Number(topLevel.length || 0);
    for (let index = 0; index < count; index++) visit(topLevel[index]);
    return {
      regionsByPage,
      diagnostics: {
        available: true,
        tableBlockCount,
        captionBlockCount,
        mathBlockCount,
        regionCount: regionsByPage.reduce((sum, regions) => sum + regions.length, 0)
      }
    };
  },

  async getCharacterSnapshot(view, pageMetrics, regionsByPage = []) {
    const pageCount = this.getReaderPageCount(view);
    const pdfDocument = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if (!pageCount) throw new Error("当前 PDF 没有可读取的页面。");
    if (typeof pdfDocument?.getPageData !== "function") {
      throw new Error("当前 Zotero Reader 不提供 getPageData 逐字符接口，无法执行版面感知正文提取。");
    }
    const pages = [];
    let usableCharacterCount = 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = await this.getPageCharacters(view, pageIndex);
      page.metric = this.mergePageMetric(pageMetrics[pageIndex], page);
      page.exclusionRegions = regionsByPage[pageIndex] || [];
      for (const char of page.chars) {
        char.viewportRect = this.getViewportRect(view, pageIndex, char.rect, page.metric);
      }
      usableCharacterCount += page.chars.filter(char => !char.ignorable && char.c).length;
      pages.push(page);
    }
    if (!usableCharacterCount) throw new Error("PDF 没有可提取的文本字符层。");
    if (typeof ReaderBodyLayoutExtractor === "undefined") throw new Error("版面提取引擎未加载。");
    const extracted = ReaderBodyLayoutExtractor.extract(pages);
    return {
      raw: extracted.raw,
      pageMetrics: pages.map(page => page.metric),
      extractionSource: "zotero-page-chars",
      coordinateSystem: "viewport-top-down",
      layoutDiagnostics: extracted.layoutDiagnostics,
      paragraphDiagnostics: extracted.paragraphDiagnostics,
      exclusions: extracted.exclusions,
      textConservation: extracted.textConservation,
      extractionSummary: extracted.summary
    };
  },

  copyRects(foreignRects) {
    const copied = [];
    const length = Number(foreignRects?.length || 0);
    for (let index = 0; index < length; index++) {
      const rect = foreignRects[index];
      if (!rect || Number(rect.length || 0) < 4) continue;
      copied.push([
        Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])
      ]);
    }
    return copied;
  },

  copyPositionFragments(foreignPosition, sourceOrder = 0) {
    const fragments = [];
    const foreignFragments = foreignPosition?.fragments;
    const count = Number(foreignFragments?.length || 0);
    for (let index = 0; index < count; index++) {
      const foreign = foreignFragments[index];
      const rects = this.copyRects(foreign?.rects);
      if (!rects.length) continue;
      fragments.push({ pageIndex: Number(foreign?.pageIndex ?? foreignPosition?.pageIndex ?? 0), rects, sourceOrder });
    }
    if (fragments.length) return fragments;
    const pageIndex = Number(foreignPosition?.pageIndex || 0);
    const add = (rects, page) => rects.length && fragments.push({ pageIndex: page, rects, sourceOrder });
    add(this.copyRects(foreignPosition?.rects), pageIndex);
    add(this.copyRects(foreignPosition?.nextPageRects), pageIndex + 1);
    return fragments;
  },

  getReaderPageMetrics(view) {
    const pages = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages || [];
    const metrics = [];
    const count = Number(pages.length || 0);
    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      const viewport = pages[pageIndex]?.viewport;
      metrics.push({
        pageIndex,
        width: Number(viewport?.width || 0),
        height: Number(viewport?.height || 0),
        rotation: Number(viewport?.rotation || 0),
        viewBox: this.copyViewBox(viewport?.viewBox)
      });
    }
    return metrics;
  },

  normalizeFlowText(text) {
    return String(text || "")
      .replace(/[\u00ad\u200b]/g, "")
      .replace(/[ﬁ]/g, "fi")
      .replace(/[ﬂ]/g, "fl")
      .replace(/[ﬀ]/g, "ff")
      .replace(/[ﬃ]/g, "ffi")
      .replace(/[ﬄ]/g, "ffl")
      .replace(/\s+/g, " ")
      .trim();
  },

  rebalanceFragmentCharCounts(fragments, textLength) {
    const totalRects = fragments.reduce((sum, fragment) => sum + fragment.rects.length, 0);
    if (!totalRects) return fragments.map(fragment => ({ ...fragment }));
    let remaining = Math.max(1, Number(textLength || 0));
    return fragments.map((fragment, index) => {
      const isLast = index === fragments.length - 1;
      const count = isLast
        ? remaining
        : Math.max(1, Math.round(remaining * fragment.rects.length /
          Math.max(1, totalRects - fragments.slice(0, index).reduce((sum, item) => sum + item.rects.length, 0))));
      remaining = Math.max(1, remaining - count);
      return { ...fragment, sourceCharCount: count };
    });
  },

  makeFlowPosition(fragments) {
    const clean = fragments.filter(fragment => fragment?.rects?.length).map(fragment => ({
      pageIndex: Number(fragment.pageIndex || 0),
      rects: this.copyRects(fragment.rects),
      sourceIndex: Number(fragment.sourceIndex || 0),
      sourceOrder: Number(fragment.sourceOrder ?? fragment.sourceIndex ?? 0),
      sourceCharCount: Math.max(1, Number(fragment.sourceCharCount || 0))
    }));
    const firstPage = Number(clean[0]?.pageIndex || 0);
    const firstPageRects = clean.filter(fragment => fragment.pageIndex === firstPage)
      .flatMap(fragment => fragment.rects);
    const nextPageRects = clean.filter(fragment => fragment.pageIndex === firstPage + 1)
      .flatMap(fragment => fragment.rects);
    const position = {
      pageIndex: firstPage,
      rects: firstPageRects,
      fragments: clean
    };
    if (nextPageRects.length) position.nextPageRects = nextPageRects;
    return position;
  },

  normalizePositionSignature(position) {
    const normalize = rects => (rects || []).map(rect =>
      rect.map(value => Number(value).toFixed(2)).join(",")
    ).join(";");
    if (position?.fragments?.length) {
      return `${PARAGRAPH_LAYOUT_VERSION}|` + position.fragments.map(fragment =>
        `${Number(fragment.pageIndex || 0)}:${normalize(fragment.rects)}`
      ).join("||");
    }
    return `${position.pageIndex}|${normalize(position.rects)}|${normalize(position.nextPageRects)}`;
  },

  makeGeometryParagraphs(rawParagraphs, attachment) {
    const translatableTypes = new Set(["body-paragraph", "abstract-paragraph"]);
    const seen = new Set();
    return (Array.isArray(rawParagraphs) ? rawParagraphs : []).map((raw, index) => {
      const text = this.normalizeFlowText(raw?.text);
      const sourceOrder = Number(raw?.sourceOrder ?? raw?.sourceIndex ?? index);
      const fragments = this.rebalanceFragmentCharCounts(
        this.copyPositionFragments(raw?.position, sourceOrder), text.length
      );
      const position = this.makeFlowPosition(fragments);
      const pageIndex = Number(position.pageIndex || 0);
      const positionSignature = this.normalizePositionSignature(position);
      const sourceHash = simpleHash(text);
      const contentType = String(raw?.contentType || "body-paragraph");
      const reason = translatableTypes.has(contentType) ? "" : "heading";
      return {
        id: `${attachment.libraryID}:${attachment.key}:${pageIndex}:${simpleHash(positionSignature)}:${sourceHash}`,
        order: sourceOrder,
        text,
        contentType,
        position,
        pageIndex,
        positionSignature,
        sourceHash,
        sourceIndexes: [Number(raw?.sourceIndex ?? index)],
        segmentationWarnings: [],
        libraryID: attachment.libraryID,
        attachmentKey: attachment.key,
        eligible: !reason,
        reason
      };
    }).filter(paragraph => paragraph.text && paragraph.position?.rects?.length)
      .filter(paragraph => {
        if (seen.has(paragraph.id)) return false;
        seen.add(paragraph.id);
        return true;
      });
  },

  makeParagraphs(rawParagraphs, attachment) {
    return this.makeGeometryParagraphs(rawParagraphs, attachment);
  },

  parseCaptionLead(text) {
    const value = this.normalizeFlowText(text);
    const match = value.match(
      /^(fig(?:ure)?\.?|table|scheme|chart|plate)\s*([A-Z]?\d+(?:[.-]\d+)?)(?:\s*([.:\-\u2013\u2014])\s*|\s+)(.*)$/i
    );
    if (!match) return null;
    const remainder = this.normalizeFlowText(match[4]);
    const proseContinuation = /^(?:shows?|illustrates?|presents?|depicts?|compares?|demonstrates?|reveals?|provides?|indicates?|summari[sz]es?|reports?|lists?|gives?|contains?)\b/i
      .test(remainder);
    return {
      kind: /^table$/i.test(match[1]) ? "table" : "figure",
      separator: match[3] || "",
      remainder,
      proseContinuation,
      strong: !!match[3] && !proseContinuation
    };
  },

  isFigureOrTableCaption(text) {
    const lead = this.parseCaptionLead(text);
    if (!lead || lead.proseContinuation) return false;
    return lead.kind === "table" || lead.strong;
  },

  isTableLikeBlock(text) {
    const pipeCount = (text.match(/[|│]/g) || []).length;
    const tabCount = (text.match(/\t/g) || []).length;
    const numericCells = text.split(/\s{2,}|[|│]/).filter(cell => /^[-+]?\d[\d.,%\s-]*$/.test(cell.trim()));
    return pipeCount >= 2 || tabCount >= 2 || numericCells.length >= 4;
  },

  isHeadingBlock(text) {
    const value = text.trim();
    if (/^(?:\d+(?:\.\d+)*|[IVX]+)\.?\s+.{1,100}$/i.test(value) && value.length < 130) return true;
    if (/^[A-Z][.)]\s+.{1,100}$/.test(value) && value.length < 130) return true;
    if (value.length <= 100 && !/[.!?]$/.test(value)) {
      const words = value.match(/[A-Za-z][A-Za-z'-]*/g) || [];
      const titleCase = words.length && words.filter(word => /^[A-Z]/.test(word)).length / words.length > 0.65;
      if (words.length <= 14 && titleCase) return true;
    }
    return false;
  },

  async detectDocumentLanguage(attachment, candidates) {
    const parent = attachment.parentID || attachment.parentItemID
      ? await Zotero.Items.getAsync(attachment.parentID || attachment.parentItemID)
      : null;
    const language = String(parent?.getField?.("language") || attachment.getField?.("language") || "").trim();
    if (/^(?:en|eng)(?:[-_][A-Za-z]+)?$/i.test(language) || /^english$/i.test(language)) {
      return { isEnglish: true, source: "metadata", message: `语言：英文（条目字段 ${language}）` };
    }
    if (language && !/^(?:und|unknown|unk)$/i.test(language)) {
      return { isEnglish: false, source: "metadata", message: `语言：${language}（明确非英文，不自动翻译）` };
    }
    const sample = candidates.slice(0, 25).map(paragraph => paragraph.text).join(" ");
    const englishWords = sample.match(/\b[A-Za-z]{2,}\b/g) || [];
    const cjk = sample.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || [];
    const letters = sample.match(/[A-Za-z]/g) || [];
    const ratio = letters.length / Math.max(1, letters.length + cjk.length);
    const isEnglish = englishWords.length >= 40 && ratio >= 0.88;
    return {
      isEnglish,
      source: "detected",
      message: isEnglish
        ? `语言：英文（正文采样判断，${Math.round(ratio * 100)}% 拉丁字母）`
        : "语言：未能可靠判定为英文，不自动翻译"
    };
  },

  async startReaderTranslation(reader, manual = false) {
    if (!reader) return;
    const existing = this.sessions.get(reader.itemID);
    if (existing?.startupError) {
      this.cancelSession(existing);
      this.sessions.delete(reader.itemID);
    }
    else if (existing) {
      return;
    }
    const key = await DeepSeekCredentials.getKey();
    if (!key) {
      if (manual) await this.promptForAPIKey(false);
      return;
    }
    const attachment = reader._item || await Zotero.Items.getAsync(reader.itemID);
    if (!attachment?.isPDFAttachment?.()) return;
    if (this.startingReaders.has(reader.itemID)) return;
    this.startingReaders.add(reader.itemID);
    let session = {
      reader,
      view: null,
      attachment,
      paragraphs: [],
      candidates: [],
      languageMessage: "语言：正在读取 Zotero PDF 段落…",
      total: 0,
      completed: 0,
      cached: 0,
      failed: [],
      failureDetails: new Map(),
      paused: false,
      cancelled: false,
      finished: false,
      pendingRequests: new Set(),
      overlayLayers: new Map()
    };
    this.sessions.set(reader.itemID, session);
    this.refreshAllPanels();
    try {
      const snapshot = await this.getReaderParagraphs(reader);
      const { view, raw, pageMetrics } = snapshot;
      const paragraphs = this.makeParagraphs(raw, attachment, pageMetrics);
      const candidates = paragraphs.filter(paragraph => paragraph.eligible);
      const language = await this.detectDocumentLanguage(attachment, candidates);
      Object.assign(session, {
        view,
        paragraphs,
        candidates,
        extractionDiagnostics: {
          extractionSource: snapshot.extractionSource,
          coordinateSystem: snapshot.coordinateSystem,
          sdtDiagnostics: snapshot.sdtDiagnostics,
          layoutDiagnostics: snapshot.layoutDiagnostics,
          paragraphDiagnostics: snapshot.paragraphDiagnostics,
          exclusions: snapshot.exclusions,
          textConservation: snapshot.textConservation,
          extractionSummary: snapshot.extractionSummary
        },
        languageMessage: language.message,
        total: candidates.length
      });
      session.readerWatcher = setInterval(() => {
        if (!(Zotero.Reader._readers || []).includes(reader)) {
          this.cancelSession(session);
          this.sessions.delete(reader.itemID);
          this.refreshAllPanels();
          const replacement = (Zotero.Reader._readers || []).find(
            candidate => candidate !== reader && candidate.itemID === reader.itemID
          );
          if (replacement) this.autoStartReader(replacement);
        }
      }, 1000);
      ReaderOverlay.attach(session);
      this.refreshAllPanels();
      if (!language.isEnglish || !candidates.length) {
        session.finished = true;
        if (!candidates.length) session.languageMessage += "；未识别到连续正文段落";
        this.refreshAllPanels();
        return;
      }
      await this.runTranslationQueue(session, key);
    }
    catch (error) {
      if (!session?.cancelled) {
        session.finished = true;
        session.startupError = error.message || String(error);
        session.languageMessage = `语言：读取失败 · ${session.startupError}`;
        Zotero.logError(error);
        this.showMessage("正文翻译启动失败", error.message || String(error), true);
      }
    }
    finally {
      this.startingReaders.delete(reader.itemID);
      this.refreshAllPanels();
    }
  },

  compareParagraphOrder(left, right) {
    const leftOrder = Number(left?.order);
    const rightOrder = Number(right?.order);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    const leftPage = Number(left?.pageIndex);
    const rightPage = Number(right?.pageIndex);
    if (Number.isFinite(leftPage) && Number.isFinite(rightPage) && leftPage !== rightPage) {
      return leftPage - rightPage;
    }
    const leftRect = left?.position?.rects?.[0] || [];
    const rightRect = right?.position?.rects?.[0] || [];
    const leftTop = Number(leftRect[1]);
    const rightTop = Number(rightRect[1]);
    if (Number.isFinite(leftTop) && Number.isFinite(rightTop) && leftTop !== rightTop) {
      return leftTop - rightTop;
    }
    const leftLeft = Number(leftRect[0]);
    const rightLeft = Number(rightRect[0]);
    if (Number.isFinite(leftLeft) && Number.isFinite(rightLeft) && leftLeft !== rightLeft) {
      return leftLeft - rightLeft;
    }
    return 0;
  },

  makeTranslationBatches(paragraphs) {
    const orderedParagraphs = [...paragraphs].sort((left, right) =>
      this.compareParagraphOrder(left, right)
    );
    const batches = [];
    for (let offset = 0; offset < orderedParagraphs.length;) {
      const batch = [];
      let characters = 0;
      while (offset < orderedParagraphs.length && batch.length < MAX_BATCH_PARAGRAPHS) {
        const paragraph = orderedParagraphs[offset];
        if (batch.length && characters + paragraph.text.length > MAX_BATCH_CHARACTERS) break;
        batch.push(paragraph);
        characters += paragraph.text.length;
        offset++;
      }
      batches.push(batch);
    }
    return batches;
  },

  async runTranslationQueue(session, apiKey, onlyFailed = false) {
    const source = (onlyFailed ? [...session.failed] : [...session.candidates])
      .sort((left, right) => this.compareParagraphOrder(left, right));
    session.failureDetails ||= new Map();
    if (onlyFailed) {
      session.failed = [];
      for (const paragraph of source) session.failureDetails.delete(paragraph.id);
    }
    session.finished = false;
    session.authFailed = false;
    session.inFlight = 0;
    const pending = [];
    for (const paragraph of source) {
      if (session.cancelled) return;
      const cached = await TranslationCache.get(paragraph);
      if (cached?.status === "complete" && cached.zhText) {
        paragraph.zh = cached.zhText;
        session.completed++;
        session.cached++;
        ReaderOverlay.renderParagraph(session, paragraph);
      }
      else pending.push(paragraph);
    }
    this.refreshAllPanels();

    const batches = this.makeTranslationBatches(pending);
    const completedResults = new Map();
    let nextBatch = 0;
    let nextCommit = 0;
    let stopQueue = false;
    let commitChain = Promise.resolve();

    const commitReady = async () => {
      while (completedResults.has(nextCommit)) {
        const { index, batch, result, error } = completedResults.get(nextCommit);
        completedResults.delete(nextCommit);
        if (error) {
          const reason = error.message || String(error);
          for (const paragraph of batch) {
            if (!session.failed.includes(paragraph)) session.failed.push(paragraph);
            this.recordFailure(session, paragraph, index, reason, error);
            await TranslationCache.put(paragraph, "", "failed", reason);
          }
          if (error.status === 401 || error.status === 403) {
            this.credentialState = "invalid";
            session.authFailed = true;
            session.paused = true;
          }
        }
        else {
          for (const paragraph of batch) {
            const zh = result.translations.get(paragraph.id);
            if (zh) {
              paragraph.zh = zh;
              session.failureDetails.delete(paragraph.id);
              await TranslationCache.put(paragraph, zh, "complete", "");
              session.completed++;
              ReaderOverlay.renderParagraph(session, paragraph);
            }
            else {
              const failure = result.failures.get(paragraph.id);
              const reason = typeof failure === "string"
                ? failure
                : failure?.reason || "译文缺失";
              const attempts = typeof failure === "object" ? failure.attempts : 0;
              if (!session.failed.includes(paragraph)) session.failed.push(paragraph);
              this.recordFailure(session, paragraph, index, reason, null, attempts);
              await TranslationCache.put(paragraph, "", "failed", reason);
            }
          }
        }
        nextCommit++;
        this.refreshAllPanels();
      }
    };

    const worker = async () => {
      while (!session.cancelled && !stopQueue) {
        while (session.paused && !session.cancelled && !session.authFailed) await sleep(150);
        if (session.cancelled || session.authFailed) return;
        const index = nextBatch++;
        if (index >= batches.length) return;
        const batch = batches[index];
        session.inFlight++;
        this.refreshAllPanels();
        try {
          const result = await this.translateBatch(apiKey, batch, session);
          completedResults.set(index, { index, batch, result, error: null });
        }
        catch (error) {
          completedResults.set(index, { index, batch, result: null, error });
          if (error.status === 401 || error.status === 403) stopQueue = true;
        }
        finally {
          session.inFlight--;
        }
        commitChain = commitChain.then(commitReady);
        await commitChain;
      }
    };

    const workerCount = Math.min(TRANSLATION_CONCURRENCY, Math.max(1, batches.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await commitChain;
    if (session.authFailed) {
      this.showMessage("DeepSeek 授权失效", "请在论文助手侧栏重新配置 API Key。", true);
    }
    session.finished = !session.authFailed && !session.failed.length && nextCommit === batches.length;
    this.refreshAllPanels();
  },

  encodeProtectedText(text, paragraphIndex) {
    const tokens = [];
    const pattern = /\[[0-9,;–—\-\s]+\]|\((?:[A-Z][A-Za-z'’.-]+(?:\s+et\s+al\.)?)(?:,|\s)\s*\d{4}[a-z]?\)|\b\d+(?:\.\d+)?(?:\s*[×x]\s*10[-+]?\d+)?\s*(?:%|MPa|GPa|kPa|Pa|Hz|kHz|MHz|mm|cm|km|ms|min|kg|kN|°C|m|s|h|K|g|N|J|W|V|A)?(?!\w)|\b[A-Z][A-Z0-9-]{1,}\b/g;
    const encoded = String(text).replace(pattern, value => {
      const placeholder = `__PA${paragraphIndex}_${tokens.length}__`;
      tokens.push({ placeholder, value });
      return placeholder;
    });
    return { encoded, tokens };
  },

  decodeProtectedText(text, tokens) {
    let decoded = String(text || "").trim();
    const missing = [];
    for (const token of tokens) {
      const count = decoded.split(token.placeholder).length - 1;
      if (count !== 1) missing.push(token.placeholder);
      else decoded = decoded.replace(token.placeholder, token.value);
    }
    return { decoded, missing };
  },

  buildTranslationPrompt(repair = false) {
    return [
      "将英文学术论文正文准确翻译为简体中文。",
      "只返回 JSON：{\"translations\":[{\"id\":\"p0\",\"zh\":\"中文\"}]}。",
      "每个输入 id 返回一次；不得解释、总结或使用 Markdown。",
      "形如 __PA0_0__ 的保护占位符必须原样、完整、各保留一次，不得移动到其他段落。",
      "专业术语保持准确，变量、引用、数字、单位和缩写由占位符保护。",
      repair ? "这是修复请求：逐段完整重译，特别检查所有保护占位符。" : ""
    ].filter(Boolean).join("\n");
  },

  prepareTranslationEntries(batch) {
    return batch.map((paragraph, index) => {
      const protectedText = this.encodeProtectedText(paragraph.text, index);
      return {
        paragraph,
        requestID: `p${index}`,
        text: protectedText.encoded,
        tokens: protectedText.tokens
      };
    });
  },

  parseTranslationContent(content) {
    if (content && typeof content === "object" && !Array.isArray(content)) {
      if (!Array.isArray(content.translations)) {
        throw makeTranslationContentError(
          "invalid-translation-schema",
          "模型返回 JSON 缺少 translations 数组。"
        );
      }
      return content;
    }
    const text = (Array.isArray(content)
      ? content.map(part => typeof part === "string" ? part : part?.text || part?.content || "").join("")
      : String(content ?? "")
    ).replace(/^\uFEFF/, "").trim();
    if (!text) {
      throw makeTranslationContentError("empty-response", "模型未返回任何译文内容。");
    }

    let parsedObject = null;
    let parseError = null;
    for (const candidate of extractBalancedJSONCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (Array.isArray(parsed.translations)) return parsed;
          parsedObject = parsed;
        }
      }
      catch (error) {
        parseError = error;
      }
    }
    if (parsedObject) {
      throw makeTranslationContentError(
        "invalid-translation-schema",
        "模型返回 JSON 但缺少 translations 数组。"
      );
    }
    const detail = parseError?.message ? `：${parseError.message}` : "";
    throw makeTranslationContentError(
      "invalid-json",
      `模型返回内容无法解析为有效 JSON${detail}`
    );
  },

  validateTranslationRows(entries, result) {
    const rows = Array.isArray(result?.translations) ? result.translations : [];
    const byID = new Map();
    for (const row of rows) {
      if (typeof row?.id === "string" && !byID.has(row.id)) byID.set(row.id, row);
    }
    const translations = new Map();
    const invalid = [];
    for (const entry of entries) {
      const row = byID.get(entry.requestID);
      const zh = String(row?.zh || "").trim();
      if (!zh) {
        invalid.push({ entry, reason: "missing-or-empty" });
        continue;
      }
      const decoded = this.decodeProtectedText(zh, entry.tokens);
      if (decoded.missing.length) {
        invalid.push({ entry, reason: `missing-placeholders:${decoded.missing.join(",")}` });
        continue;
      }
      if (!/[\u3400-\u9fff]/.test(decoded.decoded)) {
        invalid.push({ entry, reason: "not-chinese" });
        continue;
      }
      translations.set(entry.paragraph.id, decoded.decoded);
    }
    return { translations, invalid };
  },

  async requestTranslationEntries(apiKey, entries, session, repair = false) {
    const payload = {
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" },
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: this.buildTranslationPrompt(repair) },
        {
          role: "user",
          content: JSON.stringify({
            paragraphs: entries.map(entry => ({ id: entry.requestID, text: entry.text }))
          })
        }
      ]
    };
    const response = await this.requestCompletion(apiKey, payload, session);
    return this.parseTranslationContent(response?.choices?.[0]?.message?.content);
  },

  async translateBatch(apiKey, batch, session) {
    const entries = this.prepareTranslationEntries(batch);
    const translations = new Map();
    const failures = new Map();
    const attempts = new Map(entries.map(entry => [entry.paragraph.id, 0]));
    const lastReasons = new Map();
    let pending = entries.slice();

    for (let retry = 0; retry <= CONTENT_MAX_RETRIES && pending.length; retry++) {
      if (retry > 0) await sleep(CONTENT_RETRY_DELAYS[retry - 1]);
      const groups = retry >= 2 ? pending.map(entry => [entry]) : [pending];
      const nextPending = [];
      for (const group of groups) {
        if (session.cancelled) throw new Error("翻译已取消");
        for (const entry of group) {
          const id = entry.paragraph.id;
          attempts.set(id, Number(attempts.get(id) || 0) + 1);
        }
        let invalid = [];
        try {
          const result = await this.requestTranslationEntries(
            apiKey,
            group,
            session,
            retry > 0
          );
          const validation = this.validateTranslationRows(group, result);
          for (const [id, zh] of validation.translations) {
            translations.set(id, zh);
            lastReasons.delete(id);
          }
          invalid = validation.invalid;
        }
        catch (error) {
          if (error.status) throw error;
          if (!error.code) throw error;
          invalid = group.map(entry => ({ entry, reason: error.code }));
        }
        for (const item of invalid) {
          const id = item.entry.paragraph.id;
          if (!translations.has(id)) {
            nextPending.push(item);
            lastReasons.set(id, item.reason);
          }
        }
      }
      const uniquePending = new Map();
      for (const item of nextPending) {
        if (!uniquePending.has(item.entry.paragraph.id)) uniquePending.set(item.entry.paragraph.id, item);
      }
      pending = [...uniquePending.values()].map(item => item.entry);
    }

    for (const entry of pending) {
      const id = entry.paragraph.id;
      const reason = lastReasons.get(id) || "translation-missing-after-repair";
      failures.set(id, {
        reason: `retry-exhausted:${reason}`,
        attempts: Number(attempts.get(id) || 0)
      });
    }
    return { translations, failures, attempts };
  },

  async requestCompletion(apiKey, payload, session) {
    session.pendingRequests ||= new Set();
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS.length; attempt++) {
      if (session.cancelled) throw new Error("翻译已取消");
      let activeRequest = null;
      let response;
      try {
        response = await Zotero.HTTP.request(
          "POST",
          `${DEEPSEEK_BASE_URL}/chat/completions`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            responseType: "json",
            timeout: 120000,
            successCodes: false,
            errorDelayMax: 0,
            requestObserver: request => {
              activeRequest = request;
              session.pendingRequests.add(request);
            }
          }
        );
      }
      catch (error) {
        if (activeRequest) session.pendingRequests.delete(activeRequest);
        if (session.cancelled) throw new Error("翻译已取消");
        if (attempt < NETWORK_RETRY_DELAYS.length) {
          await sleep(NETWORK_RETRY_DELAYS[attempt]);
          continue;
        }
        const finalError = error instanceof Error ? error : new Error(String(error));
        finalError.attempts = attempt + 1;
        throw finalError;
      }
      if (activeRequest) session.pendingRequests.delete(activeRequest);
      const status = Number(response?.status || 0);
      if (status >= 200 && status < 300) return parseJSONResponse(response);
      const error = new Error(`DeepSeek HTTP ${status || "未知"}`);
      error.status = status;
      error.attempts = attempt + 1;
      if ((status === 429 || status >= 500) && attempt < NETWORK_RETRY_DELAYS.length) {
        let delay = NETWORK_RETRY_DELAYS[attempt];
        if (status === 429) {
          const retryAfter = Number(response?.getResponseHeader?.("Retry-After") || 0);
          if (retryAfter > 0) delay = Math.min(30000, retryAfter * 1000);
        }
        await sleep(delay);
        continue;
      }
      throw error;
    }
    throw new Error("DeepSeek 请求失败");
  },

  cancelSession(session) {
    session.cancelled = true;
    if (session.readerWatcher) clearInterval(session.readerWatcher);
    session.readerWatcher = null;
    for (const request of session.pendingRequests || []) {
      try { request?.abort?.(); } catch (_) {}
    }
    session.pendingRequests?.clear?.();
    ReaderOverlay.detach(session);
  },

  getActiveSession() {
    const reader = this.getReaderForItem(null);
    return reader ? this.sessions.get(reader.itemID) : null;
  },

  togglePauseForActiveReader() {
    const session = this.getActiveSession();
    if (!session) return;
    session.paused = !session.paused;
    this.refreshAllPanels();
  },

  async retryFailedForActiveReader() {
    const session = this.getActiveSession();
    if (!session?.failed?.length) return;
    const key = await DeepSeekCredentials.getKey();
    if (!key) return this.promptForAPIKey(false);
    session.paused = false;
    session.finished = false;
    await this.runTranslationQueue(session, key, true);
  },

  async clearCacheForActiveReader(restart) {
    const session = this.getActiveSession();
    if (!session) return;
    await TranslationCache.deleteForAttachment(session.attachment.libraryID, session.attachment.key);
    if (!restart) {
      this.showMessage("缓存已清除", "当前论文的本地译文缓存已删除；页面上的本次译文保留到标签关闭。 ");
      return;
    }
    const reader = session.reader;
    this.cancelSession(session);
    this.sessions.delete(reader.itemID);
    await this.startReaderTranslation(reader, true);
  },

  async extractFullText(attachment) {
    if (!attachment?.isPDFAttachment?.()) throw new Error("当前阅读器中没有 PDF 附件。");
    const result = await Zotero.PDFWorker.getFullText(attachment.id, null, true);
    const rawText = typeof result?.text === "string" ? result.text : "";
    const filtered = this.filterExtractedText(rawText);
    return {
      text: filtered.text,
      extractedPages: Number(result?.extractedPages || 0),
      totalPages: Number(result?.totalPages || 0),
      rawCharacterCount: rawText.length,
      removedBlockCount: filtered.removedBlockCount,
      removedCharacterCount: filtered.removedCharacterCount
    };
  },

  filterExtractedText(rawText) {
    const pages = String(rawText || "").replace(/\r\n?/g, "\n").split("\f").map(page =>
      page.split(/\n+/).map(block => block.replace(/\s+/g, " ").trim()).filter(Boolean)
    );
    const repeatedEdgeKeys = this.findRepeatedEdgeKeys(pages);
    const keptPages = [];
    let removedBlockCount = 0;
    let removedCharacterCount = 0;
    let inReferences = false;
    for (const blocks of pages) {
      const keptBlocks = [];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (/^(?:references|bibliography|literature\s+cited)\s*$/i.test(block)) inReferences = true;
        const isEdge = index < 3 || index >= blocks.length - 3;
        const remove = inReferences
          || (isEdge && repeatedEdgeKeys.has(this.normalizeRepeatedBlock(block)))
          || this.isPageNumberBlock(block)
          || this.isPublicationMetadataBlock(block)
          || this.isFormulaBlock(block)
          || this.isFigureOrTableCaption(block)
          || this.isTableLikeBlock(block)
          || this.isHeadingBlock(block);
        if (remove) {
          removedBlockCount++;
          removedCharacterCount += block.length;
        }
        else keptBlocks.push(block);
      }
      if (keptBlocks.length) keptPages.push(keptBlocks.join("\n\n"));
    }
    return { text: keptPages.join("\n\n").trim(), removedBlockCount, removedCharacterCount };
  },

  findRepeatedEdgeKeys(pages) {
    const occurrences = new Map();
    pages.forEach((blocks, pageIndex) => {
      const edgeBlocks = [...blocks.slice(0, 3), ...blocks.slice(Math.max(3, blocks.length - 3))];
      for (const block of new Set(edgeBlocks)) {
        const key = this.normalizeRepeatedBlock(block);
        if (!key || key.length < 4 || key.length > 240) continue;
        if (!occurrences.has(key)) occurrences.set(key, new Set());
        occurrences.get(key).add(pageIndex);
      }
    });
    const minimum = Math.max(3, Math.ceil(pages.length * 0.3));
    return new Set([...occurrences].filter(([, indexes]) => indexes.size >= minimum).map(([key]) => key));
  },

  normalizeRepeatedBlock(block) {
    return String(block || "").toLocaleLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  },

  isPageNumberBlock(block) {
    const text = block.trim();
    return /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(text)
      || /^[ivxlcdm]{1,8}$/i.test(text)
      || /^\d{1,4}\s*\|\s*page$/i.test(text);
  },

  isPublicationMetadataBlock(block) {
    const text = block.replace(/\s+/g, " ").trim();
    const patterns = [
      /(?:https?:\/\/)?(?:dx\.)?doi\.org\/10\./i,
      /\bdoi\s*:\s*10\.\d{4,9}\//i,
      /\b(?:received|revised|accepted)\s+(?:in\s+revised\s+form\s+)?\d{1,2}\s+[A-Z][a-z]+\s+\d{4}\b/i,
      /\bavailable\s+online\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{4}\b/i,
      /\bcorresponding\s+author\b/i,
      /\be-?mail\s+addresses?\s*:/i,
      /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/i,
      /(?:©|\(c\)|copyright)\s*\d{4}/i,
      /\ball\s+rights\s+reserved\b/i,
      /\b(?:published|distributed)\s+by\b/i,
      /\bopen\s+access\s+article\b/i,
      /\b(?:CC|Creative\s+Commons)\s+(?:BY|license)\b/i,
      /\bcontents\s+lists?\s+available\b/i,
      /\bjournal\s+homepage\s*:/i,
      /^article\s+(?:history|information)\s*:?$/i,
      /\b\d{4}-\d{3}[\dX]\b/i,
      /^[A-Z][A-Za-z&,:.'’ -]{5,100}\s+\d{1,4}\s*\(\d{4}\)\s+\d+(?:[-–]\d+)?$/
    ];
    return patterns.some(pattern => pattern.test(text));
  },

  isFormulaBlock(block) {
    const text = block.trim();
    if (!text || text.length > 280) return false;
    const words = text.match(/[A-Za-z]{3,}/g) || [];
    const symbols = text.match(/[=<>±×÷≈≠≤≥∞√∑∏∫∂∇^_{}\[\]|]/g) || [];
    const greek = text.match(/[α-ωΑ-Ω]/g) || [];
    const numbers = text.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const equationNumber = /\(\s*\d{1,3}\s*\)\s*$/.test(text);
    const sentence = /[.!?]\s*(?:[A-Z]|$)/.test(text);
    const symbolicCount = symbols.length + greek.length;
    if (sentence && words.length >= 8) return false;
    if (equationNumber && symbolicCount >= 1 && words.length <= 10) return true;
    if (/[=≈≠≤≥]/.test(text) && symbolicCount >= 1 && words.length <= 3) return true;
    if (symbolicCount >= 3 && words.length <= 8) return true;
    return symbolicCount >= 2 && numbers.length >= 2 && words.length <= 5;
  },

  async runExtraction(reader, button, preferredState = null) {
    const attachment = reader?._item || await Zotero.Items.getAsync(reader.itemID);
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "提取中…";
    try {
      const fullText = await this.extractFullText(attachment);
      if (!fullText.text.trim()) throw new Error("Zotero 未提取到正文；扫描版 PDF 请先完成 OCR。");
      this.setPanelPreview(attachment.id, fullText, preferredState);
    }
    catch (error) {
      Zotero.logError(error);
      this.showMessage("诊断提取失败", error.message || String(error), true);
    }
    finally {
      button.disabled = false;
      button.textContent = original;
    }
  },

  async exportRawSegmentation(reader, button, preferredState = null) {
    const attachment = reader?._item || await Zotero.Items.getAsync(reader.itemID);
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "导出中…";
    try {
      const snapshot = await this.getReaderParagraphs(reader);
      const directory = Zotero.DataDirectory?.dir;
      if (!directory) throw new Error("无法定位 Zotero 数据目录，未导出分段诊断。");
      const safeKey = String(attachment?.key || reader.itemID || "reader")
        .replace(/[^A-Za-z0-9._-]+/g, "_");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = PathUtils.join(directory,
        `paper-assistant-segments-${safeKey}-${stamp}.json`);
      const serializePosition = position => ({
        pageIndex: Number(position?.pageIndex || 0),
        rects: this.copyRects(position?.rects),
        nextPageRects: this.copyRects(position?.nextPageRects),
        fragments: (position?.fragments || []).map(fragment => ({
          pageIndex: Number(fragment?.pageIndex || 0),
          rects: this.copyRects(fragment?.rects)
        }))
      });
      const payload = {
        schema: SEGMENTATION_DIAGNOSTIC_SCHEMA,
        pluginVersion: PLUGIN_VERSION,
        generatedAt: new Date().toISOString(),
        attachment: {
          id: Number(attachment?.id || reader.itemID || 0),
          libraryID: Number(attachment?.libraryID || 0),
          key: String(attachment?.key || "")
        },
        pageMetrics: snapshot.pageMetrics || [],
        extractionSource: snapshot.extractionSource || "zotero-page-chars",
        coordinateSystem: snapshot.coordinateSystem || "viewport-top-down",
        sdtDiagnostics: snapshot.sdtDiagnostics || null,
        layoutDiagnostics: snapshot.layoutDiagnostics || [],
        paragraphDiagnostics: snapshot.paragraphDiagnostics || [],
        exclusions: snapshot.exclusions || [],
        textConservation: snapshot.textConservation || null,
        extractionSummary: snapshot.extractionSummary || null,
        raw: (snapshot.raw || []).map((paragraph, index) => ({
          sourceIndex: Number(paragraph.sourceIndex ?? index),
          sourceOrder: Number(paragraph.sourceOrder ?? paragraph.sourceIndex ?? index),
          text: String(paragraph.text || ""),
          contentType: String(paragraph.contentType || "body-paragraph"),
          position: serializePosition(paragraph.position)
        }))
      };
      const serialized = JSON.stringify(payload, null, 2);
      if (typeof IOUtils !== "undefined" && typeof IOUtils.writeUTF8 === "function") {
        await IOUtils.writeUTF8(path, serialized);
      }
      else if (Zotero.File?.putContentsAsync) {
        await Zotero.File.putContentsAsync(path, serialized);
      }
      else {
        throw new Error("当前 Zotero 未提供 UTF-8 文件写入接口，未导出分段诊断。");
      }
      this.showMessage("原始分段诊断已导出", path);
      const state = this.getPanelState(attachment?.id, preferredState);
      if (state) {
        state.previewLabel.textContent =
          `原始分段 ${payload.raw.length} 段 · 已保存至 Zotero 数据目录`;
        state.preview.value = serialized;
      }
    }
    catch (error) {
      Zotero.logError(error);
      this.showMessage("分段诊断导出失败", error.message || String(error), true);
    }
    finally {
      button.disabled = false;
      button.textContent = original;
    }
  },

  getPanelState(itemID, preferredState = null) {
    if (preferredState?.body?.isConnected) return preferredState;
    const direct = this.panelStates.get(itemID);
    if (direct?.body?.isConnected) return direct;
    const attachment = itemID ? Zotero.Items?.get?.(itemID) : null;
    const parent = this.panelStates.get(attachment?.parentID || attachment?.parentItemID);
    return parent?.body?.isConnected ? parent : null;
  },

  setPanelPreview(itemID, fullText, preferredState = null) {
    const state = this.getPanelState(itemID, preferredState);
    if (!state) return;
    state.preview.value = fullText.text;
    state.previewLabel.textContent =
      `完整页 ${fullText.extractedPages}/${fullText.totalPages} · ` +
      `保留 ${fullText.text.length.toLocaleString()} 字符 · 过滤 ${fullText.removedBlockCount} 段`;
  },

  showMessage(headline, description, isError = false) {
    const progressWindow = new Zotero.ProgressWindow();
    progressWindow.changeHeadline(headline);
    progressWindow.addDescription(description);
    if (isError) progressWindow.addDescription("详细错误已写入 Zotero 调试日志（不含 API Key）。");
    progressWindow.show();
    progressWindow.startCloseTimer(isError ? 8000 : 5000);
  }
};

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await ReaderTextExtractor.init(rootURI);
}

function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) ReaderTextExtractor.shutdown();
}

function install() {}
function uninstall() {}
