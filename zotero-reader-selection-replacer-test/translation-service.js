"use strict";

const PROVIDER_CREDENTIALS_ORIGIN = "chrome://paper-assistant-provider-settings";
const PROVIDER_CREDENTIALS_USERNAME = "default";
const DEEPSEEK_REALM = "Paper Assistant DeepSeek API";
const QWEN_MT_REALM = "Paper Assistant Qwen API";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PROVIDER = "deepseek";
const QWEN_MT_PROVIDER = "qwen-mt";
const QWEN_MT_PLUS_MODEL = "qwen-mt-plus";
const ACTIVE_TRANSLATION_PROVIDER_PREF =
  "extensions.reader-selection-replacer.activeTranslationProvider";
// Qwen-MT uses the Beijing shared OpenAI-compatible endpoint. Keep this
// internal so users only need to provide the API key in the side pane.
const QWEN_MT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const TRANSLATION_PROMPT_VERSION = "front-matter-translation-v2-title-break";
const SELECTION_TRANSLATION_PROMPT_VERSION = "selection-translation-v1";
const TITLE_BREAK_MARKER = "<br>";
const TRANSLATION_CACHE_FILE = "paper-assistant-segment-translations.sqlite";
const API_KEY_PROMPTED_PREF = "extensions.reader-selection-replacer.apiKeyPrompted";
// Keep failures observable during setup and manual troubleshooting. A request
// that cannot reach the selected provider should not occupy the pane for minutes.
const VALIDATION_REQUEST_TIMEOUT = 5000;
const TRANSLATION_REQUEST_TIMEOUT = 10000;
const NETWORK_RETRY_DELAYS = [];
const CONTENT_RETRY_DELAYS = [];
const QWEN_MT_LANGUAGE_NAMES = Object.freeze({
  auto: "auto",
  en: "English",
  "en-US": "English",
  "en-GB": "English",
  zh: "Chinese",
  "zh-CN": "Chinese",
  "zh-TW": "Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  "pt-BR": "Portuguese",
  ru: "Russian",
  ar: "Arabic",
  th: "Thai",
  id: "Indonesian",
  vi: "Vietnamese"
});

var TranslationModelRegistry = Object.freeze({
  deepseek: Object.freeze({
    provider: DEEPSEEK_PROVIDER,
    model: DEEPSEEK_MODEL,
    label: "DeepSeek"
  }),
  qwenMTPlus: Object.freeze({
    provider: QWEN_MT_PROVIDER,
    model: QWEN_MT_PLUS_MODEL,
    label: "Qwen-MT Plus"
  })
});

