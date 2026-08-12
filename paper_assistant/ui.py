from __future__ import annotations

import json
from typing import Any

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .models import DocumentUnderstanding, JobStage, SegmentUnderstanding
from .pdf_viewer import PdfReaderWidget
from .pipeline import PaperService


STAGE_LABELS = {
    JobStage.IMPORTING: "导入文件",
    JobStage.EXTRACTING: "提取页面与版面",
    JobStage.PREPROCESSING: "清洗并恢复阅读顺序",
    JobStage.SEGMENTING: "识别章节并分段",
    JobStage.UNDERSTANDING: "DeepSeek 逐段理解",
    JobStage.SYNTHESIZING: "全文汇总",
    JobStage.COMPLETED: "完成",
    JobStage.FAILED: "失败",
}
STAGE_ORDER = [
    JobStage.IMPORTING,
    JobStage.EXTRACTING,
    JobStage.PREPROCESSING,
    JobStage.SEGMENTING,
    JobStage.UNDERSTANDING,
    JobStage.SYNTHESIZING,
    JobStage.COMPLETED,
]


def make_button(text: str, callback: Any) -> QPushButton:
    button = QPushButton(text)
    button.clicked.connect(callback)
    return button


class SettingsDialog(QDialog):
    def __init__(self, service: PaperService, parent: QWidget | None = None):
        super().__init__(parent)
        self.service = service
        self.setWindowTitle("DeepSeek 设置")
        layout = QFormLayout(self)
        self.api_key = QLineEdit(service.database.get_setting("deepseek_api_key", ""))
        self.api_key.setEchoMode(QLineEdit.Password)
        self.base_url = QLineEdit(
            service.database.get_setting("deepseek_base_url", service.config.deepseek_base_url)
        )
        self.model = QLineEdit(
            service.database.get_setting("deepseek_model", service.config.deepseek_model)
        )
        layout.addRow("API Key", self.api_key)
        layout.addRow("API 地址", self.base_url)
        layout.addRow("模型", self.model)
        note = QLabel("未配置 Key 时使用 Mock。保存后重启应用生效。")
        note.setWordWrap(True)
        layout.addRow(note)
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.save)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def save(self) -> None:
        self.service.database.set_setting("deepseek_api_key", self.api_key.text().strip())
        self.service.database.set_setting("deepseek_base_url", self.base_url.text().strip())
        self.service.database.set_setting("deepseek_model", self.model.text().strip())
        self.accept()


