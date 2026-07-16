from __future__ import annotations

import uuid
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    copy_to_temp,
    destination_for,
    digest_file,
    publish_additively,
    secure_root,
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
                if digest_file(destination) != expected:
                    raise BackupStoreError(
                        "Existing additive object conflicts with expected bytes"
                    )
                return ManifestEntry(key, expected)
            temporary = destination.with_name(
                f".{destination.name}.{uuid.uuid4().hex}.part"
            )
            copied = _copy_to_temp(source, temporary)
            if copied != expected or digest_file(source) != expected:
                raise BackupStoreError("Source changed during additive copy")
            publish_additively(temporary, destination, expected)
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
