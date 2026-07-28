from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    digest_file,
    directory_identity,
    publish_directory_no_replace,
    remove_owned_directory,
    reject_reparse_components,
    secure_root,
)
from ytb_vps_v2.adapters.sqlite.schema import (
    SCHEMA_VERSION,
    StateStoreError,
    migrate,
)
from ytb_vps_v2.domain.backup import CheckpointManifest, FileDigest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Artifact, JobId, StageName, WorkStatus
from ytb_vps_v2.domain.restore import RestoreArtifact, RestoreLayout
from ytb_vps_v2.ports.backup import BackupStoreError


class StagedRestoreError(RuntimeError):
    """Raised when staged SQLite state is not an exact restorable checkpoint."""


def _object_prefix(job_id: JobId) -> PurePosixPath:
    token = hashlib.sha256(
        job_id.value.encode("utf-8")
    ).hexdigest()[:20]
    return PurePosixPath("objects", token)


def _connection(path: Path, *, readonly: bool) -> sqlite3.Connection:
    if not isinstance(path, Path):
        raise StagedRestoreError("Staged state path must be a Path")
    try:
        digest_file(path)
        if readonly:
            location = path.resolve(strict=True).as_uri() + "?mode=ro"
            connection = sqlite3.connect(location, uri=True, isolation_level=None)
        else:
            connection = sqlite3.connect(path, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection
    except (BackupStoreError, OSError, sqlite3.DatabaseError) as exc:
        raise StagedRestoreError("Staged state cannot be opened safely") from exc


def _require_integrity(connection: sqlite3.Connection) -> None:
    rows = connection.execute("PRAGMA integrity_check").fetchall()
    if len(rows) != 1 or rows[0][0] != "ok":
        raise StagedRestoreError("Staged SQLite integrity_check did not return exact ok")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise StagedRestoreError("Staged SQLite has foreign-key violations")


def _version(connection: sqlite3.Connection) -> int:
    value = connection.execute("PRAGMA user_version").fetchone()[0]
    if type(value) is not int or value < 1:
        raise StagedRestoreError("Staged SQLite schema version is unsupported")
    if value > SCHEMA_VERSION:
        raise StagedRestoreError(
            f"Staged SQLite uses newer schema version {value}"
        )
    return value


def _schema_signature(
    connection: sqlite3.Connection,
) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' "
            "ORDER BY type, name"
        ).fetchall()
    )


def _require_current_schema(connection: sqlite3.Connection) -> None:
    reference = sqlite3.connect(":memory:", isolation_level=None)
    try:
        migrate(reference)
        expected = _schema_signature(reference)
    finally:
        reference.close()
    if _schema_signature(connection) != expected:
        raise StagedRestoreError(
            "Staged SQLite schema does not match the current schema"
        )


def _artifact(row: sqlite3.Row) -> Artifact:
    dependencies = json.loads(row["dependencies_json"])
    if type(dependencies) is not list or any(
        type(item) is not str for item in dependencies
    ):
        raise StagedRestoreError("Stored artifact dependencies are invalid")
    canonical = json.dumps(tuple(dependencies), separators=(",", ":"), ensure_ascii=False)
    if canonical != row["dependencies_json"]:
        raise StagedRestoreError("Stored artifact dependencies are not canonical")
    return Artifact(
        row["name"],
        PurePosixPath(row["relative_path"]),
        row["size_bytes"],
        row["sha256"],
        StageName(row["owner_stage"]),
        tuple(dependencies),
    )


