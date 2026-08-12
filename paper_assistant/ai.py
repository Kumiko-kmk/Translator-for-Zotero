from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeVar
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from .models import (
    DocumentUnderstanding,
    Evidence,
    PaperSegment,
    SectionDigest,
    SegmentUnderstanding,
)


SEGMENT_PROMPT_VERSION = "segment-understanding-v2"
SYNTHESIS_PROMPT_VERSION = "document-synthesis-v2"
ModelT = TypeVar("ModelT", bound=BaseModel)


def parse_model_json(raw: str, model_type: type[ModelT]) -> ModelT:
    text = raw.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1)
    try:
        return model_type.model_validate_json(text)
    except (ValidationError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid {model_type.__name__} JSON: {exc}") from exc


class UnderstandingClient(ABC):
    model_name: str

    @abstractmethod
    def understand_segment(
        self, paper_title: str, segment: PaperSegment
    ) -> tuple[SegmentUnderstanding, str]:
        raise NotImplementedError

    @abstractmethod
    def synthesize_document(
        self, paper_title: str, segments: list[SegmentUnderstanding]
    ) -> tuple[DocumentUnderstanding, str]:
        raise NotImplementedError


def _sentences(text: str) -> list[str]:
    cleaned = re.sub(r"\s+", " ", text).strip()
    return [value.strip() for value in re.split(r"(?<=[.!?。！？])\s+", cleaned) if value.strip()]


class MockDeepSeekClient(UnderstandingClient):
    """Deterministic offline client that exercises the exact two-stage pipeline."""

    model_name = "mock-deepseek"

    def understand_segment(
        self, paper_title: str, segment: PaperSegment
    ) -> tuple[SegmentUnderstanding, str]:
        sentences = _sentences(segment.text)
        first = sentences[0] if sentences else segment.text[:240]
        key_points = sentences[:3] or ["该分段没有足够的可提取文本。"]
        methods = [
            sentence
            for sentence in sentences
            if re.search(r"\b(method|train|model|network|algorithm|activation)\b", sentence, re.I)
        ][:3]
        results = [
            sentence
            for sentence in sentences
            if re.search(r"\b(result|performance|dataset|accuracy|error|experiment)\b", sentence, re.I)
        ][:3]
        concepts = list(
            dict.fromkeys(
                re.findall(
                    r"\b(?:rectifier|sparsity|neural network|deep architecture|pre-training|activation)\w*",
                    segment.text,
                    re.I,
                )
            )
        )[:8]
        value = SegmentUnderstanding(
            segment_id=segment.id,
            section_title=segment.section_title,
            start_page=segment.start_page,
            end_page=segment.end_page,
            segment_summary=f"离线 Mock：{first[:300]}",
            role_in_paper=f"该分段属于“{segment.section_title}”，用于验证逐段理解与持久化流程。",
            key_points=key_points,
            methods=methods,
            data_and_results=results,
            concepts=concepts,
            evidence=[
                Evidence(
                    claim="该段内容已成功提取并送入理解阶段",
                    page=segment.start_page,
                    quote=segment.text[:220].replace("\n", " "),
                )
            ],
            uncertainties=["Mock 模式不对论文内容作语义推断；配置 API Key 后重新处理。"],
        )
        return value, value.model_dump_json(indent=2)

    def synthesize_document(
        self, paper_title: str, segments: list[SegmentUnderstanding]
    ) -> tuple[DocumentUnderstanding, str]:
        digests = [
            SectionDigest(
                section_title=item.section_title,
                summary=item.segment_summary,
                pages=f"{item.start_page}-{item.end_page}",
            )
            for item in segments
        ]
        evidence = [item.evidence[0] for item in segments if item.evidence][:8]
        value = DocumentUnderstanding(
            title=paper_title,
            one_sentence_summary="离线 Mock 已完成 PDF 预处理、逐段理解和全文汇总闭环。",
            research_problem="Mock 模式未进行语义推断。",
            background="未说明（Mock）",
            approach="按章节切分论文，逐段生成结构化理解，再基于各段结果汇总。",
            datasets=[],
            experiment_design="未说明（Mock）",
            main_findings=["所有有效分段均已完成独立处理并保留页码证据。"],
            contributions=["验证了面向真实双栏 PDF 的完整处理管线。"],
            limitations=["Mock 内容不能代替 DeepSeek 对论文的真实理解。"],
            future_work=["配置 DeepSeek API Key 后重新处理。"],
            section_digests=digests,
            evidence=evidence,
        )
        return value, value.model_dump_json(indent=2)


class DeepSeekClient(UnderstandingClient):
    def __init__(self, api_key: str, base_url: str, model_name: str, log_dir: Path):
        if not api_key:
            raise ValueError("DeepSeek API key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _request(self, system: str, user: str) -> str:
        payload = json.dumps(
            {
                "model": self.model_name,
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"DeepSeek HTTP {exc.code}: {detail}") from exc
        return str(decoded["choices"][0]["message"]["content"])

    def _validated_request(
        self, system: str, user: str, model_type: type[ModelT], category: str
    ) -> tuple[ModelT, str]:
        last_error: Exception | None = None
        for attempt in range(2):
            correction = (
                "\n上一次输出未通过 JSON 校验。只返回符合 Schema 的完整 JSON，不要 Markdown。"
                if attempt
                else ""
            )
            raw = self._request(system, user + correction)
            path = self.log_dir / (
                f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%S')}_{category}_{uuid4().hex[:8]}.json"
            )
            path.write_text(raw, encoding="utf-8")
            try:
                return parse_model_json(raw, model_type), str(path)
            except ValueError as exc:
                last_error = exc
        raise RuntimeError(f"DeepSeek JSON validation failed after one retry: {last_error}")

    def understand_segment(
        self, paper_title: str, segment: PaperSegment
    ) -> tuple[SegmentUnderstanding, str]:
        schema = json.dumps(SegmentUnderstanding.model_json_schema(), ensure_ascii=False)
        system = (
            "你是严谨的论文分段理解器。只能依据当前分段，不能补写分段中没有的事实。"
            "提取方法、数据、结果、概念及该段在论文中的作用。每条关键结论尽量附原文页码与短引文。"
            "不确定或上下文不足的内容写入 uncertainties。"
        )
        user = (
            f"论文：{paper_title}\n分段 ID：{segment.id}\n章节：{segment.section_title}\n"
            f"页码：{segment.start_page}-{segment.end_page}\n"
            f"严格按此 JSON Schema 返回：{schema}\n\n分段原文：\n{segment.text}"
        )
        return self._validated_request(system, user, SegmentUnderstanding, "segment")

    def synthesize_document(
        self, paper_title: str, segments: list[SegmentUnderstanding]
    ) -> tuple[DocumentUnderstanding, str]:
        schema = json.dumps(DocumentUnderstanding.model_json_schema(), ensure_ascii=False)
        input_json = json.dumps(
            [segment.model_dump() for segment in segments], ensure_ascii=False
        )
        system = (
            "你是论文全文汇总器。只根据已验证的逐段理解结果生成论文级结构化理解。"
            "不得虚构实验、数据或引用；冲突或缺失信息必须明确说明。证据页码必须来自输入。"
        )
        user = (
            f"论文：{paper_title}\n严格按此 JSON Schema 返回：{schema}\n\n"
            f"逐段理解结果：\n{input_json}"
        )
        return self._validated_request(system, user, DocumentUnderstanding, "synthesis")

