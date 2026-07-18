from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from ytb_vps_v2.adapters.ocr.change_detection import (
    ChangeDetectionPolicy,
    iter_processed_frames,
)
from ytb_vps_v2.adapters.ocr.stream import (
    RawFrame,
    iter_raw_frames,
    write_canonical_jsonl,
)
from ytb_vps_v2.ports.ocr import OcrDetection


@dataclass(frozen=True, slots=True)
class WorkerSummary:
    frames: int
    detections: int


def run_worker_loop(
    stream: BinaryIO,
    destination: Path,
    detector: Callable[[RawFrame], Iterable[OcrDetection]],
    *,
    width: int,
    height: int,
    channel_order: str,
    start_frame: int,
    frame_step: int,
    expected_frames: int,
    frame_tolerance: int = 0,
    policy: ChangeDetectionPolicy = ChangeDetectionPolicy(),
    progress: Callable[[str], None] | None = None,
) -> WorkerSummary:
    messages = progress if progress is not None else lambda value: None
    frames = iter_raw_frames(
        stream,
        width=width,
        height=height,
        channel_order=channel_order,
        start_frame=start_frame,
        frame_step=frame_step,
        expected_frames=expected_frames,
        frame_tolerance=frame_tolerance,
    )
    emitted: list[OcrDetection] = []
    frame_count = 0
    for item in iter_processed_frames(frames, detector, policy):
        frame_count += 1
        emitted.extend(item.detections)
        if frame_count == 1 or frame_count % 30 == 0 or frame_count == expected_frames:
            messages(
                f"OCR_PROGRESS {frame_count} {expected_frames} {len(emitted)}"
            )
    write_canonical_jsonl(destination, emitted)
    messages(f"OCR_DONE {frame_count} {len(emitted)}")
    return WorkerSummary(frame_count, len(emitted))
