"use strict";

const PROVIDER_CREDENTIALS_ORIGIN = "chrome://paper-assistant-provider-settings";
const PROVIDER_CREDENTIALS_USERNAME = "default";
const DEEPSEEK_REALM = "Paper Assistant DeepSeek API";
const QWEN_MT_REALM = "Paper Assistant Qwen API";
const GEMINI_REALM = "Paper Assistant Gemini API";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PROVIDER = "deepseek";
const QWEN_MT_PROVIDER = "qwen-mt";
const QWEN_MT_PLUS_MODEL = "qwen-mt-plus";
const GEMINI_PROVIDER = "gemini";
const BING_PROVIDER = "bing";
const TRANSMART_PROVIDER = "transmart";
const CNKI_PROVIDER = "cnki";
const GEMINI_MODEL = "gemini-2.5-flash";
const BING_EDGE_MODEL = "bing-edge";
const TRANSMART_WEB_MODEL = "transmart-web";
const CNKI_WEB_MODEL = "cnki-web";
const NO_ACTIVE_TRANSLATION_PROVIDER = "none";
const ACTIVE_TRANSLATION_PROVIDER_PREF =
  "extensions.reader-selection-replacer.activeTranslationProvider";
// Qwen-MT uses the Beijing shared OpenAI-compatible endpoint. Keep this
// internal so users only need to provide the API key in the side pane.
const QWEN_MT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const TRANSLATION_PROMPT_VERSION = "front-matter-translation-v2-title-break";
const SELECTION_TRANSLATION_PROMPT_VERSION = "selection-translation-v4-layout-structure";
const SELECTION_CACHE_ENVELOPE_VERSION = 1;
const TITLE_BREAK_MARKER = "<br>";
const TRANSLATION_CACHE_FILE = "paper-assistant-segment-translations.sqlite";
const TRANSLATION_CACHE_SCHEMA_VERSION = 2;
const TRANSLATION_CACHE_GC_INTERVAL = 24 * 60 * 60 * 1000;
const TRANSLATION_CACHE_UNKNOWN_FINGERPRINT = "unknown";
const API_KEY_PROMPTED_PREF = "extensions.reader-selection-replacer.apiKeyPrompted";
// Keep failures observable during setup and manual troubleshooting. A request
// that cannot reach the selected provider should not occupy the pane for minutes.
const VALIDATION_REQUEST_TIMEOUT = 5000;
const TRANSLATION_REQUEST_TIMEOUT = 10000;
const NETWORK_RETRY_DELAYS = [];
const CONTENT_RETRY_DELAYS = [];
const FREE_WEB_RETRY_DELAYS = [500, 1200];
const FREE_WEB_MAX_CHARS = 2000;
const CNKI_MAX_CHARS = 800;
const CNKI_TOKEN_TTL = 300000;
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const BING_TRANSLATE_BASE_URL = "https://edge.microsoft.com/translate/translatetext";
const TRANSMART_TRANSLATE_URL = "https://transmart.qq.com/api/imt";
const CNKI_TOKEN_URL = "https://dict.cnki.net/fyzs-front-api/getToken";
const CNKI_TRANSLATE_URL =
  "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation";
const CNKI_AES_KEY = "4e87183cfd3a45fe";
const TRANSMART_CLIENT_KEY =
  "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487";
