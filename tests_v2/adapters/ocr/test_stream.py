from __future__ import annotations

import io
import json
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from ytb_vps_v2.adapters.ocr.stream import (
    RawFrame,
    iter_raw_frames,
    parse_worker_jsonl,
    write_canonical_jsonl,
)
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import CoordinateTransform, OcrDetection


class OcrStreamTests(unittest.TestCase):
    def test_raw_frames_are_bounded_and_source_indexed(self) -> None:
        frame_size = 2 * 1 * 3
        raw = b"abcdef" + b"ghijkl" + b"mnopqr"
        frames = list(
            iter_raw_frames(
                io.BytesIO(raw),
                width=2,
                height=1,
                channel_order="BGR",
                start_frame=10,
                frame_step=2,
                expected_frames=3,
            )
        )
        self.assertEqual(
            frames,
            [
                RawFrame(10, raw[:frame_size], "BGR"),
                RawFrame(12, raw[frame_size : 2 * frame_size], "BGR"),
                RawFrame(14, raw[2 * frame_size :], "BGR"),
            ],
        )

    def test_raw_frames_reject_truncation_and_overlong_stream(self) -> None:
        with self.assertRaisesRegex(ValueError, "truncated"):
            list(
                iter_raw_frames(
                    io.BytesIO(b"abcde"),
                    width=2,
                    height=1,
                    channel_order="RGB",
                    start_frame=0,
                    frame_step=1,
                    expected_frames=1,
                )
            )
        with self.assertRaisesRegex(ValueError, "overlong"):
            list(
                iter_raw_frames(
                    io.BytesIO(b"abcdef" * 2),
                    width=2,
                    height=1,
                    channel_order="RGB",
                    start_frame=0,
                    frame_step=1,
                    expected_frames=1,
                )
            )

    def test_frame_count_tolerance_allows_bounded_difference(self) -> None:
        frames = list(
            iter_raw_frames(
                io.BytesIO(b"abcdef" * 2),
                width=2,
                height=1,
                channel_order="RGB",
                start_frame=0,
                frame_step=1,
                expected_frames=3,
                frame_tolerance=1,
            )
        )
        self.assertEqual(len(frames), 2)

    def test_worker_jsonl_maps_crop_box_and_fraction_confidence(self) -> None:
        transform = CoordinateTransform(
            x_offset=Fraction(10), y_offset=Fraction(20), x_scale=Fraction(2), y_scale=Fraction(3)
        )
        raw = json.dumps(
            {"frame_index": 1, "box": [1, 2, 11, 12], "text": "字幕", "confidence": 0.9},
            separators=(",", ":"),
        )
        detections = parse_worker_jsonl(
            raw + "\n",
            width=100,
            height=500,
            start_frame=10,
            frame_step=2,
            transform=transform,
            expected_frames=3,
        )
        self.assertEqual(
            detections,
            (
                OcrDetection(
                    12,
                    BoundingBox(12, 26, 32, 56),
                    "字幕",
                    Fraction(9, 10),
                ),
            ),
        )

    def test_worker_jsonl_rejects_unknown_or_unsafe_records(self) -> None:
        transform = CoordinateTransform()
        common = {"frame_index": 0, "box": [0, 0, 2, 2], "text": "x", "confidence": 0.5}
        for record in (
            {**common, "extra": 1},
            {**common, "confidence": float("nan")},
            {**common, "box": [0, 0, 1]},
            {**common, "frame_index": -1},
        ):
            with self.subTest(record=record), self.assertRaises(ValueError):
                parse_worker_jsonl(
                    json.dumps(record, allow_nan=True) + "\n",
                    width=10,
                    height=10,
                    start_frame=0,
                    frame_step=1,
                    transform=transform,
                )

    def test_canonical_jsonl_is_sorted_and_atomically_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "detections.jsonl"
            target.write_bytes(b"old")
            detections = [
                OcrDetection(2, BoundingBox(1, 1, 2, 2), "b", Fraction(1, 2)),
                OcrDetection(1, BoundingBox(0, 0, 1, 1), "a", Fraction(9, 10)),
            ]
            write_canonical_jsonl(target, detections)
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                '{"box":[0,0,1,1],"confidence":"9/10","frame_index":1,"text":"a"}\n'
                '{"box":[1,1,2,2],"confidence":"1/2","frame_index":2,"text":"b"}\n',
            )

    def test_canonical_jsonl_failure_leaves_existing_target_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "detections.jsonl"
            target.write_bytes(b"keep")

            def broken():
                yield OcrDetection(0, BoundingBox(0, 0, 1, 1), "x", Fraction(1, 2))
                raise RuntimeError("boom")

            with self.assertRaisesRegex(RuntimeError, "boom"):
                write_canonical_jsonl(target, broken())
            self.assertEqual(target.read_bytes(), b"keep")
            self.assertEqual(list(Path(directory).glob("*.part")), [])


if __name__ == "__main__":
    unittest.main()
