from __future__ import annotations

import builtins
import importlib
import json
import sys
import unittest
from unittest.mock import patch

from ytb_vps_v2.ports.pipeline import ProviderError


class OnnxSmokeAdapterTests(unittest.TestCase):
    def test_import_does_not_load_onnxruntime(self) -> None:
        sys.modules.pop("ytb_vps_v2.adapters.ocr.onnx", None)
        before = "onnxruntime" in sys.modules
        module = importlib.import_module("ytb_vps_v2.adapters.ocr.onnx")
        self.assertIsNotNone(module)
        self.assertEqual(before, "onnxruntime" in sys.modules)

    def test_injected_cuda_probe_returns_shared_report(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter

        adapter = OnnxOcrSmokeAdapter(
            model_revision="ocr-r1",
            provider_probe=lambda: ("CUDAExecutionProvider", "CPUExecutionProvider"),
        )
        self.assertEqual(
            adapter.smoke().providers,
            ("CUDAExecutionProvider", "CPUExecutionProvider"),
        )

    def test_cpu_only_probe_is_a_provider_error(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter

        adapter = OnnxOcrSmokeAdapter(
            model_revision="ocr-r1", provider_probe=lambda: ("CPUExecutionProvider",)
        )
        with self.assertRaisesRegex(ProviderError, "CUDAExecutionProvider"):
            adapter.smoke()

    def test_missing_onnxruntime_is_a_provider_error(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter

        adapter = OnnxOcrSmokeAdapter(model_revision="ocr-r1", model_path="model.onnx")
        real_import = importlib.import_module

        def fail(name: str, package: str | None = None):
            if name == "onnxruntime":
                raise ModuleNotFoundError("onnxruntime")
            return real_import(name, package)

        with patch("importlib.import_module", side_effect=fail):
            with self.assertRaisesRegex(ProviderError, "onnxruntime"):
                adapter.smoke()

    def test_probe_failure_and_empty_model_path_are_provider_errors(self) -> None:
        from ytb_vps_v2.adapters.ocr.onnx import OnnxOcrSmokeAdapter

        adapter = OnnxOcrSmokeAdapter(
            model_revision="ocr-r1", provider_probe=lambda: (_ for _ in ()).throw(OSError("GPU"))
        )
        with self.assertRaisesRegex(ProviderError, "probe"):
            adapter.smoke()
        with self.assertRaises(ProviderError):
            OnnxOcrSmokeAdapter(model_revision="ocr-r1", model_path=" ")


class DockerSmokeAdapterTests(unittest.TestCase):
    def test_builds_shell_free_network_none_argv_and_parses_report(self) -> None:
        from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter

        seen: list[tuple[str, ...]] = []

        def run(argv: tuple[str, ...]) -> str:
            seen.append(argv)
            return json.dumps(
                {
                    "backend": "paddle-docker",
                    "providers": ["CUDAExecutionProvider"],
                    "model_revision": "legacy-r2",
                }
            )

        report = DockerOcrSmokeAdapter("registry.example/ocr:2026", runner=run).smoke()
        self.assertEqual(report.backend, "paddle-docker")
        self.assertEqual(seen[0][:4], ("docker", "run", "--rm", "--network"))
        self.assertEqual(seen[0][4], "none")
        self.assertNotIn("sh", seen[0])

    def test_rejects_empty_or_unsafe_image(self) -> None:
        from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter

        for image in ("", "  ", "ocr;rm -rf /", "-bad/image"):
            with self.subTest(image=image), self.assertRaises(ProviderError):
                DockerOcrSmokeAdapter(image, runner=lambda argv: "{}")

    def test_rejects_malformed_smoke_json(self) -> None:
        from ytb_vps_v2.adapters.ocr.docker import DockerOcrSmokeAdapter

        adapter = DockerOcrSmokeAdapter("ocr:latest", runner=lambda argv: "not-json")
        with self.assertRaisesRegex(ProviderError, "JSON"):
            adapter.smoke()


if __name__ == "__main__":
    unittest.main()