const TRANSMART_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";
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
  }),
  gemini: Object.freeze({
    provider: GEMINI_PROVIDER,
    model: GEMINI_MODEL,
    label: "Gemini"
  }),
  bingEdge: Object.freeze({
    provider: BING_PROVIDER,
    model: BING_EDGE_MODEL,
    label: "Bing"
  }),
  transmartWeb: Object.freeze({
    provider: TRANSMART_PROVIDER,
    model: TRANSMART_WEB_MODEL,
    label: "Tencent Transmart"
  }),
  cnkiWeb: Object.freeze({
    provider: CNKI_PROVIDER,
    model: CNKI_WEB_MODEL,
    label: "CNKI"
  })
});
const NO_PROVIDER_MODEL_SPEC = Object.freeze({
  provider: "",
  model: "",
  label: "未选择模型"
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

function providerError(provider, message, code = "provider-error", status = 0) {
  const error = Object.assign(new Error(`${provider}: ${message}`), { code });
  if (status) error.status = status;
  return error;
}

function isRetryableProviderStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestExternalTranslation(provider, method, endpoint, options = {},
  session = {}, retryDelays = FREE_WEB_RETRY_DELAYS) {
  const delays = Array.isArray(retryDelays) ? retryDelays : [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (session?.cancelled) {
      throw providerError(provider, "翻译已取消", "cancelled");
    }
    let response;
    try {
      response = await Zotero.HTTP.request(method, endpoint, {
        ...options,
        responseType: options.responseType || "json",
        timeout: Number(options.timeout) > 0
          ? Number(options.timeout) : TRANSLATION_REQUEST_TIMEOUT,
        successCodes: false,
        errorDelayMax: 0
      });
    }
    catch (error) {
      if (attempt < delays.length && !error?.status) {
        await translationDelay(delays[attempt]);
        continue;
      }
      if (error && typeof error === "object" && !error.code) error.code = "network-error";
      throw error;
    }
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 300) return response;
    if (isRetryableProviderStatus(status) && attempt < delays.length) {
      await translationDelay(delays[attempt]);
      continue;
    }
    const code = status === 401 || status === 403
      ? "provider-authentication"
      : isRetryableProviderStatus(status) ? "provider-rate-limited" : "provider-http";
    throw providerError(provider, `HTTP ${status || "unknown"}`, code, status);
  }
  throw providerError(provider, "请求失败", "provider-request-failed");
}

function encodeQueryPairs(pairs) {
  return pairs.map(([name, value]) =>
    `${encodeURIComponent(name)}=${encodeURIComponent(String(value ?? ""))}`).join("&");
}

function splitTranslationText(text, maxLength) {
  const raw = String(text || "");
  const limit = Number(maxLength);
  if (!raw.trim()) throw new Error("输入文本不能为空");
  if (!Number.isFinite(limit) || limit < 1 || raw.length <= limit) return [raw];
  const chunks = [];
  let start = 0;
  while (start < raw.length) {
    let end = Math.min(start + limit, raw.length);
    if (end < raw.length) {
      const candidate = raw.slice(start, end);
      const markers = ["。", "！", "？", "；", ". ", "! ", "? ", "; ", "\n"];
      let cut = -1;
      for (const marker of markers) {
        const index = candidate.lastIndexOf(marker);
        if (index >= 0) cut = Math.max(cut, index + marker.length);
      }
      if (cut < Math.floor(limit * 0.5)) {
        const whitespace = candidate.lastIndexOf(" ");
        if (whitespace >= Math.floor(limit * 0.5)) cut = whitespace + 1;
      }
      if (cut > 0) end = start + cut;
    }
    chunks.push(raw.slice(start, end));
    start = end;
  }
  return chunks;
}

function requireSingleSegment(provider, segments) {
  if (!Array.isArray(segments) || segments.length !== 1) {
    throw providerError(provider, "每次请求只能翻译一个分段", "single-segment-only");
  }
  if (!String(segments[0]?.sourceText || "").trim()) {
    throw providerError(provider, "输入文本不能为空", "empty-source-text");
  }
  return segments[0];
}

const WEB_LANGUAGE_MAP = Object.freeze({
  auto: "auto",
  en: "en",
  "en-US": "en",
  "en-GB": "en",
  zh: "zh-CN",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  ja: "ja",
  ko: "ko",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt",
  "pt-BR": "pt",
  ru: "ru",
  ar: "ar",
  th: "th",
  id: "id",
  vi: "vi",
  it: "it",
  tr: "tr"
});

function mapWebLanguage(language, provider, fallback = "auto") {
  const value = String(language || fallback).trim();
  const mapped = WEB_LANGUAGE_MAP[value] || WEB_LANGUAGE_MAP[value.split("-")[0]];
  if (mapped) return mapped;
  if (/^[A-Za-z][A-Za-z-]*$/u.test(value)) return value;
  throw providerError(provider, `不支持的语言标识：${value}`, "unsupported-language");
}

const TRANSMART_LANGUAGE_MAP = Object.freeze({
  auto: "auto",
  en: "en",
  "en-US": "en",
  "en-GB": "en",
  zh: "zh",
  "zh-CN": "zh",
  "zh-TW": "zh-TW",
  de: "de",
  es: "es",
  fr: "fr",
  id: "id",
  it: "it",
  ja: "jp",
  ko: "kr",
  ms: "ms",
  pt: "pt",
  ru: "ru",
  th: "th",
  tr: "tr",
  vi: "vi"
});

function mapTransmartLanguage(language, source = false) {
  const value = String(language || (source ? "auto" : "zh-CN")).trim();
  const mapped = TRANSMART_LANGUAGE_MAP[value]
    || TRANSMART_LANGUAGE_MAP[value.split("-")[0]];
  if (mapped) return mapped;
  throw providerError(TRANSMART_PROVIDER, `不支持的语言标识：${value}`,
    "unsupported-language");
}

const AES_SBOX = Object.freeze([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b,
  0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0,
  0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26,
  0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2,
  0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0,
  0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed,
  0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f,
  0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5,
  0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec,
  0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14,
  0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c,
  0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d,
  0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f,
  0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e,
  0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11,
  0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f,
  0xb0, 0x54, 0xbb, 0x16
]);
const AES_RCON = Object.freeze([0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function utf8Bytes(text) {
  const bytes = [];
  for (const character of String(text || "")) {
    const code = character.codePointAt(0);
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function aes128ExpandKey(key) {
  if (!Array.isArray(key) || key.length !== 16) throw new Error("AES-128 密钥必须为 16 字节");
  const expanded = key.slice();
  for (let cursor = 16, round = 1; cursor < 176; cursor += 4) {
    const temp = expanded.slice(cursor - 4, cursor);
    if (cursor % 16 === 0) {
      const first = temp.shift();
      temp.push(first);
      for (let index = 0; index < 4; index++) temp[index] = AES_SBOX[temp[index]];
      temp[0] ^= AES_RCON[round++];
    }
    for (let index = 0; index < 4; index++) {
      expanded[cursor + index] = expanded[cursor - 16 + index] ^ temp[index];
    }
  }
  return expanded;
}

function aesXtime(value) {
  return ((value << 1) ^ ((value & 0x80) ? 0x1b : 0)) & 0xff;
}

function aes128EncryptBlock(block, expandedKey) {
  const state = block.slice();
  const addRoundKey = round => {
    for (let index = 0; index < 16; index++) state[index] ^= expandedKey[round * 16 + index];
  };
  const subBytes = () => {
    for (let index = 0; index < 16; index++) state[index] = AES_SBOX[state[index]];
  };
  const shiftRows = () => {
    const original = state.slice();
    for (let row = 1; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        state[column * 4 + row] = original[((column + row) % 4) * 4 + row];
      }
    }
  };
  const mixColumns = () => {
    for (let column = 0; column < 4; column++) {
      const offset = column * 4;
      const a0 = state[offset];
      const a1 = state[offset + 1];
      const a2 = state[offset + 2];
      const a3 = state[offset + 3];
      const mix = a0 ^ a1 ^ a2 ^ a3;
      state[offset] = a0 ^ mix ^ aesXtime(a0 ^ a1);
      state[offset + 1] = a1 ^ mix ^ aesXtime(a1 ^ a2);
      state[offset + 2] = a2 ^ mix ^ aesXtime(a2 ^ a3);
      state[offset + 3] = a3 ^ mix ^ aesXtime(a3 ^ a0);
    }
  };
  addRoundKey(0);
  for (let round = 1; round < 10; round++) {
    subBytes();
    shiftRows();
    mixColumns();
    addRoundKey(round);
  }
  subBytes();
  shiftRows();
  addRoundKey(10);
  return state;
}

function aes128EcbEncrypt(text, keyText) {
  const input = utf8Bytes(text);
  const key = utf8Bytes(keyText);
  const padding = 16 - (input.length % 16);
  const padded = input.concat(new Array(padding).fill(padding));
  const expandedKey = aes128ExpandKey(key);
  const encrypted = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    encrypted.push(...aes128EncryptBlock(padded.slice(offset, offset + 16), expandedKey));
  }
  return encrypted;
}

function base64Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(value >> 18) & 0x3f];
    output += alphabet[(value >> 12) & 0x3f];
    output += second === undefined ? "=" : alphabet[(value >> 6) & 0x3f];
    output += third === undefined ? "=" : alphabet[value & 0x3f];
  }
  return output;
}

