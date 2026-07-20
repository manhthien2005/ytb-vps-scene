from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from ytb_vps_v2.adapters.control_plane.http import ControlPlaneClient


_SECRET_PATTERN = __import__("re").compile(r"^[A-Za-z0-9_-]{43}$")


class WorkerCredentialStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, value: Mapping[str, Any]) -> None:
        required = {"schemaVersion", "origin", "workerId", "sessionSecret", "sessionExpiresAt"}
        if set(value) != required or value["schemaVersion"] != 1 or not isinstance(value["sessionSecret"], str) or not _SECRET_PATTERN.fullmatch(value["sessionSecret"]):
            raise ValueError("invalid worker credential")
        origin = value["origin"]
        if not isinstance(origin, str) or not origin.startswith("https://"):
            raise ValueError("invalid worker credential origin")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        encoded = json.dumps(dict(value), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        fd, temporary = tempfile.mkstemp(prefix=".credential.", dir=self.path.parent)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            if os.path.exists(temporary):
                try:
                    os.unlink(temporary)
                except PermissionError:
                    pass

    def load(self) -> dict[str, Any]:
        try:
            if os.name != "nt" and self.path.stat().st_mode & 0o777 != 0o600:
                raise ValueError("credential permissions")
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid worker credential") from error
        if not isinstance(value, dict):
            raise ValueError("invalid worker credential")
        required = {"schemaVersion", "origin", "workerId", "sessionSecret", "sessionExpiresAt"}
        if set(value) != required or value.get("schemaVersion") != 1 or not isinstance(value.get("sessionSecret"), str) or not _SECRET_PATTERN.fullmatch(value["sessionSecret"]):
            raise ValueError("invalid worker credential")
        return value


class WorkerClient(Protocol):
    def heartbeat(self, evidence: dict[str, Any]) -> dict[str, Any]: ...
    def claim(self) -> dict[str, Any] | None: ...


class WorkerLoop:
    def __init__(self, client: WorkerClient, capabilities: dict[str, Any], doctor: dict[str, Any]) -> None:
        self.client = client
        self.capabilities = capabilities
        self.doctor = doctor

    def run_once(self) -> str:
        self.client.heartbeat({"capabilities": self.capabilities, "doctor": self.doctor})
        if self.capabilities.get("pipelineBridgeVersion") == "cp3-control-only":
            return "HEARTBEAT_ONLY"
        self.client.claim()
        return "POLL_COMPLETE"
