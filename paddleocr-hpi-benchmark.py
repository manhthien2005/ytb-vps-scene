from __future__ import annotations

import argparse
import inspect
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def run_json(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return json.loads(completed.stdout)


def probe_video(path: Path) -> dict[str, Any]:
    payload = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    video = next(item for item in payload["streams"] if item.get("codec_type") == "video")
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"
    if "/" in rate:
        left, right = rate.split("/", 1)
        fps = float(left) / max(1.0, float(right))
    else:
        fps = float(rate)
    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": fps,
        "duration": float(payload["format"]["duration"]),
    }


def extract_bottom_crops(
    input_path: Path,
    *,
    media: dict[str, Any],
    sample_fps: float,
    limit: int,
    y0_ratio: float,
    y1_ratio: float,
    scan_width: int,
) -> list[dict[str, Any]]:
    width = int(media["width"])
    height = int(media["height"])
    y0 = int(height * y0_ratio)
    y1 = int(height * y1_ratio)
    crop_height = max(1, y1 - y0)
    scan_height = max(64, int(round(crop_height * scan_width / width)))
    scan_height -= scan_height % 2
    frames_to_read = min(limit, max(1, int(media["duration"] * sample_fps)))
    vf = f"fps={sample_fps:.8f},crop={width}:{crop_height}:0:{y0},scale={scan_width}:{scan_height}"
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vf",
        vf,
        "-frames:v",
        str(frames_to_read),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    frame_size = scan_width * scan_height * 3
    crops: list[dict[str, Any]] = []
    while len(crops) < frames_to_read:
        raw = process.stdout.read(frame_size)
        if not raw:
            break
        if len(raw) != frame_size:
            raise RuntimeError(f"Truncated frame: {len(raw)} of {frame_size}")
        image = np.frombuffer(raw, dtype=np.uint8).reshape((scan_height, scan_width, 3)).copy()
        crops.append({"second": len(crops) / sample_fps, "image": image})
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"FFmpeg failed: {stderr[-2000:]}")
    return crops


def package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for package in ("paddle", "paddleocr", "paddlex", "tensorrt", "cv2"):
        try:
            module = __import__(package)
            versions[package] = str(getattr(module, "__version__", "unknown"))
        except Exception as exc:  # noqa: BLE001 - diagnostic payload only.
            versions[package] = f"unavailable: {type(exc).__name__}: {exc}"
    return versions


def filtered_kwargs(callable_obj: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return kwargs
    params = signature.parameters
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in params.values()):
        return kwargs
    return {key: value for key, value in kwargs.items() if key in params}


