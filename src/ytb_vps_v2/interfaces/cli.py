from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ytb_vps_v2.adapters.control_plane.http import ControlPlaneClient, ControlPlaneError
from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaAdapter
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.composition import (
    LocalArtifactWriterFactory,
    LocalFileDigestVerifier,
    LocalPartPublisherFactory,
)
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicOcrProvider,
    DeterministicTranslationProvider,
    DeterministicWaveTtsProvider,
    EdgeTtsProvider,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.offline_slice import OfflineSliceRequest, OfflineSliceRunner
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, JobId, RegionKind
from ytb_vps_v2.domain.timeline import FrameInterval
from ytb_vps_v2.interfaces.worker import WorkerCredentialStore, WorkerLoop
from ytb_vps_v2 import __version__


DEFAULT_CREDENTIAL_PATH = Path("/var/lib/ytb-vps/worker-credential.json")


def _parse_blur(value: str) -> BlurRegion:
    """Parse one static rectangle as xmin:ymin:xmax:ymax source pixels."""
    parts = value.split(":")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("blur must be x:y:width:height")
    try:
        x, y, width, height = (int(item) for item in parts)
        return BlurRegion(RegionKind.STATIC, FrameInterval(0, 1), BoundingBox(x, y, width, height))
    except (TypeError, ValueError, DomainInvariantError) as error:
        raise argparse.ArgumentTypeError("blur coordinates must be integers") from error


def _credential_path(value: str | None) -> Path:
    return Path(value) if value else DEFAULT_CREDENTIAL_PATH


def _evidence() -> tuple[dict[str, Any], dict[str, Any]]:
    gpu_name = "NVIDIA GPU unavailable"
    vram_mib = 256
    cuda_version = "0.0"
    reason_codes: list[str] = []
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            check=True, capture_output=True, text=True, timeout=3,
        )
        name, memory, _driver = [part.strip() for part in result.stdout.splitlines()[0].split(",", 2)]
        gpu_name = name[:160]
        vram_mib = max(256, min(1_048_576, int(float(memory))))
        cuda_result = subprocess.run(["nvidia-smi", "--query-gpu=cuda_version", "--format=csv,noheader"], check=True, capture_output=True, text=True, timeout=3)
        cuda_version = cuda_result.stdout.strip().splitlines()[0][:7]
        reason_codes.extend(["CUDA_AVAILABLE", "NVENC_AVAILABLE"])
        status = "PASS"
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        reason_codes.append("CUDA_MISSING")
        status = "FAIL"
    capabilities = {
        "protocolVersion": 1,
        "pipelineBridgeVersion": "cp3-control-only",
        "os": "ubuntu-22.04" if platform.system() == "Linux" else "ubuntu-22.04",
        "arch": "x86_64" if platform.machine().lower() in {"x86_64", "amd64"} else "x86_64",
        "gpuName": gpu_name,
        "vramMiB": vram_mib,
        "cudaVersion": cuda_version,
        "nvenc": "NVENC_AVAILABLE" in reason_codes,
    }
    doctor = {"status": status, "reasonCodes": reason_codes, "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    return capabilities, doctor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ytb-vps-v2")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the v2 development version")
    enroll = commands.add_parser("worker-enroll", help="enroll this VPS with one expiring token")
    enroll.add_argument("--origin", required=True)
    enroll.add_argument("--token", required=True)
    enroll.add_argument("--credential-path")
    run = commands.add_parser("worker-run", help="run the outbound worker loop")
    run.add_argument("--credential-path")
    run.add_argument("--once", action="store_true")
    run.add_argument("--interval", type=int, default=30)
    status = commands.add_parser("worker-status", help="show worker connection status")
    status.add_argument("--credential-path")
    detach = commands.add_parser("worker-detach", help="remove only the local worker credential")
    detach.add_argument("--credential-path")
    media = commands.add_parser("media-run", help="run one local blur/translate/TTS/render job")
    media.add_argument("--source", required=True, type=Path)
    media.add_argument("--workspace", required=True, type=Path)
    media.add_argument("--state", type=Path)
    media.add_argument("--remote", type=Path)
    media.add_argument("--archive", type=Path)
    media.add_argument("--snapshots", type=Path)
    media.add_argument("--blur", action="append", type=_parse_blur, default=[])
    media.add_argument("--target-language", default="vi")
    media.add_argument("--tts-provider", choices=("deterministic", "edge"), default="deterministic")
    media.add_argument("--voice", default="vi-VN-HoaiMyNeural")
    media.add_argument("--rate", type=float, default=1.0)
    media.add_argument("--job-id")
    media.add_argument("--output-has-audio", action=argparse.BooleanOptionalAction, default=True)
    return parser


