from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ytb_vps_v2.adapters.ffmpeg.canonicalize import (
    canonicalize_arguments,
    plan_canvas,
)
from ytb_vps_v2.adapters.ffmpeg.probe import ProbeError, parse_probe_payload
from ytb_vps_v2.adapters.filesystem.disk_guard import ensure_free_space

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
from ytb_vps_v2.application.media_job import (
    MediaJobError,
    MediaJobExecutor,
    MediaOutput,
    scene_render_projection,
)
from ytb_vps_v2.application.offline_slice import OfflineSliceRequest, OfflineSliceRunner
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import (
    RenderFingerprintInputs,
    legacy_s2_render_fingerprint,
    stage_config_fingerprints,
)
from ytb_vps_v2.domain.models import JobId


def canonicalize_source(
    workspace: Path,
    source: Path,
    *,
    target_fps: int = 30,
    max_width: int = 1920,
    max_height: int = 1080,
) -> tuple[Path, Any]:
    """Normalize accepted media without truncating its canonical timeline."""
    ffmpeg, ffprobe = _media_binaries()
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(source),
            ],
            check=True,
            capture_output=True,
            timeout=120,
            text=True,
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise MediaJobError("source media could not be inspected") from error
    except (TypeError, ValueError) as error:
        raise MediaJobError("source media could not be inspected") from error
    try:
        manifest = parse_probe_payload(payload)
    except (ProbeError, TypeError, ValueError) as error:
        raise MediaJobError("source media could not be inspected") from error

    canvas = plan_canvas(
        manifest,
        max_width=max_width,
        max_height=max_height,
        target_fps=target_fps,
    )
    destination = workspace / "normalized" / "source.mp4"
    destination.parent.mkdir(parents=True, exist_ok=True)
    ensure_free_space(
        destination.parent,
        need_bytes=source.stat().st_size * 3,
    )
    try:
        subprocess.run(
            canonicalize_arguments(
                manifest,
                canvas,
                source=str(source),
                destination=str(destination),
                ffmpeg=ffmpeg,
            ),
            check=True,
            capture_output=True,
            timeout=7200,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise MediaJobError("source could not be canonicalized") from error
    return (
        destination,
        FfmpegMediaAdapter(
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
        ).probe(
            destination,
            target_fps=target_fps,
        ),
    )


def run_native_pipeline(
    source: Path,
    workspace: Path,
    settings: Mapping[str, Any],
    job_id_value: str,
    *,
    config: EffectiveConfig | None = None,
) -> tuple[MediaOutput, ...]:
    ffmpeg, ffprobe = _media_binaries()
    media = FfmpegMediaAdapter(ffmpeg=ffmpeg, ffprobe=ffprobe)
    baseline = EffectiveConfig() if config is None else config
    if not isinstance(baseline, EffectiveConfig):
        raise MediaJobError("native pipeline configuration is invalid")
    canonical_source, media_document = canonicalize_source(
        workspace,
        source,
        target_fps=baseline.media.target_fps,
        max_width=baseline.media.max_width,
        max_height=baseline.media.max_height,
    )
    projection = scene_render_projection(
        settings,
        media_document.width,
        media_document.height,
        frame_count=media_document.frame_count,
    )
    effective = replace(
        baseline,
        tts=replace(
            baseline.tts,
            rate=projection.tts_rate,
        ),
    )
    render_inputs = RenderFingerprintInputs(
        projection.blur_regions,
        output_has_audio=True,
    )
    fingerprints = stage_config_fingerprints(
        effective,
        render_inputs=render_inputs,
    )
    workspace.mkdir(parents=True, exist_ok=True)
    archive_root, remote_root, snapshot_root = workspace / "archive", workspace / "remote", workspace / "snapshots"
    pipeline_root = workspace / "pipeline"
    state_path = workspace / "state" / "job-v2.sqlite"
    for directory in (archive_root, remote_root, snapshot_root, pipeline_root, state_path.parent):
        directory.mkdir(parents=True, exist_ok=True)
    job_id = JobId(job_id_value)
    # Real wall-clock stamps: identical fabricated instants for every job made the
    # durable state DB useless for incident forensics.
    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    archive = VerifiedInputArchiver(archive_root).archive(canonical_source, job_id, started_at)
    archived_source = archive_root.joinpath(*archive.archive.key.parts)
    state = SqliteStateStore(state_path)
    try:
        result = OfflineSliceRunner(
            state,
            CheckpointPublisher(state, LocalAdditiveObjectStore(remote_root), archive_root, LocalFileIntegrity()),
            media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(target_language="vi"),
            CapCutTtsProvider(
                voice=effective.tts.voice,
                resource_id=effective.tts.resource_id,
                rate=float(effective.tts.rate),
                ffmpeg=ffmpeg,
            ),
            LocalArtifactWriterFactory(), LocalPartPublisherFactory(), LocalFileDigestVerifier(),
        ).run(OfflineSliceRequest(
            job_id=job_id, source=archived_source, verified_input=archive,
            config_fingerprints=fingerprints,
            workspace_root=pipeline_root, snapshot_dir=snapshot_root, output_has_audio=True,
            at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            verification_observed_at=1,
            blur_regions=projection.blur_regions,
            target_fps=effective.media.target_fps,
            chunk_seconds=effective.media.chunk_seconds,
            max_part_seconds=effective.render.max_part_seconds,
            legacy_s2_render_fingerprint=legacy_s2_render_fingerprint(
                effective,
                render_inputs=render_inputs,
            ),
        ))
    finally:
        state.close()
    return tuple(
        MediaOutput(
            part.part_index,
            part.part_count,
            result.workspace_root.joinpath(*path.parts),
        )
        for part, path in zip(
            result.publication.parts,
            result.publication.part_paths,
            strict=True,
        )
    )


def create_native_media_executor(client: Any) -> MediaJobExecutor:
    return MediaJobExecutor(client, transfer_factory=DriveMediaTransfer, pipeline=run_native_pipeline)
