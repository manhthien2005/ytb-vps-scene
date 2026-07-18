from __future__ import annotations

import hashlib
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
from ytb_vps_v2.ports.backup import BackupStoreError
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
        observed: list[tuple[Path, str]] = []
        real_write = artifacts_module._write_bytes_to_temp

        def observe(
            temporary: artifacts_module._OwnedTemporary,
            raw: bytes,
        ) -> FileDigest:
            observed.append((temporary.parent.parent, temporary.name))
            return real_write(temporary, raw)

        with mock.patch.object(
            artifacts_module,
            "_write_bytes_to_temp",
            observe,
        ), mock.patch.object(
            artifacts_module.os, "fsync", wraps=artifacts_module.os.fsync
        ) as fsync:
            self.writer.write_bytes(self.key, b"payload")

        self.assertEqual(len(observed), 1)
        parent, name = observed[0]
        self.assertEqual(parent, self.destination().parent)
        self.assertTrue(name.startswith(f".{self.destination().name}."))
        self.assertTrue(name.endswith(".part"))
        self.assertGreaterEqual(fsync.call_count, 1)
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

    def test_matching_write_file_rechecks_source_after_destination_verification(self) -> None:
        source = self.base / "source.bin"
        source.write_bytes(b"stable")
        self.writer.write_bytes(self.key, b"stable")
        real_digest_destination = (
            artifacts_module._AnchoredArtifactParent.digest_destination
        )

        def verify_then_mutate(
            anchored: artifacts_module._AnchoredArtifactParent,
        ) -> FileDigest | None:
            result = real_digest_destination(anchored)
            source.write_bytes(b"changed")
            return result

        with mock.patch.object(
            artifacts_module._AnchoredArtifactParent,
            "digest_destination",
            verify_then_mutate,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_file(self.key, source)

        self.assertEqual(self.destination().read_bytes(), b"stable")
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

    def test_parent_swap_after_validation_never_touches_outside_workspace(self) -> None:
        outside = self.base / "outside"
        outside.mkdir()
        displaced = self.base / "displaced-parent"
        opened_outside: list[Path] = []
        unlinked_outside: list[Path] = []
        real_validated_destination = artifacts_module._validated_destination
        real_open = Path.open
        real_unlink = Path.unlink

        def redirect(directory: Path) -> None:
            if artifacts_module.os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(outside), str(directory))
            else:
                directory.symlink_to(outside, target_is_directory=True)

        def destination_then_swap(
            root: Path,
            key: PurePosixPath,
            expected: FileDigest,
        ) -> Path:
            destination = real_validated_destination(root, key, expected)
            destination.parent.mkdir(parents=True)
            destination.parent.rename(displaced)
            redirect(destination.parent)
            return destination

        def observe_open(path: Path, *args: object, **kwargs: object):
            resolved = path.resolve(strict=False)
            if outside in (resolved, *resolved.parents):
                opened_outside.append(resolved)
            return real_open(path, *args, **kwargs)

        def observe_unlink(path: Path, *args: object, **kwargs: object):
            resolved = path.resolve(strict=False)
            if outside in (resolved, *resolved.parents):
                unlinked_outside.append(resolved)
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(
            artifacts_module,
            "_validated_destination",
            destination_then_swap,
        ), mock.patch.object(Path, "open", observe_open), mock.patch.object(
            Path,
            "unlink",
            observe_unlink,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"blocked")

        self.assertEqual(opened_outside, [])
        self.assertEqual(unlinked_outside, [])
        self.assertEqual(tuple(outside.iterdir()), ())

    def test_faults_never_leave_temporary_or_false_final_files(self) -> None:
        failures = (
            ("_write_bytes_to_temp", OSError("injected write failure")),
        )
        for patched, failure in failures:
            with self.subTest(patched=patched):
                with mock.patch.object(artifacts_module, patched, side_effect=failure):
                    with self.assertRaises(ArtifactWriteError):
                        self.writer.write_bytes(self.key, b"payload")
                self.assertFalse(self.destination().exists())
                self.assert_no_parts()

        with mock.patch.object(
            artifacts_module._AnchoredArtifactParent,
            "publish",
            side_effect=ArtifactWriteError("injected rename failure"),
        ):
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

    def test_temp_cleanup_only_removes_the_identity_owned_by_the_call(self) -> None:
        real_write = artifacts_module._write_bytes_to_temp
        replacement: list[Path] = []
        rename_blocked: list[bool] = []

        def replace_after_write(
            temporary: artifacts_module._OwnedTemporary,
            raw: bytes,
        ) -> FileDigest:
            result = real_write(temporary, raw)
            path = temporary.parent.parent / temporary.name
            displaced = path.with_name(f"{path.name}.displaced")
            try:
                path.rename(displaced)
            except OSError:
                rename_blocked.append(True)
            else:
                path.write_bytes(b"not-owned")
                replacement.append(path)
            raise OSError("injected failure after temp replacement attempt")

        with mock.patch.object(
            artifacts_module,
            "_write_bytes_to_temp",
            replace_after_write,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"payload")

        if artifacts_module.os.name == "nt":
            self.assertEqual(rename_blocked, [True])
            self.assertEqual(replacement, [])
            self.assert_no_parts()
        else:
            self.assertEqual(rename_blocked, [])
            self.assertEqual(len(replacement), 1)
            self.assertEqual(replacement[0].read_bytes(), b"not-owned")
            replacement[0].unlink()
            replacement[0].with_name(
                f"{replacement[0].name}.displaced"
            ).unlink()

    @unittest.skipUnless(
        artifacts_module.os.name == "nt",
        "Windows pinned-handle flush coverage",
    )
    def test_windows_flushes_intermediate_and_publication_parent_handles(self) -> None:
        real_flush = artifacts_module._flush_windows_directory_handle
        with mock.patch.object(
            artifacts_module,
            "_flush_windows_directory_handle",
            wraps=real_flush,
        ) as flush:
            self.writer.write_bytes(self.key, b"payload")

        self.assertGreaterEqual(flush.call_count, 3)

    def test_sync_and_readback_failures_roll_back_new_publication(self) -> None:
        with mock.patch.object(
            artifacts_module._AnchoredArtifactParent,
            "sync_parent",
            side_effect=BackupStoreError("injected sync failure"),
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"payload")
        self.assertFalse(self.destination().exists())
        self.assert_no_parts()

        calls = 0
        real_digest = artifacts_module._AnchoredArtifactParent.digest_destination

        def fail_readback(
            anchored: artifacts_module._AnchoredArtifactParent,
            *,
            share_delete: bool = False,
        ) -> FileDigest | None:
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_digest(anchored, share_delete=share_delete)
            raise BackupStoreError("injected read-back failure")

        with mock.patch.object(
            artifacts_module._AnchoredArtifactParent,
            "digest_destination",
            fail_readback,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"payload")
        self.assertFalse(self.destination().exists())
        self.assert_no_parts()

    @unittest.skipUnless(
        artifacts_module.os.name == "nt",
        "Windows strict directory-flush regression",
    )
    def test_windows_directory_flush_failure_never_reports_success(self) -> None:
        with mock.patch.object(
            artifacts_module,
            "_flush_windows_directory_handle",
            side_effect=BackupStoreError("injected Windows directory flush failure"),
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.write_bytes(self.key, b"payload")

        self.assertFalse(self.destination().exists())
        self.assert_no_parts()

    def test_verify_independently_rereads_and_rejects_corruption(self) -> None:
        entry = self.writer.write_bytes(self.key, b"original")
        self.destination().write_bytes(b"corrupted")

        with self.assertRaises(ArtifactWriteError):
            self.writer.verify(self.key, entry.digest)

    def test_read_verified_bytes_is_bounded_and_exact(self) -> None:
        entry = self.writer.write_bytes(self.key, b"canonical")

        self.assertEqual(
            self.writer.read_verified_bytes(self.key, entry.digest, 64),
            b"canonical",
        )
        with self.assertRaises(ArtifactWriteError):
            self.writer.read_verified_bytes(self.key, entry.digest, 4)

    @unittest.skipIf(
        artifacts_module.os.name == "nt",
        "POSIX anchored entry-swap regression",
    )
    def test_posix_read_verified_bytes_rejects_entry_swap_after_read(self) -> None:
        entry = self.writer.write_bytes(self.key, b"canonical")
        displaced = self.destination().with_name("displaced.json")
        real_read = artifacts_module._read_bounded_and_digest

        def read_then_swap(reader, max_bytes):
            result = real_read(reader, max_bytes)
            self.destination().rename(displaced)
            self.destination().write_bytes(b"canonical")
            return result

        with mock.patch.object(
            artifacts_module,
            "_read_bounded_and_digest",
            read_then_swap,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.read_verified_bytes(self.key, entry.digest, 64)

    @unittest.skipUnless(
        artifacts_module.os.name == "nt",
        "Windows injected pinned-read regression",
    )
    def test_windows_read_verified_bytes_rechecks_pinned_entry_identity(self) -> None:
        entry = self.writer.write_bytes(self.key, b"canonical")
        with mock.patch.object(
            artifacts_module._AnchoredArtifactParent,
            "_recheck_destination_identity",
            side_effect=BackupStoreError("injected entry replacement"),
            create=True,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.read_verified_bytes(self.key, entry.digest, 64)

    @unittest.skipUnless(
        artifacts_module.os.name == "nt",
        "Windows pinned-handle replacement regression",
    )
    def test_windows_read_verified_bytes_pins_entry_against_replacement(self) -> None:
        entry = self.writer.write_bytes(self.key, b"canonical")
        displaced = self.destination().with_name("displaced.json")
        real_read = artifacts_module._read_bounded_and_digest
        replacement_blocked = False

        def read_while_replacement_is_attempted(reader, max_bytes):
            nonlocal replacement_blocked
            with self.assertRaises(OSError):
                self.destination().rename(displaced)
            replacement_blocked = True
            return real_read(reader, max_bytes)

        with mock.patch.object(
            artifacts_module,
            "_read_bounded_and_digest",
            read_while_replacement_is_attempted,
        ):
            raw = self.writer.read_verified_bytes(self.key, entry.digest, 64)

        self.assertTrue(replacement_blocked)
        self.assertEqual(raw, b"canonical")
        self.assertFalse(displaced.exists())

    def test_verify_missing_artifact_fails_without_creating_parent_paths(self) -> None:
        key = PurePosixPath("missing/deep/artifact.bin")
        expected = FileDigest(0, hashlib.sha256(b"").hexdigest())

        with self.assertRaises(ArtifactWriteError):
            self.writer.verify(key, expected)

        self.assertFalse((self.root / "missing").exists())

    def test_verify_parent_swap_cannot_certify_outside_file(self) -> None:
        entry = self.writer.write_bytes(self.key, b"trusted")
        outside = self.base / "verify-outside"
        outside.mkdir()
        (outside / self.destination().name).write_bytes(b"trusted")
        displaced = self.base / "verify-displaced-parent"
        swapped: list[bool] = []
        regular_calls = 0
        real_regular_file = integrity_module.regular_file
        real_validated_destination = artifacts_module._validated_destination

        def swap_parent() -> None:
            if swapped:
                return
            self.destination().parent.rename(displaced)
            if artifacts_module.os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(outside), str(self.destination().parent))
            else:
                self.destination().parent.symlink_to(
                    outside,
                    target_is_directory=True,
                )
            swapped.append(True)

        def regular_then_swap(path: Path) -> Path:
            nonlocal regular_calls
            result = real_regular_file(path)
            if path == self.destination():
                regular_calls += 1
                if regular_calls == 2:
                    swap_parent()
            return result

        def validate_then_swap(
            root: Path,
            key: PurePosixPath,
            expected: FileDigest,
        ) -> Path:
            destination = real_validated_destination(root, key, expected)
            swap_parent()
            return destination

        with mock.patch.object(
            integrity_module,
            "regular_file",
            regular_then_swap,
        ), mock.patch.object(
            artifacts_module,
            "_validated_destination",
            validate_then_swap,
        ):
            with self.assertRaises(ArtifactWriteError):
                self.writer.verify(self.key, entry.digest)

        self.assertEqual(swapped, [True])
        self.assertEqual((outside / self.destination().name).read_bytes(), b"trusted")


if __name__ == "__main__":
    unittest.main()
