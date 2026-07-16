from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, BinaryIO

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ytb_vps.config import Settings
from ytb_vps.media import executable, full_decode, probe_video, run_ffmpeg
from ytb_vps.subtitles import srt_timestamp, wrap_two_lines
from ytb_vps.util import atomic_write_text, sha256_file

CJK_PATTERN = re.compile(r"[\u3400-\u9fff]")


def _scheduled_tts_groups(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scheduled: list[dict[str, Any]] = []
    previous_end = float("-inf")
    for group in sorted(
        groups,
        key=lambda item: (float(item["start_seconds"]), int(item.get("group_index", 0))),
    ):
        metadata = group.get("metadata") or {}
        fitted_seconds = float(
            metadata.get(
                "fitted_seconds",
                float(group["end_seconds"]) - float(group["start_seconds"]),
            )
        )
        mix_start = max(float(group["start_seconds"]), previous_end)
        mix_end = mix_start + max(0.001, fitted_seconds)
        scheduled.append(
            {
                **group,
                "mix_start_seconds": mix_start,
                "mix_end_seconds": mix_end,
            }
        )
        previous_end = mix_end
    return scheduled


def schedule_cue_subtitles(
    cues: list[dict[str, Any]], groups: list[dict[str, Any]], *, fps: int, min_subtitle_seconds: float = 0.8
) -> list[dict[str, Any]]:
    by_index = {int(cue["cue_index"]): cue for cue in cues}
    scheduled = []
    scheduled_groups = _scheduled_tts_groups(groups)
    for group_idx, group in enumerate(scheduled_groups):
        cue_indices = tuple(int(value) for value in group.get("metadata", {}).get("cue_indices", ()))
        if not cue_indices:
            continue
        selected = [by_index[index] for index in cue_indices if index in by_index]
        if not selected:
            continue
        audio_start = float(group["mix_start_seconds"])
        audio_end = float(group["mix_end_seconds"])
        audio_duration = max(0.001, audio_end - audio_start)
        next_group_start = float("inf")
        if group_idx + 1 < len(scheduled_groups):
            next_group_start = float(scheduled_groups[group_idx + 1]["mix_start_seconds"])
        min_sec = max(0.05, float(min_subtitle_seconds))
        char_counts = [max(1, len(str(cue["target_text"]))) for cue in selected]
        total_chars = float(sum(char_counts))
        durations = [audio_duration * (c / total_chars) for c in char_counts]
        below = [i for i, d in enumerate(durations) if d < min_sec]
        if below:
            above = [i for i, d in enumerate(durations) if d >= min_sec]
            for i in below:
                durations[i] = min_sec
            if above:
                needed = sum(durations) - audio_duration
                surplus = sum(max(0, durations[i] - min_sec) for i in above)
                if surplus >= needed:
                    scale = max(0.0, (surplus - needed) / surplus) if surplus > 0 else 1.0
                    for i in above:
                        extra = durations[i] - min_sec
                        durations[i] = min_sec + extra * scale
                else:
                    for i in above:
                        durations[i] = min_sec
        total_duration = sum(durations)
        effective_end = audio_end
        if total_duration > audio_duration:
            max_overflow = min_sec
            gap = next_group_start - audio_end
            available_overflow = min(max(0.0, gap), max_overflow)
            overflow_needed = total_duration - audio_duration
            actual_overflow = min(overflow_needed, available_overflow)
            effective_end = audio_end + actual_overflow
            if actual_overflow < overflow_needed:
                available = effective_end - audio_start
                scale = available / total_duration if total_duration > 0 else 1.0
                durations = [d * scale for d in durations]
        cursor = audio_start
        for position, cue in enumerate(selected):
            if position == len(selected) - 1:
                cue_end = effective_end
            else:
                cue_end = cursor + durations[position]
            scheduled.append(
                {
                    **cue,
                    "start_frame": int(round(cursor * fps)),
                    "end_frame": max(int(round(cursor * fps)) + 1, int(round(cue_end * fps))),
                }
            )
            cursor = min(cue_end, effective_end)
    return scheduled


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        block = stream.read(size - len(result))
        if not block:
            break
        result.extend(block)
    return bytes(result)


def _chunk_srt(
    path: Path,
    cues: list[dict[str, Any]],
    *,
    start_seconds: float,
    end_seconds: float,
    fps: int,
) -> None:
    blocks = []
    index = 1
    for cue in cues:
        start = int(cue["start_frame"]) / fps
        end = int(cue["end_frame"]) / fps
        if end <= start_seconds or start >= end_seconds:
            continue
        local_start = max(0.0, start - start_seconds)
        local_end = min(end_seconds - start_seconds, end - start_seconds)
        text = wrap_two_lines(str(cue["target_text"]))
        blocks.append(
            f"{index}\n{srt_timestamp(local_start)} --> {srt_timestamp(local_end)}\n{text}"
        )
        index += 1
    atomic_write_text(path, "\n\n".join(blocks) + ("\n" if blocks else ""))


def _load_font(path: str, size: int):
    configured = Path(path)
    candidates = [
        configured,
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


def _subtitle_layers(
    cues: list[dict[str, Any]],
    *,
    frame_width: int,
    frame_height: int,
    font_file: str,
    font_size: int,
    outline: int,
) -> dict[int, tuple[np.ndarray, np.ndarray, int, int]]:
    font = _load_font(font_file, font_size)
    layers: dict[int, tuple[np.ndarray, np.ndarray, int, int]] = {}
    for cue in cues:
        text = wrap_two_lines(str(cue["target_text"]))
        probe = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        draw = ImageDraw.Draw(probe)
        box = draw.multiline_textbbox(
            (0, 0), text, font=font, stroke_width=outline, align="center", spacing=4
        )
        width = max(1, int(round(box[2] - box[0] + outline * 2)))
        height = max(1, int(round(box[3] - box[1] + outline * 2)))
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.multiline_text(
            (width / 2, outline - box[1]),
            text,
            font=font,
            fill=(255, 255, 255, 255),
            stroke_width=outline,
            stroke_fill=(0, 0, 0, 255),
            anchor="ma",
            align="center",
            spacing=4,
        )
        rgba = np.asarray(image, dtype=np.uint8)
        bgr = rgba[:, :, :3][:, :, ::-1].copy()
        alpha = (rgba[:, :, 3:4].astype(np.float32) / 255.0)
        x = max(0, min(frame_width - width, (frame_width - width) // 2))
        old_center = (int(cue["ymin"]) + int(cue["ymax"])) // 2
        y = max(8, min(frame_height - height - 8, old_center - height // 2))
        layers[int(cue["cue_index"])] = (bgr, alpha, x, y)
    return layers


def _overlay_subtitle(
    frame: np.ndarray, layer: tuple[np.ndarray, np.ndarray, int, int]
) -> None:
    bgr, alpha, x, y = layer
    height, width = bgr.shape[:2]
    target = frame[y : y + height, x : x + width]
    if target.shape != bgr.shape:
        return
    blended = target.astype(np.float32) * (1.0 - alpha) + bgr.astype(np.float32) * alpha
    target[:] = np.clip(blended, 0, 255).astype(np.uint8)


def _overlay_layer(
    frame: np.ndarray, layer: tuple[np.ndarray, np.ndarray, int, int]
) -> None:
    bgr, alpha, x, y = layer
    height, width = bgr.shape[:2]
    frame_height, frame_width = frame.shape[:2]
    if x >= frame_width or y >= frame_height:
        return
    visible_width = min(width, frame_width - x)
    visible_height = min(height, frame_height - y)
    if visible_width <= 0 or visible_height <= 0:
        return
    target = frame[y : y + visible_height, x : x + visible_width]
    source = bgr[:visible_height, :visible_width]
    mask = alpha[:visible_height, :visible_width]
    blended = target.astype(np.float32) * (1.0 - mask) + source.astype(np.float32) * mask
    target[:] = np.clip(blended, 0, 255).astype(np.uint8)


def _logo_layer(
    render: dict[str, Any], *, frame_width: int, frame_height: int
) -> tuple[np.ndarray, np.ndarray, int, int] | None:
    if not bool(render.get("logo_enabled", True)):
        return None
    configured = Path(str(render.get("logo_path", "/opt/ytb-vps/new-logo.png"))).expanduser()
    asset_root = Path(__file__).resolve().parent / "assets"
    candidates = [
        configured,
        Path("/opt/ytb-vps/new-logo.png"),
        asset_root / "new-logo.png",
    ]
    path = next(
        (
            candidate
            for candidate in candidates
            if candidate.exists() and candidate.name == "new-logo.png"
        ),
        None,
    )
    if path is None:
        return None
    image = Image.open(path).convert("RGBA")
    target_width = int(render.get("logo_width_px", 0) or 0)
    if target_width <= 0:
        target_width = int(round(frame_width * float(render.get("logo_width_ratio", 0.16))))
    target_width = max(1, min(frame_width, target_width))
    target_height = max(1, int(round(image.height * target_width / image.width)))
    if target_height > frame_height:
        target_height = frame_height
        target_width = max(1, int(round(image.width * target_height / image.height)))
    resampling = getattr(Image, "Resampling", Image).LANCZOS
    image = image.resize((target_width, target_height), resampling)
    rgba = np.asarray(image, dtype=np.uint8)
    bgr = rgba[:, :, :3][:, :, ::-1].copy()
    alpha = rgba[:, :, 3:4].astype(np.float32) / 255.0
    x = max(0, int(render.get("logo_margin_x", 16)))
    y = max(0, int(render.get("logo_margin_y", 16)))
    return bgr, alpha, x, y


def _ffmpeg_has_encoder(name: str) -> bool:
    try:
        result = subprocess.run(
            [executable("ffmpeg"), "-hide_banner", "-encoders"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=10,
        )
    except Exception:
        return False
    return result.returncode == 0 and name in result.stdout


def _nvidia_available() -> bool:
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
    except Exception:
        return False
    return result.returncode == 0 and "GPU" in result.stdout


def _select_video_encoder(render: dict[str, Any]) -> str:
    configured = str(render.get("encoder", "libx264")).strip().lower()
    if configured == "auto":
        if _nvidia_available() and _ffmpeg_has_encoder("h264_nvenc"):
            return "h264_nvenc"
        return "libx264"
    if configured in {"nvenc", "h264_nvenc"}:
        return "h264_nvenc"
    if configured in {"x264", "libx264"}:
        return "libx264"
    raise ValueError(f"Unknown render.encoder: {configured}")


def _encoder_arguments(
    render: dict[str, Any], *, threads: int, expected_frames: int
) -> list[str]:
    encoder = _select_video_encoder(render)
    if encoder == "h264_nvenc":
        return [
            "-an",
            "-c:v",
            "h264_nvenc",
            "-preset",
            str(render.get("nvenc_preset", "fast")),
            "-cq:v",
            str(int(render.get("nvenc_cq", render.get("crf", 20)))),
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-frames:v",
            str(expected_frames),
        ]
    return [
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        str(render["preset"]),
        "-crf",
        str(int(render["crf"])),
        "-pix_fmt",
        "yuv420p",
        "-threads",
        str(threads),
        "-frames:v",
        str(expected_frames),
    ]

def _transcode_video_arguments(render: dict[str, Any], *, threads: int) -> list[str]:
    encoder = _select_video_encoder(render)
    if encoder == "h264_nvenc":
        return [
            "-c:v",
            "h264_nvenc",
            "-preset",
            str(render.get("nvenc_preset", "fast")),
            "-cq:v",
            str(int(render.get("nvenc_cq", render.get("crf", 20)))),
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        str(render["preset"]),
        "-crf",
        str(int(render["crf"])),
        "-pix_fmt",
        "yuv420p",
        "-threads",
        str(threads),
    ]


def _atempo_filter(speed: float) -> str:
    if speed <= 0:
        raise ValueError("render.output_speed must be greater than zero")
    filters: list[str] = []
    remaining = speed
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def _render_blur_mode(render: dict[str, Any]) -> str:
    configured = str(render.get("blur_mode", "subtitle_band")).strip().lower()
    if configured not in {"ocr_bottom_boxes", "subtitle_band", "bottom", "boxes", "both", "none"}:
        raise ValueError(f"Unknown render.blur_mode: {configured}")
    return configured


def _even(value: int) -> int:
    return value if value % 2 == 0 else value - 1


def _blur_rect_filter(
    render: dict[str, Any], *, width: int, height: int, x: int, y: int, w: int, h: int
) -> str:
    x = max(0, min(width - 2, _even(x)))
    y = max(0, min(height - 2, _even(y)))
    w = max(2, min(width - x, _even(w)))
    h = max(2, min(height - y, _even(h)))
    radius = max(1, int(render["blur_kernel"]) // 2)
    radius = min(radius, max(1, min(w, h) // 2))
    chroma_limit = max(0, ((min(w, h) // 2) - 1) // 2)
    chroma_radius = max(0, min(radius // 2, chroma_limit))
    return (
        f"crop={w}:{h}:{x}:{y},"
        f"boxblur=luma_radius={radius}:luma_power=1:"
        f"chroma_radius={chroma_radius}:chroma_power=1[blurred];"
        f"[base][blurred]overlay={x}:{y}"
    )


def _cluster_subtitle_band_candidates(
    cues: list[dict[str, Any]], *, height: int
) -> list[dict[str, Any]]:
    if not cues:
        return []
    ordered = sorted(cues, key=lambda cue: (int(cue["ymin"]) + int(cue["ymax"])) / 2)
    threshold = max(10.0, height * 0.07)
    clusters: list[list[dict[str, Any]]] = []
    for cue in ordered:
        center = (int(cue["ymin"]) + int(cue["ymax"])) / 2
        if not clusters:
            clusters.append([cue])
            continue
        last = clusters[-1]
        last_center = sum((int(item["ymin"]) + int(item["ymax"])) / 2 for item in last) / len(last)
        if abs(center - last_center) <= threshold:
            last.append(cue)
        else:
            clusters.append([cue])
    return max(
        clusters,
        key=lambda cluster: (
            len(cluster),
            sum(int(item["ymax"]) for item in cluster) / len(cluster),
        ),
    )


def _cluster_subtitle_band_ymax(cues: list[dict[str, Any]], *, height: int) -> list[dict[str, Any]]:
    if not cues:
        return []
    threshold = max(4.0, height * 0.02)
    clusters: list[list[dict[str, Any]]] = []
    for cue in sorted(cues, key=lambda item: int(item["ymax"])):
        ymax = int(cue["ymax"])
        matched = next(
            (
                cluster
                for cluster in clusters
                if abs(ymax - sum(int(item["ymax"]) for item in cluster) / len(cluster))
                <= threshold
            ),
            None,
        )
        if matched is None:
            clusters.append([cue])
        else:
            matched.append(cue)
    return max(
        clusters,
        key=lambda cluster: (
            len(cluster),
            sum(int(item["ymax"]) for item in cluster) / len(cluster),
        ),
    )


def _subtitle_band_geometry(
    render: dict[str, Any],
    *,
    width: int,
    height: int,
    cues: list[dict[str, Any]] | None = None,
) -> tuple[int, int, int, int]:
    def shift_down(x: int, y: int, w: int, h: int) -> tuple[int, int, int, int]:
        offset = int(round(height * float(render.get("subtitle_band_y_offset_ratio", 0.0))))
        offset += int(render.get("subtitle_band_y_offset_px", 0))
        if offset <= 0:
            return x, y, w, h
        return x, min(max(0, height - h), y + offset), w, h

    x_ratio = max(0.0, min(0.98, float(render.get("subtitle_band_x_ratio", 0.0))))
    y_ratio = max(0.0, min(0.98, float(render.get("subtitle_band_y_ratio", 0.78))))
    w_ratio = max(0.02, min(1.0 - x_ratio, float(render.get("subtitle_band_width_ratio", 0.76))))
    h_ratio = max(0.02, min(1.0 - y_ratio, float(render.get("subtitle_band_height_ratio", 0.18))))
    if bool(render.get("subtitle_band_auto", True)) and cues:
        candidate_min_y = height * float(render.get("subtitle_band_candidate_min_y_ratio", 0.58))
        candidate_max_y = height * float(render.get("subtitle_band_candidate_max_y_ratio", 0.98))
        candidates = [
            cue
            for cue in cues
            if CJK_PATTERN.search(str(cue.get("source_text", "")))
            and int(cue.get("ymax", 0)) >= candidate_min_y
            and int(cue.get("ymin", 0)) <= candidate_max_y
            and int(cue.get("ymax", 0)) > int(cue.get("ymin", 0))
        ]
        if len(candidates) >= int(render.get("subtitle_band_min_cues", 1)):
            candidates = _cluster_subtitle_band_ymax(candidates, height=height)
            y = max(0, min(int(cue["ymin"]) for cue in candidates))
            bottom = min(height, max(int(cue["ymax"]) for cue in candidates))
            if bottom - y >= 2:
                return shift_down(0, y, width, bottom - y)
    return shift_down(
        0 if x_ratio <= 0.001 else int(round(width * x_ratio)),
        int(round(height * y_ratio)),
        width if x_ratio <= 0.001 and w_ratio >= 0.999 else int(round(width * w_ratio)),
        int(round(height * h_ratio)),
    )


def _subtitle_band_blur_filter(
    render: dict[str, Any],
    *,
    width: int,
    height: int,
    cues: list[dict[str, Any]] | None = None,
) -> str:
    x, y, w, h = _subtitle_band_geometry(render, width=width, height=height, cues=cues)
    return _blur_rect_filter(
        render,
        width=width,
        height=height,
        x=x,
        y=y,
        w=w,
        h=h,
    )


def _bottom_blur_filter(render: dict[str, Any], *, width: int, height: int) -> str:
    start_ratio = float(render.get("bottom_blur_y_ratio", 0.82))
    start_ratio = max(0.0, min(0.98, start_ratio))
    y = max(0, min(height - 2, int(round(height * start_ratio))))
    return _blur_rect_filter(
        render,
        width=width,
        height=height,
        x=0,
        y=y,
        w=width,
        h=height - y,
    )


def _decoder_filter_arguments(
    render: dict[str, Any],
    *,
    fps: int,
    width: int,
    height: int,
    cues: list[dict[str, Any]] | None = None,
) -> tuple[list[str], bool, bool]:
    blur_mode = _render_blur_mode(render)
    box_blur_in_python = blur_mode in {"ocr_bottom_boxes", "boxes", "both"}
    region_blur_in_ffmpeg = blur_mode in {"subtitle_band", "bottom", "both"}
    mirror_in_decoder = bool(render.get("mirror_video", False)) and not box_blur_in_python
    base = f"fps={fps},scale={width}:{height}"
    if region_blur_in_ffmpeg:
        region = (
            _subtitle_band_blur_filter(render, width=width, height=height, cues=cues)
            if blur_mode == "subtitle_band"
            else _bottom_blur_filter(render, width=width, height=height)
        )
        tail = ",hflip[v]" if mirror_in_decoder else "[v]"
        graph = f"[0:v]{base}[scaled];[scaled]split=2[base][blur];[blur]{region}{tail}"
    else:
        tail = ",hflip" if mirror_in_decoder else ""
        graph = f"[0:v]{base}{tail}[v]"
    return ["-filter_complex", graph, "-map", "[v]"], box_blur_in_python, mirror_in_decoder


def _active_cues(
    cues: list[dict[str, Any]], frame_index: int, cursor: int
) -> tuple[list[dict[str, Any]], int]:
    while cursor < len(cues) and int(cues[cursor]["end_frame"]) <= frame_index:
        cursor += 1
    active = []
    position = cursor
    while position < len(cues) and int(cues[position]["start_frame"]) <= frame_index:
        if int(cues[position]["end_frame"]) > frame_index:
            active.append(cues[position])
        position += 1
    return active, cursor


def _bottom_ocr_box_allowed(
    region: dict[str, Any], render: dict[str, Any], *, width: int, height: int
) -> bool:
    xmin = int(region["xmin"])
    ymin = int(region["ymin"])
    xmax = int(region["xmax"])
    ymax = int(region["ymax"])
    if xmax <= xmin or ymax <= ymin:
        return False
    center_x = ((xmin + xmax) / 2) / width
    center_y = ((ymin + ymax) / 2) / height
    min_y = float(render.get("ocr_box_min_y_ratio", 0.68))
    min_x = float(render.get("ocr_box_min_x_ratio", 0.08))
    max_x = float(render.get("ocr_box_max_x_ratio", 0.92))
    return center_y >= min_y and min_x <= center_x <= max_x


def _blur_box(
    frame: np.ndarray,
    box: tuple[int, int, int, int],
    *,
    kernel: int,
    padding: int,
    padding_x: int | None = None,
    padding_y: int | None = None,
    previous: np.ndarray | None,
    alpha: float,
) -> np.ndarray:
    height, width = frame.shape[:2]
    pad_x = padding if padding_x is None else padding_x
    pad_y = padding if padding_y is None else padding_y
    x1 = max(0, box[0] - pad_x)
    y1 = max(0, box[1] - pad_y)
    x2 = min(width, box[2] + pad_x)
    y2 = min(height, box[3] + pad_y)
    if x2 <= x1 or y2 <= y1:
        return previous if previous is not None else np.empty((0, 0, 3), dtype=np.uint8)
    roi = frame[y1:y2, x1:x2]
    k = max(3, int(kernel) | 1)
    blurred = cv2.GaussianBlur(roi, (k, k), 0)
    if previous is not None and previous.shape == blurred.shape:
        difference = float(cv2.absdiff(previous, blurred).mean())
        if difference < 35:
            blurred = cv2.addWeighted(previous, alpha, blurred, 1 - alpha, 0)
    frame[y1:y2, x1:x2] = blurred
    return blurred


def render_video_chunk(
    *,
    settings: Settings,
    input_path: Path,
    output_path: Path,
    media: dict[str, Any],
    chunk: dict[str, Any],
    cues: list[dict[str, Any]],
    logger: logging.Logger,
    blur_regions: list[dict[str, Any]] | None = None,
    blur_cues: list[dict[str, Any]] | None = None,
    ffmpeg_threads: int | None = None,
) -> dict[str, Any]:
    fps = int(settings.section("media")["target_fps"])
    render = settings.section("render")
    threads = int(ffmpeg_threads or settings.section("media")["ffmpeg_threads"])
    mirror_video = bool(render.get("mirror_video", False))
    width = int(media["width"])
    height = int(media["height"])
    blur_mode = _render_blur_mode(render)
    blur_geometry_cues = blur_cues if blur_cues is not None else cues
    decoder_filter, box_blur_in_python, mirror_in_decoder = _decoder_filter_arguments(
        render, fps=fps, width=width, height=height, cues=blur_geometry_cues
    )
    subtitle_band = (
        _subtitle_band_geometry(render, width=width, height=height, cues=blur_geometry_cues)
        if blur_mode == "subtitle_band"
        else None
    )
    blur_cue_boxes_in_python = blur_mode in {"ocr_bottom_boxes", "boxes", "both"}
    blur_region_boxes_in_python = blur_mode in {"boxes", "both"}
    expected = int(chunk["end_frame"]) - int(chunk["start_frame"])
    duration = float(chunk["end_seconds"]) - float(chunk["start_seconds"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.stem}.part{output_path.suffix}")
    temporary.unlink(missing_ok=True)
    srt_path = output_path.with_suffix(".srt")
    _chunk_srt(
        srt_path,
        cues,
        start_seconds=float(chunk["start_seconds"]),
        end_seconds=float(chunk["end_seconds"]),
        fps=fps,
    )

    decoder_command = [
        executable("ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{float(chunk['start_seconds']):.6f}",
        "-i",
        str(input_path),
        "-an",
        *decoder_filter,
        "-frames:v",
        str(expected),
        "-threads",
        str(threads),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    encoder_command = [
        executable("ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s:v",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "pipe:0",
    ]
    encoder = _select_video_encoder(render)
    logger.info(
        "Render chunk %s | encoder=%s | blur_mode=%s | band=%s | mirror=%s",
        chunk["chunk_index"],
        encoder,
        blur_mode,
        subtitle_band,
        "decoder" if mirror_in_decoder else ("python" if mirror_video else "off"),
    )
    encoder_command.extend(_encoder_arguments(render, threads=threads, expected_frames=expected))
    encoder_command.append(str(temporary))

    start_frame = int(chunk["start_frame"])
    relevant = [
        cue
        for cue in cues
        if int(cue["end_frame"]) > start_frame
        and int(cue["start_frame"]) < int(chunk["end_frame"])
    ]
    relevant_blur = [
        region
        for region in (blur_regions if blur_regions is not None else cues)
        if int(region["end_frame"]) > start_frame
        and int(region["start_frame"]) < int(chunk["end_frame"])
    ]
    relevant_ocr_blur = [
        cue
        for cue in blur_geometry_cues
        if int(cue["end_frame"]) > start_frame
        and int(cue["start_frame"]) < int(chunk["end_frame"])
    ]
    static_blur_regions = [
        region for region in relevant_blur if str(region.get("kind", "")) == "static_blur"
    ]
    timed_blur_regions = [
        region for region in relevant_blur if str(region.get("kind", "")) != "static_blur"
    ]
    relevant.sort(key=lambda item: int(item["start_frame"]))
    relevant_ocr_blur.sort(key=lambda item: int(item["start_frame"]))
    timed_blur_regions.sort(key=lambda item: int(item["start_frame"]))
    static_blur_regions.sort(key=lambda item: int(item["cue_index"]))
    layers = _subtitle_layers(
        relevant,
        frame_width=width,
        frame_height=height,
        font_file=str(render["font_file"]),
        font_size=int(render["font_size"]),
        outline=int(render["outline"]),
    )
    logo_layer = _logo_layer(render, frame_width=width, frame_height=height)
    decoder = subprocess.Popen(decoder_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    encoder = subprocess.Popen(encoder_command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert decoder.stdout is not None and encoder.stdin is not None
    frame_size = width * height * 3
    cursor = 0
    ocr_blur_cursor = 0
    blur_cursor = 0
    previous: dict[int, np.ndarray] = {}
    previous_blur: dict[int, np.ndarray] = {}
    previous_static_blur: dict[int, np.ndarray] = {}
    frames = 0
    last_frame: np.ndarray | None = None
    try:
        while frames < expected:
            raw = _read_exact(decoder.stdout, frame_size)
            if not raw:
                break
            if len(raw) != frame_size:
                raise RuntimeError(f"Render decoder returned a truncated frame: {len(raw)}")
            frame = np.frombuffer(raw, np.uint8).reshape((height, width, 3)).copy()
            global_frame = start_frame + frames
            active_static_blur_ids = set()
            for region in static_blur_regions:
                if not (int(region["start_frame"]) <= global_frame < int(region["end_frame"])):
                    continue
                region_id = int(region["cue_index"])
                active_static_blur_ids.add(region_id)
                x1 = int(region["xmin"])
                x2 = int(region["xmax"])
                if mirror_in_decoder:
                    x1, x2 = width - x2, width - x1
                previous_static_blur[region_id] = _blur_box(
                    frame,
                    (
                        x1,
                        int(region["ymin"]),
                        x2,
                        int(region["ymax"]),
                    ),
                    kernel=int(render["blur_kernel"]),
                    padding=int(render.get("static_blur_padding", render.get("box_padding", 8))),
                    previous=previous_static_blur.get(region_id),
                    alpha=float(render["blur_temporal_alpha"]),
                )
            blur_active, blur_cursor = (
                _active_cues(timed_blur_regions, global_frame, blur_cursor)
                if blur_region_boxes_in_python
                else ([], blur_cursor)
            )
            active_blur_ids = set()
            for region in blur_active:
                region_id = int(region["cue_index"])
                active_blur_ids.add(region_id)
                previous_blur[region_id] = _blur_box(
                    frame,
                    (
                        int(region["xmin"]),
                        int(region["ymin"]),
                        int(region["xmax"]),
                        int(region["ymax"]),
                    ),
                    kernel=int(render["blur_kernel"]),
                    padding=int(render["box_padding"]),
                    padding_x=int(render.get("box_padding_x", render["box_padding"])),
                    padding_y=int(render.get("box_padding_y", render["box_padding"])),
                    previous=previous_blur.get(region_id),
                    alpha=float(render["blur_temporal_alpha"]),
                )
            active, cursor = _active_cues(relevant, global_frame, cursor)
            active_ocr_blur, ocr_blur_cursor = _active_cues(
                relevant_ocr_blur, global_frame, ocr_blur_cursor
            )
            active_ids = set()
            if blur_cue_boxes_in_python:
                for cue in active_ocr_blur:
                    if blur_mode == "ocr_bottom_boxes" and not _bottom_ocr_box_allowed(
                        cue, render, width=width, height=height
                    ):
                        continue
                    cue_id = int(cue["cue_index"])
                    active_ids.add(cue_id)
                    previous[cue_id] = _blur_box(
                        frame,
                        (
                            int(cue["xmin"]),
                            int(cue["ymin"]),
                            int(cue["xmax"]),
                            int(cue["ymax"]),
                        ),
                        kernel=int(render["blur_kernel"]),
                        padding=int(render["box_padding"]),
                        padding_x=int(render.get("box_padding_x", render["box_padding"])),
                        padding_y=int(render.get("box_padding_y", render["box_padding"])),
                        previous=previous.get(cue_id),
                        alpha=float(render["blur_temporal_alpha"]),
                    )
            else:
                active_ids = {int(cue["cue_index"]) for cue in active}
            if mirror_video and not mirror_in_decoder:
                frame = cv2.flip(frame, 1)
            if logo_layer is not None:
                _overlay_layer(frame, logo_layer)
            for cue in active:
                cue_id = int(cue["cue_index"])
                _overlay_subtitle(frame, layers[cue_id])
            previous_static_blur = {
                key: value
                for key, value in previous_static_blur.items()
                if key in active_static_blur_ids
            }
            previous_blur = {
                key: value for key, value in previous_blur.items() if key in active_blur_ids
            }
            previous = {key: value for key, value in previous.items() if key in active_ids}
            encoder.stdin.write(frame.tobytes())
            last_frame = frame
            frames += 1
            if frames == 1 or frames % 300 == 0 or frames == expected:
                logger.info("Render chunk %s | %d/%d frames", chunk["chunk_index"], frames, expected)
        if frames < expected and frames >= expected - 1 and last_frame is not None:
            encoder.stdin.write(last_frame.tobytes())
            frames += 1
        encoder.stdin.close()
        encoder_error = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
        encoder_code = encoder.wait()
        decoder_error = decoder.stderr.read().decode("utf-8", errors="replace") if decoder.stderr else ""
        decoder_code = decoder.wait()
    except BrokenPipeError as exc:
        encoder.stdin.close()
        decoder.terminate()
        decoder.wait(timeout=10)
        encoder_error = (
            encoder.stderr.read().decode("utf-8", errors="replace")
            if encoder.stderr
            else ""
        )
        encoder.wait(timeout=10)
        raise RuntimeError(f"Render encoder closed its pipe: {encoder_error[-2000:]}") from exc
    except BaseException:
        decoder.terminate()
        encoder.terminate()
        try:
            decoder.wait(timeout=10)
            encoder.wait(timeout=10)
        except subprocess.TimeoutExpired:
            decoder.kill()
            encoder.kill()
        raise
    finally:
        decoder.stdout.close()
        if decoder.stderr:
            decoder.stderr.close()
        if encoder.stderr:
            encoder.stderr.close()
    if frames != expected or decoder_code != 0:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(
            f"Render decode failed ({frames}/{expected}, code={decoder_code}): {decoder_error[-1500:]}"
        )
    if encoder_code != 0:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Render encode failed: {encoder_error[-1500:]}")
    os.replace(temporary, output_path)
    full_decode(output_path)
    rendered = probe_video(output_path)
    if abs(float(rendered["duration_seconds"]) - duration) > 1.0 / fps + 0.08:
        raise RuntimeError(f"Rendered chunk duration mismatch: {rendered['duration_seconds']} vs {duration}")
    return {"path": str(output_path), "checksum": sha256_file(output_path), "frames": frames}


def compose_audio_chunk(
    *,
    groups: list[dict[str, Any]],
    chunk: dict[str, Any],
    output: Path,
    input_path: Path | None = None,
    original_volume: float = 0.0,
    duck_volume: float | None = None,
    ducking_enabled: bool = False,
) -> dict[str, Any]:
    start = float(chunk["start_seconds"])
    end = float(chunk["end_seconds"])
    duration = end - start
    selected = [
        group
        for group in _scheduled_tts_groups(groups)
        if float(group["mix_end_seconds"]) > start
        and float(group["mix_start_seconds"]) < end
        and group["status"] == "DONE"
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.part{output.suffix}")
    temporary.unlink(missing_ok=True)
    original_volume = max(0.0, float(original_volume))
    has_original = input_path is not None and original_volume > 0
    duck_volume = original_volume if duck_volume is None else max(0.0, float(duck_volume))
    if not selected and not has_original:
        run_ffmpeg(
            [
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-t",
                f"{duration:.6f}",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(temporary),
            ],
            duration_seconds=duration,
        )
    else:
        inputs = []
        filters = []
        labels = []
        input_index = 0
        if has_original:
            inputs.extend(
                [
                    "-ss",
                    f"{start:.6f}",
                    "-t",
                    f"{duration:.6f}",
                    "-i",
                    str(input_path),
                ]
            )
            original_chain = f"[{input_index}:a]volume={original_volume:.6f}"
            if ducking_enabled and selected and duck_volume < original_volume:
                multiplier = max(0.0, min(1.0, duck_volume / original_volume))
                intervals = []
                for group in selected:
                    interval_start = max(0.0, float(group["mix_start_seconds"]) - start)
                    interval_end = min(duration, float(group["mix_end_seconds"]) - start)
                    if interval_end > interval_start:
                        intervals.append((interval_start, interval_end))
                for interval_start, interval_end in intervals:
                    original_chain += (
                        f",volume={multiplier:.6f}:"
                        f"enable='between(t,{interval_start:.3f},{interval_end:.3f})'"
                    )
            filters.append(
                f"{original_chain},"
                f"apad,atrim=0:{duration:.6f},asetpts=N/SR/TB[aorig]"
            )
            labels.append("[aorig]")
            input_index += 1
        for group in selected:
            inputs.extend(["-i", str(group["fitted_path"])])
            group_start = float(group["mix_start_seconds"])
            group_end = float(group["mix_end_seconds"])
            trim_start = max(0.0, start - group_start)
            trim_end = max(trim_start + 0.001, min(group_end - group_start, end - group_start))
            delay = max(0, int(round((group_start - start) * 1000)))
            label = f"a{input_index}"
            filters.append(
                f"[{input_index}:a]atrim=start={trim_start:.6f}:end={trim_end:.6f},"
                f"asetpts=PTS-STARTPTS,adelay={delay}|{delay}[{label}]"
            )
            labels.append(f"[{label}]")
            input_index += 1
        filters.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0,"
            f"apad,atrim=0:{duration:.6f}[mix]"
        )
        filter_script = output.with_suffix(".filter.txt")
        atomic_write_text(filter_script, ";".join(filters))
        run_ffmpeg(
            [
                "-y",
                *inputs,
                "-filter_complex_script",
                str(filter_script),
                "-map",
                "[mix]",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(temporary),
            ],
            duration_seconds=duration,
        )
    os.replace(temporary, output)
    return {
        "path": str(output),
        "checksum": sha256_file(output),
        "groups": len(selected),
        "original_volume": original_volume if has_original else 0.0,
        "duck_volume": duck_volume if has_original and ducking_enabled else None,
    }


def mux_chunk(video: Path, audio: Path, output: Path) -> None:
    temporary = output.with_name(f".{output.stem}.part{output.suffix}")
    run_ffmpeg(
        [
            "-y",
            "-i",
            str(video),
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c",
            "copy",
            "-shortest",
            str(temporary),
        ]
    )
    os.replace(temporary, output)


def concat_chunks(chunks: list[Path], output: Path) -> None:
    if not chunks:
        raise RuntimeError("No render chunks to concatenate")
    manifest = output.with_suffix(".concat.txt")
    lines = ["ffconcat version 1.0"]
    for path in chunks:
        escaped = path.resolve().as_posix().replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    atomic_write_text(manifest, "\n".join(lines) + "\n")
    temporary = output.with_name(f".{output.stem}.part{output.suffix}")
    run_ffmpeg(
        [
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(manifest),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(temporary),
        ]
    )
    os.replace(temporary, output)


def speed_up_media(
    input_path: Path,
    output_path: Path,
    *,
    speed: float,
    render: dict[str, Any],
    threads: int,
) -> None:
    if speed <= 0:
        raise ValueError("render.output_speed must be greater than zero")
    temporary = output_path.with_name(f".{output_path.stem}.part{output_path.suffix}")
    temporary.unlink(missing_ok=True)
    if abs(speed - 1.0) < 0.001:
        shutil.copy2(input_path, temporary)
        os.replace(temporary, output_path)
        return
    run_ffmpeg(
        [
            "-y",
            "-i",
            str(input_path),
            "-filter_complex",
            f"[0:v]setpts=PTS/{speed:.6f}[v];[0:a]{_atempo_filter(speed)}[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            *_transcode_video_arguments(render, threads=threads),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(temporary),
        ]
    )
    os.replace(temporary, output_path)


def validate_final(
    path: Path,
    expected: dict[str, Any],
    fps: int,
    *,
    duration_seconds: float | None = None,
) -> dict[str, Any]:
    media = probe_video(path)
    if not media["has_audio"]:
        raise RuntimeError("Final output has no audio")
    if abs(float(media["fps"]) - fps) > 0.01:
        raise RuntimeError(f"Final FPS is {media['fps']}, expected {fps}")
    target_duration = (
        float(expected["duration_seconds"])
        if duration_seconds is None
        else float(duration_seconds)
    )
    if abs(float(media["duration_seconds"]) - target_duration) > 0.5:
        raise RuntimeError(
            f"Final duration does not match expected duration: "
            f"{media['duration_seconds']} vs {target_duration}"
        )
    full_decode(path)
    return {**media, "full_decode": True, "checksum": sha256_file(path)}
