from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from ytb_vps.config import load_settings
from ytb_vps.logging import configure_logging

SUPERVISOR_CONFIG = "/etc/ytb-vps/supervisord.conf"


def _has_systemd() -> bool:
    return bool(shutil.which("systemctl") and Path("/run/systemd/system").is_dir())


def _supervisorctl(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("supervisorctl")
    if not executable:
        raise RuntimeError("Neither systemd nor Supervisor is available")
    result = subprocess.run(
        [executable, "-c", SUPERVISOR_CONFIG, *arguments],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stdout.strip() or "supervisorctl failed")
    return result


def _ensure_supervisor() -> None:
    status = _supervisorctl("status", check=False)
    if status.returncode == 0:
        return
    executable = shutil.which("supervisord")
    if not executable:
        raise RuntimeError("supervisord is unavailable")
    subprocess.run(
        [executable, "-c", SUPERVISOR_CONFIG], check=True
    )


def _start_service() -> None:
    if _has_systemd():
        subprocess.run(
            ["systemctl", "enable", "--now", "ytb-vps.service"], check=True
        )
        return
    _ensure_supervisor()
    _supervisorctl("reread")
    _supervisorctl("update")
    status = _supervisorctl("status", "ytb-vps", check=False)
    if "RUNNING" not in status.stdout:
        _supervisorctl("start", "ytb-vps")


def _stop_service() -> None:
    if _has_systemd():
        subprocess.run(["systemctl", "stop", "ytb-vps.service"], check=True)
        return
    _ensure_supervisor()
    result = _supervisorctl("stop", "ytb-vps", check=False)
    if result.returncode != 0 and "not running" not in result.stdout.lower():
        raise RuntimeError(result.stdout.strip())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ytb-vps")
    parser.add_argument("--config", help="Configuration YAML path")
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Run environment and service checks")
    doctor.add_argument("--live", action="store_true", help="Call Codex/CapCut/Drive smoke tests")
    doctor.add_argument(
        "--install-only",
        action="store_true",
        help="Check installed runtime without requiring credentials",
    )

    auth = sub.add_parser("auth", help="Configure a credential provider")
    auth.add_argument("provider", choices=("codex", "capcut", "drive"))
    auth.add_argument("source", nargs="?", help="CapCut device.json source path")

    enqueue = sub.add_parser("enqueue", help="Copy a video into the queue")
    enqueue.add_argument("video")

    run = sub.add_parser("run", help="Start the system service or run foreground")
    run.add_argument("--foreground", action="store_true")
    run.add_argument("--dry-run", action="store_true")
    sub.add_parser("worker", help=argparse.SUPPRESS)
    sub.add_parser("status", help="Show queue and job state")

    logs = sub.add_parser("logs", help="Show recent service logs")
    logs.add_argument("--follow", action="store_true")
    sub.add_parser("stop", help="Stop the system service")

    retry = sub.add_parser("retry", help="Reset failed units for a job")
    retry.add_argument("job_id")
    sub.add_parser("backup", help="Back up committed state to Google Drive")
    sub.add_parser("restore", help="Restore state from Google Drive")
    sub.add_parser("models", help="Download and verify pinned OCR models")

    upgrade = sub.add_parser("upgrade", help="Install an updated tools/vps source")
    upgrade.add_argument("source")
    return parser


def _authenticate(provider: str, source: str | None, settings) -> None:
    settings.secrets_root.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        settings.secrets_root.chmod(0o700)
    if provider == "codex":
        env = os.environ.copy()
        env["CODEX_HOME"] = str(settings.secrets_root / "codex")
        Path(env["CODEX_HOME"]).mkdir(parents=True, exist_ok=True)
        subprocess.run([settings.section("translation")["codex_executable"], "login", "--device-auth"], check=True, env=env)
        return
    if provider == "drive":
        config_path = Path(settings.section("drive")["config_file"])
        config_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["rclone", "--config", str(config_path), "config"], check=True
        )
        if os.name != "nt" and config_path.exists():
            config_path.chmod(0o600)
        return
    if not source:
        raise ValueError("auth capcut requires the path to device.json")
    source_path = Path(source).expanduser()
    payload = json.loads(source_path.read_text(encoding="utf-8-sig"))
    required = {"device_id", "iid", "tdid"}
    if not required.issubset(payload):
        raise ValueError(f"device.json is missing: {sorted(required - set(payload))}")
    destination = Path(settings.section("tts")["device_json"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source_path.resolve() != destination.resolve():
        shutil.copy2(source_path, destination)
    if os.name != "nt":
        destination.chmod(0o600)


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.config)
    settings.ensure_layout()
    logger = configure_logging(settings.data_path("logs"), args.verbose)

    if args.command == "doctor":
        from ytb_vps.doctor import run_doctor

        report = run_doctor(settings, live=args.live, install_only=args.install_only)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if not report["ok"]:
            raise SystemExit(1)
    elif args.command == "auth":
        _authenticate(args.provider, args.source, settings)
    elif args.command == "enqueue":
        from ytb_vps.queue import enqueue

        print(enqueue(settings, Path(args.video).expanduser()).resolve())
    elif args.command == "worker":
        from ytb_vps.queue import QueueRunner

        QueueRunner(settings, logger).run_forever(dry_run=False)
    elif args.command == "run" and args.foreground:
        from ytb_vps.queue import QueueRunner

        result = QueueRunner(settings, logger).run(
            dry_run=bool(getattr(args, "dry_run", False))
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.command == "run":
        _start_service()
    elif args.command == "stop":
        _stop_service()
    elif args.command == "status":
        from ytb_vps.queue import all_status

        print(json.dumps(all_status(settings), ensure_ascii=False, indent=2))
    elif args.command == "logs":
        if _has_systemd() and shutil.which("journalctl"):
            command = ["journalctl", "-u", "ytb-vps.service", "-n", "100"]
            if args.follow:
                command.append("-f")
            subprocess.run(command, check=True)
        else:
            path = settings.data_path("logs") / "supervisor.log"
            if args.follow and shutil.which("tail"):
                subprocess.run(["tail", "-n", "100", "-F", str(path)], check=True)
            elif path.exists():
                print("\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-100:]))
            else:
                print(f"No service log yet: {path}")
    elif args.command == "retry":
        from ytb_vps.queue import retry_job

        retry_job(settings, args.job_id)
    elif args.command in {"backup", "restore"}:
        from ytb_vps.backup import backup_all, restore_all

        (backup_all if args.command == "backup" else restore_all)(settings, logger)
    elif args.command == "models":
        from ytb_vps.models import ensure_models

        print(
            json.dumps(
                ensure_models(settings.data_path("models")),
                ensure_ascii=False,
                indent=2,
            )
        )
    elif args.command == "upgrade":
        script = Path(args.source).expanduser() / "install.sh"
        if not script.exists():
            raise FileNotFoundError(script)
        subprocess.run([str(script), "--upgrade"], check=True)


if __name__ == "__main__":
    main()