def build_ocr(*, device: str, enable_hpi: bool, precision: str, model_name: str | None) -> Any:
    from paddleocr import PaddleOCR

    modern_kwargs: dict[str, Any] = {
        "lang": "ch",
        "device": device,
        "enable_hpi": enable_hpi,
        "precision": precision,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if model_name:
        modern_kwargs["text_recognition_model_name"] = model_name
    try:
        return PaddleOCR(**filtered_kwargs(PaddleOCR, modern_kwargs))
    except Exception as modern_exc:  # noqa: BLE001 - fallback for older PaddleOCR API.
        log(f"Modern PaddleOCR init failed, falling back: {type(modern_exc).__name__}: {modern_exc}")
        legacy_kwargs = {
            "lang": "ch",
            "use_gpu": device.startswith("gpu"),
            "use_angle_cls": False,
            "show_log": False,
        }
        return PaddleOCR(**filtered_kwargs(PaddleOCR, legacy_kwargs))


def collect_texts(value: Any) -> list[str]:
    texts: list[str] = []
    if value is None:
        return texts
    if hasattr(value, "json"):
        try:
            payload = value.json
            if callable(payload):
                payload = payload()
            texts.extend(collect_texts(payload))
        except Exception:
            pass
    if isinstance(value, dict):
        for key in ("rec_texts", "texts", "txts"):
            items = value.get(key)
            if isinstance(items, list):
                texts.extend(str(item).strip() for item in items if str(item).strip())
        for key in ("text", "rec_text", "label"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                texts.append(item.strip())
        for item in value.values():
            if isinstance(item, (dict, list, tuple)):
                texts.extend(collect_texts(item))
        return texts
    if isinstance(value, (list, tuple)):
        if len(value) == 2 and isinstance(value[1], tuple) and value[1] and isinstance(value[1][0], str):
            texts.append(value[1][0].strip())
            return texts
        for item in value:
            texts.extend(collect_texts(item))
    return [text for text in texts if text and HAN_RE.search(text)]


def run_ocr(ocr: Any, image: np.ndarray) -> Any:
    if hasattr(ocr, "predict"):
        return ocr.predict(image)
    return ocr.ocr(image, cls=False)


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve() if args.output else None
    media = probe_video(input_path)
    log(f"Input: {input_path.name} | {media['duration']:.2f}s | {media['width']}x{media['height']}")
    log(f"Extracting {args.limit} subtitle crops at {args.sample_fps} fps")
    crops = extract_bottom_crops(
        input_path,
        media=media,
        sample_fps=args.sample_fps,
        limit=args.limit,
        y0_ratio=args.y0_ratio,
        y1_ratio=args.y1_ratio,
        scan_width=args.scan_width,
    )
    if not crops:
        raise RuntimeError("No frames extracted for benchmark")

    versions = package_versions()
    log(f"Versions: {versions}")
    init_started = time.perf_counter()
    ocr = build_ocr(device=args.device, enable_hpi=args.enable_hpi, precision=args.precision, model_name=args.model_name)
    init_seconds = time.perf_counter() - init_started
    log(f"OCR initialized in {init_seconds:.2f}s")

    samples = []
    times = []
    for index, crop in enumerate(crops):
        started = time.perf_counter()
        result = run_ocr(ocr, crop["image"])
        elapsed = time.perf_counter() - started
        times.append(elapsed)
        texts = collect_texts(result)
        if len(samples) < args.sample_texts:
            samples.append(
                {
                    "index": index,
                    "second": crop["second"],
                    "elapsed_seconds": elapsed,
                    "texts": texts[:8],
                }
            )
        if index == 0 or (index + 1) % max(1, args.progress_every) == 0:
            log(f"OCR {index + 1}/{len(crops)} | last={elapsed:.4f}s | texts={' | '.join(texts[:2])}")

    steady = times[args.warmup :] if len(times) > args.warmup else times
    summary = {
        "input": str(input_path),
        "media": media,
        "packages": versions,
        "device": args.device,
        "enable_hpi": args.enable_hpi,
        "precision": args.precision,
        "model_name": args.model_name,
        "scan_width": args.scan_width,
        "crop_y_ratio": [args.y0_ratio, args.y1_ratio],
        "sample_fps": args.sample_fps,
        "frames": len(crops),
        "warmup_frames": min(args.warmup, len(times)),
        "init_seconds": init_seconds,
        "first_ocr_seconds": times[0],
        "total_ocr_seconds": sum(times),
        "avg_ocr_seconds": sum(times) / len(times),
        "steady_avg_ocr_seconds": sum(steady) / len(steady),
        "steady_fps": len(steady) / sum(steady),
        "min_ocr_seconds": min(times),
        "max_ocr_seconds": max(times),
        "samples": samples,
    }
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"Wrote {output_path}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--output", default="")
    parser.add_argument("--device", default="gpu:0")
    parser.add_argument("--enable-hpi", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--precision", default="fp32", choices=["fp32", "fp16"])
    parser.add_argument("--model-name", default="")
    parser.add_argument("--sample-fps", type=float, default=0.5)
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--scan-width", type=int, default=640)
    parser.add_argument("--y0-ratio", type=float, default=0.58)
    parser.add_argument("--y1-ratio", type=float, default=0.96)
    parser.add_argument("--sample-texts", type=int, default=8)
    parser.add_argument("--progress-every", type=int, default=10)
    return parser


def main() -> None:
    try:
        run_benchmark(build_parser().parse_args())
    except Exception as exc:  # noqa: BLE001 - preserve diagnostics in setup logs.
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
