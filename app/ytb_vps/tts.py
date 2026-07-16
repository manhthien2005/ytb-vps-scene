from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path
from queue import Empty, Queue
from typing import Callable
from urllib.parse import urlencode
from urllib.request import urlopen

import requests

from ytb_vps.config import Settings
from ytb_vps.media import probe_duration, run_ffmpeg
from ytb_vps.state import JobStore
from ytb_vps.translation import shorten_tts_group, skipped_translation_cue_indices
from ytb_vps.util import atomic_write_json, config_fingerprint, sha256_file
from ytb_vps.vendor import capcut_client as protocol


class CapCutSharkBlock(RuntimeError):
    """CapCut's anti-abuse gate rejected the current device/session."""


FIT_ALGORITHM_VERSION = 2


def is_capcut_shark_block(error: BaseException) -> bool:
    message = str(error).lower()
    return "shark block" in message or "ret=-6" in message


def apply_tts_text_overrides(
    cues: list[dict], groups: list[dict], *, enabled: bool = False
) -> list[dict]:
    if not enabled:
        return [dict(cue) for cue in cues]
    overrides: dict[int, str] = {}
    for group in groups:
        shortened = group.get("metadata", {}).get("shortened_cues", {})
        if not isinstance(shortened, dict):
            continue
        for cue_index, text in shortened.items():
            value = " ".join(str(text).split())
            if value:
                overrides[int(cue_index)] = value
    return [
        {
            **cue,
            "target_text": overrides.get(int(cue["cue_index"]), cue.get("target_text")),
        }
        for cue in cues
    ]


@dataclass(frozen=True)
class TtsGroup:
    index: int
    start: float
    end: float
    text: str
    cue_indices: tuple[int, ...]

    def signature(self, config: dict) -> str:
        return config_fingerprint(
            {
                "version": 8,
                "start": round(self.start, 3),
                "end": round(self.end, 3),
                "cue_indices": list(self.cue_indices),
                "voice": config["voice"],
                "resource_id": config["resource_id"],
                "rate": config["rate"],
                "max_fit_speed": config.get("max_fit_speed", 1.18),
                "hard_fit_speed": config.get("hard_fit_speed", 1.25),
                "fit_tolerance_seconds": config.get("fit_tolerance_seconds", 0.08),
                "slot_borrow_seconds": config.get("slot_borrow_seconds", 4.0),
                "merge_adjacent_cues": config.get("merge_adjacent_cues", False),
                "allow_tts_spill": config.get("allow_tts_spill", False),
                "silence_trim_enabled": config.get("silence_trim_enabled", True),
                "silence_trim_threshold_db": config.get("silence_trim_threshold_db", -45),
                "text": self.text,
            }
        )


