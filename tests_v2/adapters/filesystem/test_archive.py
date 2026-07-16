from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ytb_vps_v2.adapters.filesystem import archive as archive_module
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.ports.backup import BackupStoreError


class VerifiedInputArchiverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.archive_root = self.base / "archive"
        self.archive_root.mkdir()
        self.source = self.base / "unsafe title.mp4"
        self.source.write_bytes(b"source-video-bytes")
        self.archiver = VerifiedInputArchiver(self.archive_root)

    def test_streams_digest_and_publishes_verified_content_addressed_archive(self) -> None:
        expected = digest_file(self.source)

        evidence = self.archiver.archive(
            self.source,
            JobId("job/identifier-is-not-a-path"),
            "2026-07-16T21:30:00+07:00",
        )

        destination = self.archive_root.joinpath(*evidence.archive.key.parts)
        self.assertEqual(evidence.source.digest, expected)
        self.assertEqual(evidence.source.name, self.source.name)
        self.assertEqual(evidence.archive.digest, expected)
        self.assertEqual(destination.read_bytes(), self.source.read_bytes())
        self.assertIn(expected.sha256, str(evidence.archive.key))
        self.assertEqual(evidence.archive.key.suffix, ".mp4")
        self.assertEqual(list(self.archive_root.rglob("*.part")), [])

    def test_matching_repeat_is_idempotent(self) -> None:
        first = self.archiver.archive(self.source, JobId("job-1"), "time-1")
        destination = self.archive_root.joinpath(*first.archive.key.parts)
        original_mtime = destination.stat().st_mtime_ns

        second = self.archiver.archive(self.source, JobId("job-2"), "time-2")

        self.assertEqual(second.archive, first.archive)
        self.assertEqual(destination.stat().st_mtime_ns, original_mtime)
        self.assertEqual(second.verified_at, "time-2")

    def test_matching_repeat_retries_directory_sync(self) -> None:
        self.archiver.archive(self.source, JobId("job-1"), "time-1")

        with mock.patch.object(archive_module, "sync_directory") as sync:
            self.archiver.archive(self.source, JobId("job-1"), "time-2")

        sync.assert_called_once()

    def test_conflicting_existing_archive_is_never_overwritten(self) -> None:
        evidence = self.archiver.archive(self.source, JobId("job"), "time")
        destination = self.archive_root.joinpath(*evidence.archive.key.parts)
        destination.write_bytes(b"conflict")

        with self.assertRaises(BackupStoreError):
            self.archiver.archive(self.source, JobId("job"), "later")

        self.assertEqual(destination.read_bytes(), b"conflict")

    def test_source_mutation_during_copy_fails_without_final_or_temp(self) -> None:
        real_copy = archive_module._copy_to_temp

        def copy_then_mutate(source: Path, temporary: Path) -> FileDigest:
            result = real_copy(source, temporary)
            source.write_bytes(b"changed-during-copy")
            return result

        with mock.patch.object(archive_module, "_copy_to_temp", copy_then_mutate):
            with self.assertRaises(BackupStoreError):
                self.archiver.archive(self.source, JobId("job"), "time")

        self.assertEqual(tuple(self.archive_root.rglob("*.part")), ())
        self.assertEqual(tuple(path for path in self.archive_root.rglob("*") if path.is_file()), ())

    def test_copy_failure_leaves_no_final_or_temp(self) -> None:
        with mock.patch.object(
            archive_module,
            "_copy_to_temp",
            side_effect=OSError("injected write failure"),
        ):
            with self.assertRaises(BackupStoreError):
                self.archiver.archive(self.source, JobId("job"), "time")

        self.assertEqual(tuple(path for path in self.archive_root.rglob("*") if path.is_file()), ())

    def test_rejects_invalid_paths_and_types(self) -> None:
        for source in (self.base / "missing.mp4", self.base, "source.mp4"):
            with self.subTest(source=source):
                with self.assertRaises(BackupStoreError):
                    self.archiver.archive(source, JobId("job"), "time")  # type: ignore[arg-type]
        with self.assertRaises(BackupStoreError):
            VerifiedInputArchiver(str(self.archive_root))  # type: ignore[arg-type]

    def test_rejects_symlink_source_when_supported(self) -> None:
        link = self.base / "source-link.mp4"
        try:
            link.symlink_to(self.source)
        except OSError:
            self.skipTest("symlinks are unavailable on this host")
        with self.assertRaises(BackupStoreError):
            self.archiver.archive(link, JobId("job"), "time")

    def test_sanitizes_untrusted_or_unsupported_suffix(self) -> None:
        source = self.base / "video.bad-suffix-too-long"
        source.write_bytes(b"video")

        evidence = self.archiver.archive(source, JobId("job"), "time")

        self.assertEqual(evidence.archive.key.suffix, ".bin")


if __name__ == "__main__":
    unittest.main()
