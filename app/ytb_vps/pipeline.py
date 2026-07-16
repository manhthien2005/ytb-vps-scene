from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from ytb_vps.backup import backup_output
from ytb_vps.config import Settings
from ytb_vps.media import (
    full_decode,
    plan_chunks,
    plan_render_chunks,
    probe_video,
    validate_media_limits,
)
from ytb_vps.ocr import run_ocr_chunk, run_static_ocr_samples
from ytb_vps.render import (
    compose_audio_chunk,
    concat_chunks,
    mux_chunk,
    render_video_chunk,
    speed_up_media,
    validate_final,
)
from ytb_vps.state import JobStore
from ytb_vps.subtitles import (
    build_blur_regions,
    build_cues,
    build_static_blur_regions,
    write_srt,
)
from ytb_vps.translation import (
    translate_cues,
    translation_cues_complete,
    translation_prepasses_valid,
)
from ytb_vps.tts import (
    FIT_ALGORITHM_VERSION,
    apply_tts_text_overrides,
    expected_tts_groups,
    synthesize_groups,
    synthesize_ready_groups,
)
from ytb_vps.util import atomic_write_json, sha256_file


def publish_part_count(duration_seconds: float) -> int:
    return max(1, int(duration_seconds // (30 * 60)))


def plan_publish_parts(
    chunks: list[dict[str, Any]], duration_seconds: float
) -> list[list[dict[str, Any]]]:
    ordered = sorted(chunks, key=lambda item: int(item["chunk_index"]))
    if not ordered:
        raise RuntimeError("No render chunks available for publish")
    count = min(publish_part_count(duration_seconds), len(ordered))
    parts: list[list[dict[str, Any]]] = []
    start_index = 0
    for part_index in range(1, count):
        target = duration_seconds * part_index / count
        minimum_end = start_index + 1
        maximum_end = len(ordered) - (count - part_index)
        end_index = min(
            range(minimum_end, maximum_end + 1),
            key=lambda candidate: (
                abs(float(ordered[candidate - 1]["end_seconds"]) - target),
                candidate,
            ),
        )
        parts.append(ordered[start_index:end_index])
        start_index = end_index
    parts.append(ordered[start_index:])
    return parts


def part_filename(part_index: int, part_count: int) -> str:
    return f"Part_{part_index:02d}_of_{part_count:02d}_Vietnamese_TTS_30fps.mp4"


class VideoPipeline:
    def __init__(
        self,
        *,
        settings: Settings,
        store: JobStore,
        job_id: str,
        input_path: Path,
        workspace: Path,
        output_path: Path,
        logger: logging.Logger,
    ) -> None:
        self.settings = settings
        self.store = store
        self.job_id = job_id
        self.input_path = input_path.resolve()
        self.workspace = workspace.resolve()
        self.output_path = output_path.resolve()
        self.logger = logger
        self.workspace.mkdir(parents=True, exist_ok=True)

    def run(self, *, defer_backup: bool = False) -> None:
        if self.store.job(self.job_id)["status"] == "DONE" and self._publish_valid():
            self.logger.info("DONE | validated output already exists; queue item skipped")
            return
        self._stage("INGEST", self._ingest, self._ingest_valid)
        self._stage("OCR", self._ocr, self._ocr_valid)
        self._stage("TRACK", self._track, self._track_valid)
        self._stage("TRANSLATE", self._translate, self._translate_valid)
        self._stage("TTS", self._tts, self._tts_valid)
        self._stage("RENDER", self._render, self._render_valid)
        self._stage("PUBLISH", self._publish, self._publish_valid)
        if defer_backup:
            self.logger.info("BACKUP | deferred to background worker")
            return
        self.run_backup_and_done()

    def run_backup_and_done(self) -> None:
        self._stage("BACKUP", self._backup, self._backup_valid)
        self._stage(
            "DONE",
            lambda: {"output": str(self.output_path)},
            lambda: self._publish_valid()
            and self.store.stage_status(self.job_id, "BACKUP") == "DONE",
        )

    def _stage(
        self,
        name: str,
        action: Callable[[], dict[str, Any] | None],
        valid: Callable[[], bool],
    ) -> None:
        if self.store.stage_status(self.job_id, name) == "DONE" and valid():
            self.logger.info("%s | checkpoint valid; skipping", name)
            if name == "DONE":
                self.store.complete_stage(
                    self.job_id, "DONE", {"output": str(self.output_path)}
                )
            return
        self.store.start_stage(self.job_id, name)
        self.logger.info("%s | starting", name)
        started = time.monotonic()
        try:
            details = action() or {}
            elapsed = time.monotonic() - started
            details = {**details, "elapsed_seconds": round(elapsed, 3)}
            self.store.complete_stage(self.job_id, name, details)
            self.logger.info("%s | complete in %.1fs", name, elapsed)
        except BaseException as exc:
            self.store.fail_stage(self.job_id, name, str(exc))
            self.logger.error("%s | failed: %s", name, exc)
            raise

    def _media(self) -> dict[str, Any]:
        media = self.store.job(self.job_id).get("media")
        if not media:
            raise RuntimeError("Job has no media metadata")
        return media

    def _ingest_valid(self) -> bool:
        try:
            media = self._media()
        except RuntimeError:
            return False
        return (
            int(media.get("width", 0)) > 0
            and bool(self.store.chunks(self.job_id, "ocr"))
            and bool(self.store.chunks(self.job_id, "render"))
        )

    def _ingest(self) -> dict[str, Any]:
        media = probe_video(self.input_path)
        validate_media_limits(media, self.settings.section("media"))
        fps = int(self.settings.section("media")["target_fps"])
        planned = plan_chunks(
            float(media["duration_seconds"]),
            fps=fps,
            chunk_seconds=int(self.settings.section("media")["chunk_seconds"]),
        )
        self.store.set_media(self.job_id, media)
        self.store.plan_chunks(self.job_id, "ocr", planned)
        self.store.plan_chunks(self.job_id, "render", planned)
        return {"media": media, "chunks": len(planned), "input_backed_up": False}

    def _chunk_artifact_valid(self, chunk: dict[str, Any]) -> bool:
        if chunk["status"] != "DONE" or not chunk.get("artifact_path"):
            return False
        path = Path(chunk["artifact_path"])
        if path.is_file():
            return sha256_file(path) == chunk.get("checksum")
        return bool(chunk.get("metadata", {}).get("published_remote"))

    def _ocr_valid(self) -> bool:
        chunks = self.store.chunks(self.job_id, "ocr")
        count = self.store.connection.execute(
            "SELECT COUNT(*) FROM detections WHERE job_id=?", (self.job_id,)
        ).fetchone()[0]
        return bool(chunks) and all(self._chunk_artifact_valid(item) for item in chunks) and count > 0

    def _ocr(self) -> dict[str, Any]:
        media = self._media()
        completed = 0
        detections = 0
        maximum_attempts = int(self.settings.section("ocr")["retry_attempts"])
        chunks = self.store.chunks(self.job_id, "ocr")
        pending: list[dict[str, Any]] = []
        for chunk in chunks:
            if self._chunk_artifact_valid(chunk):
                completed += 1
                detections += int(chunk["metadata"].get("detections", 0))
            else:
                pending.append(chunk)

        def process_chunk(chunk: dict[str, Any]) -> dict[str, Any]:
            last_error: Exception | None = None
            database = self.workspace / "job.sqlite"
            for attempt in range(1, maximum_attempts + 1):
                with JobStore(database) as chunk_store:
                    chunk_store.start_chunk(
                        self.job_id, "ocr", int(chunk["chunk_index"])
                    )
                    try:
                        result = run_ocr_chunk(
                            settings=self.settings,
                            store=chunk_store,
                            job_id=self.job_id,
                            input_path=self.input_path,
                            workspace=self.workspace,
                            media=media,
                            chunk=chunk,
                            logger=self.logger,
                        )
                        chunk_store.complete_chunk(
                            self.job_id,
                            "ocr",
                            int(chunk["chunk_index"]),
                            artifact_path=result["path"],
                            checksum=result["checksum"],
                            metadata={
                                "frames": result["frames"],
                                "sampled_frames": result.get("sampled_frames"),
                                "frame_step": result.get("frame_step"),
                                "elapsed_seconds": result.get("elapsed_seconds"),
                                "detections": result["detections"],
                            },
                        )
                        chunk_store.record_artifact(
                            self.job_id,
                            f"ocr-{int(chunk['chunk_index']):06d}",
                            result["path"],
                            result["checksum"],
                        )
                        return result
                    except Exception as exc:
                        last_error = exc
                        chunk_store.fail_chunk(
                            self.job_id, "ocr", int(chunk["chunk_index"]), str(exc)
                        )
                        self.logger.warning(
                            "OCR chunk %s attempt %d/%d failed: %s",
                            chunk["chunk_index"],
                            attempt,
                            maximum_attempts,
                            exc,
                        )
            if last_error is not None:
                raise last_error

            raise RuntimeError(f"OCR chunk {chunk['chunk_index']} failed")

        worker_count = max(1, int(self.settings.section("ocr").get("parallel_chunks", 1)))
        worker_count = min(worker_count, len(pending)) if pending else 1
        if pending:
            self.logger.info(
                "OCR | processing %d pending chunk(s) with %d worker(s)",
                len(pending),
                worker_count,
            )
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = {executor.submit(process_chunk, chunk): chunk for chunk in pending}
                try:
                    for future in as_completed(futures):
                        result = future.result()
                        completed += 1
                        detections += int(result["detections"])
                        seconds = float(result.get("elapsed_seconds", 0.0))
                        sampled = int(result.get("sampled_frames", 0))
                        self.logger.info(
                            "OCR chunk %d | complete (%d detections, %.2fx realtime, %.1f sampled fps)",
                            int(futures[future]["chunk_index"]),
                            int(result["detections"]),
                            float(result.get("duration_seconds", 0.0)) / seconds if seconds > 0 else 0.0,
                            sampled / seconds if seconds > 0 else 0.0,
                        )
                except Exception:
                    for future in futures:
                        future.cancel()
                    raise
        if detections <= 0:
            raise RuntimeError("OCR completed without any detections")
        return {"chunks": completed, "detections": detections, "workers": worker_count}

    @property
    def subtitles_dir(self) -> Path:
        path = self.workspace / "subtitles"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _track_valid(self) -> bool:
        count = self.store.connection.execute(
            "SELECT COUNT(*) FROM cues WHERE job_id=?", (self.job_id,)
        ).fetchone()[0]
        return count > 0 and (self.subtitles_dir / "source_zh.srt").exists()

    def _track(self) -> dict[str, Any]:
        media = self._media()
        cues = build_cues(
            self.store,
            self.job_id,
            media=media,
            ocr_config=self.settings.section("ocr"),
            tracking_config=self.settings.section("tracking"),
        )
        blur_regions = build_blur_regions(
            self.store,
            self.job_id,
            media=media,
            ocr_config=self.settings.section("ocr"),
            tracking_config=self.settings.section("tracking"),
        )
        static_ocr = run_static_ocr_samples(
            settings=self.settings,
            input_path=self.input_path,
            workspace=self.workspace,
            media=media,
            logger=self.logger,
        )
        static_blur_regions = build_static_blur_regions(
            self.store,
            self.job_id,
            media=media,
            ocr_config=self.settings.section("ocr"),
            tracking_config=self.settings.section("tracking"),
            static_detections=static_ocr["detections"],
        )
        blur_regions.extend(static_blur_regions)
        fps = int(self.settings.section("media")["target_fps"])
        render_plan = plan_render_chunks(
            float(media["duration_seconds"]),
            fps=fps,
            chunk_seconds=int(self.settings.section("media")["chunk_seconds"]),
            cues=cues,
        )
        self.store.replace_chunk_plan(self.job_id, "render", render_plan)
        chinese = self.subtitles_dir / "source_zh.srt"
        write_srt(chinese, cues, fps=fps)
        plan = self.subtitles_dir / "blur-plan.json"
        atomic_write_json(plan, blur_regions)
        self.store.record_artifact(self.job_id, "source-zh-srt", chinese, sha256_file(chinese))
        self.store.record_artifact(self.job_id, "blur-plan", plan, sha256_file(plan))
        if static_ocr["path"] is not None:
            self.store.record_artifact(
                self.job_id,
                "static-full-frame-ocr",
                static_ocr["path"],
                static_ocr["checksum"],
            )
        return {
            "cues": len(cues),
            "blur_regions": len(blur_regions),
            "static_blur_regions": len(static_blur_regions),
            "render_chunks": len(render_plan),
        }

    def _translate_valid(self) -> bool:
        return translation_cues_complete(self.store, self.job_id) and translation_prepasses_valid(
            settings=self.settings,
            store=self.store,
            job_id=self.job_id,
        ) and (
            self.subtitles_dir / "source_vi.srt"
        ).exists()

    def _translate(self) -> dict[str, Any]:
        pending_tts = None
        pending_render = None
        render_lock = threading.Lock()

        def run_ready_render() -> int:
            with JobStore(self.workspace / "job.sqlite") as render_store:
                return self._render_ready_chunks(render_store)

        def schedule_ready_render(executor: ThreadPoolExecutor) -> None:
            nonlocal pending_render
            with render_lock:
                if pending_render is not None and not pending_render.done():
                    return
                if pending_render is not None:
                    try:
                        rendered = pending_render.result()
                        if rendered:
                            self.logger.info("Render overlap | %d chunk(s) ready/done", rendered)
                    except Exception as exc:
                        self.logger.warning("Render overlap failed; final render stage will retry: %s", exc)
                pending_render = executor.submit(run_ready_render)

        def run_ready_tts(*, final: bool = False) -> int:
            with JobStore(self.workspace / "job.sqlite") as tts_store:
                groups = synthesize_ready_groups(
                    settings=self.settings,
                    store=tts_store,
                    job_id=self.job_id,
                    workspace=self.workspace,
                    logger=self.logger,
                    final=final,
                    on_group_complete=lambda _index: schedule_ready_render(render_executor),
                )
                return sum(1 for item in groups if item["status"] == "DONE")

        with ThreadPoolExecutor(max_workers=1) as executor, ThreadPoolExecutor(max_workers=1) as render_executor:
            def queue_ready_tts() -> None:
                nonlocal pending_tts
                if pending_tts is not None and not pending_tts.done():
                    return
                if pending_tts is not None:
                    try:
                        done = pending_tts.result()
                        self.logger.info("TTS overlap | %d group(s) ready/done", done)
                    except Exception as exc:
                        self.logger.warning("TTS overlap failed; final TTS stage will retry: %s", exc)
                pending_tts = executor.submit(run_ready_tts)

            cues = translate_cues(
                settings=self.settings,
                store=self.store,
                job_id=self.job_id,
                workspace=self.workspace,
                logger=self.logger,
                on_batch_complete=queue_ready_tts,
            )
            if pending_tts is not None:
                try:
                    done = pending_tts.result()
                    self.logger.info("TTS overlap | %d group(s) ready/done", done)
                except Exception as exc:
                    self.logger.warning("TTS overlap failed; final TTS stage will retry: %s", exc)
            if pending_render is not None:
                try:
                    rendered = pending_render.result()
                    if rendered:
                        self.logger.info("Render overlap | %d chunk(s) ready/done", rendered)
                except Exception as exc:
                    self.logger.warning("Render overlap failed; final render stage will retry: %s", exc)
        vietnamese = self.subtitles_dir / "source_vi.srt"
        write_srt(
            vietnamese,
            [cue for cue in cues if cue.get("target_text")],
            fps=int(self.settings.section("media")["target_fps"]),
            target=True,
        )
        self.store.record_artifact(
            self.job_id, "source-vi-srt", vietnamese, sha256_file(vietnamese)
        )
        return {"cues": len(cues)}

    def _tts_valid(self) -> bool:
        groups = self.store.tts_groups(self.job_id)
        if not translation_cues_complete(self.store, self.job_id):
            return False
        expected = expected_tts_groups(self.settings, self.store, self.job_id)
        return len(groups) == len(expected) and all(
            item["status"] == "DONE"
            and item.get("fitted_path")
            and Path(item["fitted_path"]).exists()
            and sha256_file(Path(item["fitted_path"])) == item.get("checksum")
            and int(item.get("metadata", {}).get("fit_algorithm_version", 0))
            == FIT_ALGORITHM_VERSION
            for item in groups
        )

    def _tts(self) -> dict[str, Any]:
        pending_render = None
        render_lock = threading.Lock()

        def run_ready_render() -> int:
            with JobStore(self.workspace / "job.sqlite") as render_store:
                return self._render_ready_chunks(render_store)

        with ThreadPoolExecutor(max_workers=1) as render_executor:
            def schedule_ready_render(_index: int) -> None:
                nonlocal pending_render
                with render_lock:
                    if pending_render is not None and not pending_render.done():
                        return
                    if pending_render is not None:
                        try:
                            rendered = pending_render.result()
                            if rendered:
                                self.logger.info("Render overlap | %d chunk(s) ready/done", rendered)
                        except Exception as exc:
                            self.logger.warning("Render overlap failed; final render stage will retry: %s", exc)
                    pending_render = render_executor.submit(run_ready_render)

            schedule_ready_render(-1)
            groups = synthesize_groups(
                settings=self.settings,
                store=self.store,
                job_id=self.job_id,
                workspace=self.workspace,
                logger=self.logger,
                on_group_complete=schedule_ready_render,
            )
            if pending_render is not None:
                try:
                    rendered = pending_render.result()
                    if rendered:
                        self.logger.info("Render overlap | %d chunk(s) ready/done", rendered)
                except Exception as exc:
                    self.logger.warning("Render overlap failed; final render stage will retry: %s", exc)
        display_cues = apply_tts_text_overrides(
            self.store.cues(self.job_id),
            groups,
            enabled=bool(self.settings.section("tts").get("display_shortened_text", False)),
        )
        vietnamese = self.subtitles_dir / "source_vi.srt"
        write_srt(
            vietnamese,
            [cue for cue in display_cues if cue.get("target_text")],
            fps=int(self.settings.section("media")["target_fps"]),
            target=True,
        )
        self.store.record_artifact(
            self.job_id,
            "source-vi-srt",
            vietnamese,
            sha256_file(vietnamese),
        )
        return {"groups": len(groups)}

    def _render_valid(self) -> bool:
        chunks = self.store.chunks(self.job_id, "render")
        return bool(chunks) and all(self._chunk_artifact_valid(item) for item in chunks)

    def _render(self) -> dict[str, Any]:
        return {"chunks": self._render_ready_chunks(self.store, require_all=True)}

    def _render_ready_chunks(self, store: JobStore, *, require_all: bool = False) -> int:
        media = store.job(self.job_id).get("media")
        if not media:
            raise RuntimeError("Job has no media metadata")
        all_cues = store.cues(self.job_id)
        blur_plan = self.subtitles_dir / "blur-plan.json"
        blur_regions = json.loads(blur_plan.read_text(encoding="utf-8")) if blur_plan.exists() else all_cues
        groups = store.tts_groups(self.job_id)
        cues = apply_tts_text_overrides(
            [cue for cue in all_cues if cue.get("target_text")],
            groups,
            enabled=bool(self.settings.section("tts").get("display_shortened_text", False)),
        )
        render_root = self.workspace / "render"
        video_dir = render_root / "video"
        audio_dir = render_root / "audio"
        av_dir = render_root / "chunks"
        completed = 0
        pending: list[dict[str, Any]] = []
        for chunk in store.chunks(self.job_id, "render"):
            if self._chunk_artifact_valid(chunk):
                completed += 1
                continue
            if not require_all and not self._render_chunk_ready(chunk, cues, groups):
                continue

            pending.append(chunk)

        render_config = self.settings.section("render")
        workers = max(1, min(int(render_config.get("parallel_chunks", 1)), len(pending)))
        threads_per_chunk = max(
            1, int(self.settings.section("media")["ffmpeg_threads"]) // workers
        )

        def render_one(chunk: dict[str, Any]) -> tuple[int, dict[str, Any]]:
            index = int(chunk["chunk_index"])
            video = video_dir / f"chunk_{index:06d}.mp4"
            audio = audio_dir / f"chunk_{index:06d}.m4a"
            av = av_dir / f"chunk_{index:06d}.mp4"
            video_result = render_video_chunk(
                settings=self.settings,
                input_path=self.input_path if bool(media.get("has_audio")) else None,
                output_path=video,
                media=media,
                chunk=chunk,
                cues=cues,
                blur_regions=blur_regions,
                logger=self.logger,
                ffmpeg_threads=threads_per_chunk,
            )
            audio_result = compose_audio_chunk(
                groups=groups,
                chunk=chunk,
                output=audio,
                input_path=self.input_path,
                original_volume=float(
                    self.settings.section("render").get("original_audio_volume", 0.2)
                ),
                duck_volume=float(
                    self.settings.section("render").get("original_audio_duck_volume", 0.1)
                ),
                ducking_enabled=bool(
                    self.settings.section("render").get("audio_ducking_enabled", False)
                ),
            )
            av.parent.mkdir(parents=True, exist_ok=True)
            mux_chunk(video, audio, av)
            full_decode(av)
            checksum = sha256_file(av)
            return index, {
                "artifact_path": av,
                "checksum": checksum,
                "metadata": {"video": video_result, "audio": audio_result},
            }
        if workers > 1:
            self.logger.info(
                "Render parallel | %d worker(s), %d chunk(s), %d FFmpeg thread(s) each",
                workers,
                len(pending),
                threads_per_chunk,
            )

        for chunk in pending:
            store.start_chunk(self.job_id, "render", int(chunk["chunk_index"]))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(render_one, chunk): int(chunk["chunk_index"]) for chunk in pending}
            for future in as_completed(futures):
                index = futures[future]
                try:
                    completed_index, result = future.result()
                except Exception as exc:
                    store.fail_chunk(self.job_id, "render", index, str(exc))
                    raise
                store.complete_chunk(
                    self.job_id,
                    "render",
                    completed_index,
                    artifact_path=result["artifact_path"],
                    checksum=result["checksum"],
                    metadata=result["metadata"],
                )
                store.record_artifact(
                    self.job_id,
                    f"render-{completed_index:06d}",
                    result["artifact_path"],
                    result["checksum"],
                )
                completed += 1
        return completed

    def _render_chunk_ready(
        self,
        chunk: dict[str, Any],
        cues: list[dict[str, Any]],
        groups: list[dict[str, Any]],
    ) -> bool:
        start_frame = int(chunk["start_frame"])
        end_frame = int(chunk["end_frame"])
        relevant_cues = [
            cue
            for cue in cues
            if int(cue["end_frame"]) > start_frame and int(cue["start_frame"]) < end_frame
        ]
        if any(not cue.get("target_text") for cue in relevant_cues):
            return False
        start = float(chunk["start_seconds"])
        end = float(chunk["end_seconds"])
        relevant_groups = [
            group
            for group in groups
            if float(group["end_seconds"]) > start and float(group["start_seconds"]) < end
        ]
        if relevant_cues and not relevant_groups:
            return False
        return all(
            group["status"] == "DONE"
            and group.get("fitted_path")
            and Path(group["fitted_path"]).exists()
            and sha256_file(Path(group["fitted_path"])) == group.get("checksum")
            for group in relevant_groups
        )

    def _publish_valid(self) -> bool:
        if self.settings.section("drive")["enabled"]:
            try:
                parts = self._publish_parts()
                return (
                    all(
                        self._part_remote_valid(index, len(parts))
                        for index in range(1, len(parts) + 1)
                    )
                    and self._artifact_remote_valid("publish-manifest")
                )
            except Exception:
                return False
        try:
            return all(
                self._part_valid(part, index, len(self._publish_parts()))
                for index, part in enumerate(self._publish_parts(), start=1)
            )
        except Exception:
            return False

    def _backup_valid(self) -> bool:
        return (
            self._publish_valid()
            and self.store.stage_status(self.job_id, "BACKUP") == "DONE"
        )

    def _publish_parts(self) -> list[list[dict[str, Any]]]:
        return plan_publish_parts(
            self.store.chunks(self.job_id, "render"),
            float(self._media()["duration_seconds"]),
        )

    def _part_path(self, part_index: int, part_count: int) -> Path:
        return self.output_path / part_filename(part_index, part_count)

    def _part_valid(
        self,
        part: list[dict[str, Any]],
        part_index: int,
        part_count: int,
    ) -> bool:
        output = self._part_path(part_index, part_count)
        validation = output.with_suffix(".validation.json")
        if not output.is_file() or not validation.is_file():
            return False
        try:
            report = json.loads(validation.read_text(encoding="utf-8"))
            return (
                report.get("job_id") == self.job_id
                and int(report.get("part_index", 0)) == part_index
                and int(report.get("part_count", 0)) == part_count
                and report.get("chunk_indexes")
                == [int(item["chunk_index"]) for item in part]
                and report.get("full_decode") is True
                and report.get("checksum") == sha256_file(output)
            )
        except Exception:
            return False

    def _publish(self) -> dict[str, Any]:
        if self.settings.section("drive")["enabled"]:
            return self._publish_to_drive()
        return self._publish_local()

    def _publish_local(self) -> dict[str, Any]:
        render = self.settings.section("render")
        output_speed = float(render.get("output_speed", 1.0))
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.mkdir(parents=True, exist_ok=True)
        candidate_dir = self.workspace / "publish"
        candidate_dir.mkdir(parents=True, exist_ok=True)
        parts = self._publish_parts()
        published: list[dict[str, Any]] = []
        for part_index, part in enumerate(parts, start=1):
            output = self._part_path(part_index, len(parts))
            validation = output.with_suffix(".validation.json")
            if self._part_valid(part, part_index, len(parts)):
                report = json.loads(validation.read_text(encoding="utf-8"))
            else:
                candidate = candidate_dir / f"part_{part_index:02d}.mp4"
                concat_chunks([Path(item["artifact_path"]) for item in part], candidate)
                publish_candidate = candidate
                if abs(output_speed - 1.0) >= 0.001:
                    publish_candidate = candidate_dir / f"part_{part_index:02d}_speed.mp4"
                    speed_up_media(
                        candidate,
                        publish_candidate,
                        speed=output_speed,
                        render=render,
                        threads=int(self.settings.section("media")["ffmpeg_threads"]),
                    )
                report = validate_final(
                    publish_candidate,
                    self._media(),
                    int(self.settings.section("media")["target_fps"]),
                    duration_seconds=(
                        float(part[-1]["end_seconds"])
                        - float(part[0]["start_seconds"])
                    )
                    / output_speed,
                )
                temporary = output.with_name(f".{output.name}.part")
                shutil.copy2(publish_candidate, temporary)
                os.replace(temporary, output)
                report = {
                    **report,
                    "job_id": self.job_id,
                    "input": str(self.input_path),
                    "output": str(output),
                    "part_index": part_index,
                    "part_count": len(parts),
                    "chunk_indexes": [int(item["chunk_index"]) for item in part],
                    "start_seconds": float(part[0]["start_seconds"]),
                    "end_seconds": float(part[-1]["end_seconds"]),
                    "mode": "stable-blur-capcut-tts",
                    "output_speed": output_speed,
                }
                atomic_write_json(validation, report)
            self.store.record_artifact(
                self.job_id,
                f"part-{part_index:02d}-output",
                output,
                sha256_file(output),
                metadata={"part_index": part_index, "part_count": len(parts)},
            )
            self.store.record_artifact(
                self.job_id,
                f"part-{part_index:02d}-validation",
                validation,
                sha256_file(validation),
                metadata={"part_index": part_index, "part_count": len(parts)},
            )
            published.append(report)
        manifest = self.output_path / "publish-manifest.json"
        atomic_write_json(
            manifest,
            {"job_id": self.job_id, "parts": published, "output_folder": str(self.output_path)},
        )
        self.store.record_artifact(
            self.job_id, "publish-manifest", manifest, sha256_file(manifest)
        )
        return {"output_folder": str(self.output_path), "parts": published}

    def _remote_output_path(self, name: str) -> str:
        root = str(self.settings.section("drive")["remote_root"]).rstrip("/")
        return f"{root}/output/{self.output_path.name}/{name}"

    def _artifact(self, name: str) -> dict[str, Any] | None:
        return next(
            (artifact for artifact in self.store.artifacts(self.job_id) if artifact["name"] == name),
            None,
        )

    def _artifact_remote_valid(self, name: str) -> bool:
        artifact = self._artifact(name)
        return bool(artifact and artifact["remote_verified"] and artifact["remote_path"])

    def _part_remote_valid(self, part_index: int, part_count: int) -> bool:
        return (
            self._artifact_remote_valid(f"part-{part_index:02d}-output")
            and self._artifact_remote_valid(f"part-{part_index:02d}-validation")
        )

    def _remove_render_part(self, part: list[dict[str, Any]], remote_path: str) -> None:
        self.store.mark_render_chunks_published(
            self.job_id, part, remote_path=remote_path
        )
        render_root = (self.workspace / "render").resolve()
        for chunk in part:
            index = int(chunk["chunk_index"])
            paths = (
                Path(str(chunk["artifact_path"])),
                render_root / "video" / f"chunk_{index:06d}.mp4",
                render_root / "audio" / f"chunk_{index:06d}.m4a",
            )
            for path in paths:
                resolved = path.resolve()
                if render_root == resolved or render_root not in resolved.parents:
                    raise RuntimeError(f"Refusing unsafe render cleanup path: {resolved}")
                resolved.unlink(missing_ok=True)

    def _remove_local_publish_part(self, candidate_dir: Path, part_index: int) -> None:
        for path in (
            candidate_dir / f"part_{part_index:02d}.mp4",
            candidate_dir / f"part_{part_index:02d}.concat.txt",
            candidate_dir / f"part_{part_index:02d}_speed.mp4",
            candidate_dir / f"part_{part_index:02d}.validation.json",
        ):
            path.unlink(missing_ok=True)

    def _publish_to_drive(self) -> dict[str, Any]:
        render = self.settings.section("render")
        output_speed = float(render.get("output_speed", 1.0))
        self.output_path.mkdir(parents=True, exist_ok=True)
        candidate_dir = self.workspace / "publish"
        candidate_dir.mkdir(parents=True, exist_ok=True)
        parts = self._publish_parts()
        published: list[dict[str, Any]] = []
        for part_index, part in enumerate(parts, start=1):
            output_name = part_filename(part_index, len(parts))
            output_remote = self._remote_output_path(output_name)
            output_artifact = self._artifact(f"part-{part_index:02d}-output")
            if self._part_remote_valid(part_index, len(parts)):
                report = dict((output_artifact or {}).get("metadata", {}).get("report") or {})
                if not report:
                    raise RuntimeError(f"Remote Part report is missing: {part_index}")
                self._remove_render_part(part, output_remote)
                self._remove_local_publish_part(candidate_dir, part_index)
                published.append(report)
                continue

            candidate: Path | None = None
            legacy_output = self._part_path(part_index, len(parts))
            legacy_validation = legacy_output.with_suffix(".validation.json")
            if self._part_valid(part, part_index, len(parts)):
                publish_candidate = legacy_output
                validation = legacy_validation
                report = json.loads(validation.read_text(encoding="utf-8"))
                report["output"] = output_remote
                atomic_write_json(validation, report)
            else:
                candidate = candidate_dir / f"part_{part_index:02d}.mp4"
                if not candidate.is_file():
                    concat_chunks([Path(item["artifact_path"]) for item in part], candidate)
                publish_candidate = candidate
                if abs(output_speed - 1.0) >= 0.001:
                    publish_candidate = candidate_dir / f"part_{part_index:02d}_speed.mp4"
                    if not publish_candidate.is_file():
                        speed_up_media(
                            candidate,
                            publish_candidate,
                            speed=output_speed,
                            render=render,
                            threads=int(self.settings.section("media")["ffmpeg_threads"]),
                        )
                report = validate_final(
                    publish_candidate,
                    self._media(),
                    int(self.settings.section("media")["target_fps"]),
                    duration_seconds=(
                        float(part[-1]["end_seconds"]) - float(part[0]["start_seconds"])
                    )
                    / output_speed,
                )
                report = {
                    **report,
                    "job_id": self.job_id,
                    "input": str(self.input_path),
                    "output": output_remote,
                    "part_index": part_index,
                    "part_count": len(parts),
                    "chunk_indexes": [int(item["chunk_index"]) for item in part],
                    "start_seconds": float(part[0]["start_seconds"]),
                    "end_seconds": float(part[-1]["end_seconds"]),
                    "mode": "stable-blur-capcut-tts",
                    "output_speed": output_speed,
                }
                validation = candidate_dir / f"part_{part_index:02d}.validation.json"
                atomic_write_json(validation, report)
            validation_remote = self._remote_output_path(
                f"{Path(output_name).stem}.validation.json"
            )
            self.store.record_artifact(
                self.job_id,
                f"part-{part_index:02d}-output",
                publish_candidate,
                sha256_file(publish_candidate),
                metadata={"part_index": part_index, "part_count": len(parts), "report": report},
            )
            backup_output(self.settings, publish_candidate, remote_path=output_remote)
            self.store.mark_artifact_remote(
                self.job_id, f"part-{part_index:02d}-output", output_remote
            )
            self.store.record_artifact(
                self.job_id,
                f"part-{part_index:02d}-validation",
                validation,
                sha256_file(validation),
                metadata={"part_index": part_index, "part_count": len(parts)},
            )
            backup_output(self.settings, validation, remote_path=validation_remote)
            self.store.mark_artifact_remote(
                self.job_id, f"part-{part_index:02d}-validation", validation_remote
            )
            self._remove_render_part(part, output_remote)
            publish_candidate.unlink(missing_ok=True)
            validation.unlink(missing_ok=True)
            if candidate is not None:
                candidate.unlink(missing_ok=True)
            self._remove_local_publish_part(candidate_dir, part_index)
            published.append(report)

        manifest = self.output_path / "publish-manifest.json"
        atomic_write_json(
            manifest,
            {"job_id": self.job_id, "parts": published, "output_folder": str(self.output_path)},
        )
        self.store.record_artifact(
            self.job_id, "publish-manifest", manifest, sha256_file(manifest)
        )
        manifest_remote = self._remote_output_path(manifest.name)
        backup_output(self.settings, manifest, remote_path=manifest_remote)
        self.store.mark_artifact_remote(self.job_id, "publish-manifest", manifest_remote)
        return {"output_folder": str(self.output_path), "parts": published}

    def _backup(self) -> dict[str, Any]:
        if not self.settings.section("drive")["enabled"]:
            return {"remote_root": None, "cleanup_ready": False}
        if self._publish_valid():
            root = str(self.settings.section("drive")["remote_root"]).rstrip("/")
            for path in (
                self.workspace / "render" / "video",
                self.workspace / "render" / "audio",
                self.workspace / "tts" / "fitted",
                self.workspace / "publish",
            ):
                if path.exists():
                    resolved = path.resolve()
                    if self.workspace == resolved or self.workspace not in resolved.parents:
                        raise RuntimeError(f"Refusing unsafe cleanup path: {resolved}")
                    shutil.rmtree(resolved)
            return {
                "remote_root": root,
                "remote_folder": f"{root}/output/{self.output_path.name}",
                "cleanup_ready": True,
            }
        root = str(self.settings.section("drive")["remote_root"]).rstrip("/")
        for artifact in self.store.artifacts(self.job_id):
            if not (
                artifact["name"].startswith("part-")
                or artifact["name"] == "publish-manifest"
            ):
                continue
            path = Path(artifact["path"])
            if not path.is_file():
                raise RuntimeError(f"Publish artifact is missing: {path}")
            remote_path = f"{root}/output/{self.output_path.name}/{path.name}"
            backup_output(self.settings, path, remote_path=remote_path)
            self.store.mark_artifact_remote(self.job_id, artifact["name"], remote_path)
        for path in (
            self.workspace / "render" / "video",
            self.workspace / "render" / "audio",
            self.workspace / "tts" / "fitted",
            self.workspace / "publish",
        ):
            if path.exists():
                resolved = path.resolve()
                if self.workspace == resolved or self.workspace not in resolved.parents:
                    raise RuntimeError(f"Refusing unsafe cleanup path: {resolved}")
                shutil.rmtree(resolved)
        return {
            "remote_root": root,
            "remote_folder": f"{root}/output/{self.output_path.name}",
            "cleanup_ready": True,
        }
