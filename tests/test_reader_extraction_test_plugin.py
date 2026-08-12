import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "zotero-reader-extraction-test"
MAIN_PLUGIN = ROOT / "zotero-reader-highlighter"


def test_extraction_test_manifest_is_independent() -> None:
    manifest = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    assert manifest["version"] == "0.10.2"
    assert zotero["id"] == "reader-text-extraction-test@local.kumiko"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.*"


def test_extraction_test_has_exactly_one_get_page_data_path() -> None:
    source = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    extractor = (PLUGIN / "page-data-body-extractor.js").read_text(encoding="utf-8")
    combined = source + extractor

    assert (PLUGIN / "page-data-body-extractor.js").exists()
    assert not (PLUGIN / "pdfjs-body-extractor.js").exists()
    assert not (PLUGIN / "sdt-body-extractor.js").exists()
    assert not (PLUGIN / "layout-extractor.js").exists()

    assert "pdfDocument.getPageData(request)" in source
    assert 'EXTRACTION_SOURCE = "zotero-page-data"' in source
    assert 'EXTRACTION_MODE = "page-data-body-paragraphs"' in source
    assert 'SNAPSHOT_SCHEMA = "reader-text-extraction-test.v10"' in source
    assert "ReaderPageDataBodyExtractor.extract" in source

    for forbidden in [
        "getTextContent",
        "pdfDocument.getPage(",
        "_loadSDT",
        "ReaderSDTBodyExtractor",
        "sdt-body-extractor",
        "_readAloudSegments",
        "getStructTree",
        "getOperatorList",
        "DeepSeek",
        "chat/completions",
        "XMLHttpRequest",
        "fetch(",
    ]:
        assert forbidden not in combined

    for marker in [
        "copyPageCharacters",
        "clusterPageLines",
        "detectGutter",
        "markFormulaRegions",
        "markTables",
        "markCaptionsAndFigureLabels",
        "markBodyBoundaries",
        "column-continuation",
        "page-continuation",
        "characterConservation",
        "retainedAmbiguities",
        "BOUNDARY_CLASS",
        "renderBoundaryMarker",
        "PARAGRAPH_START_COLOR",
        "PARAGRAPH_END_COLOR",
        'coordinateSource: "zotero-page-char"',
    ]:
        assert marker in combined


def test_main_plugin_runtime_remains_separate() -> None:
    build = (ROOT / "tools" / "build_reader_highlighter_xpi.ps1").read_text(encoding="utf-8")
    extraction_build = (ROOT / "tools" / "build_reader_extraction_test_xpi.ps1").read_text(encoding="utf-8")
    assert "zotero-reader-highlighter\\layout-extractor.js" in build
    assert "page-data-body-extractor.js" not in build
    assert "page-data-body-extractor.js" in extraction_build
    main_manifest = json.loads((MAIN_PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    assert main_manifest["version"] == "0.8.1"


def test_extraction_test_xpi_contents() -> None:
    xpi = ROOT / "dist" / "reader-extraction-test-0.10.2.xpi"
    if not xpi.exists():
        return
    with zipfile.ZipFile(xpi) as archive:
        names = set(archive.namelist())
        assert names == {
            "manifest.json",
            "README.md",
            "bootstrap.js",
            "page-data-body-extractor.js",
        }
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == "0.10.2"
        assert archive.read("bootstrap.js") == (PLUGIN / "bootstrap.js").read_bytes()
        assert archive.read("page-data-body-extractor.js") == (
            PLUGIN / "page-data-body-extractor.js"
        ).read_bytes()
