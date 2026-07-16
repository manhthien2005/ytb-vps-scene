from __future__ import annotations

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import Seconds, to_fraction


MAX_PART_SECONDS = 30 * 60


def target_part_count(duration_seconds: Seconds) -> int:
    duration = to_fraction(duration_seconds)
    if duration <= 0:
        raise DomainInvariantError("Media duration must be positive")
    ratio = duration / MAX_PART_SECONDS
    return max(1, -(-ratio.numerator // ratio.denominator))
