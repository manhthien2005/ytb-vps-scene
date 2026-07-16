from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry, VerifiedInputArchive
from ytb_vps_v2.domain.models import JobId


class BackupStoreError(RuntimeError):
    """Raised when durable backup storage cannot satisfy its contract."""


@runtime_checkable
class SourceArchiver(Protocol):
    def archive(
        self, source: Path, job_id: JobId, at: str
    ) -> VerifiedInputArchive: ...


@runtime_checkable
class AdditiveObjectStore(Protocol):
    def put(
        self, source: Path, key: PurePosixPath, expected: FileDigest
    ) -> ManifestEntry: ...
