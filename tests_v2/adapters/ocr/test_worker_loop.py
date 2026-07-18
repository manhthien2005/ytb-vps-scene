from __future__ import annotations

import io
import json
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from ytb_vps_v2.adapters.ocr.change_detection import ChangeDetectionPolicy
from ytb_vps_v2.adapters.ocr.worker_loop import WorkerSummary, run_worker_loop
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import OcrDetection


class WorkerLoopTests(unittest.TestCase):
    def test_fake_engine_reemits_and_preserves_progress_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "ocr.jsonl"
            calls: list[int] = []
            messages: list[str] = []

            def detector(frame):
                calls.append(frame.frame_index)
                text = "A" if frame.data[0] == 0 else "B"
                return (
                    OcrDetection(
                        frame.frame_index,
                        BoundingBox(0, 0, 1, 1),
                        text,
                        Fraction(1),
                    ),
                )

            summary = run_worker_loop(
                io.BytesIO(bytes([0]) * 3 * 3 + bytes([9]) * 3 * 2),
                output,
                detector,
                width=1,
                height=1,
                channel_order="RGB",
                start_frame=10,
                frame_step=2,
                expected_frames=5,
                policy=ChangeDetectionPolicy(threshold=Fraction(1)),
                progress=messages.append,
            )

            self.assertEqual(calls, [10, 16])
            self.assertEqual(summary, WorkerSummary(5, 5))
            self.assertEqual(messages, ["OCR_PROGRESS 1 5 1", "OCR_PROGRESS 5 5 5", "OCR_DONE 5 5"])
            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["frame_index"] for row in rows], [10, 12, 14, 16, 18])
            self.assertEqual([row["text"] for row in rows], ["A", "A", "A", "B", "B"])

    def test_failure_keeps_existing_output_and_emits_no_done(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "ocr.jsonl"
            output.write_bytes(b"keep")
            messages: list[str] = []
            with self.assertRaisesRegex(ValueError, "truncated"):
                run_worker_loop(
                    io.BytesIO(b"ab"),
                    output,
                    lambda frame: (),
                    width=1,
                    height=1,
                    channel_order="BGR",
                    start_frame=0,
                    frame_step=1,
                    expected_frames=1,
                    progress=messages.append,
                )
            self.assertEqual(output.read_bytes(), b"keep")
            self.assertFalse(any(message.startswith("OCR_DONE") for message in messages))


if __name__ == "__main__":
    unittest.main()
