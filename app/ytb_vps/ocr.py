from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from ytb_vps.config import Settings
from ytb_vps.media import executable
from ytb_vps.state import JobStore
from ytb_vps.util import sha256_file


def _mount_argument(host: Path, container: str, *, read_only: bool) -> list[str]:
    suffix = ":ro" if read_only else ""
    return ["-v", f"{host.resolve()}:{container}{suffix}"]


def ocr_backend(settings: Settings) -> str:
    config = settings.section("ocr")
    selected = str(config.get("backend", "auto")).lower()
    if selected not in {"auto", "docker", "onnx"}:
        raise ValueError(f"Unknown OCR backend: {selected}")
    if selected == "auto":
        return "onnx" if Path(str(config["onnx_python"])).is_file() else "docker"
    return selected


def onnx_ocr_environment(settings: Settings) -> dict[str, str]:
    environment = os.environ.copy()
    config = settings.section("ocr")
    resources = settings.section("resources")
    configured = str(config["onnx_library_path"])
    existing = environment.get("LD_LIBRARY_PATH", "")
    environment["LD_LIBRARY_PATH"] = configured + (f":{existing}" if existing else "")
    omp_threads = max(1, int(config.get("omp_threads", resources.get("omp_threads", 1))))
    intra_threads = max(1, int(config.get("onnx_intra_threads", omp_threads)))
    inter_threads = max(1, int(config.get("onnx_inter_threads", 1)))
    environment["OMP_NUM_THREADS"] = str(omp_threads)
    environment["MKL_NUM_THREADS"] = str(omp_threads)
    environment["OCR_ONNX_INTRA_THREADS"] = str(intra_threads)
    environment["OCR_ONNX_INTER_THREADS"] = str(inter_threads)
    environment["FLAGS_allocator_strategy"] = "auto_growth"
    return environment


