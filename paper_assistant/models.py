from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class JobStage(StrEnum):
    IMPORTING = "IMPORTING"
    EXTRACTING = "EXTRACTING"
    PREPROCESSING = "PREPROCESSING"
    SEGMENTING = "SEGMENTING"
    UNDERSTANDING = "UNDERSTANDING"
    SYNTHESIZING = "SYNTHESIZING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class TextBlock(BaseModel):
    page_number: int = Field(ge=1)
    order_index: int = Field(ge=0)
    bbox: tuple[float, float, float, float]
    text: str
    font_size: float = 0
    kind: str = "body"


class PageText(BaseModel):
    page_number: int = Field(ge=1)
    raw_text: str
    cleaned_text: str
    blocks: list[TextBlock]
    removed_margin_text: list[str] = []
    needs_ocr: bool = False
    image_count: int = 0


class TextFragment(BaseModel):
    page_number: int = Field(ge=1)
    text: str


class PaperSection(BaseModel):
    id: str
    order_index: int = Field(ge=0)
    title: str
    level: int = Field(ge=1)
    start_page: int = Field(ge=1)
    end_page: int = Field(ge=1)
    fragments: list[TextFragment]

    @property
    def text(self) -> str:
        return "\n\n".join(fragment.text for fragment in self.fragments)


class PaperSegment(BaseModel):
    id: str
    order_index: int = Field(ge=0)
    section_id: str
    section_title: str
    start_page: int = Field(ge=1)
    end_page: int = Field(ge=1)
    text: str
    char_count: int = Field(ge=1)


class Evidence(BaseModel):
    claim: str
    page: int = Field(ge=1)
    quote: str


class SegmentUnderstanding(BaseModel):
    segment_id: str
    section_title: str
    start_page: int = Field(ge=1)
    end_page: int = Field(ge=1)
    segment_summary: str
    role_in_paper: str
    key_points: list[str]
    methods: list[str]
    data_and_results: list[str]
    concepts: list[str]
    evidence: list[Evidence]
    uncertainties: list[str]


class SectionDigest(BaseModel):
    section_title: str
    summary: str
    pages: str


class DocumentUnderstanding(BaseModel):
    title: str
    one_sentence_summary: str
    research_problem: str
    background: str
    approach: str
    datasets: list[str]
    experiment_design: str
    main_findings: list[str]
    contributions: list[str]
    limitations: list[str]
    future_work: list[str]
    section_digests: list[SectionDigest]
    evidence: list[Evidence]
