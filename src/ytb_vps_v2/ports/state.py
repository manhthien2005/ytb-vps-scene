from __future__ import annotations

from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.models import JobId, WorkUnit
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

    def put_work_unit(self, job_id: JobId, unit: WorkUnit, at: str) -> None: ...

    def get_work_unit(self, job_id: JobId, unit_key: str) -> WorkUnit: ...

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
