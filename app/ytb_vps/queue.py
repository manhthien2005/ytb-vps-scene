from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from ytb_vps.backup import delete_processed_input, remote_file_matches, sync_input
from ytb_vps.config import Settings, processing_config
from ytb_vps.locking import queue_lock
from ytb_vps.state import JobStore
from ytb_vps.util import (
    atomic_write_json,
    config_fingerprint,
    ensure_within,
    now_iso,
    safe_stem,
    source_fingerprint,
)


def discover_inputs(settings: Settings) -> list[Path]:
    extensions = {
        str(value).lower() for value in settings.section("queue")["extensions"]
    }
    directory = settings.data_path("input")
    if not directory.exists():
        return []
    return sorted(
        (
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in extensions
        ),
        key=lambda value: value.name.casefold(),
    )


def build_job_identity(input_path: Path) -> tuple[str, str]:
    signature = source_fingerprint(input_path)
    return f"{safe_stem(input_path.stem)}-{signature[:10]}", signature


def choose_output_path(
    input_path: Path,
    output_dir: Path,
    signature: str,
    workspace: Path | None = None,
    *,
    source_name: str | None = None,
) -> Path:
    del workspace
    source = Path(source_name or input_path.name)
    title = safe_stem(source.stem, limit=256)
    encoded = title.encode("utf-8")[:80]
    title = encoded.decode("utf-8", errors="ignore").strip("._-") or "video"
    return output_dir / f"{title}-{signature[:8]}"


def enqueue(settings: Settings, source: Path) -> Path:
    if not source.is_file():
        raise FileNotFoundError(source)
    settings.ensure_layout()
    destination = settings.data_path("input") / source.name
    if destination.exists():
        if (
            destination.stat().st_size == source.stat().st_size
            and source_fingerprint(destination) == source_fingerprint(source)
        ):
            return destination
        destination = destination.with_name(
            f"{destination.stem}_{source_fingerprint(source)[:8]}{destination.suffix}"
        )
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.part")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


