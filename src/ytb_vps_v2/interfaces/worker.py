from __future__ import annotations

import json
import os
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

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
    def renew(self, job_id: str, fencing_token: int) -> dict[str, Any]: ...
    def progress(self, job_id: str, update: dict[str, Any]) -> dict[str, Any]: ...
    def output_session(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...
    def complete(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...


class WorkerExecutor(Protocol):
    def execute(self, assignment: dict[str, Any], workspace_root: Path) -> str: ...


class WorkerLoop:
    def __init__(
        self,
        client: WorkerClient,
        capabilities: dict[str, Any],
        doctor: dict[str, Any],
        *,
        executor: WorkerExecutor | None = None,
        workspace_root: Path | None = None,
    ) -> None:
        self.client = client
        self.capabilities = capabilities
        self.doctor = doctor
        self.executor = executor
        self.workspace_root = workspace_root or Path("/var/lib/ytb-vps/runs")

    def run_once(self) -> str:
        self.client.heartbeat({"capabilities": self.capabilities, "doctor": self.doctor})
        if self.capabilities.get("pipelineBridgeVersion") == "cp3-control-only":
            return "HEARTBEAT_ONLY"
        assignment = self.client.claim()
        if assignment is None or self.executor is None:
            return "POLL_COMPLETE"
        try:
            self.executor.execute(assignment, self.workspace_root)
        except RuntimeError as error:
            # The executor already best-effort reported FAILED_RETRYABLE to the
            # control plane; a deterministically failing job must not crash-loop
            # the whole worker process. It still has to be visible: when the lease
            # was already lost that report is dropped, and a silent worker leaves
            # the job cycling through claim/fail with no diagnosis anywhere.
            print(f"media job failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return "MEDIA_FAILED"
        return "MEDIA_COMPLETE"
