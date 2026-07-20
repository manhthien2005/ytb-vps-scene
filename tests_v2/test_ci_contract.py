from __future__ import annotations

import unittest
from pathlib import Path


class CiContractTests(unittest.TestCase):
    def test_workflow_installs_and_tests_v2_on_python_310(self) -> None:
        workflow = Path(".github/workflows/v2-ci.yml").read_text(encoding="utf-8")

        self.assertIn("v2-python310:", workflow)
        self.assertIn("python-version: '3.10'", workflow)
        self.assertIn("python -m pip install --no-deps -e .", workflow)
        self.assertIn("python -m compileall -q src tests_v2", workflow)
        self.assertIn("python -m unittest discover -s tests_v2 -t . -v", workflow)

    def test_development_guide_keeps_public_entry_point_unchanged(self) -> None:
        guide = Path("docs/rebuild/DEVELOPMENT.md").read_text(encoding="utf-8")

        self.assertIn("ytb-vps-v2 version", guide)
        self.assertIn("public `ytb-vps` command remains legacy", guide)
        self.assertIn("Python 3.10", guide)

    def test_control_plane_ci_uses_cp2_markers_and_audits_dependencies(self) -> None:
        workflow = Path(".github/workflows/v2-ci.yml").read_text(encoding="utf-8")

        for marker in (
            "GOOGLE_OAUTH_CLIENT_ID:",
            "GOOGLE_OAUTH_CLIENT_SECRET:",
            "DRIVE_TOKEN_KEY_V1:",
            "NEON_STORAGE_LIMIT_BYTES: '536870912'",
            "DRIVE_UPLOAD_MAX_BYTES: '10737418240'",
            "FREE_TIER_SOFT_PERCENT: '90'",
            "QUOTA_STALE_AFTER_SECONDS: '900'",
        ):
            self.assertIn(marker, workflow)
        self.assertIn("run: npm audit --audit-level=low", workflow)

    def test_operator_guide_documents_free_drive_setup_and_nondestructive_rollback(self) -> None:
        guide = Path("docs/rebuild/DEVELOPMENT.md").read_text(encoding="utf-8")

        for requirement in (
            "https://www.googleapis.com/auth/drive.file",
            "APP_ORIGIN/api/v1/drive/callback",
            "Google OAuth Production",
            "never enable billing",
            "never drop",
            "never delete Drive content",
        ):
            self.assertIn(requirement, guide)


if __name__ == "__main__":
    unittest.main()
