# src/ytb_vps_v2/adapters/ffmpeg/filter_graph.py
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from fractions import Fraction

from ytb_vps_v2.domain.blur_geometry import align_to_chroma_grid, blur_radii
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox

Interval = tuple[Fraction, Fraction]


@dataclass(frozen=True, slots=True)
class MaskRegion:
    box: BoundingBox
    intervals: tuple[Interval, ...]
    glyph_height: int

    def __post_init__(self) -> None:
        if not isinstance(self.box, BoundingBox):
            raise DomainInvariantError("Mask region box must be a BoundingBox")
        if not isinstance(self.intervals, tuple):
            raise DomainInvariantError("Mask region intervals must be a tuple")
        for item in self.intervals:
            if (
                not isinstance(item, tuple)
                or len(item) != 2
                or not all(isinstance(value, Fraction) for value in item)
                or item[1] <= item[0]
            ):
                raise DomainInvariantError("Mask region interval must be an ordered pair")
        if not isinstance(self.glyph_height, int) or self.glyph_height <= 0:
            raise DomainInvariantError("Mask region glyph height must be positive")


def merge_intervals(
    intervals: Iterable[Interval], *, pad_seconds: Fraction, gap_seconds: Fraction
) -> tuple[Interval, ...]:
    """Pad each interval, then coalesce ones closer than gap_seconds.

    Padding covers OCR timing jitter; coalescing stops the mask strobing on and
    off between two cues that are visually one block of dialogue."""
    padded = sorted(
        (max(Fraction(0), start - pad_seconds), end + pad_seconds)
        for start, end in intervals
    )
    merged: list[Interval] = []
    for start, end in padded:
        if merged and start - merged[-1][1] <= gap_seconds:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return tuple(merged)


def _seconds(value: Fraction) -> str:
    return f"{float(value):.3f}"


def _enable_clause(intervals: Sequence[Interval]) -> str:
    if not intervals:
        return ""
    expression = "+".join(
        f"between(t,{_seconds(start)},{_seconds(end)})" for start, end in intervals
    )
    return f":enable='{expression}'"


def _escape_filter_path(value: str) -> str:
    # The filtergraph parser splits options on ':' and unescapes '\', so a Windows
    # path needs both handled or the drive letter is read as an option separator.
    return value.replace("\\", "/").replace(":", r"\:")


def build_video_graph(
    regions: Sequence[MaskRegion],
    *,
    width: int,
    height: int,
    subtitle_path: str | None,
    input_label: str = "0:v",
    output_label: str = "vout",
) -> str:
    statements: list[str] = []
    current = f"[{input_label}]"

    if regions:
        labels = [f"m{index}" for index in range(len(regions))]
        statements.append(f"{current}split={len(regions) + 1}[base]{''.join(f'[{n}]' for n in labels)}")
        current = "[base]"
        for index, (region, label) in enumerate(zip(regions, labels)):
            box = align_to_chroma_grid(region.box, width=width, height=height)
            crop_width = box.xmax - box.xmin
            crop_height = box.ymax - box.ymin
            luma, chroma = blur_radii(crop_width, crop_height, region.glyph_height)
            statements.append(
                f"[{label}]crop={crop_width}:{crop_height}:{box.xmin}:{box.ymin},"
                f"boxblur=luma_radius={luma}:luma_power=1:"
                f"chroma_radius={chroma}:chroma_power=1[b{index}]"
            )
            nxt = f"[v{index}]"
            statements.append(
                f"{current}[b{index}]overlay={box.xmin}:{box.ymin}"
                f"{_enable_clause(region.intervals)}{nxt}"
            )
            current = nxt

    if subtitle_path is not None:
        statements.append(f"{current}subtitles='{_escape_filter_path(subtitle_path)}'[sub]")
        current = "[sub]"

    statements.append(f"{current}format=yuv420p[{output_label}]")
    return ";".join(statements)