def run_ocr_chunk(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    input_path: Path,
    workspace: Path,
    media: dict[str, Any],
    chunk: dict[str, Any],
    logger: logging.Logger,
) -> dict[str, Any]:
    index = int(chunk["chunk_index"])
    output_dir = workspace / "ocr" / "chunks"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"chunk_{index:06d}.jsonl"
    source_frames = int(chunk["end_frame"]) - int(chunk["start_frame"])
    duration = float(chunk["end_seconds"]) - float(chunk["start_seconds"])
    fps = int(settings.section("media")["target_fps"])
    ocr = settings.section("ocr")
    threads = int(ocr.get("ffmpeg_threads", settings.section("media")["ffmpeg_threads"]))
    requested_sample_fps = float(ocr.get("sample_fps", fps))
    frame_step = max(1, int(round(fps / requested_sample_fps)))
    sample_fps = fps / frame_step
    expected_frames = int(math.ceil(source_frames / frame_step))
    source_width = int(media["width"])
    source_height = int(media["height"])
    crop_min_ratio = float(ocr.get("scan_min_y_ratio", ocr["subtitle_min_y_ratio"]))
    crop_max_ratio = float(ocr.get("scan_max_y_ratio", ocr["subtitle_max_y_ratio"]))
    y0 = max(0, min(source_height - 1, int(source_height * crop_min_ratio)))
    y1 = max(y0 + 1, min(source_height, int(source_height * crop_max_ratio)))
    crop_height = y1 - y0
    scan_width = int(ocr.get("scan_width", source_width))
    scan_width = max(320, min(source_width, scan_width))
    scan_height = max(64, int(round(crop_height * scan_width / source_width)))
    # Even dimensions keep FFmpeg filters and common OCR kernels on their fast paths.
    scan_width -= scan_width % 2
    scan_height -= scan_height % 2

    ffmpeg_command = [
        executable("ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{float(chunk['start_seconds']):.6f}",
        "-i",
        str(input_path.resolve()),
        "-an",
        "-vf",
        (
            f"fps={sample_fps:.8f},"
            f"scale={source_width}:{source_height},"
            f"crop={source_width}:{crop_height}:0:{y0},"
            f"scale={scan_width}:{scan_height}"
        ),
        "-frames:v",
        str(expected_frames),
        "-threads",
        str(threads),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    models_root = settings.data_path("models")
    backend = ocr_backend(settings)
    common_arguments = [
        "--width",
        str(scan_width),
        "--height",
        str(scan_height),
        "--start-frame",
        str(int(chunk["start_frame"])),
        "--expected-frames",
        str(expected_frames),
        "--frame-step",
        str(frame_step),
        "--language",
        str(ocr["language"]),
        "--gpu-memory-mb",
        str(int(ocr["gpu_memory_mb"])),
        "--crop-min-y-ratio",
        "0.0",
        "--crop-max-y-ratio",
        "1.0",
        "--x-scale",
        str(source_width / scan_width),
        "--y-scale",
        str(crop_height / scan_height),
        "--x-offset",
        "0",
        "--y-offset",
        str(y0),
    ]
    worker_environment = None
    if backend == "docker":
        container_output_dir = "/work"
        worker_command = [
            executable("docker"),
            "run",
            "--rm",
            "--gpus",
            "all",
            "-i",
            "--network",
            "none",
            *_mount_argument(models_root, "/models", read_only=True),
            *_mount_argument(output_dir, container_output_dir, read_only=False),
            str(ocr["container_image"]),
            *common_arguments,
            "--output",
            f"{container_output_dir}/{output.name}",
            "--det-model-dir",
            str(ocr["det_model_dir"]),
            "--rec-model-dir",
            str(ocr["rec_model_dir"]),
        ]
    else:
        onnx_python = Path(str(ocr["onnx_python"]))
        if not onnx_python.is_file():
            raise FileNotFoundError(onnx_python)
        worker_command = [
            str(onnx_python),
            str(Path(str(ocr["onnx_worker"])).resolve(strict=True)),
            *common_arguments,
            "--output",
            str(output.resolve()),
            "--det-model-dir",
            str((models_root / Path(str(ocr["det_model_dir"])).name).resolve()),
            "--rec-model-dir",
            str((models_root / Path(str(ocr["rec_model_dir"])).name).resolve()),
        ]
        worker_environment = onnx_ocr_environment(settings)

    logger.info(
        "OCR chunk %d | %.1fs-%.1fs | %d/%d sampled frames (step=%d)",
        index,
        float(chunk["start_seconds"]),
        float(chunk["end_seconds"]),
        expected_frames,
        source_frames,
        frame_step,
    )
    started = time.monotonic()
    ffmpeg = subprocess.Popen(ffmpeg_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert ffmpeg.stdout is not None
    worker = subprocess.Popen(
        worker_command,
        stdin=ffmpeg.stdout,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=worker_environment,
    )
    ffmpeg.stdout.close()
    assert worker.stdout is not None
    tail: list[str] = []
    try:
        for raw in worker.stdout:
            line = raw.strip()
            tail.append(line)
            tail = tail[-40:]
            if line.startswith("OCR_PROGRESS "):
                _, current, total, detections = line.split()
                if int(current) == 1 or int(current) % 30 == 0 or current == total:
                    logger.info(
                        "OCR chunk %d | %s/%s frames | %s detections",
                        index,
                        current,
                        total,
                        detections,
                    )
        worker_code = worker.wait()
        ffmpeg_stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
        ffmpeg_code = ffmpeg.wait()
    except BaseException:
        worker.terminate()
        ffmpeg.terminate()
        raise
    finally:
        worker.stdout.close()
        if ffmpeg.stderr:
            ffmpeg.stderr.close()
    if worker_code != 0:
        raise RuntimeError(
            f"OCR {backend} worker exited {worker_code}; FFmpeg reported: "
            f"{ffmpeg_stderr[-1000:]}\n" + "\n".join(tail[-15:])
        )
    if ffmpeg_code != 0:
        raise RuntimeError(f"OCR FFmpeg decode failed: {ffmpeg_stderr[-2000:]}")
    if not output.exists():
        raise RuntimeError(f"OCR {backend} worker did not produce {output.name}")

    detections: list[dict[str, Any]] = []
    with output.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Invalid OCR JSONL at line {line_number}: {exc}"
                ) from exc
            if not isinstance(value, dict) or "frame_index" not in value:
                raise RuntimeError(f"Invalid OCR detection at line {line_number}")
            detections.append(value)
    store.replace_chunk_detections(job_id, index, detections)
    checksum = sha256_file(output)
    elapsed = time.monotonic() - started
    return {
        "path": output,
        "checksum": checksum,
        "frames": source_frames,
        "sampled_frames": expected_frames,
        "frame_step": frame_step,
        "detections": len(detections),
        "duration_seconds": duration,
        "elapsed_seconds": elapsed,
    }
