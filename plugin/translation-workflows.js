(function (global) {
  "use strict";

  const {
    PLUGIN_ID,
    POPUP_CLASS,
    LEGACY_TOOLBAR_IDS,
    AUTO_TARGET_LABELS,
    copyPosition
  } = global.TranslatorCore;

  const TranslatorWorkflows = {
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

  global.TranslatorWorkflows = Object.freeze(TranslatorWorkflows);
})(globalThis);