def group_cues(
    cues: list[dict],
    fps: int,
    config: dict,
    *,
    chunk_end_frames: list[int],
    merge_micro_cues: bool = True,
    micro_borrow_indices: set[int] | None = None,
) -> list[TtsGroup]:
    groups: list[TtsGroup] = []
    current: list[dict] = []
    ordered_cues = list(cues)
    short_group_gap = max(
        float(config.get("group_gap_seconds", 0.0)),
        float(config.get("short_group_gap_seconds", 0.45)),
    )
    short_group_min_duration = float(config.get("short_group_min_duration_seconds", 1.4))
    slot_borrow_seconds = max(0.0, float(config.get("slot_borrow_seconds", 4.0)))
    allow_tts_spill = bool(config.get("allow_tts_spill", False))
    max_group_chars = int(config["max_group_chars"])
    max_group_duration = float(config["max_group_duration_seconds"])
    micro_cue_max_duration = 0.8
    micro_cue_merge_gap = 0.6
    micro_cue_borrow = max(0.0, float(config.get("micro_spill_seconds", 1.0)))
    merge_adjacent_cues = bool(config.get("merge_adjacent_cues", False))

    def chunk_end_for(frame: int) -> float | None:
        for end_frame in chunk_end_frames:
            if frame < end_frame:
                return int(end_frame) / fps
        return None

    def flush(*, next_start: float | None = None) -> None:
        if not current:
            return
        start = int(current[0]["start_frame"]) / fps
        end = int(current[-1]["end_frame"]) / fps
        group_index = len(groups)
        is_micro_cue = len(current) == 1 and end - start <= micro_cue_max_duration
        allow_micro_borrow = allow_tts_spill and is_micro_cue and (
            micro_borrow_indices is None or group_index in micro_borrow_indices
        )
        borrowed_end = end + (
            micro_cue_borrow if allow_micro_borrow else slot_borrow_seconds
        )
        chunk_end = chunk_end_for(int(current[0]["start_frame"]))
        if chunk_end is not None and not allow_micro_borrow and not allow_tts_spill:
            borrowed_end = min(borrowed_end, chunk_end)
        if next_start is not None and not allow_micro_borrow and not allow_tts_spill:
            borrowed_end = min(borrowed_end, next_start)
        end = max(end, borrowed_end)
        groups.append(
            TtsGroup(
                index=group_index,
                start=start,
                end=end,
                text=" ".join(str(item["target_text"]) for item in current),
                cue_indices=tuple(int(item["cue_index"]) for item in current),
            )
        )
        current.clear()

    for cue in ordered_cues:
        if current:
            start_frame = int(cue["start_frame"])
            start = start_frame / fps
            if int(cue["cue_index"]) != int(current[-1]["cue_index"]) + 1:
                flush(next_start=start)
                current.append(cue)
                continue
            previous_end = int(current[-1]["end_frame"]) / fps
            characters = sum(len(str(item["target_text"])) for item in current)
            duration = int(cue["end_frame"]) / fps - int(current[0]["start_frame"]) / fps
            current_start = int(current[0]["start_frame"])
            current_duration = previous_end - current_start / fps
            next_duration = int(cue["end_frame"]) / fps - current_start / fps
            gap = start - previous_end
            current_is_micro_cue = (
                len(current) == 1 and current_duration <= micro_cue_max_duration
            )

            def chunk_for(frame: int) -> int:
                for chunk_index, end_frame in enumerate(chunk_end_frames):
                    if frame < end_frame:
                        return chunk_index
                return len(chunk_end_frames)

            crosses_chunk = chunk_for(start_frame) != chunk_for(current_start)
            should_keep_short_group = (
                merge_adjacent_cues
                and not crosses_chunk
                and current_duration < short_group_min_duration
                and gap <= (
                    micro_cue_merge_gap
                    if merge_micro_cues and current_is_micro_cue
                    else short_group_gap
                )
                and characters + len(str(cue["target_text"])) <= max_group_chars
                and next_duration <= max_group_duration
            )
            if not merge_adjacent_cues:
                flush(next_start=start)
            elif not should_keep_short_group and (
                crosses_chunk
                or gap > float(config["group_gap_seconds"])
                or characters + len(str(cue["target_text"])) > max_group_chars
                or duration > max_group_duration
            ):
                flush(next_start=start)
        current.append(cue)
    flush()
    return groups


