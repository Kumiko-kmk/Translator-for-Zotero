(function (global) {
  "use strict";

  const {
    PARAGRAPH_TRANSLATION_INDENT,
    PARAGRAPH_MARK_COLORS,
    AUTO_TARGET_COLORS,
    AUTO_TARGET_LABELS
  } = global.TranslatorCore;

  const TranslatorOverlayRenderer = {
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

  global.TranslatorOverlayRenderer = Object.freeze(TranslatorOverlayRenderer);
})(globalThis);
