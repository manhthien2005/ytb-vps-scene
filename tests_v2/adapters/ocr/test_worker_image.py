from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


class WorkerImageContractTests(unittest.TestCase):
    def test_v2_worker_has_stdout_entrypoint_and_does_not_import_legacy(self) -> None:
        worker = (ROOT / "containers" / "ocr-v2" / "worker.py").read_text(encoding="utf-8")
        self.assertIn('sys.stdout', worker)
        self.assertIn('sys.stderr', worker)
        self.assertNotIn("containers.ocr", worker)
        self.assertNotIn("paddleocr", worker)

    def test_dockerfile_installs_v2_package_without_legacy_copy(self) -> None:
        dockerfile = (ROOT / "containers" / "ocr-v2" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY src ./src", dockerfile)
        self.assertIn('ENTRYPOINT ["python", "/app/worker.py"]', dockerfile)
        self.assertNotIn("ocr-legacy", dockerfile)

