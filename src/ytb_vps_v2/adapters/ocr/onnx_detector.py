from __future__ import annotations

import importlib
import math
from collections.abc import Callable
from fractions import Fraction
from typing import Any

from ytb_vps_v2.adapters.ocr.stream import RawFrame
from ytb_vps_v2.ports.ocr import CoordinateTransform, OcrDetection
from ytb_vps_v2.ports.pipeline import ProviderError


_DEFAULT_ENGINE_PARAMS: dict[str, object] = {
    "Global.use_cls": False,
    "EngineConfig.onnxruntime.use_cuda": True,
    "EngineConfig.onnxruntime.cuda_ep_cfg.device_id": 0,
}


def _active_providers(engine: Any) -> tuple[tuple[str, ...], tuple[str, ...]]:
    try:
        detection = tuple(engine.text_det.session.session.get_providers())
        recognition = tuple(engine.text_rec.session.session.get_providers())
    except (AttributeError, TypeError) as exc:
        raise ProviderError("RapidOCR engine does not expose active sessions") from exc
    for providers in (detection, recognition):
        if not providers or providers[0] != "CUDAExecutionProvider":
            raise ProviderError(
                "RapidOCR sessions must start with CUDAExecutionProvider"
            )
    return detection, recognition


def convert_rapidocr_result(
    result: Any,
    *,
    frame_index: int,
    width: int,
    height: int,
    transform: CoordinateTransform,
    minimum_confidence: Fraction,
) -> tuple[OcrDetection, ...]:
    if result is None:
        return ()
    try:
        boxes = result.boxes
        texts = result.txts
        scores = result.scores
    except AttributeError as exc:
        raise ProviderError("RapidOCR result does not match the provider contract") from exc
    if boxes is None or texts is None:
        return ()
    if scores is None:
        scores = (0,) * len(texts)
    if not (len(boxes) == len(texts) == len(scores)):
        raise ProviderError("RapidOCR result lengths are inconsistent")
    detections: list[OcrDetection] = []
    for points, text, score in zip(boxes, texts, scores):
        value = str(text).strip()
        if not value:
            continue
        try:
            confidence = Fraction(str(score))
            if not math.isfinite(float(confidence)) or not 0 <= confidence <= 1:
                raise ValueError("confidence")
            if confidence < minimum_confidence:
                continue
            xs = tuple(float(point[0]) for point in points)
            ys = tuple(float(point[1]) for point in points)
            if len(xs) < 2 or any(not math.isfinite(item) for item in (*xs, *ys)):
                raise ValueError("points")
            raw_box = (
                math.floor(min(xs)),
                math.floor(min(ys)),
                math.ceil(max(xs)),
                math.ceil(max(ys)),
            )
            box = transform.box(raw_box, width=width, height=height)
            detections.append(OcrDetection(frame_index, box, value, confidence))
        except (IndexError, TypeError, ValueError, ZeroDivisionError) as exc:
            raise ProviderError("RapidOCR detection is malformed") from exc
    return tuple(detections)


class RapidOcrOnnxDetector:
    def __init__(
        self,
        *,
        width: int,
        height: int,
        engine: Any | None = None,
        decoder: Callable[[RawFrame, int, int, int, int], Any] | None = None,
        crop_min_y: Fraction = Fraction(1, 2),
        crop_max_y: Fraction = Fraction(98, 100),
        minimum_confidence: Fraction = Fraction(55, 100),
        transform: CoordinateTransform | None = None,
        engine_params: dict[str, object] | None = None,
    ) -> None:
        if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
            raise ProviderError("ONNX detector dimensions must be positive integers")
        if (
            type(crop_min_y) is not Fraction
            or type(crop_max_y) is not Fraction
            or not 0 <= crop_min_y < crop_max_y <= 1
        ):
            raise ProviderError("ONNX crop ratios are invalid")
        if type(minimum_confidence) is not Fraction or not 0 <= minimum_confidence <= 1:
            raise ProviderError("ONNX minimum confidence is invalid")
        self.width = width
        self.height = height
        self.y0 = max(0, min(height - 1, int(height * crop_min_y)))
        self.y1 = max(self.y0 + 1, min(height, int(height * crop_max_y)))
        self.minimum_confidence = minimum_confidence
        if transform is not None and type(transform) is not CoordinateTransform:
            raise ProviderError("ONNX coordinate transform is invalid")
        self.transform = transform or CoordinateTransform(y_offset=Fraction(self.y0))
        self._engine = engine
        self._decoder = decoder
        self._engine_params = dict(_DEFAULT_ENGINE_PARAMS)
        self._engine_params.update(engine_params or {})
        if engine is not None:
            _active_providers(engine)

    def _load_engine(self) -> Any:
        if self._engine is None:
            try:
                rapidocr = importlib.import_module("rapidocr")
                self._engine = rapidocr.RapidOCR(params=self._engine_params)
            except ModuleNotFoundError as exc:
                raise ProviderError("rapidocr is not installed") from exc
            except Exception as exc:
                raise ProviderError(f"RapidOCR initialization failed: {exc}") from exc
            _active_providers(self._engine)
        return self._engine

    def _decode(self, frame: RawFrame) -> Any:
        if self._decoder is not None:
            return self._decoder(frame, self.width, self.height, self.y0, self.y1)
        try:
            numpy = importlib.import_module("numpy")
            image = numpy.frombuffer(frame.data, dtype=numpy.uint8).reshape(
                (self.height, self.width, 3)
            )
            return image[self.y0 : self.y1, :, :]
        except ModuleNotFoundError as exc:
            raise ProviderError("numpy is not installed") from exc
        except Exception as exc:
            raise ProviderError(f"ONNX frame decode failed: {exc}") from exc

    def __call__(self, frame: RawFrame) -> tuple[OcrDetection, ...]:
        if type(frame) is not RawFrame:
            raise ProviderError("ONNX detector input must be RawFrame")
        expected = self.width * self.height * 3
        if len(frame.data) != expected:
            raise ProviderError("ONNX detector frame byte length is invalid")
        try:
            result = self._load_engine()(self._decode(frame))
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(f"RapidOCR inference failed: {exc}") from exc
        return convert_rapidocr_result(
            result,
            frame_index=frame.frame_index,
            width=self.width,
            height=self.height,
            transform=self.transform,
            minimum_confidence=self.minimum_confidence,
        )
