from __future__ import annotations

import re
from typing import Iterable
from uuid import uuid4

from .models import PaperSection, PaperSegment, TextFragment


SKIPPED_SECTIONS = {"front matter", "references", "acknowledgements", "acknowledgments"}


def _split_long_fragment(fragment: TextFragment, max_chars: int) -> list[TextFragment]:
    if len(fragment.text) <= max_chars:
        return [fragment]
    sentences = re.split(r"(?<=[.!?。！？])\s+", fragment.text)
    output: list[TextFragment] = []
    buffer = ""
    for sentence in sentences:
        if buffer and len(buffer) + len(sentence) + 1 > max_chars:
            output.append(TextFragment(page_number=fragment.page_number, text=buffer))
            buffer = ""
        if len(sentence) > max_chars:
            if buffer:
                output.append(TextFragment(page_number=fragment.page_number, text=buffer))
                buffer = ""
            output.extend(
                TextFragment(page_number=fragment.page_number, text=sentence[offset : offset + max_chars])
                for offset in range(0, len(sentence), max_chars)
            )
        else:
            buffer = f"{buffer} {sentence}".strip()
    if buffer:
        output.append(TextFragment(page_number=fragment.page_number, text=buffer))
    return output


def segment_sections(
    sections: Iterable[PaperSection],
    *,
    max_chars: int = 6000,
    overlap_chars: int = 300,
    merge_shorter_than: int = 500,
    include_references: bool = False,
) -> list[PaperSegment]:
    if max_chars < 500:
        raise ValueError("max_chars must be at least 500")
    if overlap_chars < 0 or overlap_chars >= max_chars:
        raise ValueError("overlap_chars must satisfy 0 <= overlap < max_chars")
    segments: list[PaperSegment] = []
    pending: list[TextFragment] = []
    for section in sections:
        normalized_title = re.sub(r"^\d+(?:\.\d+)*\s+", "", section.title).strip().lower()
        if normalized_title in SKIPPED_SECTIONS and not (
            include_references and normalized_title == "references"
        ):
            continue
        if len(section.text) < merge_shorter_than and section.title.lower() != "abstract":
            if section.text:
                pending.append(
                    TextFragment(
                        page_number=section.start_page,
                        text=f"[章节导语：{section.title}]\n{section.text}",
                    )
                )
            continue
        fragments = [
            part
            for fragment in [*pending, *section.fragments]
            for part in _split_long_fragment(fragment, max_chars)
        ]
        pending = []
        buffer: list[TextFragment] = []
        buffer_length = 0

        def flush() -> None:
            nonlocal buffer, buffer_length
            if not buffer:
                return
            text = "\n\n".join(fragment.text for fragment in buffer).strip()
            segments.append(
                PaperSegment(
                    id=str(uuid4()),
                    order_index=len(segments),
                    section_id=section.id,
                    section_title=section.title,
                    start_page=min(fragment.page_number for fragment in buffer),
                    end_page=max(fragment.page_number for fragment in buffer),
                    text=text,
                    char_count=len(text),
                )
            )
            if overlap_chars:
                tail = text[-overlap_chars:]
                last_page = buffer[-1].page_number
                buffer = [TextFragment(page_number=last_page, text=f"[重叠上下文] {tail}")]
                buffer_length = len(buffer[0].text)
            else:
                buffer = []
                buffer_length = 0

        for fragment in fragments:
            added = len(fragment.text) + (2 if buffer else 0)
            if buffer and buffer_length + added > int(max_chars * 1.15):
                flush()
            buffer.append(fragment)
            buffer_length += added
        flush()
    return segments
