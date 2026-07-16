from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from math import isfinite

from ytb_vps_v2.domain.errors import DomainInvariantError


Seconds = int | float | str | Decimal | Fraction


def to_fraction(value: Seconds) -> Fraction:
    if isinstance(value, bool):
        raise DomainInvariantError(f"Invalid rational value: {value!r}")
    try:
        if isinstance(value, Fraction):
            result = value
        elif isinstance(value, Decimal):
            if not value.is_finite():
                raise ValueError("Decimal value must be finite")
            result = Fraction(value)
        elif isinstance(value, float):
            if not isfinite(value):
                raise ValueError("Float value must be finite")
            result = Fraction(str(value))
        else:
            result = Fraction(value)
    except (TypeError, ValueError, OverflowError, ZeroDivisionError) as exc:
        raise DomainInvariantError(f"Invalid rational value: {value!r}") from exc
    return result


def _require_frame_index(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DomainInvariantError(f"{name} must be an integer")


def _floor(value: Fraction) -> int:
    return value.numerator // value.denominator


def _ceil(value: Fraction) -> int:
    return -(-value.numerator // value.denominator)


@dataclass(frozen=True, slots=True)
class FrameInterval:
    start_frame: int
    end_frame: int

    def __post_init__(self) -> None:
        _require_frame_index("Frame interval start", self.start_frame)
        _require_frame_index("Frame interval end", self.end_frame)
        if self.start_frame < 0:
            raise DomainInvariantError("Frame interval start must be non-negative")
        if self.end_frame <= self.start_frame:
            raise DomainInvariantError("Frame interval must be non-empty")

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame

    def contains(self, frame_index: int) -> bool:
        _require_frame_index("Frame index", frame_index)
        return self.start_frame <= frame_index < self.end_frame


@dataclass(frozen=True, slots=True)
class Timeline:
    target_fps: int = 30

    def __post_init__(self) -> None:
        if isinstance(self.target_fps, bool) or not isinstance(self.target_fps, int):
            raise DomainInvariantError("Target FPS must be an integer")
        if self.target_fps <= 0:
            raise DomainInvariantError("Target FPS must be positive")

    def total_frames(self, duration_seconds: Seconds) -> int:
        duration = to_fraction(duration_seconds)
        if duration <= 0:
            raise DomainInvariantError("Media duration must be positive")
        return _ceil(duration * self.target_fps)

    def interval(
        self,
        start_seconds: Seconds,
        end_seconds: Seconds,
        duration_seconds: Seconds,
    ) -> FrameInterval:
        start = to_fraction(start_seconds)
        end = to_fraction(end_seconds)
        duration = to_fraction(duration_seconds)
        if duration <= 0:
            raise DomainInvariantError("Media duration must be positive")
        if start < 0 or start >= duration:
            raise DomainInvariantError("Interval start is outside media duration")
        if end <= start:
            raise DomainInvariantError("Interval end must be after its start")

        total = self.total_frames(duration)
        start_frame = min(total - 1, _floor(start * self.target_fps))
        end_frame = min(total, _ceil(min(end, duration) * self.target_fps))
        return FrameInterval(start_frame=start_frame, end_frame=end_frame)

    def normalize_source_interval(
        self,
        start_source_frame: int,
        end_source_frame: int,
        source_fps: Seconds,
        duration_seconds: Seconds,
    ) -> FrameInterval:
        _require_frame_index("Source frame interval start", start_source_frame)
        _require_frame_index("Source frame interval end", end_source_frame)
        if start_source_frame < 0 or end_source_frame <= start_source_frame:
            raise DomainInvariantError("Source frame interval must be non-empty")
        source_rate = to_fraction(source_fps)
        if source_rate <= 0:
            raise DomainInvariantError("Source FPS must be positive")
        return self.interval(
            Fraction(start_source_frame, 1) / source_rate,
            Fraction(end_source_frame, 1) / source_rate,
            duration_seconds,
        )
