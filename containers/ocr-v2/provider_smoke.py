from __future__ import annotations

import importlib.metadata
import json

import onnxruntime as ort
from rapidocr import RapidOCR


def main() -> None:
    engine = RapidOCR(
        params={
            "Global.use_cls": False,
            "EngineConfig.onnxruntime.use_cuda": True,
            "EngineConfig.onnxruntime.cuda_ep_cfg.device_id": 0,
        }
    )
    detection = engine.text_det.session.session.get_providers()
    recognition = engine.text_rec.session.session.get_providers()
    if not detection or detection[0] != "CUDAExecutionProvider":
        raise SystemExit(f"detector CUDA provider is not first: {detection}")
    if not recognition or recognition[0] != "CUDAExecutionProvider":
        raise SystemExit(f"recognizer CUDA provider is not first: {recognition}")
    print(
        json.dumps(
            {
                "available_providers": ort.get_available_providers(),
                "det_providers": detection,
                "onnxruntime": ort.__version__,
                "rapidocr": importlib.metadata.version("rapidocr"),
                "rec_providers": recognition,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
