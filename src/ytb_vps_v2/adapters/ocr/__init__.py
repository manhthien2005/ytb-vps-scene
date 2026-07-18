"""Optional OCR provider adapters with lazy runtime loading."""

from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter
from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter

__all__ = ["DockerOcrSmokeAdapter", "OnnxOcrSmokeAdapter"]
