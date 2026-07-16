from __future__ import annotations

from dataclasses import dataclass

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import StageName


STAGE_ORDER = (
    StageName.INGEST,
    StageName.OCR,
    StageName.TRACK,
    StageName.TRANSLATE,
    StageName.TTS,
    StageName.RENDER,
    StageName.PUBLISH,
    StageName.BACKUP,
)


@dataclass(frozen=True, slots=True)
class InvalidationPlan:
    direct_stages: tuple[StageName, ...]
    affected_stages: tuple[StageName, ...]

    def __post_init__(self) -> None:
        for name, stages in (
            ("Direct stages", self.direct_stages),
            ("Affected stages", self.affected_stages),
        ):
            if not isinstance(stages, tuple) or any(
                not isinstance(stage, StageName) for stage in stages
            ):
                raise DomainInvariantError(f"{name} must be a tuple of StageName")
            if len(stages) != len(set(stages)):
                raise DomainInvariantError(f"{name} must be unique")
            ordered = tuple(stage for stage in STAGE_ORDER if stage in stages)
            if stages != ordered:
                raise DomainInvariantError(f"{name} must follow pipeline order")
        if not set(self.direct_stages).issubset(self.affected_stages):
            raise DomainInvariantError("Direct stages must be affected stages")
