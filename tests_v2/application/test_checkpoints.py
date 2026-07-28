from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity
from ytb_vps_v2.adapters.sqlite.schema import StateStoreError
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.checkpoints import CheckpointError, CheckpointPublisher
from ytb_vps_v2.domain.backup import CheckpointManifest, FileDigest, ManifestEntry
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import Artifact, JobId, StageName, WorkUnit
from ytb_vps_v2.ports.backup import BackupStoreError


class RecordingStore:
    def __init__(
        self,
        delegate: LocalAdditiveObjectStore,
        fail_name: str | None = None,
    ) -> None:
        self.delegate = delegate
        self.fail_name = fail_name
        self.puts: list[PurePosixPath] = []
        self.verifies: list[PurePosixPath] = []

    def put(
        self, source: Path, key: PurePosixPath, expected: FileDigest
    ) -> ManifestEntry:
        self.puts.append(key)
        if self.fail_name is not None and self.fail_name in str(key):
            raise BackupStoreError("injected additive-store failure")
        return self.delegate.put(source, key, expected)

    def read_bytes(self, key: PurePosixPath, max_bytes: int) -> bytes:
        return self.delegate.read_bytes(key, max_bytes)

    def verify(self, key, expected, observed_at, method):
        self.verifies.append(key)
        return self.delegate.verify(key, expected, observed_at, method)


class CheckpointPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.workspace = self.base / "workspace"
        self.archive_root = self.base / "archive"
        self.remote_root = self.base / "remote"
        self.snapshot_root = self.base / "snapshots"
        self.state_root = self.base / "state"
        for directory in (
            self.workspace,
            self.archive_root,
            self.remote_root,
            self.snapshot_root,
            self.state_root,
        ):
            directory.mkdir()

        self.source = self.base / "source.mp4"
        self.source.write_bytes(b"source-video")
        self.job_id = JobId("job/unsafe-as-path")
        self.archive = VerifiedInputArchiver(self.archive_root).archive(
            self.source, self.job_id, "verified"
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
        artifact_path.write_bytes(b'{"ocr":"result"}')
        artifact_digest = digest_file(artifact_path)
        self.artifact = Artifact(
            "ocr-result",
            PurePosixPath("artifacts/ocr.json"),
            artifact_digest.size_bytes,
            artifact_digest.sha256,
            StageName.OCR,
        )
        self.state.put_work_unit(
            self.job_id, WorkUnit("ocr:1", StageName.OCR), "planned"
        )
        self.state.start_work_unit(self.job_id, "ocr:1", "started")
        self.state.commit_artifact(
            self.job_id, "ocr:1", self.artifact, "committed"
        )

        self.local_store = LocalAdditiveObjectStore(self.remote_root)
        self.files = LocalFileIntegrity()
        self.recording_store = RecordingStore(self.local_store)
        self.publisher = CheckpointPublisher(
            self.state,
            self.recording_store,
            self.archive_root,
            self.files,
        )

    def _publish(
        self,
        checkpoint_id: str = "checkpoint/unsafe",
        verification_observed_at: int | None = None,
        reuse: CheckpointManifest | None = None,
    ):
        return self.publisher.publish(
            self.job_id,
            checkpoint_id,
            self.workspace,
            self.snapshot_root,
            "2026-07-16T22:00:00+07:00",
            verification_observed_at=verification_observed_at,
            reuse=reuse,
        )

    def _commit_chunk(self, index: int, raw: bytes) -> Artifact:
        relative_path = PurePosixPath(
            f"artifacts/render/chunks/chunk-{index:06d}.mp4"
        )
        path = self.workspace.joinpath(*relative_path.parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        digest = digest_file(path)
        artifact = Artifact(
            f"render-chunk-{index:06d}",
            relative_path,
            digest.size_bytes,
            digest.sha256,
            StageName.RENDER,
        )
        key = f"render:{index:06d}"
        self.state.put_work_unit(
            self.job_id,
            WorkUnit(key, StageName.RENDER),
            "planned",
        )
        self.state.start_work_unit(self.job_id, key, "started")
        self.state.commit_artifact(
            self.job_id,
            key,
            artifact,
            "committed",
        )
        return artifact

    def test_publishes_verified_data_then_canonical_manifest_and_records_completion(self) -> None:
        manifest = self._publish()

        self.assertEqual(manifest.job_id, self.job_id)
        self.assertEqual(manifest.source, self.archive.source)
        self.assertEqual(len(manifest.artifacts), 1)
        self.assertEqual(self.recording_store.puts[-1].name, "manifest-v2.json")
        self.assertTrue(all("job/" not in str(key) for key in self.recording_store.puts))
        records = self.state.completed_checkpoints(self.job_id)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].manifest.key, self.recording_store.puts[-1])
        for item in (
            manifest.input_archive,
            manifest.state_snapshot,
            *manifest.artifacts,
        ):
            path = self.remote_root.joinpath(*item.key.parts)
            self.assertEqual(digest_file(path), item.digest)

    def test_v2_stable_keys_reuse_verified_chunks_without_duplicate_puts(
        self,
    ) -> None:
        chunk_zero = self._commit_chunk(0, b"chunk-zero")
        first = self._publish(
            "render-chunk-000000-token",
            verification_observed_at=100,
        )
        chunk_one = self._commit_chunk(1, b"chunk-one")
        self.recording_store.verifies.clear()
        second = self._publish(
            "render-chunk-000001-token",
            verification_observed_at=101,
            reuse=first,
        )

        token = hashlib.sha256(self.job_id.value.encode("utf-8")).hexdigest()[:20]
        expected_input = (
            PurePosixPath("objects")
            / token
            / "input"
            / self.archive.source.digest.sha256
        )
        self.assertEqual(first.version, 2)
        self.assertEqual(second.version, 2)
        self.assertEqual(first.input_archive.key, expected_input)
        by_suffix = {
            entry.key.name: entry
            for entry in second.artifacts
        }
        zero_entry = by_suffix[chunk_zero.sha256]
        one_entry = by_suffix[chunk_one.sha256]
        self.assertEqual(
            self.recording_store.puts.count(zero_entry.key),
            1,
        )
        self.assertEqual(
            self.recording_store.puts.count(one_entry.key),
            1,
        )
        self.assertEqual(
            self.recording_store.puts.count(expected_input),
            1,
        )
        self.assertNotEqual(
            first.state_snapshot.key,
            second.state_snapshot.key,
        )
        records = {
            item.checkpoint_id: item
            for item in self.state.completed_checkpoints(self.job_id)
        }
        self.assertNotEqual(
            records[first.checkpoint_id].manifest.key,
            records[second.checkpoint_id].manifest.key,
        )
        self.assertIn(zero_entry, second.artifacts)
        self.assertIn(one_entry, second.artifacts)
        self.assertIn(zero_entry.key, self.recording_store.verifies)
        self.assertEqual(
            self.publisher.latest_verified_v2(
                self.job_id,
                "render-chunk-",
                102,
            ),
            second,
        )
        self.remote_root.joinpath(*one_entry.key.parts).write_bytes(b"corrupt")
        self.assertEqual(
            self.publisher.latest_verified_v2(
                self.job_id,
                "render-chunk-",
                103,
            ),
            first,
        )

    def test_completed_publish_is_idempotent_and_rejects_corrupt_manifest_readback(self) -> None:
        first = self._publish("cp-idempotent")
        self.recording_store.puts.clear()

        second = self._publish("cp-idempotent")

        self.assertEqual(second, first)
        self.assertEqual(self.recording_store.puts, [])
        record = self.state.completed_checkpoints(self.job_id)[0]
        manifest_path = self.remote_root.joinpath(*record.manifest.key.parts)
        manifest_path.write_bytes(b"corrupt")
        with self.assertRaises(CheckpointError):
            self._publish("cp-idempotent")

    def test_completed_publish_rejects_corrupt_artifact_instead_of_reusing(self) -> None:
        first = self._publish("cp-corrupt-artifact", verification_observed_at=100)
        artifact_path = self.remote_root.joinpath(
            *first.artifacts[0].key.parts
        )
        artifact_path.write_bytes(b"corrupt artifact")

        with self.assertRaises(CheckpointError):
            self._publish("cp-corrupt-artifact", verification_observed_at=100)

    def test_missing_or_mutated_artifact_publishes_no_manifest_or_record(self) -> None:
        artifact_path = self.workspace.joinpath(*self.artifact.relative_path.parts)
        artifact_path.write_bytes(b"mutated")

        with self.assertRaisesRegex(CheckpointError, "artifact"):
            self._publish("cp-mutated")

        self.assertEqual(self.state.completed_checkpoints(self.job_id), ())
        self.assertEqual(tuple(self.remote_root.rglob("manifest-v2.json")), ())

    def test_data_store_failure_is_retryable_and_manifest_remains_last(self) -> None:
        failing = RecordingStore(self.local_store, fail_name="workspace")
        publisher = CheckpointPublisher(
            self.state, failing, self.archive_root, self.files
        )

        with self.assertRaises(CheckpointError):
            publisher.publish(
                self.job_id,
                "cp-data-failure",
                self.workspace,
                self.snapshot_root,
                "same-time",
            )

        self.assertEqual(self.state.completed_checkpoints(self.job_id), ())
        self.assertEqual(tuple(self.remote_root.rglob("manifest-v2.json")), ())
        retry = CheckpointPublisher(
            self.state, self.local_store, self.archive_root, self.files
        )
        manifest = retry.publish(
            self.job_id,
            "cp-data-failure",
            self.workspace,
            self.snapshot_root,
            "same-time",
        )
        self.assertEqual(manifest.checkpoint_id, "cp-data-failure")

    def test_manifest_store_and_state_record_failures_are_retryable(self) -> None:
        failing = RecordingStore(self.local_store, fail_name="manifest-v2.json")
        with self.assertRaises(CheckpointError):
            CheckpointPublisher(
                self.state, failing, self.archive_root, self.files
            ).publish(
                self.job_id,
                "cp-manifest-failure",
                self.workspace,
                self.snapshot_root,
                "same-time",
            )
        self.assertEqual(self.state.completed_checkpoints(self.job_id), ())
        self.assertEqual(tuple(self.remote_root.rglob("manifest-v2.json")), ())

        with mock.patch.object(
            self.state,
            "record_checkpoint",
            side_effect=StateStoreError("injected record failure"),
        ):
            with self.assertRaises(CheckpointError):
                CheckpointPublisher(
                    self.state, self.local_store, self.archive_root, self.files
                ).publish(
                    self.job_id,
                    "cp-record-failure",
                    self.workspace,
                    self.snapshot_root,
                    "time-1",
                )
        self.assertEqual(self.state.completed_checkpoints(self.job_id), ())
        manifest = CheckpointPublisher(
            self.state, self.local_store, self.archive_root, self.files
        ).publish(
            self.job_id,
            "cp-record-failure",
            self.workspace,
            self.snapshot_root,
            "time-2",
        )
        self.assertEqual(manifest.checkpoint_id, "cp-record-failure")
        self.assertEqual(manifest.created_at, "time-1")

    def test_missing_input_or_snapshot_failure_records_nothing(self) -> None:
        other = JobId("job-without-input")
        self.state.create_job(
            other,
            Fingerprint("f" * 64),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )
        with self.assertRaisesRegex(CheckpointError, "verified input"):
            self.publisher.publish(
                other,
                "cp",
                self.workspace,
                self.snapshot_root,
                "time",
            )

        with mock.patch.object(
            self.state,
            "create_snapshot",
            side_effect=StateStoreError("injected snapshot failure"),
        ):
            with self.assertRaises(CheckpointError):
                self._publish("cp-snapshot-failure")
        self.assertEqual(self.state.completed_checkpoints(self.job_id), ())
        self.assertEqual(tuple(self.remote_root.rglob("manifest-v2.json")), ())


if __name__ == "__main__":
    unittest.main()
