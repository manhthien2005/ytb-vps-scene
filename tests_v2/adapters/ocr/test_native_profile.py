from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


class NativeProfileContractTests(unittest.TestCase):
    def test_native_requirements_use_host_cuda_without_cuda_wheels(self) -> None:
        requirements = (
            ROOT / "containers" / "ocr-v2" / "requirements-native.txt"
        ).read_text(encoding="utf-8").splitlines()
        self.assertIn("onnxruntime-gpu==1.19.2", requirements)
        self.assertIn("rapidocr==3.9.0", requirements)
        self.assertFalse(
            any(requirement.startswith("nvidia-") for requirement in requirements)
        )

    def test_native_bootstrap_pins_ffmpeg_and_cuda_host_contract(self) -> None:
        script = (ROOT / "ops" / "native-v2" / "bootstrap.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("python3.10-venv", script)
        self.assertIn("/usr/local/cuda-12.4", script)
        self.assertIn("ffmpeg-7.0.2-amd64-static.tar.xz", script)
        self.assertIn(
            "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67",
            script,
        )
        self.assertIn("containers/ocr-v2/requirements-native.txt", script)
        self.assertIn(
            "pip install --no-cache-dir --no-deps nvidia-cudnn-cu12==9.24.0.43",
            script,
        )
        self.assertIn('bash "$SCRIPT_DIR/provider-smoke.sh"', script)
        self.assertNotIn("rm -rf", script)

    def test_native_launchers_use_portable_ffmpeg_and_provider_smoke(self) -> None:
        smoke = (ROOT / "ops" / "native-v2" / "provider-smoke.sh").read_text(
            encoding="utf-8"
        )
        worker = (ROOT / "ops" / "native-v2" / "worker.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("ffmpeg-v2", smoke)
        self.assertIn("fps_mode", smoke)
        self.assertNotIn('grep -q -- "-fps_mode"', smoke)
        self.assertIn("provider_smoke.py", smoke)
        self.assertIn("ffmpeg-v2", worker)
        self.assertIn("worker.py", worker)
