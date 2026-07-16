from __future__ import annotations

import json
import os
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable


def executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(f"Required executable is not in PATH: {name}")
    return path


def parse_rate(value: str | None) -> float:
    if not value or value in {"0/0", "N/A"}:
        return 0.0
    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return float(value)


def probe_video(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            executable("ffprobe"),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    videos = [item for item in payload.get("streams", []) if item.get("codec_type") == "video"]
    audios = [item for item in payload.get("streams", []) if item.get("codec_type") == "audio"]
    if not videos:
        raise RuntimeError(f"Input has no video stream: {path.name}")
    video = videos[0]
    duration = float(
        video.get("duration")
        or payload.get("format", {}).get("duration")
        or 0.0
    )
    fps = parse_rate(video.get("avg_frame_rate") or video.get("r_frame_rate"))
    frames = int(video.get("nb_frames") or 0)
    if frames <= 0 and duration > 0 and fps > 0:
        frames = int(round(duration * fps))
    return {
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": fps,
        "duration_seconds": duration,
        "frame_count": frames,
        "video_codec": video.get("codec_name"),
        "pixel_format": video.get("pix_fmt"),
        "has_audio": bool(audios),
        "audio_codec": audios[0].get("codec_name") if audios else None,
    }


def validate_media_limits(media: dict[str, Any], config: dict[str, Any]) -> None:
    width = int(media["width"])
    height = int(media["height"])
    if width > int(config["max_width"]) or height > int(config["max_height"]):
        raise RuntimeError(
            f"Input is {width}x{height}; maximum is "
            f"{config['max_width']}x{config['max_height']}"
        )
    if float(media["fps"]) > float(config["target_fps"]) + 0.01:
        raise RuntimeError(
            f"Input is {media['fps']:.3f} FPS; maximum is {config['target_fps']} FPS"
        )
    if float(media["duration_seconds"]) <= 0:
        raise RuntimeError("Could not determine input duration")


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            executable("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError(f"Could not determine duration for {path}") from exc


def normalized_frame_count(duration_seconds: float, fps: int) -> int:
    return max(1, int(round(duration_seconds * fps)))


def plan_chunks(
    duration_seconds: float,
    *,
    fps: int,
    chunk_seconds: int,
) -> list[dict[str, int | float]]:
    total_frames = normalized_frame_count(duration_seconds, fps)
    chunk_frames = max(fps, int(chunk_seconds * fps))
    chunks: list[dict[str, int | float]] = []
    for index, start_frame in enumerate(range(0, total_frames, chunk_frames)):
        end_frame = min(total_frames, start_frame + chunk_frames)
        chunks.append(
            {
                "index": index,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "start_seconds": start_frame / fps,
                "end_seconds": min(duration_seconds, end_frame / fps),
            }
        )
    return chunks


def plan_render_chunks(
    duration_seconds: float,
    *,
    fps: int,
    chunk_seconds: int,
    cues: list[dict[str, Any]],
) -> list[dict[str, int | float]]:
    """Plan bounded chunks without separating a micro cue from its successor."""
    total_frames = normalized_frame_count(duration_seconds, fps)
    target = max(fps, chunk_seconds * fps)
    chunks: list[dict[str, int | float]] = []
    start = 0
    while start < total_frames:
        end = min(total_frames, start + target)
        if end < total_frames:
            changed = True
            while changed:
                changed = False
                for cue in cues:
                    cue_start = int(cue["start_frame"])
                    cue_end = int(cue["end_frame"])
                    if cue_start < end < cue_end:
                        end = min(total_frames, cue_end)
                        changed = True
                for index, cue in enumerate(cues[:-1]):
                    cue_start = int(cue["start_frame"])
                    cue_end = int(cue["end_frame"])
                    next_cue = cues[index + 1]
                    next_start = int(next_cue["start_frame"])
                    next_end = int(next_cue["end_frame"])
                    if (
                        cue_end - cue_start <= int(round(0.8 * fps))
                        and next_start - cue_end <= int(round(0.6 * fps))
                        and cue_end <= end <= next_start
                    ):
                        end = min(total_frames, next_end)
                        changed = True
        if end <= start:
            raise RuntimeError("Render chunk planner made no progress")
        chunks.append(
            {
                "index": len(chunks),
                "start_frame": start,
                "end_frame": end,
                "start_seconds": start / fps,
                "end_seconds": min(duration_seconds, end / fps),
            }
        )
        start = end
    return chunks


def run_ffmpeg(
    arguments: list[str],
    *,
    duration_seconds: float = 0,
    progress: Callable[[float], None] | None = None,
) -> None:
    command = [
        executable("ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        *arguments,
    ]
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creation_flags,
    )
    assert process.stdout is not None
    tail: list[str] = []
    try:
        for raw in process.stdout:
            line = raw.strip()
            tail.append(line)
            tail = tail[-30:]
            if progress is None or not line.startswith("out_time_ms="):
                continue
            try:
                current = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            progress(min(1.0, current / duration_seconds) if duration_seconds else 0.0)
        code = process.wait()
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        raise
    finally:
        process.stdout.close()
    if code != 0:
        raise RuntimeError("FFmpeg failed:\n" + "\n".join(tail[-15:]))


def full_decode(path: Path) -> None:
    run_ffmpeg(["-i", str(path), "-f", "null", "-"])
