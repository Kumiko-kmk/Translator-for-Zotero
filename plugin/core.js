(function (global) {
  "use strict";

  const PLUGIN_ID = "reader-selection-replacer-test@local.kumiko";
  const PLUGIN_VERSION = "2.0.0";
  const POPUP_CLASS = "reader-selection-replacer-test-popup";
  const PANE_ID = "reader-selection-replacer-test-pane";
  const PANEL_LOCALE_FILE = "reader-selection-replacer-test.ftl";
  const LEGACY_TOOLBAR_IDS = Object.freeze([
    "reader-selection-replacer-test-auto-button",
    "reader-selection-replacer-test-auto-button-key",
    "reader-selection-replacer-test-auto-status"
  ]);
  const LAYER_CLASS = "reader-selection-replacer-test-layer";
  const PARAGRAPH_TRANSLATION_INDENT = "　　";
  const TRANSLATION_FAILURE_COUNTDOWN_SECONDS = 5;
  const TRANSLATION_FAILURE_MESSAGE = "翻译失败，请手动重试";
  const ITEM_PANE_REGISTRATION_RETRY_DELAY = 250;
  const ITEM_PANE_REGISTRATION_MAX_RETRIES = 40;
  const PARAGRAPH_MARK_COLORS = [
    "#0ea5e9", "#f97316", "#22c55e", "#a855f7", "#eab308", "#ec4899"
  ];
  const AUTO_TARGET_COLORS = Object.freeze({
    title: "#2563eb",
    abstract: "#f97316"
  });
  const AUTO_TARGET_LABELS = Object.freeze({
    title: "标题",
    abstract: "摘要"
  });
  const TRANSLATION_PROVIDER_UI = Object.freeze([
    Object.freeze({
      id: "qwen-mt",
      label: "Qwen",
      icon: "icons/qwen-symbol-hd.png",
      fallback: "Q",
      color: "#8c73fc"
    }),
    Object.freeze({
      id: "deepseek",
      label: "DeepSeek",
      icon: "icons/deepseek-symbol-hd.png",
      fallback: "D",
      color: "#052cba"
    }),
    Object.freeze({
      id: "gemini",
      label: "Gemini",
      icon: "icons/gemini-symbol-hd.png",
      fallback: "✦",
      color: "#3d0191"
    }),
    Object.freeze({
      id: "bing",
      label: "Bing",
      icon: "icons/bing-symbol-hd.png",
      fallback: "b",
      color: "#02c684"
    }),
    Object.freeze({
      id: "transmart",
      label: "Transmart",
      icon: "icons/transmart-symbol-hd.png",
      fallback: "T",
      color: "#00b0fd"
    }),
    Object.freeze({
      id: "cnki",
      label: "CNKI",
      icon: "icons/cnki-symbol-hd.png",
      fallback: "知",
      color: "#a8010b"
    })
  ]);
  const TRANSLATION_PROVIDER_UI_BY_ID = Object.freeze(
    Object.fromEntries(TRANSLATION_PROVIDER_UI.map(value => [value.id, value]))
  );
  const PANEL_STYLE_ID = "reader-selection-replacer-test-provider-panel-style";

  function createPanelLocalization() {
    const LocalizationConstructor = globalThis.Localization
      || (typeof Localization === "undefined" ? null : Localization);
    if (typeof LocalizationConstructor !== "function") return null;
    try {
      return new LocalizationConstructor([PANEL_LOCALE_FILE], true);
    }
    catch (error) {
      Zotero.logError?.(error);
      return null;
    }
  }

  function insertPanelLocalizationIntoMainWindows() {
    for (const win of Zotero.getMainWindows?.() || []) {
      try {
        win.MozXULElement?.insertFTLIfNeeded?.(PANEL_LOCALE_FILE);
      }
      catch (error) {
        Zotero.logError?.(error);
      }
    }
  }

  function copyRects(rects) {
    const result = [];
    for (const rect of rects || []) {
      if (!rect || Number(rect.length || 0) < 4) continue;
      const value = [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])];
      if (value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1]) {
        result.push(value);
      }
    }
    return result;
  }

  function boundingRect(rects) {
    const valid = (rects || []).filter(Boolean);
    if (!valid.length) return null;
    return [
      Math.min(...valid.map(rect => rect[0])),
      Math.min(...valid.map(rect => rect[1])),
      Math.max(...valid.map(rect => rect[2])),
      Math.max(...valid.map(rect => rect[3]))
    ];
  }

  function copyPosition(position) {
    if (!position || typeof position !== "object") return null;
    const fragments = Array.isArray(position.fragments)
      ? position.fragments.map(fragment => ({
        pageIndex: Number(fragment?.pageIndex ?? position.pageIndex ?? 0),
        flowID: fragment?.flowID == null ? null : String(fragment.flowID),
        rects: copyRects(fragment?.rects),
        lineIDs: Array.isArray(fragment?.lineIDs)
          ? fragment.lineIDs.map(value => String(value)) : [],
        lineCharCounts: Array.isArray(fragment?.lineCharCounts)
          ? fragment.lineCharCounts.map(value => Math.max(0, Number(value) || 0)) : []
      })).filter(fragment => fragment.rects.length)
      : [];
    if (!fragments.length) {
      const pageIndex = Number(position.pageIndex || 0);
      const rects = copyRects(position.rects);
      if (rects.length) fragments.push({ pageIndex, rects });
      const nextPageRects = copyRects(position.nextPageRects);
      if (nextPageRects.length) fragments.push({ pageIndex: pageIndex + 1, rects: nextPageRects });
    }
    if (!fragments.length) return null;
    const firstPage = Number(fragments[0].pageIndex || 0);
    return {
      version: Number(position.version) === 2 ? 2 : undefined,
      coordinateSpace: position.coordinateSpace === "pdf" ? "pdf" : undefined,
      pageIndex: firstPage,
      rects: copyRects(fragments.find(fragment => fragment.pageIndex === firstPage)?.rects),
      fragments
    };
  }

  function positionFragments(position) {
    return Array.isArray(position?.fragments) ? position.fragments : [];
  }

  function splitReplacement(text, parts) {
    const chars = [...String(text || "")];
    if (!parts.length) return [];
    if (!chars.length) return parts.map(() => "");
    if (chars.length <= parts.length) {
      return [chars.join(""), ...parts.slice(1).map(() => "")];
    }

    const weights = parts.map(part => Math.max(
      1,
      Number(part.sourceCharCount || 0)
        || ((part.rect[2] - part.rect[0]) * (part.rect[3] - part.rect[1]))
    ));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const chunks = [];
    let offset = 0;
    for (let index = 0; index < parts.length; index++) {
      if (index === parts.length - 1) {
        chunks.push(chars.slice(offset).join(""));
        break;
      }
      const cumulative = weights.slice(0, index + 1)
        .reduce((sum, value) => sum + value, 0);
      const end = Math.max(offset, Math.min(
        chars.length,
        Math.round(chars.length * cumulative / totalWeight)
      ));
      chunks.push(chars.slice(offset, end).join(""));
      offset = end;
    }
    return chunks;
  }

  function buildPositionFromChars(chars) {
    const byPage = new Map();
    const ordered = [...(chars || [])].filter(char => char?.rect)
      .sort((left, right) => Number(left.pageIndex || 0) - Number(right.pageIndex || 0)
        || Number(left.offset || 0) - Number(right.offset || 0));
    let current = null;
    for (const char of ordered) {
      const pageIndex = Number(char.pageIndex || 0);
      if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
      if (!current || current.pageIndex !== pageIndex) {
        current = { pageIndex, chars: [] };
        byPage.get(pageIndex).push(current);
      }
      current.chars.push(char);
      if (char.lineBreakAfter) current = null;
    }
    const fragments = [...byPage.entries()].sort((a, b) => a[0] - b[0])
      .map(([pageIndex, lines]) => {
        const entries = lines.map((line, index) => ({
          line,
          rect: boundingRect(line.chars.map(char => char.rect)),
          lineID: `${pageIndex}:metadata-line:${index}`
        })).filter(entry => entry.rect);
        return {
          pageIndex,
          flowID: null,
          rects: entries.map(entry => entry.rect),
          lineIDs: entries.map(entry => entry.lineID),
          lineCharCounts: entries.map(entry => entry.line.chars
            .filter(char => !/^\s+$/u.test(String(char.c || ""))).length)
        };
      }).filter(fragment => fragment.rects.length);
    if (!fragments.length) return null;
    return {
      version: 2,
      coordinateSpace: "pdf",
      pageIndex: fragments[0].pageIndex,
      rects: copyRects(fragments[0].rects),
      fragments
    };
  }


  global.TranslatorCore = Object.freeze({
    PLUGIN_ID,
    PLUGIN_VERSION,
    POPUP_CLASS,
    PANE_ID,
    PANEL_LOCALE_FILE,
    LEGACY_TOOLBAR_IDS,
    LAYER_CLASS,
    PARAGRAPH_TRANSLATION_INDENT,
    TRANSLATION_FAILURE_COUNTDOWN_SECONDS,
    TRANSLATION_FAILURE_MESSAGE,
    ITEM_PANE_REGISTRATION_RETRY_DELAY,
    ITEM_PANE_REGISTRATION_MAX_RETRIES,
    PARAGRAPH_MARK_COLORS,
    AUTO_TARGET_COLORS,
    AUTO_TARGET_LABELS,
    TRANSLATION_PROVIDER_UI,
    TRANSLATION_PROVIDER_UI_BY_ID,
    PANEL_STYLE_ID,
    createPanelLocalization,
    insertPanelLocalizationIntoMainWindows,
    copyRects,
    boundingRect,
    copyPosition,
    positionFragments,
    splitReplacement,
    buildPositionFromChars
  });
})(globalThis);