class MainWindow(QMainWindow):
    def __init__(self, service: PaperService):
        super().__init__()
        self.service = service
        self.setWindowTitle("PDF → DeepSeek 论文理解")
        self.resize(1680, 920)
        self._paper_signature: tuple[Any, ...] | None = None
        self._content_signature: tuple[Any, ...] | None = None

        root = QWidget()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        header = QHBoxLayout()
        title = QLabel("<h2>PDF → DeepSeek 论文理解</h2>")
        header.addWidget(title)
        self.paper_combo = QComboBox()
        self.paper_combo.currentIndexChanged.connect(self.paper_changed)
        header.addWidget(self.paper_combo, 1)
        header.addWidget(make_button("导入 PDF", self.import_pdf))
        header.addWidget(make_button("重新处理", self.reprocess))
        header.addWidget(make_button("模型设置", self.open_settings))
        outer.addLayout(header)

        self.mode_label = QLabel()
        outer.addWidget(self.mode_label)
        self.main_splitter = QSplitter(Qt.Horizontal)
        self.left_tabs = QTabWidget()
        self.pdf_viewer = PdfReaderWidget()
        self.right_tabs = QTabWidget()
        self.main_splitter.addWidget(self.left_tabs)
        self.main_splitter.addWidget(self.pdf_viewer)
        self.main_splitter.addWidget(self.right_tabs)
        self.main_splitter.setStretchFactor(0, 1)
        self.main_splitter.setStretchFactor(1, 2)
        self.main_splitter.setStretchFactor(2, 1)
        outer.addWidget(self.main_splitter, 1)
        self._build_process_tab()
        self._build_preprocess_tab()
        self._build_segment_tab()
        self._build_document_tab()
        self.left_tabs.setMinimumWidth(340)
        self.pdf_viewer.setMinimumWidth(560)
        self.right_tabs.setMinimumWidth(360)
        self.main_splitter.setSizes([410, 820, 430])

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(700)
        self.refresh(force=True)

    def _build_process_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.paper_info = QLabel("尚未导入论文")
        self.paper_info.setWordWrap(True)
        layout.addWidget(self.paper_info)
        self.progress = QProgressBar()
        layout.addWidget(self.progress)
        self.current_item = QLabel()
        self.current_item.setWordWrap(True)
        layout.addWidget(self.current_item)
        grid = QGridLayout()
        self.stage_widgets: dict[JobStage, QLabel] = {}
        for index, stage in enumerate(STAGE_ORDER):
            widget = QLabel(f"○ {STAGE_LABELS[stage]}")
            widget.setMinimumHeight(34)
            grid.addWidget(widget, index // 2, index % 2)
            self.stage_widgets[stage] = widget
        layout.addLayout(grid)
        self.metrics = QLabel()
        self.metrics.setWordWrap(True)
        layout.addWidget(self.metrics)
        self.error_label = QLabel()
        self.error_label.setWordWrap(True)
        self.error_label.setStyleSheet("color: #b42318;")
        layout.addWidget(self.error_label)
        layout.addStretch()
        self.left_tabs.addTab(tab, "处理流程")

    def _build_preprocess_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        hint = QLabel("这里显示真正送入 DeepSeek 前的数据。可检查页眉页脚清理、双栏顺序、章节和分段。")
        hint.setWordWrap(True)
        hint.setMaximumHeight(44)
        hint.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        layout.addWidget(hint)
        splitter = QSplitter(Qt.Vertical)
        self.preprocess_tree = QTreeWidget()
        self.preprocess_tree.setHeaderLabels(["结构", "页码/长度"])
        self.preprocess_tree.itemSelectionChanged.connect(self.show_preprocess_item)
        self.preprocess_text = QPlainTextEdit()
        self.preprocess_text.setReadOnly(True)
        splitter.addWidget(self.preprocess_tree)
        splitter.addWidget(self.preprocess_text)
        splitter.setSizes([360, 300])
        layout.addWidget(splitter)
        layout.setStretch(1, 1)
        self.left_tabs.addTab(tab, "预处理预览")

    def _build_segment_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        splitter = QSplitter(Qt.Vertical)
        self.segment_list = QListWidget()
        self.segment_list.itemSelectionChanged.connect(self.show_segment_analysis)
        self.segment_text = QPlainTextEdit()
        self.segment_text.setReadOnly(True)
        splitter.addWidget(self.segment_list)
        splitter.addWidget(self.segment_text)
        splitter.setSizes([270, 440])
        layout.addWidget(splitter)
        self.right_tabs.addTab(tab, "逐段理解")

    def _build_document_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.document_text = QPlainTextEdit()
        self.document_text.setReadOnly(True)
        layout.addWidget(self.document_text)
        self.right_tabs.addTab(tab, "全文汇总")

    def import_pdf(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择论文 PDF", "", "PDF 文件 (*.pdf)")
        if not path:
            return
        try:
            result = self.service.import_pdf(path, background=True)
            if result["duplicate"]:
                QMessageBox.information(self, "文件已存在", "相同 SHA256 的 PDF 已导入，不会重复处理。")
            self.refresh(force=True)
            paper_id = result["paper"]["id"]
            index = self.paper_combo.findData(paper_id)
            if index >= 0:
                self.paper_combo.setCurrentIndex(index)
        except Exception as exc:
            QMessageBox.critical(self, "导入失败", str(exc))

    def reprocess(self) -> None:
        paper_id = self.paper_combo.currentData()
        if not paper_id:
            return
        try:
            latest = self.service.database.latest_job(paper_id)
            if latest and latest["stage"] == JobStage.FAILED.value:
                self.service.resume(latest["id"])
            else:
                self.service.reprocess(paper_id)
            self.left_tabs.setCurrentIndex(0)
            self.refresh(force=True)
        except Exception as exc:
            QMessageBox.critical(self, "无法重新处理", str(exc))

    def open_settings(self) -> None:
        if SettingsDialog(self.service, self).exec():
            QMessageBox.information(self, "设置已保存", "请重启应用以切换 DeepSeek 客户端。")

    def paper_changed(self) -> None:
        self._content_signature = None
        self.refresh(force=True)

    def refresh(self, force: bool = False) -> None:
        papers = self.service.database.list_papers()
        selected = self.paper_combo.currentData()
        signature = tuple((paper["id"], paper["title"], paper["status"]) for paper in papers)
        if force or signature != self._paper_signature:
            self.paper_combo.blockSignals(True)
            self.paper_combo.clear()
            for paper in papers:
                self.paper_combo.addItem(paper["title"], paper["id"])
            if selected:
                index = self.paper_combo.findData(selected)
                if index >= 0:
                    self.paper_combo.setCurrentIndex(index)
            self.paper_combo.blockSignals(False)
            self._paper_signature = signature
        self.mode_label.setText(
            f"模式：{'离线 Mock' if self.service.config.mock_mode else 'DeepSeek API'} · "
            f"模型：{self.service.client.model_name}"
        )
        paper_id = self.paper_combo.currentData()
        if not paper_id:
            return
        self._refresh_process(paper_id)
        self._refresh_content(paper_id, force=force)

    def _refresh_process(self, paper_id: str) -> None:
        paper = self.service.database.get_paper(paper_id)
        jobs = [job for job in self.service.database.list_jobs() if job["paper_id"] == paper_id]
        job = jobs[0] if jobs else None
        self.paper_info.setText(
            f"<b>{paper['title']}</b><br>{paper['file_path']}<br>"
            f"SHA256: {paper['file_sha256']} · 解析器: {paper['parser_version'] or '等待处理'}"
        )
        if not job:
            return
        stage = JobStage(job["stage"])
        self.progress.setValue(job["progress"])
        self.current_item.setText(job["current_item"])
        current_index = STAGE_ORDER.index(stage) if stage in STAGE_ORDER else -1
        for index, value in enumerate(STAGE_ORDER):
            if stage == JobStage.FAILED:
                symbol = "×" if index == max(current_index, 0) else "·"
            elif index < current_index or stage == JobStage.COMPLETED:
                symbol = "✓"
            elif index == current_index:
                symbol = "●"
            else:
                symbol = "○"
            self.stage_widgets[value].setText(f"{symbol} {STAGE_LABELS[value]}")
        self.error_label.setText(job["error_message"] or "")
        pages = self.service.database.get_pages(paper_id)
        sections = self.service.database.get_sections(paper_id)
        segments = self.service.database.get_segments(paper_id)
        analyses = self.service.database.list_segment_analyses(paper_id)
        removed_count = sum(len(json.loads(page["removed_margin_json"])) for page in pages)
        self.metrics.setText(
            f"页面 {len(pages)} · 章节 {len(sections)} · 送入模型的分段 {len(segments)} · "
            f"已理解 {len(analyses)} · 已清理边缘重复块 {removed_count}"
        )

    def _refresh_content(self, paper_id: str, *, force: bool) -> None:
        pages = self.service.database.get_pages(paper_id)
        sections = self.service.database.get_sections(paper_id)
        segments = self.service.database.get_segments(paper_id)
        analyses = self.service.database.list_segment_analyses(paper_id)
        document = self.service.database.get_document_analysis(paper_id)
        signature = (
            paper_id,
            len(pages),
            len(sections),
            len(segments),
            len(analyses),
            bool(document),
        )
        if not force and signature == self._content_signature:
            return
        self._content_signature = signature
        paper = self.service.database.get_paper(paper_id)
        if paper:
            self.pdf_viewer.set_document(paper["file_path"], pages)
        self._populate_preprocess(pages, sections, segments)
        self._populate_segment_analyses(segments, analyses)
        self.document_text.setPlainText(
            self._format_document(document) if document else "等待全部分段完成后生成全文汇总。"
        )

    def _populate_preprocess(
        self, pages: list[dict[str, Any]], sections: list[dict[str, Any]], segments: list[Any]
    ) -> None:
        self.preprocess_tree.clear()
        pages_root = QTreeWidgetItem(["清洗后的页面", str(len(pages))])
        pages_root.setData(0, Qt.UserRole, ("root", "pages"))
        for page in pages:
            item = QTreeWidgetItem([f"第 {page['page_number']} 页", f"{len(page['cleaned_text'])} 字符"])
            item.setData(0, Qt.UserRole, ("page", page["page_number"]))
            pages_root.addChild(item)
        sections_root = QTreeWidgetItem(["识别出的章节", str(len(sections))])
        for section in sections:
            item = QTreeWidgetItem(
                [
                    section["title"],
                    f"第 {section['start_page']}-{section['end_page']} 页 · {len(section['text'])} 字符",
                ]
            )
            item.setData(0, Qt.UserRole, ("section", section["id"]))
            sections_root.addChild(item)
        segments_root = QTreeWidgetItem(["送入 DeepSeek 的分段", str(len(segments))])
        for segment in segments:
            item = QTreeWidgetItem(
                [
                    f"{segment.order_index + 1}. {segment.section_title}",
                    f"第 {segment.start_page}-{segment.end_page} 页 · {segment.char_count} 字符",
                ]
            )
            item.setData(0, Qt.UserRole, ("segment", segment.id))
            segments_root.addChild(item)
        self.preprocess_tree.addTopLevelItems([pages_root, sections_root, segments_root])
        self.preprocess_tree.expandAll()
        if pages_root.childCount():
            self.preprocess_tree.setCurrentItem(pages_root.child(0))

    def show_preprocess_item(self) -> None:
        item = self.preprocess_tree.currentItem()
        paper_id = self.paper_combo.currentData()
        if not item or not paper_id:
            return
        kind, identifier = item.data(0, Qt.UserRole) or (None, None)
        if kind == "page":
            page = next(
                value
                for value in self.service.database.get_pages(paper_id)
                if value["page_number"] == identifier
            )
            removed = json.loads(page["removed_margin_json"])
            prefix = (
                f"已移除页眉/页脚：{removed or '无'}\n"
                f"needs_ocr={bool(page['needs_ocr'])} · 图片块={page['image_count']}\n\n"
            )
            self.preprocess_text.setPlainText(prefix + page["cleaned_text"])
            self.pdf_viewer.go_to_page(page["page_number"])
        elif kind == "section":
            section = next(
                value
                for value in self.service.database.get_sections(paper_id)
                if value["id"] == identifier
            )
            self.preprocess_text.setPlainText(section["text"] or "此项是父章节标题，没有独立正文。")
            self.pdf_viewer.go_to_page(section["start_page"])
        elif kind == "segment":
            segment = next(
                value
                for value in self.service.database.get_segments(paper_id)
                if value.id == identifier
            )
            self.preprocess_text.setPlainText(segment.text)
            self.pdf_viewer.go_to_page(segment.start_page)

    def _populate_segment_analyses(
        self, segments: list[Any], analyses: list[SegmentUnderstanding]
    ) -> None:
        current = (
            self.segment_list.currentItem().data(Qt.UserRole)
            if self.segment_list.currentItem()
            else None
        )
        by_id = {value.segment_id: value for value in analyses}
        self.segment_list.clear()
        for segment in segments:
            mark = "✓" if segment.id in by_id else "○"
            item = self._list_item(
                f"{mark} {segment.order_index + 1}. {segment.section_title}\n"
                f"第 {segment.start_page}-{segment.end_page} 页"
            )
            item.setData(Qt.UserRole, segment.id)
            self.segment_list.addItem(item)
        if current:
            for index in range(self.segment_list.count()):
                if self.segment_list.item(index).data(Qt.UserRole) == current:
                    self.segment_list.setCurrentRow(index)
                    break
        elif self.segment_list.count():
            self.segment_list.setCurrentRow(0)

    @staticmethod
    def _list_item(text: str) -> Any:
        from PySide6.QtWidgets import QListWidgetItem

        return QListWidgetItem(text)

    def show_segment_analysis(self) -> None:
        item = self.segment_list.currentItem()
        if not item:
            return
        segment_id = item.data(Qt.UserRole)
        paper_id = self.paper_combo.currentData()
        if paper_id:
            segment = next(
                (
                    value
                    for value in self.service.database.get_segments(paper_id)
                    if value.id == segment_id
                ),
                None,
            )
            if segment:
                self.pdf_viewer.go_to_page(segment.start_page)
        value = self.service.database.get_segment_analysis(segment_id)
        if not value:
            self.segment_text.setPlainText("该分段尚未完成理解。")
            return
        lines = [
            f"章节：{value.section_title}",
            f"页码：{value.start_page}-{value.end_page}",
            "",
            f"分段摘要：{value.segment_summary}",
            f"在论文中的作用：{value.role_in_paper}",
            "",
            "关键点：\n- " + "\n- ".join(value.key_points),
            "方法：\n- " + ("\n- ".join(value.methods) if value.methods else "未识别"),
            "数据与结果：\n- "
            + ("\n- ".join(value.data_and_results) if value.data_and_results else "未识别"),
            "概念：\n- " + ("\n- ".join(value.concepts) if value.concepts else "未识别"),
            "不确定项：\n- "
            + ("\n- ".join(value.uncertainties) if value.uncertainties else "无"),
            "",
            "证据：",
        ]
        lines.extend(
            f"- 第 {evidence.page} 页 · {evidence.claim}\n  {evidence.quote}"
            for evidence in value.evidence
        )
        self.segment_text.setPlainText("\n".join(lines))

    @staticmethod
    def _format_document(value: DocumentUnderstanding) -> str:
        lines = [
            value.title,
            "=" * len(value.title),
            "",
            f"一句话总结：{value.one_sentence_summary}",
            f"研究问题：{value.research_problem}",
            f"背景：{value.background}",
            f"方法路线：{value.approach}",
            f"数据集：{', '.join(value.datasets) if value.datasets else '未说明'}",
            f"实验设计：{value.experiment_design}",
            "",
            "主要发现：\n- " + "\n- ".join(value.main_findings),
            "贡献：\n- " + "\n- ".join(value.contributions),
            "局限：\n- " + "\n- ".join(value.limitations),
            "后续工作：\n- " + "\n- ".join(value.future_work),
            "",
            "章节摘要：",
        ]
        lines.extend(
            f"- {digest.section_title}（第 {digest.pages} 页）：{digest.summary}"
            for digest in value.section_digests
        )
        lines.append("\n全文证据：")
        lines.extend(
            f"- 第 {evidence.page} 页 · {evidence.claim}\n  {evidence.quote}"
            for evidence in value.evidence
        )
        return "\n".join(lines)

    def closeEvent(self, event: Any) -> None:
        self.timer.stop()
        self.pdf_viewer.close_document()
        self.service.shutdown()
        super().closeEvent(event)


def run_desktop(service: PaperService) -> int:
    app = QApplication.instance() or QApplication([])
    app.setFont(QFont("Microsoft YaHei UI", 10))
    window = MainWindow(service)
    window.show()
    return app.exec()
