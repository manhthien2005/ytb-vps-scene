from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Iterable, Protocol, runtime_checkable

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox


def _fraction(name: str, value: object) -> Fraction:
    if type(value) is not Fraction:
        raise DomainInvariantError(f"{name} must be Fraction")
    return value


@dataclass(frozen=True, slots=True)
class CoordinateTransform:
    """Map provider crop coordinates into canonical source-frame coordinates."""

    x_offset: Fraction = Fraction(0)
    y_offset: Fraction = Fraction(0)
    x_scale: Fraction = Fraction(1)
    y_scale: Fraction = Fraction(1)

    def __post_init__(self) -> None:
        _fraction("OCR x offset", self.x_offset)
        _fraction("OCR y offset", self.y_offset)
        if _fraction("OCR x scale", self.x_scale) <= 0:
            raise DomainInvariantError("OCR x scale must be positive")
        if _fraction("OCR y scale", self.y_scale) <= 0:
            raise DomainInvariantError("OCR y scale must be positive")

    def box(
        self,
        points: tuple[int, int, int, int] | list[int],
        *,
        width: int,
        height: int,
    ) -> BoundingBox:
        if type(points) not in (tuple, list) or len(points) != 4:
            raise DomainInvariantError("OCR box must contain four coordinates")
        if any(type(item) is not int for item in points):
            raise DomainInvariantError("OCR box coordinates must be integers")
        if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
            raise DomainInvariantError("OCR frame dimensions must be positive integers")
        x0, y0, x1, y1 = points
        left = int(self.x_offset + self.x_scale * x0)
        top = int(self.y_offset + self.y_scale * y0)
        right = int(self.x_offset + self.x_scale * x1)
        bottom = int(self.y_offset + self.y_scale * y1)
        left = max(0, min(width - 1, left))
        top = max(0, min(height - 1, top))
        right = max(left + 1, min(width, right))
        bottom = max(top + 1, min(height, bottom))
        return BoundingBox(left, top, right, bottom)


@dataclass(frozen=True, slots=True)
class OcrDetection:
    frame_index: int
    box: BoundingBox
    text: str
    confidence: Fraction

    def __post_init__(self) -> None:
        if type(self.frame_index) is not int or self.frame_index < 0:
            raise DomainInvariantError("OCR frame index must be non-negative")
        if type(self.box) is not BoundingBox:
            raise DomainInvariantError("OCR detection box must be BoundingBox")
        if type(self.text) is not str or not self.text.strip():
            raise DomainInvariantError("OCR detection text must be non-empty")
        if type(self.confidence) is not Fraction or not 0 <= self.confidence <= 1:
            raise DomainInvariantError("OCR confidence must be a Fraction between 0 and 1")


@dataclass(frozen=True, slots=True)
class OcrProviderReport:
    backend: str
    providers: tuple[str, ...]
    model_revision: str

    def __post_init__(self) -> None:
        if type(self.backend) is not str or not self.backend.strip():
            raise DomainInvariantError("OCR backend must be non-empty")
        if type(self.providers) is not tuple or not self.providers or any(
            type(item) is not str or not item.strip() for item in self.providers
        ):
            raise DomainInvariantError("OCR providers must be non-empty strings")
        if type(self.model_revision) is not str or not self.model_revision.strip():
            raise DomainInvariantError("OCR model revision must be non-empty")


def require_cuda_provider(report: OcrProviderReport) -> None:
    if report.providers[0] != "CUDAExecutionProvider":
        raise RuntimeError(
            "OCR ONNX provider must initialize CUDAExecutionProvider; "
            f"got {report.providers!r}"
        )


@runtime_checkable
class OcrEngine(Protocol):
    def smoke(self) -> OcrProviderReport: ...

    def detect(
        self,
        frames: Iterable[bytes],
        *,
        width: int,
        height: int,
        start_frame: int,
        frame_step: int,
        transform: CoordinateTransform,
    ) -> tuple[OcrDetection, ...]: ...
