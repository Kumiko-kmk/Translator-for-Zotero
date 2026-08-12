from paper_assistant.ai import MockDeepSeekClient, parse_model_json
from paper_assistant.models import PaperSegment, SegmentUnderstanding


def _segment() -> PaperSegment:
    text = (
        "The experimental method trains a rectifier neural network. "
        "Results on the dataset improve performance and preserve sparse activation."
    )
    return PaperSegment(
        id="segment-1",
        order_index=0,
        section_id="section-1",
        section_title="4 Experimental Study",
        start_page=5,
        end_page=5,
        text=text,
        char_count=len(text),
    )


def test_mock_client_uses_segment_identity_pages_and_two_stage_output() -> None:
    client = MockDeepSeekClient()
    segment_value, raw = client.understand_segment("Paper", _segment())
    parsed = parse_model_json(raw, SegmentUnderstanding)
    assert parsed.segment_id == "segment-1"
    assert parsed.evidence[0].page == 5
    assert parsed.methods
    assert parsed.data_and_results

    document, _raw = client.synthesize_document("Paper", [segment_value])
    assert document.title == "Paper"
    assert document.section_digests[0].section_title == "4 Experimental Study"
    assert document.evidence[0].page == 5


def test_json_validation_rejects_incomplete_segment() -> None:
    try:
        parse_model_json('{"segment_id": "only"}', SegmentUnderstanding)
    except ValueError as exc:
        assert "SegmentUnderstanding" in str(exc)
    else:
        raise AssertionError("Expected validation failure")

