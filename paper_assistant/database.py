from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from .models import (
    DocumentUnderstanding,
    JobStage,
    PageText,
    PaperSection,
    PaperSegment,
    SegmentUnderstanding,
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_sha256 TEXT NOT NULL UNIQUE,
    page_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    parser_version TEXT
);
CREATE TABLE IF NOT EXISTS paper_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    raw_text TEXT NOT NULL,
    cleaned_text TEXT NOT NULL,
    blocks_json TEXT NOT NULL,
    removed_margin_json TEXT NOT NULL,
    needs_ocr INTEGER NOT NULL,
    image_count INTEGER NOT NULL,
    UNIQUE(paper_id, page_number)
);
CREATE TABLE IF NOT EXISTS paper_sections (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    level INTEGER NOT NULL,
    start_page INTEGER NOT NULL,
    end_page INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_segments (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL REFERENCES paper_sections(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    section_title TEXT NOT NULL,
    start_page INTEGER NOT NULL,
    end_page INTEGER NOT NULL,
    text TEXT NOT NULL,
    char_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segment_analyses (
    segment_id TEXT PRIMARY KEY REFERENCES paper_segments(id) ON DELETE CASCADE,
    analysis_json TEXT NOT NULL,
    raw_response_path TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    analyzed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_analyses (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    analysis_json TEXT NOT NULL,
    raw_response_path TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    analyzed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL,
    current_item TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    def create_or_get_paper(
        self, *, title: str, filename: str, file_path: str, file_sha256: str
    ) -> tuple[dict[str, Any], bool]:
        now = utc_now()
        with self.connect() as conn:
            existing = conn.execute(
                "SELECT * FROM papers WHERE file_sha256 = ?", (file_sha256,)
            ).fetchone()
            if existing:
                return dict(existing), False
            paper_id = str(uuid4())
            conn.execute(
                """
                INSERT INTO papers (
                    id, title, filename, file_path, file_sha256, status, imported_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    paper_id,
                    title,
                    filename,
                    file_path,
                    file_sha256,
                    JobStage.IMPORTING.value,
                    now,
                    now,
                ),
            )
            return dict(conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()), True

    def get_paper(self, paper_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
            return dict(row) if row else None

    def list_papers(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM papers ORDER BY imported_at DESC"
                ).fetchall()
            ]

    def create_job(self, paper_id: str) -> dict[str, Any]:
        job_id, now = str(uuid4()), utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (id, paper_id, stage, progress, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?)
                """,
                (job_id, paper_id, JobStage.IMPORTING.value, now, now),
            )
            return dict(conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def update_job(
        self,
        job_id: str,
        stage: JobStage,
        progress: int,
        current_item: str = "",
        error_message: str | None = None,
    ) -> None:
        with self.connect() as conn:
            row = conn.execute("SELECT paper_id FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError(job_id)
            now = utc_now()
            conn.execute(
                """
                UPDATE jobs SET stage=?, progress=?, current_item=?, error_message=?, updated_at=?
                WHERE id=?
                """,
                (stage.value, max(0, min(100, progress)), current_item, error_message, now, job_id),
            )
            conn.execute(
                "UPDATE papers SET status=?, updated_at=? WHERE id=?",
                (stage.value, now, row["paper_id"]),
            )

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def list_jobs(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT j.*, p.title AS paper_title
                    FROM jobs j JOIN papers p ON p.id=j.paper_id
                    ORDER BY j.created_at DESC
                    """
                ).fetchall()
            ]

    def latest_job(self, paper_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE paper_id=? ORDER BY created_at DESC LIMIT 1",
                (paper_id,),
            ).fetchone()
        return dict(row) if row else None

    def replace_preprocessed(
        self,
        paper_id: str,
        *,
        title: str,
        parser_version: str,
        pages: list[PageText],
        sections: list[PaperSection],
        segments: list[PaperSegment],
    ) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM paper_pages WHERE paper_id=?", (paper_id,))
            conn.execute("DELETE FROM paper_sections WHERE paper_id=?", (paper_id,))
            conn.execute(
                """
                UPDATE papers SET title=?, page_count=?, parser_version=?, updated_at=?
                WHERE id=?
                """,
                (title, len(pages), parser_version, utc_now(), paper_id),
            )
            conn.executemany(
                """
                INSERT INTO paper_pages (
                    paper_id, page_number, raw_text, cleaned_text, blocks_json,
                    removed_margin_json, needs_ocr, image_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        paper_id,
                        page.page_number,
                        page.raw_text,
                        page.cleaned_text,
                        json.dumps([block.model_dump() for block in page.blocks], ensure_ascii=False),
                        json.dumps(page.removed_margin_text, ensure_ascii=False),
                        int(page.needs_ocr),
                        page.image_count,
                    )
                    for page in pages
                ],
            )
            conn.executemany(
                """
                INSERT INTO paper_sections (
                    id, paper_id, order_index, title, level, start_page, end_page, text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        section.id,
                        paper_id,
                        section.order_index,
                        section.title,
                        section.level,
                        section.start_page,
                        section.end_page,
                        section.text,
                    )
                    for section in sections
                ],
            )
            conn.executemany(
                """
                INSERT INTO paper_segments (
                    id, paper_id, section_id, order_index, section_title,
                    start_page, end_page, text, char_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        segment.id,
                        paper_id,
                        segment.section_id,
                        segment.order_index,
                        segment.section_title,
                        segment.start_page,
                        segment.end_page,
                        segment.text,
                        segment.char_count,
                    )
                    for segment in segments
                ],
            )

    def get_pages(self, paper_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM paper_pages WHERE paper_id=? ORDER BY page_number", (paper_id,)
                ).fetchall()
            ]

    def get_sections(self, paper_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM paper_sections WHERE paper_id=? ORDER BY order_index",
                    (paper_id,),
                ).fetchall()
            ]

    def get_segments(self, paper_id: str) -> list[PaperSegment]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM paper_segments WHERE paper_id=? ORDER BY order_index", (paper_id,)
            ).fetchall()
        return [
            PaperSegment(
                id=row["id"],
                order_index=row["order_index"],
                section_id=row["section_id"],
                section_title=row["section_title"],
                start_page=row["start_page"],
                end_page=row["end_page"],
                text=row["text"],
                char_count=row["char_count"],
            )
            for row in rows
        ]

    def save_segment_analysis(
        self,
        value: SegmentUnderstanding,
        *,
        raw_response_path: str,
        model_name: str,
        prompt_version: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO segment_analyses (
                    segment_id, analysis_json, raw_response_path,
                    model_name, prompt_version, analyzed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    value.segment_id,
                    value.model_dump_json(),
                    raw_response_path,
                    model_name,
                    prompt_version,
                    utc_now(),
                ),
            )

    def get_segment_analysis(self, segment_id: str) -> SegmentUnderstanding | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT analysis_json FROM segment_analyses WHERE segment_id=?", (segment_id,)
            ).fetchone()
        return SegmentUnderstanding.model_validate_json(row["analysis_json"]) if row else None

    def list_segment_analyses(self, paper_id: str) -> list[SegmentUnderstanding]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT a.analysis_json
                FROM segment_analyses a JOIN paper_segments s ON s.id=a.segment_id
                WHERE s.paper_id=? ORDER BY s.order_index
                """,
                (paper_id,),
            ).fetchall()
        return [SegmentUnderstanding.model_validate_json(row["analysis_json"]) for row in rows]

    def save_document_analysis(
        self,
        paper_id: str,
        value: DocumentUnderstanding,
        *,
        raw_response_path: str,
        model_name: str,
        prompt_version: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO document_analyses (
                    paper_id, analysis_json, raw_response_path,
                    model_name, prompt_version, analyzed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    paper_id,
                    value.model_dump_json(),
                    raw_response_path,
                    model_name,
                    prompt_version,
                    utc_now(),
                ),
            )

    def get_document_analysis(self, paper_id: str) -> DocumentUnderstanding | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT analysis_json FROM document_analyses WHERE paper_id=?", (paper_id,)
            ).fetchone()
        return DocumentUnderstanding.model_validate_json(row["analysis_json"]) if row else None

    def get_setting(self, key: str, default: str = "") -> str:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, value, utc_now()),
            )
