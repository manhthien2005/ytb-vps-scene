from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry, parse_manifest_bytes
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.restore import RestoreResult
from ytb_vps_v2.ports.backup import AdditiveObjectStore, BackupStoreError
from ytb_vps_v2.ports.restore import StagedRestoreWorkspace


_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_VERIFY_METHOD = "sha256-readback"


class RestoreError(RuntimeError):
    """Raised when a checkpoint cannot be restored without touching active state."""


def _bytes_digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


def _destination(
    workspace: StagedRestoreWorkspace,
    parent: Path,
    relative: PurePosixPath,
) -> Path:
    destination = parent.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    workspace.reject_reparse(destination.parent)
    return destination


def _remove_owned_staging(staging: Path, parent: Path) -> None:
    if not staging.exists() and not staging.is_symlink():
        return
    if (
        staging.parent != parent
        or not staging.name.startswith(".")
        or ".restore-" not in staging.name
    ):
        raise RestoreError("Owned restore staging identity is invalid")
    if staging.is_symlink() or (
        getattr(staging, "is_junction", None) is not None and staging.is_junction()
    ):
        staging.unlink()
        return
    shutil.rmtree(staging)


class CheckpointRestorer:
    def __init__(
        self,
        object_store: AdditiveObjectStore,
        workspace: StagedRestoreWorkspace,
    ) -> None:
        if not isinstance(object_store, AdditiveObjectStore):
            raise RestoreError("Restore object store does not satisfy its contract")
        self.object_store = object_store
        if not isinstance(workspace, StagedRestoreWorkspace):
            raise RestoreError("Restore workspace does not satisfy its contract")
        self.workspace = workspace

    def restore(
        self,
        manifest_key: PurePosixPath,
        target: Path,
        staging_parent: Path,
        observed_at: int,
    ) -> RestoreResult:
        if not isinstance(target, Path) or not target.is_absolute():
            raise RestoreError("Restore target must be an absolute Path")
        staging: Path | None = None
        try:
            parent = self.workspace.secure_parent(staging_parent)
            self.workspace.reject_reparse(target.parent)
            if target.parent.resolve(strict=True) != parent:
                raise RestoreError("Restore staging must share the target parent")
            ManifestEntry(PurePosixPath(target.name), FileDigest(0, "0" * 64))
            if target.exists() or target.is_symlink() or (
                getattr(target, "is_junction", None) is not None and target.is_junction()
            ):
                raise RestoreError("Restore target already exists")

            raw = self.object_store.read_bytes(manifest_key, _MAX_MANIFEST_BYTES)
            manifest_digest = _bytes_digest(raw)
            self.object_store.verify(
                manifest_key,
                manifest_digest,
                observed_at,
                _VERIFY_METHOD,
            )
            manifest = parse_manifest_bytes(raw)

            staging = Path(
                tempfile.mkdtemp(
                    prefix=f".{target.name}.restore-",
                    dir=parent,
                )
            )
            state_path = staging / "job-v2.sqlite"
            self.object_store.verify(
                manifest.state_snapshot.key,
                manifest.state_snapshot.digest,
                observed_at,
                _VERIFY_METHOD,
            )
            self.object_store.materialize(
                manifest.state_snapshot.key,
                state_path,
                manifest.state_snapshot.digest,
            )

            migrated_from = self.workspace.migrate_state(state_path)
            layout = self.workspace.inspect_state(state_path, manifest)

            input_destination = _destination(
                self.workspace,
                staging / "archive",
                layout.archive_key,
            )
            self.object_store.verify(
                layout.input_remote.key,
                layout.input_remote.digest,
                observed_at,
                _VERIFY_METHOD,
            )
            self.object_store.materialize(
                layout.input_remote.key,
                input_destination,
                layout.input_remote.digest,
            )

            for artifact in layout.artifacts:
                destination = _destination(
                    self.workspace,
                    staging / "workspace",
                    artifact.relative_path,
                )
                self.object_store.verify(
                    artifact.remote.key,
                    artifact.remote.digest,
                    observed_at,
                    _VERIFY_METHOD,
                )
                self.object_store.materialize(
                    artifact.remote.key,
                    destination,
                    artifact.remote.digest,
                )

            final_layout = self.workspace.inspect_state(state_path, manifest)
            if final_layout != layout:
                raise RestoreError("Staged restore layout changed during materialization")
            if (
                migrated_from is None
                and self.workspace.digest(state_path) != manifest.state_snapshot.digest
            ):
                raise RestoreError("Staged state snapshot changed during restore")
            if self.workspace.digest(input_destination) != layout.input_remote.digest:
                raise RestoreError("Staged input failed final verification")
            for artifact in layout.artifacts:
                destination = (staging / "workspace").joinpath(
                    *artifact.relative_path.parts
                )
                if self.workspace.digest(destination) != artifact.remote.digest:
                    raise RestoreError("Staged artifact failed final verification")

            self.workspace.publish(staging, target, parent)
            staging = None
            return RestoreResult(
                manifest.job_id,
                manifest.checkpoint_id,
                len(layout.artifacts),
                layout.schema_version,
                migrated_from,
            )
        except RestoreError:
            raise
        except (
            BackupStoreError,
            DomainInvariantError,
            OSError,
            RuntimeError,
            ValueError,
            TypeError,
        ) as exc:
            raise RestoreError("Verified staged checkpoint restore failed") from exc
        finally:
            if staging is not None:
                try:
                    _remove_owned_staging(staging, staging.parent)
                except (OSError, RestoreError) as cleanup_error:
                    raise RestoreError("Restore staging cleanup failed") from cleanup_error
