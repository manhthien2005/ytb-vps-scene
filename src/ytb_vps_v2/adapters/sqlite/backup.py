from __future__ import annotations

import os
import sqlite3
import uuid
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    digest_file,
    publish_additively,
    secure_root,
)
from ytb_vps_v2.adapters.sqlite.schema import SCHEMA_VERSION, StateStoreError
from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.ports.backup import BackupStoreError


def _backup_connection(
    source: sqlite3.Connection, destination: sqlite3.Connection
) -> None:
    source.backup(destination)


def _integrity_check(connection: sqlite3.Connection) -> bool:
    rows = connection.execute("PRAGMA integrity_check").fetchall()
    return len(rows) == 1 and rows[0][0] == "ok"


def _fsync_file(path: Path) -> None:
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def create_sqlite_snapshot(
    connection: sqlite3.Connection,
    destination: Path,
    key: PurePosixPath,
) -> ManifestEntry:
    if not isinstance(connection, sqlite3.Connection):
        raise StateStoreError("SQLite snapshot requires a live SQLite connection")
    if connection.in_transaction:
        raise StateStoreError(
            "SQLite snapshot source must not have an active transaction"
        )
    if not isinstance(destination, Path):
        raise StateStoreError("SQLite snapshot destination must be a Path")
    try:
        placeholder = ManifestEntry(key, FileDigest(0, "0" * 64))
    except DomainInvariantError as exc:
        raise StateStoreError("SQLite snapshot key is unsafe") from exc
    if placeholder.key.name != destination.name:
        raise StateStoreError("SQLite snapshot key must name its destination file")
    try:
        snapshot_root = secure_root(destination.parent)
    except BackupStoreError as exc:
        raise StateStoreError(
            "SQLite snapshot parent must be an existing real directory"
        ) from exc
    if destination.exists() or destination.is_symlink():
        raise StateStoreError("SQLite snapshot destination already exists")

    temporary = destination.with_name(
        f".{destination.name}.{uuid.uuid4().hex}.part"
    )
    target: sqlite3.Connection | None = None
    inspection: sqlite3.Connection | None = None
    try:
        target = sqlite3.connect(temporary, isolation_level=None)
        _backup_connection(connection, target)
        target.close()
        target = None

        inspection = sqlite3.connect(temporary, isolation_level=None)
        if not _integrity_check(inspection):
            raise StateStoreError("SQLite snapshot failed integrity_check")
        version = inspection.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            raise StateStoreError("SQLite snapshot schema version is incompatible")
        inspection.close()
        inspection = None

        _fsync_file(temporary)
        digest = digest_file(temporary)
        publish_additively(temporary, destination, digest, snapshot_root)
        return ManifestEntry(key, digest)
    except StateStoreError:
        raise
    except (sqlite3.DatabaseError, BackupStoreError, OSError) as exc:
        raise StateStoreError("SQLite backup snapshot failed") from exc
    finally:
        if target is not None:
            target.close()
        if inspection is not None:
            inspection.close()
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
