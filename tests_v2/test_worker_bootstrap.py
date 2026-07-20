from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "ops" / "native-v2" / "bootstrap-worker.sh"
SERVICE = ROOT / "ops" / "native-v2" / "ytb-vps-worker.service"


class WorkerBootstrapContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT.read_text(encoding="utf-8")
        cls.service = SERVICE.read_text(encoding="utf-8")

    def test_bootstrap_is_pinned_idempotent_and_native(self) -> None:
        self.assertIn("set -euo pipefail", self.script)
        self.assertIn("ubuntu-22.04", self.script)
        self.assertIn("x86_64", self.script)
        self.assertRegex(self.script, r"\^\[0-9a-f\]\{40\}\$")
        self.assertIn('git -C "$temporary" checkout --detach "$commit"', self.script)
        self.assertIn("python3.10 -m venv", self.script)
        self.assertNotIn("docker", self.script.lower())
        self.assertNotRegex(self.script, r"curl[^\n]*\|[^\n]*(sh|bash)")
        self.assertIn("/opt/ytb-vps/releases/$commit", self.script)
        self.assertIn("ln -sfn", self.script)

    def test_bootstrap_installs_only_after_successful_enrollment(self) -> None:
        enrollment = self.script.index("worker-enroll")
        switch = self.script.index("ln -sfn")
        self.assertLess(enrollment, switch)
        self.assertIn("worker-status", self.script)
        self.assertIn("chmod 700", self.script)
        self.assertIn("chmod 600", self.script)

    def test_systemd_is_least_privilege_and_persistent(self) -> None:
        self.assertIn("User=ytb-vps", self.service)
        self.assertIn("NoNewPrivileges=true", self.service)
        self.assertIn("PrivateTmp=true", self.service)
        self.assertIn("ProtectSystem=strict", self.service)
        self.assertIn("ReadWritePaths=/var/lib/ytb-vps", self.service)
        self.assertIn("Restart=on-failure", self.service)


if __name__ == "__main__":
    unittest.main()