function cnkiEncodeText(text) {
  return base64Encode(aes128EcbEncrypt(text, CNKI_AES_KEY))
    .replace(/\//g, "_").replace(/\+/g, "-");
}

function stableHash(value) {
  // Zotero's privileged JS runtime does not expose a portable Web Crypto
  // implementation in every supported version. Two independent 32-bit
  // lanes provide a stable 64-bit digest and are materially safer than the
  // old single 32-bit hash for cache identities.
  let first = 2166136261;
  let second = 3432918353;
  let index = 0;
  for (const character of String(value ?? "")) {
    const codePoint = character.codePointAt(0);
    first = Math.imul(first ^ codePoint, 16777619);
    second = Math.imul(second ^ (codePoint + index), 2246822519);
    second = (second << 13) | (second >>> 19);
    index += 1;
  }
  return (first >>> 0).toString(16).padStart(8, "0")
    + (second >>> 0).toString(16).padStart(8, "0");
}

function positionSignature(position) {
  const fragments = position?.fragments?.length ? position.fragments : [position];
  return stableHash(JSON.stringify({
    version: Number(position?.version || 1),
    coordinateSpace: String(position?.coordinateSpace || "pdf"),
    fragments: (fragments || []).map(fragment => ({
      pageIndex: Number(fragment?.pageIndex || 0),
      flowID: fragment?.flowID == null ? null : String(fragment.flowID),
      lineIDs: [...(fragment?.lineIDs || [])].map(String),
      lineCharCounts: [...(fragment?.lineCharCounts || [])].map(Number),
      rects: (fragment?.rects || []).map(rect =>
        rect.map(value => Number(value).toFixed(3)))
    }))
  }));
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
  return units.length ? units : [{ id: "unit-0",
    sourceText: String(segment?.sourceText || "").trim(), breakAfter: "none" }];
}

function composeTranslatedUnits(units) {
  return (units || []).reduce((text, unit, index) => {
    const value = String(unit?.translatedText || "").trim();
    if (!value) return text;
    if (!text) return value;
    const previous = units[index - 1];
    return text + (previous?.breakAfter === "paragraph" ? "\n\n" : "") + value;
  }, "");
}

async function translateSelectionUnits(segment, session, translateUnit) {
  const translatedUnits = [];
  for (const unit of selectionUnits(segment)) {
    if (session?.cancelled) throw new Error("翻译已取消");
    const translatedText = String(await translateUnit(unit) || "").trim();
    if (!translatedText) {
      throw Object.assign(new Error(`翻译单元返回空译文：${unit.id}`),
        { code: "empty-selection-unit" });
    }
    translatedUnits.push({ id: unit.id, translatedText,
      breakAfter: unit.breakAfter });
  }
  return { translatedUnits,
    translatedText: composeTranslatedUnits(translatedUnits) };
}

function normalizeTranslationValue(segment, value) {
  const rawUnits = Array.isArray(value?.translatedUnits) ? value.translatedUnits : [];
  const translatedUnits = rawUnits.map((unit, index) => ({
    id: String(unit?.id || `unit-${index}`),
    translatedText: String(unit?.translatedText ?? unit?.text ?? "").trim(),
    breakAfter: unit?.breakAfter === "paragraph" ? "paragraph" : "none"
  })).filter(unit => unit.id && unit.translatedText);
  let translatedText = typeof value === "string" ? value.trim()
    : String(value?.translatedText || "").trim();
  if (!translatedText && translatedUnits.length) {
    translatedText = composeTranslatedUnits(translatedUnits);
  }
  if (isSelectionSegment(segment) && !translatedUnits.length && translatedText) {
    const expected = selectionUnits(segment);
    if (expected.length === 1) translatedUnits.push({ id: expected[0].id,
      translatedText, breakAfter: "none" });
  }
  return { translatedText, translatedUnits };
}

function encodeCachedTranslation(segment, value) {
  const normalized = normalizeTranslationValue(segment, value);
  if (!isSelectionSegment(segment)) return normalized.translatedText;
  return JSON.stringify({ type: "selection-translation", version: SELECTION_CACHE_ENVELOPE_VERSION,
    translatedText: normalized.translatedText, translatedUnits: normalized.translatedUnits });
}

function decodeCachedTranslation(segment, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!isSelectionSegment(segment)) return { translatedText: raw, translatedUnits: [] };
  try {
    const payload = JSON.parse(raw);
    if (payload?.type !== "selection-translation"
      || Number(payload?.version) !== SELECTION_CACHE_ENVELOPE_VERSION) return null;
    const normalized = normalizeTranslationValue(segment, payload);
    const expected = selectionUnits(segment);
    if (normalized.translatedUnits.length !== expected.length
      || normalized.translatedUnits.some((unit, index) => unit.id !== expected[index].id)) {
      return null;
    }
    return normalized.translatedText ? normalized : null;
  }
  catch (error) {
    Zotero.debug?.(`[reader-selection-replacer] translation cache translation JSON decode failed: ${
      error?.message || error}`);
    return null;
  }
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

var GeminiCredentials = Object.create(DeepSeekCredentials);
GeminiCredentials.provider = GEMINI_PROVIDER;
GeminiCredentials.realm = GEMINI_REALM;

GeminiCredentials.validateKey = async function(apiKey, options = {}) {
  if (!String(apiKey || "").trim()) {
    throw Object.assign(new Error("API Key 不能为空"), { code: "missing-key" });
  }
  await GeminiTranslationClient.request(
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
    NO_ACTIVE_TRANSLATION_PROVIDER
  );
  return TranslationProviderRegistry?.[value] ? value : "";
}

function setActiveTranslationProviderID(provider) {
  const value = TranslationProviderRegistry?.[provider]
    ? provider : NO_ACTIVE_TRANSLATION_PROVIDER;
  try {
    Services.prefs?.setCharPref?.(ACTIVE_TRANSLATION_PROVIDER_PREF, value);
  }
  catch (_) {
    // Preference storage is unavailable in isolated tests and early startup.
  }
  return value === NO_ACTIVE_TRANSLATION_PROVIDER ? "" : value;
}

function getQwenMTRequestOptions() {
  return { baseURL: QWEN_MT_BASE_URL };
}

var SegmentTranslationCache = {
  db: null,
  readyPromise: null,
  maintenanceTimer: null,
  attachmentIdentities: new Map(),
  lastGarbageCollectionAt: 0,

  logCacheError(operation, error) {
    const message = error?.message || String(error || "unknown error");
    Zotero.debug?.(`[reader-selection-replacer] translation cache ${operation} failed: ${message}`);
  },

  async query(sql, params = []) {
    if (!this.db?.queryAsync) return [];
    return await this.db.queryAsync(sql, params) || [];
  },

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      if (!Zotero.DBConnection || !Zotero.DataDirectory?.dir) return;
      this.db = new Zotero.DBConnection(PathUtils.join(Zotero.DataDirectory.dir,
        TRANSLATION_CACHE_FILE));

      await this.query(`CREATE TABLE IF NOT EXISTS translation_cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      const versionRows = await this.query(
        `SELECT value FROM translation_cache_meta WHERE key=?`,
        ["schema_version"]);
      const storedVersion = String(versionRows?.[0]?.value || "");
      if (storedVersion !== String(TRANSLATION_CACHE_SCHEMA_VERSION)) {
        // The old table used provider/model as part of its primary key. The
        // selected migration policy is an intentional clean rebuild and does
        // not touch Zotero's own item database.
        await this.query(`DROP TABLE IF EXISTS segment_translations`);
        await this.query(`DROP TABLE IF EXISTS translation_records`);
        await this.query(`DROP TABLE IF EXISTS attachment_states`);
        await this.query(`DROP TABLE IF EXISTS translation_cache_meta`);
        await this.query(`CREATE TABLE translation_cache_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )`);
      }
      await this.query(`CREATE TABLE IF NOT EXISTS attachment_states (
        library_id INTEGER NOT NULL,
        attachment_key TEXT NOT NULL,
        attachment_item_id INTEGER,
        parent_item_id INTEGER,
        file_fingerprint TEXT NOT NULL,
        is_trashed INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL,
        PRIMARY KEY (library_id, attachment_key)
      )`);
      await this.query(`CREATE TABLE IF NOT EXISTS translation_records (
        record_id TEXT PRIMARY KEY,
        library_id INTEGER NOT NULL,
        attachment_key TEXT NOT NULL,
        attachment_item_id INTEGER,
        parent_item_id INTEGER,
        file_fingerprint TEXT NOT NULL,
        segment_kind TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_units_json TEXT NOT NULL,
        position_json TEXT NOT NULL,
        position_signature TEXT NOT NULL,
        source_language TEXT NOT NULL,
        target_language TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        translated_units_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        UNIQUE (library_id, attachment_key, file_fingerprint, segment_kind,
          position_signature, source_hash, source_language, target_language)
      )`);
      await this.query(`CREATE INDEX IF NOT EXISTS translation_records_attachment_index
        ON translation_records (library_id, attachment_key, file_fingerprint)`);
      await this.query(`CREATE INDEX IF NOT EXISTS translation_records_item_index
        ON translation_records (attachment_item_id, parent_item_id)`);
      await this.query(`INSERT OR REPLACE INTO translation_cache_meta (key, value)
        VALUES (?, ?)`, ["schema_version", String(TRANSLATION_CACHE_SCHEMA_VERSION)]);
    })().catch(error => {
      this.db = null;
      this.logCacheError("initialization", error);
    });
    return this.readyPromise;
  },

  promptVersion(segment) {
    return ["custom", "unclassified"].includes(segment?.kind)
      ? SELECTION_TRANSLATION_PROMPT_VERSION : TRANSLATION_PROMPT_VERSION;
  },

  normalizeID(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  },

  async readAttachmentValue(attachment, names) {
    for (const name of names || []) {
      try {
        let value = attachment?.[name];
        if (typeof value === "function") value = value.call(attachment);
        value = await value;
        if (value !== undefined && value !== null && value !== "") return value;
      }
      catch (_) {}
    }
    return null;
  },

  async getAttachmentFingerprint(attachment) {
    const attachmentHash = await this.readAttachmentValue(attachment,
      ["attachmentHash"]);
    if (String(attachmentHash || "").trim()) {
      return `hash:${String(attachmentHash).trim().toLowerCase()}`;
    }

    let filePath = await this.readAttachmentValue(attachment,
      ["getFilePathAsync", "getFilePath"]);
    filePath = filePath ? String(filePath) : "";
    let stat = null;
    try {
      if (filePath && globalThis.IOUtils?.stat) stat = await globalThis.IOUtils.stat(filePath);
      else if (filePath && globalThis.OS?.File?.stat) stat = await globalThis.OS.File.stat(filePath);
    }
    catch (_) {
      stat = null;
    }

    const modificationTime = stat?.lastModified ?? stat?.mtime
      ?? await this.readAttachmentValue(attachment, [
        "attachmentModificationTime", "fileModificationTime", "modificationTime"
      ]);
    const size = stat?.size ?? await this.readAttachmentValue(attachment, [
      "attachmentSize", "fileSize", "size"
    ]);
    const numericTime = modificationTime instanceof Date
      ? modificationTime.getTime() : Number(modificationTime);
    const numericSize = Number(size);
    if (modificationTime !== null && modificationTime !== undefined
      && size !== null && size !== undefined
      && Number.isFinite(numericTime) && numericTime >= 0
      && Number.isFinite(numericSize) && numericSize >= 0) {
      return `stat:${numericSize}:${numericTime}`;
    }
    return null;
  },

  attachmentKey(attachment) {
    return String(attachment?.key || attachment?.id || "");
  },

  identityKey(identity) {
    return `${identity.libraryID}\u0000${identity.attachmentKey}`;
  },

  async ensureAttachment(attachment, options = {}) {
    const libraryID = Number(attachment?.libraryID || 0);
    const attachmentKey = this.attachmentKey(attachment);
    const memoKey = `${libraryID}\u0000${attachmentKey}`;
    if (!options.refresh && this.attachmentIdentities.has(memoKey)) {
      return this.attachmentIdentities.get(memoKey);
    }

    await this.init();
    const fileFingerprint = await this.getAttachmentFingerprint(attachment);
    const identity = {
      libraryID,
      attachmentKey,
      attachmentItemID: this.normalizeID(attachment?.id),
      parentItemID: this.normalizeID(attachment?.parentID ?? attachment?.parentItemID),
      fileFingerprint: fileFingerprint || TRANSLATION_CACHE_UNKNOWN_FINGERPRINT,
      usable: Boolean(fileFingerprint && libraryID > 0 && attachmentKey && this.db)
    };
    if (!identity.usable) {
      // Unknown file identity is deliberately session-only. Do not let an
      // unavailable fingerprint overwrite a previously valid cache state.
      this.attachmentIdentities.set(memoKey, identity);
      return identity;
    }

    const previousRows = await this.query(`SELECT file_fingerprint, is_trashed,
      first_seen_at FROM attachment_states WHERE library_id=? AND attachment_key=?`,
    [identity.libraryID, identity.attachmentKey]);
    const previous = previousRows?.[0] || null;
    if (previous?.file_fingerprint
      && String(previous.file_fingerprint) !== identity.fileFingerprint) {
      await this.clearAttachmentRecords(identity.libraryID, identity.attachmentKey);
    }
    const now = Date.now();
    await this.query(`INSERT OR REPLACE INTO attachment_states (
      library_id, attachment_key, attachment_item_id, parent_item_id,
      file_fingerprint, is_trashed, first_seen_at, last_seen_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      identity.libraryID,
      identity.attachmentKey,
      identity.attachmentItemID,
      identity.parentItemID,
      identity.fileFingerprint,
      Number(previous?.is_trashed || 0),
      Number(previous?.first_seen_at || now),
      now,
      now
    ]);
    this.attachmentIdentities.set(memoKey, identity);
    return identity;
  },

  serialize(value, fallback = "") {
    try {
      return JSON.stringify(value ?? null);
    }
    catch (_) {
      return fallback;
    }
  },

  parseJSON(value, fallback = null, fieldName = "") {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    }
    catch (error) {
      this.logCacheError(`JSON decode${fieldName ? ` (${fieldName})` : ""}`, error);
      return fallback;
    }
  },

  sourceDetails(segment) {
    const units = isSelectionSegment(segment) ? selectionUnits(segment).map(unit => ({
      id: unit.id, sourceText: unit.sourceText, breakAfter: unit.breakAfter
    })) : [];
    const sourceText = String(segment?.sourceText || "");
    return {
      sourceText,
      sourceUnitsJSON: this.serialize(units, "[]"),
      sourceHash: stableHash(JSON.stringify({ sourceText, units }))
    };
  },

  key(attachment, segment, targetLanguage,
    _modelSpec = null, identity = null) {
    const source = this.sourceDetails(segment);
    const positionJSON = this.serialize(segment?.position, "null");
    const key = {
      libraryID: Number(identity?.libraryID ?? attachment?.libraryID ?? 0),
      attachmentKey: String(identity?.attachmentKey || this.attachmentKey(attachment)),
      attachmentItemID: identity?.attachmentItemID ?? this.normalizeID(attachment?.id),
      parentItemID: identity?.parentItemID
        ?? this.normalizeID(attachment?.parentID ?? attachment?.parentItemID),
      fileFingerprint: String(identity?.fileFingerprint || TRANSLATION_CACHE_UNKNOWN_FINGERPRINT),
      segmentKind: String(segment?.kind || ""),
      segmentID: String(segment?.id || segment?.kind || ""),
      sourceText: source.sourceText,
      sourceUnitsJSON: source.sourceUnitsJSON,
      positionJSON,
      positionSignature: positionSignature(segment?.position),
      sourceHash: source.sourceHash,
      sourceLanguage: String(segment?.sourceLanguage || ""),
      targetLanguage: String(targetLanguage || ""),
      promptVersion: this.promptVersion(segment)
    };
    key.recordID = `translation-${stableHash(this.serialize({
      libraryID: key.libraryID,
      attachmentKey: key.attachmentKey,
      fileFingerprint: key.fileFingerprint,
      segmentKind: key.segmentKind,
      positionSignature: key.positionSignature,
      sourceHash: key.sourceHash,
      sourceLanguage: key.sourceLanguage,
      targetLanguage: key.targetLanguage
    }))}`;
    return key;
  },

  readRowValue(row, names, fallback = null) {
    for (const name of names || []) {
      try {
        const value = row?.[name];
        if (value !== undefined && value !== null) return value;
      }
      catch (_) {
        // Zotero database rows are column proxies. A missing or inaccessible
        // column must not make the whole cache unreadable.
      }
    }
    return fallback;
  },

  normalizeRow(row) {
    if (!row) return null;
    try {
      // Do not enumerate or spread Zotero's database row proxy. In Zotero,
      // enumeration can probe QueryInterface as if it were a DB column.
      const value = (names, fallback = null) => this.readRowValue(row, names, fallback);
      const sourceUnitsJSON = String(value(["source_units_json"], "") ?? "");
      const positionJSON = String(value(["position_json"], "") ?? "");
      const translatedUnitsJSON = String(
        value(["translated_units_json"], "") ?? ""
      );
      return {
        recordID: String(value(["record_id"], "") || ""),
        libraryID: Number(value(["library_id"], 0) || 0),
        attachmentKey: String(value(["attachment_key"], "") || ""),
        attachmentItemID: this.normalizeID(
          value(["attachment_item_id"], null)
        ),
        parentItemID: this.normalizeID(
          value(["parent_item_id"], null)
        ),
        fileFingerprint: String(
          value(["file_fingerprint"], "") || ""
        ),
        segmentKind: String(value(["segment_kind"], "") || ""),
        segmentID: String(value(["segment_id"], "") || ""),
        sourceText: String(value(["source_text"], "") || ""),
        sourceHash: String(value(["source_hash"], "") || ""),
        sourceUnitsJSON,
        source_units_json: sourceUnitsJSON,
        sourceUnits: this.parseJSON(sourceUnitsJSON, [], "source_units_json"),
        positionJSON,
        position_json: positionJSON,
        position: this.parseJSON(positionJSON, null, "position_json"),
        positionSignature: String(
          value(["position_signature"], "") || ""
        ),
        sourceLanguage: String(value(["source_language"], "") || ""),
        targetLanguage: String(value(["target_language"], "") || ""),
        promptVersion: String(value(["prompt_version"], "") || ""),
        translatedText: String(value(["translated_text"], "") || ""),
        translatedUnitsJSON,
        translated_units_json: translatedUnitsJSON,
        translatedUnits: this.parseJSON(
          translatedUnitsJSON, [], "translated_units_json"
        ),
        provider: String(value(["provider"], "") || ""),
        model: String(value(["model"], "") || ""),
        createdAt: Number(value(["created_at"], 0) || 0),
        updatedAt: Number(value(["updated_at"], 0) || 0),
        lastUsedAt: Number(value(["last_used_at"], 0) || 0)
      };
    }
    catch (error) {
      this.logCacheError("row normalization", error);
      return null;
    }
  },

  async get(attachment, segment, targetLanguage,
    modelSpec = null, options = {}) {
    try {
      await this.init();
      const identity = options.identity || await this.ensureAttachment(attachment);
      if (!this.db || !identity?.usable) return null;
      const key = this.key(attachment, segment, targetLanguage, modelSpec, identity);
      const rows = await this.query(`SELECT * FROM translation_records WHERE record_id=?`,
        [key.recordID]);
      const row = this.normalizeRow(rows?.[0]);
      if (!row || row.fileFingerprint !== key.fileFingerprint
        || row.sourceHash !== key.sourceHash
        || row.positionSignature !== key.positionSignature
        || row.sourceText !== key.sourceText
        || row.position_json !== key.positionJSON
        || row.source_units_json !== key.sourceUnitsJSON
        || row.sourceLanguage !== key.sourceLanguage
        || row.targetLanguage !== key.targetLanguage
        || row.promptVersion !== key.promptVersion) return null;
      const now = Date.now();
      await this.query(`UPDATE translation_records SET last_used_at=? WHERE record_id=?`,
        [now, key.recordID]);
      return row;
    }
    catch (error) {
      this.logCacheError("read", error);
      return null;
    }
  },

  async listForAttachment(attachment, targetLanguage = "zh-CN", options = {}) {
    try {
      await this.init();
      const identity = options.identity || await this.ensureAttachment(attachment);
      if (!this.db || !identity?.usable) return [];
      const rows = await this.query(`SELECT * FROM translation_records
        WHERE library_id=? AND attachment_key=? AND file_fingerprint=?
          AND target_language=? AND segment_kind IN (?, ?)
        ORDER BY created_at ASC, record_id ASC`, [
        identity.libraryID, identity.attachmentKey, identity.fileFingerprint,
        targetLanguage, "custom", "unclassified"
      ]);
      return (rows || []).map(row => {
        try {
          return this.normalizeRow(row);
        }
        catch (error) {
          this.logCacheError("row normalization", error);
          return null;
        }
      }).filter(row => row
        && row.promptVersion === this.promptVersion({ kind: row.segmentKind })
        && row.sourceText && row.position && row.translatedText);
    }
    catch (error) {
      this.logCacheError("list", error);
      return [];
    }
  },

  async remove(attachment, segment, targetLanguage,
    modelSpec = null, options = {}) {
    await this.init();
    if (!this.db) throw new Error("翻译缓存数据库不可用");
    const identity = options.identity || await this.ensureAttachment(attachment);
    if (!identity?.usable) return false;
    const key = this.key(attachment, segment, targetLanguage, modelSpec, identity);
    await this.query(`DELETE FROM translation_records WHERE record_id=?`, [key.recordID]);
    return true;
  },

  async put(attachment, segment, targetLanguage, translatedText,
    modelSpec = null, options = {}) {
    try {
      await this.init();
      if (!this.db || !String(translatedText || "").trim()) return null;
      const identity = options.identity || await this.ensureAttachment(attachment);
      if (!identity?.usable) return null;
      const key = this.key(attachment, segment, targetLanguage, modelSpec, identity);
      const encodedText = String(translatedText).trim();
      const decoded = decodeCachedTranslation(segment, encodedText);
      if (!decoded?.translatedText) return null;
      const now = Date.now();
      const existing = await this.query(
        `SELECT created_at FROM translation_records WHERE record_id=?`, [key.recordID]);
      if (["title", "abstract"].includes(key.segmentKind)) {
        await this.query(`DELETE FROM translation_records WHERE library_id=?
          AND attachment_key=? AND file_fingerprint=? AND segment_kind=?
          AND source_language=? AND target_language=? AND record_id<>?`, [
          key.libraryID, key.attachmentKey, key.fileFingerprint, key.segmentKind,
          key.sourceLanguage, key.targetLanguage, key.recordID
        ]);
      }
      await this.query(`INSERT OR REPLACE INTO translation_records (
        record_id, library_id, attachment_key, attachment_item_id, parent_item_id,
        file_fingerprint, segment_kind, segment_id, source_text, source_hash,
        source_units_json, position_json, position_signature, source_language,
        target_language, prompt_version, translated_text, translated_units_json,
        provider, model, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        key.recordID,
        key.libraryID,
        key.attachmentKey,
        key.attachmentItemID,
        key.parentItemID,
        key.fileFingerprint,
        key.segmentKind,
        key.segmentID,
        key.sourceText,
        key.sourceHash,
        key.sourceUnitsJSON,
        key.positionJSON,
        key.positionSignature,
        key.sourceLanguage,
        key.targetLanguage,
        key.promptVersion,
        encodedText,
        this.serialize(decoded.translatedUnits || [], "[]"),
        String(modelSpec?.provider || ""),
        String(modelSpec?.model || ""),
        Number(existing?.[0]?.created_at || now),
        now,
        now
      ]);
      return { recordID: key.recordID, provider: String(modelSpec?.provider || ""),
        model: String(modelSpec?.model || "") };
    }
    catch (error) {
      this.logCacheError("write", error);
      return null;
    }
  },

  async clearAttachmentRecords(libraryID, attachmentKey) {
    if (!this.db) return;
    await this.query(`DELETE FROM translation_records
      WHERE library_id=? AND attachment_key=?`, [libraryID, attachmentKey]);
  },

  async purgeByIDs(ids) {
    const values = [...new Set((ids || []).map(value => this.normalizeID(value)).filter(Boolean))];
    if (!this.db || !values.length) return 0;
    for (const [memoKey, identity] of this.attachmentIdentities) {
      if (values.includes(identity?.attachmentItemID)
        || values.includes(identity?.parentItemID)) this.attachmentIdentities.delete(memoKey);
    }
    const placeholders = values.map(() => "?").join(", ");
    await this.query(`DELETE FROM translation_records WHERE attachment_item_id IN (${placeholders})
      OR parent_item_id IN (${placeholders})`, [...values, ...values]);
    await this.query(`DELETE FROM attachment_states WHERE attachment_item_id IN (${placeholders})
      OR parent_item_id IN (${placeholders})`, [...values, ...values]);
    return values.length;
  },

  async setTrashedByIDs(ids, trashed) {
    const values = [...new Set((ids || []).map(value => this.normalizeID(value)).filter(Boolean))];
    if (!this.db || !values.length) return 0;
    const placeholders = values.map(() => "?").join(", ");
    await this.query(`UPDATE attachment_states SET is_trashed=?, last_seen_at=?
      WHERE attachment_item_id IN (${placeholders}) OR parent_item_id IN (${placeholders})`,
    [trashed ? 1 : 0, Date.now(), ...values, ...values]);
    return values.length;
  },

  async handleNotifier(event, type, ids, extraData = null) {
    await this.init();
    if (!this.db) return;
    const values = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
    const normalizedEvent = String(event || "").toLowerCase();
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedEvent === "delete") {
      await this.purgeByIDs(values);
      return;
    }
    if (normalizedEvent === "trash"
      || (normalizedType === "trash" && ["add", "modify"].includes(normalizedEvent))) {
      await this.setTrashedByIDs(values, true);
      return;
    }
    if (normalizedEvent === "untrash"
      || (normalizedType === "trash" && normalizedEvent === "remove")) {
      await this.setTrashedByIDs(values, false);
      return;
    }
    if (normalizedEvent === "modify" && extraData && typeof extraData === "object") {
      const deleted = Object.values(extraData).some(value => {
        const candidate = value?.deleted ?? value?.fields?.deleted;
        return candidate?.newValue === true || candidate === true;
      });
      const restored = Object.values(extraData).some(value => {
        const candidate = value?.deleted ?? value?.fields?.deleted;
        return candidate?.newValue === false || candidate === false;
      });
      if (deleted) await this.setTrashedByIDs(values, true);
      else if (restored) await this.setTrashedByIDs(values, false);
    }
    // Collection membership, sorting, moves, and parent changes do not alter
    // the attachment identity. The next Reader open still refreshes the file
    // fingerprint, which is the only supported invalidation signal here.
  },

  async runGarbageCollection(options = {}) {
    await this.init();
    if (!this.db) return 0;
    const canResolveItems = typeof Zotero.Items?.getAsync === "function"
      || typeof Zotero.Items?.get === "function";
    if (!canResolveItems) return 0;
    const rows = await this.query(`SELECT library_id, attachment_key,
      attachment_item_id, parent_item_id FROM attachment_states`);
    let removed = 0;
    for (const row of rows) {
      const itemID = this.normalizeID(row.attachment_item_id);
      if (!itemID) continue;
      let item = null;
      let lookupFailed = false;
      try {
        item = Zotero.Items.getAsync
          ? await Zotero.Items.getAsync(itemID) : Zotero.Items.get(itemID);
      }
      catch (_) {
        lookupFailed = true;
      }
      if (lookupFailed) continue;
      if (!item) {
        await this.clearAttachmentRecords(Number(row.library_id || 0),
          String(row.attachment_key || ""));
        await this.query(`DELETE FROM attachment_states WHERE library_id=? AND attachment_key=?`,
          [Number(row.library_id || 0), String(row.attachment_key || "")]);
        this.attachmentIdentities.delete(`${Number(row.library_id || 0)}\u0000${
          String(row.attachment_key || "")}`);
        removed += 1;
      }
      else {
        await this.query(`UPDATE attachment_states SET last_checked_at=?, last_seen_at=?
          WHERE library_id=? AND attachment_key=?`, [Date.now(), Date.now(),
          Number(row.library_id || 0), String(row.attachment_key || "")]);
      }
    }
    await this.query(`DELETE FROM translation_records WHERE NOT EXISTS (
      SELECT 1 FROM attachment_states states
      WHERE states.library_id=translation_records.library_id
        AND states.attachment_key=translation_records.attachment_key
    )`);
    this.lastGarbageCollectionAt = Date.now();
    await this.query(`INSERT OR REPLACE INTO translation_cache_meta (key, value)
      VALUES (?, ?)`, ["last_gc_at", String(this.lastGarbageCollectionAt)]);
    return removed;
  },

  async maybeGarbageCollect(options = {}) {
    await this.init();
    if (!this.db) return 0;
    if (!options.force && Date.now() - this.lastGarbageCollectionAt
      < TRANSLATION_CACHE_GC_INTERVAL) return 0;
    return await this.runGarbageCollection(options);
  },

  startMaintenance() {
    if (this.maintenanceTimer !== null) return;
    this.maybeGarbageCollect({ force: true }).catch(error => Zotero.logError?.(error));
    this.maintenanceTimer = setInterval(() => {
      this.maybeGarbageCollect().catch(error => Zotero.logError?.(error));
    }, TRANSLATION_CACHE_GC_INTERVAL);
  },

  stopMaintenance() {
    if (this.maintenanceTimer !== null) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  },

  async close() {
    this.stopMaintenance();
    if (this.db) await this.db.closeDatabase?.();
    this.db = null;
    this.readyPromise = null;
    this.attachmentIdentities.clear();
    this.lastGarbageCollectionAt = 0;
  }
};

var DeepSeekTranslationClient = {
  prompt(repair = false, segments = []) {
    const selection = (segments || []).some(segment =>
      ["custom", "unclassified"].includes(segment?.kind));
    if (selection) {
      return [
        "将用户从英文学术 PDF 中划选的正文段落或文本忠实翻译为简体中文。",
        "只返回 JSON：{\"translations\":[{\"id\":\"segment-id\",\"units\":[{\"id\":\"unit-0\",\"zh\":\"中文\"}]}]}。",
        "每个 segment id 和 unit id 必须按输入顺序恰好返回一次；不得合并、拆分或遗漏单元。",
        "不得解释、总结、增删事实或使用 Markdown。",
        "保持术语、数字、单位、缩写、变量、引用和原文语气准确。",
        "每个单元译文必须是纯文本，禁止 <br>、任何 HTML 标签、Markdown 和额外空行。",
        repair ? "上次输出未通过校验，请完整重译并严格遵循 JSON、纯文本和逐单元对应规则。" : ""
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
      if (!expected.has(id) || result.has(id)) {
        throw Object.assign(new Error(`无效译文目标：${id || "unknown"}`), { code: "invalid-row" });
      }
      const segment = segments.find(value => value.id === id);
      if (isSelectionSegment(segment)) {
        const expectedUnits = selectionUnits(segment);
        const rows = Array.isArray(row?.units) ? row.units : [];
        if (rows.length !== expectedUnits.length) {
          throw Object.assign(new Error(`译文单元数量不匹配：${id}`),
            { code: "selection-unit-count" });
        }
        const translatedUnits = [];
        for (let index = 0; index < expectedUnits.length; index++) {
          const expectedUnit = expectedUnits[index];
          const unitRow = rows[index];
          const unitID = String(unitRow?.id || "");
          const zh = String(unitRow?.zh || "").trim();
          if (unitID !== expectedUnit.id || !zh || !/[\u3400-\u9fff]/u.test(zh)) {
            throw Object.assign(new Error(`无效译文单元：${unitID || "unknown"}`),
              { code: "invalid-selection-unit" });
          }
          if (/<\s*br\s*\/?>/iu.test(zh) || /<[^>]+>/u.test(zh) || /\n\s*\n/u.test(zh)) {
            throw Object.assign(new Error("自定义段落译文包含不允许的换行或 HTML 标记"),
              { code: "invalid-selection-html" });
          }
          translatedUnits.push({ id: expectedUnit.id,
            translatedText: zh.replace(/\s*\n\s*/gu, " ").trim(),
            breakAfter: expectedUnit.breakAfter });
        }
        result.set(id, { translatedUnits,
          translatedText: composeTranslatedUnits(translatedUnits) });
        continue;
      }
      let zh = String(row?.zh || "").trim();
      if (!zh || !/[\u3400-\u9fff]/u.test(zh)) {
        throw Object.assign(new Error(`无效译文目标：${id || "unknown"}`), { code: "invalid-row" });
      }
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
          segments: segments.map(segment => isSelectionSegment(segment)
            ? { id: segment.id, kind: segment.kind,
              units: selectionUnits(segment).map(unit => ({ id: unit.id,
                text: unit.sourceText })) }
            : { id: segment.id, kind: segment.kind, text: segment.sourceText })
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
    const segment = segments[0];
    if (!isSelectionSegment(segment)) {
      const text = await this.request(apiKey, segments, session, options);
      return new Map([[segment.id, text]]);
    }
    const translatedUnits = [];
    for (const unit of selectionUnits(segment)) {
      if (session?.cancelled) throw new Error("翻译已取消");
      const text = await this.request(apiKey, [{ ...segment,
        id: `${segment.id}:${unit.id}`, sourceText: unit.sourceText }], session, options);
      translatedUnits.push({ id: unit.id, translatedText: text,
        breakAfter: unit.breakAfter });
    }
    return new Map([[segment.id, { translatedUnits,
      translatedText: composeTranslatedUnits(translatedUnits) }]]);
  }
};

const GEMINI_TRANSLATION_INSTRUCTION =
  "Translate the source text faithfully into Simplified Chinese. "
  + "Preserve technical terms, numbers, units, abbreviations, variables, citations, "
  + "and paragraph breaks. Return only the translation without explanations or Markdown.";

var GeminiTranslationClient = {
  provider: GEMINI_PROVIDER,
  model: GEMINI_MODEL,

  buildEndpoint() {
    return `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  },

  buildPayload(segment, options = {}) {
    const sourceText = String(segment?.sourceText || "").trim();
    if (!sourceText) {
      throw providerError(GEMINI_PROVIDER, "输入文本不能为空", "empty-source-text");
    }
    const targetLanguage = String(options.targetLanguage || "zh-CN").trim();
    return {
      contents: [{
        role: "user",
        parts: [{
          text: `${GEMINI_TRANSLATION_INSTRUCTION}\nTarget language: ${targetLanguage}\n\nSource text:\n${sourceText}`
        }]
      }]
    };
  },

  extractText(response) {
    const data = parseAPIResponse(response);
    const candidates = data?.candidates;
    const parts = Array.isArray(candidates?.[0]?.content?.parts)
      ? candidates[0].content.parts : [];
    const text = parts
      .filter(part => part && part.thought !== true && typeof part.text === "string")
      .map(part => part.text)
      .join("")
      .trim();
    if (text) return text;
    if (data?.promptFeedback?.blockReason) {
      throw providerError(GEMINI_PROVIDER,
        `请求被阻止：${data.promptFeedback.blockReason}`, "content-blocked");
    }
    throw providerError(GEMINI_PROVIDER, "返回空译文或响应结构无效", "invalid-response");
  },

  async request(apiKey, segments, session, options = {}) {
    const segment = requireSingleSegment(GEMINI_PROVIDER, segments);
    if (!String(apiKey || "").trim()) {
      throw providerError(GEMINI_PROVIDER, "未配置 Gemini API Key", "missing-key");
    }
    const response = await requestExternalTranslation(
      GEMINI_PROVIDER,
      "POST",
      this.buildEndpoint(),
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey.trim()
        },
        body: JSON.stringify(this.buildPayload(segment, options)),
        timeout: options.timeout
      },
      session,
      options.retryDelays || NETWORK_RETRY_DELAYS
    );
    return this.extractText(response);
  },

  async translate(apiKey, segments, session, options = {}) {
    const segment = requireSingleSegment(GEMINI_PROVIDER, segments);
    if (!isSelectionSegment(segment)) {
      const text = await this.request(apiKey, [segment], session, options);
      return new Map([[segment.id, text]]);
    }
    const value = await translateSelectionUnits(segment, session, unit =>
      this.request(apiKey, [{ ...segment, id: `${segment.id}:${unit.id}`,
        sourceText: unit.sourceText }], session, options));
    return new Map([[segment.id, value]]);
  }
};

