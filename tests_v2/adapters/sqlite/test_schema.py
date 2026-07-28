from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ytb_vps_v2.adapters.sqlite import schema as schema_module
from ytb_vps_v2.adapters.sqlite.schema import (
    SCHEMA_VERSION,
    StateStoreError,
    connect_database,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.domain.models import JobId, WorkStatus


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
        self.assertEqual(SCHEMA_VERSION, 3)
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
                "input_archives",
                "checkpoint_snapshots",
                "work_unit_dependencies",
            }.issubset(tables)
        )
        artifact_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(artifacts)")
        }
        self.assertIn("unit_key", artifact_columns)

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
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION + 1}")
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

    def test_degraded_durability_pragma_is_rejected(self) -> None:
        memory_connection = sqlite3.connect(":memory:", isolation_level=None)

        with patch(
            "ytb_vps_v2.adapters.sqlite.schema.sqlite3.connect",
            return_value=memory_connection,
        ):
            with self.assertRaisesRegex(StateStoreError, "durability"):
                connect_database(self.path)

        with self.assertRaises(sqlite3.ProgrammingError):
            memory_connection.execute("SELECT 1")

    def test_schema_v2_migrates_unit_ownership_without_changing_state(
        self,
    ) -> None:
        connection = sqlite3.connect(self.path, isolation_level=None)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(schema_module._MIGRATION_1)
        connection.executescript(schema_module._MIGRATION_2)
        connection.execute(
            "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            ("job-1", "a" * 64, "t0", "t2"),
        )
        connection.execute(
            "INSERT INTO work_units("
            "job_id, unit_key, stage, status, attempts, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            ("job-1", "render", "RENDER", "SUCCEEDED", 2, "t2"),
        )
        connection.execute(
            "INSERT INTO artifacts("
            "job_id, name, relative_path, size_bytes, sha256, owner_stage, "
            "dependencies_json, is_valid, committed_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "job-1",
                "render-plan",
                "artifacts/render/render-plan.json",
                42,
                "b" * 64,
                "RENDER",
                '["tts"]',
                1,
                "t2",
            ),
        )
        connection.close()

        store = SqliteStateStore(self.path)
        self.addCleanup(store.close)

        self.assertEqual(
            store.connection.execute("PRAGMA user_version").fetchone()[0],
            3,
        )
        unit = store.get_work_unit(JobId("job-1"), "render")
        self.assertIs(unit.status, WorkStatus.SUCCEEDED)
        self.assertEqual(unit.attempts, 2)
        row = store.connection.execute(
            "SELECT name, size_bytes, sha256, owner_stage, unit_key, "
            "dependencies_json, is_valid, committed_at "
            "FROM artifacts WHERE job_id=?",
            ("job-1",),
        ).fetchone()
        self.assertEqual(
            tuple(row),
            (
                "render-plan",
                42,
                "b" * 64,
                "RENDER",
                "render",
                '["tts"]',
                1,
                "t2",
            ),
        )

    def test_schema_v3_migration_failure_rolls_back_the_entire_rebuild(
        self,
    ) -> None:
        connection = sqlite3.connect(self.path, isolation_level=None)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(schema_module._MIGRATION_1)
        connection.executescript(schema_module._MIGRATION_2)
        connection.execute(
            "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            ("job-1", "a" * 64, "t0", "t1"),
        )
        connection.execute(
            "INSERT INTO work_units("
            "job_id, unit_key, stage, status, attempts, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            ("job-1", "render:legacy", "RENDER", "SUCCEEDED", 1, "t1"),
        )
        connection.execute(
            "INSERT INTO artifacts("
            "job_id, name, relative_path, size_bytes, sha256, owner_stage, "
            "dependencies_json, is_valid, committed_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "job-1",
                "legacy-render",
                "artifacts/render/legacy.mp4",
                42,
                "b" * 64,
                "RENDER",
                "[]",
                1,
                "t1",
            ),
        )
        connection.close()

        with self.assertRaises(StateStoreError):
            connect_database(self.path)

        inspected = sqlite3.connect(self.path)
        self.addCleanup(inspected.close)
        self.assertEqual(
            inspected.execute("PRAGMA user_version").fetchone()[0],
            2,
        )
        self.assertNotIn(
            "unit_key",
            {
                row[1]
                for row in inspected.execute("PRAGMA table_info(artifacts)")
            },
        )
        self.assertEqual(
            inspected.execute(
                "SELECT name, sha256 FROM artifacts"
            ).fetchone(),
            ("legacy-render", "b" * 64),
        )
        self.assertIsNone(
            inspected.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type='table' AND name='artifacts_v2'"
            ).fetchone()
        )


if __name__ == "__main__":
    unittest.main()
