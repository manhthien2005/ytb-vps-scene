from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping
from fractions import Fraction
from pathlib import Path
from typing import Any


def _media_binaries() -> tuple[str, str]:
    # Ubuntu 22.04's system FFmpeg 4.4 lacks the v2 -fps_mode contract, so the
    # bootstrap installs a static 7.0 build and exports these. Fall back to the
    # bare names for local development where the modern binary is on PATH.
    return (
        os.environ.get("YTB_VPS_FFMPEG", "ffmpeg"),
        os.environ.get("YTB_VPS_FFPROBE", "ffprobe"),
    )

from ytb_vps_v2.adapters.drive.media_transfer import DriveMediaTransfer
from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaAdapter
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.composition import LocalArtifactWriterFactory, LocalFileDigestVerifier, LocalPartPublisherFactory
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity
from ytb_vps_v2.adapters.offline.capcut_tts import CapCutTtsProvider
from ytb_vps_v2.adapters.offline.providers import DeterministicOcrProvider, DeterministicTranslationProvider
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.media_job import MediaJobError, MediaJobExecutor, scene_blur_regions
from ytb_vps_v2.application.offline_slice import OfflineSliceRequest, OfflineSliceRunner
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import JobId


def _canonical_source(source: Path, workspace: Path, media: FfmpegMediaAdapter, ffmpeg: str) -> tuple[Path, Any]:
    document = media.probe(source)
    if document.frame_count == 900 and document.source_fps == Fraction(30, 1):
        return source, document
    normalized = workspace / "normalized" / "source.mp4"
    normalized.parent.mkdir(parents=True, exist_ok=True)
    command = [ffmpeg, "-y", "-i", str(source), "-t", "30", "-vf", "fps=30", "-frames:v", "900", "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    command.extend(["-af", "apad,atrim=duration=30", "-c:a", "aac"] if document.has_audio else ["-an"])
    command.extend(["-movflags", "+faststart", str(normalized)])
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=600)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise MediaJobError("source could not be normalized to the canonical 30-second slice") from error
    return normalized, media.probe(normalized)


def run_native_pipeline(source: Path, workspace: Path, settings: Mapping[str, Any], job_id_value: str) -> Path:
    ffmpeg, ffprobe = _media_binaries()
    media = FfmpegMediaAdapter(ffmpeg=ffmpeg, ffprobe=ffprobe)
    canonical_source, media_document = _canonical_source(source, workspace, media, ffmpeg)
    blur_regions = scene_blur_regions(settings, media_document.width, media_document.height)
    workspace.mkdir(parents=True, exist_ok=True)
    archive_root, remote_root, snapshot_root = workspace / "archive", workspace / "remote", workspace / "snapshots"
    state_path = workspace / "state" / "job-v2.sqlite"
    for directory in (archive_root, remote_root, snapshot_root, state_path.parent):
        directory.mkdir(parents=True, exist_ok=True)
    job_id = JobId(job_id_value)
    archive = VerifiedInputArchiver(archive_root).archive(canonical_source, job_id, "2026-01-01T00:00:00Z")
    archived_source = archive_root.joinpath(*archive.archive.key.parts)
    state = SqliteStateStore(state_path)
    try:
        result = OfflineSliceRunner(
            state,
            CheckpointPublisher(state, LocalAdditiveObjectStore(remote_root), archive_root, LocalFileIntegrity()),
            media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(target_language="vi"),
            CapCutTtsProvider(rate=float(settings.get("rate", 1)), ffmpeg=ffmpeg),
            LocalArtifactWriterFactory(), LocalPartPublisherFactory(), LocalFileDigestVerifier(),
        ).run(OfflineSliceRequest(
            job_id=job_id, source=archived_source, verified_input=archive,
            config_fingerprints=stage_config_fingerprints(EffectiveConfig()),
            workspace_root=workspace / "pipeline", snapshot_dir=snapshot_root, output_has_audio=True,
            at="2026-01-01T00:00:01Z", verification_observed_at=1, blur_regions=blur_regions,
        ))
    finally:
        state.close()
    return result.workspace_root / "published" / "part-001.mp4"


def create_native_media_executor(client: Any) -> MediaJobExecutor:
    return MediaJobExecutor(client, transfer_factory=DriveMediaTransfer, pipeline=run_native_pipeline)