var BingTranslationClient = {
  provider: BING_PROVIDER,
  model: BING_EDGE_MODEL,

  buildEndpoint(segment, options = {}) {
    const source = mapWebLanguage(segment?.sourceLanguage, BING_PROVIDER);
    const target = mapWebLanguage(options.targetLanguage || "zh-CN", BING_PROVIDER,
      "zh-CN");
    return `${BING_TRANSLATE_BASE_URL}?${encodeQueryPairs([
      ["from", source], ["to", target], ["isEnterpriseClient", "false"]
    ])}`;
  },

  extractText(response) {
    const data = parseAPIResponse(response);
    const text = data?.[0]?.translations?.[0]?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw providerError(BING_PROVIDER, "返回空译文或响应结构无效", "invalid-response");
    }
    return text.trim();
  },

  async translateText(segment, session, options = {}) {
    const chunks = splitTranslationText(segment.sourceText,
      options.maxChars || FREE_WEB_MAX_CHARS);
    const translated = [];
    for (const chunk of chunks) {
      const response = await requestExternalTranslation(
        BING_PROVIDER, "POST", this.buildEndpoint(segment, options), {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": TRANSMART_USER_AGENT
          },
          body: JSON.stringify([chunk.trim()])
        }, session, options.retryDelays || FREE_WEB_RETRY_DELAYS);
      translated.push(this.extractText(response));
    }
    return translated.join("");
  },

  async translate(_apiKey, segments, session, options = {}) {
    const segment = requireSingleSegment(BING_PROVIDER, segments);
    if (!isSelectionSegment(segment)) {
      return new Map([[segment.id, await this.translateText(segment, session, options)]]);
    }
    const value = await translateSelectionUnits(segment, session, unit =>
      this.translateText({ ...segment, id: `${segment.id}:${unit.id}`,
        sourceText: unit.sourceText }, session, options));
    return new Map([[segment.id, value]]);
  }
};

