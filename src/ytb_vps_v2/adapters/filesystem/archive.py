from __future__ import annotations

import re
import uuid
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    copy_to_temp,
    destination_for,
    digest_file,
    publish_additively,
    secure_root,
)
from ytb_vps_v2.domain.backup import (
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.ports.backup import BackupStoreError


_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,10}$")
_copy_to_temp = copy_to_temp


def _timestamp(value: object) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > 128
    ):
        raise BackupStoreError("Archive verification time is invalid")
    return value


def _entry(key: PurePosixPath, digest: FileDigest) -> ManifestEntry:
    return ManifestEntry(key, digest)


class VerifiedInputArchiver:
    def __init__(self, root: Path) -> None:
        self.root = secure_root(root)

    def archive(
        self, source: Path, job_id: JobId, at: str
    ) -> VerifiedInputArchive:
        if type(job_id) is not JobId:
            raise BackupStoreError("Archive job ID must be JobId")
        timestamp = _timestamp(at)
        temporary: Path | None = None
        try:
            initial = digest_file(source)
            identity = SourceIdentity(source.name, initial)
            suffix = source.suffix if _SAFE_SUFFIX.fullmatch(source.suffix) else ".bin"
            suffix = suffix.lower()
            key = PurePosixPath(
                "inputs", initial.sha256[:2], f"{initial.sha256}{suffix}"
            )
            destination = destination_for(self.root, key, initial)
            if destination.exists():
                if digest_file(destination) != initial:
                    raise BackupStoreError(
                        "Existing input archive conflicts with source identity"
                    )
                return VerifiedInputArchive(identity, _entry(key, initial), timestamp)
            temporary = destination.with_name(
                f".{destination.name}.{uuid.uuid4().hex}.part"
            )
            copied = _copy_to_temp(source, temporary)
            latest = digest_file(source)
            if copied != initial or latest != initial:
                raise BackupStoreError("Source changed while it was being archived")
            publish_additively(temporary, destination, initial)
            return VerifiedInputArchive(identity, _entry(key, initial), timestamp)
        except BackupStoreError:
            raise
        except (DomainInvariantError, OSError) as exc:
            raise BackupStoreError("Input archive could not be verified") from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
