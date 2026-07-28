from __future__ import annotations

import copy
import hashlib
import tempfile
import unittest
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

from ytb_vps_v2.application.invalidation import plan_invalidation
from ytb_vps_v2.application.media_job import (
    MediaOutput,
    MediaJobError,
    MediaJobExecutor,
    scene_blur_regions,
    scene_render_projection,
)
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import (
    RenderFingerprintInputs,
    stage_config_fingerprints,
)
from ytb_vps_v2.domain.models import StageName
from ytb_vps_v2.domain.render_chunks import part_file_name
from ytb_vps_v2.domain.timeline import FrameInterval


class FakeTransfer:
    instances: list["FakeTransfer"] = []

    def __init__(self, token: str) -> None:
        self.token = token
        self.downloads: list[tuple[str, Path, int, str]] = []
        self.uploads: list[tuple[str, Path, int, str]] = []
        self.__class__.instances.append(self)

    def download_source(self, file_id: str, destination: Path, expected_size: int, expected_sha256: str) -> None:
        self.downloads.append((file_id, destination, expected_size, expected_sha256))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"input")

    def upload_resumable(self, session_uri: str, source: Path, expected_size: int, expected_sha256: str) -> None:
        self.uploads.append((session_uri, source, expected_size, expected_sha256))


class FakeClient:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    def progress(self, job_id: str, update: dict[str, object]) -> dict[str, object]:
        self.events.append(("progress", update))
        return {"outcome": "UPDATED"}

    def renew(self, job_id: str, fencing_token: int) -> dict[str, object]:
        self.events.append(("renew", (job_id, fencing_token)))
        return {"outcome": "RENEWED"}

    def output_session(self, job_id: str, request: dict[str, object]) -> dict[str, object]:
        self.events.append(("output-session", request))
        return {
            "status": "UPLOAD",
            "artifactId": "artifact-1",
            "driveFileId": "drive-output-1",
            "sessionUri": "https://www.googleapis.com/upload/drive/v3/files/file-001?uploadType=resumable&upload_id=abc",
            "expiresAt": "2099-01-01T00:00:00Z",
        }

    def complete(self, job_id: str, request: dict[str, object]) -> dict[str, object]:
        self.events.append(("complete", request))
        return {"outcome": "COMPLETED"}


class MultipartClient(FakeClient):
    def __init__(
        self,
        *,
        ready_parts: tuple[int, ...] = (),
        early_completed: bool = False,
    ) -> None:
        super().__init__()
        self.ready_parts = ready_parts
        self.early_completed = early_completed

    def output_session(
        self,
        job_id: str,
        request: dict[str, object],
    ) -> dict[str, object]:
        self.events.append(("output-session", request))
        index = int(request["partIndex"])
        if index in self.ready_parts:
            return {
                "status": "READY",
                "artifactId": f"artifact-{index}",
                "driveFileId": f"drive-output-{index}",
            }
        return {
            "status": "UPLOAD",
            "artifactId": f"artifact-{index}",
            "driveFileId": f"drive-output-{index}",
            "sessionUri": f"https://upload.example/part-{index}",
            "expiresAt": "2099-01-01T00:00:00Z",
        }

    def complete(
        self,
        job_id: str,
        request: dict[str, object],
    ) -> dict[str, object]:
        self.events.append(("complete", request))
        index = int(request["partIndex"])
        count = int(request["partCount"])
        return {
            "outcome": (
                "COMPLETED"
                if self.early_completed or index == count
                else "PART_COMPLETED"
            )
        }


class CancelOnRenewClient(FakeClient):
    def __init__(self, cancel_on_renew: int) -> None:
        super().__init__()
        self.cancel_on_renew = cancel_on_renew
        self.renew_count = 0

    def renew(self, job_id: str, fencing_token: int) -> dict[str, object]:
        self.events.append(("renew", (job_id, fencing_token)))
        self.renew_count += 1
        return {
            "outcome": "RENEWED",
            "cancelRequested": self.renew_count == self.cancel_on_renew,
        }