var TransmartTranslationClient = {
  provider: TRANSMART_PROVIDER,
  model: TRANSMART_WEB_MODEL,

  buildPayload(segment) {
    return {
      header: {
        fn: "auto_translation",
        client_key: TRANSMART_CLIENT_KEY
      },
      type: "plain",
      model_category: "normal",
      source: {
        lang: mapTransmartLanguage(segment?.sourceLanguage, true),
        text_list: [String(segment?.sourceText || "").trim()]
      },
      target: {
        lang: mapTransmartLanguage("zh-CN")
      }
    };
  },

  extractText(response) {
    const data = parseAPIResponse(response);
    const values = data?.auto_translation;
    if (!Array.isArray(values) || !values.length) {
      throw providerError(TRANSMART_PROVIDER, "返回空译文或响应结构无效", "invalid-response");
    }
    const text = values.map(value => String(value || "").trim()).filter(Boolean).join("\n");
    if (!text) throw providerError(TRANSMART_PROVIDER, "返回空译文", "empty-translation");
    return text;
  },

  async translateText(segment, session, options = {}) {
    const chunks = splitTranslationText(segment.sourceText,
      options.maxChars || FREE_WEB_MAX_CHARS);
    const translated = [];
    for (const chunk of chunks) {
      const chunkSegment = { ...segment, sourceText: chunk.trim() };
      const response = await requestExternalTranslation(
        TRANSMART_PROVIDER, "POST", TRANSMART_TRANSLATE_URL, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": TRANSMART_USER_AGENT,
            Referer: "https://transmart.qq.com/zh-CN/index"
          },
          body: JSON.stringify(this.buildPayload(chunkSegment))
        }, session, options.retryDelays || FREE_WEB_RETRY_DELAYS);
      translated.push(this.extractText(response));
    }
    return translated.join("");
  },

  async translate(_apiKey, segments, session, options = {}) {
    const segment = requireSingleSegment(TRANSMART_PROVIDER, segments);
    if (!isSelectionSegment(segment)) {
      return new Map([[segment.id, await this.translateText(segment, session, options)]]);
    }
    const value = await translateSelectionUnits(segment, session, unit =>
      this.translateText({ ...segment, id: `${segment.id}:${unit.id}`,
        sourceText: unit.sourceText }, session, options));
    return new Map([[segment.id, value]]);
  }
};

