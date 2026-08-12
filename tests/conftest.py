from __future__ import annotations

import os
from pathlib import Path

import pytest

from paper_assistant.config import AppConfig
from paper_assistant.database import Database


@pytest.fixture
def app_config(tmp_path: Path) -> AppConfig:
    return AppConfig(database_path=tmp_path / "pipeline.db", log_dir=tmp_path / "logs")


@pytest.fixture
def database(tmp_path: Path) -> Database:
    value = Database(tmp_path / "pipeline.db")
    value.initialize()
    return value


@pytest.fixture
def layout_pdf(tmp_path: Path) -> Path:
    import fitz

    path = tmp_path / "two_column.pdf"
    document = fitz.open()
    for page_number in range(1, 4):
        page = document.new_page(width=612, height=792)
        if page_number == 1:
            page.insert_text(
                (145, 80),
                "A Page-Aware PDF Understanding Pipeline",
                fontsize=16,
            )
        else:
            page.insert_textbox(
                fitz.Rect(180, 30, 432, 50),
                "A Page-Aware PDF Understanding Pipeline",
                fontsize=9,
                align=fitz.TEXT_ALIGN_CENTER,
            )
        left_heading = "Abstract" if page_number == 1 else f"{page_number} Left Column"
        page.insert_textbox(fitz.Rect(60, 110, 290, 140), left_heading, fontsize=12)
        page.insert_textbox(
            fitz.Rect(60, 145, 290, 650),
            (
                f"Left column page {page_number}. This biologically plausible method uses "
                "page-aware extraction and preserves reading order. " * 5
            ),
            fontsize=10,
        )
        page.insert_textbox(
            fitz.Rect(322, 110, 552, 140), f"{page_number}.1 Right Column", fontsize=12
        )
        page.insert_textbox(
            fitz.Rect(322, 145, 552, 650),
            (
                f"Right column page {page_number}. The result remains after the complete "
                "left column and includes traceable evidence. " * 5
            ),
            fontsize=10,
        )
        page.insert_text((300, 765), str(page_number), fontsize=9)
    document.save(path)
    document.close()
    return path


@pytest.fixture
def real_pdf() -> Path:
    configured = os.getenv("TEST_PDF_PATH")
    path = (
        Path(configured)
        if configured
        else Path.home() / "Downloads" / "Deep Sparse Rectifier Neural Networks.pdf"
    )
    if not path.exists():
        pytest.skip(f"Real PDF regression sample not found: {path}")
    return path
