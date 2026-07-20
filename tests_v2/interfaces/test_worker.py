from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from ytb_vps_v2.adapters.control_plane.http import HttpResponse
from ytb_vps_v2.interfaces.worker import WorkerCredentialStore, WorkerLoop


class FakeClient:
    def __init__(self) -> None:
        self.heartbeats = 0
        self.claims = 0

    def enroll(self, token: str, evidence: dict[str, object]) -> dict[str, str]:
        return {"workerId": "10000000-0000-4000-8000-000000000001", "sessionSecret": "A" * 43, "sessionExpiresAt": "2026-07-21T08:30:00.000Z"}

    def heartbeat(self, evidence: dict[str, object]) -> dict[str, str]:
        self.heartbeats += 1
        return {"state": "READY", "lastHeartbeatAt": "2026-07-20T08:30:00.000Z"}

    def claim(self) -> dict[str, object] | None:
        self.claims += 1
        return None


class WorkerTests(unittest.TestCase):
    def test_credential_store_uses_0700_directory_and_0600_file(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "worker" / "credential.json"
            store = WorkerCredentialStore(path)
            store.save({"schemaVersion": 1, "origin": "https://app.example", "workerId": "id", "sessionSecret": "A" * 43, "sessionExpiresAt": "2026-07-21T08:30:00.000Z"})
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(store.load()["workerId"], "id")

    def test_corrupted_credentials_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "credential.json"
            path.parent.mkdir(mode=0o700, exist_ok=True)
            path.write_text("{}", encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaisesRegex(ValueError, "credential"):
                WorkerCredentialStore(path).load()

    def test_control_only_worker_heartbeats_but_never_claims(self) -> None:
        client = FakeClient()
        loop = WorkerLoop(client=client, capabilities={"pipelineBridgeVersion": "cp3-control-only"}, doctor={"status": "PASS"})
        self.assertEqual(loop.run_once(), "HEARTBEAT_ONLY")
        self.assertEqual(client.heartbeats, 1)
        self.assertEqual(client.claims, 0)


if __name__ == "__main__":
    unittest.main()
