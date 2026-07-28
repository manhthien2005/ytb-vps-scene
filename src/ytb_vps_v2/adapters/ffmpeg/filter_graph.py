# src/ytb_vps_v2/adapters/ffmpeg/filter_graph.py
from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from fractions import Fraction

from ytb_vps_v2.domain.blur_geometry import align_to_chroma_grid, blur_radii
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox

Interval = tuple[Fraction, Fraction]

# Measured against ffmpeg N-124716: an `enable=` expression accepts at most 100
# `between()` terms; the 101st fails the WHOLE filter with "Error when evaluating
# the expression". The limit is on expression NODE COUNT, not string length --
# 90 long terms (3309 chars) parse while 150 short terms (2631 chars) do not.
# 60 leaves headroom for the parser's own nodes.
MAX_TERMS_PER_STAGE = 60


@dataclass(frozen=True, slots=True)
class MaskRegion:
    box: BoundingBox
    glyph_height: int
    intervals: tuple[Interval, ...] = ()
    always_on: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.box, BoundingBox):
            raise DomainInvariantError("Mask region box must be a BoundingBox")
        if not isinstance(self.always_on, bool):
            raise DomainInvariantError("Mask region always_on must be a bool")
        if not isinstance(self.intervals, tuple):
            raise DomainInvariantError("Mask region intervals must be a tuple")
        # An empty interval tuple must never mean "blur forever". OCR finding
        # nothing in a region is the common case, and silently blurring the whole
        # runtime is exactly the v1 defect this rebuild exists to remove. Callers
        # that genuinely want a permanent mask say so with always_on=True.
        if not self.intervals and not self.always_on:
            raise DomainInvariantError(
                "Mask region has no intervals; pass always_on=True for a permanent mask "
                "or drop the region entirely"
            )
        if self.intervals and self.always_on:
            raise DomainInvariantError(
                "Mask region cannot be always_on and carry intervals at the same time"
            )
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


def _seconds(value: Fraction, *, round_up: bool) -> str:
    """Format a Fraction as seconds at millisecond precision, rounding OUTWARD.

    A naive float round can move an edge INWARD by up to 0.5ms, shrinking the
    masked window and exposing a sliver of the original glyph. Every other
    coordinate rule in this system expands outward; enable= windows must match:
    floor the start (earlier), ceil the end (later)."""
    millis = value * 1000
    whole = math.ceil(millis) if round_up else math.floor(millis)
    sign = "-" if whole < 0 else ""
    whole = abs(whole)
    return f"{sign}{whole // 1000}.{whole % 1000:03d}"


def _stage_chunks(intervals: Sequence[Interval]) -> list[Sequence[Interval]]:
    """Split intervals into groups small enough for one enable= expression.

    Measured against ffmpeg N-124716: an `enable=` expression accepts at most 100
    `between()` terms and fails the whole filter with "Error when evaluating the
    expression" at 101. The limit is on expression NODE COUNT, not string length --
    90 long terms (3309 chars) parse while 150 short terms (2631 chars) do not.
    60 leaves room for the parser's own nodes."""
    size = MAX_TERMS_PER_STAGE
    return [intervals[index:index + size] for index in range(0, len(intervals), size)]


def _enable_clause(intervals: Sequence[Interval]) -> str:
    """Render the overlay's enable= option, or nothing for a permanent mask.

    An empty expression is not the same as an absent one: ffmpeg rejects
    `enable=''` with "Undefined constant or missing '('", so an always-on
    region must omit the option entirely rather than pass an empty string."""
    if not intervals:
        return ""
    expression = "+".join(
        f"between(t,{_seconds(start, round_up=False)},{_seconds(end, round_up=True)})"
        for start, end in intervals
    )
    return f":enable='{expression}'"


def _escape_filter_path(value: str) -> str:
    # The filtergraph parser splits options on ':' and unescapes '\', so a Windows
    # path needs both handled or the drive letter is read as an option separator.
    #
    # An embedded "'" is harder than it looks, because the caller wraps the result
    # in single quotes and ffmpeg runs TWO unescape passes over it (the quote
    # remover, then the option unescaper). Measured against ffmpeg N-124716 on a
    # real file at .../AA'BB/real.ass -- only the last form opens it:
    #   \'      -> path truncates at "AABB/real.ass" and swallows the rest of the
    #              graph into the filename (the apostrophe is simply dropped)
    #   '\''    -> terminates the path correctly but still drops the apostrophe
    #              (this is the documented ffmpeg-utils shell-style escape, and it
    #              is NOT sufficient here -- it survives only one unescape pass)
    #   '\\''   -> yields a literal backslash instead: "AA\BB"
    #   '\\\''  -> "AA'BB" -- correct, verified against a real file with returncode 0
    # So: close the quote, emit a doubly-escaped apostrophe (3 backslashes), reopen
    # the quote. Each unescape pass consumes one layer of backslash; three survive
    # both passes as exactly one literal backslash in front of the apostrophe,
    # which the second pass then resolves to a bare "'".
    escaped = value.replace("\\", "/").replace(":", r"\:")
    return escaped.replace("'", "'" + "\\" * 3 + "''")


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
        statements.append(
            f"{current}split={len(regions) + 1}[base]"
            + "".join(f"[m{index}]" for index in range(len(regions)))
        )
        current = "[base]"
        stage = 0
        for index, region in enumerate(regions):
            box = align_to_chroma_grid(region.box, width=width, height=height)
            crop_width = box.xmax - box.xmin
            crop_height = box.ymax - box.ymin
            luma, chroma = blur_radii(crop_width, crop_height, region.glyph_height)

            # One blurred copy per region, reused by every overlay stage below it.
            chunks = _stage_chunks(region.intervals) if region.intervals else [()]
            fanout = f"[b{index}]"
            if len(chunks) > 1:
                fanout = "".join(f"[b{index}_{part}]" for part in range(len(chunks)))
            statements.append(
                f"[m{index}]crop={crop_width}:{crop_height}:{box.xmin}:{box.ymin},"
                f"boxblur=luma_radius={luma}:luma_power=1:"
                f"chroma_radius={chroma}:chroma_power=1"
                + (f",split={len(chunks)}{fanout}" if len(chunks) > 1 else fanout)
            )

            # Each chunk is its own overlay stage. Stages compose: a frame inside any
            # chunk's enable window is covered, so N stages behave as one mask whose
            # term count is unbounded while every single expression stays legal.
            for part, chunk in enumerate(chunks):
                source = (
                    f"[b{index}_{part}]" if len(chunks) > 1 else f"[b{index}]"
                )
                nxt = f"[v{stage}]"
                statements.append(
                    f"{current}{source}overlay={box.xmin}:{box.ymin}"
                    f"{_enable_clause(chunk)}{nxt}"
                )
                current = nxt
                stage += 1

    if subtitle_path is not None:
        statements.append(f"{current}subtitles='{_escape_filter_path(subtitle_path)}'[sub]")
        current = "[sub]"

    statements.append(f"{current}format=yuv420p[{output_label}]")
    return ";".join(statements)
