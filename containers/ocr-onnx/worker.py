from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from rapidocr import RapidOCR


def env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except ValueError:
        return default


def read_exact(stream, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        block = stream.read(size - len(chunks))
        if not block:
            break
        chunks.extend(block)
    return bytes(chunks)


def build_engine() -> RapidOCR:
    intra_threads = env_int("OCR_ONNX_INTRA_THREADS", 1)
    inter_threads = env_int("OCR_ONNX_INTER_THREADS", 1)
    engine = RapidOCR(
        params={
            "Global.use_cls": False,
            "EngineConfig.onnxruntime.use_cuda": True,
            "EngineConfig.onnxruntime.cuda_ep_cfg.device_id": 0,
            "EngineConfig.onnxruntime.intra_op_num_threads": intra_threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": inter_threads,
        }
    )
    sessions = {
        "det": engine.text_det.session.session,
        "rec": engine.text_rec.session.session,
    }
    invalid = {
        name: session.get_providers()
        for name, session in sessions.items()
        if not session.get_providers()
        or session.get_providers()[0] != "CUDAExecutionProvider"
    }
    if invalid:
        raise RuntimeError(f"RapidOCR CUDA provider did not initialize: {invalid}")
    return engine


def provider_report(engine: RapidOCR) -> dict:
    return {
        "backend": "rapidocr-onnx",
        "rapidocr": importlib.metadata.version("rapidocr"),
        "onnxruntime": ort.__version__,
        "available_providers": ort.get_available_providers(),
        "det_providers": engine.text_det.session.session.get_providers(),
        "rec_providers": engine.text_rec.session.session.get_providers(),
    }


def parse_result(
    result, *, x_offset: float, y_offset: float, x_scale: float, y_scale: float
) -> list[dict]:
    if result is None or result.boxes is None or result.txts is None:
        return []
    scores = result.scores if result.scores is not None else [0.0] * len(result.txts)
    detections = []
    for line_index, (points, text, confidence) in enumerate(
        zip(result.boxes, result.txts, scores)
    ):
        value = str(text).strip()
        if not value:
            continue
        array = np.asarray(points, dtype=np.float32)
        xs = array[:, 0] * x_scale + x_offset
        ys = array[:, 1] * y_scale + y_offset
        detections.append(
            {
                "line_index": line_index,
                "box": [
                    int(max(0, xs.min())),
                    int(max(0, ys.min())),
                    int(xs.max()),
                    int(ys.max()),
                ],
                "text": value,
                "confidence": float(confidence),
            }
        )
    return detections


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--start-frame", type=int)
    parser.add_argument("--expected-frames", type=int)
    parser.add_argument("--frame-step", type=int, default=1)
    parser.add_argument("--output")
    parser.add_argument("--det-model-dir")
    parser.add_argument("--rec-model-dir")
    parser.add_argument("--language", default="ch")
    parser.add_argument("--gpu-memory-mb", type=int, default=3000)
    parser.add_argument("--crop-min-y-ratio", type=float, default=0.5)
    parser.add_argument("--crop-max-y-ratio", type=float, default=0.98)
    parser.add_argument("--x-scale", type=float, default=1.0)
    parser.add_argument("--y-scale", type=float, default=1.0)
    parser.add_argument("--x-offset", type=float, default=0.0)
    parser.add_argument("--y-offset", type=float, default=0.0)
    parser.add_argument("--frame-tolerance", type=int, default=1)
    parser.add_argument("--smoke", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    engine = build_engine()
    if args.smoke:
        print(json.dumps(provider_report(engine), sort_keys=True))
        return

    required = ("width", "height", "start_frame", "expected_frames", "output")
    missing = [name for name in required if getattr(args, name) is None]
    if missing:
        raise SystemExit(f"missing required arguments: {', '.join(missing)}")

    frame_bytes = args.width * args.height * 3
    y0 = max(0, min(args.height - 1, int(args.height * args.crop_min_y_ratio)))
    y1 = max(y0 + 1, min(args.height, int(args.height * args.crop_max_y_ratio)))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.part")
    frames = 0
    detection_count = 0
    warmed_up = False
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            while frames < args.expected_frames:
                raw = read_exact(sys.stdin.buffer, frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise RuntimeError(
                        f"Truncated raw frame: {len(raw)} of {frame_bytes} bytes"
                    )
                image = np.frombuffer(raw, dtype=np.uint8).reshape(
                    (args.height, args.width, 3)
                )
                cropped = image[y0:y1, :, :]
                if not warmed_up:
                    engine(cropped)
                    warmed_up = True
                result = engine(cropped)
                for detection in parse_result(
                    result,
                    x_offset=args.x_offset,
                    y_offset=args.y_offset + y0 * args.y_scale,
                    x_scale=args.x_scale,
                    y_scale=args.y_scale,
                ):
                    detection["frame_index"] = args.start_frame + frames * args.frame_step
                    handle.write(json.dumps(detection, ensure_ascii=False) + "\n")
                    detection_count += 1
                frames += 1
                if frames == 1 or frames % 30 == 0 or frames == args.expected_frames:
                    print(
                        f"OCR_PROGRESS {frames} {args.expected_frames} {detection_count}",
                        flush=True,
                    )
            handle.flush()
            os.fsync(handle.fileno())
        if frames < args.expected_frames - args.frame_tolerance:
            raise RuntimeError(f"Decoded {frames} frames, expected {args.expected_frames}")
        os.replace(temporary, output)
        print(f"OCR_DONE {frames} {detection_count}", flush=True)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
