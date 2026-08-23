(function (global) {
  "use strict";

  const {
    PLUGIN_ID,
    PLUGIN_VERSION,
    PANE_ID,
    PANEL_LOCALE_FILE,
    ITEM_PANE_REGISTRATION_RETRY_DELAY,
    ITEM_PANE_REGISTRATION_MAX_RETRIES,
    createPanelLocalization,
    insertPanelLocalizationIntoMainWindows
  } = global.TranslatorCore;

  const SelectionReplacerTest = Object.assign({
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
    firstModelSelectionNoticePromise: null,

    async init(rootURI) {
      this.rootURI = rootURI;
      await (Zotero.uiReadyPromise || Promise.resolve());
      this.localization = createPanelLocalization();
      insertPanelLocalizationIntoMainWindows();
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
        minHeight: "144px",
        maxHeight: "440px",
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
  }, global.TranslatorProviderPanel, global.TranslatorWorkflows);

  global.SelectionReplacerTest = SelectionReplacerTest;
  global.TranslatorForZoteroApp = SelectionReplacerTest;
})(globalThis);
