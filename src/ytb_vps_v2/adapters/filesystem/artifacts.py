from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    destination_for,
    digest_file,
    publish_additively,
    regular_file,
    secure_root,
    sync_directory,
    verified_existing_file,
)
from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.ports.backup import BackupStoreError
from ytb_vps_v2.ports.pipeline import ArtifactWriteError


_CHUNK_SIZE = 1024 * 1024


def _write_bytes_to_temp(temporary: Path, raw: bytes) -> FileDigest:
    hasher = hashlib.sha256()
    created = False
    try:
        with temporary.open("xb") as handle:
            created = True
            handle.write(raw)
            hasher.update(raw)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        if created:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return FileDigest(len(raw), hasher.hexdigest())


def _copy_to_temp(source: Path, temporary: Path) -> FileDigest:
    source_file = regular_file(source)
    hasher = hashlib.sha256()
    size = 0
    created = False
    try:
        with source_file.open("rb") as reader, temporary.open("xb") as writer:
            created = True
            while True:
                chunk = reader.read(_CHUNK_SIZE)
                if not chunk:
                    break
                writer.write(chunk)
                hasher.update(chunk)
                size += len(chunk)
            writer.flush()
            os.fsync(writer.fileno())
    except BaseException:
        if created:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return FileDigest(size, hasher.hexdigest())


class LocalArtifactWriter:
    def __init__(self, root: Path) -> None:
        try:
            self.root = secure_root(root)
        except BackupStoreError as exc:
            raise ArtifactWriteError("Workspace root is invalid") from exc

    @staticmethod
    def _temporary_for(destination: Path) -> Path:
        return destination.with_name(
            f".{destination.name}.{uuid.uuid4().hex}.part"
        )

    def _matching_existing(
        self,
        key: PurePosixPath,
        destination: Path,
        expected: FileDigest,
    ) -> ManifestEntry | None:
        if not destination.exists():
            return None
        verified_existing_file(self.root, key, expected)
        sync_directory(destination.parent)
        return ManifestEntry(key, expected)

    def write_bytes(self, key: PurePosixPath, raw: bytes) -> ManifestEntry:
        if type(raw) is not bytes:
            raise ArtifactWriteError("Artifact content must be bytes")
        expected = FileDigest(len(raw), hashlib.sha256(raw).hexdigest())
        temporary: Path | None = None
        temporary_owned = False
        try:
            destination = destination_for(self.root, key, expected)
            existing = self._matching_existing(key, destination, expected)
            if existing is not None:
                return existing
            temporary = self._temporary_for(destination)
            written = _write_bytes_to_temp(temporary, raw)
            temporary_owned = True
            if written != expected:
                raise ArtifactWriteError("Temporary artifact bytes changed while writing")
            publish_additively(temporary, destination, expected, self.root)
            return ManifestEntry(key, expected)
        except ArtifactWriteError:
            raise
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Artifact bytes could not be committed") from exc
        finally:
            if temporary_owned and temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def write_file(self, key: PurePosixPath, source: Path) -> ManifestEntry:
        temporary: Path | None = None
        temporary_owned = False
        try:
            expected = digest_file(source)
            destination = destination_for(self.root, key, expected)
            existing = self._matching_existing(key, destination, expected)
            if existing is not None:
                return existing
            temporary = self._temporary_for(destination)
            copied = _copy_to_temp(source, temporary)
            temporary_owned = True
            latest = digest_file(source)
            if copied != expected or latest != expected:
                raise ArtifactWriteError("Artifact source changed while being copied")
            publish_additively(temporary, destination, expected, self.root)
            return ManifestEntry(key, expected)
        except ArtifactWriteError:
            raise
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Artifact file could not be committed") from exc
        finally:
            if temporary_owned and temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def verify(self, key: PurePosixPath, expected: FileDigest) -> ManifestEntry:
        if type(expected) is not FileDigest:
            raise ArtifactWriteError("Expected artifact digest must be FileDigest")
        try:
            verified_existing_file(self.root, key, expected)
            return ManifestEntry(key, expected)
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Workspace artifact failed verification") from exc


DurableArtifactWriter = LocalArtifactWriter