class CapCutClient:
    def __init__(self, config: dict, device_json: Path | None = None) -> None:
        path = device_json or Path(config["device_json"])
        if not path.exists():
            raise FileNotFoundError(f"CapCut device credential is missing: {path}")
        self.config = config
        self.device_path = path.resolve()
        self.device = protocol.deepcopy(protocol.DEFAULT_DEVICE)
        self.device.update(json.loads(path.read_text(encoding="utf-8-sig")))

    def _headers(self, url: str, body_text: str) -> dict:
        headers = protocol.base_headers(self.device, body_text, appid=True)
        headers["sign"] = protocol.make_sign_header(
            url,
            self.device["appvr"],
            headers["device-time"],
            self.device["tdid"],
        )
        return headers

    def synthesize(self, text: str, output: Path) -> None:
        babi, body = protocol.tts_new_body(
            [text],
            str(self.config["voice"]),
            str(self.config["resource_id"]),
            str(self.config["rate"]),
            self.device,
        )
        body_text = protocol.compact_json(body)
        url = (
            protocol.BASE
            + "/lv/v1/common_task/new?"
            + urlencode(protocol.common_query(self.device, babi, include_region=True))
        )
        response = requests.post(
            url, headers=self._headers(url, body_text), data=body_text.encode(), timeout=60
        )
        response.raise_for_status()
        data = response.json()
        task = ((data.get("data") or {}).get("tasks") or [{}])[0]
        if data.get("ret") != "0" or not task.get("id") or not task.get("token"):
            message = f"CapCut task rejected: ret={data.get('ret')} {data.get('errmsg')}"
            if is_capcut_shark_block(RuntimeError(message)):
                raise CapCutSharkBlock(message)
            raise RuntimeError(message)

        audio_url = None
        status = None
        for _ in range(int(self.config["query_attempts"])):
            query = protocol.query_body(task["id"], task["token"])
            query_text = protocol.compact_json(query)
            query_url = (
                protocol.BASE
                + "/lv/v1/common_task/query?"
                + urlencode(protocol.common_query(self.device, None, include_region=False))
            )
            query_response = requests.post(
                query_url,
                headers=self._headers(query_url, query_text),
                data=query_text.encode(),
                timeout=60,
            )
            query_response.raise_for_status()
            query_data = query_response.json()
            query_task = ((query_data.get("data") or {}).get("tasks") or [{}])[0]
            status = query_task.get("status")
            if status == "succeed" and query_task.get("payload"):
                payload = json.loads(query_task["payload"])
                urls: list[str] = []

                def walk(value) -> None:
                    if isinstance(value, dict):
                        for nested in value.values():
                            walk(nested)
                    elif isinstance(value, list):
                        for nested in value:
                            walk(nested)
                    elif isinstance(value, str) and value.startswith(("https://", "http://")):
                        urls.append(value)

                walk(payload)
                if urls:
                    audio_url = urls[0]
                    break
            time.sleep(float(self.config["query_interval_seconds"]))
        if not audio_url:
            raise RuntimeError(f"CapCut TTS timed out with status {status}")

        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".part")
        temporary.unlink(missing_ok=True)
        with urlopen(audio_url, timeout=300) as source, temporary.open("wb") as target:
            while block := source.read(1024 * 1024):
                target.write(block)
        if temporary.stat().st_size < 1024:
            temporary.unlink(missing_ok=True)
            raise RuntimeError("Downloaded CapCut audio is unexpectedly small")
        os.replace(temporary, output)

