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


class LocalAdditiveObjectStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "store"
        self.root.mkdir()
        self.source = self.base / "artifact.bin"
        self.source.write_bytes(b"artifact-bytes")
        self.expected = digest_file(self.source)
        self.store = LocalAdditiveObjectStore(self.root)
        self.key = PurePosixPath("checkpoints/job-1/artifact.bin")

    def test_puts_and_verifies_new_object(self) -> None:
        result = self.store.put(self.source, self.key, self.expected)

        destination = self.root.joinpath(*self.key.parts)
        self.assertEqual(result.key, self.key)
        self.assertEqual(result.digest, self.expected)
        self.assertEqual(destination.read_bytes(), self.source.read_bytes())
        self.assertEqual(tuple(self.root.rglob("*.part")), ())

    def test_matching_existing_object_is_reused_without_replacement(self) -> None:
        self.store.put(self.source, self.key, self.expected)
        destination = self.root.joinpath(*self.key.parts)
        original_mtime = destination.stat().st_mtime_ns

        result = self.store.put(self.source, self.key, self.expected)

        self.assertEqual(result.digest, self.expected)
        self.assertEqual(destination.stat().st_mtime_ns, original_mtime)

    def test_conflicting_existing_object_is_never_overwritten(self) -> None:
        destination = self.root.joinpath(*self.key.parts)
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"remote-conflict")

        with self.assertRaises(BackupStoreError):
            self.store.put(self.source, self.key, self.expected)

        self.assertEqual(destination.read_bytes(), b"remote-conflict")

    def test_rejects_source_digest_mismatch(self) -> None:
        wrong = FileDigest(self.expected.size_bytes, "f" * 64)
        with self.assertRaises(BackupStoreError):
            self.store.put(self.source, self.key, wrong)
        self.assertEqual(tuple(path for path in self.root.rglob("*") if path.is_file()), ())

    def test_rejects_unsafe_key_and_invalid_root_type(self) -> None:
        with self.assertRaises(BackupStoreError):
            self.store.put(
                self.source,
                PurePosixPath("../escape.bin"),
                self.expected,
            )
        with self.assertRaises(BackupStoreError):
            LocalAdditiveObjectStore(str(self.root))  # type: ignore[arg-type]

    def test_copy_failure_leaves_no_final_or_temp(self) -> None:
        with mock.patch.object(
            additive_module,
            "_copy_to_temp",
            side_effect=OSError("injected read failure"),
        ):
            with self.assertRaises(BackupStoreError):
                self.store.put(self.source, self.key, self.expected)

        self.assertEqual(tuple(path for path in self.root.rglob("*") if path.is_file()), ())

    def test_contract_exposes_no_delete_or_replace_operation(self) -> None:
        self.assertFalse(hasattr(self.store, "delete"))
        self.assertFalse(hasattr(self.store, "replace"))

    def test_reads_small_objects_with_an_explicit_size_bound(self) -> None:
        self.store.put(self.source, self.key, self.expected)

        self.assertEqual(self.store.read_bytes(self.key, 1024), b"artifact-bytes")
        with self.assertRaises(BackupStoreError):
            self.store.read_bytes(self.key, 3)
        with self.assertRaises(BackupStoreError):
            self.store.read_bytes(PurePosixPath("missing.json"), 1024)
        with self.assertRaises(BackupStoreError):
            self.store.read_bytes(PurePosixPath("../escape.json"), 1024)


if __name__ == "__main__":
    unittest.main()
