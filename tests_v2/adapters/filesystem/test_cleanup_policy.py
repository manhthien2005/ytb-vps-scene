from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ytb_vps_v2.adapters.filesystem.cleanup import LocalDeletionTargetPolicy
from ytb_vps_v2.ports.cleanup import UnsafeDeletionTargetError


class LocalDeletionTargetPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "allowed"
        self.root.mkdir()
        self.first = self.root / "job-a"
        self.first.mkdir()
        self.second = self.root / "job-b.bin"
        self.second.write_bytes(b"part")
        self.policy = LocalDeletionTargetPolicy()

    def test_accepts_existing_distinct_targets_strictly_below_real_roots(self) -> None:
        result = self.policy.preflight(
            (self.first, self.second),
            (self.root,),
        )

        self.assertEqual(
            tuple(str(item) for item in result),
            tuple(sorted((self.first.as_posix(), self.second.as_posix()))),
        )
        self.assertFalse(hasattr(self.policy, "delete"))
        self.assertFalse(hasattr(self.policy, "remove"))

    def test_rejects_non_path_relative_missing_root_and_root_itself(self) -> None:
        cases = (
            ((str(self.first),), (self.root,)),
            ((self.first,), (str(self.root),)),
            ((Path("relative-target"),), (self.root,)),
            ((self.first,), (Path("relative-root"),)),
            ((self.first,), (self.base / "missing",)),
            ((self.root,), (self.root,)),
        )
        for targets, roots in cases:
            with self.subTest(targets=targets, roots=roots):
                with self.assertRaises(UnsafeDeletionTargetError):
                    self.policy.preflight(targets, roots)  # type: ignore[arg-type]

    def test_rejects_dotdot_duplicate_and_nested_targets(self) -> None:
        child = self.first / "child.bin"
        child.write_bytes(b"child")
        cases = (
            (self.root / "job-a" / ".." / "job-b.bin",),
            (self.first, self.first),
            (self.first, child),
        )
        for targets in cases:
            with self.subTest(targets=targets):
                with self.assertRaises(UnsafeDeletionTargetError):
                    self.policy.preflight(targets, (self.root,))

    def test_rejects_target_outside_root_and_ambiguous_roots(self) -> None:
        outside = self.base / "outside"
        outside.mkdir()
        nested_root = self.root / "nested-root"
        nested_root.mkdir()
        with self.assertRaises(UnsafeDeletionTargetError):
            self.policy.preflight((outside,), (self.root,))
        with self.assertRaises(UnsafeDeletionTargetError):
            self.policy.preflight((self.first,), (self.root, self.root))
        with self.assertRaises(UnsafeDeletionTargetError):
            self.policy.preflight((self.first,), (self.root, nested_root))

    def test_rejects_symlink_or_junction_components(self) -> None:
        linked = self.root / "linked"
        try:
            linked.symlink_to(self.first, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks are unavailable on this host")
        with self.assertRaises(UnsafeDeletionTargetError):
            self.policy.preflight((linked,), (self.root,))

    def test_rejects_reparse_component_without_requiring_symlink_privilege(self) -> None:
        path_type = type(self.first)
        original = getattr(path_type, "is_junction", None)

        def junction_only_for_target(path: Path) -> bool:
            if path == self.first:
                return True
            return bool(original(path)) if original is not None else False

        with mock.patch.object(
            path_type,
            "is_junction",
            junction_only_for_target,
            create=original is None,
        ):
            with self.assertRaises(UnsafeDeletionTargetError):
                self.policy.preflight((self.first,), (self.root,))

    def test_rejects_component_identity_change_during_preflight(self) -> None:
        real_lstat = os.lstat
        calls = 0

        def changing_lstat(path: object, *args: object, **kwargs: object) -> os.stat_result:
            nonlocal calls
            result = real_lstat(path, *args, **kwargs)
            if Path(path) == self.first:
                calls += 1
                if calls > 1:
                    values = list(result)
                    values[1] += calls
                    return os.stat_result(values)
            return result

        with mock.patch("os.lstat", changing_lstat):
            with self.assertRaises(UnsafeDeletionTargetError):
                self.policy.preflight((self.first,), (self.root,))


if __name__ == "__main__":
    unittest.main()
