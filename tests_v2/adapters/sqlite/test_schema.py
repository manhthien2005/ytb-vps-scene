from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from ytb_vps_v2.adapters.sqlite.schema import (
    SCHEMA_VERSION,
    StateStoreError,
    connect_database,
)


class SqliteSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "job-v2.sqlite"

    def test_new_database_has_versioned_schema_and_durable_pragmas(self) -> None:
        connection = connect_database(self.path)
        self.addCleanup(connection.close)

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        self.assertEqual(SCHEMA_VERSION, 1)
        self.assertEqual(
            connection.execute("PRAGMA user_version").fetchone()[0],
            SCHEMA_VERSION,
        )
        self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        self.assertEqual(
            connection.execute("PRAGMA journal_mode").fetchone()[0].lower(),
            "wal",
        )
        self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 2)
        self.assertTrue(
            {
                "jobs",
                "config_fingerprints",
                "work_units",
                "artifacts",
                "retry_events",
            }.issubset(tables)
        )

    def test_reopen_is_idempotent_and_preserves_rows(self) -> None:
        first = connect_database(self.path)
        first.execute(
            "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            ("job-1", "a" * 64, "t1", "t1"),
        )
        first.commit()
        first.close()

        second = connect_database(self.path)
        self.addCleanup(second.close)

        self.assertEqual(
            second.execute("SELECT job_id FROM jobs").fetchone()[0],
            "job-1",
        )

    def test_future_schema_version_fails_explicitly(self) -> None:
        connection = connect_database(self.path)
        connection.execute("PRAGMA user_version=2")
        connection.close()

        with self.assertRaisesRegex(StateStoreError, "newer schema version"):
            connect_database(self.path)

    def test_corrupt_database_and_unsafe_path_fail_with_store_error(self) -> None:
        self.path.write_bytes(b"not a sqlite database")
        with self.assertRaises(StateStoreError):
            connect_database(self.path)

        wrong_name = self.path.with_name("job.sqlite")
        with self.assertRaisesRegex(StateStoreError, "job-v2.sqlite"):
            connect_database(wrong_name)


if __name__ == "__main__":
    unittest.main()
