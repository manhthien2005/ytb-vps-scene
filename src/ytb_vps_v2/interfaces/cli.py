from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ytb_vps_v2.adapters.control_plane.http import ControlPlaneClient, ControlPlaneError
from ytb_vps_v2.interfaces.worker import WorkerCredentialStore, WorkerLoop
from ytb_vps_v2 import __version__


DEFAULT_CREDENTIAL_PATH = Path("/var/lib/ytb-vps/worker-credential.json")


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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "version":
        print(f"ytb-vps-v2 {__version__}")
        return 0
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
