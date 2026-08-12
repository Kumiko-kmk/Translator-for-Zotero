from paper_assistant.pdf_processing import extract_and_preprocess, normalize_text
from paper_assistant.segmentation import segment_sections


def test_normalization_repairs_ligatures_and_line_break_hyphenation() -> None:
    value = normalize_text("rectiﬁer is bi-\nologically plausible\nand sparse")
    assert value == "rectifier is biologically plausible and sparse"


def test_synthetic_two_column_order_and_margin_cleanup(layout_pdf) -> None:
    title, pages, sections = extract_and_preprocess(layout_pdf)
    assert title == "A Page-Aware PDF Understanding Pipeline"
    assert len(pages) == 3
    assert "A Page-Aware PDF Understanding Pipeline" in pages[1].removed_margin_text
    assert "2" in pages[1].removed_margin_text
    assert pages[1].cleaned_text.index("Left column page 2") < pages[1].cleaned_text.index(
        "2.1 Right Column"
    )
    assert all(not page.needs_ocr for page in pages)
    assert any(section.title == "Abstract" for section in sections)


def test_real_paper_regression_for_layout_cleanup_and_sections(real_pdf) -> None:
    title, pages, sections = extract_and_preprocess(real_pdf)
    section_titles = [section.title for section in sections]
    assert title == "Deep Sparse Rectifier Neural Networks"
    assert len(pages) == 9
    assert pages[1].cleaned_text.startswith("Regarding the training of deep networks")
    assert pages[1].cleaned_text.index("Regarding the training") < pages[1].cleaned_text.index(
        "2 Background"
    )
    assert "biologically plausible" in pages[0].cleaned_text
    assert "bi-\nologically" not in pages[0].cleaned_text
    assert "Deep Sparse Rectifier Neural Networks" in pages[1].removed_margin_text
    assert "316" in pages[1].removed_margin_text
    assert "2 Background" in section_titles
    assert "3 Deep Rectifier Networks" in section_titles
    assert "4 Experimental Study" in section_titles
    assert "References" in section_titles
    assert not any(title.startswith("0 ,") for title in section_titles)


def test_real_paper_segments_are_section_aware_and_model_sized(real_pdf) -> None:
    _title, _pages, sections = extract_and_preprocess(real_pdf)
    segments = segment_sections(sections)
    assert 8 <= len(segments) <= 12
    assert segments[0].section_title == "Abstract"
    assert all(segment.section_title not in {"Front Matter", "References"} for segment in segments)
    assert all(segment.char_count <= 6900 for segment in segments)
    assert all(segment.start_page <= segment.end_page for segment in segments)
    image_section = [segment for segment in segments if segment.section_title == "4.1 Image Recognition"]
    assert len(image_section) == 2
    assert image_section[0].text.startswith("[章节导语：4 Experimental Study]")