def assignment(source_sha256: str) -> dict[str, object]:
    return {
        "job": {"id": "job-1", "state": "CLAIMED"},
        "lease": {"fencingToken": 4},
        "driveAccessToken": "token-1",
        "execution": {
            "projectId": "project-1",
            "source": {"driveFileId": "drive-source-1", "fileName": "source.mp4", "mimeType": "video/mp4", "sizeBytes": 5, "sha256": source_sha256},
            "outputParentId": "drive-project-1",
            "sceneSettings": {"sourceSubtitle": {"x": 0.1, "y": 0.7, "width": 0.8, "height": 0.2}, "logo": {"x": 0.8, "y": 0.05, "width": 0.15, "height": 0.1}, "voice": "vi-VN-HoaiMyNeural", "rate": 1.0},
        },
    }


def projection_settings() -> dict[str, object]:
    return {
        "version": 3,
        "voice": "BV074_streaming",
        "rate": 1.0,
        "presetDisplayName": "Tin tức",
        "regions": [
            {
                "id": "region-a",
                "kind": "blur",
                "label": "Phụ đề gốc",
                "enabled": True,
                "origin": "manual",
                "rectangle": {
                    "x": 0.1,
                    "y": 0.7,
                    "width": 0.8,
                    "height": 0.2,
                },
                "timeRanges": None,
            },
        ],
    }


def scene_fingerprints(settings: dict[str, object]):
    projection = scene_render_projection(
        settings,
        1920,
        1080,
        frame_count=900,
    )
    baseline = EffectiveConfig()
    effective = replace(
        baseline,
        tts=replace(baseline.tts, rate=projection.tts_rate),
    )
    return stage_config_fingerprints(
        effective,
        render_inputs=RenderFingerprintInputs(
            projection.blur_regions,
            output_has_audio=True,
        ),
    )


class SceneRenderProjectionTests(unittest.TestCase):
    def test_mask_rectangle_changes_only_render_direct_fingerprint(self) -> None:
        baseline = projection_settings()
        changed = copy.deepcopy(baseline)
        changed["regions"][0]["rectangle"]["x"] = 0.2  # type: ignore[index]

        before = scene_fingerprints(baseline)
        after = scene_fingerprints(changed)

        self.assertEqual(
            tuple(
                previous.stage
                for previous, current in zip(before, after, strict=True)
                if previous.fingerprint != current.fingerprint
            ),
            (StageName.RENDER,),
        )

    def test_rate_changes_tts_and_downstream_but_not_ocr_or_translate(self) -> None:
        baseline = projection_settings()
        changed = copy.deepcopy(baseline)
        changed["rate"] = 1.1

        before = scene_fingerprints(baseline)
        after = scene_fingerprints(changed)
        invalidation = plan_invalidation(before, after)

        self.assertEqual(invalidation.direct_stages, (StageName.TTS,))
        self.assertEqual(
            invalidation.affected_stages,
            (
                StageName.TTS,
                StageName.RENDER,
                StageName.PUBLISH,
                StageName.BACKUP,
            ),
        )

    def test_editor_metadata_does_not_change_content_fingerprints(self) -> None:
        baseline = projection_settings()
        changed = copy.deepcopy(baseline)
        changed["presetDisplayName"] = "Bản tin buổi tối"
        changed["regions"][0]["id"] = "replacement-id"  # type: ignore[index]
        changed["regions"][0]["label"] = "Nhãn mới"  # type: ignore[index]
        changed["regions"][0]["origin"] = "auto"  # type: ignore[index]

        self.assertEqual(
            scene_fingerprints(baseline),
            scene_fingerprints(changed),
        )

    def test_scene_rate_is_exact_and_legacy_voices_are_compatible(self) -> None:
        for voice in (
            "BV074_streaming",
            "vi-VN-HoaiMyNeural",
            "vi-VN-NamMinhNeural",
        ):
            with self.subTest(voice=voice):
                settings = projection_settings()
                settings["voice"] = voice
                settings["rate"] = "1.1"
                projection = scene_render_projection(
                    settings,
                    1920,
                    1080,
                    frame_count=900,
                )
                self.assertEqual(projection.tts_rate, Fraction(11, 10))

    def test_scene_rejects_unsupported_voice_and_out_of_range_rate(self) -> None:
        invalid = (
            {"voice": "another-voice"},
            {"rate": 0.79},
            {"rate": 1.21},
            {"rate": True},
        )
        for changes in invalid:
            with self.subTest(changes=changes):
                settings = projection_settings()
                settings.update(changes)
                with self.assertRaises(MediaJobError):
                    scene_render_projection(
                        settings,
                        1920,
                        1080,
                        frame_count=900,
                    )

    def test_production_default_chunk_size_remains_five_minutes(self) -> None:
        self.assertEqual(EffectiveConfig().media.chunk_seconds, 300)


