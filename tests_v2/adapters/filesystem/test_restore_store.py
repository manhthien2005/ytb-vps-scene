from __future__ import annotations

import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

from ytb_vps_v2.adapters.filesystem import additive as additive_module
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.ports.backup import BackupStoreError


class RestoreObjectStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "store"
        self.root.mkdir()
        self.staging = self.base / "staging"
        self.staging.mkdir()
        self.source = self.base / "source.bin"
        self.source.write_bytes(b"verified-remote-object")
        self.expected = digest_file(self.source)
        self.key = PurePosixPath("checkpoints/job-1/object.bin")
        self.store = LocalAdditiveObjectStore(self.root)
        self.store.put(self.source, self.key, self.expected)

    def test_verify_rereads_remote_bytes_on_every_call(self) -> None:
        first = self.store.verify(self.key, self.expected, 100, "sha256-readback")
        remote = self.root.joinpath(*self.key.parts)
        remote.write_bytes(b"corrupt-after-first-proof")

        self.assertEqual(first.observed_at, 100)
        self.assertEqual(first.method, "sha256-readback")
        with self.assertRaises(BackupStoreError):
            self.store.verify(self.key, self.expected, 101, "sha256-readback")

    def test_verify_rejects_missing_object_and_invalid_arguments(self) -> None:
        with self.assertRaises(BackupStoreError):
            self.store.verify(
                PurePosixPath("missing.bin"),
                self.expected,
                1,
                "sha256-readback",
            )
        for observed_at in (True, -1):
            with self.subTest(observed_at=observed_at):
                with self.assertRaises(BackupStoreError):
                    self.store.verify(
                        self.key,
                        self.expected,
                        observed_at,  # type: ignore[arg-type]
                        "sha256-readback",
                    )

    def test_materialize_uses_verified_no_replace_publication(self) -> None:
        destination = self.staging / "state.sqlite"

        result = self.store.materialize(self.key, destination, self.expected)

        self.assertEqual(result.key, self.key)
        self.assertEqual(result.digest, self.expected)
        self.assertEqual(destination.read_bytes(), self.source.read_bytes())
        self.assertEqual(tuple(self.staging.glob("*.part")), ())

    def test_matching_destination_is_idempotent_but_conflict_is_unchanged(self) -> None:
        destination = self.staging / "object.bin"
        self.store.materialize(self.key, destination, self.expected)
        original_mtime = destination.stat().st_mtime_ns

        self.store.materialize(self.key, destination, self.expected)
        self.assertEqual(destination.stat().st_mtime_ns, original_mtime)

        conflict = self.staging / "conflict.bin"
        conflict.write_bytes(b"local-conflict")
        with self.assertRaises(BackupStoreError):
            self.store.materialize(self.key, conflict, self.expected)
        self.assertEqual(conflict.read_bytes(), b"local-conflict")

    def test_remote_mutation_during_copy_fails_without_final_or_temp(self) -> None:
        remote = self.root.joinpath(*self.key.parts)
        real_copy = additive_module._copy_to_temp

        def copy_then_mutate(source: Path, temporary: Path) -> FileDigest:
            result = real_copy(source, temporary)
            remote.write_bytes(b"changed-during-materialization")
            return result

        destination = self.staging / "object.bin"
        with mock.patch.object(additive_module, "_copy_to_temp", copy_then_mutate):
            with self.assertRaises(BackupStoreError):
                self.store.materialize(self.key, destination, self.expected)

        self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.staging.glob("*.part")), ())

    def test_copy_and_publish_failures_leave_no_final_or_temp(self) -> None:
        destination = self.staging / "object.bin"
        for patched, failure in (
            ("_copy_to_temp", OSError("injected copy failure")),
            ("publish_additively", BackupStoreError("injected publish failure")),
        ):
            with self.subTest(patched=patched):
                with mock.patch.object(additive_module, patched, side_effect=failure):
                    with self.assertRaises(BackupStoreError):
                        self.store.materialize(self.key, destination, self.expected)
                self.assertFalse(destination.exists())
                self.assertEqual(tuple(self.staging.glob("*.part")), ())

    def test_materialize_rejects_unsafe_destination_and_invalid_types(self) -> None:
        with self.assertRaises(BackupStoreError):
            self.store.materialize(
                self.key,
                self.staging / "missing" / "object.bin",
                self.expected,
            )
        with self.assertRaises(BackupStoreError):
            self.store.materialize(
                self.key,
                str(self.staging / "object.bin"),  # type: ignore[arg-type]
                self.expected,
            )


if __name__ == "__main__":
    unittest.main()