var CNKITokenState = {
  token: "",
  expiresAt: 0,
  promise: null
};

async function getCNKIToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && CNKITokenState.token && CNKITokenState.expiresAt > now) {
    return CNKITokenState.token;
  }
  if (!forceRefresh && CNKITokenState.promise) return CNKITokenState.promise;
  const promise = (async () => {
    const response = await requestExternalTranslation(CNKI_PROVIDER, "GET", CNKI_TOKEN_URL, {
      headers: { Accept: "application/json" }
    }, { cancelled: false }, FREE_WEB_RETRY_DELAYS);
    const data = parseAPIResponse(response);
    const token = String(data?.data || data?.token || "").trim();
    if (!token) throw providerError(CNKI_PROVIDER, "Token 响应无效", "invalid-token-response");
    CNKITokenState.token = token;
    CNKITokenState.expiresAt = Date.now() + CNKI_TOKEN_TTL;
    return token;
  })();
  CNKITokenState.promise = promise;
  try {
    return await promise;
  }
  finally {
    if (CNKITokenState.promise === promise) CNKITokenState.promise = null;
  }
}

var CNKITranslationClient = {
  provider: CNKI_PROVIDER,
  model: CNKI_WEB_MODEL,

  extractText(response) {
    const data = parseAPIResponse(response)?.data;
    if (data?.isInputVerificationCode) {
      throw providerError(CNKI_PROVIDER, "需要人工验证码", "verification-required");
    }
    const text = data?.mResult;
    if (typeof text !== "string" || !text.trim()) {
      throw providerError(CNKI_PROVIDER, "返回空译文或响应结构无效", "invalid-response");
    }
    return text.trim();
  },

  async requestChunk(text, token, session, options = {}) {
    return requestExternalTranslation(CNKI_PROVIDER, "POST", CNKI_TRANSLATE_URL, {
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Token: token
      },
      body: JSON.stringify({ words: cnkiEncodeText(text), translateType: null })
    }, session, options.retryDelays || FREE_WEB_RETRY_DELAYS);
  },

  async translateText(segment, session, options = {}) {
    const chunks = splitTranslationText(segment.sourceText,
      options.maxChars || CNKI_MAX_CHARS);
    const translated = [];
    for (const chunk of chunks) {
      let token = await getCNKIToken(false);
      let response;
      try {
        response = await this.requestChunk(chunk.trim(), token, session, options);
      }
      catch (error) {
        if (error?.status !== 401 && error?.status !== 403) throw error;
        token = await getCNKIToken(true);
        response = await this.requestChunk(chunk.trim(), token, session, options);
      }
      translated.push(this.extractText(response));
    }
    return translated.join("");
  },

  async translate(_apiKey, segments, session, options = {}) {
    const segment = requireSingleSegment(CNKI_PROVIDER, segments);
    if (!isSelectionSegment(segment)) {
      return new Map([[segment.id, await this.translateText(segment, session, options)]]);
    }
    const value = await translateSelectionUnits(segment, session, unit =>
      this.translateText({ ...segment, id: `${segment.id}:${unit.id}`,
        sourceText: unit.sourceText }, session, options));
    return new Map([[segment.id, value]]);
  }
};

