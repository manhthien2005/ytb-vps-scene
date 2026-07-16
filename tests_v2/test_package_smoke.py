from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path


class PackageSmokeTests(unittest.TestCase):
    def test_package_import_is_independent_from_legacy(self) -> None:
        sys.modules.pop("ytb_vps_v2", None)
        module = importlib.import_module("ytb_vps_v2")

        self.assertEqual(module.__version__, "0.1.0.dev0")
        self.assertNotIn("ytb_vps", sys.modules)

    def test_project_metadata_uses_src_layout_and_dev_entry_point(self) -> None:
        metadata = Path("pyproject.toml").read_text(encoding="utf-8")

        self.assertIn('requires-python = ">=3.10,<3.13"', metadata)
        self.assertIn(
            'ytb-vps-v2 = "ytb_vps_v2.interfaces.cli:main"',
            metadata,
        )
        self.assertNotIn('\nytb-vps = "', metadata)
        self.assertIn('package-dir = {"" = "src"}', metadata)


if __name__ == "__main__":
    unittest.main()
