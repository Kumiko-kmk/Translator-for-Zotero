import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from paper_assistant.ai import MockDeepSeekClient
from paper_assistant.pipeline import PaperService
from paper_assistant.ui import MainWindow


APP = QApplication.instance() or QApplication([])


def test_three_pane_window_starts(app_config) -> None:
    service = PaperService(app_config, client=MockDeepSeekClient())
    window = MainWindow(service)
    assert window.main_splitter.count() == 3
    assert [window.left_tabs.tabText(index) for index in range(2)] == [
        "处理流程",
        "预处理预览",
    ]
    assert [window.right_tabs.tabText(index) for index in range(2)] == [
        "逐段理解",
        "全文汇总",
    ]
    window.show()
    APP.processEvents()
    window.timer.stop()
    window.close()
    window.deleteLater()
    APP.processEvents()


def test_pdf_reader_renders_detected_blocks(app_config, layout_pdf) -> None:
    service = PaperService(app_config, client=MockDeepSeekClient())
    result = service.import_pdf(layout_pdf, background=False)
    window = MainWindow(service)
    window.show()
    APP.processEvents()

    assert result["duplicate"] is False
    assert window.pdf_viewer.page_count == 3
    assert window.pdf_viewer.current_page == 1
    assert window.pdf_viewer.highlight_count > 0
    assert all(item.brush().color().alpha() > 0 for item in window.pdf_viewer.highlight_items)

    window.pdf_viewer.go_to_page(2)
    APP.processEvents()
    assert window.pdf_viewer.current_page == 2
    assert window.pdf_viewer.highlight_count > 0

    window.timer.stop()
    window.close()
    window.deleteLater()
    APP.processEvents()
