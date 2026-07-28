from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.backup import (
    CheckpointRecord,
    ManifestEntry,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.invalidation import InvalidationPlan
from ytb_vps_v2.domain.models import Artifact, JobId, WorkUnit
from ytb_vps_v2.domain.state import RetryEvent


@runtime_checkable
class StateRepository(Protocol):
    def create_job(
        self,
        job_id: JobId,
        source_fingerprint: Fingerprint,
        config_fingerprints: tuple[StageConfigFingerprint, ...],
        at: str,
    ) -> None: ...

    def stored_config_fingerprints(
        self,
        job_id: JobId,
    ) -> tuple[StageConfigFingerprint, ...] | None: ...

    def reconfigure_job(
        self,
        job_id: JobId,
        previous: tuple[StageConfigFingerprint, ...],
        current: tuple[StageConfigFingerprint, ...],
        plan: InvalidationPlan,
        at: str,
    ) -> tuple[str, ...]: ...

    def record_verified_input(
        self, job_id: JobId, evidence: VerifiedInputArchive
    ) -> None: ...

    def verified_input(self, job_id: JobId) -> VerifiedInputArchive | None: ...

    def record_checkpoint(
        self,
        job_id: JobId,
        checkpoint_id: str,
        manifest: ManifestEntry,
        state_snapshot: ManifestEntry,
        at: str,
    ) -> None: ...

    def completed_checkpoints(
        self, job_id: JobId
    ) -> tuple[CheckpointRecord, ...]: ...

    def create_snapshot(
        self, destination: Path, key: PurePosixPath
    ) -> ManifestEntry: ...

    def put_work_unit(self, job_id: JobId, unit: WorkUnit, at: str) -> None: ...

    def get_work_unit(self, job_id: JobId, unit_key: str) -> WorkUnit: ...

    def work_units(self, job_id: JobId) -> tuple[WorkUnit, ...]: ...

    def start_work_unit(self, job_id: JobId, unit_key: str, at: str) -> WorkUnit: ...

    def fail_work_unit(
        self,
        job_id: JobId,
        unit_key: str,
        error_kind: str,
        error_message: str,
        at: str,
    ) -> WorkUnit: ...

    def recover_stale_work(self, at: str) -> tuple[tuple[JobId, str], ...]: ...

    def retry_events(self, job_id: JobId, unit_key: str) -> tuple[RetryEvent, ...]: ...

    def commit_artifact(
        self,
        job_id: JobId,
        unit_key: str,
        artifact: Artifact,
        at: str,
    ) -> None: ...

    def commit_artifacts(
        self,
        job_id: JobId,
        unit_key: str,
        artifacts: tuple[Artifact, ...],
        at: str,
    ) -> None: ...

    def valid_artifacts(self, job_id: JobId) -> tuple[Artifact, ...]: ...

    def artifacts_for_unit(
        self,
        job_id: JobId,
        unit_key: str,
    ) -> tuple[Artifact, ...]: ...

    def invalidate_work_units(
        self,
        job_id: JobId,
        unit_keys: tuple[str, ...],
        at: str,
    ) -> tuple[str, ...]: ...

    def apply_invalidation(
        self,
        job_id: JobId,
        plan: InvalidationPlan,
        at: str,
    ) -> tuple[str, ...]: ...
