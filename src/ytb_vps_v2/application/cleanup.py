from __future__ import annotations

import hashlib
from pathlib import Path

from ytb_vps_v2.domain.backup import (
    ManifestEntry,
    canonical_manifest_bytes,
)
from ytb_vps_v2.domain.restore import (
    CleanupDecision,
    CleanupDenialReason,
    CleanupProof,
    RemoteObjectEvidence,
)
from ytb_vps_v2.ports.cleanup import (
    DeletionTargetPolicy,
    UnsafeDeletionTargetError,
)


class CleanupGuardError(RuntimeError):
    """Raised when cleanup assessment inputs cannot be evaluated safely."""


def _exact_evidence(
    expected: ManifestEntry,
    observed: dict[str, RemoteObjectEvidence],
) -> bool:
    evidence = observed.get(str(expected.key))
    return evidence is not None and evidence.entry == expected


class CleanupGuard:
    def __init__(self, deletion_policy: DeletionTargetPolicy) -> None:
        if not isinstance(deletion_policy, DeletionTargetPolicy):
            raise CleanupGuardError(
                "Deletion target policy does not satisfy its contract"
            )
        self.deletion_policy = deletion_policy

    def assess(
        self,
        proof: CleanupProof,
        targets: tuple[Path, ...],
        allowed_roots: tuple[Path, ...],
        now: int,
        max_age: int,
        operator_enabled: bool,
        required_parts: tuple[ManifestEntry, ...],
        required_validations: tuple[ManifestEntry, ...],
        required_work_keys: tuple[str, ...],
    ) -> CleanupDecision:
        if type(proof) is not CleanupProof:
            raise CleanupGuardError("Cleanup proof must be CleanupProof")
        if type(now) is not int or now < 0:
            raise CleanupGuardError("Cleanup assessment time must be non-negative")
        if type(max_age) is not int or max_age < 0:
            raise CleanupGuardError("Cleanup evidence age must be non-negative")
        if type(operator_enabled) is not bool:
            raise CleanupGuardError("Cleanup operator flag must be boolean")
        if (
            type(required_parts) is not tuple
            or not required_parts
            or any(type(item) is not ManifestEntry for item in required_parts)
        ):
            raise CleanupGuardError("Required Parts must be non-empty manifest entries")
        if (
            type(required_validations) is not tuple
            or not required_validations
            or any(
                type(item) is not ManifestEntry for item in required_validations
            )
        ):
            raise CleanupGuardError(
                "Required validations must be non-empty manifest entries"
            )
        if (
            type(required_work_keys) is not tuple
            or not required_work_keys
            or any(
                type(item) is not str or not item or item != item.strip()
                for item in required_work_keys
            )
            or required_work_keys != tuple(sorted(required_work_keys))
            or len(required_work_keys) != len(set(required_work_keys))
        ):
            raise CleanupGuardError(
                "Required work keys must be non-empty, sorted, and unique"
            )

        reasons: set[CleanupDenialReason] = set()
        if not operator_enabled:
            reasons.add(CleanupDenialReason.OPERATOR_DISABLED)

        expected_entries = (
            proof.manifest_entry,
            proof.manifest.input_archive,
            proof.manifest.state_snapshot,
            *proof.manifest.artifacts,
            *required_parts,
            *required_validations,
        )
        expected_by_key = {str(item.key): item for item in expected_entries}
        if len(expected_by_key) != len(expected_entries):
            reasons.add(CleanupDenialReason.MISMATCHING_EVIDENCE)

        observed_by_key = {
            str(item.entry.key): item for item in proof.evidence
        }
        missing_keys = set(expected_by_key) - set(observed_by_key)
        if missing_keys:
            reasons.add(CleanupDenialReason.MISSING_EVIDENCE)
        mismatching_keys = {
            key
            for key in set(expected_by_key) & set(observed_by_key)
            if observed_by_key[key].entry != expected_by_key[key]
        }
        extra_keys = set(observed_by_key) - set(expected_by_key)
        if mismatching_keys or extra_keys:
            reasons.add(CleanupDenialReason.MISMATCHING_EVIDENCE)

        canonical = canonical_manifest_bytes(proof.manifest)
        canonical_digest = (
            len(canonical),
            hashlib.sha256(canonical).hexdigest(),
        )
        if (
            proof.manifest_entry.digest.size_bytes,
            proof.manifest_entry.digest.sha256,
        ) != canonical_digest:
            reasons.add(CleanupDenialReason.MISMATCHING_EVIDENCE)
        manifest_prefix = proof.manifest.state_snapshot.key.parent.parent
        manifest_name = f"manifest-v{proof.manifest.version}.json"
        if proof.manifest_entry.key != manifest_prefix / manifest_name:
            reasons.add(CleanupDenialReason.MISMATCHING_EVIDENCE)
        if any(item.method != "sha256-readback" for item in proof.evidence):
            reasons.add(CleanupDenialReason.MISMATCHING_EVIDENCE)

        if not _exact_evidence(proof.manifest.input_archive, observed_by_key):
            reasons.add(CleanupDenialReason.INPUT_NOT_DURABLE)
        if proof.published_parts != required_parts or any(
            not _exact_evidence(item, observed_by_key)
            for item in required_parts
        ):
            reasons.add(CleanupDenialReason.PARTS_NOT_VERIFIED)
        if proof.validation_artifacts != required_validations or any(
            not _exact_evidence(item, observed_by_key)
            for item in required_validations
        ):
            reasons.add(CleanupDenialReason.VALIDATIONS_NOT_VERIFIED)

        for evidence in proof.evidence:
            if evidence.observed_at > now:
                reasons.add(CleanupDenialReason.FUTURE_EVIDENCE)
            elif now - evidence.observed_at > max_age:
                reasons.add(CleanupDenialReason.STALE_EVIDENCE)

        if not proof.snapshot_restorable:
            reasons.add(CleanupDenialReason.SNAPSHOT_NOT_RESTORABLE)
        if (
            proof.required_work_keys != required_work_keys
            or proof.remote_work_keys != required_work_keys
        ):
            reasons.add(CleanupDenialReason.WORK_NOT_DURABLE)

        try:
            self.deletion_policy.preflight(targets, allowed_roots)
        except (UnsafeDeletionTargetError, OSError, RuntimeError, ValueError, TypeError):
            reasons.add(CleanupDenialReason.UNSAFE_DELETION_TARGET)

        ordered = tuple(sorted(reasons, key=lambda item: item.value))
        return CleanupDecision(not ordered, ordered)
