from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath
from unittest import mock

from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity, digest_file
from ytb_vps_v2.adapters.filesystem import integrity as integrity_module
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.adapters.sqlite.restore import LocalStagedRestoreWorkspace
from ytb_vps_v2.adapters.sqlite.schema import SCHEMA_VERSION
from ytb_vps_v2.application import restore as restore_module
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.restore import CheckpointRestorer, RestoreError
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.backup import canonical_manifest_bytes
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import Artifact, JobId, StageName, WorkUnit
from ytb_vps_v2.ports.backup import BackupStoreError


class CheckpointRestorerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.workspace = self.base / "workspace"
        self.archive_root = self.base / "archive-source"
        self.remote_root = self.base / "remote"
        self.snapshot_root = self.base / "snapshots"
        self.state_root = self.base / "state"
        self.restore_parent = self.base / "restores"
        for directory in (
            self.workspace,
            self.archive_root,
            self.remote_root,
            self.snapshot_root,
            self.state_root,
            self.restore_parent,
        ):
            directory.mkdir()

        self.source = self.base / "source.mp4"
        self.source.write_bytes(b"source-video")
        self.job_id = JobId("job-restore")
        self.archive = VerifiedInputArchiver(self.archive_root).archive(
            self.source,
            self.job_id,
            "verified",
        )
        self.state = SqliteStateStore(self.state_root / "job-v2.sqlite")
        self.addCleanup(self.state.close)
        self.state.create_job(
            self.job_id,
            Fingerprint(self.archive.source.digest.sha256),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )
        self.state.record_verified_input(self.job_id, self.archive)

        artifact_path = self.workspace / "artifacts" / "ocr.json"
        artifact_path.parent.mkdir()
        artifact_path.write_bytes(b'{"ocr":"restorable"}')
        artifact_digest = digest_file(artifact_path)
        self.artifact = Artifact(
            "ocr-result",
            PurePosixPath("artifacts/ocr.json"),
            artifact_digest.size_bytes,
            artifact_digest.sha256,
            StageName.OCR,
        )
        self.state.put_work_unit(
            self.job_id,
            WorkUnit("ocr:1", StageName.OCR),
            "planned",
        )
        self.state.start_work_unit(self.job_id, "ocr:1", "started")
        self.state.commit_artifact(
            self.job_id,
            "ocr:1",
            self.artifact,
            "committed",
        )

        self.store = LocalAdditiveObjectStore(self.remote_root)
        self.manifest = CheckpointPublisher(
            self.state,
            self.store,
            self.archive_root,
            LocalFileIntegrity(),
        ).publish(
            self.job_id,
            "cp-restore",
            self.workspace,
            self.snapshot_root,
            "checkpoint-time",
        )
        records = self.state.completed_checkpoints(self.job_id)
        self.manifest_entry = records[0].manifest
        self.restore_workspace = LocalStagedRestoreWorkspace()
        self.restorer = CheckpointRestorer(self.store, self.restore_workspace)

    def _temporary_restore_paths(self) -> tuple[Path, ...]:
        return tuple(self.restore_parent.glob(".*.restore-*"))

    def test_restores_real_checkpoint_into_absent_target(self) -> None:
        target = self.restore_parent / "job-restored"

        result = self.restorer.restore(
            self.manifest_entry,
            target,
            self.restore_parent,
            100,
        )

        self.assertEqual(result.job_id, self.job_id)
        self.assertEqual(result.checkpoint_id, self.manifest.checkpoint_id)
        self.assertEqual(result.artifact_count, 1)
        self.assertEqual(result.schema_version, SCHEMA_VERSION)
        self.assertIsNone(result.migrated_from)
        self.assertEqual(
            (target / "archive").joinpath(*self.archive.archive.key.parts).read_bytes(),
            self.source.read_bytes(),
        )
        self.assertEqual(
            (target / "workspace").joinpath(*self.artifact.relative_path.parts).read_bytes(),
            (self.workspace).joinpath(*self.artifact.relative_path.parts).read_bytes(),
        )
        self.assertTrue((target / "job-v2.sqlite").is_file())
        self.assertEqual(self._temporary_restore_paths(), ())

    def test_existing_target_is_untouched(self) -> None:
        target = self.restore_parent / "active-job"
        target.mkdir()
        marker = target / "active.txt"
        marker.write_bytes(b"must-stay")

        with self.assertRaises(RestoreError):
            self.restorer.restore(
                self.manifest_entry,
                target,
                self.restore_parent,
                100,
            )

        self.assertEqual(marker.read_bytes(), b"must-stay")
        self.assertEqual(tuple(target.iterdir()), (marker,))
        self.assertEqual(self._temporary_restore_paths(), ())

    def test_interruption_before_and_after_each_materialization_is_retryable(self) -> None:
        real_materialize = self.store.materialize
        object_count = 2 + len(self.manifest.artifacts)
        for fail_index in range(1, object_count + 1):
            for timing in ("before", "after"):
                with self.subTest(fail_index=fail_index, timing=timing):
                    calls = 0

                    def interrupted(*args: object, **kwargs: object):
                        nonlocal calls
                        calls += 1
                        if calls == fail_index and timing == "before":
                            raise BackupStoreError("injected pre-copy interruption")
                        result = real_materialize(*args, **kwargs)
                        if calls == fail_index and timing == "after":
                            raise BackupStoreError("injected post-copy interruption")
                        return result

                    target = self.restore_parent / f"failed-{fail_index}-{timing}"
                    with mock.patch.object(self.store, "materialize", interrupted):
                        with self.assertRaises(RestoreError):
                            self.restorer.restore(
                                self.manifest_entry,
                                target,
                                self.restore_parent,
                                100,
                            )
                    self.assertFalse(target.exists())
                    self.assertEqual(self._temporary_restore_paths(), ())

        retry_target = self.restore_parent / "retry-success"
        result = self.restorer.restore(
            self.manifest_entry,
            retry_target,
            self.restore_parent,
            101,
        )
        self.assertEqual(result.job_id, self.job_id)

    def test_failure_before_final_publish_removes_owned_staging(self) -> None:
        target = self.restore_parent / "publish-failure"
        with mock.patch.object(
            self.restore_workspace,
            "publish",
            side_effect=BackupStoreError("injected final publication failure"),
        ):
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )

        self.assertFalse(target.exists())
        self.assertEqual(self._temporary_restore_paths(), ())

    def test_migration_interruption_removes_owned_staging(self) -> None:
        target = self.restore_parent / "migration-failure"
        with mock.patch.object(
            self.restore_workspace,
            "migrate_state",
            side_effect=RuntimeError("injected migration interruption"),
        ):
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )

        self.assertFalse(target.exists())
        self.assertEqual(self._temporary_restore_paths(), ())

    def test_staging_swap_on_failure_never_deletes_replacement(self) -> None:
        displaced = self.restore_parent / "displaced-owned-staging"
        replacement_path: Path | None = None

        def swap_then_fail(*args: object, **kwargs: object):
            nonlocal replacement_path
            staging_paths = self._temporary_restore_paths()
            self.assertEqual(len(staging_paths), 1)
            replacement_path = staging_paths[0]
            replacement_path.rename(displaced)
            replacement_path.mkdir()
            (replacement_path / "attacker.txt").write_bytes(b"do-not-delete")
            raise BackupStoreError("injected failure after staging swap")

        target = self.restore_parent / "swap-cleanup-failure"
        with mock.patch.object(self.store, "materialize", swap_then_fail):
            with self.assertRaisesRegex(RestoreError, "cleanup"):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )

        self.assertIsNotNone(replacement_path)
        assert replacement_path is not None
        self.assertEqual(
            (replacement_path / "attacker.txt").read_bytes(),
            b"do-not-delete",
        )
        self.assertTrue(displaced.is_dir())
        self.assertFalse(target.exists())

    def test_state_is_materialized_first_and_final_revalidation_can_abort(self) -> None:
        real_materialize = self.store.materialize
        materialized: list[PurePosixPath] = []

        def recording_materialize(*args: object, **kwargs: object):
            materialized.append(args[0])
            return real_materialize(*args, **kwargs)

        target = self.restore_parent / "final-validation-failure"
        real_inspect = self.restore_workspace.inspect_state
        inspections = 0

        def fail_second_inspection(*args: object, **kwargs: object):
            nonlocal inspections
            inspections += 1
            if inspections == 2:
                raise RuntimeError("injected final validation failure")
            return real_inspect(*args, **kwargs)

        with (
            mock.patch.object(self.store, "materialize", recording_materialize),
            mock.patch.object(
                self.restore_workspace,
                "inspect_state",
                fail_second_inspection,
            ),
        ):
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )

        self.assertEqual(materialized[0], self.manifest.state_snapshot.key)
        self.assertFalse(target.exists())
        self.assertEqual(self._temporary_restore_paths(), ())

    def test_target_creation_race_never_overwrites_the_winner(self) -> None:
        target = self.restore_parent / "race-target"
        real_publish = self.restore_workspace.publish

        def competing_publish(
            source: Path,
            destination: Path,
            parent: Path,
            expected_identity: tuple[int, int],
        ) -> None:
            destination.mkdir()
            (destination / "winner.txt").write_bytes(b"winner")
            real_publish(source, destination, parent, expected_identity)

        with mock.patch.object(
            self.restore_workspace,
            "publish",
            competing_publish,
        ):
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )

        self.assertEqual((target / "winner.txt").read_bytes(), b"winner")
        self.assertEqual(tuple(target.iterdir()), (target / "winner.txt",))
        self.assertEqual(self._temporary_restore_paths(), ())

    @unittest.skipUnless(__import__("os").name == "nt", "Windows handle test")
    def test_directory_publication_does_not_use_swappable_source_path(self) -> None:
        source = self.restore_parent / ".pinned.restore-source"
        source.mkdir()
        (source / "identity.txt").write_bytes(b"verified-staging")
        replacement = self.restore_parent / "attacker-replacement"
        replacement.mkdir()
        (replacement / "identity.txt").write_bytes(b"attacker")
        displaced = self.restore_parent / "displaced"
        target = self.restore_parent / "published"
        real_rename = __import__("os").rename

        def swap_before_path_rename(first: object, second: object) -> None:
            real_rename(source, displaced)
            real_rename(replacement, source)
            real_rename(first, second)

        with mock.patch("os.rename", swap_before_path_rename):
            integrity_module.publish_directory_no_replace(
                source,
                target,
                self.restore_parent,
                integrity_module.directory_identity(source),
            )

        self.assertEqual(
            (target / "identity.txt").read_bytes(),
            b"verified-staging",
        )

    def test_sync_rollback_conflict_evacuates_published_target(self) -> None:
        source = self.restore_parent / ".sync-failure.restore-source"
        source.mkdir()
        (source / "identity.txt").write_bytes(b"verified-staging")
        target = self.restore_parent / "sync-failure-target"
        expected_identity = integrity_module.directory_identity(source)
        real_rename = integrity_module._rename_directory_no_replace
        calls = 0

        def conflict_on_preferred_rollback(*args: object, **kwargs: object) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise BackupStoreError("injected EEXIST rollback conflict")
            real_rename(*args, **kwargs)

        with (
            mock.patch.object(
                integrity_module,
                "_rename_directory_no_replace",
                conflict_on_preferred_rollback,
            ),
            mock.patch.object(
                integrity_module,
                "sync_directory",
                side_effect=BackupStoreError("injected sync failure"),
            ),
        ):
            with self.assertRaises(BackupStoreError):
                integrity_module.publish_directory_no_replace(
                    source,
                    target,
                    self.restore_parent,
                    expected_identity,
                )

        self.assertFalse(target.exists())
        quarantines = tuple(
            self.restore_parent.glob(".sync-failure-target.rollback-*")
        )
        self.assertEqual(len(quarantines), 1)
        self.assertEqual(
            (quarantines[0] / "identity.txt").read_bytes(),
            b"verified-staging",
        )

    def test_missing_or_corrupt_remote_object_never_publishes_target(self) -> None:
        entries = (
            self.manifest.input_archive,
            self.manifest.state_snapshot,
            *self.manifest.artifacts,
        )
        for index, entry in enumerate(entries):
            remote = self.remote_root.joinpath(*entry.key.parts)
            original = remote.read_bytes()
            remote.write_bytes(b"corrupt")
            target = self.restore_parent / f"corrupt-{index}"
            try:
                with self.subTest(key=str(entry.key)):
                    with self.assertRaises(RestoreError):
                        self.restorer.restore(
                            self.manifest_entry,
                            target,
                            self.restore_parent,
                            100,
                        )
                    self.assertFalse(target.exists())
                    self.assertEqual(self._temporary_restore_paths(), ())
            finally:
                remote.write_bytes(original)

        missing = self.remote_root.joinpath(*entries[-1].key.parts)
        missing_bytes = missing.read_bytes()
        missing.unlink()
        try:
            target = self.restore_parent / "missing-object"
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )
            self.assertFalse(target.exists())
        finally:
            missing.write_bytes(missing_bytes)

    def test_corrupt_manifest_never_creates_staging_or_target(self) -> None:
        remote = self.remote_root.joinpath(*self.manifest_entry.key.parts)
        original = remote.read_bytes()
        remote.write_bytes(b"not canonical manifest")
        target = self.restore_parent / "corrupt-manifest"
        try:
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )
            self.assertFalse(target.exists())
            self.assertEqual(self._temporary_restore_paths(), ())
        finally:
            remote.write_bytes(original)

    def test_canonical_forged_manifest_fails_trusted_digest(self) -> None:
        remote = self.remote_root.joinpath(*self.manifest_entry.key.parts)
        original = remote.read_bytes()
        forged = canonical_manifest_bytes(
            replace(self.manifest, checkpoint_id="forged-checkpoint")
        )
        remote.write_bytes(forged)
        target = self.restore_parent / "forged-manifest"
        try:
            with self.assertRaises(RestoreError):
                self.restorer.restore(
                    self.manifest_entry,
                    target,
                    self.restore_parent,
                    100,
                )
            self.assertFalse(target.exists())
            self.assertEqual(self._temporary_restore_paths(), ())
        finally:
            remote.write_bytes(original)

    def test_rejects_relative_target_or_different_staging_parent(self) -> None:
        with self.assertRaises(RestoreError):
            self.restorer.restore(
                self.manifest_entry,
                Path("relative"),
                self.restore_parent,
                100,
            )
        other = self.base / "other"
        other.mkdir()
        with self.assertRaises(RestoreError):
            self.restorer.restore(
                self.manifest_entry,
                self.restore_parent / "job",
                other,
                100,
            )

    def test_application_restore_depends_only_on_inward_ports_and_domain(self) -> None:
        source = Path(restore_module.__file__).read_text(encoding="utf-8")

        self.assertNotIn("ytb_vps_v2.adapters", source)


if __name__ == "__main__":
    unittest.main()
