from __future__ import annotations

import copy
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


DEFAULTS: dict[str, Any] = {
    "runtime": {
        "data_root": "/srv/ytb-vps",
        "secrets_root": "/root/.config/ytb-vps/secrets",
        "lock_file": "/run/lock/ytb-vps.lock",
    },
    "queue": {
        "extensions": [".mp4", ".mkv", ".mov", ".webm"],
        "continue_after_failure": True,
        "auto_sync_input": True,
        "background_backup": True,
        "wait_for_background_backup": False,
        "backup_workers": 1,
        "cleanup_after_upload": True,
        "poll_interval_seconds": 30,
    },
    "media": {
        "target_fps": 30,
        "max_width": 1920,
        "max_height": 1080,
        "chunk_seconds": 120,
        "fallback_chunk_seconds": 120,
        "ffmpeg_threads": 6,
    },
    "resources": {
        "minimum_free_gib": 30,
        "minimum_free_inodes": 10_000,
        "required_swap_gib": 0,
        "omp_threads": 1,
    },
    "ocr": {
        "backend": "auto",
        "container_image": "ytb-vps-ocr-legacy:0.1.0",
        "onnx_python": "/opt/ytb-vps-ocr-onnx/bin/python",
        "onnx_worker": "/opt/ytb-vps/containers/ocr-onnx/worker.py",
        "onnx_library_path": "/opt/ytb-vps-ocr-onnx/lib/python3.10/site-packages/nvidia/cudnn/lib:/usr/local/cuda/targets/x86_64-linux/lib:/usr/lib/wsl/lib",
        "gpu_memory_mb": 5200,
        "sample_fps": 2.0,
        "scan_width": 640,
        "parallel_chunks": 1,
        "ffmpeg_threads": 2,
        "omp_threads": 1,
        "onnx_intra_threads": 1,
        "onnx_inter_threads": 1,
        "language": "ch",
        "minimum_confidence": 0.55,
        "scan_min_y_ratio": 0.0,
        "scan_max_y_ratio": 1.0,
        "subtitle_min_y_ratio": 0.58,
        "subtitle_max_y_ratio": 0.96,
        "subtitle_center_min_x_ratio": 0.20,
        "subtitle_center_max_x_ratio": 0.80,
        "subtitle_center_min_y_ratio": 0.86,
        "retry_attempts": 2,
        "det_model_dir": "/models/ch_PP-OCRv3_det_infer",
        "rec_model_dir": "/models/ch_PP-OCRv3_rec_infer",
    },
    "tracking": {
        "max_gap_frames": 15,
        "minimum_duration_frames": 3,
        "cue_lead_frames": 3,
        "cue_tail_frames": 3,
        "cue_min_gap_frames": 1,
        "cue_prevent_overlap": True,
        "text_similarity": 0.72,
        "line_cluster_y_ratio": 0.055,
        "minimum_text_chars": 2,
        "box_padding": 6,
        "static_blur_enabled": True,
        "static_blur_sample_frames": 10,
        "static_blur_min_samples": 5,
        "static_blur_position_tolerance_px": 12,
        "static_blur_min_y_ratio": 0.0,
        "static_blur_max_y_ratio": 1.0,
        "static_blur_subtitle_padding": 6,
    },
    "translation": {
        "mode": "cue_translation",
        "codex_executable": "codex",
        "model": "cx/gpt-5.5-xhigh",
        "style_version": 5,
        "batch_size": 150,
        "timeout_seconds": 900,
        "retry_attempts": 2,
        "skip_failed_cues": True,
        "max_skipped_cues": 3,
        "scene_gap_seconds": 1.2,
        "scene_max_seconds": 24.0,
        "scene_max_source_chars": 1800,
        "scene_timing_tolerance_seconds": 1.5,
        "scene_retry_attempts": 2,
        "scene_tts_max_speed": 1.18,
    },
    "tts": {
        "voice": "BV074_streaming",
        "resource_id": "7102355709945188865",
        "rate": "1.0",
        "group_gap_seconds": 0.0,
        "short_group_gap_seconds": 0.45,
        "short_group_min_duration_seconds": 1.4,
        "slot_borrow_seconds": 0.0,
        "micro_spill_seconds": 0.0,
        "allow_tts_spill": False,
        "max_group_chars": 90,
        "max_group_duration_seconds": 4.0,
        "query_attempts": 40,
        "query_interval_seconds": 2.0,
        "retry_attempts": 3,
        "shorten_attempts": 0,
        "max_fit_speed": 1.35,
        "hard_fit_speed": 1.35,
        "fit_tolerance_seconds": 0.08,
        "silence_trim_enabled": True,
        "silence_trim_threshold_db": -45,
        "silence_trim_start_duration": 0.02,
        "silence_trim_stop_duration": 0.05,
        "device_json": "/root/.config/ytb-vps/secrets/capcut-device.json",
    },
    "render": {
        "font_file": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "font_size": 42,
        "outline": 4,
        "encoder": "auto",
        "nvenc_preset": "fast",
        "nvenc_cq": 20,
        "crf": 20,
        "preset": "veryfast",
        "mirror_video": True,
        "blur_mode": "subtitle_band",
        "subtitle_band_auto": True,
        "output_speed": 1.0,
        "original_audio_volume": 0.2,
        "original_audio_duck_volume": 0.08,
        "audio_ducking_enabled": True,
        "bottom_blur_y_ratio": 0.82,
        "subtitle_band_x_ratio": 0.0,
        "subtitle_band_y_ratio": 0.83,
        "subtitle_band_width_ratio": 1.0,
        "subtitle_band_height_ratio": 0.14,
        "subtitle_band_min_cues": 1,
        "subtitle_band_candidate_min_y_ratio": 0.58,
        "subtitle_band_candidate_max_y_ratio": 0.98,
        "subtitle_band_y_offset_ratio": 0.0,
        "ocr_box_min_y_ratio": 0.68,
        "ocr_box_min_x_ratio": 0.08,
        "ocr_box_max_x_ratio": 0.92,
        "blur_kernel": 41,
        "blur_temporal_alpha": 0.72,
        "box_padding": 18,
        "box_padding_x": 10,
        "box_padding_y": 4,
        "static_blur_padding": 4,
        "logo_enabled": True,
        "logo_path": "/opt/ytb-vps/new-logo.png",
        "logo_width_ratio": 0.192,
        "logo_margin_x": 16,
        "logo_margin_y": 16,
    },
    "drive": {
        "enabled": True,
        "remote_root": "gdrive:YTB-VPS",
        "config_file": "/root/.config/ytb-vps/secrets/rclone.conf",
        "transfers": 1,
        "checkers": 2,
        "retry_attempts": 5,
        "chunk_size": "1M",
        "disable_http2": True,
    },
}


