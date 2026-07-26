from __future__ import annotations

from dataclasses import dataclass

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId, StageName


class StateTransitionError(DomainInvariantError):
    """Raised when a durable work unit cannot make a requested transition."""


def _text(name: str, value: object, maximum: int) -> None:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        raise DomainInvariantError(
            f"{name} must be non-empty, trimmed, and at most {maximum} characters"
        )


@dataclass(frozen=True, slots=True)
class RetryEvent:
    job_id: JobId
    unit_key: str
    stage: StageName
    attempt: int
    error_kind: str
    error_message: str
    recorded_at: str

    def __post_init__(self) -> None:
        if type(self.job_id) is not JobId:
            raise DomainInvariantError("Retry event job ID must be JobId")
        _text("Retry event unit key", self.unit_key, 512)
        if not isinstance(self.stage, StageName):
            raise DomainInvariantError("Retry event stage must be StageName")
        if (
            isinstance(self.attempt, bool)
            or not isinstance(self.attempt, int)
            or self.attempt <= 0
        ):
            raise DomainInvariantError("Retry event attempt must be a positive integer")
        _text("Retry event error kind", self.error_kind, 128)
        _text("Retry event error message", self.error_message, 4096)
        _text("Retry event timestamp", self.recorded_at, 128)
