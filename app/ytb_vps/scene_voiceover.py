from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from ytb_vps.config import Settings
from ytb_vps.state import JobStore
from ytb_vps.translation import CodexTranslator, TranslationError
from ytb_vps.tts import CapCutDevicePool, TtsFitError, fit_audio, is_capcut_shark_block
from ytb_vps.util import config_fingerprint, sha256_file


def enabled(settings: Settings) -> bool:
    return str(settings.section("translation").get("mode", "cue_translation")) == "scene_voiceover"


def build_scenes(cues: list[dict[str, Any]], *, fps: int, config: dict[str, Any]) -> list[dict[str, Any]]:
    gap_frames = round(float(config.get("scene_gap_seconds", 1.2)) * fps)
    max_frames = max(1, round(float(config.get("scene_max_seconds", 24.0)) * fps))
    max_chars = max(1, int(config.get("scene_max_source_chars", 1800)))
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    chars = 0
    for cue in cues:
        cue_chars = len(str(cue["source_text"]))
        split = bool(current) and (
            int(cue["start_frame"]) - int(current[-1]["end_frame"]) >= gap_frames
            or int(cue["end_frame"]) - int(current[0]["start_frame"]) > max_frames
            or chars + cue_chars > max_chars
        )
        if split:
            groups.append(current)
            current, chars = [], 0
        current.append(cue)
        chars += cue_chars
    if current:
        groups.append(current)
    return [_scene(index, entries) for index, entries in enumerate(groups)]


def _scene(index: int, entries: list[dict[str, Any]]) -> dict[str, Any]:
    source_text = "\n".join(str(item["source_text"]) for item in entries)
    cue_indices = [int(item["cue_index"]) for item in entries]
    return {
        "scene_index": index,
        "start_frame": int(entries[0]["start_frame"]),
        "end_frame": int(entries[-1]["end_frame"]),
        "cue_indices": cue_indices,
        "source_text": source_text,
        "source_hash": config_fingerprint({"cue_indices": cue_indices, "source_text": source_text}),
        "xmin": min(int(item["xmin"]) for item in entries),
        "ymin": min(int(item["ymin"]) for item in entries),
        "xmax": max(int(item["xmax"]) for item in entries),
        "ymax": max(int(item["ymax"]) for item in entries),
    }


def plan_scenes(settings: Settings, store: JobStore, job_id: str) -> list[dict[str, Any]]:
    scenes = build_scenes(
        store.cues(job_id),
        fps=int(settings.section("media")["target_fps"]),
        config=settings.section("translation"),
    )
    if not scenes:
        raise TranslationError("No scenes created from OCR cues")
    store.replace_scenes(job_id, scenes)
    return store.scenes(job_id)


