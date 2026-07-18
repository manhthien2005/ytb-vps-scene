from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import (
    CoordinateTransform,
    OcrDetection,
    OcrProviderReport,
    require_cuda_provider,
)


class OcrContractTests(unittest.TestCase):
    def test_transform_maps_crop_coordinates_to_canonical_frame(self) -> None:
        transform = CoordinateTransform(
            x_offset=Fraction(10),
            y_offset=Fraction(200),
            x_scale=Fraction(2),
            y_scale=Fraction(3),
        )
        self.assertEqual(
            transform.box((1, 2, 11, 12), width=100, height=500),
            BoundingBox(12, 206, 32, 236),
        )

    def test_detection_requires_frame_text_box_and_bounded_confidence(self) -> None:
        detection = OcrDetection(
            frame_index=12,
            box=BoundingBox(1, 2, 10, 20),
            text="字幕",
            confidence=Fraction(9, 10),
        )
        self.assertEqual(detection.confidence, Fraction(9, 10))
        with self.assertRaises(DomainInvariantError):
            OcrDetection(0, BoundingBox(1, 2, 10, 20), " ", Fraction(1, 2))
        with self.assertRaises(DomainInvariantError):
            OcrDetection(-1, BoundingBox(1, 2, 10, 20), "x", Fraction(1, 2))
        with self.assertRaises(DomainInvariantError):
            OcrDetection(1, BoundingBox(1, 2, 10, 20), "x", Fraction(11, 10))

    def test_onnx_report_rejects_cpu_fallback(self) -> None:
        report = OcrProviderReport(
            backend="onnx",
            providers=("CPUExecutionProvider",),
            model_revision="r1",
        )
        with self.assertRaisesRegex(RuntimeError, "CUDAExecutionProvider"):
            require_cuda_provider(report)

    def test_onnx_report_accepts_cuda_as_first_provider(self) -> None:
        report = OcrProviderReport(
            backend="onnx",
            providers=("CUDAExecutionProvider", "CPUExecutionProvider"),
            model_revision="r1",
        )
        self.assertIsNone(require_cuda_provider(report))
