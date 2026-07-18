"""Optional OCR provider adapters with lazy runtime loading."""

from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter
from ytb_vps_v2.adapters.ocr.change_detection import (
    ChangeDetectionPolicy,
    FrameDetections,
    iter_processed_frames,
    process_frames,
)
from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter
from ytb_vps_v2.adapters.ocr.onnx_detector import (
    RapidOcrOnnxDetector,
    convert_rapidocr_result,
)
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
    "iter_processed_frames",
    "OnnxOcrSmokeAdapter",
    "RapidOcrOnnxDetector",
    "RawFrame",
    "iter_raw_frames",
    "parse_worker_jsonl",
    "write_canonical_jsonl",
    "process_frames",
    "convert_rapidocr_result",
]