class CapCutDevicePool:
    def __init__(self, config: dict, workspace: Path, logger: logging.Logger) -> None:
        self.config = config
        self.logger = logger
        self.paths = self._discover_paths(config)
        if not self.paths:
            raise FileNotFoundError("No CapCut device credential is available")
        self.state_path = workspace / "tts" / "device-pool-state.json"
        self.state = self._load_state()
        self.cooldown_seconds = float(
            config.get(
                "device_block_cooldown_seconds",
                config.get("shark_block_cooldown_seconds", 100),
            )
        )
        self.random = random.Random()
        self._condition = threading.Condition()
        self._in_use: set[str] = set()

    @property
    def device_count(self) -> int:
        return len(self.paths)

    @staticmethod
    def _looks_like_device_json(path: Path) -> bool:
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return False
        return isinstance(payload, dict) and {"device_id", "iid", "tdid"}.issubset(payload)

    def _discover_paths(self, config: dict) -> list[Path]:
        candidates: list[Path] = [Path(config["device_json"])]
        default_pool_dir = Path(config["device_json"]).expanduser().parent / "capcut-devices"
        pool_dirs = [default_pool_dir]
        configured_pool_dir = str(config.get("device_pool_dir", "")).strip()
        if configured_pool_dir:
            pool_dirs.append(Path(configured_pool_dir).expanduser())
        for pool_dir in pool_dirs:
            if pool_dir.exists():
                candidates.extend(sorted(pool_dir.glob("*.json")))
        for value in config.get("device_jsons", []) or []:
            candidates.append(Path(value))

        seen: set[str] = set()
        result: list[Path] = []
        for candidate in candidates:
            path = candidate.expanduser().resolve()
            key = str(path)
            if key in seen or not path.exists() or not self._looks_like_device_json(path):
                continue
            seen.add(key)
            result.append(path)
        return result

    def _load_state(self) -> dict:
        if not self.state_path.exists():
            return {"devices": {}}
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return {"devices": {}}
        if not isinstance(data, dict):
            return {"devices": {}}
        if not isinstance(data.get("devices"), dict):
            data["devices"] = {}
        return data

    def _device_state(self, path: Path) -> dict:
        devices = self.state.setdefault("devices", {})
        return devices.setdefault(
            str(path.resolve()),
            {
                "blocked_until": 0.0,
                "failures": 0,
                "successes": 0,
                "last_used": 0.0,
            },
        )

    def _save(self) -> None:
        atomic_write_json(self.state_path, self.state)

    def _ready_paths(self, now: float) -> list[Path]:
        return [
            path
            for path in self.paths
            if float(self._device_state(path).get("blocked_until", 0.0)) <= now
            and str(path.resolve()) not in self._in_use
        ]

    def acquire_client(self) -> CapCutClient:
        with self._condition:
            while True:
                now = time.time()
                ready = self._ready_paths(now)
                if ready:
                    path = self.random.choice(ready)
                    self._in_use.add(str(path.resolve()))
                    state = self._device_state(path)
                    state["last_used"] = now
                    self._save()
                    if self.device_count > 1:
                        self.logger.info(
                            "CapCut device pool | using %s (%d/%d ready, %d busy)",
                            path.name,
                            len(ready),
                            self.device_count,
                            len(self._in_use),
                        )
                    return CapCutClient(self.config, path)

                waits = [
                    float(self._device_state(path).get("blocked_until", 0.0)) - now
                    for path in self.paths
                    if str(path.resolve()) not in self._in_use
                ]
                positive_waits = [value for value in waits if value > 0]
                wait_seconds = (
                    max(1.0, min(positive_waits))
                    if positive_waits
                    else 1.0
                )
                self.logger.warning(
                    "CapCut device pool | no ready idle device (%d/%d busy); waiting %.0f second(s)",
                    len(self._in_use),
                    self.device_count,
                    wait_seconds,
                )
                self._condition.wait(timeout=wait_seconds)

    def release_client(self, path: Path) -> None:
        with self._condition:
            self._in_use.discard(str(path.resolve()))
            self._condition.notify_all()

    def mark_success(self, path: Path) -> None:
        with self._condition:
            state = self._device_state(path)
            state["successes"] = int(state.get("successes", 0)) + 1
            state["last_success"] = time.time()
            state["failures"] = 0
            self._save()
            self._condition.notify_all()

    def mark_blocked(self, path: Path, error: BaseException) -> None:
        with self._condition:
            now = time.time()
            state = self._device_state(path)
            failures = int(state.get("failures", 0)) + 1
            state["failures"] = failures
            state["last_error"] = str(error)
            state["blocked_until"] = now + self.cooldown_seconds
            self._save()
            self._condition.notify_all()
            self.logger.warning(
                "CapCut device pool | %s blocked for %.0f second(s) (failure %d)",
                path.name,
                self.cooldown_seconds,
                failures,
            )


def _atempo(speed: float) -> str:
    speed = max(0.05, speed)
    filters = []
    while speed > 2:
        filters.append("atempo=2")
        speed /= 2
    while speed < 0.5:
        filters.append("atempo=0.5")
        speed /= 0.5
    filters.append(f"atempo={speed:.6f}")
    return ",".join(filters)


def _fit_speed(duration_seconds: float, slot_seconds: float) -> float:
    available_seconds = max(0.001, float(slot_seconds))
    return max(1.0, float(duration_seconds) / available_seconds)


class TtsFitError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        raw_seconds: float | None = None,
        slot_seconds: float | None = None,
        required_speed: float | None = None,
        hard_speed: float | None = None,
    ) -> None:
        super().__init__(message)
        self.raw_seconds = raw_seconds
        self.slot_seconds = slot_seconds
        self.required_speed = required_speed
        self.hard_speed = hard_speed


