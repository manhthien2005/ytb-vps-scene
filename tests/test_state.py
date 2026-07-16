from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ytb_vps.state import JobStore
from ytb_vps.util import sha256_file


class StateTests(unittest.TestCase):
    def test_processing_config_change_invalidates_completed_work(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = root / "job.sqlite"
            with JobStore(database) as store:
                common = {
                    "job_id": "job",
                    "input_path": root / "input.mp4",
                    "source_signature": "abc",
                    "output_path": root / "output.mp4",
                }
                store.initialize_job(**common, config_signature="cfg-1")
                store.start_stage("job", "INGEST")
                store.complete_stage("job", "INGEST")
                store.plan_chunks(
                    "job",
                    "ocr",
                    [{"index": 0, "start_frame": 0, "end_frame": 30, "start_seconds": 0.0, "end_seconds": 1.0}],
                )
                store.initialize_job(**common, config_signature="cfg-2")
                self.assertEqual(store.stage_status("job", "INGEST"), "PENDING")
                self.assertEqual(store.chunks("job", "ocr"), [])
                self.assertEqual(store.job("job")["config_signature"], "cfg-2")

    def test_running_units_recover_to_pending(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = root / "job.sqlite"
            with JobStore(database) as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                store.plan_chunks(
                    "job",
                    "ocr",
                    [
                        {
                            "index": 0,
                            "start_frame": 0,
                            "end_frame": 60,
                            "start_seconds": 0.0,
                            "end_seconds": 2.0,
                        }
                    ],
                )
                store.start_stage("job", "OCR")
                store.start_chunk("job", "ocr", 0)

            with JobStore(database) as store:
                store.recover_stale("job")
                self.assertEqual(store.stage_status("job", "OCR"), "PENDING")
                self.assertEqual(store.chunks("job", "ocr")[0]["status"], "PENDING")
                self.assertEqual(store.job("job")["status"], "PENDING")

    def test_artifact_and_detection_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            artifact = root / "chunk.jsonl"
            artifact.write_text("{}\n", encoding="utf-8")
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                store.plan_chunks(
                    "job",
                    "ocr",
                    [{"index": 0, "start_frame": 0, "end_frame": 1, "start_seconds": 0.0, "end_seconds": 1 / 30}],
                )
                store.replace_chunk_detections(
                    "job",
                    0,
                    [{"frame_index": 0, "line_index": 0, "box": [1, 2, 3, 4], "text": "你好", "confidence": 0.9}],
                )
                store.complete_chunk(
                    "job",
                    "ocr",
                    0,
                    artifact_path=artifact,
                    checksum=sha256_file(artifact),
                    metadata={"detections": 1},
                )
                self.assertEqual(len(list(store.iter_detections("job"))), 1)
                self.assertEqual(store.chunks("job", "ocr")[0]["status"], "DONE")


if __name__ == "__main__":
    unittest.main()