def inspect_staged_state(
    path: Path,
    manifest: CheckpointManifest,
) -> RestoreLayout:
    if type(manifest) is not CheckpointManifest:
        raise StagedRestoreError("Restore manifest must be CheckpointManifest")
    connection: sqlite3.Connection | None = None
    try:
        connection = _connection(path, readonly=True)
        _require_integrity(connection)
        version = _version(connection)
        if version != SCHEMA_VERSION:
            raise StagedRestoreError("Staged SQLite must be migrated before inspection")
        _require_current_schema(connection)

        jobs = connection.execute(
            "SELECT job_id, source_sha256 FROM jobs ORDER BY job_id"
        ).fetchall()
        if len(jobs) != 1:
            raise StagedRestoreError("Staged SQLite must contain exactly one job")
        if (
            jobs[0]["job_id"] != manifest.job_id.value
            or jobs[0]["source_sha256"] != manifest.source.digest.sha256
        ):
            raise StagedRestoreError("Staged job identity does not match manifest")

        inputs = connection.execute(
            "SELECT source_name, archive_key, size_bytes, sha256 "
            "FROM input_archives WHERE job_id=?",
            (manifest.job_id.value,),
        ).fetchall()
        if len(inputs) != 1:
            raise StagedRestoreError("Staged verified input is missing or ambiguous")
        input_row = inputs[0]
        input_digest = FileDigest(input_row["size_bytes"], input_row["sha256"])
        archive_entry = ManifestEntry(
            PurePosixPath(input_row["archive_key"]),
            input_digest,
        )
        if (
            input_row["source_name"] != manifest.source.name
            or input_digest != manifest.source.digest
            or manifest.input_archive.digest != input_digest
        ):
            raise StagedRestoreError("Staged verified input does not match manifest")

        state_key = manifest.state_snapshot.key
        prefix = state_key.parent.parent
        if state_key.name != "job-v2.sqlite" or state_key.parent.name != "state":
            raise StagedRestoreError("Checkpoint object layout is invalid")
        if manifest.version == 1:
            if (
                manifest.input_archive.key.parent.name != "input"
                or manifest.input_archive.key.parent.parent != prefix
            ):
                raise StagedRestoreError(
                    "Checkpoint object layout is invalid"
                )
        else:
            expected_input = (
                _object_prefix(manifest.job_id)
                / "input"
                / input_digest.sha256
            )
            if manifest.input_archive.key != expected_input:
                raise StagedRestoreError(
                    "Checkpoint object layout is invalid"
                )

        unit_rows = connection.execute(
            "SELECT unit_key, stage, status FROM work_units WHERE job_id=?",
            (manifest.job_id.value,),
        ).fetchall()
        units = {
            row["unit_key"]: (row["stage"], row["status"])
            for row in unit_rows
        }
        rows = connection.execute(
            "SELECT name, relative_path, size_bytes, sha256, owner_stage, "
            "unit_key, dependencies_json FROM artifacts "
            "WHERE job_id=? AND is_valid=1 ORDER BY relative_path",
            (manifest.job_id.value,),
        ).fetchall()
        stored_artifacts: list[Artifact] = []
        for row in rows:
            unit = units.get(row["unit_key"])
            if (
                unit is None
                or unit[0] != row["owner_stage"]
                or unit[1] != WorkStatus.SUCCEEDED.value
            ):
                raise StagedRestoreError(
                    "Valid artifact owner unit is inconsistent"
                )
            stored_artifacts.append(_artifact(row))
        remote_by_key = {str(item.key): item for item in manifest.artifacts}
        if len(remote_by_key) != len(manifest.artifacts):
            raise StagedRestoreError("Manifest artifact objects are ambiguous")
        layout_artifacts: list[RestoreArtifact] = []
        expected_keys: set[str] = set()
        for artifact in stored_artifacts:
            if manifest.version == 1:
                expected_key = (
                    prefix / "workspace" / artifact.relative_path
                )
            else:
                expected_key = (
                    _object_prefix(manifest.job_id)
                    / "workspace"
                    / artifact.relative_path
                    / artifact.sha256
                )
            expected_keys.add(str(expected_key))
            remote = remote_by_key.get(str(expected_key))
            expected_digest = FileDigest(artifact.size_bytes, artifact.sha256)
            if remote is None or remote.digest != expected_digest:
                raise StagedRestoreError(
                    "Staged artifact does not match its manifest object"
                )
            layout_artifacts.append(RestoreArtifact(artifact.relative_path, remote))
        if expected_keys != set(remote_by_key):
            raise StagedRestoreError("Manifest has missing or extra artifact objects")

        return RestoreLayout(
            manifest.job_id,
            archive_entry.key,
            manifest.input_archive,
            tuple(layout_artifacts),
            version,
        )
    except StagedRestoreError:
        raise
    except (
        sqlite3.DatabaseError,
        DomainInvariantError,
        ValueError,
        TypeError,
        json.JSONDecodeError,
    ) as exc:
        raise StagedRestoreError("Staged SQLite state is invalid") from exc
    finally:
        if connection is not None:
            connection.close()


def migrate_staged_state(path: Path) -> int | None:
    connection: sqlite3.Connection | None = None
    original: int | None = None
    try:
        connection = _connection(path, readonly=False)
        _require_integrity(connection)
        original = _version(connection)
        if original == SCHEMA_VERSION:
            return None
        migrate(connection)
        _require_integrity(connection)
        if _version(connection) != SCHEMA_VERSION:
            raise StagedRestoreError("Staged SQLite migration did not reach current schema")
        _require_current_schema(connection)
        connection.close()
        connection = None
        with path.open("r+b") as handle:
            os.fsync(handle.fileno())
        return original
    except StagedRestoreError:
        raise
    except (sqlite3.DatabaseError, StateStoreError, BackupStoreError, OSError) as exc:
        raise StagedRestoreError("Staged SQLite migration failed") from exc
    finally:
        if connection is not None:
            connection.close()


class LocalStagedRestoreWorkspace:
    def secure_parent(self, parent: Path) -> Path:
        return secure_root(parent)

    def reject_reparse(self, path: Path) -> None:
        reject_reparse_components(path)

    def migrate_state(self, path: Path) -> int | None:
        return migrate_staged_state(path)

    def inspect_state(
        self,
        path: Path,
        manifest: CheckpointManifest,
    ) -> RestoreLayout:
        return inspect_staged_state(path, manifest)

    def digest(self, path: Path) -> FileDigest:
        return digest_file(path)

    def identity(self, path: Path) -> tuple[int, int]:
        return directory_identity(path)

    def remove_owned(
        self,
        path: Path,
        parent: Path,
        expected_identity: tuple[int, int],
    ) -> None:
        remove_owned_directory(path, parent, expected_identity)

    def publish(
        self,
        source: Path,
        destination: Path,
        parent: Path,
        expected_identity: tuple[int, int],
    ) -> None:
        publish_directory_no_replace(
            source,
            destination,
            parent,
            expected_identity,
        )
