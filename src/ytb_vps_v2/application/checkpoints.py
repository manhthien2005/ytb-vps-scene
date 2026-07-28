from __future__ import annotations

import hashlib
import os
import re
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


def _object_prefix(job_id: JobId) -> PurePosixPath:
    return PurePosixPath("objects", _token(job_id.value))


def _input_object(
    job_id: JobId,
    digest: FileDigest,
) -> PurePosixPath:
    return _object_prefix(job_id) / "input" / digest.sha256


def _artifact_object(
    job_id: JobId,
    artifact: Artifact,
) -> PurePosixPath:
    return (
        _object_prefix(job_id)
        / "workspace"
        / artifact.relative_path
        / artifact.sha256
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

    def _verify_entry(
        self,
        entry: ManifestEntry,
        observed_at: int,
        method: str,
    ) -> None:
        if type(observed_at) is not int or observed_at < 0:
            raise CheckpointError("Checkpoint verification time is invalid")
        if (
            type(method) is not str
            or not method
            or method != method.strip()
            or len(method) > 128
        ):
            raise CheckpointError(
                "Checkpoint verification method is invalid"
            )
        verifier = getattr(self.object_store, "verify", None)
        if not callable(verifier):
            raise CheckpointError(
                "Checkpoint store lacks remote verification"
            )
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
                "Checkpoint object verification is invalid"
            )

    def latest_verified_v2(
        self,
        job_id: JobId,
        checkpoint_prefix: str,
        observed_at: int,
    ) -> CheckpointManifest | None:
        if type(job_id) is not JobId:
            raise CheckpointError("Checkpoint job ID must be JobId")
        prefix = _text("Checkpoint prefix", checkpoint_prefix)
        if type(observed_at) is not int or observed_at < 0:
            raise CheckpointError("Checkpoint verification time is invalid")
        pattern = re.compile(rf"^{re.escape(prefix)}(\d{{6}})(?:-|$)")
        candidates: list[tuple[int, str]] = []
        for record in self.state.completed_checkpoints(job_id):
            match = pattern.match(record.checkpoint_id)
            if match is not None:
                candidates.append(
                    (int(match.group(1)), record.checkpoint_id)
                )
        for _, checkpoint_id in sorted(candidates, reverse=True):
            try:
                manifest = self._completed(
                    job_id,
                    checkpoint_id,
                    observed_at=observed_at,
                    method=_VERIFY_METHOD,
                )
            except (
                BackupStoreError,
                CheckpointError,
                DomainInvariantError,
                RuntimeError,
            ):
                continue
            if manifest is not None and manifest.version == 2:
                return manifest
        return None

    def verify_manifest(
        self,
        manifest: CheckpointManifest,
        observed_at: int,
        method: str = _VERIFY_METHOD,
    ) -> CheckpointManifest:
        if type(manifest) is not CheckpointManifest:
            raise CheckpointError(
                "Verified checkpoint must be CheckpointManifest"
            )
        completed = self._completed(
            manifest.job_id,
            manifest.checkpoint_id,
            observed_at=observed_at,
            method=method,
        )
        if completed != manifest:
            raise CheckpointError(
                "Checkpoint does not match its verified completion"
            )
        return completed

    def _put_exact(self, source: Path, entry: ManifestEntry) -> None:
        result = self.object_store.put(source, entry.key, entry.digest)
        if result != entry:
            raise CheckpointError("Additive store returned mismatching evidence")

    def _adopt_verified_remote(
        self,
        job_id: JobId,
        checkpoint_id: str,
        observed_at: int,
        method: str,
    ) -> CheckpointManifest | None:
        prefix = _prefix(job_id, checkpoint_id)
        manifest_key = prefix / "manifest-v2.json"
        try:
            raw = self.object_store.read_bytes(
                manifest_key,
                _MAX_MANIFEST_BYTES,
            )
        except BackupStoreError:
            return None
        try:
            manifest = parse_manifest_bytes(raw)
            manifest_entry = ManifestEntry(
                manifest_key,
                _bytes_digest(raw),
            )
            verified_input = self.state.verified_input(job_id)
            if (
                manifest.version != 2
                or manifest.job_id != job_id
                or manifest.checkpoint_id != checkpoint_id
                or manifest.state_snapshot.key
                != prefix / "state" / "job-v2.sqlite"
                or verified_input is None
                or manifest.source != verified_input.source
                or manifest.input_archive
                != ManifestEntry(
                    _input_object(
                        job_id,
                        verified_input.archive.digest,
                    ),
                    verified_input.archive.digest,
                )
            ):
                raise CheckpointError(
                    "Remote checkpoint cannot be adopted by this job"
                )
            expected_artifacts = tuple(
                sorted(
                    (
                        ManifestEntry(
                            _artifact_object(job_id, artifact),
                            FileDigest(
                                artifact.size_bytes,
                                artifact.sha256,
                            ),
                        )
                        for artifact
                        in self.state.valid_artifacts(job_id)
                    ),
                    key=lambda item: str(item.key),
                )
            )
            if manifest.artifacts != expected_artifacts:
                raise CheckpointError(
                    "Remote checkpoint artifacts differ from local state"
                )
            for entry in (
                manifest_entry,
                manifest.input_archive,
                manifest.state_snapshot,
                *manifest.artifacts,
            ):
                self._verify_entry(entry, observed_at, method)
            self.state.record_checkpoint(
                job_id,
                checkpoint_id,
                manifest_entry,
                manifest.state_snapshot,
                manifest.created_at,
            )
            return manifest
        except CheckpointError:
            raise
        except (DomainInvariantError, RuntimeError, TypeError, ValueError) as exc:
            raise CheckpointError(
                "Remote checkpoint adoption failed"
            ) from exc

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
        reuse: CheckpointManifest | None = None,
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
            adopted = self._adopt_verified_remote(
                job_id,
                identifier,
                (
                    verification_observed_at
                    if verification_observed_at is not None
                    else 0
                ),
                verification_method,
            )
            if adopted is not None:
                return adopted

            verified_input = self.state.verified_input(job_id)
            if verified_input is None:
                raise CheckpointError("Checkpoint requires verified input")
            workspace = self.files.secure_root(workspace_root)
            snapshots = self.files.secure_root(snapshot_dir)
            if reuse is not None and type(reuse) is not CheckpointManifest:
                raise CheckpointError(
                    "Reused checkpoint must be CheckpointManifest"
                )
            reuse_entries: dict[str, ManifestEntry] = {}
            if reuse is not None and reuse.version == 2:
                if reuse.job_id != job_id:
                    raise CheckpointError(
                        "Reused checkpoint belongs to another job"
                    )
                reuse_entries = {
                    str(entry.key): entry
                    for entry in (
                        reuse.input_archive,
                        *reuse.artifacts,
                    )
                }
            reuse_observed_at = (
                verification_observed_at
                if verification_observed_at is not None
                else 0
            )
            prefix = _prefix(job_id, identifier)
            input_entry = ManifestEntry(
                _input_object(job_id, verified_input.archive.digest),
                verified_input.archive.digest,
            )
            archive_path: Path | None = None
            if reuse_entries.get(str(input_entry.key)) == input_entry:
                self._verify_entry(
                    input_entry,
                    reuse_observed_at,
                    verification_method,
                )
            else:
                archive_path = self.files.existing(
                    self.input_archive_root,
                    verified_input.archive.key,
                    verified_input.archive.digest,
                )

            artifacts = self.state.valid_artifacts(job_id)
            artifact_pairs = sorted(
                [
                    (
                        ManifestEntry(
                            _artifact_object(job_id, artifact),
                            FileDigest(artifact.size_bytes, artifact.sha256),
                        ),
                        artifact,
                    )
                    for artifact in artifacts
                ],
                key=lambda pair: str(pair[0].key),
            )
            prepared_artifacts: list[
                tuple[ManifestEntry, Path | None]
            ] = []
            for entry, artifact in artifact_pairs:
                local: Path | None = None
                if reuse_entries.get(str(entry.key)) == entry:
                    self._verify_entry(
                        entry,
                        reuse_observed_at,
                        verification_method,
                    )
                else:
                    try:
                        local = self.files.existing(
                            workspace,
                            artifact.relative_path,
                            entry.digest,
                        )
                    except RuntimeError as exc:
                        raise CheckpointError(
                            "Checkpoint artifact failed verification: "
                            f"{artifact.name}"
                        ) from exc
                prepared_artifacts.append((entry, local))
            state_key = prefix / "state" / "job-v2.sqlite"
            manifest_key = prefix / "manifest-v2.json"

            with tempfile.TemporaryDirectory(dir=snapshots) as temporary_name:
                temporary = Path(temporary_name)
                snapshot_path = temporary / "job-v2.sqlite"
                state_entry = self.state.create_snapshot(snapshot_path, state_key)
                manifest = CheckpointManifest(
                    2,
                    identifier,
                    job_id,
                    verified_input.source,
                    input_entry,
                    state_entry,
                    tuple(pair[0] for pair in prepared_artifacts),
                    timestamp,
                )

                if archive_path is not None:
                    self._put_exact(archive_path, input_entry)
                for entry, local in prepared_artifacts:
                    if local is not None:
                        self._put_exact(local, entry)
                self._put_exact(snapshot_path, state_entry)

                raw = canonical_manifest_bytes(manifest)
                manifest_path = temporary / "manifest-v2.json"
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
