from __future__ import annotations

import json
import os
import shutil
import tarfile
import urllib.request
from pathlib import Path
from typing import Any

from ytb_vps.util import sha256_file


def _manifest_path() -> Path:
    configured = os.environ.get("YTB_VPS_MODEL_MANIFEST")
    if configured:
        return Path(configured)
    installed = Path("/opt/ytb-vps/assets/model-manifest.json")
    if installed.exists():
        return installed
    packaged = Path(__file__).resolve().parent / "assets" / "model-manifest.json"
    if packaged.exists():
        return packaged
    return Path(__file__).resolve().parents[2] / "assets" / "model-manifest.json"


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    target = path or _manifest_path()
    value = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(value.get("models"), list):
        raise ValueError(f"Invalid model manifest: {target}")
    return value


def _safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with tarfile.open(archive, "r:*") as bundle:
        for member in bundle.getmembers():
            resolved = (destination / member.name).resolve()
            if root != resolved and root not in resolved.parents:
                raise RuntimeError(f"Unsafe model archive member: {member.name}")
            if member.issym() or member.islnk():
                raise RuntimeError(f"Links are not allowed in model archives: {member.name}")
        bundle.extractall(destination)


def ensure_models(models_root: Path, manifest_path: Path | None = None) -> list[dict[str, Any]]:
    manifest = load_manifest(manifest_path)
    models_root.mkdir(parents=True, exist_ok=True)
    cache = models_root / ".downloads"
    cache.mkdir(parents=True, exist_ok=True)
    report: list[dict[str, Any]] = []
    for item in manifest["models"]:
        target = models_root / str(item["name"])
        marker = target / ".ytb-vps-model.json"
        if marker.exists():
            existing = json.loads(marker.read_text(encoding="utf-8"))
            if existing.get("archive_sha256") == item["sha256"]:
                report.append({"name": item["name"], "status": "present"})
                continue
        archive = cache / str(item["archive"])
        temporary = archive.with_suffix(archive.suffix + ".part")
        if not archive.exists() or sha256_file(archive) != item["sha256"]:
            temporary.unlink(missing_ok=True)
            with urllib.request.urlopen(item["url"], timeout=120) as response, temporary.open("wb") as handle:
                shutil.copyfileobj(response, handle, length=1024 * 1024)
            if sha256_file(temporary) != item["sha256"]:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"Checksum mismatch for {item['archive']}")
            os.replace(temporary, archive)
        staging = models_root / f".{item['name']}.extracting"
        if staging.exists():
            shutil.rmtree(staging)
        _safe_extract(archive, staging)
        extracted = staging / str(item["name"])
        if not extracted.is_dir():
            shutil.rmtree(staging, ignore_errors=True)
            raise RuntimeError(f"Archive did not contain {item['name']}")
        if target.exists():
            shutil.rmtree(target)
        os.replace(extracted, target)
        shutil.rmtree(staging, ignore_errors=True)
        marker.write_text(
            json.dumps(
                {
                    "url": item["url"],
                    "archive_sha256": item["sha256"],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        report.append({"name": item["name"], "status": "downloaded"})
    fixtures_root = models_root / "fixtures"
    fixtures_root.mkdir(parents=True, exist_ok=True)
    for item in manifest.get("fixtures", []):
        target = fixtures_root / str(item["name"])
        if target.exists() and sha256_file(target) == item["sha256"]:
            report.append({"name": item["name"], "status": "present"})
            continue
        temporary = target.with_suffix(target.suffix + ".part")
        temporary.unlink(missing_ok=True)
        with urllib.request.urlopen(item["url"], timeout=120) as response, temporary.open("wb") as handle:
            shutil.copyfileobj(response, handle, length=1024 * 1024)
        if sha256_file(temporary) != item["sha256"]:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {item['name']}")
        os.replace(temporary, target)
        report.append({"name": item["name"], "status": "downloaded"})
    return report
