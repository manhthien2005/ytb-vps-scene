from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import BinaryIO, TextIO

from ytb_vps_v2.adapters.ocr.change_detection import ChangeDetectionPolicy, iter_processed_frames
from ytb_vps_v2.adapters.ocr.stream import RawFrame, iter_raw_frames
from ytb_vps_v2.ports.ocr import OcrDetection


@dataclass(frozen=True, slots=True)
class StdoutWorkerSummary:
    frames: int
    detections: int


def _record(item: OcrDetection) -> str:
    payload = {
        "box": [item.box.xmin, item.box.ymin, item.box.xmax, item.box.ymax],
        "confidence": float(item.confidence),
        "frame_index": item.frame_index,
        "text": item.text,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def run_stdout_worker_loop(
    stream: BinaryIO,
    output: TextIO,
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
) -> StdoutWorkerSummary:
    emit_progress = progress if progress is not None else lambda value: None
    frames = iter_raw_frames(
        stream, width=width, height=height, channel_order=channel_order,
        start_frame=start_frame, frame_step=frame_step,
        expected_frames=expected_frames, frame_tolerance=frame_tolerance,
    )
    frame_count = 0
    detection_count = 0
    for item in iter_processed_frames(frames, detector, policy):
        frame_count += 1
        for detection in item.detections:
            output.write(_record(detection))
            output.write("\n")
            detection_count += 1
        if frame_count == 1 or frame_count % 30 == 0 or frame_count == expected_frames:
            output.flush()
            emit_progress(f"OCR_PROGRESS {frame_count} {expected_frames} {detection_count}")
    output.flush()
    emit_progress(f"OCR_DONE {frame_count} {detection_count}")
    return StdoutWorkerSummary(frame_count, detection_count)

