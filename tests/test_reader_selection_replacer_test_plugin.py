import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "zotero-reader-selection-replacer-test"


def test_selection_replacer_manifest_is_independent() -> None:
    manifest = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    assert manifest["name"] == "Translator for Zotero"
    assert manifest["version"] == "1.1.0"
    assert zotero["id"] == "reader-selection-replacer-test@local.kumiko"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.*"


def test_selection_replacer_uses_reader_selection_event_and_no_network() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    translation_source = (PLUGIN / "translation-service.js").read_text(encoding="utf-8")
    assert '"renderTextSelectionPopup"' in source
    assert '"renderToolbar"' in source
    assert "registerSection" in source
    assert "reader-selection-replacer-test-pane" in source
    assert "renderItemPane" in source
    assert "saveAPIKeyFromPanel" in source
    assert "retryFrontMatter" in source
    assert "TranslationModelRegistry" in translation_source
    assert "TranslationProviderRegistry" in translation_source
    assert "QwenCredentials" in translation_source
    assert "activeTranslationProvider" in translation_source
    assert "QwenMTPlusTranslationClient" in translation_source
    assert "QWEN_MT_PLUS_MODEL" in translation_source
    assert '"qwen-mt-plus"' in translation_source
    assert "VALIDATION_REQUEST_TIMEOUT = 5000" in translation_source
    assert "TRANSLATION_REQUEST_TIMEOUT = 10000" in translation_source
    assert "NETWORK_RETRY_DELAYS = []" in translation_source
    assert "CONTENT_RETRY_DELAYS = []" in translation_source
    assert "translation_options" in translation_source
    assert "requestOptions" in translation_source
    assert "maskAPIKey" in source
    assert "reader-selection-replacer-test-pane-provider-qwen" in source
    assert "reader-selection-replacer-test-pane-provider-deepseek" in source
    assert "icons/qwen-symbol-32.png" in source
    assert "icons/deepseek-symbol-32.png" in source
    assert "icons/qwen-20.png" not in source
    assert "icons/deepseek-20.png" not in source
    assert "makeProviderLogo" in source
    assert "message" not in source[source.index("  renderItemPane({"):source.index("  async selectProviderForPanels")]
    assert "insertFTLIfNeeded" in source
    assert "PANEL_LOCALE_FILE" in source
    assert "QWEN_MT_BASE_URL" in translation_source
    assert '"https://dashscope.aliyuncs.com/compatible-mode/v1"' in translation_source
    assert "qwenMTEndpoint" not in translation_source
    assert "待配置 Qwen-MT API endpoint" not in source
    assert "annotation?.text" in source
    assert "annotation?.position" in source
    assert "getSelectionPosition" in source
    assert "getClientRect" in source
    assert "reader-selection-replacer-test-layer" in source
    assert 'button.textContent = "翻译"' in source
    assert "DEFAULT_REPLACEMENT" not in source
    assert "replaceSelection" not in source
    assert "SelectionMatcher" in source
    assert "ReaderPageDataLoader" in source
    assert "getPageData" in source
    assert "sourceCharIDs" in source
    assert "selectedCharIDs" in source
    assert "selectedPosition" in source
    assert "completeSelectionLines" in source
    assert "translationText" in source
    assert "translationPosition" in source
    assert "translationIndentFirstBlock" in source
    assert "paragraphCount" in source
    assert 'matchType: full ? "full" : "partial"' in source
    assert "lineCharCounts" in source
    assert 'paragraph.matchType === "unclassified"' in source
    assert '`${unclassified ? "U" : "P"}${displayIndex + 1}`' in source
    assert "buildSelectionContext" in source
    assert "selectionContext" in source
    assert "ReaderMetadataLoader" in source
    assert 'readField("title")' in source
    assert 'readField("abstractNote")' in source
    assert "ReaderTargetLocator" in source
    assert "extractFrontMatter" in source
    assert "metadata-segmented" in source
    assert "metadataHeadinglessAbstractTarget" in source
    assert "abstractLayoutFallbackTarget" in source
    assert "abstractFlow" in source
    assert "abstractFlowLineMatches" in source
    assert "pageGutter" in source
    assert "matchedAnchorCharIDs" in source
    assert "makeTitleMetadataSearchRegions" in source
    assert "selectedLineCharIDs" in source
    assert "FRONT_MATTER_PAGE_INDEX" in source
    assert "FRONT_MATTER_PAGE_LIMIT" not in source
    assert "A B S T R A C T" not in source
    assert "_findController" not in source
    assert "diagnostic" in source
    assert "标题" in source
    assert "摘要" in source
    assert 'PLUGIN_VERSION = "1.1.0"' in source
    assert "PARAGRAPH_TRANSLATION_INDENT" in source
    assert "records: new Map()" in source
    assert "removeRecord" in source
    assert "front-matter" in source
    assert "selection-${++this.selectionTaskCounter}" in source
    assert "selection-translation" in source
    assert "renderSelectionTranslations" in source
    assert "translateSelection" in source
    assert "displayModes" in source
    assert "bindTranslationToggle" in source
    assert "translationDisplayMode" in source
    assert 'border: "none"' in source
    assert 'source: parent ? "parent-item" : "none"' in source
    assert 'source: parent ? "parent-item" : (title || abstractText ? "attachment" : "none")' not in source
    assert "function sleep(" not in source
    for forbidden in [
        "fetch(",
        "XMLHttpRequest",
        "saveAnnotations",
        "Zotero.Annotations.save",
    ]:
        assert forbidden not in source


