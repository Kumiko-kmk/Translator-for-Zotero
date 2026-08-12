import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "zotero-reader-highlighter"
LAYOUT_ENGINE = ROOT / "zotero-reader-highlighter" / "layout-extractor.js"


def test_manifest_targets_local_zotero_9() -> None:
    manifest = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    assert manifest["manifest_version"] == 2
    assert manifest["version"] == "0.8.1"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.*"
    assert zotero["update_url"].endswith(".invalid/updates.json")


def test_plugin_implements_translation_pipeline() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert "ItemPaneManager.registerSection" in source
    assert "PDFWorker.getFullText" in source
    assert "getPageData" in source
    assert "ReaderBodyLayoutExtractor.extract" in source
    assert "getSDTExclusionRegions" in source
    assert 'reason: semanticType === "table" ? "zotero-sdt-table"' in source
    assert '"zotero-sdt-math"' in source
    assert "mathBlockCount" in source
    assert "_initReadAloudSegments" not in source
    assert "_readAloudSegments" not in source
    assert "reconstructParagraphFlow" not in source
    assert "PARAGRAPH_LAYOUT_VERSION = \"geometry-v3\"" in source
    assert "exportRawSegmentation" in source
    assert "DeepSeekCredentials" in source
    assert "Services.logins.searchLoginsAsync" in source
    assert 'const DEEPSEEK_MODEL = "deepseek-v4-flash"' in source
    assert 'thinking: { type: "disabled" }' in source
    assert 'response_format: { type: "json_object" }' in source
    assert 'temperature: 0.1' in source
    assert '`${DEEPSEEK_BASE_URL}/models`' in source
    assert '`${DEEPSEEK_BASE_URL}/chat/completions`' in source
    assert "MAX_BATCH_PARAGRAPHS = 5" in source
    assert "MAX_BATCH_CHARACTERS = 2600" in source
    assert "TRANSLATION_CONCURRENCY = 4" in source
    assert 'PROMPT_VERSION = "body-translation-v2"' in source
    assert "encodeProtectedText" in source
    assert "validateTranslationRows" in source
    assert "NETWORK_RETRY_DELAYS = [1000, 3000, 8000]" in source
    assert "CONTENT_RETRY_DELAYS = [1000, 3000, 8000]" in source
    assert "CONTENT_MAX_RETRIES = 3" in source
    assert "extractBalancedJSONCandidates" in source
    assert "retry-exhausted:" in source
    assert "compareParagraphOrder" in source
    assert "failureDetails: new Map()" in source
    assert "recordFailure(session" in source
    assert "失败详情（临时诊断" in source


def test_plugin_uses_local_cache_without_credentials() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert 'const CACHE_FILE = "paper-assistant-translations.sqlite"' in source
    assert "CREATE TABLE IF NOT EXISTS translations" in source
    assert "library_id INTEGER" in source
    assert "position_signature TEXT" in source
    assert "source_hash TEXT" in source
    assert "prompt_version TEXT" in source
    assert "error_message TEXT" in source
    schema_start = source.index("CREATE TABLE IF NOT EXISTS translations")
    schema_end = source.index("`);", schema_start)
    assert "api_key" not in source[schema_start:schema_end].lower()
    assert "Zotero.Prefs.set(" not in source[source.index("var DeepSeekCredentials"):source.index("var TranslationCache")]


def test_plugin_filters_non_body_content_and_references() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    layout_source = LAYOUT_ENGINE.read_text(encoding="utf-8")
    for marker in [
        "isPublicationMetadataBlock",
        "isFormulaBlock",
        "isFigureOrTableCaption",
        "isTableLikeBlock",
        "isHeadingBlock",
    ]:
        assert marker in source
    for marker in [
        "detectTableLineReasons",
        "rowsHaveAlignedCells",
        "crossColumnLineMergeCount",
        "zotero-sdt",
        "proseContinuation",
        "proseSyntax",
    ]:
        assert marker in layout_source
    assert "references|bibliography|literature" in source
    assert 'split("\\f")' in source
    assert "fullText.text.slice" not in source
    assert "state.preview.value = fullText.text" in source


def test_plugin_renders_non_destructive_reader_overlays() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert "paper-assistant-translation-layer-v2" in source
    assert "Components.utils.cloneInto" in source
    assert "session.view.getClientRect" in source
    assert '"pagerendered", "scalechanging", "rotationchanging"' in source
    assert "overlaySettleTimer" in source
    assert "clusterRects" in source
    assert "getPartMetrics" in source
    assert 'cover.className = "paper-assistant-source-cover"' in source
    assert 'computed?.getPropertyValue?.("--background-color")' in source
    assert "background: pageColors.background" in source
    assert "maxFont" in source
    assert "record.cover.style.display" in source
    assert "Components.utils.exportFunction" in source
    assert "position.nextPageRects" in source
    assert "position.fragments" in source
    assert "sourceCharCount" in source
    assert 'badge.textContent = "中"' in source
    assert 'expand.textContent = "展开"' in source
    assert "addAnnotationFromReadAloudSegments" not in source
    assert "saveAnnotations" not in source


def test_right_side_reader_workspace_is_preserved() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert 'Zotero.Prefs.set("layout", "standard")' in source
    assert "ZoteroContextPane.collapsed = false" in source
    assert "itemDetails.pinnedPane = PANE_ID" in source
    assert "reader._waitForInternalReader" not in source
    assert 'getElementById("sidebarContainer")' not in source


def test_built_xpi_has_manifest_at_archive_root() -> None:
    xpi = ROOT / "dist" / "reader-text-highlighter-0.8.1.xpi"
    if not xpi.exists():
        return
    with zipfile.ZipFile(xpi) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "bootstrap.js" in names
        assert "layout-extractor.js" in names
        assert "locale/zh-CN/reader-text-highlighter.ftl" in names
        assert "icons/highlighter-20.svg" in names
        assert not any(name.startswith("zotero-reader-highlighter/") for name in names)
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == "0.8.1"
        assert archive.read("bootstrap.js") == (PLUGIN / "bootstrap.js").read_bytes()
        assert archive.read("layout-extractor.js") == LAYOUT_ENGINE.read_bytes()


def test_release_source_contains_no_integration_test_hook() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert "INTEGRATION_TEST_PDF" not in source
    assert "runPDFIntegrationTest" not in source
    assert "Legacy" not in source
    assert source.count("var ReaderOverlay = {") == 1
    assert len(source.splitlines()) < 2700
