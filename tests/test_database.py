from paper_assistant.ai import MockDeepSeekClient
from paper_assistant.models import JobStage
from paper_assistant.pdf_processing import PARSER_VERSION, extract_and_preprocess
from paper_assistant.pipeline import sha256_file
from paper_assistant.segmentation import segment_sections


def test_database_persists_preprocessing_and_two_stage_results(database, layout_pdf) -> None:
    title, pages, sections = extract_and_preprocess(layout_pdf)
    segments = segment_sections(sections, max_chars=1800, overlap_chars=100)
    paper, created = database.create_or_get_paper(
        title=layout_pdf.stem,
        filename=layout_pdf.name,
        file_path=str(layout_pdf),
        file_sha256=sha256_file(layout_pdf),
    )
    assert created
    job = database.create_job(paper["id"])
    database.replace_preprocessed(
        paper["id"],
        title=title,
        parser_version=PARSER_VERSION,
        pages=pages,
        sections=sections,
        segments=segments,
    )
    client = MockDeepSeekClient()
    segment_values = []
    for segment in segments:
        value, _raw = client.understand_segment(title, segment)
        database.save_segment_analysis(
            value,
            raw_response_path="mock.json",
            model_name=client.model_name,
            prompt_version="test",
        )
        segment_values.append(value)
    document, _raw = client.synthesize_document(title, segment_values)
    database.save_document_analysis(
        paper["id"],
        document,
        raw_response_path="mock.json",
        model_name=client.model_name,
        prompt_version="test",
    )
    database.update_job(job["id"], JobStage.COMPLETED, 100, "done")

    assert len(database.get_pages(paper["id"])) == 3
    assert len(database.get_sections(paper["id"])) >= 4
    assert len(database.get_segments(paper["id"])) == len(segments)
    assert len(database.list_segment_analyses(paper["id"])) == len(segments)
    assert database.get_document_analysis(paper["id"]).title == title


def test_database_contains_only_pipeline_tables(database) -> None:
    with database.connect() as conn:
        names = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
    assert names == {
        "papers",
        "paper_pages",
        "paper_sections",
        "paper_segments",
        "segment_analyses",
        "document_analyses",
        "jobs",
        "settings",
    }

