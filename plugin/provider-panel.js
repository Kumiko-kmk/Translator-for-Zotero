(function (global) {
  "use strict";

  const {
    TRANSLATION_PROVIDER_UI,
    TRANSLATION_PROVIDER_UI_BY_ID,
    PANEL_STYLE_ID
  } = global.TranslatorCore;

  const TranslatorProviderPanel = {
    getProvider(providerID = this.activeProviderID) {
      if (!providerID) return null;
      return globalThis.getTranslationProvider?.(providerID)
        || globalThis.TranslationProviderRegistry?.[providerID]
        || null;
    },

    getProviderState(providerID = this.activeProviderID) {
      const id = String(providerID || "");
      if (!this.providerStates.has(id)) {
        this.providerStates.set(id, {
          status: "missing",
          message: "",
          validationToken: 0
        });
      }
      return this.providerStates.get(id);
    },

    setProviderState(providerID, status, message = "") {
      const state = this.getProviderState(providerID);
      state.status = status;
      state.message = String(message || "");
      if (providerID === this.activeProviderID) this.credentialState = status;
      return state;
    },

    setPanelText(element, l10nID, fallback, doc = element?.ownerDocument) {
      if (!element) return;
      element.setAttribute?.("data-l10n-id", l10nID);
      element.textContent = fallback;
      doc?.l10n?.setAttributes?.(element, l10nID);
    },

    setPanelAttributes(element, l10nID, attributes, doc = element?.ownerDocument) {
      if (!element) return;
      element.setAttribute?.("data-l10n-id", l10nID);
      element.setAttribute?.("data-l10n-attrs", Object.keys(attributes).join(","));
      for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute?.(name, value);
      }
      doc?.l10n?.setAttributes?.(element, l10nID);
    },

    maskAPIKey(apiKey) {
      const value = String(apiKey || "").trim();
      if (!value) return "";
      if (value.length <= 7) return "*".repeat(value.length);
      const prefixLength = 4;
      const suffixLength = 3;
      return value.slice(0, prefixLength)
        + "*".repeat(value.length - prefixLength - suffixLength)
        + value.slice(-suffixLength);
    },

    providerRequestOptions(provider) {
      try {
        return provider?.requestOptions?.() || {};
      }
      catch (error) {
        return { error };
      }
    },

    providerStatusText(provider, state) {
      switch (state?.status) {
        case "configured":
          return "验证成功 · " + (provider?.modelSpec?.model || provider?.label || "");
        case "validating":
          return "正在验证…";
        case "invalid": {
          const message = String(state?.message || "").trim();
          if (/API Key 无效|密钥无效/iu.test(message)) return "API Key 无效";
          if (/timeout|timed out|超时/iu.test(message)) return "请求超时，请重试";
          const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/iu);
          if (httpStatus) return `HTTP ${httpStatus[1]}`;
          return message ? `验证失败：${message.slice(0, 80)}` : "验证失败";
        }
        case "unknown":
          return "正在检查";
        case "missing":
        default:
          return "未输入";
      }
    },

    providerStatusColor(status) {
      if (status === "configured") return "#16a34a";
      if (status === "invalid") return "#dc2626";
      return "#9ca3af";
    },

    makeStatusLamp(doc) {
      const lamp = doc.createElement("span");
      lamp.setAttribute("aria-hidden", "true");
      this.stylePanel(lamp, {
        display: "inline-block",
        width: "9px",
        height: "9px",
        borderRadius: "50%",
        flex: "0 0 auto",
        background: "#9ca3af",
        boxShadow: "0 0 0 1px rgba(0,0,0,.18)"
      });
      return lamp;
    },

    makeRetryButton(doc) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "↻";
      button.title = "重试验证";
      button.setAttribute("aria-label", "重试验证");
      this.stylePanel(button, {
        width: "24px",
        height: "24px",
        padding: "0",
        border: "0",
        borderRadius: "50%",
        color: "inherit",
        background: "transparent",
        fontSize: "18px",
        lineHeight: "22px",
        cursor: "pointer"
      });
      return button;
    },

    getProviderUI(providerID) {
      return TRANSLATION_PROVIDER_UI_BY_ID[providerID] || null;
    },

    ensureProviderPanelStyle(doc) {
      const styleParent = doc?.head || doc?.documentElement;
      if (!doc?.createElement || !styleParent?.append) return;
      if (doc.getElementById?.(PANEL_STYLE_ID)) return;
      const style = doc.createElement("style");
      style.id = PANEL_STYLE_ID;
      style.textContent = `
        [data-provider-cards="true"] {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 160px));
          justify-content: center;
          gap: 10px;
        }
        [data-provider-card="true"] {
          min-width: 0;
        }
        @media (max-width: 520px) {
          [data-provider-card="true"] {
            min-height: 60px !important;
            height: 60px !important;
            padding: 6px 8px !important;
          }
          [data-provider-card-label="true"] {
            display: none !important;
          }
          [data-provider-card-logo="true"] {
            width: 28px !important;
            height: 28px !important;
            flex-basis: 28px !important;
          }
        }
      `;
      styleParent.append(style);
    },

    makeProviderLogo(doc, providerID, size = 42) {
      const metadata = this.getProviderUI(providerID) || {
        icon: "",
        fallback: "?"
      };
      const image = doc.createElement("img");
      image.src = `${this.rootURI}${metadata.icon}`;
      this.setPanelAttributes(
        image,
        `reader-selection-replacer-test-pane-provider-${providerID}-icon`,
        { alt: `${metadata.fallback} 图标` },
        doc
      );
      image.setAttribute("aria-hidden", "true");
      image.setAttribute("data-provider-logo", providerID);
      image.setAttribute("data-provider-card-logo", "true");
      this.stylePanel(image, {
        display: "block",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "10px",
        border: "0",
        objectFit: "cover",
        boxSizing: "border-box",
        padding: "0",
        overflow: "hidden",
        background: "transparent",
        flex: `0 0 ${size}px`
      });

      const fallback = doc.createElement("span");
      fallback.textContent = metadata.fallback;
      fallback.setAttribute("aria-hidden", "true");
      fallback.setAttribute("data-provider-logo-fallback", providerID);
      this.stylePanel(fallback, {
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "10px",
        border: "0",
        flex: `0 0 ${size}px`,
        color: "var(--fill-primary, inherit)",
        background: "var(--material-button-hover, rgba(127,127,127,.22))",
        fontSize: size > 30 ? "18px" : "13px",
        fontWeight: "600"
      });
      image.addEventListener("error", () => {
        image.style.display = "none";
        fallback.style.display = "inline-flex";
      });

      const wrapper = doc.createElement("span");
      this.stylePanel(wrapper, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        flex: `0 0 ${size}px`
      });
      wrapper.append(image, fallback);
      return wrapper;
    },

    makeProviderCard(doc, metadata) {
      const button = this.makePanelButton(doc, "");
      button.dataset.provider = metadata.id;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("data-provider-card", "true");
      button.setAttribute("aria-label", metadata.label);
      this.stylePanel(button, {
        minHeight: "72px",
        height: "72px",
        padding: "8px 12px",
        border: "0",
        borderRadius: "12px",
        background: metadata.color,
        color: "#f2f3f7",
        textAlign: "left",
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "10px",
        boxSizing: "border-box",
        boxShadow: "0 2px 4px rgba(0,0,0,.18)",
        cursor: "pointer",
        position: "relative"
      });

      const logo = this.makeProviderLogo(doc, metadata.id, 42);
      const check = doc.createElement("span");
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("data-provider-card-check", metadata.id);
      this.stylePanel(check, {
        visibility: "hidden",
        position: "absolute",
        top: "8px",
        right: "10px",
        color: "#f2f3f7",
        fontSize: "21px",
        lineHeight: "1",
        fontWeight: "600"
      });
      const label = doc.createElement("strong");
      label.setAttribute("data-provider-card-label", "true");
      this.setPanelText(label,
        `reader-selection-replacer-test-pane-provider-${metadata.id}`,
        metadata.label, doc);
      this.stylePanel(label, {
        display: "block",
        fontSize: "17px",
        lineHeight: "1.15",
        fontWeight: "700",
        letterSpacing: "-.02em"
      });

      button.append(logo, label, check);
      return button;
    },

    renderItemPane({ doc, body, item, tabType }) {
      if (!doc || !body) return;
      for (const oldState of [...this.panelStates]) {
        if (oldState.body === body) this.panelStates.delete(oldState);
      }
      body.replaceChildren?.();

      this.ensureProviderPanelStyle(doc);
      const container = doc.createElement("div");
      container.setAttribute("data-provider-panel", "true");
      this.stylePanel(container, {
        display: "flex",
        flexDirection: "column",
        gap: "0",
        padding: "0",
        color: "var(--fill-primary, inherit)",
        fontSize: "14px",
        boxSizing: "border-box",
        width: "100%",
        marginTop: "12px"
      });

      const providerPanel = doc.createElement("div");
      this.stylePanel(providerPanel, {
        display: "flex",
        flexDirection: "column",
        gap: "0",
        border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
        borderRadius: "11px",
        background: "rgba(127,127,127,.03)",
        overflow: "hidden"
      });
      const providerHeader = doc.createElement("button");
      providerHeader.type = "button";
      providerHeader.setAttribute("aria-expanded", "true");
      this.stylePanel(providerHeader, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        minHeight: "48px",
        padding: "6px 12px",
        border: "0",
        borderBottom: "1px solid var(--fill-quinary, rgba(0,0,0,.35))",
        borderRadius: "0",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer"
      });
      const providerTitle = doc.createElement("span");
      this.stylePanel(providerTitle, {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        minWidth: "0",
        color: "var(--fill-secondary, #aeb0b6)",
        fontSize: "15px",
        fontWeight: "600"
      });
      const providerHeaderLogo = doc.createElement("span");
      const providerHeaderLabel = doc.createElement("span");
      providerTitle.append(providerHeaderLogo, providerHeaderLabel);
      const providerChevron = doc.createElement("span");
      providerChevron.textContent = "⌃";
      providerChevron.setAttribute("aria-hidden", "true");
      this.stylePanel(providerChevron, { fontSize: "18px", opacity: "0.7" });
      providerHeader.append(providerTitle, providerChevron);

      const providerContent = doc.createElement("div");
      this.stylePanel(providerContent, {
        display: "block",
        padding: "10px 14px 14px"
      });
      const providerButtons = doc.createElement("div");
      providerButtons.setAttribute("data-provider-cards", "true");
      this.stylePanel(providerButtons, {
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: "10px"
      });
      for (const metadata of TRANSLATION_PROVIDER_UI) {
        providerButtons.append(this.makeProviderCard(doc, metadata));
      }

      const divider = doc.createElement("div");
      this.stylePanel(divider, {
        height: "1px",
        margin: "16px 0 14px",
        background: "var(--fill-quinary, rgba(0,0,0,.42))"
      });

      const inputSection = doc.createElement("div");
      this.stylePanel(inputSection, {
        display: "flex",
        flexDirection: "column",
        gap: "9px"
      });
      const apiInput = doc.createElement("input");
      apiInput.type = "password";
      apiInput.readOnly = false;
      apiInput.autocomplete = "new-password";
      apiInput.spellcheck = false;
      this.stylePanel(apiInput, {
        boxSizing: "border-box",
        width: "100%",
        minHeight: "50px",
        padding: "8px 12px",
        color: "var(--fill-secondary, #9ca3af)",
        background: "transparent",
        border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
        borderRadius: "8px",
        font: "inherit",
        textAlign: "center",
        fontFamily: "monospace"
      });
      const statusRow = doc.createElement("div");
      this.stylePanel(statusRow, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minHeight: "24px",
        color: "var(--fill-secondary, inherit)",
        padding: "0 3px"
      });
      const statusLamp = this.makeStatusLamp(doc);
      const apiStatus = doc.createElement("span");
      const retryValidation = this.makeRetryButton(doc);
      statusRow.append(statusLamp, apiStatus, retryValidation);
      inputSection.append(apiInput, statusRow);

      const actions = doc.createElement("div");
      this.stylePanel(actions, {
        display: "flex",
        justifyContent: "space-between",
        gap: "16px"
      });
      const resetKey = this.makePanelButton(doc, "重置", true);
      const saveKey = this.makePanelButton(doc, "保存");
      this.setPanelText(resetKey,
        "reader-selection-replacer-test-pane-reset", "重置", doc);
      this.setPanelText(saveKey,
        "reader-selection-replacer-test-pane-save", "保存", doc);
      this.stylePanel(resetKey, {
        flex: "1 1 0",
        minHeight: "46px",
        border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
        borderRadius: "8px",
        background: "transparent",
        fontSize: "16px"
      });
      this.stylePanel(saveKey, {
        flex: "1 1 0",
        minHeight: "46px",
        border: "1px solid var(--fill-quinary, rgba(0,0,0,.55))",
        borderRadius: "8px",
        background: "transparent",
        fontSize: "16px"
      });
      actions.append(resetKey, saveKey);

      providerContent.append(providerButtons, divider, inputSection, actions);
      providerPanel.append(providerHeader, providerContent);
      const previewSection = doc.createElement("div");
      previewSection.setAttribute("data-translation-preview", "true");
      this.stylePanel(previewSection, {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        width: "100%",
        marginTop: "10px"
      });
      const translatedPreview = this.makeTranslationPreviewBox(doc, "translated");
      const originalPreview = this.makeTranslationPreviewBox(doc, "original");
      previewSection.append(translatedPreview.wrapper, originalPreview.wrapper);
      container.append(providerPanel, previewSection);
      body.append(container);

      const providerCardMap = new Map(
        [...providerButtons.children].map(button => [button.dataset.provider, button])
      );
      const state = {
        body,
        itemID: item?.id || null,
        tabType,
        container,
        providerPanel,
        providerHeader,
        providerHeaderLogo,
        providerHeaderLabel,
        providerChevron,
        providerContent,
        providerButtons,
        providerCardMap,
        previewSection,
        translatedPreviewText: translatedPreview.text,
        originalPreviewText: originalPreview.text,
        translatedCopyButton: translatedPreview.copyButton,
        originalCopyButton: originalPreview.copyButton,
        divider,
        inputSection,
        apiInput,
        statusRow,
        statusLamp,
        apiStatus,
        retryValidation,
        actions,
        resetKey,
        saveKey,
        providerID: this.activeProviderID || "",
        savedKey: "",
        loadToken: 0,
        previewSignature: ""
      };
      state.qwenButton = providerCardMap.get("qwen-mt");
      state.deepSeekButton = providerCardMap.get("deepseek");
      this.panelStates.add(state);
      providerHeader.addEventListener("click", () => {
        const expanded = providerHeader.getAttribute("aria-expanded") !== "false";
        providerHeader.setAttribute("aria-expanded", String(!expanded));
        providerContent.style.display = expanded ? "none" : "block";
        providerChevron.textContent = expanded ? "⌄" : "⌃";
      });
      for (const [providerID, button] of providerCardMap) {
        button.addEventListener("click", () => this.selectProviderForPanels(providerID));
      }
      translatedPreview.copyButton.addEventListener("click",
        () => this.copyPreviewText(state, "translated"));
      originalPreview.copyButton.addEventListener("click",
        () => this.copyPreviewText(state, "original"));
      apiInput.addEventListener("input", () => {
        state.inputDirty = true;
        state.maskedPreview = false;
      });
      saveKey.addEventListener("click", () => this.saveAPIKeyFromPanel(state));
      resetKey.addEventListener("click", () => this.removeAPIKey(state));
      retryValidation.addEventListener("click", () => this.revalidateAPIKey(state));

      this.updatePanelState(state);
      if (this.activeProviderID) this.loadProviderIntoPanel(state, true);
    },

    async selectProviderForPanels(providerID) {
      const id = TRANSLATION_PROVIDER_UI_BY_ID[providerID] ? providerID : "";
      const previousID = this.activeProviderID;
      this.activeProviderID = globalThis.setActiveTranslationProviderID?.(id) || id;
      if (previousID !== this.activeProviderID) {
        this.latestTranslationPreviews.clear();
        this.refreshAllPanels();
      }
      await Promise.all([...this.panelStates].map(state => {
        state.providerID = this.activeProviderID;
        return this.loadProviderIntoPanel(state, true);
      }));
      this.refreshAllPanels();
      const provider = this.getProvider(this.activeProviderID);
      const providerState = this.activeProviderID
        ? this.getProviderState(this.activeProviderID) : null;
      if (provider?.credentialMode === "none" || providerState?.status === "configured") {
        this.restartActiveReaders();
      }
    },

    async loadProviderIntoPanel(state, validate = true) {
      if (!state) return false;
      const token = ++state.loadToken;
      state.providerID = this.activeProviderID;
      state.savedKey = "";
      state.apiInput.value = "";
      state.inputDirty = false;
      state.maskedPreview = false;
      if (state.providerID) this.setProviderState(state.providerID, "missing", "");
      this.updatePanelState(state);
      if (!state.providerID) return false;
      const provider = this.getProvider(state.providerID);
      if (!provider) return false;
      if (provider.credentialMode === "none") return true;
      const credentials = provider.credentials;
      if (!credentials?.getKey) return false;
      let apiKey = "";
      try {
        apiKey = String(await credentials.getKey() || "").trim();
      }
      catch (error) {
        this.setProviderState(state.providerID, "invalid", String(error?.message || error));
        this.updatePanelState(state);
        return false;
      }
      if (token !== state.loadToken) return false;
      state.savedKey = apiKey;
      this.updatePanelState(state);
      if (!apiKey || !validate) {
        this.setProviderState(state.providerID, apiKey ? "unknown" : "missing", "");
        this.updatePanelState(state);
        return Boolean(apiKey);
      }
      return this.revalidateAPIKey(state, { apiKey, saveOnSuccess: false });
    },

    async revalidateProviderKey(providerID = this.activeProviderID) {
      const provider = this.getProvider(providerID);
      if (!provider) return false;
      const credentials = provider.credentials;
      const state = this.setProviderState(provider.id, "missing", "");
      if (!credentials?.getKey) return false;
      const apiKey = String(await credentials.getKey() || "").trim();
      if (!apiKey) {
        state.status = "missing";
        this.refreshAllPanels();
        return false;
      }
      const requestOptions = this.providerRequestOptions(provider);
      state.status = "validating";
      this.refreshAllPanels();
      try {
        await credentials.validateKey(apiKey, requestOptions);
        state.status = "configured";
        state.message = "";
        this.refreshAllPanels();
        return true;
      }
      catch (error) {
        state.status = "invalid";
        state.message = String(error?.message || error);
        this.refreshAllPanels();
        return false;
      }
    },

    async saveAPIKeyFromPanel(state) {
      if (!state) return false;
      const provider = this.getProvider(state.providerID);
      if (!provider || provider.credentialMode !== "api-key") return false;
      const credentials = provider.credentials;
      const inputKey = state.inputDirty
        ? String(state.apiInput?.value || "").trim()
        : "";
      const apiKey = inputKey || state.savedKey
        || String(await credentials?.getKey?.() || "").trim();
      if (!apiKey) {
        this.setProviderState(state.providerID, "missing", "请输入 API Key。");
        this.setPanelMessage(state, "请输入 API Key。", false);
        this.updatePanelState(state);
        return false;
      }
      return this.revalidateAPIKey(state, { apiKey, saveOnSuccess: Boolean(inputKey) });
    },

    async revalidateAPIKey(state = null, options = {}) {
      const providerID = state?.providerID || this.activeProviderID;
      const provider = this.getProvider(providerID);
      if (!provider || provider.credentialMode !== "api-key") return false;
      const credentials = provider.credentials;
      const inputKey = state?.inputDirty
        ? String(state.apiInput?.value || "").trim()
        : "";
      const apiKey = String(options.apiKey || inputKey || state?.savedKey
        || await credentials?.getKey?.() || "").trim();
      if (!apiKey) {
        this.setProviderState(providerID, "missing", "请输入 API Key。");
        if (state) this.setPanelMessage(state, "请输入 API Key。", false);
        this.updatePanelState(state);
        return false;
      }
      const requestOptions = this.providerRequestOptions(provider);
      const providerState = this.setProviderState(providerID, "validating", "");
      const token = ++providerState.validationToken;
      this.refreshAllPanels();
      try {
        await credentials.validateKey(apiKey, requestOptions);
        if (token !== providerState.validationToken) return false;
        const shouldSave = options.saveOnSuccess !== false
          && Boolean(inputKey)
          && inputKey !== state?.savedKey;
        if (shouldSave) {
          await credentials.saveKey(inputKey);
          if (state) state.savedKey = inputKey;
        }
        if (state && shouldSave) {
          state.apiInput.value = "";
          state.inputDirty = false;
          state.maskedPreview = true;
        }
        providerState.status = "configured";
        providerState.message = "";
        if (state) this.setPanelMessage(state,
          provider.label + " API Key 验证成功。", false);
        this.refreshAllPanels();
        if (shouldSave) this.restartActiveReaders();
        else this.restartFailedAutoSessions();
        return true;
      }
      catch (error) {
        if (token !== providerState.validationToken) return false;
        providerState.status = "invalid";
        providerState.message = String(error?.message || error);
        if (state) this.setPanelMessage(state, providerState.message, true);
        this.refreshAllPanels();
        return false;
      }
    },

    async removeAPIKey(state = null) {
      const providerID = state?.providerID || this.activeProviderID;
      const provider = this.getProvider(providerID);
      if (!provider || provider.credentialMode !== "api-key") return false;
      const confirmed = Services.prompt?.confirm
        ? Services.prompt.confirm(null, "Translator for Zotero", "确定删除当前模型的 API Key？")
        : true;
      if (!confirmed) return false;
      try {
        await provider.credentials?.deleteKey?.();
        if (state) {
          state.savedKey = "";
          state.apiInput.value = "";
          state.inputDirty = false;
          state.maskedPreview = false;
        }
        this.setProviderState(providerID, "missing", "");
        if (state) this.setPanelMessage(state, provider.label + " API Key 已删除。", false);
        this.refreshAllPanels();
        return true;
      }
      catch (error) {
        this.setProviderState(providerID, "invalid", String(error?.message || error));
        if (state) this.setPanelMessage(state, String(error?.message || error), true);
        this.refreshAllPanels();
        return false;
      }
    },

    restartFailedAutoSessions() {
      for (const reader of Zotero.Reader?._readers || []) {
        const session = this.autoSessions.get(reader);
        const failed = Boolean(session?.error || session?.translation?.diagnostics?.failed);
        if (failed) {
          this.autoSessions.delete(reader);
          this.autoMarkReader(reader).catch(error => Zotero.logError?.(error));
        }
      }
    },

    restartActiveReaders() {
      if (!this.activeProviderID) return;
      for (const reader of Zotero.Reader?._readers || []) {
        const session = this.autoSessions.get(reader);
        if (session) session.cancelled = true;
        this.autoSessions.delete(reader);
        this.autoMarkReader(reader, { force: true }).catch(error => Zotero.logError?.(error));
      }
    },

    updatePanelState(state) {
      if (!state) return;
      const doc = state.container?.ownerDocument || state.body?.ownerDocument;
      const providerID = state.providerID || this.activeProviderID || "";
      const provider = this.getProvider(providerID);
      const metadata = this.getProviderUI(providerID);
      const providerState = provider ? this.getProviderState(providerID)
        : { status: "missing", message: "" };
      for (const [cardID, button] of state.providerCardMap || []) {
        const selected = cardID === providerID;
        const card = this.getProviderUI(cardID);
        button.setAttribute("aria-pressed", String(selected));
        button.style.border = "0";
        button.style.padding = "8px 12px";
        button.style.background = card?.color || "var(--material-button, transparent)";
        button.style.boxShadow = "0 2px 4px rgba(0,0,0,.18)";
        const check = button.children?.[2];
        if (check) check.style.visibility = selected ? "visible" : "hidden";
      }
      state.providerHeaderLogo.replaceChildren?.();
      if (metadata) {
        state.providerHeaderLogo.append(this.makeProviderLogo(doc, providerID, 26));
        this.setPanelText(state.providerHeaderLabel,
          `reader-selection-replacer-test-pane-provider-${providerID}`,
          metadata.label, doc);
        state.providerHeaderLabel.style.color = "inherit";
      }
      else {
        this.setPanelText(state.providerHeaderLabel,
          "reader-selection-replacer-test-pane-no-provider", "选择翻译模型",
          doc);
        state.providerHeaderLabel.style.color = "var(--fill-secondary, #aeb0b6)";
      }
      const keyedProvider = provider?.credentialMode === "api-key";
      state.divider.style.display = keyedProvider ? "block" : "none";
      state.inputSection.style.display = keyedProvider ? "flex" : "none";
      state.actions.style.display = keyedProvider ? "flex" : "none";
      const editing = Boolean(state.inputDirty);
      const hasSavedKey = Boolean(state.savedKey);
      const inputL10nID = providerID
        ? `reader-selection-replacer-test-pane-api-key-${providerID}` : "";
      this.setPanelAttributes(state.apiInput, inputL10nID, {
        placeholder: provider ? `输入${provider.label} API Key` : "",
        "aria-label": provider ? `${provider.label} API Key` : ""
      });
      if (hasSavedKey && !editing) {
        state.apiInput.readOnly = true;
        state.apiInput.type = "text";
        state.apiInput.value = this.maskAPIKey(state.savedKey);
        state.apiInput.placeholder = "";
        state.apiInput.style.color = "var(--fill-secondary, #9ca3af)";
        state.maskedPreview = true;
      }
      else {
        state.apiInput.readOnly = false;
        state.apiInput.type = "password";
        state.apiInput.style.color = "inherit";
        if (!editing) state.apiInput.value = "";
        state.maskedPreview = false;
      }
      state.apiInput.setAttribute("aria-readonly", String(Boolean(state.apiInput.readOnly)));
      state.apiStatus.textContent = provider
        ? this.providerStatusText(provider, providerState) : "";
      state.statusLamp.style.background = this.providerStatusColor(providerState.status);
      state.retryValidation.style.visibility =
        keyedProvider && providerState.status === "invalid" ? "visible" : "hidden";
      state.retryValidation.disabled = providerState.status === "validating";
      state.saveKey.disabled = !keyedProvider || providerState.status === "validating";
      state.resetKey.disabled = !keyedProvider || providerState.status === "validating";
      this.updateTranslationPreviewPanel(state);
    },
  };

  global.TranslatorProviderPanel = Object.freeze(TranslatorProviderPanel);
})(globalThis);
