from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ytb_vps_v2.adapters.filesystem.disk_guard import DiskSpaceError, ensure_free_space


class DiskGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def usage(self, free_bytes: int) -> object:
        return mock.Mock(total=free_bytes * 4, used=free_bytes * 3, free=free_bytes)

    def test_enough_space_passes(self) -> None:
        with mock.patch("shutil.disk_usage", return_value=self.usage(10_000_000)):
            ensure_free_space(self.root, 1_000_000)

    def test_insufficient_space_raises_with_both_numbers(self) -> None:
        with mock.patch("shutil.disk_usage", return_value=self.usage(1_000_000)):
            with self.assertRaises(DiskSpaceError) as caught:
                ensure_free_space(self.root, 5_000_000)
        message = str(caught.exception)
        self.assertIn("5", message)
        self.assertIn("1", message)

    def test_need_must_be_non_negative(self) -> None:
        with self.assertRaises(ValueError):
            ensure_free_space(self.root, -1)

    def test_missing_directory_is_reported_as_a_disk_error(self) -> None:
        with self.assertRaises(DiskSpaceError):
            ensure_free_space(self.root / "absent", 1)