def fit_audio(
    raw: Path,
    output: Path,
    slot_seconds: float,
    *,
    max_speed: float = 1.18,
    hard_speed: float = 1.25,
    tolerance_seconds: float = 0.08,
    silence_trim: bool = True,
    silence_threshold_db: float = -45,
    silence_start_duration: float = 0.02,
    silence_stop_duration: float = 0.05,
) -> dict:
    input_audio = raw
    raw_duration = probe_duration(raw)
    output.parent.mkdir(parents=True, exist_ok=True)
    trim_temporary = output.with_suffix(".trim.wav")
    if silence_trim:
        trim_temporary.unlink(missing_ok=True)
        run_ffmpeg(
            [
                "-y",
                "-i",
                str(raw),
                "-af",
                (
                    f"silenceremove=start_periods=1:start_duration={max(0.0, silence_start_duration):.3f}:"
                    f"start_threshold={float(silence_threshold_db):.1f}dB,"
                    "areverse,"
                    f"silenceremove=start_periods=1:start_duration={max(0.0, silence_stop_duration):.3f}:"
                    f"start_threshold={float(silence_threshold_db):.1f}dB,"
                    "areverse"
                ),
                "-ac",
                "2",
                "-ar",
                "44100",
                str(trim_temporary),
            ],
            duration_seconds=raw_duration,
        )
        if trim_temporary.exists() and trim_temporary.stat().st_size > 1024:
            input_audio = trim_temporary
    duration = probe_duration(input_audio)
    tolerance = max(0.0, float(tolerance_seconds))
    required_speed = _fit_speed(duration, slot_seconds)
    natural_max_speed = max(1.0, float(max_speed))
    hard_max_speed = max(natural_max_speed, float(hard_speed))
    speed = min(required_speed, hard_max_speed)
    initial_speed = speed
    fitted_seconds = duration / speed
    temporary = output.with_suffix(".part.wav")
    run_ffmpeg(
        [
            "-y",
            "-i",
            str(input_audio),
            "-af",
            _atempo(speed) + ",asetpts=N/SR/TB",
            "-ac",
            "2",
            "-ar",
            "44100",
            str(temporary),
        ],
        duration_seconds=duration,
    )
    actual_fitted_seconds = probe_duration(temporary)
    if actual_fitted_seconds > slot_seconds + 0.005:
        corrected_speed = _fit_speed(actual_fitted_seconds, slot_seconds)
        speed = min(hard_max_speed, speed * corrected_speed)
        run_ffmpeg(
            [
                "-y",
                "-i",
                str(temporary),
                "-af",
                _atempo(speed / initial_speed) + ",asetpts=N/SR/TB",
                "-ac",
                "2",
                "-ar",
                "44100",
                str(temporary.with_suffix(".retry.wav")),
            ],
            duration_seconds=actual_fitted_seconds,
        )
        retry_temporary = temporary.with_suffix(".retry.wav")
        os.replace(retry_temporary, temporary)
        actual_fitted_seconds = probe_duration(temporary)
    if actual_fitted_seconds > slot_seconds + 0.01:
        truncated = temporary.with_suffix(".trunc.wav")
        run_ffmpeg(
            [
                "-y", "-i", str(temporary), "-t", f"{slot_seconds:.6f}",
                "-ac", "2", "-ar", "44100", str(truncated),
            ],
            duration_seconds=actual_fitted_seconds,
        )
        os.replace(truncated, temporary)
        actual_fitted_seconds = probe_duration(temporary)
    os.replace(temporary, output)
    trim_temporary.unlink(missing_ok=True)
    return {
        "raw_seconds": raw_duration,
        "trimmed_input_seconds": duration,
        "slot_seconds": slot_seconds,
        "speed": speed,
        "required_speed": required_speed,
        "natural_max_speed": natural_max_speed,
        "hard_max_speed": hard_max_speed,
        "above_natural_speed": speed > natural_max_speed + 0.001,
        "fitted_seconds": actual_fitted_seconds,
        "expected_fitted_seconds": fitted_seconds,
        "fit_tolerance_seconds": tolerance,
        "fit_algorithm_version": FIT_ALGORITHM_VERSION,
        "speech_trimmed": actual_fitted_seconds < fitted_seconds - 0.01,
        "trimmed_to_slot": actual_fitted_seconds <= slot_seconds + 0.01,
        "silence_trimmed": input_audio != raw,
    }


