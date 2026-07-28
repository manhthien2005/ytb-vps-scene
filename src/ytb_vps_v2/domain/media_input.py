# src/ytb_vps_v2/domain/media_input.py
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError


class FrameRateMode(str, Enum):
    CFR = "CFR"
    VFR = "VFR"


@dataclass(frozen=True, slots=True)
class ColourProfile:
    primaries: str
    transfer: str
    matrix: str
    range_: str
    bit_depth: int

    def __post_init__(self) -> None:
        for name, value in (
            ("Colour primaries", self.primaries),
            ("Colour transfer", self.transfer),
            ("Colour matrix", self.matrix),
            ("Colour range", self.range_),
        ):
            if not isinstance(value, str) or not value:
                raise DomainInvariantError(f"{name} must be non-empty text")
        if not isinstance(self.bit_depth, int) or not 8 <= self.bit_depth <= 16:
            raise DomainInvariantError("Colour bit depth must be between 8 and 16")

    @property
    def is_high_dynamic_range(self) -> bool:
        return self.transfer in {"smpte2084", "arib-std-b67"} or self.primaries == "bt2020"


@dataclass(frozen=True, slots=True)
class InputManifest:
    video_stream_index: int
    audio_stream_index: int | None
    storage_width: int
    storage_height: int
    rotation_degrees: int
    sample_aspect_ratio: Fraction
    frame_rate: Fraction
    frame_rate_mode: FrameRateMode
    colour: ColourProfile
    start_time_seconds: Fraction
    duration_seconds: Fraction
    rejected_audio_indexes: tuple[int, ...]
    subtitle_stream_indexes: tuple[int, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.video_stream_index, int) or self.video_stream_index < 0:
            raise DomainInvariantError("Video stream index must be a non-negative integer")
        if self.audio_stream_index is not None and (
            not isinstance(self.audio_stream_index, int) or self.audio_stream_index < 0
        ):
            raise DomainInvariantError("Audio stream index must be absent or non-negative")
        for name, value in (
            ("Storage width", self.storage_width),
            ("Storage height", self.storage_height),
        ):
            if not isinstance(value, int) or value <= 0:
                raise DomainInvariantError(f"{name} must be a positive integer")
        if self.rotation_degrees not in (0, 90, 180, 270):
            raise DomainInvariantError("Rotation must be 0, 90, 180 or 270 degrees")
        if not isinstance(self.sample_aspect_ratio, Fraction) or self.sample_aspect_ratio <= 0:
            raise DomainInvariantError("Sample aspect ratio must be a positive Fraction")
        if not isinstance(self.frame_rate, Fraction) or self.frame_rate <= 0:
            raise DomainInvariantError("Frame rate must be a positive Fraction")
        if not isinstance(self.frame_rate_mode, FrameRateMode):
            raise DomainInvariantError("Frame rate mode must be a FrameRateMode")
        if not isinstance(self.colour, ColourProfile):
            raise DomainInvariantError("Colour must be a ColourProfile")
        if not isinstance(self.start_time_seconds, Fraction):
            raise DomainInvariantError("Start time must be a Fraction")
        if not isinstance(self.duration_seconds, Fraction) or self.duration_seconds <= 0:
            raise DomainInvariantError("Duration must be a positive Fraction")
        for name, values in (
            ("Rejected audio indexes", self.rejected_audio_indexes),
            ("Subtitle stream indexes", self.subtitle_stream_indexes),
        ):
            if not isinstance(values, tuple) or any(
                not isinstance(item, int) or item < 0 for item in values
            ):
                raise DomainInvariantError(f"{name} must be a tuple of non-negative integers")

    @property
    def display_size(self) -> tuple[int, int]:
        """Pixel size an operator actually sees, after SAR then rotation.

        ffprobe reports storage geometry; the decoder applies the display matrix.
        Every region coordinate in this system refers to this size, never to storage."""
        width = int(round(self.storage_width * self.sample_aspect_ratio))
        height = self.storage_height
        if self.rotation_degrees in (90, 270):
            return height, width
        return width, height
