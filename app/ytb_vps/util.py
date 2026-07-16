from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def safe_stem(value: str, limit: int = 72) -> str:
    cleaned = re.sub(r"[^\w.-]+", "_", value, flags=re.UNICODE)
    cleaned = cleaned.strip("._-")
    return (cleaned or "video")[:limit]


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.part")
    try:
        temporary.write_text(content, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def sha256_file(path: Path, block_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()


def source_fingerprint(path: Path, block_size: int = 4 * 1024 * 1024) -> str:
    """Full content fingerprint used to prevent checkpoint identity collisions."""
    size = path.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()


def config_fingerprint(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def ensure_within(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    resolved_root = root.resolve()
    if resolved == resolved_root or resolved_root in resolved.parents:
        return resolved
    raise ValueError(f"Path escapes managed root: {resolved}")


def command_text(command: Iterable[object]) -> str:
    # For diagnostics only. Never include secret-bearing arguments here.
    return " ".join(str(part) for part in command)


def run_checked(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: float | None = None,
    input_text: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        timeout=timeout,
        input=input_text,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
        env=env,
    )


def human_bytes(value: int) -> str:
    number = float(value)
    for suffix in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(number) < 1024 or suffix == "TiB":
            return f"{number:.1f} {suffix}"
        number /= 1024
    return f"{number:.1f} TiB"