class MediaJobTests(unittest.TestCase):
    def test_scene_rectangles_are_converted_to_source_pixel_regions(self) -> None:
        regions = scene_blur_regions(
            assignment("a" * 64)["execution"]["sceneSettings"],  # type: ignore[arg-type]
            1920,
            1080,
            frame_count=900,
        )
        self.assertEqual(regions[0].box.xmin, 192)
        self.assertEqual(regions[0].box.ymin, 756)
        self.assertEqual(regions[1].box.xmax, 1824)
        self.assertTrue(
            all(region.interval == FrameInterval(0, 900) for region in regions)
        )

    def test_execute_streams_input_runs_pipeline_and_completes_output(self) -> None:
        client = FakeClient()
        output_bytes = b"rendered-output"

        def pipeline(
            source: Path,
            workspace: Path,
            settings: object,
            job_id: str,
        ) -> tuple[MediaOutput, ...]:
            self.assertEqual(job_id, "job-1")
            self.assertEqual(source.read_bytes(), b"input")
            result = workspace / "published" / "part-01-of-01.mp4"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_bytes(output_bytes)
            return (MediaOutput(1, 1, result),)

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))
        transfer = FakeTransfer.instances[0]
        self.assertEqual(transfer.downloads[0][0], "drive-source-1")
        self.assertEqual(transfer.uploads[0][0].startswith("https://www.googleapis.com/"), True)
        progress_updates = [payload for event, payload in client.events if event == "progress"]
        self.assertEqual(
            progress_updates,
            [
                {
                    "fencingToken": 4,
                    "fromState": "CLAIMED",
                    "state": "DOWNLOADING",
                    "progressPercent": 5,
                    "phase": "download",
                    "phaseProgressPercent": 0,
                    "message": "Downloading source media",
                    "currentPart": 1,
                    "totalParts": 1,
                },
                {
                    "fencingToken": 4,
                    "fromState": "DOWNLOADING",
                    "state": "OCR",
                    "progressPercent": 20,
                    "phase": "process",
                    "phaseProgressPercent": 0,
                    "message": "Processing source media",
                    "currentPart": 1,
                    "totalParts": 1,
                },
                {
                    "fencingToken": 4,
                    "fromState": "OCR",
                    "state": "UPLOADING",
                    "progressPercent": 90,
                    "phase": "upload",
                    "phaseProgressPercent": 0,
                    "message": "Uploading output Part 1/1",
                    "currentPart": 1,
                    "totalParts": 1,
                },
            ],
        )
        uploading_progress_index = client.events.index(("progress", progress_updates[-1]))
        output_session_index = next(
            index for index, (event, _payload) in enumerate(client.events) if event == "output-session"
        )
        self.assertLess(uploading_progress_index, output_session_index)
        self.assertEqual([event for event, _ in client.events], ["progress", "progress", "renew", "renew", "progress", "output-session", "complete"])

    def test_cancel_requested_on_first_renew_stops_before_pipeline(self) -> None:
        client = CancelOnRenewClient(cancel_on_renew=1)
        pipeline_called = False

        def pipeline(*_args: object) -> Path:
            nonlocal pipeline_called
            pipeline_called = True
            raise AssertionError("pipeline must not run after cancellation")

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            result = executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))

        self.assertEqual(result, "CANCELLED")
        self.assertEqual(pipeline_called, False)
        self.assertEqual(
            client.events[-1],
            (
                "progress",
                {
                    "fencingToken": 4,
                    "fromState": "CANCEL_REQUESTED",
                    "state": "CANCELLED",
                    "progressPercent": 20,
                    "phase": "cancel",
                    "phaseProgressPercent": 100,
                    "message": "Cancellation acknowledged",
                    "currentPart": 1,
                    "totalParts": 1,
                },
            ),
        )
        self.assertEqual([event for event, _ in client.events], ["progress", "progress", "renew", "progress"])

    def test_cancel_requested_on_second_renew_stops_before_upload(self) -> None:
        client = CancelOnRenewClient(cancel_on_renew=2)

        def pipeline(
            _source: Path,
            workspace: Path,
            _settings: object,
            _job_id: str,
        ) -> tuple[MediaOutput, ...]:
            result = workspace / "published" / "part-01-of-01.mp4"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_bytes(b"rendered-output")
            return (MediaOutput(1, 1, result),)

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            result = executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))

        self.assertEqual(result, "CANCELLED")
        self.assertEqual(FakeTransfer.instances[0].uploads, [])
        self.assertEqual([event for event, _ in client.events], ["progress", "progress", "renew", "renew", "progress"])
        cancellation = client.events[-1][1]
        self.assertEqual(cancellation["fromState"], "CANCEL_REQUESTED")  # type: ignore[index]
        self.assertEqual(cancellation["state"], "CANCELLED")  # type: ignore[index]
        self.assertEqual(cancellation["progressPercent"], 90)  # type: ignore[index]

    def test_lease_lost_renew_response_is_a_media_job_error(self) -> None:
        class LeaseLostClient(FakeClient):
            def renew(self, job_id: str, fencing_token: int) -> dict[str, object]:
                self.events.append(("renew", (job_id, fencing_token)))
                return {"outcome": "LEASE_LOST"}

        pipeline_called = False

        def pipeline(*_args: object) -> Path:
            nonlocal pipeline_called
            pipeline_called = True
            return Path("unexpected.mp4")

        executor = MediaJobExecutor(LeaseLostClient(), transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(MediaJobError, "lease renewal"):
                executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))
        self.assertEqual(pipeline_called, False)

    def test_progress_rejection_is_a_media_job_error(self) -> None:
        class RejectingProgressClient(FakeClient):
            def progress(self, job_id: str, update: dict[str, object]) -> dict[str, object]:
                raise RuntimeError("INVALID_REQUEST")

        executor = MediaJobExecutor(RejectingProgressClient(), transfer_factory=FakeTransfer, pipeline=lambda *_args: Path("unexpected.mp4"))
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(MediaJobError, "progress update"):
                executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))

    def test_progress_messages_do_not_expose_tokens_secrets_or_paths(self) -> None:
        client = FakeClient()

        def pipeline(
            _source: Path,
            workspace: Path,
            _settings: object,
            _job_id: str,
        ) -> tuple[MediaOutput, ...]:
            result = workspace / "published" / "part-01-of-01.mp4"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_bytes(b"rendered-output")
            return (MediaOutput(1, 1, result),)

        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))
            messages = "\n".join(
                str(payload["message"])
                for event, payload in client.events
                if event == "progress" and "message" in payload  # type: ignore[operator]
            )
            for sensitive_value in (
                "token-1",
                "session-secret-sentinel",
                "upload_id=abc",
                str(Path(root)),
            ):
                self.assertNotIn(sensitive_value, messages)

    def test_rejects_missing_source_digest(self) -> None:
        invalid = assignment("a" * 64)
        invalid["execution"]["source"].pop("sha256")  # type: ignore[index]
        with self.assertRaises(MediaJobError):
            MediaJobExecutor(FakeClient(), transfer_factory=FakeTransfer, pipeline=lambda *_args: Path("missing.mp4")).execute(invalid, Path(tempfile.gettempdir()))

    def test_pipeline_failure_reports_failed_retryable(self) -> None:
        client = FakeClient()

        def pipeline(*_args: object) -> Path:
            raise OSError("render crashed")

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(MediaJobError, "execution failed"):
                executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))

        event, payload = client.events[-1]
        self.assertEqual(event, "progress")
        self.assertEqual(payload["state"], "FAILED_RETRYABLE")  # type: ignore[index]
        self.assertEqual(payload["fromState"], "OCR")  # type: ignore[index]
        self.assertEqual(payload["errorCode"], "WORKER_EXECUTION_FAILED")  # type: ignore[index]

    def test_progress_racing_a_cancel_acknowledges_the_cancellation(self) -> None:
        class RacingClient(FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.rejected = False

            def progress(self, job_id: str, update: dict[str, object]) -> dict[str, object]:
                if update.get("state") == "OCR" and not self.rejected:
                    # The web flipped the job to CANCEL_REQUESTED between the
                    # worker's checkpoints; the fenced transition is rejected.
                    self.rejected = True
                    error = RuntimeError("LEASE_LOST")
                    error.code = "LEASE_LOST"  # type: ignore[attr-defined]
                    raise error
                return super().progress(job_id, update)

            def renew(self, job_id: str, fencing_token: int) -> dict[str, object]:
                self.events.append(("renew", (job_id, fencing_token)))
                return {"outcome": "RENEWED", "cancelRequested": True}

        client = RacingClient()
        pipeline_called = False

        def pipeline(*_args: object) -> Path:
            nonlocal pipeline_called
            pipeline_called = True
            raise AssertionError("pipeline must not run after cancellation")

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            result = executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))

        self.assertEqual(result, "CANCELLED")
        self.assertFalse(pipeline_called)
        event, payload = client.events[-1]
        self.assertEqual(event, "progress")
        self.assertEqual(payload["fromState"], "CANCEL_REQUESTED")  # type: ignore[index]
        self.assertEqual(payload["state"], "CANCELLED")  # type: ignore[index]

    def test_completed_job_cleans_its_workspace(self) -> None:
        client = FakeClient()

        def pipeline(
            _source: Path,
            workspace: Path,
            _settings: object,
            _job_id: str,
        ) -> tuple[MediaOutput, ...]:
            result = workspace / "published" / "part-01-of-01.mp4"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_bytes(b"rendered-output")
            return (MediaOutput(1, 1, result),)

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            result = executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))
            self.assertEqual(result, "COMPLETED")
            self.assertFalse((Path(root) / "job-1").exists())

    @staticmethod
    def _multipart_pipeline(
        _source: Path,
        workspace: Path,
        _settings: object,
        _job_id: str,
    ) -> tuple[MediaOutput, ...]:
        outputs = []
        for index in (1, 2):
            path = (
                workspace
                / "published"
                / f"part-{index:02d}-of-02.mp4"
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"Part {index}".encode())
            outputs.append(MediaOutput(index, 2, path))
        return tuple(outputs)

    def test_execute_uploads_ordered_multipart_outputs(self) -> None:
        client = MultipartClient()
        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(
            client,
            transfer_factory=FakeTransfer,
            pipeline=self._multipart_pipeline,
        )

        with tempfile.TemporaryDirectory() as root:
            result = executor.execute(
                assignment(hashlib.sha256(b"input").hexdigest()),
                Path(root),
            )
            self.assertFalse((Path(root) / "job-1").exists())

        self.assertEqual(result, "COMPLETED")
        self.assertEqual(
            tuple(
                upload[1].name
                for upload in FakeTransfer.instances[0].uploads
            ),
            ("part-01-of-02.mp4", "part-02-of-02.mp4"),
        )
        sessions = tuple(
            payload
            for event, payload in client.events
            if event == "output-session"
        )
        self.assertEqual(
            tuple(
                (
                    payload["partIndex"],
                    payload["partCount"],
                    part_file_name(
                        payload["partIndex"],
                        payload["partCount"],
                    ),
                )
                for payload in sessions
            ),
            (
                (1, 2, "part-01-of-02.mp4"),
                (2, 2, "part-02-of-02.mp4"),
            ),
        )
        completions = tuple(
            payload
            for event, payload in client.events
            if event == "complete"
        )
        self.assertEqual(
            tuple(
                (
                    payload["partIndex"],
                    payload["partCount"],
                )
                for payload in completions
            ),
            ((1, 2), (2, 2)),
        )
        uploading = tuple(
            payload
            for event, payload in client.events
            if event == "progress"
            and payload["state"] == "UPLOADING"
        )
        self.assertEqual(
            tuple(
                (
                    payload["currentPart"],
                    payload["totalParts"],
                )
                for payload in uploading
            ),
            ((1, 2), (2, 2)),
        )

    def test_ready_replay_skips_first_upload_and_finishes_second(self) -> None:
        client = MultipartClient(ready_parts=(1,))
        FakeTransfer.instances.clear()

        with tempfile.TemporaryDirectory() as root:
            result = MediaJobExecutor(
                client,
                transfer_factory=FakeTransfer,
                pipeline=self._multipart_pipeline,
            ).execute(
                assignment(hashlib.sha256(b"input").hexdigest()),
                Path(root),
            )

        self.assertEqual(result, "COMPLETED")
        self.assertEqual(
            tuple(
                upload[1].name
                for upload in FakeTransfer.instances[0].uploads
            ),
            ("part-02-of-02.mp4",),
        )
        self.assertEqual(
            len(
                tuple(
                    event
                    for event, _ in client.events
                    if event == "complete"
                )
            ),
            1,
        )

    def test_completed_before_final_part_fails_closed(self) -> None:
        client = MultipartClient(early_completed=True)
        FakeTransfer.instances.clear()

        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(
                MediaJobError,
                "completion outcome",
            ):
                MediaJobExecutor(
                    client,
                    transfer_factory=FakeTransfer,
                    pipeline=self._multipart_pipeline,
                ).execute(
                    assignment(
                        hashlib.sha256(b"input").hexdigest()
                    ),
                    Path(root),
                )
            self.assertTrue((Path(root) / "job-1").exists())

        self.assertEqual(len(FakeTransfer.instances[0].uploads), 1)

    def test_cancellation_between_parts_does_not_start_second(self) -> None:
        class CancelBetweenPartsClient(
            CancelOnRenewClient,
            MultipartClient,
        ):
            def __init__(self) -> None:
                CancelOnRenewClient.__init__(
                    self,
                    cancel_on_renew=3,
                )
                self.ready_parts = ()
                self.early_completed = False

            output_session = MultipartClient.output_session
            complete = MultipartClient.complete

        client = CancelBetweenPartsClient()
        FakeTransfer.instances.clear()

        with tempfile.TemporaryDirectory() as root:
            result = MediaJobExecutor(
                client,
                transfer_factory=FakeTransfer,
                pipeline=self._multipart_pipeline,
            ).execute(
                assignment(hashlib.sha256(b"input").hexdigest()),
                Path(root),
            )

        self.assertEqual(result, "CANCELLED")
        self.assertEqual(len(FakeTransfer.instances[0].uploads), 1)
        self.assertEqual(
            len(
                tuple(
                    event
                    for event, _ in client.events
                    if event == "output-session"
                )
            ),
            1,
        )

    def test_malformed_output_descriptors_fail_before_upload(self) -> None:
        variants: tuple[object, ...] = (
            (),
            Path("single.mp4"),
            (
                MediaOutput(1, 2, Path("missing-1.mp4")),
                MediaOutput(1, 2, Path("missing-2.mp4")),
            ),
            (MediaOutput(1, 2, Path("missing-1.mp4")),),
        )
        for outputs in variants:
            with self.subTest(outputs=outputs):
                client = MultipartClient()
                FakeTransfer.instances.clear()
                with tempfile.TemporaryDirectory() as root:
                    with self.assertRaises(MediaJobError):
                        MediaJobExecutor(
                            client,
                            transfer_factory=FakeTransfer,
                            pipeline=lambda *_args, value=outputs: value,
                        ).execute(
                            assignment(
                                hashlib.sha256(b"input").hexdigest()
                            ),
                            Path(root),
                        )
                self.assertEqual(
                    tuple(
                        event
                        for event, _ in client.events
                        if event == "output-session"
                    ),
                    (),
                )


if __name__ == "__main__":
    unittest.main()
