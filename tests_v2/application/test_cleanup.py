from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.cleanup import LocalDeletionTargetPolicy
from ytb_vps_v2.application.cleanup import CleanupGuard, CleanupGuardError
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
)
from ytb_vps_v2.domain.config import ConfigError, EffectiveConfig, SafetyConfig
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.domain.restore import (
    CleanupDenialReason,
    CleanupProof,
    RemoteObjectEvidence,
)


SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64


def entry(key: str, sha256: str = SHA_A) -> ManifestEntry:
    return ManifestEntry(PurePosixPath(key), FileDigest(10, sha256))


class CleanupGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.allowed_root = self.base / "jobs"
        self.allowed_root.mkdir()
        self.target = self.allowed_root / "job-1"
        self.target.mkdir()
        source = SourceIdentity("source.mp4", FileDigest(10, SHA_A))
        self.manifest = CheckpointManifest(
            1,
            "cp-1",
            JobId("job-1"),
            source,
            entry("checkpoints/input.mp4"),
            entry("checkpoints/job-v2.sqlite", SHA_B),
            (entry("checkpoints/workspace/a.json", SHA_C),),
            "created",
        )
        self.manifest_entry = entry("checkpoints/manifest-v1.json", SHA_B)
        self.part = entry("published/part-001.mp4", SHA_C)
        self.validation = entry("published/part-001.validation.json", SHA_B)
        expected = (
            self.manifest_entry,
            self.manifest.input_archive,
            self.manifest.state_snapshot,
            *self.manifest.artifacts,
            self.part,
            self.validation,
        )
        self.evidence = tuple(
            RemoteObjectEvidence(item, 100, "sha256-readback")
            for item in sorted(expected, key=lambda value: str(value.key))
        )
        self.proof = CleanupProof(
            self.manifest_entry,
            self.manifest,
            self.evidence,
            (self.part,),
            (self.validation,),
            ("backup:1", "publish:1"),
            ("backup:1", "publish:1"),
            True,
        )
        self.guard = CleanupGuard(LocalDeletionTargetPolicy())

    def _assess(self, proof: CleanupProof | None = None, **changes: object):
        values = {
            "proof": proof or self.proof,
            "targets": (self.target,),
            "allowed_roots": (self.allowed_root,),
            "now": 100,
            "max_age": 10,
            "operator_enabled": True,
        }
        values.update(changes)
        return self.guard.assess(**values)  # type: ignore[arg-type]

    def test_valid_proof_is_still_denied_until_operator_explicitly_enables(self) -> None:
        denied = self._assess(operator_enabled=False)

        self.assertFalse(denied.allowed)
        self.assertEqual(
            denied.reasons,
            (CleanupDenialReason.OPERATOR_DISABLED,),
        )
        self.assertTrue(self._assess().allowed)
        self.assertFalse(hasattr(self.guard, "delete"))
        self.assertFalse(hasattr(self.guard, "remove"))

    def test_missing_or_mismatching_manifest_state_and_artifact_evidence_denies(self) -> None:
        protected = (
            self.manifest_entry,
            self.manifest.state_snapshot,
            self.manifest.artifacts[0],
        )
        for expected in protected:
            remaining = tuple(
                item for item in self.evidence if item.entry.key != expected.key
            )
            with self.subTest(kind="missing", key=str(expected.key)):
                decision = self._assess(replace(self.proof, evidence=remaining))
                self.assertIn(CleanupDenialReason.MISSING_EVIDENCE, decision.reasons)

            mismatching = tuple(
                replace(
                    item,
                    entry=ManifestEntry(item.entry.key, FileDigest(10, "f" * 64)),
                )
                if item.entry.key == expected.key
                else item
                for item in self.evidence
            )
            with self.subTest(kind="mismatch", key=str(expected.key)):
                decision = self._assess(replace(self.proof, evidence=mismatching))
                self.assertIn(
                    CleanupDenialReason.MISMATCHING_EVIDENCE,
                    decision.reasons,
                )

    def test_input_part_and_validation_failures_have_specific_denials(self) -> None:
        cases = (
            (
                self.manifest.input_archive.key,
                CleanupDenialReason.INPUT_NOT_DURABLE,
            ),
            (self.part.key, CleanupDenialReason.PARTS_NOT_VERIFIED),
            (
                self.validation.key,
                CleanupDenialReason.VALIDATIONS_NOT_VERIFIED,
            ),
        )
        for key, reason in cases:
            evidence = tuple(item for item in self.evidence if item.entry.key != key)
            with self.subTest(key=str(key)):
                decision = self._assess(replace(self.proof, evidence=evidence))
                self.assertIn(CleanupDenialReason.MISSING_EVIDENCE, decision.reasons)
                self.assertIn(reason, decision.reasons)

    def test_stale_future_snapshot_work_and_path_failures_accumulate(self) -> None:
        stale_and_future = tuple(
            replace(item, observed_at=1 if index else 101)
            for index, item in enumerate(self.evidence)
        )
        unsafe = self.base / "outside"
        unsafe.mkdir()
        proof = replace(
            self.proof,
            evidence=stale_and_future,
            remote_work_keys=("backup:1",),
            snapshot_restorable=False,
        )

        decision = self._assess(proof, targets=(unsafe,))

        self.assertEqual(
            set(decision.reasons),
            {
                CleanupDenialReason.FUTURE_EVIDENCE,
                CleanupDenialReason.SNAPSHOT_NOT_RESTORABLE,
                CleanupDenialReason.STALE_EVIDENCE,
                CleanupDenialReason.UNSAFE_DELETION_TARGET,
                CleanupDenialReason.WORK_NOT_DURABLE,
            },
        )

    def test_extra_evidence_and_work_are_not_treated_as_proof(self) -> None:
        extra_evidence = tuple(
            sorted(
                (
                    *self.evidence,
                    RemoteObjectEvidence(entry("unexpected.bin"), 100, "method"),
                ),
                key=lambda item: str(item.entry.key),
            )
        )
        proof = replace(
            self.proof,
            evidence=extra_evidence,
            remote_work_keys=("backup:1", "extra:1", "publish:1"),
        )

        decision = self._assess(proof)

        self.assertIn(CleanupDenialReason.MISMATCHING_EVIDENCE, decision.reasons)
        self.assertIn(CleanupDenialReason.WORK_NOT_DURABLE, decision.reasons)

    def test_invalid_freshness_arguments_fail_closed(self) -> None:
        for changes in (
            {"now": True},
            {"now": -1},
            {"max_age": True},
            {"max_age": -1},
            {"operator_enabled": 1},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(CleanupGuardError):
                    self._assess(**changes)

    def test_runtime_cleanup_configuration_and_cli_remain_disabled(self) -> None:
        self.assertFalse(EffectiveConfig().safety.cleanup_after_upload)
        with self.assertRaises(ConfigError):
            SafetyConfig(cleanup_after_upload=True)
        cli_source = (
            Path(__file__).parents[2]
            / "src"
            / "ytb_vps_v2"
            / "interfaces"
            / "cli.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn("CleanupGuard", cli_source)
        self.assertNotIn("cleanup_after_upload", cli_source)


if __name__ == "__main__":
    unittest.main()
