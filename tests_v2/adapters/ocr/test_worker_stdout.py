from __future__ import annotations

import io
import json
import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.change_detection import ChangeDetectionPolicy
from ytb_vps_v2.adapters.ocr.worker_stdout import run_stdout_worker_loop
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import OcrDetection


class WorkerStdoutTests(unittest.TestCase):
    def test_stdout_contains_only_jsonl_and_progress_is_separate(self) -> None:
        output = io.StringIO()
        progress: list[str] = []

        def detector(frame):
            return (OcrDetection(frame.frame_index, BoundingBox(0, 0, 1, 1), "x", Fraction(1)),)

        summary = run_stdout_worker_loop(
            io.BytesIO(b"abc" * 2), output, detector,
            width=1, height=1, channel_order="RGB", start_frame=0, frame_step=1,
            expected_frames=2, policy=ChangeDetectionPolicy(enabled=False),
            progress=progress.append,
        )
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(summary.frames, 2)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("OCR_" not in line for line in output.getvalue().splitlines()))
        self.assertEqual(progress[-1], "OCR_DONE 2 2")

