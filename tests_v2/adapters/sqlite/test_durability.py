from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.sqlite import backup as backup_module
from ytb_vps_v2.adapters.sqlite.backup import create_sqlite_snapshot
from ytb_vps_v2.adapters.sqlite.schema import (
    SCHEMA_VERSION,
    StateStoreError,
    _MIGRATION_1,
    connect_database,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.domain.backup import (
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import JobId, StageName, WorkStatus, WorkUnit
from ytb_vps_v2.domain.state import StateTransitionError
from ytb_vps_v2.ports.backup import BackupStoreError


SHA_A = "a" * 64
SHA_B = "b" * 64


def archive_evidence(sha256: str = SHA_A) -> VerifiedInputArchive:
    digest = FileDigest(12, sha256)
    return VerifiedInputArchive(
        SourceIdentity("source.mp4", digest),
        ManifestEntry(PurePosixPath(f"inputs/{sha256[:2]}/{sha256}.mp4"), digest),
        "verified",
    )


class SqliteDurabilityStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.path = self.base / "job-v2.sqlite"
        self.store = SqliteStateStore(self.path)
        self.addCleanup(lambda: self.store.close())
        self.job_id = JobId("job-1")
        self.store.create_job(
            self.job_id,
            Fingerprint(SHA_A),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )

    def test_schema_v2_tables_exist_and_real_v1_database_migrates(self) -> None:
        tables = {
            row[0]
            for row in self.store.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        self.assertEqual(SCHEMA_VERSION, 2)
        self.assertTrue({"input_archives", "checkpoint_snapshots"}.issubset(tables))

        legacy_path = self.base / "legacy" / "job-v2.sqlite"
        legacy_path.parent.mkdir()
        legacy = sqlite3.connect(legacy_path, isolation_level=None)
        legacy.executescript(_MIGRATION_1)
        legacy.execute(
            "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
            "VALUES ('preserved', ?, 't0', 't0')",
            (SHA_A,),
        )
        legacy.close()

        migrated = connect_database(legacy_path)
        self.addCleanup(migrated.close)
        self.assertEqual(migrated.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual(
            migrated.execute("SELECT job_id FROM jobs").fetchone()[0],
            "preserved",
        )

    def test_post_ingest_work_requires_matching_verified_input_and_survives_reopen(self) -> None:
        self.store.put_work_unit(
            self.job_id, WorkUnit("ingest:1", StageName.INGEST), "planned"
        )
        self.store.put_work_unit(
            self.job_id, WorkUnit("ocr:1", StageName.OCR), "planned"
        )

        ingest = self.store.start_work_unit(self.job_id, "ingest:1", "started")
        with self.assertRaisesRegex(StateTransitionError, "durable input"):
            self.store.start_work_unit(self.job_id, "ocr:1", "blocked")
        with self.assertRaisesRegex(StateStoreError, "source identity"):
            self.store.record_verified_input(self.job_id, archive_evidence(SHA_B))

        evidence = archive_evidence()
        self.store.record_verified_input(self.job_id, evidence)
        self.store.record_verified_input(self.job_id, evidence)
        running = self.store.start_work_unit(self.job_id, "ocr:1", "started")
        self.store.close()
        self.store = SqliteStateStore(self.path)

        self.assertEqual(ingest.status, WorkStatus.RUNNING)
        self.assertEqual(running.status, WorkStatus.RUNNING)
        self.assertEqual(self.store.verified_input(self.job_id), evidence)

    def test_conflicting_archive_evidence_is_rejected_unchanged(self) -> None:
        evidence = archive_evidence()
        self.store.record_verified_input(self.job_id, evidence)
        conflict = VerifiedInputArchive(
            evidence.source,
            ManifestEntry(PurePosixPath("inputs/conflict.mp4"), evidence.source.digest),
            "later",
        )

        with self.assertRaisesRegex(StateStoreError, "conflicts"):
            self.store.record_verified_input(self.job_id, conflict)

        self.assertEqual(self.store.verified_input(self.job_id), evidence)

    def test_checkpoint_evidence_is_idempotent_only_when_exact(self) -> None:
        manifest_entry = ManifestEntry(
            PurePosixPath("checkpoints/job-1/cp-1/manifest-v1.json"),
            FileDigest(100, SHA_A),
        )
        state_entry = ManifestEntry(
            PurePosixPath("checkpoints/job-1/cp-1/job-v2.sqlite"),
            FileDigest(200, SHA_B),
        )
        with self.assertRaisesRegex(StateStoreError, "verified input"):
            self.store.record_checkpoint(
                self.job_id, "cp-1", manifest_entry, state_entry, "completed"
            )
        self.store.record_verified_input(self.job_id, archive_evidence())
        self.store.record_checkpoint(
            self.job_id, "cp-1", manifest_entry, state_entry, "completed"
        )
        self.store.record_checkpoint(
            self.job_id, "cp-1", manifest_entry, state_entry, "completed"
        )

        records = self.store.completed_checkpoints(self.job_id)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].checkpoint_id, "cp-1")
        self.assertEqual(records[0].manifest, manifest_entry)
        with self.assertRaisesRegex(StateStoreError, "conflicts"):
            self.store.record_checkpoint(
                self.job_id,
                "cp-1",
                ManifestEntry(manifest_entry.key, FileDigest(101, SHA_A)),
                state_entry,
                "completed",
            )
        with self.assertRaises(StateStoreError):
            self.store.record_checkpoint(
                self.job_id,
                "cp-2",
                state_entry,
                state_entry,
                "completed",
            )


class SqliteBackupSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.path = self.base / "job-v2.sqlite"
        self.connection = connect_database(self.path)
        self.addCleanup(self.connection.close)
        self.connection.execute(
            "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
            "VALUES ('job-1', ?, 't0', 't0')",
            (SHA_A,),
        )
        self.snapshot_dir = self.base / "snapshots"
        self.snapshot_dir.mkdir()
        self.destination = self.snapshot_dir / "job-v2.sqlite"
        self.key = PurePosixPath("checkpoints/job-1/cp-1/job-v2.sqlite")

    def test_backup_api_snapshot_is_independently_integrity_checked(self) -> None:
        result = create_sqlite_snapshot(self.connection, self.destination, self.key)

        self.assertEqual(result.key, self.key)
        self.assertEqual(result.digest, digest_file(self.destination))
        snapshot = sqlite3.connect(self.destination)
        self.addCleanup(snapshot.close)
        self.assertEqual(snapshot.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(snapshot.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual(snapshot.execute("SELECT job_id FROM jobs").fetchone()[0], "job-1")
        self.assertEqual(tuple(self.snapshot_dir.glob("*.part")), ())

    def test_existing_snapshot_is_never_replaced(self) -> None:
        self.destination.write_bytes(b"existing")

        with self.assertRaises(StateStoreError):
            create_sqlite_snapshot(self.connection, self.destination, self.key)

        self.assertEqual(self.destination.read_bytes(), b"existing")

    def test_backup_or_integrity_failure_publishes_nothing(self) -> None:
        failures = (
            mock.patch.object(
                backup_module,
                "_backup_connection",
                side_effect=sqlite3.DatabaseError("injected backup failure"),
            ),
            mock.patch.object(backup_module, "_integrity_check", return_value=False),
        )
        for failure in failures:
            with self.subTest(failure=failure):
                with failure:
                    with self.assertRaises(StateStoreError):
                        create_sqlite_snapshot(
                            self.connection, self.destination, self.key
                        )
                self.assertFalse(self.destination.exists())
                self.assertEqual(tuple(self.snapshot_dir.glob("*.part")), ())

    def test_post_publish_verification_failure_removes_only_owned_snapshot(self) -> None:
        real_digest = backup_module.digest_file
        calls = 0

        def fail_second_digest(path: Path) -> FileDigest:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise BackupStoreError("injected final verification failure")
            return real_digest(path)

        with mock.patch.object(backup_module, "digest_file", fail_second_digest):
            with self.assertRaises(StateStoreError):
                create_sqlite_snapshot(self.connection, self.destination, self.key)

        self.assertFalse(self.destination.exists())
        self.assertEqual(tuple(self.snapshot_dir.glob("*.part")), ())

    def test_active_source_transaction_is_rejected_without_blocking(self) -> None:
        self.connection.execute("BEGIN IMMEDIATE")
        self.addCleanup(self.connection.rollback)

        with self.assertRaisesRegex(StateStoreError, "transaction"):
            create_sqlite_snapshot(self.connection, self.destination, self.key)

        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