class QueueRunner:
    def __init__(self, settings: Settings, logger: logging.Logger) -> None:
        self.settings = settings
        self.logger = logger
        self._background_backup_jobs: set[str] = set()
        self._background_backup_lock = threading.Lock()
        self._input_sources_lock = threading.Lock()
        self._input_sync_lock = threading.Lock()
        self._input_sync_thread: threading.Thread | None = None
        self._input_sync_condition = threading.Condition()
        self._input_sync_revision = 0
        settings.ensure_layout()
        self.summary_path = settings.data_path("output") / "queue-summary.json"
        self.completed_inputs_path = settings.data_path("cache") / "completed-inputs.json"
        self.input_sources_path = settings.data_path("cache") / "input-sources.json"

    def _input_sources(self) -> dict[str, str]:
        with self._input_sources_lock:
            try:
                payload = json.loads(self.input_sources_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                return {}
            sources = payload.get("sources", {}) if isinstance(payload, dict) else {}
            if not isinstance(sources, dict):
                return {}
            return {
                str(local_name): str(remote_name)
                for local_name, remote_name in sources.items()
                if Path(str(local_name)).name == str(local_name)
                and Path(str(remote_name)).name == str(remote_name)
            }

    def _record_input_sources(self, sources: dict[str, str]) -> None:
        if not sources:
            return
        with self._input_sources_lock:
            try:
                payload = json.loads(self.input_sources_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                payload = {}
            existing = payload.get("sources", {}) if isinstance(payload, dict) else {}
            existing = existing if isinstance(existing, dict) else {}
            existing.update(sources)
            atomic_write_json(self.input_sources_path, {"sources": existing})

    def _completed_input_names(self) -> set[str]:
        try:
            payload = json.loads(self.completed_inputs_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return set()
        except (json.JSONDecodeError, OSError) as exc:
            self.logger.warning("CLEANUP | ignoring invalid completed input registry: %s", exc)
            return set()
        names = payload.get("names", {}) if isinstance(payload, dict) else {}
        if not isinstance(names, dict):
            return set()
        return {name for name in names if Path(name).name == name}

    def _mark_input_completed(self, input_path: Path, source_signature: str) -> None:
        input_path = ensure_within(input_path, self.settings.data_path("input"))
        names: dict[str, dict[str, str]] = {}
        try:
            payload = json.loads(self.completed_inputs_path.read_text(encoding="utf-8"))
            existing = payload.get("names", {}) if isinstance(payload, dict) else {}
            if isinstance(existing, dict):
                names = {
                    str(name): value
                    for name, value in existing.items()
                    if Path(str(name)).name == str(name) and isinstance(value, dict)
                }
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        remote_name = self._input_sources().get(input_path.name, input_path.name)
        names[remote_name] = {
            "source_signature": source_signature,
            "completed_at": now_iso(),
        }
        atomic_write_json(self.completed_inputs_path, {"names": names})

    def _track_background_backup(
        self, job_id: str, future: Future[dict[str, Any]]
    ) -> None:
        def done(completed: Future[dict[str, Any]]) -> None:
            with self._background_backup_lock:
                self._background_backup_jobs.discard(job_id)
            try:
                completed.result()
            except Exception as exc:
                self.logger.error("%s | background backup failed: %s", job_id, exc)

        future.add_done_callback(done)

    def run(
        self, *, dry_run: bool = False, sync_drive_input: bool = True
    ) -> dict[str, Any]:
        lock_path = Path(self.settings.section("runtime")["lock_file"])
        with queue_lock(lock_path):
            return self._run_locked(
                dry_run=dry_run, sync_drive_input=sync_drive_input
            )

    def _sync_drive_input(self) -> None:
        queue_config = self.settings.section("queue")
        if not bool(queue_config.get("auto_sync_input", True)):
            return
        if not bool(self.settings.section("drive").get("enabled", False)):
            return
        started = time.monotonic()
        self.logger.info("DRIVE INPUT | syncing remote input")
        try:
            sources = sync_input(
                self.settings,
                tuple(queue_config["extensions"]),
                excluded_names=self._completed_input_names(),
            )
            self._record_input_sources(sources)
        except Exception as exc:
            self.logger.error("DRIVE INPUT | sync failed: %s", exc)
            return
        self.logger.info(
            "DRIVE INPUT | sync complete in %.1fs",
            time.monotonic() - started,
        )

    def _start_background_input_sync(self) -> None:
        queue_config = self.settings.section("queue")
        if not bool(queue_config.get("auto_sync_input", True)):
            return
        if not bool(self.settings.section("drive").get("enabled", False)):
            return
        with self._input_sync_lock:
            if self._input_sync_thread is not None and self._input_sync_thread.is_alive():
                return

            def on_file_synced(local_name: str, remote_name: str) -> None:
                self._record_input_sources({local_name: remote_name})
                with self._input_sync_condition:
                    self._input_sync_revision += 1
                    self._input_sync_condition.notify_all()
                self.logger.info("DRIVE INPUT | ready %s", local_name)

            def sync() -> None:
                started = time.monotonic()
                self.logger.info("DRIVE INPUT | background sync starting")
                try:
                    sources = sync_input(
                        self.settings,
                        tuple(queue_config["extensions"]),
                        excluded_names=self._completed_input_names(),
                        on_file_synced=on_file_synced,
                    )
                    self._record_input_sources(sources)
                    self.logger.info(
                        "DRIVE INPUT | background sync complete in %.1fs",
                        time.monotonic() - started,
                    )
                except Exception as exc:
                    self.logger.error("DRIVE INPUT | background sync failed: %s", exc)

            self._input_sync_thread = threading.Thread(
                target=sync,
                name="ytb-vps-drive-input",
                daemon=True,
            )
            self._input_sync_thread.start()

    def _cleanup_local_job(
        self,
        *,
        job_id: str,
        source_signature: str,
        input_path: Path,
        output_path: Path,
        workspace: Path,
    ) -> None:
        input_path = ensure_within(input_path, self.settings.data_path("input"))
        output_path = ensure_within(output_path, self.settings.data_path("output"))
        workspace = ensure_within(workspace, self.settings.data_path("work"))
        manifest = output_path / "publish-manifest.json"
        root = str(self.settings.section("drive")["remote_root"])
        if output_path.is_dir() and manifest.is_file():
            try:
                published = json.loads(manifest.read_text(encoding="utf-8"))
                reports = published["parts"]
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                raise RuntimeError("Local publish manifest is invalid") from exc
            if published.get("job_id") != job_id or not isinstance(reports, list) or not reports:
                raise RuntimeError("Local publish manifest belongs to another job")
            for report in reports:
                output = Path(str(report.get("output", "")))
                validation = output.with_suffix(".validation.json")
                remote_folder = f"{root.rstrip('/')}/output/{output_path.name}"
                if output.is_file() and validation.is_file():
                    if output.parent != output_path:
                        raise RuntimeError("Local Part artifact is outside output folder")
                    if not remote_file_matches(self.settings, output, f"{remote_folder}/{output.name}"):
                        raise RuntimeError("Drive Part output verification failed")
                    if not remote_file_matches(self.settings, validation, f"{remote_folder}/{validation.name}"):
                        raise RuntimeError("Drive Part validation verification failed")
                elif str(report.get("output", "")) != f"{remote_folder}/{output.name}":
                    raise RuntimeError("Remote Part output path is invalid")
        else:
            validation = output_path.with_suffix(".validation.json")
            if not output_path.is_file() or not validation.is_file():
                raise RuntimeError("Local final output or validation is missing")
            try:
                report = json.loads(validation.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise RuntimeError("Local final validation is invalid") from exc
            if report.get("job_id") != job_id:
                raise RuntimeError("Local final validation belongs to another job")
            if not remote_file_matches(
                self.settings, output_path, f"{root.rstrip('/')}/output/{output_path.name}"
            ):
                raise RuntimeError("Drive final output verification failed")
            if not remote_file_matches(
                self.settings, validation, f"{root.rstrip('/')}/output/{validation.name}"
            ):
                raise RuntimeError("Drive final validation verification failed")
        if input_path.is_file():
            if source_fingerprint(input_path) != source_signature:
                raise RuntimeError("Local input changed after processing")
            remote_name = self._input_sources().get(input_path.name, input_path.name)
            try:
                delete_processed_input(self.settings, input_path, remote_name=remote_name)
            except RuntimeError as exc:
                message = str(exc).lower()
                if (
                    "directory not found" not in message
                    and "insufficientfilepermissions" not in message
                    and "insufficient permissions" not in message
                ):
                    raise
                self.logger.info("CLEANUP | Drive input retained: %s", input_path.name)
            self._mark_input_completed(input_path, source_signature)
            input_path.unlink()
        if output_path.is_dir():
            shutil.rmtree(output_path)
        else:
            output_path.unlink()
            output_path.with_suffix(".validation.json").unlink()
        shutil.rmtree(workspace)

    def _cleanup_completed_jobs(self) -> None:
        if not bool(self.settings.section("queue").get("cleanup_after_upload", True)):
            return
        candidates: list[dict[str, Any]] = []
        for database in sorted(self.settings.data_path("work").glob("*/job.sqlite")):
            workspace = database.parent
            try:
                with self._background_backup_lock:
                    if workspace.name in self._background_backup_jobs:
                        continue
                with JobStore(database) as store:
                    job = store.job(workspace.name)
                    if job["status"] != "DONE" or store.stage_status(workspace.name, "BACKUP") != "DONE":
                        continue
                    candidates.append(
                        {
                            "job_id": workspace.name,
                            "source_signature": str(job["source_signature"]),
                            "input_path": Path(str(job["input_path"])),
                            "output_path": Path(str(job["output_path"])),
                            "workspace": workspace,
                        }
                    )
            except Exception as exc:
                self.logger.error("CLEANUP | skipped %s: %s", workspace.name, exc)
        for candidate in candidates:
            try:
                self._cleanup_local_job(**candidate)
                self.logger.info("CLEANUP | removed local artifacts for %s", candidate["job_id"])
            except Exception as exc:
                self.logger.error("CLEANUP | failed for %s: %s", candidate["job_id"], exc)

    def run_forever(self, *, dry_run: bool = False) -> None:
        interval = max(
            5,
            int(self.settings.section("queue").get("poll_interval_seconds", 30)),
        )
        self.logger.info("Worker daemon | polling every %ds", interval)
        sync_revision = 0
        while True:
            started = time.monotonic()
            try:
                self._start_background_input_sync()
                summary = self.run(dry_run=dry_run, sync_drive_input=False)
                counts = summary.get("counts", {})
                self.logger.info(
                    "Worker daemon | pass complete in %.1fs | total=%s done=%s failed=%s",
                    time.monotonic() - started,
                    summary.get("total", 0),
                    counts.get("DONE", 0),
                    counts.get("FAILED", 0),
                )
            except Exception:
                self.logger.exception("Worker daemon | pass failed")
            self._start_background_input_sync()
            with self._input_sync_condition:
                if self._input_sync_revision == sync_revision:
                    self._input_sync_condition.wait(timeout=interval)
                sync_revision = self._input_sync_revision

    def _run_locked(self, *, dry_run: bool, sync_drive_input: bool = True) -> dict[str, Any]:
        if not dry_run:
            self._cleanup_completed_jobs()
        if sync_drive_input:
            self._sync_drive_input()
        inputs = discover_inputs(self.settings)
        started_monotonic = time.monotonic()
        summary: dict[str, Any] = {
            "started_at": now_iso(),
            "finished_at": None,
            "total": len(inputs),
            "jobs": [],
        }
        atomic_write_json(self.summary_path, summary)
        self.logger.info("Discovered %d supported video(s)", len(inputs))
        background_backup = bool(
            self.settings.section("queue").get("background_backup", True)
        )
        backup_workers = max(
            1, int(self.settings.section("queue").get("backup_workers", 1))
        )
        wait_for_backup = bool(
            self.settings.section("queue").get("wait_for_background_backup", False)
        )
        backup_futures: list[tuple[dict[str, Any], Future[dict[str, Any]]]] = []
        backup_executor = ThreadPoolExecutor(max_workers=backup_workers)
        try:
            for position, input_path in enumerate(inputs, start=1):
                result, backup_future = self._run_input(
                    position,
                    len(inputs),
                    input_path,
                    dry_run,
                    backup_executor=backup_executor if background_backup else None,
                )
                summary["jobs"].append(result)
                if backup_future is not None:
                    backup_futures.append((result, backup_future))
                atomic_write_json(self.summary_path, summary)

            if backup_futures and wait_for_backup:
                self.logger.info(
                    "Waiting for %d background backup(s)", len(backup_futures)
                )
                for result, future in backup_futures:
                    try:
                        backup_result = future.result()
                        result.update(backup_result)
                    except Exception as exc:
                        result["status"] = "FAILED"
                        result["error"] = str(exc)
                        self.logger.error(
                            "%s | background backup failed: %s",
                            result.get("job_id", "unknown"),
                            exc,
                        )
                    atomic_write_json(self.summary_path, summary)
            elif backup_futures:
                self.logger.info(
                    "Leaving %d backup/upload job(s) running in background",
                    len(backup_futures),
                )
        finally:
            backup_executor.shutdown(wait=wait_for_backup)
        summary["finished_at"] = now_iso()
        summary["elapsed_seconds"] = round(time.monotonic() - started_monotonic, 3)
        summary["counts"] = {
            status: sum(1 for item in summary["jobs"] if item["status"] == status)
            for status in ("DONE", "SKIPPED", "FAILED", "DRY_RUN")
        }
        atomic_write_json(self.summary_path, summary)
        return summary

    def _run_input(
        self,
        position: int,
        total: int,
        input_path: Path,
        dry_run: bool,
        *,
        backup_executor: ThreadPoolExecutor | None = None,
    ) -> tuple[dict[str, Any], Future[dict[str, Any]] | None]:
        job_id, signature = build_job_identity(input_path)
        workspace = self.settings.data_path("work") / job_id
        workspace.mkdir(parents=True, exist_ok=True)
        output = choose_output_path(
            input_path,
            self.settings.data_path("output"),
            signature,
            workspace,
            source_name=self._input_sources().get(input_path.name, input_path.name),
        )
        database = workspace / "job.sqlite"
        with JobStore(database) as store:
            store.initialize_job(
                job_id=job_id,
                input_path=input_path,
                source_signature=signature,
                output_path=output,
                config_signature=config_fingerprint(processing_config(self.settings)),
                pipeline_mode=str(self.settings.section("translation").get("mode", "cue_translation")),
            )
            with self._background_backup_lock:
                backup_already_running = job_id in self._background_backup_jobs
            if (
                backup_already_running
                and store.stage_status(job_id, "PUBLISH") == "DONE"
                and store.stage_status(job_id, "DONE") != "DONE"
            ):
                return {
                    "job_id": job_id,
                    "input": str(input_path),
                    "output": str(output),
                    "status": "BACKUP_RUNNING",
                }, None
            store.recover_stale(job_id)
            if dry_run:
                return {
                    "job_id": job_id,
                    "input": str(input_path),
                    "output": str(output),
                    "status": "DRY_RUN",
                }, None
            try:
                job_started = time.monotonic()
                self.logger.info(
                    "[%d/%d] %s | starting %s",
                    position,
                    total,
                    input_path.name,
                    job_id,
                )
                from ytb_vps.pipeline import VideoPipeline

                VideoPipeline(
                    settings=self.settings,
                    store=store,
                    job_id=job_id,
                    input_path=input_path,
                    workspace=workspace,
                    output_path=output,
                    logger=self.logger,
                ).run(defer_backup=backup_executor is not None)
                status = store.job(job_id)["status"]
                elapsed = time.monotonic() - job_started
                result = {
                    "job_id": job_id,
                    "input": str(input_path),
                    "output": str(output),
                    "status": status,
                    "elapsed_seconds": round(elapsed, 3),
                }
                if (
                    backup_executor is not None
                    and store.stage_status(job_id, "PUBLISH") == "DONE"
                    and store.stage_status(job_id, "DONE") != "DONE"
                ):
                    with self._background_backup_lock:
                        if job_id in self._background_backup_jobs:
                            result["status"] = "BACKUP_RUNNING"
                            return result, None
                        self._background_backup_jobs.add(job_id)
                    self.logger.info(
                        "[%d/%d] %s | backup scheduled in background",
                        position,
                        total,
                        input_path.name,
                    )
                    result["status"] = "BACKUP_RUNNING"
                    future = backup_executor.submit(
                        self._run_backup_job,
                        job_id=job_id,
                        input_path=input_path,
                        workspace=workspace,
                        output=output,
                    )
                    self._track_background_backup(job_id, future)
                    return result, future
                return result, None
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                self.logger.error(
                    "[%d/%d] %s | failed: %s\n%s",
                    position,
                    total,
                    input_path.name,
                    exc,
                    traceback.format_exc(),
                )
                return {
                    "job_id": job_id,
                    "input": str(input_path),
                    "output": str(output),
                    "status": "FAILED",
                    "error": str(exc),
                }, None

    def _run_backup_job(
        self,
        *,
        job_id: str,
        input_path: Path,
        workspace: Path,
        output: Path,
    ) -> dict[str, Any]:
        self.logger.info("%s | background backup starting", job_id)
        database = workspace / "job.sqlite"
        with JobStore(database) as store:
            from ytb_vps.pipeline import VideoPipeline

            started = time.monotonic()

            VideoPipeline(
                settings=self.settings,
                store=store,
                job_id=job_id,
                input_path=input_path,
                workspace=workspace,
                output_path=output,
                logger=self.logger,
            ).run_backup_and_done()
            status = store.job(job_id)["status"]
        self.logger.info("%s | background backup complete", job_id)
        return {
            "job_id": job_id,
            "input": str(input_path),
            "output": str(output),
            "status": status,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }


def all_status(settings: Settings) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for database in sorted(settings.data_path("work").glob("*/job.sqlite")):
        with JobStore(database) as store:
            row = store.connection.execute("SELECT job_id FROM jobs LIMIT 1").fetchone()
            if row:
                results.append(store.summary(str(row["job_id"])))
    return results


def retry_job(settings: Settings, job_id: str) -> None:
    database = settings.data_path("work") / job_id / "job.sqlite"
    if not database.exists():
        raise FileNotFoundError(f"Unknown job: {job_id}")
    with JobStore(database) as store:
        failed = store.connection.execute(
            "SELECT name FROM stages WHERE job_id=? AND status='FAILED'", (job_id,)
        ).fetchall()
        for row in failed:
            store.reset_stage(job_id, str(row["name"]))
        store.connection.execute(
            "UPDATE chunks SET status='PENDING', error=NULL WHERE job_id=? "
            "AND status='FAILED'",
            (job_id,),
        )
        store.connection.execute(
            "UPDATE jobs SET status='PENDING', current_stage=NULL, error=NULL, "
            "updated_at=? WHERE job_id=?",
            (now_iso(), job_id),
        )
        store.connection.commit()