def is_silent_tts_text(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and not any(character.isalnum() for character in stripped)


def synthesize_silence(raw: Path, output: Path, slot_seconds: float) -> dict:
    duration = max(0.001, slot_seconds)
    raw.parent.mkdir(parents=True, exist_ok=True)
    temporary = raw.with_name(raw.name + ".part.wav")
    run_ffmpeg(
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            f"{duration:.6f}",
            "-ac",
            "2",
            "-ar",
            "44100",
            str(temporary),
        ],
        duration_seconds=duration,
    )
    os.replace(temporary, raw)
    metadata = fit_audio(raw, output, slot_seconds)
    metadata["silent"] = True
    return metadata


def _chunk_end_frames(store: JobStore, job_id: str) -> list[int]:
    return [int(item["end_frame"]) for item in store.chunks(job_id, "render")]


def expected_tts_groups(settings: Settings, store: JobStore, job_id: str) -> list[TtsGroup]:
    existing = store.tts_groups(job_id)
    return group_cues(
        [cue for cue in store.cues(job_id) if cue.get("target_text")],
        int(settings.section("media")["target_fps"]),
        settings.section("tts"),
        chunk_end_frames=_chunk_end_frames(store, job_id),
        merge_micro_cues=not any(item["status"] == "DONE" for item in existing),
        micro_borrow_indices={
            int(item["group_index"])
            for item in existing
            if item["status"] != "DONE" or item.get("metadata", {}).get("micro_spill")
        },
    )


def ready_tts_groups(
    settings: Settings,
    store: JobStore,
    job_id: str,
    *,
    final: bool = False,
) -> list[TtsGroup]:
    cues = store.cues(job_id)
    skipped = skipped_translation_cue_indices(store, job_id)
    translated_prefix = []
    for cue in cues:
        if cue.get("target_text"):
            translated_prefix.append(cue)
            continue
        if int(cue["cue_index"]) not in skipped:
            break
    if not translated_prefix:
        return []
    groups = group_cues(
        translated_prefix,
        int(settings.section("media")["target_fps"]),
        settings.section("tts"),
        chunk_end_frames=_chunk_end_frames(store, job_id),
    )
    if not final and len(translated_prefix) < len(cues) and groups:
        groups = groups[:-1]
    return groups