def _prompt(scene: dict[str, Any], *, prior_summary: str, fps: int) -> str:
    seconds = (int(scene["end_frame"]) - int(scene["start_frame"])) / fps
    payload = {
        "scene_id": int(scene["scene_index"]) + 1,
        "duration_seconds": round(seconds, 3),
        "maximum_vietnamese_characters": max(24, min(360, round(seconds * 15))),
        "prior_scene_summary": prior_summary,
        "chinese_source": str(scene["source_text"]),
    }
    # ponytail: one narration segment per scene; split into writer segments when per-sentence timing is needed.
    return (
        "Viết VOICEOVER tiếng Việt tự nhiên cho MỘT cảnh. Không dịch từng cue. "
        "Giữ sự kiện chính, nhân vật, quan hệ, trình tự, nhân quả; nén vừa phải bằng cách bỏ lặp/chi tiết phụ. "
        "Không thêm sự kiện, suy đoán, spoiler, nhãn người nói, markdown hay giải thích. "
        "Output schema bắt buộc có một translations array. Trả một object id=scene_id và text là toàn bộ lời kể cảnh.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )


def write_scenes(
    *, settings: Settings, store: JobStore, job_id: str, workspace: Path, logger: logging.Logger
) -> list[dict[str, Any]]:
    fps = int(settings.section("media")["target_fps"])
    attempts = max(1, int(settings.section("translation").get("scene_retry_attempts", 2)))
    writer = CodexTranslator(settings, workspace, logger)
    summary = ""
    for scene in plan_scenes(settings, store, job_id):
        if scene["status"] == "DONE":
            summary = str(scene.get("summary") or summary)
            continue
        if scene["status"] == "SKIPPED":
            continue
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                store.start_scene(job_id, int(scene["scene_index"]))
                proxy = {
                    "cue_index": int(scene["scene_index"]) + 1,
                    "source_hash": scene["source_hash"],
                }
                result = writer._run_prompt(
                    [proxy],
                    prompt=_prompt(scene, prior_summary=summary, fps=fps),
                    signature_payload={
                        "purpose": "scene-voiceover", "revision": 1,
                        "scene": [scene["source_hash"], summary],
                        "model": settings.section("translation").get("model"),
                    },
                    cache_prefix="scene",
                )
                narration = result[int(proxy["cue_index"])]
                scene_summary = narration[:240]
                store.complete_scene(
                    job_id, int(scene["scene_index"]), summary=scene_summary, narration=narration
                )
                summary = scene_summary
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                logger.warning("Scene %d writer attempt %d failed: %s", scene["scene_index"], attempt, exc)
        if last_error is not None:
            logger.error("Scene %d skipped: %s", scene["scene_index"], last_error)
            store.skip_scene(job_id, int(scene["scene_index"]), str(last_error))
    return store.scenes(job_id)


def _shorten_prompt(scene: dict[str, Any], *, fps: int, required_speed: float) -> str:
    seconds = (int(scene["end_frame"]) - int(scene["start_frame"])) / fps
    payload = {
        "scene_id": int(scene["scene_index"]) + 1,
        "duration_seconds": round(seconds, 3),
        "required_speed": round(required_speed, 3),
        "current_narration": str(scene["narration"]),
        "chinese_source": str(scene["source_text"]),
    }
    return (
        "Rút ngắn lời VOICEOVER Việt cho một cảnh để TTS vừa thời lượng. "
        "Giữ các ý chính, nhân vật, trình tự và nhân quả; bỏ lặp/chi tiết phụ; không thêm thông tin. "
        "Output schema bắt buộc có một translations array, object id=scene_id, text là lời kể mới.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )


def synthesize_scenes(
    *, settings: Settings, store: JobStore, job_id: str, workspace: Path, logger: logging.Logger
) -> list[dict[str, Any]]:
    fps = int(settings.section("media")["target_fps"])
    translation = settings.section("translation")
    config = settings.section("tts")
    attempts = max(1, int(translation.get("scene_retry_attempts", 2)))
    max_speed = float(translation.get("scene_tts_max_speed", 1.18))
    writer = CodexTranslator(settings, workspace, logger)
    pool = CapCutDevicePool(config, workspace, logger)
    raw_dir = workspace / "voiceover" / "raw"
    fitted_dir = workspace / "voiceover" / "fitted"
    for scene in store.scenes(job_id):
        index = int(scene["scene_index"])
        if scene["status"] != "DONE":
            continue
        segment = next(
            (item for item in store.voiceover_segments(job_id) if int(item["scene_index"]) == index), None
        )
        if segment and segment["status"] == "DONE" and Path(str(segment["audio_path"])).exists():
            continue
        slot = (int(scene["end_frame"]) - int(scene["start_frame"])) / fps
        narration = str(scene["narration"])
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            client = None
            try:
                signature = config_fingerprint({"scene": index, "text": narration, "voice": config["voice"], "rate": config["rate"]})
                raw = raw_dir / f"scene_{index:05d}_{signature[:12]}.mp3"
                fitted = fitted_dir / f"scene_{index:05d}_{signature[:12]}.wav"
                raw.parent.mkdir(parents=True, exist_ok=True)
                if not raw.exists() or raw.stat().st_size < 1024:
                    client = pool.acquire_client()
                    client.synthesize(narration, raw)
                    pool.mark_success(client.device_path)
                metadata = fit_audio(
                    raw, fitted, slot, max_speed=max_speed, hard_speed=max_speed,
                    tolerance_seconds=float(config.get("fit_tolerance_seconds", 0.08)),
                    silence_trim=bool(config.get("silence_trim_enabled", True)),
                    silence_threshold_db=float(config.get("silence_trim_threshold_db", -45)),
                    silence_start_duration=float(config.get("silence_trim_start_duration", 0.02)),
                    silence_stop_duration=float(config.get("silence_trim_stop_duration", 0.05)),
                )
                store.complete_voiceover_segment(
                    job_id, index, fitted_path=fitted, duration_seconds=float(metadata["fitted_seconds"]),
                    speed=float(metadata["speed"]), fps=fps,
                )
                last_error = None
                break
            except TtsFitError as exc:
                last_error = exc
                if attempt < attempts:
                    try:
                        proxy = {"cue_index": index + 1, "source_hash": scene["source_hash"]}
                        shortened = writer._run_prompt(
                            [proxy],
                            prompt=_shorten_prompt(scene, fps=fps, required_speed=float(exc.required_speed or max_speed)),
                            signature_payload={"purpose": "shorten-scene-voiceover", "scene": [scene["source_hash"], narration]},
                            cache_prefix="shorten_scene",
                        )[index + 1]
                        narration = shortened
                        store.complete_scene(job_id, index, summary=str(scene.get("summary") or ""), narration=narration)
                        scene = next(item for item in store.scenes(job_id) if int(item["scene_index"]) == index)
                    except Exception as shorten_error:
                        last_error = shorten_error
                        logger.warning("Scene %d rewrite failed: %s", index, shorten_error)
                        break
            except Exception as exc:
                last_error = exc
                if is_capcut_shark_block(exc) and client is not None:
                    pool.mark_blocked(client.device_path, exc)
                logger.warning("Scene %d TTS attempt %d failed: %s", index, attempt, exc)
            finally:
                if client is not None:
                    pool.release_client(client.device_path)
        if last_error is not None:
            store.skip_scene(job_id, index, str(last_error))
            store.skip_voiceover_segment(job_id, index, str(last_error))
    return store.voiceover_segments(job_id)


def display_cues(store: JobStore, job_id: str) -> list[dict[str, Any]]:
    scenes = {int(scene["scene_index"]): scene for scene in store.scenes(job_id)}
    result = []
    for segment in store.voiceover_segments(job_id):
        if segment["status"] != "DONE":
            continue
        scene = scenes[int(segment["scene_index"])]
        parts = _subtitle_parts(str(segment["text"]))
        total = max(1, sum(len(part) for part in parts))
        start = int(segment["start_frame"])
        end = int(segment["end_frame"])
        cursor = start
        for part_index, part in enumerate(parts):
            if part_index == len(parts) - 1:
                part_end = end
            else:
                part_end = cursor + max(1, round((end - start) * len(part) / total))
            result.append(
                {
                    "cue_index": (int(segment["scene_index"]) + 1) * 1000 + part_index,
                    "start_frame": cursor,
                    "end_frame": min(end, part_end),
                    "source_text": part,
                    "target_text": part,
                    "xmin": int(scene["xmin"]), "ymin": int(scene["ymin"]),
                    "xmax": int(scene["xmax"]), "ymax": int(scene["ymax"]),
                }
            )
            cursor = part_end
    return result


def _subtitle_parts(text: str) -> list[str]:
    sentences = [" ".join(value.split()) for value in re.split(r"(?<=[.!?;:])\s+", text) if value.strip()]
    result: list[str] = []
    current = ""
    for sentence in sentences or [text]:
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate) > 76:
            result.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        result.append(current)
    return result or [text]


def audio_groups(store: JobStore, job_id: str, *, fps: int) -> list[dict[str, Any]]:
    return [
        {
            "group_index": int(segment["scene_index"]),
            "start_seconds": int(segment["start_frame"]) / fps,
            "end_seconds": int(segment["end_frame"]) / fps,
            "status": "DONE",
            "fitted_path": segment["audio_path"],
            "checksum": sha256_file(Path(str(segment["audio_path"]))),
            "metadata": {"fitted_seconds": float(segment["audio_duration_seconds"])},
        }
        for segment in store.voiceover_segments(job_id)
        if segment["status"] == "DONE" and segment.get("audio_path")
    ]
