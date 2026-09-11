"use strict";

// Keep provider fixes in a small, credential-free module. This also lets the
// bootstrap use the same fixes when an older public translation-service.js is
// already present in a user's profile.
(function (global) {
  const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  const DEEPSEEK_MODEL_CANDIDATES = Object.freeze([
    "deepseek-v4-flash",
    "deepseek-flash",
    "deepseek-chat",
    "deepseek-v4-pro"
  ]);
  const QWEN_CHAT_ENDPOINT =
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
  const VALIDATION_TIMEOUT = 5000;
  const REQUEST_TIMEOUT = 10000;

  function delay(milliseconds) {
    return Zotero.Promise?.delay
      ? Zotero.Promise.delay(milliseconds)
      : new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value || "")) {
      hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function parseResponse(response) {
    if (response?.response && typeof response.response === "object") {
      return response.response;
    }
    if (typeof response?.responseText === "string") {
      try {
        return JSON.parse(response.responseText);
      }
      catch (_) {
        return response;
      }
    }
    return response;
  }

  function errorDetails(response) {
    const data = parseResponse(response) || {};
    const nested = data.error && typeof data.error === "object" ? data.error : null;
    const value = nested || data;
    return {
      code: String(value.code || data.code || "").trim(),
      message: String(value.message || data.message || "").trim(),
      requestID: String(value.request_id || value.requestId
        || data.request_id || data.requestId || "").trim()
    };
  }

  function providerHTTPError(provider, status, response, fallback = "") {
    const details = errorDetails(response);
    const label = fallback || `${provider} HTTP ${status || "unknown"}`;
    const suffix = [details.code, details.message,
      details.requestID ? `request_id=${details.requestID}` : ""]
      .filter(Boolean).join("；");
    return Object.assign(new Error(suffix ? `${label}：${suffix}` : label), {
      status,
      code: details.code || (status ? `http-${status}` : "provider-http-error"),
      providerCode: details.code,
      requestID: details.requestID
    });
  }

  function isSelectionSegment(segment) {
    return ["custom", "unclassified"].includes(segment?.kind);
  }

  function selectionUnits(segment) {
    const units = (segment?.metadata?.selectionUnits || []).map((unit, index) => ({
      id: String(unit?.id || `unit-${index}`),
      sourceText: String(unit?.sourceText || "").trim(),
      breakAfter: unit?.breakAfter === "paragraph" ? "paragraph" : "none"
    })).filter(unit => unit.id && unit.sourceText);
    return units.length ? units : [{
      id: "unit-0",
      sourceText: String(segment?.sourceText || "").trim(),
      breakAfter: "none"
    }];
  }

  function chooseDeepSeekModel(models) {
    const available = new Set((models || []).map(value => String(value || "").trim())
      .filter(Boolean));
    return DEEPSEEK_MODEL_CANDIDATES.find(model => available.has(model)) || "";
  }

  async function listDeepSeekModels(apiKey) {
    const response = await Zotero.HTTP.request("GET", `${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${String(apiKey || "").trim()}` },
      responseType: "json",
      timeout: VALIDATION_TIMEOUT,
      successCodes: false,
      errorDelayMax: 0
    });
    const status = Number(response?.status || 0);
    if (status === 401 || status === 403) {
      throw providerHTTPError("DeepSeek", status, response, "DeepSeek API Key 无效");
    }
    if (status < 200 || status >= 300) {
      throw providerHTTPError("DeepSeek", status, response);
    }
    const data = parseResponse(response);
    return (data?.data || []).map(model => String(model?.id || "").trim())
      .filter(Boolean);
  }

  function modelUnavailableError(models) {
    const available = (models || []).length ? models.join(", ") : "无";
    return Object.assign(new Error(
      `账户没有可用的兼容 DeepSeek 模型；支持候选：${DEEPSEEK_MODEL_CANDIDATES.join(", ")}`
        + `；账户返回：${available}`
    ), { code: "model-unavailable", availableModels: models || [] });
  }

  const deepSeek = global.DeepSeekTranslationClient;
  if (deepSeek) {
    deepSeek.setResolvedModel = function (model, apiKey) {
      const value = String(model || "").trim();
      if (!DEEPSEEK_MODEL_CANDIDATES.includes(value)) {
        throw new Error(`不支持的 DeepSeek 模型：${value || "unknown"}`);
      }
      this.resolvedModel = value;
      this.resolvedKeyFingerprint = fingerprint(apiKey);
      return value;
    };

    deepSeek.ensureResolvedModel = async function (apiKey) {
      const keyFingerprint = fingerprint(apiKey);
      if (this.resolvedModel && this.resolvedKeyFingerprint === keyFingerprint) {
        return this.resolvedModel;
      }
      const models = await listDeepSeekModels(apiKey);
      const selectedModel = chooseDeepSeekModel(models);
      if (!selectedModel) throw modelUnavailableError(models);
      return this.setResolvedModel(selectedModel, apiKey);
    };

    deepSeek.request = async function (apiKey, segments, session, repair = false) {
      const model = await this.ensureResolvedModel(apiKey);
      const payload = {
        model,
        thinking: { type: "disabled" },
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: this.prompt(repair, segments) },
          { role: "user", content: JSON.stringify({
            segments: segments.map(segment => isSelectionSegment(segment)
              ? { id: segment.id, kind: segment.kind,
                units: selectionUnits(segment).map(unit => ({ id: unit.id,
                  text: unit.sourceText })) }
              : { id: segment.id, kind: segment.kind, text: segment.sourceText })
          }) }
        ]
      };
      const retryDelays = [];
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (session?.cancelled) throw new Error("翻译已取消");
        let response;
        try {
          response = await Zotero.HTTP.request("POST",
            `${DEEPSEEK_BASE_URL}/chat/completions`, {
              headers: {
                Authorization: `Bearer ${String(apiKey || "").trim()}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(payload),
              responseType: "json",
              timeout: REQUEST_TIMEOUT,
              successCodes: false,
              errorDelayMax: 0
            });
        }
        catch (error) {
          if (attempt < retryDelays.length) {
            await delay(retryDelays[attempt]);
            continue;
          }
          throw error;
        }
        const status = Number(response?.status || 0);
        if (status >= 200 && status < 300) {
          const data = parseResponse(response);
          return data?.choices?.[0]?.message?.content;
        }
        if (status === 401 || status === 403) {
          throw providerHTTPError("DeepSeek", status, response, "DeepSeek API Key 无效");
        }
        const error = providerHTTPError("DeepSeek", status, response);
        if ((status === 429 || status >= 500) && attempt < retryDelays.length) {
          await delay(retryDelays[attempt]);
          continue;
        }
        throw error;
      }
      throw new Error("DeepSeek 请求失败");
    };

    if (global.DeepSeekCredentials) {
      global.DeepSeekCredentials.validateKey = async function (apiKey) {
        if (!String(apiKey || "").trim()) throw new Error("API Key 不能为空");
        const models = await listDeepSeekModels(apiKey);
        const selectedModel = chooseDeepSeekModel(models);
        if (!selectedModel) throw modelUnavailableError(models);
        deepSeek.setResolvedModel(selectedModel, apiKey);
        return true;
      };
    }
  }

  const qwen = global.QwenMTPlusTranslationClient;
  if (qwen) {
    qwen.request = async function (apiKey, segments, session, options = {}) {
      if (!Array.isArray(segments) || segments.length !== 1) {
        throw Object.assign(new Error("Qwen-MT 每次请求只能翻译一个分段"),
          { code: "single-segment-only" });
      }
      if (!String(apiKey || "").trim()) {
        throw Object.assign(new Error("未配置 Qwen-MT API Key"), { code: "missing-key" });
      }
      const payload = this.buildPayload(segments[0], options);
      const retryDelays = Array.isArray(options?.retryDelays) ? options.retryDelays : [];
      const requestedTimeout = Number(options?.timeout);
      const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout : REQUEST_TIMEOUT;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (session?.cancelled) throw new Error("翻译已取消");
        let response;
        try {
          response = await Zotero.HTTP.request("POST", QWEN_CHAT_ENDPOINT, {
            headers: {
              Authorization: `Bearer ${apiKey.trim()}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            responseType: "json",
            timeout,
            successCodes: false,
            errorDelayMax: 0
          });
        }
        catch (error) {
          if (attempt < retryDelays.length) {
            await delay(retryDelays[attempt]);
            continue;
          }
          throw error;
        }
        const status = Number(response?.status || 0);
        if (status >= 200 && status < 300) return this.extractText(response);
        if (status === 401 || status === 403) {
          throw providerHTTPError("Qwen-MT", status, response, "Qwen-MT API Key 无效");
        }
        const error = providerHTTPError("Qwen-MT", status, response);
        if ((status === 429 || status >= 500) && attempt < retryDelays.length) {
          await delay(retryDelays[attempt]);
          continue;
        }
        throw error;
      }
      throw new Error("Qwen-MT 请求失败");
    };

    if (global.QwenCredentials) {
      global.QwenCredentials.validateKey = async function (apiKey, options = {}) {
        if (!String(apiKey || "").trim()) {
          throw Object.assign(new Error("API Key 不能为空"), { code: "missing-key" });
        }
        await qwen.request(apiKey, [{
          id: "provider-validation",
          kind: "custom",
          sourceText: "test",
          sourceLanguage: "en"
        }], { cancelled: false }, {
          ...options,
          targetLanguage: "zh-CN",
          timeout: VALIDATION_TIMEOUT,
          retryDelays: []
        });
        return true;
      };
    }
  }
})(globalThis);
