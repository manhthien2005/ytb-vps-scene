from __future__ import annotations

import uuid
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    copy_to_temp,
    destination_for,
    digest_file,
    existing_path,
    publish_additively,
    secure_root,
    sync_directory,
    verified_existing_file,
)
from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.ports.backup import BackupStoreError


_copy_to_temp = copy_to_temp


class LocalAdditiveObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = secure_root(root)

    def put(
        self, source: Path, key: PurePosixPath, expected: FileDigest
    ) -> ManifestEntry:
        if type(expected) is not FileDigest:
            raise BackupStoreError("Expected object digest must be FileDigest")
        temporary: Path | None = None
        try:
            if digest_file(source) != expected:
                raise BackupStoreError("Source does not match expected object digest")
            destination = destination_for(self.root, key, expected)
            if destination.exists():
                verified_existing_file(self.root, key, expected)
                sync_directory(destination.parent)
                return ManifestEntry(key, expected)
            temporary = destination.with_name(
                f".{destination.name}.{uuid.uuid4().hex}.part"
            )
            copied = _copy_to_temp(source, temporary)
            if copied != expected or digest_file(source) != expected:
                raise BackupStoreError("Source changed during additive copy")
            publish_additively(temporary, destination, expected, self.root)
            return ManifestEntry(key, expected)
        except BackupStoreError:
            raise
        except OSError as exc:
            raise BackupStoreError("Additive object copy failed") from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def read_bytes(self, key: PurePosixPath, max_bytes: int) -> bytes:
        if type(max_bytes) is not int or not 0 < max_bytes <= 16 * 1024 * 1024:
            raise BackupStoreError(
                "Object read limit must be between 1 and 16777216 bytes"
            )
        path = existing_path(self.root, key)
        try:
            if path.stat().st_size > max_bytes:
                raise BackupStoreError("Object exceeds its allowed read size")
            with path.open("rb") as handle:
                raw = handle.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise BackupStoreError("Object exceeds its allowed read size")
            return raw
        except BackupStoreError:
            raise
        except OSError as exc:
            raise BackupStoreError("Object could not be read") from exc
