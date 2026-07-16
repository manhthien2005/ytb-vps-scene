from __future__ import annotations

from collections.abc import Iterable, Mapping
from types import MappingProxyType

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import (
    Fingerprint,
    StageConfigFingerprint,
)
from ytb_vps_v2.domain.invalidation import InvalidationPlan, STAGE_ORDER
from ytb_vps_v2.domain.models import StageName


STAGE_DEPENDENCIES: Mapping[StageName, tuple[StageName, ...]] = MappingProxyType(
    {
        stage: (() if index == 0 else (STAGE_ORDER[index - 1],))
        for index, stage in enumerate(STAGE_ORDER)
    }
)


def _snapshot(
    values: Iterable[StageConfigFingerprint],
) -> dict[StageName, Fingerprint]:
    try:
        items = tuple(values)
    except TypeError as exc:
        raise DomainInvariantError("Fingerprint snapshot must be iterable") from exc
    if any(not isinstance(item, StageConfigFingerprint) for item in items):
        raise DomainInvariantError(
            "Fingerprint snapshot must contain StageConfigFingerprint values"
        )
    snapshot = {item.stage: item.fingerprint for item in items}
    if len(items) != len(snapshot):
        raise DomainInvariantError("Fingerprint snapshot contains duplicate stages")
    if set(snapshot) != set(STAGE_ORDER):
        raise DomainInvariantError("Fingerprint snapshot must contain every stage")
    return snapshot


def plan_invalidation(
    previous: Iterable[StageConfigFingerprint],
    current: Iterable[StageConfigFingerprint],
    *,
    changed_artifact_owners: Iterable[StageName] = (),
) -> InvalidationPlan:
    old = _snapshot(previous)
    new = _snapshot(current)
    try:
        owners = tuple(changed_artifact_owners)
    except TypeError as exc:
        raise DomainInvariantError("Artifact owners must be iterable") from exc
    if any(not isinstance(stage, StageName) for stage in owners):
        raise DomainInvariantError("Artifact owners must be StageName values")

    direct = {
        stage
        for stage in STAGE_ORDER
        if old[stage] != new[stage]
    }
    direct.update(owners)
    affected = set(direct)
    changed = True
    while changed:
        before = len(affected)
        affected.update(
            stage
            for stage in STAGE_ORDER
            if any(
                dependency in affected
                for dependency in STAGE_DEPENDENCIES[stage]
            )
        )
        changed = len(affected) != before

    return InvalidationPlan(
        tuple(stage for stage in STAGE_ORDER if stage in direct),
        tuple(stage for stage in STAGE_ORDER if stage in affected),
    )
