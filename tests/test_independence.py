from __future__ import annotations

import unittest
from pathlib import Path


class IndependenceTests(unittest.TestCase):
    def test_runtime_does_not_import_legacy_packages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        banned = (
            "queue_pipeline",
            "tight_mask_pipeline",
            "balanced_pipeline",
            "from modules",
            "_external",
        )
        violations = []
        for directory in (root / "app", root / "containers"):
            for path in directory.rglob("*.py"):
                text = path.read_text(encoding="utf-8")
                for token in banned:
                    if token in text:
                        violations.append(f"{path.relative_to(root)}: {token}")
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()

