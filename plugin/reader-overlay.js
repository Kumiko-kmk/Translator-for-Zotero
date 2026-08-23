(function (global) {
  "use strict";

  const {
    LAYER_CLASS,
    TRANSLATION_FAILURE_COUNTDOWN_SECONDS,
    TRANSLATION_FAILURE_MESSAGE,
    positionFragments,
    splitReplacement
  } = global.TranslatorCore;

  const SelectionReplacerOverlay = Object.assign({
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
  }, global.TranslatorOverlayLayout, global.TranslatorOverlayRenderer);

  global.SelectionReplacerOverlay = SelectionReplacerOverlay;
})(globalThis);