function translationDelay(milliseconds) {
  return Zotero.Promise?.delay
    ? Zotero.Promise.delay(milliseconds)
    : new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseAPIResponse(response) {
  if (response?.response && typeof response.response === "object") return response.response;
  if (typeof response?.responseText === "string") return JSON.parse(response.responseText);
  return response;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function positionSignature(position) {
  const fragments = position?.fragments?.length ? position.fragments : [position];
  return stableHash(JSON.stringify((fragments || []).map(fragment => ({
    pageIndex: Number(fragment?.pageIndex || 0),
    rects: (fragment?.rects || []).map(rect => rect.map(value => Number(value).toFixed(3)))
  }))));
}

var DeepSeekCredentials = {
  provider: DEEPSEEK_PROVIDER,
  origin: PROVIDER_CREDENTIALS_ORIGIN,
  realm: DEEPSEEK_REALM,
  username: PROVIDER_CREDENTIALS_USERNAME,

  async findLogin() {
    const query = { origin: this.origin, httpRealm: this.realm };
    const logins = Services.logins.searchLoginsAsync
      ? await Services.logins.searchLoginsAsync(query)
      : Services.logins.findLogins(this.origin, null, this.realm);
    return (logins || []).find(login => login.username === this.username) || null;
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
    const login = new LoginInfo(this.origin, null, this.realm,
      this.username, apiKey.trim(), "", "");
    if (Services.logins.addLoginAsync) await Services.logins.addLoginAsync(login);
    else Services.logins.addLogin(login);
  },

  async deleteKey() {
    const login = await this.findLogin();
    if (login) Services.logins.removeLogin(login);
  },

  async validateKey(apiKey) {
    if (!String(apiKey || "").trim()) throw new Error("API Key 不能为空");
    const response = await Zotero.HTTP.request("GET", `${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      responseType: "json",
      timeout: VALIDATION_REQUEST_TIMEOUT,
      successCodes: false
    });
    const status = Number(response?.status || 0);
    if (status === 401 || status === 403) throw Object.assign(new Error("API Key 无效"), { status });
    if (status < 200 || status >= 300) throw Object.assign(new Error(`DeepSeek HTTP ${status}`), { status });
    const data = parseAPIResponse(response);
    const models = (data?.data || []).map(model => model?.id);
    if (!models.includes(DEEPSEEK_MODEL)) throw new Error(`账户不可用模型：${DEEPSEEK_MODEL}`);
    return true;
  }
};

var QwenCredentials = Object.create(DeepSeekCredentials);
QwenCredentials.provider = QWEN_MT_PROVIDER;
QwenCredentials.realm = QWEN_MT_REALM;

QwenCredentials.validateKey = async function(apiKey, options = {}) {
  if (!String(apiKey || "").trim()) {
    throw Object.assign(new Error("API Key 不能为空"), { code: "missing-key" });
  }
  await QwenMTPlusTranslationClient.request(
    apiKey,
    [{
      id: "provider-validation",
      kind: "custom",
      sourceText: "test",
      sourceLanguage: "en"
    }],
    { cancelled: false },
    {
      ...options,
      targetLanguage: "zh-CN",
      timeout: VALIDATION_REQUEST_TIMEOUT,
      retryDelays: []
    }
  );
  return true;
};

function getPreferenceString(name, fallback = "") {
  try {
    return String(Services.prefs?.getCharPref?.(name, fallback) || fallback);
  }
  catch (_) {
    return fallback;
  }
}

function getActiveTranslationProviderID() {
  const value = getPreferenceString(
    ACTIVE_TRANSLATION_PROVIDER_PREF,
    DEEPSEEK_PROVIDER
  );
  return value === QWEN_MT_PROVIDER ? QWEN_MT_PROVIDER : DEEPSEEK_PROVIDER;
}

function setActiveTranslationProviderID(provider) {
  const value = provider === QWEN_MT_PROVIDER
    ? QWEN_MT_PROVIDER
    : DEEPSEEK_PROVIDER;
  try {
    Services.prefs?.setCharPref?.(ACTIVE_TRANSLATION_PROVIDER_PREF, value);
  }
  catch (_) {
    // Preference storage is unavailable in isolated tests and early startup.
  }
  return value;
}

function getQwenMTRequestOptions() {
  return { baseURL: QWEN_MT_BASE_URL };
}

var SegmentTranslationCache = {
  db: null,
  readyPromise: null,

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      if (!Zotero.DBConnection || !Zotero.DataDirectory?.dir) return;
      this.db = new Zotero.DBConnection(PathUtils.join(Zotero.DataDirectory.dir,
        TRANSLATION_CACHE_FILE));
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS segment_translations (
        library_id INTEGER NOT NULL,
        attachment_key TEXT NOT NULL,
        segment_kind TEXT NOT NULL,
        position_signature TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_language TEXT NOT NULL,
        target_language TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (library_id, attachment_key, segment_kind, position_signature,
          source_hash, source_language, target_language, provider, model, prompt_version)
      )`);
    })().catch(error => {
      this.db = null;
      Zotero.logError?.(error);
    });
    return this.readyPromise;
  },

  key(attachment, segment, targetLanguage,
    modelSpec = TranslationModelRegistry.deepseek) {
    return {
      libraryID: Number(attachment?.libraryID || 0),
      attachmentKey: String(attachment?.key || attachment?.id || ""),
      segmentKind: segment.kind,
      positionSignature: positionSignature(segment.position),
      sourceHash: stableHash(segment.sourceText),
      sourceLanguage: segment.sourceLanguage,
      targetLanguage,
      provider: modelSpec.provider,
      model: modelSpec.model,
      promptVersion: this.promptVersion(segment)
    };
  },

  promptVersion(segment) {
    return ["custom", "unclassified"].includes(segment?.kind)
      ? SELECTION_TRANSLATION_PROMPT_VERSION : TRANSLATION_PROMPT_VERSION;
  },

  values(key) {
    return [key.libraryID, key.attachmentKey, key.segmentKind, key.positionSignature,
      key.sourceHash, key.sourceLanguage, key.targetLanguage, key.provider,
      key.model, key.promptVersion];
  },

  async get(attachment, segment, targetLanguage,
    modelSpec = TranslationModelRegistry.deepseek) {
    await this.init();
    if (!this.db) return null;
    const rows = await this.db.queryAsync(`SELECT translated_text AS translatedText
      FROM segment_translations WHERE library_id=? AND attachment_key=? AND segment_kind=?
      AND position_signature=? AND source_hash=? AND source_language=? AND target_language=?
      AND provider=? AND model=? AND prompt_version=?`,
    this.values(this.key(attachment, segment, targetLanguage, modelSpec)));
    return rows?.[0] || null;
  },

  async put(attachment, segment, targetLanguage, translatedText,
    modelSpec = TranslationModelRegistry.deepseek) {
    await this.init();
    if (!this.db || !String(translatedText || "").trim()) return;
    const key = this.key(attachment, segment, targetLanguage, modelSpec);
    await this.db.queryAsync(`INSERT OR REPLACE INTO segment_translations (
      library_id, attachment_key, segment_kind, position_signature, source_hash,
      source_language, target_language, provider, model, prompt_version,
      translated_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...this.values(key), translatedText.trim(), Date.now()]);
  },

  async close() {
    if (this.db) await this.db.closeDatabase();
    this.db = null;
    this.readyPromise = null;
  }
};

var DeepSeekTranslationClient = {
  prompt(repair = false, segments = []) {
    const selection = (segments || []).some(segment =>
      ["custom", "unclassified"].includes(segment?.kind));
    if (selection) {
      return [
        "将用户从英文学术 PDF 中划选的正文段落或文本忠实翻译为简体中文。",
        "只返回 JSON：{\"translations\":[{\"id\":\"segment-id\",\"zh\":\"中文\"}]}。",
        "每个输入 id 恰好返回一次；不得解释、总结、增删事实或使用 Markdown。",
        "保持术语、数字、单位、缩写、变量、引用和原文语气准确。",
        "自定义段落译文必须是纯文本，禁止 <br>、任何 HTML 标签和 Markdown。",
        repair ? "上次输出未通过校验，请完整重译并严格遵循 JSON、纯文本和逐段对应规则。" : ""
      ].filter(Boolean).join("\n");
    }
    return [
      "将英文学术论文的标题和摘要忠实翻译为简体中文。",
      "只返回 JSON：{\"translations\":[{\"id\":\"title\",\"zh\":\"中文\"}]}。",
      "每个输入 id 恰好返回一次；不得解释、总结、增删事实或使用 Markdown。",
      "保持术语、数字、单位、缩写、变量和引用准确。",
      "标题译文不超过 24 个有效字符时不要插入换行标记。",
      "标题译文超过 24 个有效字符时，在接近中间且语义自然的位置插入唯一一个 <br>。",
      "标题换行优先位于短语、并列结构、修饰语与中心语边界；两侧长度应尽量均衡。",
      "不得用 <br> 拆开专有名词、缩写、连续英文、数字与单位；摘要中禁止出现 <br>。",
      repair ? "上次输出未通过校验，请完整重译并严格遵循 JSON 和标题换行规则。" : ""
    ].filter(Boolean).join("\n");
  },

  splitsProtectedToken(left, right) {
    return /[A-Za-z0-9]/u.test(String(left || "").slice(-1))
      && /[A-Za-z0-9]/u.test(String(right || "").slice(0, 1));
  },

  normalizeTitleTranslation(text) {
    const raw = String(text || "").trim();
    if (/<(?!\s*br\s*\/?>)[^>]+>/iu.test(raw)) {
      throw Object.assign(new Error("标题译文包含不允许的 HTML 标签"),
        { code: "invalid-title-html" });
    }
    const markers = raw.match(/<\s*br\s*\/?>/giu) || [];
    if (markers.length > 1) {
      throw Object.assign(new Error("标题译文包含多个换行标记"),
        { code: "multiple-title-breaks" });
    }
    const plain = raw.replace(/<\s*br\s*\/?>/giu, "").trim();
    if (!markers.length) return plain;
    const [left = "", right = ""] = raw.split(/<\s*br\s*\/?>/iu)
      .map(value => value.trim());
    if (!left || !right || this.splitsProtectedToken(left, right)) {
      throw Object.assign(new Error("标题换行位置无效"), { code: "invalid-title-break" });
    }
    return `${left}${TITLE_BREAK_MARKER}${right}`;
  },

  parse(content) {
    if (content && typeof content === "object" && !Array.isArray(content)) return content;
    const text = String(content || "").replace(/^```(?:json)?|```$/gim, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw Object.assign(new Error("DeepSeek 返回无效 JSON"), { code: "invalid-json" });
    return JSON.parse(text.slice(start, end + 1));
  },

  validate(segments, payload) {
    const rows = Array.isArray(payload?.translations) ? payload.translations : [];
    const expected = new Set(segments.map(segment => segment.id));
    if (rows.length !== expected.size) throw Object.assign(new Error("译文数量不匹配"), { code: "row-count" });
    const result = new Map();
    for (const row of rows) {
      const id = String(row?.id || "");
      let zh = String(row?.zh || "").trim();
      if (!expected.has(id) || result.has(id) || !zh || !/[\u3400-\u9fff]/u.test(zh)) {
        throw Object.assign(new Error(`无效译文目标：${id || "unknown"}`), { code: "invalid-row" });
      }
      const segment = segments.find(value => value.id === id);
      if (segment?.kind === "title") zh = this.normalizeTitleTranslation(zh);
      else if (/<\s*br\s*\/?>/iu.test(zh) || /<[^>]+>/u.test(zh)) {
        const selection = ["custom", "unclassified"].includes(segment?.kind);
        throw Object.assign(new Error(selection
          ? "自定义段落译文包含不允许的换行或 HTML 标记"
          : "摘要译文包含不允许的换行或 HTML 标记"),
        { code: selection ? "invalid-selection-html" : "invalid-abstract-html" });
      }
      result.set(id, zh);
    }
    return result;
  },

  async request(apiKey, segments, session, repair = false) {
    const payload = {
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" },
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: this.prompt(repair, segments) },
        { role: "user", content: JSON.stringify({
          segments: segments.map(segment => ({ id: segment.id, kind: segment.kind, text: segment.sourceText }))
        }) }
      ]
    };
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS.length; attempt++) {
      if (session?.cancelled) throw new Error("翻译已取消");
      let response;
      try {
        response = await Zotero.HTTP.request("POST", `${DEEPSEEK_BASE_URL}/chat/completions`, {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload), responseType: "json",
          timeout: TRANSLATION_REQUEST_TIMEOUT,
          successCodes: false, errorDelayMax: 0
        });
      }
      catch (error) {
        if (attempt < NETWORK_RETRY_DELAYS.length) {
          await translationDelay(NETWORK_RETRY_DELAYS[attempt]);
          continue;
        }
        throw error;
      }
      const status = Number(response?.status || 0);
      if (status >= 200 && status < 300) {
        const data = parseAPIResponse(response);
        return data?.choices?.[0]?.message?.content;
      }
      if (status === 401 || status === 403) {
        throw Object.assign(new Error("API Key 无效"), { status });
      }
      const error = Object.assign(new Error(`DeepSeek HTTP ${status || "unknown"}`), { status });
      if ((status === 429 || status >= 500) && attempt < NETWORK_RETRY_DELAYS.length) {
        await translationDelay(NETWORK_RETRY_DELAYS[attempt]);
        continue;
      }
      throw error;
    }
    throw new Error("DeepSeek 请求失败");
  },

  async translate(apiKey, segments, session) {
    let lastError = null;
    for (let attempt = 0; attempt <= CONTENT_RETRY_DELAYS.length; attempt++) {
      if (attempt) await translationDelay(CONTENT_RETRY_DELAYS[attempt - 1]);
      try {
        return this.validate(segments, this.parse(await this.request(apiKey, segments, session, attempt > 0)));
      }
      catch (error) {
        if (error.status) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("译文校验失败");
  }
};

var QwenMTPlusTranslationClient = {
  provider: QWEN_MT_PROVIDER,
  model: QWEN_MT_PLUS_MODEL,

  languageName(language, source = false) {
    const value = String(language || "").trim();
    if (!value) {
      if (source) return "auto";
      throw Object.assign(new Error("Qwen-MT 目标语言不能为空"),
        { code: "missing-target-language" });
    }
    const mapped = QWEN_MT_LANGUAGE_NAMES[value];
    if (mapped) return mapped;
    if (/^[A-Za-z][A-Za-z .-]*$/u.test(value)) return value;
    throw Object.assign(new Error(`Qwen-MT 不支持的语言标识：${value}`),
      { code: "unsupported-language" });
  },

  buildPayload(segment, options = {}) {
    const sourceText = String(segment?.sourceText || "").trim();
    if (!sourceText) {
      throw Object.assign(new Error("Qwen-MT 输入文本不能为空"),
        { code: "empty-source-text" });
    }
    const sourceLanguage = this.languageName(
      options.sourceLanguage || segment?.sourceLanguage || "auto", true);
    const targetLanguage = this.languageName(options.targetLanguage || "zh-CN");
    if (targetLanguage === "auto") {
      throw Object.assign(new Error("Qwen-MT 目标语言不能使用 auto"),
        { code: "invalid-target-language" });
    }
    return {
      model: QWEN_MT_PLUS_MODEL,
      messages: [{ role: "user", content: sourceText }],
      translation_options: {
        source_lang: sourceLanguage,
        target_lang: targetLanguage
      }
    };
  },

  extractText(response) {
    const data = parseAPIResponse(response);
    const content = data?.choices?.[0]?.message?.content
      ?? data?.output?.choices?.[0]?.message?.content
      ?? data?.output?.text;
    if (typeof content !== "string" || !content.trim()) {
      throw Object.assign(new Error("Qwen-MT 返回空译文"),
        { code: "empty-translation" });
    }
    return content.trim();
  },

  async request(apiKey, segments, session, options = {}) {
    if (!Array.isArray(segments) || segments.length !== 1) {
      throw Object.assign(new Error("Qwen-MT 每次请求只能翻译一个分段"),
        { code: "single-segment-only" });
    }
    if (!String(apiKey || "").trim()) {
      throw Object.assign(new Error("未配置 Qwen-MT API Key"),
        { code: "missing-key" });
    }
    const endpoint = `${QWEN_MT_BASE_URL}/chat/completions`;
    const payload = this.buildPayload(segments[0], options);
    const retryDelays = Array.isArray(options?.retryDelays)
      ? options.retryDelays : NETWORK_RETRY_DELAYS;
    const requestedTimeout = Number(options?.timeout);
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout : TRANSLATION_REQUEST_TIMEOUT;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (session?.cancelled) throw new Error("翻译已取消");
      let response;
      try {
        response = await Zotero.HTTP.request("POST", endpoint, {
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
          await translationDelay(retryDelays[attempt]);
          continue;
        }
        throw error;
      }
      const status = Number(response?.status || 0);
      if (status >= 200 && status < 300) return this.extractText(response);
      if (status === 401 || status === 403) {
        throw Object.assign(new Error("API Key 无效"), { status });
      }
      const error = Object.assign(new Error(`Qwen-MT HTTP ${status || "unknown"}`), { status });
      if ((status === 429 || status >= 500) && attempt < retryDelays.length) {
        await translationDelay(retryDelays[attempt]);
        continue;
      }
      throw error;
    }
    throw new Error("Qwen-MT 请求失败");
  },

  async translate(apiKey, segments, session, options = {}) {
    if (!Array.isArray(segments) || segments.length !== 1) {
      throw Object.assign(new Error("Qwen-MT 每次请求只能翻译一个分段"),
        { code: "single-segment-only" });
    }
    const text = await this.request(apiKey, segments, session, options);
    return new Map([[segments[0].id, text]]);
  }
};

var TranslationProviderRegistry = Object.freeze({
  [DEEPSEEK_PROVIDER]: Object.freeze({
    id: DEEPSEEK_PROVIDER,
    label: "DeepSeek",
    modelSpec: TranslationModelRegistry.deepseek,
    credentials: DeepSeekCredentials,
    translationClient: DeepSeekTranslationClient,
    requestOptions() {
      return {};
    }
  }),
  [QWEN_MT_PROVIDER]: Object.freeze({
    id: QWEN_MT_PROVIDER,
    label: "千问",
    modelSpec: TranslationModelRegistry.qwenMTPlus,
    credentials: QwenCredentials,
    translationClient: QwenMTPlusTranslationClient,
    requestOptions: getQwenMTRequestOptions
  })
});

function getTranslationProvider(providerID = getActiveTranslationProviderID()) {
  return TranslationProviderRegistry[providerID]
    || TranslationProviderRegistry[DEEPSEEK_PROVIDER];
}

var TranslationCoordinator = {
  result(segment, status, translatedText = "", error = null,
    modelSpec = TranslationModelRegistry.deepseek) {
    return {
      segmentID: segment.id,
      status,
      translatedText,
      provider: modelSpec.provider,
      model: modelSpec.model,
      promptVersion: SegmentTranslationCache.promptVersion(segment),
      errorCode: error?.code || (error?.status ? `http-${error.status}` : ""),
      errorMessage: error ? String(error.message || error).slice(0, 500) : ""
    };
  },

  async translateSegments({ attachment, segments, sourceLanguage = "en",
    targetLanguage = "zh-CN", session = {}, bypassCache = false,
    modelSpec = null, credentials = null, translationClient = null,
    requestOptions = null }) {
    const provider = getTranslationProvider(modelSpec?.provider);
    modelSpec = modelSpec || provider.modelSpec;
    credentials = credentials || provider.credentials;
    translationClient = translationClient || provider.translationClient;
    requestOptions = requestOptions || provider.requestOptions();
    const results = new Map();
    const eligible = [];
    for (const segment of segments || []) {
      const frontMatter = ["title", "abstract"].includes(segment.kind);
      const selection = ["custom", "unclassified"].includes(segment.kind);
      const eligibleKind = frontMatter || selection;
      const confidenceAllowed = selection
        || ["high", "medium"].includes(segment.confidence);
      if (!eligibleKind || segment.sourceLanguage !== sourceLanguage || !confidenceAllowed) {
        results.set(segment.id, this.result(segment, "skipped", "", null, modelSpec));
        continue;
      }
      const cached = bypassCache ? null
        : await SegmentTranslationCache.get(attachment, segment, targetLanguage, modelSpec);
      if (cached?.translatedText) results.set(segment.id,
        this.result(segment, "cached", cached.translatedText, null, modelSpec));
      else eligible.push(segment);
    }
    if (!eligible.length) return { results, diagnostics: this.diagnostics(results) };
    const apiKey = await credentials.getKey();
    if (!apiKey) {
      const providerLabel = modelSpec.label || modelSpec.provider;
      for (const segment of eligible) results.set(segment.id,
        this.result(segment, "failed", "", Object.assign(new Error(`未配置 ${providerLabel} API Key`),
          { code: "missing-key" }), modelSpec));
      return { results, diagnostics: this.diagnostics(results) };
    }
    for (const segment of eligible) {
      try {
        const translated = await translationClient.translate(
          apiKey, [segment], session, requestOptions);
        const text = translated.get(segment.id);
        await SegmentTranslationCache.put(attachment, segment, targetLanguage, text, modelSpec);
        results.set(segment.id, this.result(segment, "translated", text, null, modelSpec));
      }
      catch (error) {
        results.set(segment.id, this.result(segment, "failed", "", error, modelSpec));
        if (error.status === 401 || error.status === 403) break;
      }
    }
    for (const segment of eligible) {
      if (!results.has(segment.id)) {
        results.set(segment.id, this.result(segment, "failed", "", Object.assign(
          new Error("认证失败，翻译队列已停止"), { code: "auth-stopped" }), modelSpec));
      }
    }
    return { results, diagnostics: this.diagnostics(results) };
  },

  diagnostics(results) {
    const values = [...results.values()];
    return {
      total: values.length,
      cached: values.filter(value => value.status === "cached").length,
      translated: values.filter(value => value.status === "translated").length,
      skipped: values.filter(value => value.status === "skipped").length,
      failed: values.filter(value => value.status === "failed").length
    };
  }
};
