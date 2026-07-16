from __future__ import annotations

import hashlib
import json
import logging
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Callable

from ytb_vps.config import Settings


def _rclone() -> str:
    executable_path = shutil.which("rclone")
    if not executable_path:
        raise FileNotFoundError("rclone is not installed")
    return executable_path


def _remote(root: str, *parts: str) -> str:
    base = root.rstrip("/")
    suffix = "/".join(part.strip("/").replace("\\", "/") for part in parts)
    return f"{base}/{suffix}" if suffix else base


def _filter_literal(name: str) -> str:
    return (
        name.replace("\\", "\\\\")
        .replace("*", "\\*")
        .replace("?", "\\?")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def local_input_name(remote_name: str, remote_id: str = "") -> str:
    """Build a filesystem-safe local name while retaining the media suffix."""
    source = Path(remote_name)
    suffix = source.suffix.lower()
    identity = remote_id or remote_name
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    return f"drive-input-{digest}{suffix}"


def _base(settings: Settings) -> list[str]:
    command = [
        _rclone(),
        "--config",
        str(settings.section("drive")["config_file"]),
    ]
    if settings.section("drive").get("disable_http2"):
        command.append("--disable-http2")
    return command


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        stderr_tail = "\n".join(result.stderr.splitlines()[-12:])
        stdout_tail = "\n".join(result.stdout.splitlines()[-12:])
        details = "\n".join(item for item in (stderr_tail, stdout_tail) if item).strip()
        if not details:
            details = f"exit code {result.returncode}"
        raise RuntimeError("rclone failed: " + details)
    return result


def sync_input(
    settings: Settings,
    extensions: list[str] | tuple[str, ...],
    *,
    excluded_names: set[str] | None = None,
    on_file_synced: Callable[[str, str], None] | None = None,
) -> dict[str, str]:
    if not settings.section("drive")["enabled"]:
        return {}
    drive = settings.section("drive")
    destination = settings.data_path("input")
    destination.mkdir(parents=True, exist_ok=True)
    root = str(drive["remote_root"])
    allowed = {
        (str(extension).strip() if str(extension).strip().startswith(".") else f".{str(extension).strip()}").lower()
        for extension in extensions
        if str(extension).strip()
    }
    listing = _run([*_base(settings), "lsjson", _remote(root, "input"), "--files-only"])
    try:
        entries = json.loads(listing.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Drive input listing is invalid JSON") from exc
    completed = excluded_names or set()
    synced: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        remote_name = str(entry.get("Name", ""))
        if (
            not remote_name
            or Path(remote_name).name != remote_name
            or remote_name in completed
            or Path(remote_name).suffix.lower() not in allowed
        ):
            continue
        local_name = local_input_name(remote_name, str(entry.get("ID", "")))
        local_path = destination / local_name
        if local_path.is_file():
            synced[local_name] = remote_name
            if on_file_synced is not None:
                on_file_synced(local_name, remote_name)
            continue
        _run(
            [
                *_base(settings),
                "copyto",
                _remote(root, "input", remote_name),
                str(local_path),
                "--transfers",
                str(int(drive["transfers"])),
                "--checkers",
                str(int(drive["checkers"])),
                "--retries",
                str(int(drive["retry_attempts"])),
                "--checksum",
                "--drive-chunk-size",
                str(drive.get("chunk_size", "1M")),
            ]
        )
        synced[local_name] = remote_name
        if on_file_synced is not None:
            on_file_synced(local_name, remote_name)
    return synced


def copy_file(settings: Settings, source: Path, remote_path: str) -> None:
    if not settings.section("drive")["enabled"]:
        return
    drive = settings.section("drive")
    _run(
        [
            *_base(settings),
            "copyto",
            str(source),
            remote_path,
            "--transfers",
            str(int(drive["transfers"])),
            "--checkers",
            str(int(drive["checkers"])),
            "--retries",
            str(int(drive["retry_attempts"])),
            "--checksum",
            "--drive-chunk-size",
            str(drive.get("chunk_size", "1M")),
        ]
    )


def _md5_file(path: Path, block_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()


def remote_file_matches(settings: Settings, source: Path, remote_path: str) -> bool:
    if not settings.section("drive")["enabled"] or not source.is_file():
        return False
    result = _run([*_base(settings), "lsjson", remote_path, "--files-only", "--hash"])
    try:
        entries = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False
    if not isinstance(entries, list) or len(entries) != 1:
        return False
    entry = entries[0]
    if not isinstance(entry, dict) or int(entry.get("Size", -1)) != source.stat().st_size:
        return False
    hashes = entry.get("Hashes")
    remote_md5 = hashes.get("md5") if isinstance(hashes, dict) else None
    return isinstance(remote_md5, str) and remote_md5.lower() == _md5_file(source)


def copy_directory(settings: Settings, source: Path, remote_path: str) -> None:
    if not settings.section("drive")["enabled"] or not source.exists():
        return
    drive = settings.section("drive")
    _run(
        [
            *_base(settings),
            "copy",
            str(source),
            remote_path,
            "--exclude",
            "*.part*",
            "--exclude",
            "*.wav",
            "--transfers",
            str(int(drive["transfers"])),
            "--checkers",
            str(int(drive["checkers"])),
            "--retries",
            str(int(drive["retry_attempts"])),
            "--checksum",
            "--drive-chunk-size",
            str(drive.get("chunk_size", "1M")),
        ]
    )


def backup_input(settings: Settings, path: Path) -> None:
    root = str(settings.section("drive")["remote_root"])
    remote_path = _remote(root, "inbox", path.name)
    copy_file(settings, path, remote_path)
    if not remote_file_matches(settings, path, remote_path):
        raise RuntimeError(f"Drive input archive verification failed: {path.name}")


def backup_output(
    settings: Settings, path: Path, *, remote_path: str | None = None
) -> str:
    root = str(settings.section("drive")["remote_root"])
    destination = remote_path or _remote(root, "output", path.name)
    copy_file(settings, path, destination)
    if not remote_file_matches(settings, path, destination):
        raise RuntimeError(f"Drive output verification failed: {path.name}")
    return destination


def delete_processed_input(
    settings: Settings, path: Path, *, remote_name: str | None = None
) -> None:
    """Remove a consumed queue item after final artifacts reached Drive."""
    if not settings.section("drive")["enabled"]:
        return
    root = str(settings.section("drive")["remote_root"])
    name = remote_name or path.name
    if Path(name).name != name:
        raise ValueError(f"Unsafe Drive input name: {name}")
    remote_path = _remote(root, "input", name)
    if not remote_file_matches(settings, path, remote_path):
        raise RuntimeError(f"Drive input verification failed: {path.name}")
    _run([*_base(settings), "deletefile", remote_path])


def _snapshot_database(database: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.unlink(missing_ok=True)
    source_connection = sqlite3.connect(database)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.backup(target_connection)
        target_connection.commit()
    finally:
        target_connection.close()
        source_connection.close()
    temporary.replace(destination)


def backup_job(settings: Settings, workspace: Path, job_id: str) -> None:
    if not settings.section("drive")["enabled"]:
        return
    root = str(settings.section("drive")["remote_root"])
    snapshot = workspace / "backup" / "job.sqlite"
    _snapshot_database(workspace / "job.sqlite", snapshot)
    copy_file(settings, snapshot, _remote(root, "jobs", job_id, "job.sqlite"))
    for relative in (
        "ocr",
        "translation/cache",
        "tts/raw",
        "render/chunks",
        "subtitles",
    ):
        copy_directory(
            settings,
            workspace / relative,
            _remote(root, "jobs", job_id, relative),
        )


def backup_all(settings: Settings, logger: logging.Logger) -> None:
    root = str(settings.section("drive")["remote_root"])
    for path in settings.data_path("input").iterdir():
        if path.is_file():
            logger.info("Backing up input %s", path.name)
            backup_input(settings, path)
    for workspace in settings.data_path("work").iterdir():
        if workspace.is_dir() and (workspace / "job.sqlite").exists():
            logger.info("Backing up job %s", workspace.name)
            backup_job(settings, workspace, workspace.name)
    copy_directory(settings, settings.data_path("output"), _remote(root, "output"))


def restore_all(settings: Settings, logger: logging.Logger) -> None:
    if not settings.section("drive")["enabled"]:
        raise RuntimeError("Google Drive is disabled in configuration")
    root = str(settings.section("drive")["remote_root"])
    mappings = (
        (_remote(root, "inbox"), settings.data_path("input")),
        (_remote(root, "jobs"), settings.data_path("work")),
        (_remote(root, "output"), settings.data_path("output")),
    )
    for remote_path, destination in mappings:
        destination.mkdir(parents=True, exist_ok=True)
        logger.info("Restoring %s to %s", remote_path, destination)
        _run(
            [
                *_base(settings),
                "copy",
                remote_path,
                str(destination),
                "--ignore-existing",
            ]
        )
