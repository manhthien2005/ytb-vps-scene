from __future__ import annotations

import json
import logging
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.support import test_settings
from ytb_vps.config import processing_config
from ytb_vps.backup import _filter_literal, local_input_name
from ytb_vps.queue import (
    QueueRunner,
    build_job_identity,
    choose_output_path,
    discover_inputs,
    enqueue,
)
from ytb_vps.state import JobStore
from ytb_vps.models import load_manifest
from ytb_vps.util import source_fingerprint


class ConfigQueueTests(unittest.TestCase):
    def test_bundled_model_manifest_is_discoverable(self) -> None:
        manifest = load_manifest()
        self.assertEqual(len(manifest["models"]), 2)
        self.assertEqual(len(manifest["fixtures"]), 1)
        source_manifest = json.loads(
            (Path(__file__).parents[1] / "assets" / "model-manifest.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(manifest, source_manifest)

    def test_enqueue_and_discover_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            source = root / "video sample.mp4"
            source.write_bytes(b"header" + b"x" * 1024)
            destination = enqueue(settings, source)
            self.assertEqual(discover_inputs(settings), [destination])
            first = build_job_identity(destination)
            second = build_job_identity(destination)
            self.assertEqual(first, second)
            self.assertIn("video_sample", first[0])

    def test_enqueue_does_not_duplicate_identical_input(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            source = root / "a.mp4"
            source.write_bytes(b"same")
            self.assertEqual(enqueue(settings, source), enqueue(settings, source))

    def test_existing_job_keeps_its_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "work"
            output = root / "chosen.mp4"
            source = root / "input.mp4"
            source.write_bytes(b"video")
            job_id, signature = build_job_identity(source)
            with JobStore(workspace / "job.sqlite") as store:
                store.initialize_job(
                    job_id=job_id,
                    input_path=source,
                    source_signature=signature,
                    output_path=output,
                    config_signature="cfg",
                )
            self.assertEqual(
                choose_output_path(source, root / "output", signature, workspace),
                root / "output" / f"input-{signature[:8]}",
            )

    def test_output_folder_uses_byte_safe_source_title_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "input.mp4"
            source.write_bytes(b"video")
            _job_id, signature = build_job_identity(source)
            folder_path = choose_output_path(
                source,
                root / "output",
                signature,
                source_name="[Toàn Dân Sinh Tồn] " + "nội dung dài " * 40 + ".mp4",
            )
            self.assertLessEqual(len(folder_path.name.encode("utf-8")), 90)
            self.assertTrue(folder_path.name.endswith(f"-{signature[:8]}"))

    def test_processing_config_ignores_logo_only_changes(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            baseline = test_settings(root, render={"logo_width_ratio": 0.16})
            resized_logo = test_settings(root, render={"logo_width_ratio": 0.192})
            changed_font = test_settings(root, render={"font_size": 43})

            self.assertEqual(processing_config(baseline), processing_config(resized_logo))
            self.assertNotEqual(processing_config(baseline), processing_config(changed_font))

    def test_processing_config_ignores_runtime_parallelism_and_micro_spill(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            baseline = test_settings(root)
            tuned = test_settings(
                root,
                ocr={"parallel_chunks": 1, "gpu_memory_mb": 4000},
                tts={"micro_spill_seconds": 1.0},
            )

            self.assertEqual(processing_config(baseline), processing_config(tuned))

    def test_config_change_preserves_existing_job_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = root / "job.sqlite"
            with JobStore(database) as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="source",
                    output_path=root / "output.mp4",
                    config_signature="old",
                )
                store.set_media("job", {"width": 640, "height": 360})
                store.plan_chunks(
                    "job",
                    "ocr",
                    [{"index": 0, "start_frame": 0, "end_frame": 30, "start_seconds": 0, "end_seconds": 1}],
                )
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="source",
                    output_path=root / "output.mp4",
                    config_signature="new",
                )

                self.assertEqual(store.job("job")["config_signature"], "new")
                self.assertEqual(store.job("job")["media"], {"width": 640, "height": 360})
                self.assertEqual(len(store.chunks("job", "ocr")), 1)

    def test_completed_input_filter_escapes_glob_characters(self) -> None:
        self.assertEqual(_filter_literal("[done]*?.mp4"), "\\[done\\]\\*\\?.mp4")

    def test_long_drive_input_uses_short_hashed_local_name(self) -> None:
        remote_name = "[Toàn Dân Sinh Tồn] " + "rất dài " * 80 + ".mp4"
        local_name = local_input_name(remote_name, "drive-file-id")
        self.assertLessEqual(len(local_name.encode("utf-8")), 255)
        self.assertTrue(local_name.startswith("drive-input-"))
        self.assertTrue(local_name.endswith(".mp4"))
        self.assertEqual(local_name, local_input_name(remote_name, "drive-file-id"))

    def test_background_drive_sync_records_each_ready_file(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root,
                drive={"enabled": True},
                queue={"auto_sync_input": True},
            )
            runner = QueueRunner(settings, logging.getLogger("queue-test"))

            def sync(_settings, _extensions, *, excluded_names, on_file_synced):
                self.assertEqual(excluded_names, set())
                assert on_file_synced is not None
                on_file_synced("first.mp4", "remote-first.mp4")
                on_file_synced("second.mp4", "remote-second.mp4")
                return {
                    "first.mp4": "remote-first.mp4",
                    "second.mp4": "remote-second.mp4",
                }

            with patch("ytb_vps.queue.sync_input", side_effect=sync):
                runner._start_background_input_sync()
                assert runner._input_sync_thread is not None
                runner._input_sync_thread.join(timeout=1)

            self.assertFalse(runner._input_sync_thread.is_alive())
            self.assertEqual(runner._input_sync_revision, 2)
            self.assertEqual(
                runner._input_sources(),
                {"first.mp4": "remote-first.mp4", "second.mp4": "remote-second.mp4"},
            )

    def test_cleanup_removes_verified_local_job_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, queue={"cleanup_after_upload": True})
            runner = QueueRunner(settings, logging.getLogger("queue-test"))
            job_id = "finished-job"
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            output = settings.data_path("output") / "final.mp4"
            output.write_bytes(b"final")
            output.with_suffix(".validation.json").write_text(
                json.dumps({"job_id": job_id}), encoding="utf-8"
            )
            workspace = settings.data_path("work") / job_id
            workspace.mkdir()

            with patch("ytb_vps.queue.remote_file_matches", return_value=True), patch(
                "ytb_vps.queue.delete_processed_input"
            ) as delete_input:
                runner._cleanup_local_job(
                    job_id=job_id,
                    source_signature=source_fingerprint(source),
                    input_path=source,
                    output_path=output,
                    workspace=workspace,
                )

            delete_input.assert_called_once_with(
                settings, source, remote_name="source.mp4"
            )

            self.assertFalse(source.exists())
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix(".validation.json").exists())
            self.assertFalse(workspace.exists())

    def test_cleanup_removes_verified_part_folder(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, queue={"cleanup_after_upload": True})
            runner = QueueRunner(settings, logging.getLogger("queue-test"))
            job_id = "finished-job"
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            output = settings.data_path("output") / "source-12345678"
            output.mkdir()
            part = output / "Part_01_of_01_Vietnamese_TTS_30fps.mp4"
            validation = part.with_suffix(".validation.json")
            part.write_bytes(b"part")
            validation.write_text(json.dumps({"job_id": job_id}), encoding="utf-8")
            (output / "publish-manifest.json").write_text(
                json.dumps(
                    {
                        "job_id": job_id,
                        "parts": [{"output": str(part)}],
                    }
                ),
                encoding="utf-8",
            )
            workspace = settings.data_path("work") / job_id
            workspace.mkdir()

            with patch("ytb_vps.queue.remote_file_matches", return_value=True), patch(
                "ytb_vps.queue.delete_processed_input"
            ) as delete_input:
                runner._cleanup_local_job(
                    job_id=job_id,
                    source_signature=source_fingerprint(source),
                    input_path=source,
                    output_path=output,
                    workspace=workspace,
                )

            delete_input.assert_called_once_with(
                settings, source, remote_name="source.mp4"
            )
            self.assertFalse(source.exists())
            self.assertFalse(output.exists())
            self.assertFalse(workspace.exists())

    def test_cleanup_allows_already_consumed_drive_input(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, queue={"cleanup_after_upload": True})
            runner = QueueRunner(settings, logging.getLogger("queue-test"))
            job_id = "finished-job"
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            output = settings.data_path("output") / "final.mp4"
            output.write_bytes(b"final")
            output.with_suffix(".validation.json").write_text(
                json.dumps({"job_id": job_id}), encoding="utf-8"
            )
            workspace = settings.data_path("work") / job_id
            workspace.mkdir()

            with patch("ytb_vps.queue.remote_file_matches", return_value=True), patch(
                "ytb_vps.queue.delete_processed_input",
                side_effect=RuntimeError("rclone failed: directory not found"),
            ):
                runner._cleanup_local_job(
                    job_id=job_id,
                    source_signature=source_fingerprint(source),
                    input_path=source,
                    output_path=output,
                    workspace=workspace,
                )

            self.assertFalse(source.exists())
            self.assertFalse(output.exists())
            self.assertFalse(workspace.exists())

    def test_cleanup_excludes_read_only_drive_input_after_completion(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, queue={"cleanup_after_upload": True})
            runner = QueueRunner(settings, logging.getLogger("queue-test"))
            job_id = "finished-job"
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            output = settings.data_path("output") / "final.mp4"
            output.write_bytes(b"final")
            output.with_suffix(".validation.json").write_text(
                json.dumps({"job_id": job_id}), encoding="utf-8"
            )
            workspace = settings.data_path("work") / job_id
            workspace.mkdir()

            with patch("ytb_vps.queue.remote_file_matches", return_value=True), patch(
                "ytb_vps.queue.delete_processed_input",
                side_effect=RuntimeError("rclone failed: insufficientFilePermissions"),
            ):
                runner._cleanup_local_job(
                    job_id=job_id,
                    source_signature=source_fingerprint(source),
                    input_path=source,
                    output_path=output,
                    workspace=workspace,
                )

            self.assertEqual(runner._completed_input_names(), {"source.mp4"})
            self.assertFalse(source.exists())

    def test_background_backup_does_not_block_next_input(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root, queue={"wait_for_background_backup": True}
            )
            first = settings.data_path("input") / "a.mp4"
            second = settings.data_path("input") / "b.mp4"
            first.write_bytes(b"a" * 1024)
            second.write_bytes(b"b" * 1024)
            events: list[str] = []
            first_backup_started = threading.Event()
            second_run_started = threading.Event()

            class FakePipeline:
                def __init__(self, **kwargs):
                    self.store = kwargs["store"]
                    self.job_id = kwargs["job_id"]
                    self.output_path = kwargs["output_path"]

                def run(self, *, defer_backup: bool = False) -> None:
                    if not defer_backup:
                        raise AssertionError("backup should be deferred")
                    events.append(f"run:{self.job_id}")
                    if self.job_id.startswith("b-"):
                        second_run_started.set()
                    self.output_path.write_bytes(b"mp4")
                    self.output_path.with_suffix(".validation.json").write_text(
                        "{}",
                        encoding="utf-8",
                    )
                    self.store.start_stage(self.job_id, "PUBLISH")
                    self.store.complete_stage(self.job_id, "PUBLISH", {})

                def run_backup_and_done(self) -> None:
                    events.append(f"backup-start:{self.job_id}")
                    if self.job_id.startswith("a-"):
                        first_backup_started.set()
                        if not second_run_started.wait(timeout=5):
                            raise AssertionError("second input did not start")
                    self.store.start_stage(self.job_id, "BACKUP")
                    self.store.complete_stage(self.job_id, "BACKUP", {})
                    self.store.start_stage(self.job_id, "DONE")
                    self.store.complete_stage(self.job_id, "DONE", {})
                    events.append(f"backup-done:{self.job_id}")

            with patch("ytb_vps.pipeline.VideoPipeline", FakePipeline):
                summary = QueueRunner(
                    settings,
                    logging.getLogger("queue-test"),
                ).run()

            self.assertTrue(first_backup_started.is_set())
            self.assertEqual(summary["counts"]["DONE"], 2)
            run_second = next(
                index for index, event in enumerate(events) if event.startswith("run:b-")
            )
            done_first = next(
                index
                for index, event in enumerate(events)
                if event.startswith("backup-done:a-")
            )
            self.assertLess(run_second, done_first)

    def test_background_backup_does_not_block_queue_pass(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            source = settings.data_path("input") / "a.mp4"
            source.write_bytes(b"a" * 1024)
            backup_started = threading.Event()
            backup_can_finish = threading.Event()

            class FakePipeline:
                def __init__(self, **kwargs):
                    self.store = kwargs["store"]
                    self.job_id = kwargs["job_id"]
                    self.output_path = kwargs["output_path"]

                def run(self, *, defer_backup: bool = False) -> None:
                    if not defer_backup:
                        raise AssertionError("backup should be deferred")
                    self.output_path.write_bytes(b"mp4")
                    self.output_path.with_suffix(".validation.json").write_text(
                        "{}",
                        encoding="utf-8",
                    )
                    self.store.start_stage(self.job_id, "PUBLISH")
                    self.store.complete_stage(self.job_id, "PUBLISH", {})

                def run_backup_and_done(self) -> None:
                    backup_started.set()
                    if not backup_can_finish.wait(timeout=5):
                        raise AssertionError("test did not release backup")
                    self.store.start_stage(self.job_id, "BACKUP")
                    self.store.complete_stage(self.job_id, "BACKUP", {})
                    self.store.start_stage(self.job_id, "DONE")
                    self.store.complete_stage(self.job_id, "DONE", {})

            try:
                with patch("ytb_vps.pipeline.VideoPipeline", FakePipeline):
                    summary = QueueRunner(
                        settings,
                        logging.getLogger("queue-test"),
                    ).run()
                self.assertEqual(summary["jobs"][0]["status"], "BACKUP_RUNNING")
            finally:
                backup_can_finish.set()


if __name__ == "__main__":
    unittest.main()
