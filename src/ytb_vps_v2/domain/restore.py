from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath

from ytb_vps_v2.domain.backup import CheckpointManifest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId


def _text(name: str, value: object, maximum: int = 128) -> str:
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


def _entries(name: str, value: object) -> tuple[ManifestEntry, ...]:
    if type(value) is not tuple or any(
        type(item) is not ManifestEntry for item in value
    ):
        raise DomainInvariantError(f"{name} must contain ManifestEntry values")
    keys = tuple(str(item.key) for item in value)
    if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
        raise DomainInvariantError(f"{name} must be sorted by key and unique")
    return value


def _work_keys(name: str, value: object) -> tuple[str, ...]:
    if type(value) is not tuple or any(
        type(item) is not str
        or not item
        or item != item.strip()
        or len(item) > 256
        for item in value
    ):
        raise DomainInvariantError(
            f"{name} must contain non-empty, trimmed work keys"
        )
    if value != tuple(sorted(value)) or len(value) != len(set(value)):
        raise DomainInvariantError(f"{name} must be sorted and unique")
    return value


@dataclass(frozen=True, slots=True)
class RemoteObjectEvidence:
    entry: ManifestEntry
    observed_at: int
    method: str

    def __post_init__(self) -> None:
        if type(self.entry) is not ManifestEntry:
            raise DomainInvariantError("Remote evidence entry must be ManifestEntry")
        if type(self.observed_at) is not int or self.observed_at < 0:
            raise DomainInvariantError(
                "Remote evidence time must be a non-negative integer"
            )
        _text("Remote evidence method", self.method)


@dataclass(frozen=True, slots=True)
class RestoreResult:
    job_id: JobId
    checkpoint_id: str
    artifact_count: int
    schema_version: int
    migrated_from: int | None

    def __post_init__(self) -> None:
        if type(self.job_id) is not JobId:
            raise DomainInvariantError("Restore job ID must be JobId")
        _text("Restore checkpoint ID", self.checkpoint_id)
        if type(self.artifact_count) is not int or self.artifact_count < 0:
            raise DomainInvariantError(
                "Restore artifact count must be a non-negative integer"
            )
        if type(self.schema_version) is not int or self.schema_version < 1:
            raise DomainInvariantError(
                "Restore schema version must be a positive integer"
            )
        if self.migrated_from is not None and (
            type(self.migrated_from) is not int
            or self.migrated_from < 1
            or self.migrated_from >= self.schema_version
        ):
            raise DomainInvariantError(
                "Restore migration source must precede the resulting schema version"
            )


@dataclass(frozen=True, slots=True)
class RestoreArtifact:
    relative_path: PurePosixPath
    remote: ManifestEntry

    def __post_init__(self) -> None:
        if type(self.remote) is not ManifestEntry:
            raise DomainInvariantError("Restore artifact remote must be ManifestEntry")
        ManifestEntry(self.relative_path, self.remote.digest)


@dataclass(frozen=True, slots=True)
class RestoreLayout:
    job_id: JobId
    archive_key: PurePosixPath
    input_remote: ManifestEntry
    artifacts: tuple[RestoreArtifact, ...]
    schema_version: int

    def __post_init__(self) -> None:
        if type(self.job_id) is not JobId:
            raise DomainInvariantError("Restore layout job ID must be JobId")
        if type(self.input_remote) is not ManifestEntry:
            raise DomainInvariantError("Restore layout input must be ManifestEntry")
        ManifestEntry(self.archive_key, self.input_remote.digest)
        if type(self.artifacts) is not tuple or any(
            type(item) is not RestoreArtifact for item in self.artifacts
        ):
            raise DomainInvariantError(
                "Restore layout artifacts must be RestoreArtifact values"
            )
        paths = tuple(str(item.relative_path) for item in self.artifacts)
        if paths != tuple(sorted(paths)) or len(paths) != len(set(paths)):
            raise DomainInvariantError(
                "Restore layout artifact paths must be sorted and unique"
            )
        if type(self.schema_version) is not int or self.schema_version < 1:
            raise DomainInvariantError("Restore layout schema version must be positive")


class CleanupDenialReason(str, Enum):
    FUTURE_EVIDENCE = "future_evidence"
    INPUT_NOT_DURABLE = "input_not_durable"
    MISMATCHING_EVIDENCE = "mismatching_evidence"
    MISSING_EVIDENCE = "missing_evidence"
    OPERATOR_DISABLED = "operator_disabled"
    PARTS_NOT_VERIFIED = "parts_not_verified"
    SNAPSHOT_NOT_RESTORABLE = "snapshot_not_restorable"
    STALE_EVIDENCE = "stale_evidence"
    UNSAFE_DELETION_TARGET = "unsafe_deletion_target"
    VALIDATIONS_NOT_VERIFIED = "validations_not_verified"
    WORK_NOT_DURABLE = "work_not_durable"


@dataclass(frozen=True, slots=True)
class CleanupProof:
    manifest_entry: ManifestEntry
    manifest: CheckpointManifest
    evidence: tuple[RemoteObjectEvidence, ...]
    published_parts: tuple[ManifestEntry, ...]
    validation_artifacts: tuple[ManifestEntry, ...]
    required_work_keys: tuple[str, ...]
    remote_work_keys: tuple[str, ...]
    snapshot_restorable: bool

    def __post_init__(self) -> None:
        if type(self.manifest_entry) is not ManifestEntry:
            raise DomainInvariantError("Cleanup manifest entry must be ManifestEntry")
        if type(self.manifest) is not CheckpointManifest:
            raise DomainInvariantError("Cleanup manifest must be CheckpointManifest")
        if type(self.evidence) is not tuple or any(
            type(item) is not RemoteObjectEvidence for item in self.evidence
        ):
            raise DomainInvariantError(
                "Cleanup evidence must contain RemoteObjectEvidence values"
            )
        evidence_keys = tuple(str(item.entry.key) for item in self.evidence)
        if (
            evidence_keys != tuple(sorted(evidence_keys))
            or len(evidence_keys) != len(set(evidence_keys))
        ):
            raise DomainInvariantError(
                "Cleanup evidence must be sorted by entry key and unique"
            )
        published_parts = _entries("Published parts", self.published_parts)
        validation_artifacts = _entries(
            "Validation artifacts", self.validation_artifacts
        )
        output_keys = tuple(
            str(item.key) for item in (*published_parts, *validation_artifacts)
        )
        if len(output_keys) != len(set(output_keys)):
            raise DomainInvariantError("Cleanup output evidence keys must be distinct")
        _work_keys("Required work keys", self.required_work_keys)
        _work_keys("Remote work keys", self.remote_work_keys)
        if type(self.snapshot_restorable) is not bool:
            raise DomainInvariantError("Snapshot restorable flag must be boolean")


@dataclass(frozen=True, slots=True)
class CleanupDecision:
    allowed: bool
    reasons: tuple[CleanupDenialReason, ...]

    def __post_init__(self) -> None:
        if type(self.allowed) is not bool:
            raise DomainInvariantError("Cleanup decision flag must be boolean")
        if type(self.reasons) is not tuple or any(
            type(item) is not CleanupDenialReason for item in self.reasons
        ):
            raise DomainInvariantError(
                "Cleanup reasons must contain CleanupDenialReason values"
            )
        values = tuple(item.value for item in self.reasons)
        if values != tuple(sorted(values)) or len(values) != len(set(values)):
            raise DomainInvariantError("Cleanup denial reasons must be sorted and unique")
        if self.allowed != (not self.reasons):
            raise DomainInvariantError(
                "Cleanup is allowed exactly when no denial reason exists"
            )
