from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.stream import RawFrame
from ytb_vps_v2.ports.ocr import OcrDetection

try:  # numpy is pinned in the OCR worker image; the pure-Python path is the fallback.
    import numpy as _numpy
except ImportError:  # pragma: no cover - exercised only on hosts without numpy
    _numpy = None


@dataclass(frozen=True, slots=True)
class ChangeDetectionPolicy:
    enabled: bool = True
    threshold: Fraction = Fraction(8)

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise ValueError("change detection enabled must be boolean")
        if type(self.threshold) is not Fraction or not 0 <= self.threshold <= 255:
            raise ValueError("change detection threshold must be Fraction in [0, 255]")


@dataclass(frozen=True, slots=True)
class FrameDetections:
    frame_index: int
    detections: tuple[OcrDetection, ...]

    def __post_init__(self) -> None:
        if type(self.frame_index) is not int or self.frame_index < 0:
            raise ValueError("frame detection index must be non-negative")
        if type(self.detections) is not tuple or any(
            type(item) is not OcrDetection for item in self.detections
        ):
            raise ValueError("frame detections must contain OcrDetection values")


def _difference(previous: bytes, current: bytes) -> Fraction:
    if len(previous) != len(current):
        raise ValueError("change detection frames must have equal byte length")
    if not previous:
        raise ValueError("change detection frames must not be empty")
    if _numpy is not None:
        # ~100x faster than the interpreter loop; this runs for EVERY frame, so the
        # pure-Python version cost seconds per job at canonical resolution.
        left = _numpy.frombuffer(previous, dtype=_numpy.uint8).astype(_numpy.int32)
        right = _numpy.frombuffer(current, dtype=_numpy.uint8).astype(_numpy.int32)
        return Fraction(int(_numpy.abs(left - right).sum()), len(previous))
    return Fraction(sum(abs(left - right) for left, right in zip(previous, current)), len(previous))


def process_frames(
    frames: Iterable[RawFrame],
    detect: Callable[[RawFrame], Iterable[OcrDetection]],
    policy: ChangeDetectionPolicy = ChangeDetectionPolicy(),
) -> tuple[FrameDetections, ...]:
    return tuple(iter_processed_frames(frames, detect, policy))


def iter_processed_frames(
    frames: Iterable[RawFrame],
    detect: Callable[[RawFrame], Iterable[OcrDetection]],
    policy: ChangeDetectionPolicy = ChangeDetectionPolicy(),
) -> Iterable[FrameDetections]:
    if not callable(detect):
        raise ValueError("OCR detector must be callable")
    previous: RawFrame | None = None
    previous_detections: tuple[OcrDetection, ...] = ()
    for frame in frames:
        if type(frame) is not RawFrame:
            raise ValueError("change detection input must contain RawFrame values")
        should_detect = (
            previous is None
            or not policy.enabled
            or _difference(previous.data, frame.data) > policy.threshold
        )
        if should_detect:
            detections = tuple(detect(frame))
            if any(type(item) is not OcrDetection for item in detections):
                raise ValueError("OCR detector returned invalid detections")
            previous_detections = detections
        else:
            previous_detections = tuple(
                replace(item, frame_index=frame.frame_index)
                for item in previous_detections
            )
        yield FrameDetections(frame.frame_index, previous_detections)
        previous = frame
