from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, RegionKind
from ytb_vps_v2.domain.timeline import FrameInterval


class MediaJobError(RuntimeError):
    """Raised when a claimed native media job cannot be completed safely."""


class ControlPlaneMediaClient(Protocol):
    def progress(self, job_id: str, update: dict[str, Any]) -> dict[str, Any]: ...
    def renew(self, job_id: str, fencing_token: int) -> dict[str, Any]: ...
    def output_session(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...
    def complete(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...


def _digest_file(path: Path) -> tuple[int, str]:
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def _rectangle(settings: Mapping[str, Any], name: str, width: int, height: int) -> BlurRegion:
    value = settings.get(name)
    if not isinstance(value, Mapping):
        raise MediaJobError(f"scene setting {name} is invalid")
    try:
        x = float(value["x"])
        y = float(value["y"])
        w = float(value["width"])
        h = float(value["height"])
    except (KeyError, TypeError, ValueError) as error:
        raise MediaJobError(f"scene setting {name} is invalid") from error
    if not all(0 <= item <= 1 for item in (x, y, w, h)) or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
        raise MediaJobError(f"scene setting {name} is outside the source")
    xmin, ymin = round(x * width), round(y * height)
    xmax, ymax = round((x + w) * width), round((y + h) * height)
    if xmax - xmin < 8 or ymax - ymin < 8:
        raise MediaJobError(f"scene setting {name} is smaller than 8 source pixels")
    return BlurRegion(RegionKind.STATIC, FrameInterval(0, 1), BoundingBox(xmin, ymin, xmax, ymax))


def scene_blur_regions(settings: Mapping[str, Any], width: int, height: int) -> tuple[BlurRegion, ...]:
    if not isinstance(settings, Mapping):
        raise MediaJobError("scene settings are invalid")
    return (_rectangle(settings, "sourceSubtitle", width, height), _rectangle(settings, "logo", width, height))


class MediaJobExecutor:
    def __init__(
        self,
        client: ControlPlaneMediaClient,
        transfer_factory: Callable[[str], Any],
        pipeline: Callable[[Path, Path, Mapping[str, Any], str], Path],
    ) -> None:
        self.client = client
        self.transfer_factory = transfer_factory
        self.pipeline = pipeline

    def execute(self, assignment: Mapping[str, Any], workspace_root: Path) -> str:
        try:
            job = assignment["job"]
            lease = assignment["lease"]
            execution = assignment["execution"]
            job_id = str(job["id"])
            fencing_token = int(lease["fencingToken"])
            access_token = str(assignment["driveAccessToken"])
            source = execution["source"]
            settings = execution["sceneSettings"]
            project_id = str(execution["projectId"])
            if str(job.get("state")) != "CLAIMED" or not project_id or not access_token:
                raise MediaJobError("assignment is invalid")
            source_path = workspace_root / job_id / "source.mp4"
            run_root = workspace_root / job_id
            self.client.progress(job_id, {"fencingToken": fencing_token, "fromState": "CLAIMED", "state": "DOWNLOADING", "progressPercent": 5})
            transfer = self.transfer_factory(access_token)
            transfer.download_source(str(source["driveFileId"]), source_path, int(source["sizeBytes"]), str(source["sha256"]))
            self.client.progress(job_id, {"fencingToken": fencing_token, "fromState": "DOWNLOADING", "state": "OCR", "progressPercent": 20})
            self.client.renew(job_id, fencing_token)
            output = self.pipeline(source_path, run_root, settings, job_id)
            size, checksum = _digest_file(output)
            self.client.renew(job_id, fencing_token)
            self.client.progress(job_id, {"fencingToken": fencing_token, "fromState": "OCR", "state": "UPLOADING", "progressPercent": 90})
            session = self.client.output_session(job_id, {"fencingToken": fencing_token, "sizeBytes": size, "checksumSha256": checksum})
            transfer.upload_resumable(str(session["sessionUri"]), output, size, checksum)
            self.client.complete(job_id, {"artifactId": str(session["artifactId"]), "driveFileId": str(session["driveFileId"]), "fencingToken": fencing_token, "sizeBytes": size})
            return "COMPLETED"
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise MediaJobError("assignment execution failed") from error
