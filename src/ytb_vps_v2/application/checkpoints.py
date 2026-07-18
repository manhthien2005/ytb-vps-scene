from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    canonical_manifest_bytes,
    parse_manifest_bytes,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Artifact, JobId
from ytb_vps_v2.domain.restore import RemoteObjectEvidence
from ytb_vps_v2.ports.backup import (
    AdditiveObjectStore,
    BackupStoreError,
    FileIntegrity,
)
from ytb_vps_v2.ports.state import StateRepository


_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_VERIFY_METHOD = "sha256-readback"


class CheckpointError(RuntimeError):
    """Raised when a complete verified checkpoint cannot be published."""


def _text(name: str, value: object) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > 128
    ):
        raise CheckpointError(f"{name} is invalid")
    return value


def _token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def _prefix(job_id: JobId, checkpoint_id: str) -> PurePosixPath:
    return PurePosixPath(
        "checkpoints", _token(job_id.value), _token(checkpoint_id)
    )


def _bytes_digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


class CheckpointPublisher:
    def __init__(
        self,
        state: StateRepository,
        object_store: AdditiveObjectStore,
        input_archive_root: Path,
        files: FileIntegrity,
    ) -> None:
        self.state = state
        self.object_store = object_store
        self.files = files
        try:
            self.input_archive_root = files.secure_root(input_archive_root)
        except RuntimeError as exc:
            raise CheckpointError("Input archive root is invalid") from exc

    def _completed(
        self,
        job_id: JobId,
        checkpoint_id: str,
        *,
        observed_at: int | None = None,
        method: str = _VERIFY_METHOD,
    ) -> CheckpointManifest | None:
        records = tuple(
            item
            for item in self.state.completed_checkpoints(job_id)
            if item.checkpoint_id == checkpoint_id
        )
        if not records:
            return None
        if len(records) != 1:
            raise CheckpointError("Checkpoint completion evidence is ambiguous")
        record = records[0]
        raw = self.object_store.read_bytes(
            record.manifest.key, _MAX_MANIFEST_BYTES
        )
        if _bytes_digest(raw) != record.manifest.digest:
            raise CheckpointError("Completed checkpoint manifest digest is invalid")
        manifest = parse_manifest_bytes(raw)
        if (
            manifest.job_id != job_id
            or manifest.checkpoint_id != checkpoint_id
            or manifest.state_snapshot != record.state_snapshot
        ):
            raise CheckpointError("Completed checkpoint manifest identity is invalid")
        if observed_at is not None and (
            type(observed_at) is not int or observed_at < 0
        ):
            raise CheckpointError("Checkpoint verification time is invalid")
        if (
            type(method) is not str
            or not method
            or method != method.strip()
            or len(method) > 128
        ):
            raise CheckpointError("Checkpoint verification method is invalid")
        verifier = getattr(self.object_store, "verify", None)
        if observed_at is not None and not callable(verifier):
            raise CheckpointError("Checkpoint store lacks remote verification")
        if observed_at is not None and callable(verifier):
            entries = (
                record.manifest,
                record.state_snapshot,
                manifest.input_archive,
                manifest.state_snapshot,
                *manifest.artifacts,
            )
            seen: set[str] = set()
            for entry in entries:
                key = str(entry.key)
                if key in seen:
                    continue
                seen.add(key)
                evidence = verifier(
                    entry.key,
                    entry.digest,
                    observed_at,
                    method,
                )
                if (
                    type(evidence) is not RemoteObjectEvidence
                    or evidence.entry != entry
                    or evidence.observed_at != observed_at
                    or evidence.method != method
                ):
                    raise CheckpointError(
                        "Completed checkpoint object verification is invalid"
                    )
        return manifest

    def _put_exact(self, source: Path, entry: ManifestEntry) -> None:
        result = self.object_store.put(source, entry.key, entry.digest)
        if result != entry:
            raise CheckpointError("Additive store returned mismatching evidence")

    def publish(
        self,
        job_id: JobId,
        checkpoint_id: str,
        workspace_root: Path,
        snapshot_dir: Path,
        at: str,
        *,
        verification_observed_at: int | None = None,
        verification_method: str = _VERIFY_METHOD,
    ) -> CheckpointManifest:
        if type(job_id) is not JobId:
            raise CheckpointError("Checkpoint job ID must be JobId")
        identifier = _text("Checkpoint ID", checkpoint_id)
        timestamp = _text("Checkpoint time", at)
        try:
            completed = self._completed(
                job_id,
                identifier,
                observed_at=verification_observed_at,
                method=verification_method,
            )
            if completed is not None:
                return completed

            verified_input = self.state.verified_input(job_id)
            if verified_input is None:
                raise CheckpointError("Checkpoint requires verified input")
            workspace = self.files.secure_root(workspace_root)
            snapshots = self.files.secure_root(snapshot_dir)
            archive_path = self.files.existing(
                self.input_archive_root,
                verified_input.archive.key,
                verified_input.archive.digest,
            )

            artifacts = self.state.valid_artifacts(job_id)
            local_artifacts: list[tuple[Artifact, Path]] = []
            for artifact in artifacts:
                digest = FileDigest(artifact.size_bytes, artifact.sha256)
                try:
                    local = self.files.existing(
                        workspace, artifact.relative_path, digest
                    )
                except RuntimeError as exc:
                    raise CheckpointError(
                        f"Checkpoint artifact failed verification: {artifact.name}"
                    ) from exc
                local_artifacts.append((artifact, local))

            prefix = _prefix(job_id, identifier)
            input_entry = ManifestEntry(
                prefix / "input" / verified_input.archive.key.name,
                verified_input.archive.digest,
            )
            artifact_pairs = sorted(
                [
                    (
                        ManifestEntry(
                            prefix / "workspace" / artifact.relative_path,
                            FileDigest(artifact.size_bytes, artifact.sha256),
                        ),
                        local,
                    )
                    for artifact, local in local_artifacts
                ],
                key=lambda pair: str(pair[0].key),
            )
            state_key = prefix / "state" / "job-v2.sqlite"
            manifest_key = prefix / "manifest-v1.json"

            with tempfile.TemporaryDirectory(dir=snapshots) as temporary_name:
                temporary = Path(temporary_name)
                snapshot_path = temporary / "job-v2.sqlite"
                state_entry = self.state.create_snapshot(snapshot_path, state_key)
                manifest = CheckpointManifest(
                    1,
                    identifier,
                    job_id,
                    verified_input.source,
                    input_entry,
                    state_entry,
                    tuple(pair[0] for pair in artifact_pairs),
                    timestamp,
                )

                self._put_exact(archive_path, input_entry)
                for entry, local in artifact_pairs:
                    self._put_exact(local, entry)
                self._put_exact(snapshot_path, state_entry)

                raw = canonical_manifest_bytes(manifest)
                manifest_path = temporary / "manifest-v1.json"
                with manifest_path.open("xb") as handle:
                    handle.write(raw)
                    handle.flush()
                    os.fsync(handle.fileno())
                manifest_entry = ManifestEntry(manifest_key, _bytes_digest(raw))
                try:
                    self._put_exact(manifest_path, manifest_entry)
                    published = self.object_store.read_bytes(
                        manifest_key, _MAX_MANIFEST_BYTES
                    )
                except (CheckpointError, BackupStoreError):
                    published = self.object_store.read_bytes(
                        manifest_key, _MAX_MANIFEST_BYTES
                    )
                    existing = parse_manifest_bytes(published)
                    if replace(existing, created_at=manifest.created_at) != manifest:
                        raise
                    manifest = existing
                    raw = published
                    manifest_entry = ManifestEntry(
                        manifest_key, _bytes_digest(published)
                    )
                if published != raw or parse_manifest_bytes(published) != manifest:
                    raise CheckpointError(
                        "Published checkpoint manifest failed read-back verification"
                    )
                self.state.record_checkpoint(
                    job_id,
                    identifier,
                    manifest_entry,
                    state_entry,
                    manifest.created_at,
                )
                return manifest
        except CheckpointError:
            raise
        except (BackupStoreError, DomainInvariantError, OSError, RuntimeError) as exc:
            raise CheckpointError("Checkpoint publication failed") from exc
