from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_FIELDS = {
    "artifacts",
    "checkpoint_id",
    "created_at",
    "input_archive",
    "job_id",
    "source",
    "state_snapshot",
    "version",
}
_ENTRY_FIELDS = {"key", "sha256", "size_bytes"}
_SOURCE_FIELDS = {"name", "sha256", "size_bytes"}


def _text(name: str, value: object, maximum: int) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        raise DomainInvariantError(
            f"{name} must be non-empty, trimmed, and at most {maximum} characters"
        )
    return value


def _portable_key(value: object) -> PurePosixPath:
    if type(value) is not PurePosixPath:
        raise DomainInvariantError("Manifest key must use portable POSIX format")
    raw = str(value)
    windows_view = PureWindowsPath(raw)
    if (
        raw in {"", "."}
        or "\\" in raw
        or value.is_absolute()
        or windows_view.is_absolute()
        or bool(windows_view.drive)
        or any(part in {"", ".", ".."} for part in value.parts)
    ):
        raise DomainInvariantError("Manifest key must be safe and relative")
    return value


@dataclass(frozen=True, slots=True)
class FileDigest:
    size_bytes: int
    sha256: str

    def __post_init__(self) -> None:
        if type(self.size_bytes) is not int or self.size_bytes < 0:
            raise DomainInvariantError("File size must be a non-negative integer")
        if type(self.sha256) is not str or _SHA256.fullmatch(self.sha256) is None:
            raise DomainInvariantError("File checksum must be lowercase SHA-256")


@dataclass(frozen=True, slots=True)
class SourceIdentity:
    name: str
    digest: FileDigest

    def __post_init__(self) -> None:
        name = _text("Source name", self.name, 255)
        if (
            name in {".", ".."}
            or "/" in name
            or "\\" in name
            or PureWindowsPath(name).drive
        ):
            raise DomainInvariantError("Source name must be a safe basename")
        if type(self.digest) is not FileDigest:
            raise DomainInvariantError("Source digest must be FileDigest")


@dataclass(frozen=True, slots=True)
class ManifestEntry:
    key: PurePosixPath
    digest: FileDigest

    def __post_init__(self) -> None:
        _portable_key(self.key)
        if type(self.digest) is not FileDigest:
            raise DomainInvariantError("Manifest entry digest must be FileDigest")


@dataclass(frozen=True, slots=True)
class VerifiedInputArchive:
    source: SourceIdentity
    archive: ManifestEntry
    verified_at: str

    def __post_init__(self) -> None:
        if type(self.source) is not SourceIdentity:
            raise DomainInvariantError("Archive source must be SourceIdentity")
        if type(self.archive) is not ManifestEntry:
            raise DomainInvariantError("Archive entry must be ManifestEntry")
        _text("Archive verification time", self.verified_at, 128)
        if self.source.digest != self.archive.digest:
            raise DomainInvariantError("Archive digest must match source identity")


@dataclass(frozen=True, slots=True)
class CheckpointRecord:
    job_id: JobId
    checkpoint_id: str
    manifest: ManifestEntry
    state_snapshot: ManifestEntry
    completed_at: str

    def __post_init__(self) -> None:
        if type(self.job_id) is not JobId:
            raise DomainInvariantError("Checkpoint record job ID must be JobId")
        _text("Checkpoint record ID", self.checkpoint_id, 128)
        if type(self.manifest) is not ManifestEntry:
            raise DomainInvariantError("Checkpoint record manifest must be ManifestEntry")
        if type(self.state_snapshot) is not ManifestEntry:
            raise DomainInvariantError(
                "Checkpoint record state snapshot must be ManifestEntry"
            )
        _text("Checkpoint completion time", self.completed_at, 128)
        if self.manifest.key == self.state_snapshot.key:
            raise DomainInvariantError("Checkpoint record keys must be distinct")


