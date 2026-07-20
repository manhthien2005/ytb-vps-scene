from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from ytb_vps_v2.application.media_job import MediaJobExecutor, MediaJobError, scene_blur_regions


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
        return {"artifactId": "artifact-1", "driveFileId": "drive-output-1", "sessionUri": "https://www.googleapis.com/upload/drive/v3/files/file-001?uploadType=resumable&upload_id=abc"}

    def complete(self, job_id: str, request: dict[str, object]) -> dict[str, object]:
        self.events.append(("complete", request))
        return {"outcome": "COMPLETED"}


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


class MediaJobTests(unittest.TestCase):
    def test_scene_rectangles_are_converted_to_source_pixel_regions(self) -> None:
        regions = scene_blur_regions(assignment("a" * 64)["execution"]["sceneSettings"], 1920, 1080)  # type: ignore[arg-type]
        self.assertEqual(regions[0].box.xmin, 192)
        self.assertEqual(regions[0].box.ymin, 756)
        self.assertEqual(regions[1].box.xmax, 1824)

    def test_execute_streams_input_runs_pipeline_and_completes_output(self) -> None:
        client = FakeClient()
        output_bytes = b"rendered-output"

        def pipeline(source: Path, workspace: Path, settings: object, job_id: str) -> Path:
            self.assertEqual(job_id, "job-1")
            self.assertEqual(source.read_bytes(), b"input")
            result = workspace / "published" / "part-001.mp4"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_bytes(output_bytes)
            return result

        FakeTransfer.instances.clear()
        executor = MediaJobExecutor(client, transfer_factory=FakeTransfer, pipeline=pipeline)
        with tempfile.TemporaryDirectory() as root:
            executor.execute(assignment(hashlib.sha256(b"input").hexdigest()), Path(root))
        transfer = FakeTransfer.instances[0]
        self.assertEqual(transfer.downloads[0][0], "drive-source-1")
        self.assertEqual(transfer.uploads[0][0].startswith("https://www.googleapis.com/"), True)
        self.assertEqual([event for event, _ in client.events], ["progress", "progress", "renew", "renew", "progress", "output-session", "complete"])

    def test_rejects_missing_source_digest(self) -> None:
        invalid = assignment("a" * 64)
        invalid["execution"]["source"].pop("sha256")  # type: ignore[index]
        with self.assertRaises(MediaJobError):
            MediaJobExecutor(FakeClient(), transfer_factory=FakeTransfer, pipeline=lambda *_args: Path("missing.mp4")).execute(invalid, Path(tempfile.gettempdir()))


if __name__ == "__main__":
    unittest.main()
