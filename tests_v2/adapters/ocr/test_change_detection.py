from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.change_detection import (
    ChangeDetectionPolicy,
    FrameDetections,
    process_frames,
)
from ytb_vps_v2.adapters.ocr.stream import RawFrame
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import OcrDetection


def _detection(frame: int, text: str) -> OcrDetection:
    return OcrDetection(frame, BoundingBox(0, 0, 2, 2), text, Fraction(1, 1))


class ChangeDetectionTests(unittest.TestCase):
    def test_unchanged_frames_reemit_without_ocr_and_reindex(self) -> None:
        frames = tuple(
            RawFrame(index, bytes([value]) * 6, "RGB")
            for index, value in enumerate((0, 0, 0, 9, 9))
        )
        calls: list[int] = []

        def detect(frame: RawFrame):
            calls.append(frame.frame_index)
            return (_detection(frame.frame_index, "A" if frame.data[0] == 0 else "B"),)

        output = process_frames(
            frames,
            detect,
            ChangeDetectionPolicy(enabled=True, threshold=Fraction(1)),
        )
        self.assertEqual(calls, [0, 3])
        self.assertEqual([item.frame_index for item in output], [0, 1, 2, 3, 4])
        self.assertEqual([item.detections[0].frame_index for item in output], [0, 1, 2, 3, 4])
        self.assertEqual([item.detections[0].text for item in output], ["A", "A", "A", "B", "B"])

    def test_disabled_mode_calls_ocr_for_every_frame(self) -> None:
        frames = tuple(RawFrame(index, bytes([index]) * 3, "RGB") for index in range(3))
        calls: list[int] = []
        output = process_frames(
            frames,
            lambda frame: calls.append(frame.frame_index) or (),
            ChangeDetectionPolicy(enabled=False, threshold=Fraction(1)),
        )
        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(tuple(item.detections for item in output), ((), (), ()))

    def test_empty_previous_detection_stays_empty_on_reemit(self) -> None:
        frames = (RawFrame(0, b"aaa", "RGB"), RawFrame(1, b"aaa", "RGB"))
        calls: list[int] = []
        output = process_frames(
            frames,
            lambda frame: calls.append(frame.frame_index) or (),
            ChangeDetectionPolicy(enabled=True, threshold=Fraction(1)),
        )
        self.assertEqual(calls, [0])
        self.assertEqual(output, (FrameDetections(0, ()), FrameDetections(1, ())))

    def test_policy_and_frame_validation(self) -> None:
        with self.assertRaises(ValueError):
            ChangeDetectionPolicy(enabled=True, threshold=Fraction(-1))
        with self.assertRaises(ValueError):
            ChangeDetectionPolicy(enabled=True, threshold=Fraction(256))
        with self.assertRaises(ValueError):
            process_frames(
                (RawFrame(0, b"a", "RGB"), RawFrame(1, b"bb", "RGB")),
                lambda frame: (),
                ChangeDetectionPolicy(),
            )


if __name__ == "__main__":
    unittest.main()
