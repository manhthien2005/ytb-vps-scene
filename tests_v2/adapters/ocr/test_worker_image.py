from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


class WorkerImageContractTests(unittest.TestCase):
    def test_v2_runtime_requirements_pin_cuda_stack(self) -> None:
        requirements_path = ROOT / "containers" / "ocr-v2" / "requirements.txt"
        self.assertTrue(requirements_path.is_file())
        requirements = requirements_path.read_text(encoding="utf-8").splitlines()
        for requirement in (
            "numpy==2.2.6",
            "onnxruntime-gpu==1.19.2",
            "rapidocr==3.9.0",
            "nvidia-cuda-runtime-cu12==12.4.127",
            "nvidia-cublas-cu12==12.4.5.8",
            "nvidia-cufft-cu12==11.2.1.3",
            "nvidia-curand-cu12==10.3.5.147",
            "nvidia-cusolver-cu12==11.6.1.9",
            "nvidia-cusparse-cu12==12.3.1.170",
            "nvidia-cudnn-cu12==9.24.0.43",
            "nvidia-nvjitlink-cu12==12.4.127",
            "nvidia-nvtx-cu12==12.4.127",
        ):
            self.assertIn(requirement, requirements)

    def test_dockerfile_bootstraps_reproducible_gpu_runtime(self) -> None:
        dockerfile = (ROOT / "containers" / "ocr-v2" / "Dockerfile").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "FROM python:3.10-slim-bookworm@sha256:9643927a6fc74bd81b0f1bbb5cce3cb4a491f46b4c5dbee770f28e575f180015",
            dockerfile,
        )
        self.assertIn("apt-get install", dockerfile)
        self.assertIn("ffmpeg", dockerfile)
        self.assertIn("libgl1", dockerfile)
        self.assertIn("libglib2.0-0", dockerfile)
        self.assertIn("fps_mode", dockerfile)
        self.assertIn("COPY containers/ocr-v2/requirements.txt", dockerfile)
        self.assertIn("pip install --no-cache-dir -r", dockerfile)
        self.assertIn("COPY containers/ocr-v2/entrypoint.sh", dockerfile)
        self.assertIn("COPY containers/ocr-v2/provider_smoke.py", dockerfile)
        self.assertIn('ENTRYPOINT ["ytb-vps-v2-ocr"]', dockerfile)

    def test_v2_readme_documents_gpu_run_and_provider_smoke(self) -> None:
        readme = (ROOT / "containers" / "ocr-v2" / "README.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("--gpus all", readme)
        self.assertIn("provider", readme.lower())
        self.assertIn("--provider-smoke", readme)

    def test_v2_worker_has_stdout_entrypoint_and_does_not_import_legacy(self) -> None:
        worker = (ROOT / "containers" / "ocr-v2" / "worker.py").read_text(encoding="utf-8")
        self.assertIn('sys.stdout', worker)
        self.assertIn('sys.stderr', worker)
        self.assertNotIn("containers.ocr", worker)
        self.assertNotIn("paddleocr", worker)

    def test_dockerfile_installs_v2_package_without_legacy_copy(self) -> None:
        dockerfile = (ROOT / "containers" / "ocr-v2" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY src ./src", dockerfile)
        self.assertIn('ENTRYPOINT ["ytb-vps-v2-ocr"]', dockerfile)
        self.assertNotIn("ocr-legacy", dockerfile)
