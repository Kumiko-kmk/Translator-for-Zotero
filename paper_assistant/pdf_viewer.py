from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import fitz
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)


class PdfReaderWidget(QWidget):
    """Render one PDF page and overlay the retained preprocessing text blocks."""

    page_changed = Signal(int)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._document: fitz.Document | None = None
        self._pdf_path: Path | None = None
        self._blocks_by_page: dict[int, list[dict[str, Any]]] = {}
        self._page_number = 1
        self._zoom = 1.1
        self.highlight_items: list[QGraphicsRectItem] = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        toolbar = QHBoxLayout()
        self.previous_button = QPushButton("‹")
        self.previous_button.setToolTip("上一页")
        self.previous_button.clicked.connect(self.previous_page)
        toolbar.addWidget(self.previous_button)

        self.page_spin = QSpinBox()
        self.page_spin.setPrefix("第 ")
        self.page_spin.setSuffix(" 页")
        self.page_spin.setMinimum(1)
        self.page_spin.valueChanged.connect(self.go_to_page)
        toolbar.addWidget(self.page_spin)

        self.page_total_label = QLabel("/ 0")
        toolbar.addWidget(self.page_total_label)

        self.next_button = QPushButton("›")
        self.next_button.setToolTip("下一页")
        self.next_button.clicked.connect(self.next_page)
        toolbar.addWidget(self.next_button)

        toolbar.addSpacing(8)
        self.zoom_out_button = QPushButton("−")
        self.zoom_out_button.setToolTip("缩小")
        self.zoom_out_button.clicked.connect(self.zoom_out)
        toolbar.addWidget(self.zoom_out_button)
        self.zoom_label = QLabel("110%")
        self.zoom_label.setMinimumWidth(46)
        self.zoom_label.setAlignment(Qt.AlignCenter)
        toolbar.addWidget(self.zoom_label)
        self.zoom_in_button = QPushButton("+")
        self.zoom_in_button.setToolTip("放大")
        self.zoom_in_button.clicked.connect(self.zoom_in)
        toolbar.addWidget(self.zoom_in_button)
        self.fit_button = QPushButton("适合宽度")
        self.fit_button.clicked.connect(self.fit_width)
        toolbar.addWidget(self.fit_button)
        toolbar.addStretch()

        self.highlight_toggle = QCheckBox("段落高亮")
        self.highlight_toggle.setChecked(True)
        self.highlight_toggle.toggled.connect(self._set_highlights_visible)
        toolbar.addWidget(self.highlight_toggle)
        layout.addLayout(toolbar)

        self.scene = QGraphicsScene(self)
        self.view = QGraphicsView(self.scene)
        self.view.setRenderHints(
            QPainter.Antialiasing | QPainter.SmoothPixmapTransform | QPainter.TextAntialiasing
        )
        self.view.setAlignment(Qt.AlignHCenter | Qt.AlignTop)
        self.view.setBackgroundBrush(QColor("#d8dadd"))
        self.view.setDragMode(QGraphicsView.ScrollHandDrag)
        layout.addWidget(self.view, 1)

        self.status_label = QLabel("选择论文后在此显示 PDF")
        self.status_label.setStyleSheet("color: #59636e; padding: 3px 6px;")
        layout.addWidget(self.status_label)
        self._update_controls()

    @property
    def page_count(self) -> int:
        return self._document.page_count if self._document is not None else 0

    @property
    def current_page(self) -> int:
        return self._page_number

    @property
    def highlight_count(self) -> int:
        return len(self.highlight_items)

    def set_document(self, pdf_path: str | Path, pages: list[dict[str, Any]]) -> None:
        path = Path(pdf_path)
        self._blocks_by_page = self._decode_blocks(pages)
        if self._pdf_path == path and self._document is not None:
            self._render_page()
            return

        self.close_document()
        if not path.is_file():
            self.status_label.setText(f"PDF 文件不存在：{path}")
            self._update_controls()
            return
        try:
            self._document = fitz.open(path)
        except Exception as exc:
            self.status_label.setText(f"无法打开 PDF：{exc}")
            self._update_controls()
            return

        self._pdf_path = path
        self._page_number = 1
        self.page_spin.blockSignals(True)
        self.page_spin.setRange(1, max(1, self.page_count))
        self.page_spin.setValue(1)
        self.page_spin.blockSignals(False)
        self._render_page()

    @staticmethod
    def _decode_blocks(pages: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
        result: dict[int, list[dict[str, Any]]] = {}
        for page in pages:
            try:
                blocks = json.loads(page.get("blocks_json", "[]"))
            except (TypeError, json.JSONDecodeError):
                blocks = []
            result[int(page["page_number"])] = [
                block
                for block in blocks
                if isinstance(block, dict)
                and isinstance(block.get("bbox"), (list, tuple))
                and len(block["bbox"]) == 4
            ]
        return result

    def close_document(self) -> None:
        self.scene.clear()
        self.highlight_items.clear()
        if self._document is not None:
            self._document.close()
        self._document = None
        self._pdf_path = None
        self._page_number = 1
        self._update_controls()

    def go_to_page(self, page_number: int) -> None:
        if self._document is None:
            return
        bounded = max(1, min(int(page_number), self.page_count))
        if bounded == self._page_number and self.scene.items():
            return
        self._page_number = bounded
        self.page_spin.blockSignals(True)
        self.page_spin.setValue(bounded)
        self.page_spin.blockSignals(False)
        self._render_page()
        self.page_changed.emit(bounded)

    def previous_page(self) -> None:
        self.go_to_page(self._page_number - 1)

    def next_page(self) -> None:
        self.go_to_page(self._page_number + 1)

    def zoom_in(self) -> None:
        self._set_zoom(self._zoom * 1.2)

    def zoom_out(self) -> None:
        self._set_zoom(self._zoom / 1.2)

    def fit_width(self) -> None:
        if self._document is None:
            return
        page = self._document.load_page(self._page_number - 1)
        available_width = max(200, self.view.viewport().width() - 30)
        self._set_zoom(available_width / float(page.rect.width))

    def _set_zoom(self, value: float) -> None:
        value = max(0.45, min(4.0, value))
        if abs(value - self._zoom) < 0.001:
            return
        self._zoom = value
        self._render_page()

    def _render_page(self) -> None:
        self.scene.clear()
        self.highlight_items.clear()
        if self._document is None or self.page_count == 0:
            self._update_controls()
            return

        page = self._document.load_page(self._page_number - 1)
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(self._zoom, self._zoom),
            colorspace=fitz.csRGB,
            alpha=False,
        )
        image = QImage(
            pixmap.samples,
            pixmap.width,
            pixmap.height,
            pixmap.stride,
            QImage.Format_RGB888,
        ).copy()
        page_item = self.scene.addPixmap(QPixmap.fromImage(image))
        page_item.setZValue(0)

        fill = QColor(255, 235, 59, 82)
        outline = QPen(QColor(226, 171, 0, 170))
        outline.setWidthF(max(0.7, self._zoom * 0.7))
        for block in self._blocks_by_page.get(self._page_number, []):
            x0, y0, x1, y1 = (float(value) * self._zoom for value in block["bbox"])
            item = self.scene.addRect(x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0))
            item.setBrush(fill)
            item.setPen(outline)
            item.setZValue(2)
            item.setVisible(self.highlight_toggle.isChecked())
            text = str(block.get("text", "")).strip()
            item.setToolTip(text[:500])
            self.highlight_items.append(item)

        self.scene.setSceneRect(0, 0, pixmap.width, pixmap.height)
        self.view.horizontalScrollBar().setValue(0)
        self.view.verticalScrollBar().setValue(0)
        self._update_controls()

    def _set_highlights_visible(self, visible: bool) -> None:
        for item in self.highlight_items:
            item.setVisible(visible)

    def _update_controls(self) -> None:
        has_document = self._document is not None and self.page_count > 0
        self.page_total_label.setText(f"/ {self.page_count}")
        self.zoom_label.setText(f"{round(self._zoom * 100)}%")
        self.page_spin.setEnabled(has_document)
        self.previous_button.setEnabled(has_document and self._page_number > 1)
        self.next_button.setEnabled(has_document and self._page_number < self.page_count)
        self.zoom_out_button.setEnabled(has_document)
        self.zoom_in_button.setEnabled(has_document)
        self.fit_button.setEnabled(has_document)
        self.highlight_toggle.setEnabled(has_document)
        if has_document:
            self.status_label.setText(
                f"第 {self._page_number} 页 · 识别文本块 {self.highlight_count} 个"
                " · 黄色高亮仅显示，不修改原 PDF"
            )
