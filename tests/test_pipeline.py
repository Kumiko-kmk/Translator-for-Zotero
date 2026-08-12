from paper_assistant.ai import MockDeepSeekClient
from paper_assistant.models import JobStage
from paper_assistant.pipeline import PaperService


class CountingMockClient(MockDeepSeekClient):
    def __init__(self) -> None:
        self.segment_calls = 0
        self.synthesis_calls = 0

    def understand_segment(self, paper_title, segment):
        self.segment_calls += 1
        return super().understand_segment(paper_title, segment)

    def synthesize_document(self, paper_title, segments):
        self.synthesis_calls += 1
        return super().synthesize_document(paper_title, segments)


class FailOnThirdClient(CountingMockClient):
    def understand_segment(self, paper_title, segment):
        if self.segment_calls == 2:
            self.segment_calls += 1
            raise RuntimeError("intentional segment failure")
        return super().understand_segment(paper_title, segment)


def test_real_pdf_runs_extract_segment_understand_synthesize_pipeline(app_config, real_pdf) -> None:
    client = CountingMockClient()
    service = PaperService(app_config, client=client)
    result = service.import_pdf(real_pdf, background=False)
    paper_id = result["paper"]["id"]
    job = service.database.get_job(result["job"]["id"])
    segments = service.database.get_segments(paper_id)

    assert job["stage"] == JobStage.COMPLETED.value
    assert result["paper"]["title"] == "Deep Sparse Rectifier Neural Networks"
    assert len(service.database.get_pages(paper_id)) == 9
    assert 8 <= len(segments) <= 12
    assert client.segment_calls == len(segments)
    assert client.synthesis_calls == 1
    assert len(service.database.list_segment_analyses(paper_id)) == len(segments)
    assert service.database.get_document_analysis(paper_id) is not None

    duplicate = service.import_pdf(real_pdf, background=False)
    assert duplicate["duplicate"] is True
    assert client.segment_calls == len(segments)
    service.shutdown()


def test_failed_segment_job_resumes_without_repeating_completed_segments(
    app_config, layout_pdf
) -> None:
    failing = FailOnThirdClient()
    service = PaperService(app_config, client=failing)
    result = service.import_pdf(layout_pdf, background=False)
    paper_id = result["paper"]["id"]
    job_id = result["job"]["id"]
    assert service.database.get_job(job_id)["stage"] == JobStage.FAILED.value
    completed_before_retry = len(service.database.list_segment_analyses(paper_id))
    assert completed_before_retry == 2

    resumed = CountingMockClient()
    service.client = resumed
    service.resume(job_id).result(timeout=10)
    total = len(service.database.get_segments(paper_id))
    assert service.database.get_job(job_id)["stage"] == JobStage.COMPLETED.value
    assert resumed.segment_calls == total - completed_before_retry
    assert resumed.synthesis_calls == 1
    service.shutdown()
