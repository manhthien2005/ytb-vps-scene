from __future__ import annotations

import importlib
import sys
import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.stream import RawFrame
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import CoordinateTransform, OcrDetection
from ytb_vps_v2.ports.pipeline import ProviderError


class _Session:
    def __init__(self, providers=("CUDAExecutionProvider",)) -> None:
        self._providers = providers

    def get_providers(self):
        return list(self._providers)


class _Stage:
    def __init__(self, providers=("CUDAExecutionProvider",)) -> None:
        self.session = type("Wrapped", (), {"session": _Session(providers)})()


class _Result:
    boxes = (((1, 2), (11, 2), (11, 12), (1, 12)), ((0, 0), (1, 0), (1, 1), (0, 1)))
    txts = ("字幕", " ")
    scores = (0.9, 1.0)


class _Engine:
    def __init__(self, providers=("CUDAExecutionProvider",)) -> None:
        self.text_det = _Stage(providers)
        self.text_rec = _Stage(providers)
        self.inputs = []

    def __call__(self, image):
        self.inputs.append(image)
        return _Result()


class OnnxDetectorTests(unittest.TestCase):
    def test_import_is_lazy_for_optional_runtime(self) -> None:
        before = {name: name in sys.modules for name in ("numpy", "rapidocr", "onnxruntime")}
        module = importlib.import_module("ytb_vps_v2.adapters.ocr.onnx_detector")
        self.assertIsNotNone(module)
        self.assertEqual(before, {name: name in sys.modules for name in before})

    def test_result_conversion_maps_coordinates_and_filters_blank_text(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx_detector import convert_rapidocr_result

        self.assertEqual(
            convert_rapidocr_result(
                _Result(),
                frame_index=7,
                width=100,
                height=500,
                transform=CoordinateTransform(
                    x_offset=Fraction(10),
                    y_offset=Fraction(20),
                    x_scale=Fraction(2),
                    y_scale=Fraction(3),
                ),
                minimum_confidence=Fraction(1, 2),
            ),
            (OcrDetection(7, BoundingBox(12, 26, 32, 56), "字幕", Fraction(9, 10)),),
        )

    def test_detector_decodes_crop_calls_engine_and_returns_canonical_detection(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx_detector import RapidOcrOnnxDetector

        engine = _Engine()
        decoded = []

        def decoder(frame, width, height, y0, y1):
            decoded.append((frame, width, height, y0, y1))
            return "cropped-image"

        detector = RapidOcrOnnxDetector(
            width=100,
            height=50,
            engine=engine,
            decoder=decoder,
            crop_min_y=Fraction(1, 2),
            crop_max_y=Fraction(1),
            minimum_confidence=Fraction(1, 2),
        )
        detections = detector(RawFrame(3, b"x" * (100 * 50 * 3), "BGR"))
        self.assertEqual(decoded[0][3:], (25, 50))
        self.assertEqual(engine.inputs, ["cropped-image"])
        self.assertEqual(detections[0].frame_index, 3)
        self.assertEqual(detections[0].box, BoundingBox(1, 27, 11, 37))

    def test_cpu_session_is_a_hard_provider_error(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx_detector import RapidOcrOnnxDetector

        with self.assertRaisesRegex(ProviderError, "CUDAExecutionProvider"):
            RapidOcrOnnxDetector(
                width=10,
                height=10,
                engine=_Engine(("CPUExecutionProvider",)),
                decoder=lambda *args: object(),
            )


if __name__ == "__main__":
    unittest.main()