@dataclass(frozen=True, slots=True)
class CheckpointManifest:
    version: int
    checkpoint_id: str
    job_id: JobId
    source: SourceIdentity
    input_archive: ManifestEntry
    state_snapshot: ManifestEntry
    artifacts: tuple[ManifestEntry, ...]
    created_at: str

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version != 1:
            raise DomainInvariantError("Checkpoint manifest version must be 1")
        _text("Checkpoint ID", self.checkpoint_id, 128)
        if type(self.job_id) is not JobId:
            raise DomainInvariantError("Checkpoint job ID must be JobId")
        if type(self.source) is not SourceIdentity:
            raise DomainInvariantError("Checkpoint source must be SourceIdentity")
        if type(self.input_archive) is not ManifestEntry:
            raise DomainInvariantError("Checkpoint input archive must be ManifestEntry")
        if type(self.state_snapshot) is not ManifestEntry:
            raise DomainInvariantError("Checkpoint state snapshot must be ManifestEntry")
        if type(self.artifacts) is not tuple or any(
            type(item) is not ManifestEntry for item in self.artifacts
        ):
            raise DomainInvariantError("Checkpoint artifacts must be ManifestEntry values")
        _text("Checkpoint creation time", self.created_at, 128)
        if self.source.digest != self.input_archive.digest:
            raise DomainInvariantError("Checkpoint archive must match source identity")
        keys = tuple(str(item.key) for item in self.artifacts)
        if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
            raise DomainInvariantError(
                "Checkpoint artifact keys must be sorted and unique"
            )
        all_keys = (
            str(self.input_archive.key),
            str(self.state_snapshot.key),
            *keys,
        )
        if len(all_keys) != len(set(all_keys)):
            raise DomainInvariantError("Checkpoint manifest keys must be unique")


def _entry_dict(value: ManifestEntry) -> dict[str, object]:
    return {
        "key": str(value.key),
        "sha256": value.digest.sha256,
        "size_bytes": value.digest.size_bytes,
    }


def canonical_manifest_bytes(manifest: CheckpointManifest) -> bytes:
    if type(manifest) is not CheckpointManifest:
        raise DomainInvariantError("Canonical serialization requires CheckpointManifest")
    payload = {
        "artifacts": [_entry_dict(item) for item in manifest.artifacts],
        "checkpoint_id": manifest.checkpoint_id,
        "created_at": manifest.created_at,
        "input_archive": _entry_dict(manifest.input_archive),
        "job_id": manifest.job_id.value,
        "source": {
            "name": manifest.source.name,
            "sha256": manifest.source.digest.sha256,
            "size_bytes": manifest.source.digest.size_bytes,
        },
        "state_snapshot": _entry_dict(manifest.state_snapshot),
        "version": manifest.version,
    }
    try:
        return (
            json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")
    except UnicodeEncodeError as exc:
        raise DomainInvariantError(
            "Checkpoint manifest contains invalid Unicode"
        ) from exc


def _closed_dict(name: str, value: object, fields: set[str]) -> dict[str, object]:
    if type(value) is not dict or set(value) != fields:
        raise DomainInvariantError(f"{name} has missing or unknown fields")
    return value


def _entry_from_dict(value: object) -> ManifestEntry:
    item = _closed_dict("Manifest entry", value, _ENTRY_FIELDS)
    key = item["key"]
    if type(key) is not str:
        raise DomainInvariantError("Manifest key must be text")
    return ManifestEntry(
        PurePosixPath(key),
        FileDigest(item["size_bytes"], item["sha256"]),  # type: ignore[arg-type]
    )


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DomainInvariantError("Manifest JSON contains a duplicate field")
        result[key] = value
    return result


def parse_manifest_bytes(raw: bytes) -> CheckpointManifest:
    if type(raw) is not bytes:
        raise DomainInvariantError("Manifest input must be bytes")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
        )
        root = _closed_dict("Checkpoint manifest", payload, _MANIFEST_FIELDS)
        source_payload = _closed_dict("Manifest source", root["source"], _SOURCE_FIELDS)
        source = SourceIdentity(
            source_payload["name"],  # type: ignore[arg-type]
            FileDigest(
                source_payload["size_bytes"],  # type: ignore[arg-type]
                source_payload["sha256"],  # type: ignore[arg-type]
            ),
        )
        artifacts_payload = root["artifacts"]
        if type(artifacts_payload) is not list:
            raise DomainInvariantError("Manifest artifacts must be a JSON array")
        manifest = CheckpointManifest(
            root["version"],  # type: ignore[arg-type]
            root["checkpoint_id"],  # type: ignore[arg-type]
            JobId(root["job_id"]),  # type: ignore[arg-type]
            source,
            _entry_from_dict(root["input_archive"]),
            _entry_from_dict(root["state_snapshot"]),
            tuple(_entry_from_dict(item) for item in artifacts_payload),
            root["created_at"],  # type: ignore[arg-type]
        )
    except DomainInvariantError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise DomainInvariantError("Checkpoint manifest is invalid") from exc
    if canonical_manifest_bytes(manifest) != raw:
        raise DomainInvariantError("Checkpoint manifest JSON is not canonical")
    return manifest