var NoCredentials = Object.freeze({
  async getKey() {
    return "";
  }
});

var TranslationProviderRegistry = Object.freeze({
  [DEEPSEEK_PROVIDER]: Object.freeze({
    id: DEEPSEEK_PROVIDER,
    label: "DeepSeek",
    credentialMode: "api-key",
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
    credentialMode: "api-key",
    modelSpec: TranslationModelRegistry.qwenMTPlus,
    credentials: QwenCredentials,
    translationClient: QwenMTPlusTranslationClient,
    requestOptions: getQwenMTRequestOptions
  }),
  [GEMINI_PROVIDER]: Object.freeze({
    id: GEMINI_PROVIDER,
    label: "Gemini",
    credentialMode: "api-key",
    modelSpec: TranslationModelRegistry.gemini,
    credentials: GeminiCredentials,
    translationClient: GeminiTranslationClient,
    requestOptions() {
      return { retryDelays: NETWORK_RETRY_DELAYS };
    }
  }),
  [BING_PROVIDER]: Object.freeze({
    id: BING_PROVIDER,
    label: "Bing",
    credentialMode: "none",
    modelSpec: TranslationModelRegistry.bingEdge,
    credentials: NoCredentials,
    translationClient: BingTranslationClient,
    requestOptions() {
      return { maxChars: FREE_WEB_MAX_CHARS, retryDelays: FREE_WEB_RETRY_DELAYS };
    }
  }),
  [TRANSMART_PROVIDER]: Object.freeze({
    id: TRANSMART_PROVIDER,
    label: "Tencent Transmart",
    credentialMode: "none",
    modelSpec: TranslationModelRegistry.transmartWeb,
    credentials: NoCredentials,
    translationClient: TransmartTranslationClient,
    requestOptions() {
      return { maxChars: FREE_WEB_MAX_CHARS, retryDelays: FREE_WEB_RETRY_DELAYS };
    }
  }),
  [CNKI_PROVIDER]: Object.freeze({
    id: CNKI_PROVIDER,
    label: "CNKI",
    credentialMode: "none",
    modelSpec: TranslationModelRegistry.cnkiWeb,
    credentials: NoCredentials,
    translationClient: CNKITranslationClient,
    requestOptions() {
      return { maxChars: CNKI_MAX_CHARS, retryDelays: FREE_WEB_RETRY_DELAYS };
    }
  })
});