def processing_config(settings: "Settings") -> dict[str, Any]:
    config = {
        name: copy.deepcopy(settings.raw[name])
        for name in ("media", "ocr", "tracking", "translation", "tts", "render")
    }
    for name in (
        "logo_enabled",
        "logo_path",
        "logo_width_px",
        "logo_width_ratio",
        "logo_margin_x",
        "logo_margin_y",
    ):
        config["render"].pop(name, None)
    for name in (
        "parallel_chunks",
        "ffmpeg_threads",
        "omp_threads",
        "onnx_intra_threads",
        "onnx_inter_threads",
        "gpu_memory_mb",
    ):
        config["ocr"].pop(name, None)
    config["tts"].pop("micro_spill_seconds", None)
    return config


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


@dataclass(frozen=True)
class Settings:
    raw: dict[str, Any]
    source: Path | None = None

    def section(self, name: str) -> dict[str, Any]:
        value = self.raw.get(name)
        if not isinstance(value, dict):
            raise ValueError(f"Configuration section is missing: {name}")
        return value

    @property
    def data_root(self) -> Path:
        return Path(self.section("runtime")["data_root"]).expanduser()

    @property
    def secrets_root(self) -> Path:
        return Path(self.section("runtime")["secrets_root"]).expanduser()

    def data_path(self, name: str) -> Path:
        allowed = {"input", "work", "output", "logs", "models", "cache"}
        if name not in allowed:
            raise ValueError(f"Unknown managed data path: {name}")
        return self.data_root / name

    def ensure_layout(self) -> None:
        for name in ("input", "work", "output", "logs", "models", "cache"):
            self.data_path(name).mkdir(parents=True, exist_ok=True)


def validate(settings: Settings) -> None:
    media = settings.section("media")
    if int(media["target_fps"]) <= 0:
        raise ValueError("media.target_fps must be positive")
    sample_fps = float(settings.section("ocr").get("sample_fps", media["target_fps"]))
    if sample_fps <= 0 or sample_fps > int(media["target_fps"]):
        raise ValueError("ocr.sample_fps must be positive and no greater than media.target_fps")
    if int(media["chunk_seconds"]) < 10:
        raise ValueError("media.chunk_seconds must be at least 10")
    if int(media["max_width"]) <= 0 or int(media["max_height"]) <= 0:
        raise ValueError("media maximum dimensions must be positive")
    if not settings.section("queue").get("extensions"):
        raise ValueError("queue.extensions must not be empty")
    translation = settings.section("translation")
    if int(translation.get("max_skipped_cues", 0)) < 0:
        raise ValueError("translation.max_skipped_cues must not be negative")
    if translation.get("mode", "cue_translation") not in {"cue_translation", "scene_voiceover"}:
        raise ValueError("translation.mode must be cue_translation or scene_voiceover")
    if float(translation.get("scene_gap_seconds", 1.2)) < 0:
        raise ValueError("translation.scene_gap_seconds must not be negative")
    if float(translation.get("scene_max_seconds", 24.0)) <= 0:
        raise ValueError("translation.scene_max_seconds must be positive")
    if int(translation.get("scene_max_source_chars", 1800)) <= 0:
        raise ValueError("translation.scene_max_source_chars must be positive")
    if float(translation.get("scene_timing_tolerance_seconds", 1.5)) < 0:
        raise ValueError("translation.scene_timing_tolerance_seconds must not be negative")
    if float(translation.get("scene_tts_max_speed", 1.18)) < 1.0:
        raise ValueError("translation.scene_tts_max_speed must be at least 1.0")
    drive = settings.section("drive")
    if drive.get("enabled") and not str(drive.get("remote_root", "")).strip():
        raise ValueError("drive.remote_root is required when Drive is enabled")
    if drive.get("enabled") and not str(drive.get("config_file", "")).strip():
        raise ValueError("drive.config_file is required when Drive is enabled")


def load_settings(path: str | Path | None = None) -> Settings:
    chosen: Path | None
    if path is not None:
        chosen = Path(path).expanduser()
    elif os.environ.get("YTB_VPS_CONFIG"):
        chosen = Path(os.environ["YTB_VPS_CONFIG"]).expanduser()
    else:
        system = Path("/etc/ytb-vps/config.yaml")
        chosen = system if system.exists() else None

    override: dict[str, Any] = {}
    if chosen is not None:
        if not chosen.exists():
            raise FileNotFoundError(f"Configuration file not found: {chosen}")
        loaded = yaml.safe_load(chosen.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ValueError("Configuration root must be a mapping")
        override = loaded
    settings = Settings(_merge(DEFAULTS, override), chosen)
    validate(settings)
    return settings


