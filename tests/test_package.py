import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin"
PACKAGED_FILES = {
    "manifest.json",
    "bootstrap.js",
    "page-text-index.js",
    "selection-block.js",
    "front-matter-extractor.js",
    "content-segments.js",
    "translation-service.js",
    "icons/paper-assistant-16.svg",
    "icons/paper-assistant-20.svg",
    "icons/translator-for-zotero-16.svg",
    "icons/translator-for-zotero-20.svg",
    "icons/translator-for-zotero.png",
    "icons/qwen-symbol-32.png",
    "icons/deepseek-symbol-32.png",
    "locale/en-US/reader-selection-replacer-test.ftl",
    "locale/zh-CN/reader-selection-replacer-test.ftl",
}


def test_repository_layout_contains_only_the_active_plugin() -> None:
    assert PLUGIN.is_dir()
    assert (ROOT / "docs" / "DEVELOPMENT.md").is_file()
    assert (ROOT / "tools" / "build_xpi.ps1").is_file()
    for retired_path in (
        "paper_assistant/main.py",
        "zotero-reader-extraction-test/manifest.json",
        "zotero-reader-highlighter/manifest.json",
        "zotero-reader-selection-replacer-test/manifest.json",
        "PROJECT_HANDOFF.md",
        "run.py",
        "requirements.txt",
        "logs/zotero-0.6.1-final.stdout.log",
    ):
        assert not (ROOT / retired_path).exists()


def test_selection_replacer_manifest_is_independent() -> None:
    manifest = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    assert manifest["name"] == "Translator for Zotero"
    assert manifest["version"] == "1.2.0"
    assert zotero["id"] == "reader-selection-replacer-test@local.kumiko"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.*"
    assert zotero["update_url"] == (
        "https://reader-selection-replacer-test.invalid/updates.json"
    )


def test_xpi_build_process_is_manifest_driven_and_validated() -> None:
    source = (ROOT / "tools" / "build_xpi.ps1").read_text(
        encoding="utf-8"
    )
    assert "param(" not in source
    assert "$version = [string]$manifest.version" in source
    assert "bootstrap.js PLUGIN_VERSION does not match" in source
    assert "Zotero update_url is required" in source
    assert "XPI file list validation failed" in source
    assert "manifest.json is not at the XPI root" in source
    assert "Move-Item -LiteralPath $temporaryPath" in source
    assert "Get-FileHash" in source


def test_selection_replacer_uses_reader_selection_event_and_no_network() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    index_source = (PLUGIN / "page-text-index.js").read_text(encoding="utf-8")
    selection_source = (PLUGIN / "selection-block.js").read_text(encoding="utf-8")
    segments_source = (PLUGIN / "content-segments.js").read_text(encoding="utf-8")
    translation_source = (PLUGIN / "translation-service.js").read_text(encoding="utf-8")
    assert '"renderTextSelectionPopup"' in source
    assert '"renderToolbar"' in source
    assert "registerSection" in source
    assert "schedulePaneRegistrationRetry" in source
    assert "onMainWindowLoad" in source
    assert "registerReaderListeners" in source
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
    assert "view.getClientRect" not in source
    assert "pageRectCache" not in source
    assert "reader-selection-replacer-test-layer" in source
    assert 'button.textContent = "翻译"' in source
    assert "DEFAULT_REPLACEMENT" not in source
    assert "replaceSelection" not in source
    assert "SelectionMatcher" not in source
    assert "ReaderPageDataLoader" not in source
    assert "ReaderParagraphEngine" not in source
    assert "ReaderSelectionBlock.create" in source
    assert "getPageData" in index_source
    assert 'coordinateSpace: "pdf"' in index_source
    assert "normalizedViewportMatrix" in index_source
    assert "function projectRect" in index_source
    assert "convertToViewportPoint" in index_source
    assert "convertToPdfPoint" in index_source
    assert "function groupRects" in selection_source
    assert "minimumGap" in selection_source
    assert 'mode: "selection-block"' in selection_source
    assert "geometricBreakRatios" in selection_source
    assert "distribution: { pageWeights, blockWeights }" in selection_source
    assert "selectionUnits" in segments_source
    assert "selection-translation-v4-layout-structure" in translation_source
    assert "allocateSelectionChunks" in source
    assert "fitSelectionFlowBlock" in source
    assert "paragraphCount" not in selection_source
    assert "MAX_BOUNDARY_SCAN_PAGES" not in selection_source
    assert "groupAdjacentSelectionTranslations" not in source
    assert "mergeSelectionParts" not in source
    assert "splitSelectionTranslation" not in source
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
    assert 'PLUGIN_VERSION = "1.2.0"' in source
    assert "PARAGRAPH_TRANSLATION_INDENT" in source
    assert "records: new Map()" in source
    assert "removeRecord" in source
    assert "front-matter" in source
    assert "selection-${++this.selectionTaskCounter}" in source
    assert "selection-translation" in source
    assert "renderSelectionTranslations" in source
    assert "translateSelection" in source
    assert "pageDisplayModes" in source
    assert "renderPageDisplayControls" in source
    assert "pageTranslationSessions" not in source
    assert "translatePage" not in source
    assert 'mode: "page-translation"' not in source
    assert "ReaderPageDataBodyExtractor" not in source
    assert "ContentSegments.fromPageParagraphs" not in source
    assert "翻译整页" not in source
    assert "bindTranslationToggle" not in source
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


def test_current_page_translation_pipeline_is_removed() -> None:
    segments = (PLUGIN / "content-segments.js").read_text(encoding="utf-8")
    service = (PLUGIN / "translation-service.js").read_text(encoding="utf-8")
    extractor = (PLUGIN / "front-matter-extractor.js").read_text(encoding="utf-8")
    assert "fromPageParagraphs" not in segments
    assert 'kind: "page-body"' not in segments
    assert "PAGE_BODY_TRANSLATION_PROMPT_VERSION" not in service
    assert 'segment?.kind === "page-body"' not in service
    assert "onProgress" not in service
    assert "extractPage" not in extractor
    assert "strictMinimumLineHeightRatio" not in extractor


def test_selection_replacer_xpi_contents() -> None:
    xpi = ROOT / "dist" / "Translator-for-Zotero-1.2.0.xpi"
    if not xpi.exists():
        return
    with zipfile.ZipFile(xpi) as archive:
        assert set(archive.namelist()) == PACKAGED_FILES
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == "1.2.0"
        for archive_path in PACKAGED_FILES:
            assert archive.read(archive_path) == (PLUGIN / archive_path).read_bytes()
