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


if __name__ == "__main__":
    unittest.main()
