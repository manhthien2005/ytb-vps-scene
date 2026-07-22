from __future__ import annotations

import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO


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


if __name__ == "__main__":
    unittest.main()