def test_selection_replacer_xpi_contents() -> None:
    xpi = ROOT / "dist" / "Translator-for-Zotero-1.1.0.xpi"
    if not xpi.exists():
        return
    with zipfile.ZipFile(xpi) as archive:
        assert set(archive.namelist()) == {
            "manifest.json",
            "README.md",
            "bootstrap.js",
            "page-data-body-extractor.js",
            "content-segments.js",
            "translation-service.js",
            "icons/paper-assistant-16.svg",
            "icons/paper-assistant-20.svg",
            "icons/translator-for-zotero-16.svg",
            "icons/translator-for-zotero-20.svg",
            "icons/translator-for-zotero.png",
            "icons/qwen-symbol-32.png",
            "icons/deepseek-symbol-32.png",
            "docs/translation-workflow.png",
            "docs/system-architecture.png",
            "locale/en-US/reader-selection-replacer-test.ftl",
            "locale/zh-CN/reader-selection-replacer-test.ftl",
        }
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == "1.1.0"
        assert archive.read("bootstrap.js") == (PLUGIN / "bootstrap.js").read_bytes()
        assert archive.read("page-data-body-extractor.js") == (
            PLUGIN / "page-data-body-extractor.js"
        ).read_bytes()
        assert archive.read("content-segments.js") == (PLUGIN / "content-segments.js").read_bytes()
        assert archive.read("translation-service.js") == (
            PLUGIN / "translation-service.js"
        ).read_bytes()
        assert archive.read("icons/paper-assistant-16.svg") == (
            PLUGIN / "icons" / "paper-assistant-16.svg"
        ).read_bytes()
        assert archive.read("icons/paper-assistant-20.svg") == (
            PLUGIN / "icons" / "paper-assistant-20.svg"
        ).read_bytes()
        assert archive.read("icons/translator-for-zotero.png") == (
            PLUGIN / "icons" / "translator-for-zotero.png"
        ).read_bytes()
        assert archive.read("icons/translator-for-zotero-16.svg") == (
            PLUGIN / "icons" / "translator-for-zotero-16.svg"
        ).read_bytes()
        assert archive.read("icons/translator-for-zotero-20.svg") == (
            PLUGIN / "icons" / "translator-for-zotero-20.svg"
        ).read_bytes()
        assert archive.read("icons/qwen-symbol-32.png") == (
            PLUGIN / "icons" / "qwen-symbol-32.png"
        ).read_bytes()
        assert archive.read("icons/deepseek-symbol-32.png") == (
            PLUGIN / "icons" / "deepseek-symbol-32.png"
        ).read_bytes()
        assert archive.read("docs/translation-workflow.png") == (
            PLUGIN / "docs" / "translation-workflow.png"
        ).read_bytes()
        assert archive.read("docs/system-architecture.png") == (
            PLUGIN / "docs" / "system-architecture.png"
        ).read_bytes()
        assert archive.read("locale/en-US/reader-selection-replacer-test.ftl") == (
            PLUGIN / "locale" / "en-US" / "reader-selection-replacer-test.ftl"
        ).read_bytes()
        assert archive.read("locale/zh-CN/reader-selection-replacer-test.ftl") == (
            PLUGIN / "locale" / "zh-CN" / "reader-selection-replacer-test.ftl"
        ).read_bytes()