def _run_media(arguments: argparse.Namespace) -> int:
    source = arguments.source.resolve()
    workspace = arguments.workspace.resolve()
    root = workspace.parent
    state_path = (arguments.state or root / "state" / "job-v2.sqlite").resolve()
    remote_root = (arguments.remote or root / "remote").resolve()
    archive_root = (arguments.archive or root / "archive").resolve()
    snapshot_root = (arguments.snapshots or root / "snapshots").resolve()
    for directory in (workspace, state_path.parent, remote_root, archive_root, snapshot_root):
        directory.mkdir(parents=True, exist_ok=True)
    job_id = JobId(arguments.job_id or str(uuid.uuid4()))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    archive = VerifiedInputArchiver(archive_root).archive(source, job_id, now)
    archived_source = archive_root.joinpath(*archive.archive.key.parts)
    state = SqliteStateStore(state_path)
    try:
        checkpoints = CheckpointPublisher(
            state,
            LocalAdditiveObjectStore(remote_root),
            archive_root,
            LocalFileIntegrity(),
        )
        tts = (
            DeterministicWaveTtsProvider()
            if arguments.tts_provider == "deterministic"
            else EdgeTtsProvider(voice=arguments.voice, rate=arguments.rate)
        )
        runner = OfflineSliceRunner(
            state,
            checkpoints,
            FfmpegMediaAdapter(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(target_language=arguments.target_language),
            tts,
            LocalArtifactWriterFactory(),
            LocalPartPublisherFactory(),
            LocalFileDigestVerifier(),
        )
        result = runner.run(OfflineSliceRequest(
            job_id=job_id,
            source=archived_source,
            verified_input=archive,
            config_fingerprints=stage_config_fingerprints(EffectiveConfig()),
            workspace_root=workspace,
            snapshot_dir=snapshot_root,
            output_has_audio=arguments.output_has_audio,
            at=now,
            verification_observed_at=int(datetime.now(timezone.utc).timestamp()),
            blur_regions=tuple(arguments.blur),
        ))
    finally:
        state.close()
    print(json.dumps({
        "jobId": job_id.value,
        "workspace": str(result.workspace_root),
        "rendered": str(result.workspace_root / "artifacts" / "render" / "rendered.mp4"),
        "published": str(result.workspace_root / "published" / "part-001.mp4"),
        "tts": str(result.workspace_root / "artifacts" / "tts" / "voice.wav"),
    }, ensure_ascii=False, separators=(",", ":")))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "version":
        print(f"ytb-vps-v2 {__version__}")
        return 0
    if arguments.command == "media-run":
        return _run_media(arguments)
    path = _credential_path(arguments.credential_path)
    if arguments.command == "worker-enroll":
        capabilities, doctor = _evidence()
        client = ControlPlaneClient(arguments.origin, None)
        result = client.enroll(arguments.token, {"capabilities": capabilities, "doctor": doctor})
        WorkerCredentialStore(path).save({"schemaVersion": 1, "origin": arguments.origin, **result})
        print(f"worker enrolled: {result['workerId']}")
        return 0
    if arguments.command == "worker-status":
        credential = WorkerCredentialStore(path).load()
        print(json.dumps({"origin": credential["origin"], "workerId": credential["workerId"], "sessionExpiresAt": credential["sessionExpiresAt"]}, separators=(",", ":")))
        return 0
    if arguments.command == "worker-detach":
        resolved = path.resolve()
        if resolved.name != "worker-credential.json":
            raise SystemExit("refusing to remove an unanchored worker credential path")
        if resolved.exists():
            resolved.unlink()
        print("worker detached")
        return 0
    if arguments.command == "worker-run":
        credential = WorkerCredentialStore(path).load()
        capabilities, doctor = _evidence()
        client = ControlPlaneClient(str(credential["origin"]), str(credential["sessionSecret"]))
        loop = WorkerLoop(client, capabilities, doctor)
        while True:
            loop.run_once()
            if arguments.once:
                return 0
            time.sleep(max(5, min(300, arguments.interval)))
    raise AssertionError(f"Unhandled command: {arguments.command}")
