from __future__ import annotations

import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

from ytb_vps_v2.adapters.filesystem import artifacts as artifacts_module
from ytb_vps_v2.adapters.filesystem import integrity as integrity_module
from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.ports.pipeline import ArtifactWriteError


class LocalArtifactWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.writer = LocalArtifactWriter(self.root)
        self.key = PurePosixPath("artifacts/ocr/ocr.json")

    def destination(self) -> Path:
        return self.root.joinpath(*self.key.parts)

    def assert_no_parts(self) -> None:
        self.assertEqual(tuple(self.root.rglob("*.part")), ())

    def test_write_bytes_publishes_exact_durable_bytes_and_verifies_readback(self) -> None:
        raw = b'{"canonical":true}'

        entry = self.writer.write_bytes(self.key, raw)

        self.assertEqual(self.destination().read_bytes(), raw)
        self.assertEqual(entry.digest, digest_file(self.destination()))
        self.assertEqual(self.writer.verify(self.key, entry.digest), entry)
        self.assert_no_parts()

    def test_write_uses_exclusive_same_directory_part_and_syncs(self) -> None:
        observed: list[Path] = []
        real_write = artifacts_module._write_bytes_to_temp

        def observe(path: Path, raw: bytes) -> FileDigest:
            observed.append(path)
            return real_write(path, raw)

        with mock.patch.object(
            artifacts_module,
            "_write_bytes_to_temp",
            observe,
        ), mock.patch.object(
            artifacts_module.os, "fsync", wraps=artifacts_module.os.fsync
        ) as fsync, mock.patch.object(
            integrity_module,
            "sync_directory",
            wraps=integrity_module.sync_directory,
        ) as sync_parent:
            self.writer.write_bytes(self.key, b"payload")

        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0].parent, self.destination().parent)
        self.assertTrue(observed[0].name.startswith(f".{self.destination().name}."))
        self.assertTrue(observed[0].name.endswith(".part"))
        self.assertGreaterEqual(fsync.call_count, 1)
        sync_parent.assert_called_once_with(self.destination().parent)
        self.assert_no_parts()

    def test_write_file_streams_exact_bytes_and_rejects_source_mutation(self) -> None:
        source = self.base / "render.mp4"
        source.write_bytes(b"render-bytes")
        expected = digest_file(source)

        entry = self.writer.write_file(self.key, source)

        self.assertEqual(entry.digest, expected)
        self.assertEqual(self.destination().read_bytes(), b"render-bytes")

        other_key = PurePosixPath("artifacts/render/mutated.mp4")
        real_copy = artifacts_module._copy_to_temp

        def copy_then_mutate(first: Path, second: Path) -> FileDigest:
            result = real_copy(first, second)
            first.write_bytes(b"changed")
            return result

        with mock.patch.object(artifacts_module, "_copy_to_temp", copy_then_mutate):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_file(other_key, source)
        self.assertFalse(self.root.joinpath(*other_key.parts).exists())
        self.assert_no_parts()

    def test_matching_destination_is_idempotent_and_conflict_is_unchanged(self) -> None:
        raw = b"stable"
        first = self.writer.write_bytes(self.key, raw)
        original_mtime = self.destination().stat().st_mtime_ns

        second = self.writer.write_bytes(self.key, raw)

        self.assertEqual(second, first)
        self.assertEqual(self.destination().stat().st_mtime_ns, original_mtime)
        self.destination().write_bytes(b"conflict")
        with self.assertRaises(ArtifactWriteError):
            self.writer.write_bytes(self.key, raw)
        self.assertEqual(self.destination().read_bytes(), b"conflict")
        self.assert_no_parts()

    def test_rejects_unsafe_keys_roots_and_reparse_components(self) -> None:
        with self.assertRaises(ArtifactWriteError):
            self.writer.write_bytes(PurePosixPath("../escape.json"), b"escape")
        with self.assertRaises(ArtifactWriteError):
            LocalArtifactWriter(str(self.root))  # type: ignore[arg-type]

        path_type = type(self.root)
        with mock.patch.object(
            path_type,
            "is_junction",
            return_value=True,
            create=not hasattr(path_type, "is_junction"),
        ):
            with self.assertRaises(ArtifactWriteError):
                LocalArtifactWriter(self.root)

    def test_rejects_symlink_destination_parent_when_supported(self) -> None:
        outside = self.base / "outside"
        outside.mkdir()
        linked = self.root / "artifacts"
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("directory symlinks are unavailable on this host")

        with self.assertRaises(ArtifactWriteError):
            self.writer.write_bytes(self.key, b"blocked")
        self.assertEqual(tuple(outside.rglob("*")), ())

    def test_faults_never_leave_temporary_or_false_final_files(self) -> None:
        failures = (
            ("_write_bytes_to_temp", OSError("injected write failure")),
            ("publish_additively", ArtifactWriteError("injected rename failure")),
        )
        for patched, failure in failures:
            with self.subTest(patched=patched):
                with mock.patch.object(artifacts_module, patched, side_effect=failure):
                    with self.assertRaises(ArtifactWriteError):
                        self.writer.write_bytes(self.key, b"payload")
                self.assertFalse(self.destination().exists())
                self.assert_no_parts()

    def test_exclusive_temp_collision_never_deletes_unowned_file(self) -> None:
        destination = self.destination()
        destination.parent.mkdir(parents=True)
        token = "1" * 32
        collision = destination.with_name(f".{destination.name}.{token}.part")
        collision.write_bytes(b"unowned")

        with mock.patch.object(
            artifacts_module.uuid,
            "uuid4",
            return_value=types.SimpleNamespace(hex=token),
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"payload")

        self.assertEqual(collision.read_bytes(), b"unowned")
        self.assertFalse(destination.exists())

    def test_sync_and_readback_failures_roll_back_new_publication(self) -> None:
        for patched in ("sync_directory", "digest_file"):
            with self.subTest(patched=patched):
                failure = ArtifactWriteError(f"injected {patched} failure")
                with mock.patch.object(integrity_module, patched, side_effect=failure):
                    with self.assertRaises(ArtifactWriteError):
                        self.writer.write_bytes(self.key, b"payload")
                self.assertFalse(self.destination().exists())
                self.assert_no_parts()

    def test_verify_independently_rereads_and_rejects_corruption(self) -> None:
        entry = self.writer.write_bytes(self.key, b"original")
        self.destination().write_bytes(b"corrupted")

        with self.assertRaises(ArtifactWriteError):
            self.writer.verify(self.key, entry.digest)


if __name__ == "__main__":
    unittest.main()
