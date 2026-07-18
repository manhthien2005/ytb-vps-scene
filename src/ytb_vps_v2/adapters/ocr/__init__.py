"""Optional OCR provider adapters with lazy runtime loading."""

from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter
from ytb_vps_v2.adapters.ocr.change_detection import (
    ChangeDetectionPolicy,
    FrameDetections,
    process_frames,
)
from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter
from ytb_vps_v2.adapters.ocr.stream import (
    RawFrame,
    iter_raw_frames,
    parse_worker_jsonl,
    write_canonical_jsonl,
)

__all__ = [
    "DockerOcrSmokeAdapter",
    "ChangeDetectionPolicy",
    "FrameDetections",
    "OnnxOcrSmokeAdapter",
    "RawFrame",
    "iter_raw_frames",
    "parse_worker_jsonl",
    "write_canonical_jsonl",
    "process_frames",
]
