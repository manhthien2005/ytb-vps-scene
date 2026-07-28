from __future__ import annotations

import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path, PurePosixPath
from types import SimpleNamespace


class CliTests(unittest.TestCase):
    def test_version_command_returns_zero_and_prints_version(self) -> None:
        from ytb_vps_v2.interfaces.cli import main

        output = StringIO()
        with redirect_stdout(output):
            exit_code = main(["version"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(output.getvalue().strip(), "ytb-vps-v2 0.1.0.dev0")

    def test_module_entry_point_runs_development_cli(self) -> None:
        environment = os.environ.copy()
        environment["PYTHONPATH"] = "src"

        result = subprocess.run(
            [sys.executable, "-m", "ytb_vps_v2", "version"],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
            env=environment,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ytb-vps-v2 0.1.0.dev0")

    def test_parser_exposes_native_worker_commands(self) -> None:
        from ytb_vps_v2.interfaces.cli import build_parser

        parser = build_parser()
        command_arguments = {
            "worker-enroll": ["--origin", "https://app.example", "--token", "A" * 43],
            "worker-run": ["--once"],
            "worker-status": [],
            "worker-detach": [],
        }
        for command, arguments_list in command_arguments.items():
            arguments = parser.parse_args([command, *arguments_list])
            self.assertEqual(arguments.command, command)

    def test_media_run_exposes_only_deterministic_or_capcut_bv074_tts(self) -> None:
        from ytb_vps_v2.interfaces.cli import build_parser

        parser = build_parser()
        arguments = parser.parse_args([
            "media-run", "--source", "source.mp4", "--workspace", "workspace",
            "--tts-provider", "capcut",
        ])
        self.assertEqual(arguments.tts_provider, "capcut")
        self.assertFalse(hasattr(arguments, "voice"))

        with self.assertRaises(SystemExit):
            parser.parse_args([
                "media-run", "--source", "source.mp4", "--workspace", "workspace",
                "--tts-provider", "edge",
            ])

    def test_media_result_payload_emits_multipart_arrays_and_single_aliases(
        self,
    ) -> None:
        from ytb_vps_v2.domain.models import JobId
        from ytb_vps_v2.interfaces import cli

        workspace = Path("workspace").resolve()
        multipart = SimpleNamespace(
            workspace_root=workspace,
            artifacts=(
                SimpleNamespace(
                    name="render-part-000001",
                    relative_path=PurePosixPath(
                        "artifacts/render/parts/part-01-of-02.mp4"
                    ),
                ),
                SimpleNamespace(
                    name="render-part-000002",
                    relative_path=PurePosixPath(
                        "artifacts/render/parts/part-02-of-02.mp4"
                    ),
                ),
            ),
            publication=SimpleNamespace(
                part_paths=(
                    PurePosixPath("published/part-01-of-02.mp4"),
                    PurePosixPath("published/part-02-of-02.mp4"),
                )
            ),
        )

        payload = cli._media_output_payload(
            JobId("job-1"),
            multipart,
        )

        self.assertEqual(len(payload["renderedParts"]), 2)
        self.assertEqual(len(payload["publishedParts"]), 2)
        self.assertNotIn("rendered", payload)
        self.assertNotIn("published", payload)

        single = SimpleNamespace(
            workspace_root=workspace,
            artifacts=(multipart.artifacts[0],),
            publication=SimpleNamespace(
                part_paths=(
                    PurePosixPath("published/part-01-of-01.mp4"),
                )
            ),
        )
        single_payload = cli._media_output_payload(
            JobId("job-1"),
            single,
        )
        self.assertEqual(
            single_payload["rendered"],
            single_payload["renderedParts"][0],
        )
        self.assertEqual(
            single_payload["published"],
            single_payload["publishedParts"][0],
        )

    def test_doctor_fails_without_a_capcut_device_credential(self) -> None:
        # A worker that cannot synthesise the fixed BV074 voice cannot finish any
        # render. Only a PASS doctor report is allowed to claim, so this is what
        # stops it from taking jobs while the credential pool is still being staged.
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from ytb_vps_v2.interfaces import cli

        with tempfile.TemporaryDirectory() as root:
            empty = Path(root)
            environment = {
                "YTB_VPS_CAPCUT_DEVICE_FILE": str(empty / "capcut-device.json"),
                "YTB_VPS_CAPCUT_DEVICE_POOL_DIR": str(empty / "capcut-devices"),
            }
            with patch.dict(os.environ, environment, clear=False):
                self.assertFalse(cli._capcut_credential_present())
                _, doctor = cli._evidence()
                self.assertEqual(doctor["status"], "FAIL")
                self.assertIn("CAPCUT_DEVICE_MISSING", doctor["reasonCodes"])

            (empty / "capcut-devices").mkdir()
            (empty / "capcut-devices" / "device-001.json").write_text("{}", encoding="utf-8")
            with patch.dict(os.environ, environment, clear=False):
                self.assertTrue(cli._capcut_credential_present())
                _, doctor = cli._evidence()
                self.assertIn("CAPCUT_DEVICE_PRESENT", doctor["reasonCodes"])


if __name__ == "__main__":
    unittest.main()