def _synthesize_groups(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
    groups: list[TtsGroup],
    on_group_complete: Callable[[int], None] | None = None,
) -> list[dict]:
    config = settings.section("tts")
    stale_fits = store.invalidate_tts_fit_version(job_id, FIT_ALGORITHM_VERSION)
    if stale_fits:
        logger.warning(
            "TTS fit migration | invalidated %d stale fitted clip(s); raw audio will be reused",
            stale_fits,
        )
    store.plan_tts_groups(job_id, groups, config)
    raw_dir = workspace / "tts" / "raw"
    fitted_dir = workspace / "tts" / "fitted"

    def is_group_done(record: dict) -> bool:
        if record["status"] != "DONE" or not record.get("fitted_path"):
            return False
        fitted = Path(record["fitted_path"])
        return fitted.exists() and sha256_file(fitted) == record["checksum"]

    records = {int(record["group_index"]): record for record in store.tts_groups(job_id)}
    cue_by_index = {int(cue["cue_index"]): cue for cue in store.cues(job_id)}
    pending_groups = [group for group in groups if not is_group_done(records[group.index])]
    if not pending_groups:
        return store.tts_groups(job_id)

    device_pool = CapCutDevicePool(config, workspace, logger)
    attempts = int(config["retry_attempts"])
    if device_pool.device_count > 1:
        attempts = max(
            attempts,
            int(config.get("device_pool_group_attempts", device_pool.device_count)),
        )

    requested_workers = int(
        config.get(
            "parallel_workers",
            config.get("parallel_tts_workers", min(5, device_pool.device_count)),
        )
    )
    worker_count = max(1, min(requested_workers, device_pool.device_count, len(pending_groups)))
    if worker_count > 1:
        logger.info(
            "TTS parallel | %d worker(s), %d pending group(s), %d device file(s)",
            worker_count,
            len(pending_groups),
            device_pool.device_count,
        )

    work_queue: Queue[TtsGroup] = Queue()
    for group in pending_groups:
        work_queue.put(group)
    stop_event = threading.Event()

    def synthesize_one(worker_store: JobStore, group: TtsGroup) -> None:
        worker_store.start_tts_group(job_id, group.index)
        current_group = group
        base_signature = group.signature(config)
        existing_raw = records[group.index].get("raw_path")
        reusable_raw = Path(existing_raw) if existing_raw else None
        if reusable_raw is not None and (
            not reusable_raw.exists() or reusable_raw.stat().st_size < 1024
        ):
            reusable_raw = None
        shorten_attempts = max(0, int(config.get("shorten_attempts", 2)))
        shorten_count = 0
        current_cue_texts: dict[int, str] | None = None
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            client: CapCutClient | None = None
            try:
                signature = current_group.signature(config)
                silent_text = is_silent_tts_text(current_group.text)
                raw_extension = "wav" if silent_text else "mp3"
                raw = (
                    reusable_raw
                    if reusable_raw is not None
                    else raw_dir / f"group_{group.index:06d}_{signature[:12]}.{raw_extension}"
                )
                fitted = fitted_dir / f"group_{group.index:06d}_{signature[:12]}.wav"
                if silent_text:
                    metadata = synthesize_silence(
                        raw,
                        fitted,
                        current_group.end - current_group.start,
                    )
                else:
                    if not raw.exists() or raw.stat().st_size < 1024:
                        client = device_pool.acquire_client()
                        client.synthesize(current_group.text, raw)
                        device_pool.mark_success(client.device_path)
                    metadata = fit_audio(
                        raw,
                        fitted,
                        current_group.end - current_group.start,
                        max_speed=float(config.get("max_fit_speed", 1.18)),
                        hard_speed=float(config.get("hard_fit_speed", 1.25)),
                        tolerance_seconds=float(config.get("fit_tolerance_seconds", 0.08)),
                        silence_trim=bool(config.get("silence_trim_enabled", True)),
                        silence_threshold_db=float(config.get("silence_trim_threshold_db", -45)),
                        silence_start_duration=float(config.get("silence_trim_start_duration", 0.02)),
                        silence_stop_duration=float(config.get("silence_trim_stop_duration", 0.05)),
                    )
                if shorten_count:
                    metadata.update(
                        {
                            "tts_text_override": True,
                            "base_signature": base_signature,
                            "shortened_text": current_group.text,
                            "shortened_cues": shortened_cues,
                            "shorten_count": shorten_count,
                        }
                    )
                if len(current_group.cue_indices) == 1:
                    cue = cue_by_index[current_group.cue_indices[0]]
                    cue_end = int(cue["end_frame"]) / int(settings.section("media")["target_fps"])
                    if current_group.end > cue_end + 0.001:
                        metadata["micro_spill"] = True
                worker_store.complete_tts_group(
                    job_id,
                    group.index,
                    raw=raw,
                    fitted=fitted,
                    checksum=sha256_file(fitted),
                    metadata=metadata,
                )
                logger.info("TTS group %d/%d complete", group.index + 1, len(groups))
                if on_group_complete is not None:
                    on_group_complete(group.index)
                last_error = None
                break
            except Exception as exc:
                if (
                    isinstance(exc, TtsFitError)
                    and not silent_text
                    and shorten_count < shorten_attempts
                    and exc.required_speed is not None
                ):
                    shorten_required_speed = exc.required_speed * (
                        1.0 + 0.35 * shorten_count
                    )
                    shortened_cues = shorten_tts_group(
                        settings=settings,
                        store=worker_store,
                        job_id=job_id,
                        workspace=workspace,
                        logger=logger,
                        cue_indices=current_group.cue_indices,
                        slot_seconds=current_group.end - current_group.start,
                        required_speed=shorten_required_speed,
                        hard_speed=float(exc.hard_speed or config.get("hard_fit_speed", 1.25)),
                        current_texts=current_cue_texts,
                    )
                    current_cue_texts = shortened_cues
                    shortened_text = " ".join(
                        shortened_cues[int(cue_index)]
                        for cue_index in current_group.cue_indices
                    )
                    if len(shortened_text) >= len(current_group.text):
                        shorten_count += 1
                        if shorten_count < shorten_attempts:
                            logger.warning(
                                "TTS group %d | Codex did not shorten at level %d; "
                                "retrying with a stricter character budget",
                                group.index,
                                shorten_count,
                            )
                            continue
                        last_error = TtsFitError(
                            "Codex did not shorten the overlong TTS group",
                            raw_seconds=exc.raw_seconds,
                            slot_seconds=exc.slot_seconds,
                            required_speed=exc.required_speed,
                            hard_speed=exc.hard_speed,
                        )
                        break
                    shorten_count += 1
                    logger.info(
                        "TTS group %d | shortened %d -> %d chars after %.3fx fit request",
                        group.index,
                        len(current_group.text),
                        len(shortened_text),
                        exc.required_speed,
                    )
                    current_group = replace(current_group, text=shortened_text)
                    worker_store.replan_tts_group(job_id, current_group, config)
                    reusable_raw = None
                    last_error = None
                    continue
                if isinstance(exc, TtsFitError):
                    last_error = TtsFitError(
                        f"TTS group {group.index} cue(s) {current_group.cue_indices} does not fit: {exc}",
                        raw_seconds=exc.raw_seconds,
                        slot_seconds=exc.slot_seconds,
                        required_speed=exc.required_speed,
                        hard_speed=exc.hard_speed,
                    )
                else:
                    last_error = exc
                logger.warning("TTS group %d attempt %d failed: %s", group.index, attempt, exc)
                if isinstance(exc, TtsFitError):
                    break
                if is_capcut_shark_block(exc) and client is not None:
                    device_pool.mark_blocked(client.device_path, exc)
                elif attempt < attempts:
                    time.sleep(min(30, 2**attempt))
            finally:
                if client is not None:
                    device_pool.release_client(client.device_path)
        if last_error is not None:
            worker_store.fail_tts_group(job_id, group.index, str(last_error))
            raise last_error

    def worker(worker_index: int) -> None:
        with JobStore(workspace / "job.sqlite") as worker_store:
            while not stop_event.is_set():
                try:
                    group = work_queue.get_nowait()
                except Empty:
                    return
                try:
                    synthesize_one(worker_store, group)
                except Exception:
                    stop_event.set()
                    raise
                finally:
                    work_queue.task_done()

    if worker_count == 1:
        with JobStore(workspace / "job.sqlite") as worker_store:
            while not work_queue.empty():
                synthesize_one(worker_store, work_queue.get_nowait())
                work_queue.task_done()
    else:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(worker, index) for index in range(worker_count)]
            for future in as_completed(futures):
                future.result()
    return store.tts_groups(job_id)


def synthesize_ready_groups(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
    final: bool = False,
    on_group_complete: Callable[[int], None] | None = None,
) -> list[dict]:
    groups = ready_tts_groups(settings, store, job_id, final=final)
    if not groups:
        return store.tts_groups(job_id)
    logger.info(
        "TTS overlap | %d ready group(s)%s",
        len(groups),
        " final" if final else "",
    )
    return _synthesize_groups(
        settings=settings,
        store=store,
        job_id=job_id,
        workspace=workspace,
        logger=logger,
        groups=groups,
        on_group_complete=on_group_complete,
    )


def synthesize_groups(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
    on_group_complete: Callable[[int], None] | None = None,
) -> list[dict]:
    return _synthesize_groups(
        settings=settings,
        store=store,
        job_id=job_id,
        workspace=workspace,
        logger=logger,
        groups=expected_tts_groups(settings, store, job_id),
        on_group_complete=on_group_complete,
    )
