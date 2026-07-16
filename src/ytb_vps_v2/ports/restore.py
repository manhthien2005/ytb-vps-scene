from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.backup import CheckpointManifest, FileDigest
from ytb_vps_v2.domain.restore import RestoreLayout


@runtime_checkable
class StagedRestoreWorkspace(Protocol):
    def secure_parent(self, parent: Path) -> Path: ...

    def reject_reparse(self, path: Path) -> None: ...

    def migrate_state(self, path: Path) -> int | None: ...

    def inspect_state(
        self,
        path: Path,
        manifest: CheckpointManifest,
    ) -> RestoreLayout: ...

    def digest(self, path: Path) -> FileDigest: ...

    def identity(self, path: Path) -> tuple[int, int]: ...

    def remove_owned(
        self,
        path: Path,
        parent: Path,
        expected_identity: tuple[int, int],
    ) -> None: ...

    def publish(
        self,
        source: Path,
        destination: Path,
        parent: Path,
        expected_identity: tuple[int, int],
    ) -> None: ...