function getTranslationProvider(providerID = getActiveTranslationProviderID()) {
  if (!providerID) return null;
  return TranslationProviderRegistry[providerID] || null;
}

var TranslationCoordinator = {
  result(segment, status, translatedText = "", error = null,
    modelSpec = TranslationModelRegistry.deepseek, translatedUnits = [], recordID = "") {
    return {
      segmentID: segment.id,
      status,
      translatedText,
      translatedUnits,
      recordID: String(recordID || ""),
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
    requestOptions = null, attachmentIdentity = null }) {
    const provider = getTranslationProvider(modelSpec?.provider
      || getActiveTranslationProviderID());
    modelSpec = modelSpec || provider?.modelSpec || NO_PROVIDER_MODEL_SPEC;
    const results = new Map();
    const candidates = [];
    for (const segment of segments || []) {
      candidates.push(segment);
    }
    if (!candidates.length) return { results, diagnostics: this.diagnostics(results) };
    let identity = attachmentIdentity || null;
    if (!identity) {
      try {
        identity = await SegmentTranslationCache.ensureAttachment(
          attachment, { refresh: true });
      }
      catch (error) {
        SegmentTranslationCache.logCacheError("identity lookup", error);
        identity = null;
      }
    }
    const eligible = [];
    for (const segment of candidates) {
      const frontMatter = ["title", "abstract"].includes(segment.kind);
      const selection = ["custom", "unclassified"].includes(segment.kind);
      const eligibleKind = frontMatter || selection;
      const confidenceAllowed = selection
        || ["high", "medium"].includes(segment.confidence);
      if (!eligibleKind || segment.sourceLanguage !== sourceLanguage || !confidenceAllowed) {
        results.set(segment.id, this.result(segment, "skipped", "", null, modelSpec));
        continue;
      }
      let cached = null;
      if (!bypassCache && identity?.usable) {
        try {
          cached = await SegmentTranslationCache.get(
            attachment, segment, targetLanguage, modelSpec, { identity }
          );
        }
        catch (error) {
          SegmentTranslationCache.logCacheError("read", error);
        }
      }
      const decoded = cached?.translatedText
        ? decodeCachedTranslation(segment, cached.translatedText) : null;
      if (decoded?.translatedText) {
        const cachedModelSpec = {
          provider: cached.provider || modelSpec.provider,
          model: cached.model || modelSpec.model
        };
        results.set(segment.id, this.result(segment, "cached", decoded.translatedText,
          null, cachedModelSpec, decoded.translatedUnits, cached.recordID));
      }
      else eligible.push(segment);
    }
    if (!eligible.length) return { results, diagnostics: this.diagnostics(results) };
    if (!provider) {
      const error = Object.assign(new Error("未选择翻译模型"), { code: "no-provider" });
      for (const segment of eligible) results.set(segment.id,
        this.result(segment, "skipped", "", error, NO_PROVIDER_MODEL_SPEC));
      return { results, diagnostics: this.diagnostics(results) };
    }
    credentials = credentials || provider.credentials;
    translationClient = translationClient || provider.translationClient;
    requestOptions = requestOptions || provider.requestOptions();
    const apiKey = credentials?.getKey ? await credentials.getKey() : "";
    if (provider.credentialMode !== "none" && !apiKey) {
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
        const value = normalizeTranslationValue(segment, translated.get(segment.id));
        if (!value.translatedText) {
          throw Object.assign(new Error("翻译服务返回空译文"), { code: "empty-translation" });
        }
        let cachedRecord = null;
        if (identity?.usable) {
          try {
            cachedRecord = await SegmentTranslationCache.put(attachment, segment,
              targetLanguage, encodeCachedTranslation(segment, value), modelSpec,
              { identity });
          }
          catch (error) {
            SegmentTranslationCache.logCacheError("write", error);
          }
        }
        results.set(segment.id, this.result(segment, "translated", value.translatedText,
          null, modelSpec, value.translatedUnits, cachedRecord?.recordID));
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
