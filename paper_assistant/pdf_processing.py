from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import (
    PageText,
    PaperSection,
    TextBlock,
    TextFragment,
)


PARSER_VERSION = "pymupdf-layout-v2"
MIN_PAGE_TEXT = 40
HEADING_RE = re.compile(r"^([1-9]\d*(?:\.\d+)*)\s+([A-Z][^\n]{1,120})$")
NAMED_HEADING_RE = re.compile(r"^(Abstract|References|Acknowledg(?:e)?ments?)$", re.I)


@dataclass(slots=True)
class RawPageLayout:
    width: float
    height: float
    raw_text: str
    blocks: list[dict[str, Any]]
    image_count: int


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\u00ad", "")
    text = re.sub(r"(?<=[A-Za-z])-\s*\n\s*(?=[a-z])", "", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    paragraphs: list[str] = []
    current: list[str] = []
    for line in lines:
        if not line:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        current.append(line)
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(paragraphs).strip()


def _margin_signature(text: str) -> str:
    value = normalize_text(text).lower()
    value = re.sub(r"\d+", "<number>", value)
    return re.sub(r"\s+", " ", value).strip()


def _raw_blocks(page: Any, page_number: int) -> tuple[list[dict[str, Any]], int]:
    output: list[dict[str, Any]] = []
    image_count = 0
    for block in page.get_text("dict", sort=False)["blocks"]:
        if block.get("type") == 1:
            image_count += 1
            continue
        lines = block.get("lines", [])
        spans = [span for line in lines for span in line.get("spans", [])]
        if not spans:
            continue
        raw_text = "\n".join(
            "".join(span.get("text", "") for span in line.get("spans", []))
            for line in lines
        ).strip()
        if not raw_text:
            continue
        output.append(
            {
                "page_number": page_number,
                "bbox": tuple(float(value) for value in block["bbox"]),
                "raw_text": raw_text,
                "text": normalize_text(raw_text),
                "font_size": max(float(span.get("size", 0)) for span in spans),
                "bold": any("bold" in str(span.get("font", "")).lower() for span in spans),
            }
        )
    return output, image_count


def _repeated_margin_signatures(
    page_blocks: list[tuple[float, list[dict[str, Any]]]]
) -> set[str]:
    candidates: Counter[str] = Counter()
    for page_height, blocks in page_blocks:
        page_values: set[str] = set()
        for block in blocks:
            _x0, y0, _x1, y1 = block["bbox"]
            if y1 < page_height * 0.11 or y0 > page_height * 0.93:
                signature = _margin_signature(block["text"])
                if signature:
                    page_values.add(signature)
        candidates.update(page_values)
    return {signature for signature, count in candidates.items() if count >= 2}


def _reading_order(blocks: list[dict[str, Any]], page_width: float) -> list[dict[str, Any]]:
    midpoint = page_width / 2
    wide: list[dict[str, Any]] = []
    columns: list[dict[str, Any]] = []
    for block in blocks:
        x0, _y0, x1, _y1 = block["bbox"]
        if x0 < midpoint - 45 and x1 > midpoint + 45:
            wide.append(block)
        else:
            columns.append(block)
    wide.sort(key=lambda block: (block["bbox"][1], block["bbox"][0]))
    remaining = set(range(len(columns)))
    ordered: list[dict[str, Any]] = []

    def add_column_band(before_y: float) -> None:
        band = [
            (index, block)
            for index, block in enumerate(columns)
            if index in remaining and block["bbox"][1] < before_y
        ]
        left = sorted(
            ((i, b) for i, b in band if (b["bbox"][0] + b["bbox"][2]) / 2 < midpoint),
            key=lambda item: (item[1]["bbox"][1], item[1]["bbox"][0]),
        )
        right = sorted(
            ((i, b) for i, b in band if (b["bbox"][0] + b["bbox"][2]) / 2 >= midpoint),
            key=lambda item: (item[1]["bbox"][1], item[1]["bbox"][0]),
        )
        for index, block in [*left, *right]:
            ordered.append(block)
            remaining.discard(index)

    for block in wide:
        add_column_band(block["bbox"][1] - 2)
        ordered.append(block)
    add_column_band(float("inf"))
    return ordered


def _heading(text: str) -> tuple[str, int] | None:
    compact = re.sub(r"\s+", " ", text).strip()
    named = NAMED_HEADING_RE.fullmatch(compact)
    if named:
        return compact, 1
    numbered = HEADING_RE.fullmatch(compact)
    if numbered and len(compact) <= 130:
        number, title = numbered.groups()
        if re.search(r"[A-Za-z\u4e00-\u9fff]", title):
            return compact, number.count(".") + 1
    return None


def _extract_title(pages: list[PageText]) -> str:
    candidates = [
        block
        for block in pages[0].blocks
        if block.kind not in {"header", "footer"}
        and block.bbox[1] < 320
        and 4 <= len(block.text) <= 250
    ]
    if not candidates:
        return "Untitled paper"
    return max(candidates, key=lambda block: (block.font_size, len(block.text))).text


def _build_sections(pages: list[PageText]) -> list[PaperSection]:
    sections: list[PaperSection] = []
    title = "Front Matter"
    level = 1
    fragments: list[TextFragment] = []
    start_page = 1

    def flush(*, keep_empty: bool = False) -> None:
        nonlocal fragments
        if not fragments and not keep_empty:
            return
        sections.append(
            PaperSection(
                id=str(uuid4()),
                order_index=len(sections),
                title=title,
                level=level,
                start_page=start_page,
                end_page=fragments[-1].page_number if fragments else start_page,
                fragments=fragments,
            )
        )
        fragments = []

    for page in pages:
        for block in page.blocks:
            if block.kind in {"header", "footer", "footnote"}:
                continue
            heading = _heading(block.text)
            if heading:
                flush(keep_empty=title != "Front Matter")
                title, level = heading
                start_page = page.page_number
                continue
            if block.text:
                fragments.append(TextFragment(page_number=page.page_number, text=block.text))
    flush()
    return sections


def extract_pdf_layout(pdf_path: Path | str) -> list[RawPageLayout]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required. Install requirements.txt first.") from exc

    path = Path(pdf_path)
    raw_pages: list[RawPageLayout] = []
    with fitz.open(path) as document:
        for index, page in enumerate(document):
            blocks, image_count = _raw_blocks(page, index + 1)
            raw_pages.append(
                RawPageLayout(
                    width=float(page.rect.width),
                    height=float(page.rect.height),
                    raw_text=page.get_text(),
                    blocks=blocks,
                    image_count=image_count,
                )
            )
    return raw_pages


def preprocess_layout(
    raw_pages: list[RawPageLayout],
) -> tuple[str, list[PageText], list[PaperSection]]:
    if not raw_pages:
        raise ValueError("PDF has no pages")
    signatures = _repeated_margin_signatures(
        [(page.height, page.blocks) for page in raw_pages]
    )
    pages: list[PageText] = []
    for page_number, raw_page in enumerate(raw_pages, 1):
        width, height = raw_page.width, raw_page.height
        raw_text, raw_blocks, image_count = (
            raw_page.raw_text,
            raw_page.blocks,
            raw_page.image_count,
        )
        kept: list[dict[str, Any]] = []
        removed: list[str] = []
        first_page_max_font = (
            max((block["font_size"] for block in raw_blocks), default=0) if page_number == 1 else 0
        )
        for block in raw_blocks:
            _x0, y0, _x1, y1 = block["bbox"]
            signature = _margin_signature(block["text"])
            is_margin = y1 < height * 0.11 or y0 > height * 0.93
            numeric_margin = bool(re.fullmatch(r"\d+", block["text"])) and (
                y1 < height * 0.12 or y0 > height * 0.9
            )
            protected_title = (
                page_number == 1
                and block["font_size"] == first_page_max_font
                and len(block["text"]) >= 8
            )
            if ((is_margin and signature in signatures) or numeric_margin) and not protected_title:
                removed.append(block["text"])
                block["kind"] = "header" if y1 < height * 0.5 else "footer"
            elif block["font_size"] <= 8.5 and y0 > height * 0.84:
                block["kind"] = "footnote"
            else:
                block["kind"] = "heading" if _heading(block["text"]) else "body"
                kept.append(block)
        ordered = _reading_order(kept, width)
        page_models = [
            TextBlock(
                page_number=page_number,
                order_index=order,
                bbox=block["bbox"],
                text=block["text"],
                font_size=block["font_size"],
                kind=block["kind"],
            )
            for order, block in enumerate(ordered)
        ]
        pages.append(
            PageText(
                page_number=page_number,
                raw_text=raw_text,
                cleaned_text="\n\n".join(block.text for block in page_models),
                blocks=page_models,
                removed_margin_text=removed,
                needs_ocr=len(normalize_text(raw_text)) < MIN_PAGE_TEXT,
                image_count=image_count,
            )
        )
    return _extract_title(pages), pages, _build_sections(pages)


def extract_and_preprocess(pdf_path: Path | str) -> tuple[str, list[PageText], list[PaperSection]]:
    return preprocess_layout(extract_pdf_layout(pdf_path))
