from __future__ import annotations

import hashlib
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Any

from .ai import (
    SEGMENT_PROMPT_VERSION,
    SYNTHESIS_PROMPT_VERSION,
    DeepSeekClient,
    MockDeepSeekClient,
    UnderstandingClient,
)
from .config import AppConfig
from .database import Database
from .models import JobStage
from .pdf_processing import PARSER_VERSION, extract_pdf_layout, preprocess_layout
from .segmentation import segment_sections


def sha256_file(path: Path | str, block_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


class PaperService:
    def __init__(
        self,
        config: AppConfig,
        database: Database | None = None,
        client: UnderstandingClient | None = None,
    ):
        self.config = config
        self.config.ensure_directories()
        self.database = database or Database(config.database_path)
        self.database.initialize()
        self.client = client or (
            DeepSeekClient(
                config.deepseek_api_key,
                config.deepseek_base_url,
                config.deepseek_model,
                config.log_dir,
            )
            if not config.mock_mode
            else MockDeepSeekClient()
        )
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pdf-pipeline")
        self._futures: dict[str, Future[None]] = {}
        self._lock = Lock()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)

    def import_pdf(self, pdf_path: Path | str, *, background: bool = True) -> dict[str, Any]:
        path = Path(pdf_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(path)
        if path.suffix.lower() != ".pdf":
            raise ValueError("Only PDF files are supported")
        paper, created = self.database.create_or_get_paper(
            title=path.stem,
            filename=path.name,
            file_path=str(path),
            file_sha256=sha256_file(path),
        )
        if not created:
            return {"paper": paper, "created": False, "duplicate": True, "job": None}
        job = self.database.create_job(paper["id"])
        if background:
            self.submit(job["id"])
        else:
            self.process(job["id"])
        return {
            "paper": self.database.get_paper(paper["id"]),
            "created": True,
            "duplicate": False,
            "job": self.database.get_job(job["id"]),
        }

    def reprocess(self, paper_id: str) -> dict[str, Any]:
        paper = self.database.get_paper(paper_id)
        if not paper:
            raise KeyError(paper_id)
        job = self.database.create_job(paper_id)
        self.submit(job["id"], force=True)
        return job

    def resume(self, job_id: str) -> Future[None]:
        job = self.database.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        if job["stage"] != JobStage.FAILED.value:
            raise ValueError("Only failed jobs can be resumed")
        return self.submit(job_id, force=False)

    def submit(self, job_id: str, *, force: bool = False) -> Future[None]:
        with self._lock:
            current = self._futures.get(job_id)
            if current and not current.done():
                return current
            future = self._executor.submit(self.process, job_id, force=force)
            self._futures[job_id] = future
            return future

    def process(self, job_id: str, *, force: bool = False) -> None:
        job = self.database.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        paper_id = job["paper_id"]
        paper = self.database.get_paper(paper_id)
        if not paper:
            raise KeyError(paper_id)
        try:
            segments = [] if force else self.database.get_segments(paper_id)
            if not segments:
                self.database.update_job(job_id, JobStage.EXTRACTING, 10, "读取页面与版面块")
                raw_pages = extract_pdf_layout(paper["file_path"])
                self.database.update_job(
                    job_id, JobStage.PREPROCESSING, 30, "双栏排序、页眉页脚清理、断词修复"
                )
                title, pages, sections = preprocess_layout(raw_pages)
                self.database.update_job(job_id, JobStage.SEGMENTING, 45, "按章节生成语义分段")
                segments = segment_sections(sections)
                if not segments:
                    raise RuntimeError("No analyzable text segments were produced")
                self.database.replace_preprocessed(
                    paper_id,
                    title=title,
                    parser_version=PARSER_VERSION,
                    pages=pages,
                    sections=sections,
                    segments=segments,
                )
                paper = self.database.get_paper(paper_id)
            analyses = []
            total = len(segments)
            for index, segment in enumerate(segments):
                existing = None if force else self.database.get_segment_analysis(segment.id)
                progress = 50 + int((index / max(total, 1)) * 35)
                self.database.update_job(
                    job_id,
                    JobStage.UNDERSTANDING,
                    progress,
                    f"{index + 1}/{total} · {segment.section_title} · 第 {segment.start_page}-{segment.end_page} 页",
                )
                if existing:
                    analyses.append(existing)
                    continue
                value, raw_reference = self.client.understand_segment(paper["title"], segment)
                raw_path = self._persist_raw(job_id, f"segment-{index + 1}", raw_reference)
                self.database.save_segment_analysis(
                    value,
                    raw_response_path=raw_path,
                    model_name=self.client.model_name,
                    prompt_version=SEGMENT_PROMPT_VERSION,
                )
                analyses.append(value)
            self.database.update_job(job_id, JobStage.SYNTHESIZING, 92, "汇总全部分段理解")
            document, raw_reference = self.client.synthesize_document(paper["title"], analyses)
            raw_path = self._persist_raw(job_id, "synthesis", raw_reference)
            self.database.save_document_analysis(
                paper_id,
                document,
                raw_response_path=raw_path,
                model_name=self.client.model_name,
                prompt_version=SYNTHESIS_PROMPT_VERSION,
            )
            self.database.update_job(job_id, JobStage.COMPLETED, 100, "处理完成")
        except Exception as exc:
            self.database.update_job(job_id, JobStage.FAILED, 100, "处理失败", str(exc))

    def _persist_raw(self, job_id: str, suffix: str, raw_reference: str) -> str:
        if not raw_reference.lstrip().startswith(("{", "[", "```")):
            candidate = Path(raw_reference)
            try:
                if candidate.exists():
                    return str(candidate)
            except OSError:
                pass
        path = self.config.log_dir / f"{job_id}_{suffix}.json"
        path.write_text(raw_reference, encoding="utf-8")
        return str(path)
