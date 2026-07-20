from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Callable, Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

from ytb_vps_v2.adapters.drive.media_transfer import DriveMediaTransfer
from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaAdapter
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.composition import (
    LocalArtifactWriterFactory,
    LocalFileDigestVerifier,
    LocalPartPublisherFactory,
)
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity, digest_file
from ytb_vps_v2.adapters.offline.providers import DeterministicOcrProvider, DeterministicTranslationProvider, EdgeTtsProvider
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.offline_slice import OfflineSliceRequest, OfflineSliceRunner
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, JobId, RegionKind
from ytb_vps_v2.domain.timeline import FrameInterval


class MediaJobError(RuntimeError):
    """Raised when a claimed native media job cannot be completed safely."""


class ControlPlaneMediaClient(Protocol):
    def progress(self, job_id: str, update: dict[str, Any]) -> dict[str, Any]: ...
    def renew(self, job_id: str, fencing_token: int) -> dict[str, Any]: ...
    def output_session(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...
    def complete(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...


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


def _sha256(path: Path) -> tuple[int, str]:
    digest = digest_file(path)
    return digest.size_bytes, digest.sha256


def _canonical_source(source: Path, workspace: Path, media: FfmpegMediaAdapter) -> tuple[Path, Any]:
    document = media.probe(source)
    if document.frame_count == 900 and document.source_fps == Fraction(30, 1):
        return source, document
    normalized = workspace / "normalized" / "source.mp4"
    normalized.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-i", str(source), "-t", "30",
        "-vf", "fps=30", "-frames:v", "900",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]
    if document.has_audio:
        command.extend(["-af", "apad,atrim=duration=30", "-c:a", "aac"])
    else:
        command.append("-an")
    command.extend(["-movflags", "+faststart", str(normalized)])
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=600)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise MediaJobError("source could not be normalized to the canonical 30-second slice") from error
    return normalized, media.probe(normalized)


def run_native_pipeline(source: Path, workspace: Path, settings: Mapping[str, Any], job_id_value: str) -> Path:
    media = FfmpegMediaAdapter()
    canonical_source, media_document = _canonical_source(source, workspace, media)
    blur_regions = scene_blur_regions(settings, media_document.width, media_document.height)
    workspace.mkdir(parents=True, exist_ok=True)
    archive_root = workspace / "archive"
    remote_root = workspace / "remote"
    snapshot_root = workspace / "snapshots"
    state_path = workspace / "state" / "job-v2.sqlite"
    for directory in (archive_root, remote_root, snapshot_root, state_path.parent):
        directory.mkdir(parents=True, exist_ok=True)
    job_id = JobId(job_id_value)
    archive = VerifiedInputArchiver(archive_root).archive(canonical_source, job_id, "2026-01-01T00:00:00Z")
    archived_source = archive_root.joinpath(*archive.archive.key.parts)
    state = SqliteStateStore(state_path)
    try:
        checkpoints = CheckpointPublisher(state, LocalAdditiveObjectStore(remote_root), archive_root, LocalFileIntegrity())
        result = OfflineSliceRunner(
            state,
            checkpoints,
            media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(target_language="vi"),
            EdgeTtsProvider(voice=str(settings.get("voice", "vi-VN-HoaiMyNeural")), rate=float(settings.get("rate", 1))),
            LocalArtifactWriterFactory(),
            LocalPartPublisherFactory(),
            LocalFileDigestVerifier(),
        ).run(OfflineSliceRequest(
            job_id=job_id,
            source=archived_source,
            verified_input=archive,
            config_fingerprints=stage_config_fingerprints(EffectiveConfig()),
            workspace_root=workspace / "pipeline",
            snapshot_dir=snapshot_root,
            output_has_audio=True,
            at="2026-01-01T00:00:01Z",
            verification_observed_at=1,
            blur_regions=blur_regions,
        ))
    finally:
        state.close()
    return result.workspace_root / "published" / "part-001.mp4"


class MediaJobExecutor:
    def __init__(
        self,
        client: ControlPlaneMediaClient,
        transfer_factory: Callable[[str], DriveMediaTransfer] = DriveMediaTransfer,
        pipeline: Callable[[Path, Path, Mapping[str, Any], str], Path] = run_native_pipeline,
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
            size, checksum = _sha256(output)
            self.client.renew(job_id, fencing_token)
            self.client.progress(job_id, {"fencingToken": fencing_token, "fromState": "OCR", "state": "UPLOADING", "progressPercent": 90})
            session = self.client.output_session(job_id, {"fencingToken": fencing_token, "sizeBytes": size, "checksumSha256": checksum})
            transfer.upload_resumable(str(session["sessionUri"]), output, size, checksum)
            self.client.complete(job_id, {"artifactId": str(session["artifactId"]), "driveFileId": str(session["driveFileId"]), "fencingToken": fencing_token, "sizeBytes": size})
            return "COMPLETED"
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise MediaJobError("assignment execution failed") from error
