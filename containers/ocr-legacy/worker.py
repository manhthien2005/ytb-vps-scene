from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from paddleocr import PaddleOCR


def read_exact(stream, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        block = stream.read(size - len(chunks))
        if not block:
            break
        chunks.extend(block)
    return bytes(chunks)


def parse_result(result, y_offset: int) -> list[dict]:
    if not result:
        return []
    lines = result[0] if isinstance(result, list) else result
    if not lines:
        return []
    detections = []
    for line_index, line in enumerate(lines):
        if not line or len(line) < 2:
            continue
        points, text_data = line
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) + y_offset for point in points]
        text = str(text_data[0]).strip()
        if not text:
            continue
        confidence = float(text_data[1]) if len(text_data) > 1 else 0.0
        detections.append(
            {
                "line_index": line_index,
                "box": [
                    int(max(0, min(xs))),
                    int(max(0, min(ys))),
                    int(max(xs)),
                    int(max(ys)),
                ],
                "text": text,
                "confidence": confidence,
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
    parser.add_argument("--frame-tolerance", type=int, default=1)
    parser.add_argument("--smoke", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.smoke:
        from smoke import main as smoke_main

        smoke_main()
        return

    required = (
        "width",
        "height",
        "start_frame",
        "expected_frames",
        "output",
        "det_model_dir",
        "rec_model_dir",
    )
    missing = [name for name in required if getattr(args, name) is None]
    if missing:
        raise SystemExit(f"missing required arguments: {', '.join(missing)}")

    frame_bytes = args.width * args.height * 3
    y0 = max(0, min(args.height - 1, int(args.height * args.crop_min_y_ratio)))
    y1 = max(y0 + 1, min(args.height, int(args.height * args.crop_max_y_ratio)))
    ocr = PaddleOCR(
        use_angle_cls=False,
        lang=args.language,
        det_model_dir=args.det_model_dir,
        rec_model_dir=args.rec_model_dir,
        use_gpu=True,
        gpu_mem=args.gpu_memory_mb,
        show_log=False,
    )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.part")
    frames = 0
    detection_count = 0
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
                result = ocr.ocr(image[y0:y1, :, :], cls=False, det=True, rec=True)
                for detection in parse_result(result, y0):
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
            raise RuntimeError(
                f"Decoded {frames} frames, expected {args.expected_frames}"
            )
        os.replace(temporary, output)
        print(f"OCR_DONE {frames} {detection_count}", flush=True)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
