from __future__ import annotations

import unittest
from pathlib import PurePosixPath

from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.domain.restore import (
    CleanupDecision,
    CleanupDenialReason,
    CleanupProof,
    RemoteObjectEvidence,
    RestoreResult,
)


SHA_A = "a" * 64
SHA_B = "b" * 64


def entry(key: str, sha: str = SHA_A) -> ManifestEntry:
    return ManifestEntry(PurePosixPath(key), FileDigest(10, sha))


def manifest() -> CheckpointManifest:
    source = SourceIdentity("source.mp4", FileDigest(10, SHA_A))
    return CheckpointManifest(
        1,
        "cp-1",
        JobId("job-1"),
        source,
        entry("checkpoints/input.mp4"),
        entry("checkpoints/job-v2.sqlite", SHA_B),
        (entry("checkpoints/workspace/a.json", SHA_B),),
        "created",
    )


class RestoreEvidenceTests(unittest.TestCase):
    def test_remote_evidence_requires_exact_entry_time_and_method(self) -> None:
        value = RemoteObjectEvidence(entry("remote/a"), 100, "sha256-readback")
        self.assertEqual(value.observed_at, 100)
        for observed_at in (True, -1, 1.5):
            with self.subTest(observed_at=observed_at):
                with self.assertRaises(DomainInvariantError):
                    RemoteObjectEvidence(entry("remote/a"), observed_at, "method")  # type: ignore[arg-type]
        for method in ("", " method", "x" * 129, 1):
            with self.subTest(method=method):
                with self.assertRaises(DomainInvariantError):
                    RemoteObjectEvidence(entry("remote/a"), 1, method)  # type: ignore[arg-type]

    def test_restore_result_validates_counts_and_migration_versions(self) -> None:
        result = RestoreResult(JobId("job-1"), "cp-1", 2, 2, None)
        self.assertEqual(result.artifact_count, 2)
        with self.assertRaises(DomainInvariantError):
            RestoreResult(JobId("job-1"), "cp-1", True, 2, None)  # type: ignore[arg-type]
        with self.assertRaises(DomainInvariantError):
            RestoreResult(JobId("job-1"), "cp-1", 1, 2, 2)


class CleanupValueTests(unittest.TestCase):
    def _proof(self) -> CleanupProof:
        checkpoint = manifest()
        manifest_entry = entry("checkpoints/manifest-v1.json")
        evidence_entries = (
            manifest_entry,
            checkpoint.input_archive,
            checkpoint.state_snapshot,
            *checkpoint.artifacts,
        )
        return CleanupProof(
            manifest_entry,
            checkpoint,
            tuple(
                RemoteObjectEvidence(item, 100, "sha256-readback")
                for item in sorted(evidence_entries, key=lambda value: str(value.key))
            ),
            (entry("published/part-001.mp4"),),
            (entry("published/part-001.validation.json", SHA_B),),
            ("backup:1", "publish:1"),
            ("backup:1", "publish:1"),
            True,
        )

    def test_cleanup_proof_accepts_sorted_unique_closed_sets(self) -> None:
        proof = self._proof()
        self.assertTrue(proof.snapshot_restorable)
        self.assertEqual(len(proof.evidence), 4)

    def test_cleanup_proof_rejects_duplicate_or_unsorted_evidence_and_work(self) -> None:
        proof = self._proof()
        with self.assertRaises(DomainInvariantError):
            CleanupProof(
                proof.manifest_entry,
                proof.manifest,
                tuple(reversed(proof.evidence)),
                proof.published_parts,
                proof.validation_artifacts,
                proof.required_work_keys,
                proof.remote_work_keys,
                proof.snapshot_restorable,
            )
        with self.assertRaises(DomainInvariantError):
            CleanupProof(
                proof.manifest_entry,
                proof.manifest,
                proof.evidence,
                proof.published_parts,
                proof.validation_artifacts,
                ("publish:1", "backup:1"),
                proof.remote_work_keys,
                True,
            )

    def test_cleanup_decision_allowed_exactly_when_no_reasons(self) -> None:
        self.assertTrue(CleanupDecision(True, ()).allowed)
        denied = CleanupDecision(
            False,
            (
                CleanupDenialReason.OPERATOR_DISABLED,
                CleanupDenialReason.STALE_EVIDENCE,
            ),
        )
        self.assertFalse(denied.allowed)
        with self.assertRaises(DomainInvariantError):
            CleanupDecision(True, (CleanupDenialReason.OPERATOR_DISABLED,))
        with self.assertRaises(DomainInvariantError):
            CleanupDecision(False, ())
        with self.assertRaises(DomainInvariantError):
            CleanupDecision(
                False,
                (
                    CleanupDenialReason.STALE_EVIDENCE,
                    CleanupDenialReason.OPERATOR_DISABLED,
                ),
            )


if __name__ == "__main__":
    unittest.main()
