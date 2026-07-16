from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA_VERSION = 2


class StateStoreError(RuntimeError):
    """Raised when the v2 state store cannot satisfy its persistence contract."""


_MIGRATION_1 = """
BEGIN IMMEDIATE;
CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE config_fingerprints (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (job_id, stage)
);
CREATE TABLE work_units (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error_kind TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, unit_key)
);
CREATE TABLE artifacts (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    owner_stage TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name),
    UNIQUE (job_id, relative_path)
);
CREATE TABLE retry_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    error_kind TEXT NOT NULL,
    error_message TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (job_id, unit_key)
        REFERENCES work_units(job_id, unit_key) ON DELETE CASCADE
);
PRAGMA user_version=1;
COMMIT;
"""


_MIGRATION_2 = """
BEGIN IMMEDIATE;
CREATE TABLE input_archives (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    archive_key TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    verified_at TEXT NOT NULL
);
CREATE TABLE checkpoint_snapshots (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    checkpoint_id TEXT NOT NULL,
    manifest_key TEXT NOT NULL,
    manifest_size_bytes INTEGER NOT NULL CHECK (manifest_size_bytes >= 0),
    manifest_sha256 TEXT NOT NULL,
    state_key TEXT NOT NULL,
    state_size_bytes INTEGER NOT NULL CHECK (state_size_bytes >= 0),
    state_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (job_id, checkpoint_id),
    UNIQUE (job_id, manifest_key)
);
PRAGMA user_version=2;
COMMIT;
"""


def migrate(connection: sqlite3.Connection) -> None:
    if not isinstance(connection, sqlite3.Connection):
        raise StateStoreError("Migration requires a SQLite connection")
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise StateStoreError(
                f"Database uses newer schema version {version}; supported is {SCHEMA_VERSION}"
            )
        if version == 0:
            connection.executescript(_MIGRATION_1)
            version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version == 1:
            connection.executescript(_MIGRATION_2)
        final_version = connection.execute("PRAGMA user_version").fetchone()[0]
        if final_version != SCHEMA_VERSION:
            raise StateStoreError(
                f"Database schema version is {final_version}; expected {SCHEMA_VERSION}"
            )
    except StateStoreError:
        if connection.in_transaction:
            connection.rollback()
        raise
    except sqlite3.DatabaseError as exc:
        if connection.in_transaction:
            connection.rollback()
        raise StateStoreError("SQLite schema migration failed") from exc


def connect_database(path: Path) -> sqlite3.Connection:
    if not isinstance(path, Path):
        raise StateStoreError("State database path must be a Path")
    if path.name != "job-v2.sqlite":
        raise StateStoreError("V2 state database must be named job-v2.sqlite")
    if not path.parent.is_dir():
        raise StateStoreError("State database parent directory does not exist")

    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(path, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
        synchronous = connection.execute("PRAGMA synchronous").fetchone()[0]
        if (
            foreign_keys != 1
            or str(journal_mode).lower() != "wal"
            or synchronous != 2
        ):
            raise StateStoreError(
                "SQLite durability settings could not be enforced"
            )
        migrate(connection)
        return connection
    except StateStoreError:
        if connection is not None:
            connection.close()
        raise
    except sqlite3.DatabaseError as exc:
        if connection is not None:
            connection.close()
        raise StateStoreError("Unable to open v2 SQLite state database") from exc
