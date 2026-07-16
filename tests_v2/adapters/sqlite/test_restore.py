from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.sqlite.restore import (
    StagedRestoreError,
    inspect_staged_state,
    migrate_staged_state,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
)
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import Artifact, JobId, StageName, WorkUnit


class StagedSqliteRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        archive_root = self.base / "source-archive"
        archive_root.mkdir()
        source = self.base / "source.mp4"
        source.write_bytes(b"source-video")
        self.job_id = JobId("job-1")
        self.archive = VerifiedInputArchiver(archive_root).archive(
            source, self.job_id, "verified"
        )
        self.path = self.base / "job-v2.sqlite"
        state = SqliteStateStore(self.path)
        state.create_job(
            self.job_id,
            Fingerprint(self.archive.source.digest.sha256),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )
        state.record_verified_input(self.job_id, self.archive)
        self.artifact_bytes = b'{"ocr":"result"}'
        artifact_digest = FileDigest(
            len(self.artifact_bytes),
            "c" * 64,
        )
        self.artifact = Artifact(
            "ocr-result",
            PurePosixPath("artifacts/ocr.json"),
            artifact_digest.size_bytes,
            artifact_digest.sha256,
            StageName.OCR,
        )
        state.put_work_unit(self.job_id, WorkUnit("ocr:1", StageName.OCR), "planned")
        state.start_work_unit(self.job_id, "ocr:1", "started")
        state.commit_artifact(self.job_id, "ocr:1", self.artifact, "committed")
        state.close()
        state_digest = digest_file(self.path)
        prefix = PurePosixPath("checkpoints/job-1/cp-1")
        self.manifest = CheckpointManifest(
            1,
            "cp-1",
            self.job_id,
            self.archive.source,
            ManifestEntry(prefix / "input" / "source.mp4", self.archive.source.digest),
            ManifestEntry(prefix / "state" / "job-v2.sqlite", state_digest),
            (
                ManifestEntry(
                    prefix / "workspace" / self.artifact.relative_path,
                    FileDigest(self.artifact.size_bytes, self.artifact.sha256),
                ),
            ),
            "created",
        )

    def _execute(self, statement: str, parameters: tuple[object, ...] = ()) -> None:
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(statement, parameters)
            connection.commit()
        finally:
            connection.close()

    def test_inspects_exact_job_input_and_artifact_layout(self) -> None:
        layout = inspect_staged_state(self.path, self.manifest)

        self.assertEqual(layout.job_id, self.job_id)
        self.assertEqual(layout.archive_key, self.archive.archive.key)
        self.assertEqual(layout.schema_version, 2)
        self.assertEqual(len(layout.artifacts), 1)
        self.assertEqual(
            layout.artifacts[0].relative_path,
            self.artifact.relative_path,
        )
        self.assertEqual(layout.artifacts[0].remote, self.manifest.artifacts[0])

    def test_rejects_corruption_future_schema_and_incomplete_integrity_result(self) -> None:
        corrupt = self.base / "corrupt.sqlite"
        corrupt.write_bytes(b"not sqlite")
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(corrupt, self.manifest)

        self._execute("PRAGMA user_version=99")
        with self.assertRaisesRegex(StagedRestoreError, "newer"):
            inspect_staged_state(self.path, self.manifest)

    def test_rejects_version_two_database_with_incomplete_or_altered_schema(self) -> None:
        self._execute("DROP TABLE retry_events")

        with self.assertRaisesRegex(StagedRestoreError, "schema"):
            inspect_staged_state(self.path, self.manifest)

    def test_rejects_job_source_or_verified_input_mismatch(self) -> None:
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(
                self.path,
                replace(self.manifest, job_id=JobId("other-job")),
            )

        wrong_digest = FileDigest(self.archive.source.digest.size_bytes, "d" * 64)
        wrong_source = SourceIdentity(self.archive.source.name, wrong_digest)
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(
                self.path,
                replace(
                    self.manifest,
                    source=wrong_source,
                    input_archive=ManifestEntry(
                        self.manifest.input_archive.key,
                        wrong_digest,
                    ),
                ),
            )

        self._execute("DELETE FROM input_archives")
        with self.assertRaisesRegex(StagedRestoreError, "input"):
            inspect_staged_state(self.path, self.manifest)

    def test_rejects_missing_extra_mismatching_or_unsafe_artifact_layout(self) -> None:
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(
                self.path,
                replace(self.manifest, artifacts=()),
            )

        extra = ManifestEntry(
            PurePosixPath("checkpoints/job-1/cp-1/workspace/extra.bin"),
            FileDigest(1, "e" * 64),
        )
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(
                self.path,
                replace(
                    self.manifest,
                    artifacts=tuple(sorted((*self.manifest.artifacts, extra), key=lambda item: str(item.key))),
                ),
            )

        mismatching = ManifestEntry(
            self.manifest.artifacts[0].key,
            FileDigest(self.artifact.size_bytes, "f" * 64),
        )
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(
                self.path,
                replace(self.manifest, artifacts=(mismatching,)),
            )

        self._execute(
            "UPDATE artifacts SET relative_path='../escape.bin' WHERE job_id=?",
            (self.job_id.value,),
        )
        with self.assertRaises(StagedRestoreError):
            inspect_staged_state(self.path, self.manifest)

    def test_migrates_only_staged_v1_copy_and_rechecks_schema(self) -> None:
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("DROP TABLE checkpoint_snapshots")
            connection.execute("DROP TABLE input_archives")
            connection.execute("PRAGMA user_version=1")
            connection.commit()
        finally:
            connection.close()
        source_v1 = self.base / "source-v1.sqlite"
        self.path.replace(source_v1)
        staged = self.base / "staged"
        staged.mkdir()
        staged_path = staged / "job-v2.sqlite"
        shutil.copyfile(source_v1, staged_path)

        migrated_from = migrate_staged_state(staged_path)

        self.assertEqual(migrated_from, 1)
        source_connection = sqlite3.connect(source_v1)
        try:
            self.assertEqual(source_connection.execute("PRAGMA user_version").fetchone()[0], 1)
        finally:
            source_connection.close()
        staged_connection = sqlite3.connect(staged_path)
        try:
            self.assertEqual(staged_connection.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
            self.assertEqual(staged_connection.execute("PRAGMA user_version").fetchone()[0], 2)
            tables = {
                row[0]
                for row in staged_connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertTrue({"input_archives", "checkpoint_snapshots"}.issubset(tables))
        finally:
            staged_connection.close()


if __name__ == "__main__":
    unittest.main()
