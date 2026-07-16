from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain import FrameInterval, Timeline, target_part_count
from ytb_vps_v2.domain.errors import DomainInvariantError


class PartPlanningTests(unittest.TestCase):
    def test_part_count_uses_ceiling_at_thirty_minute_boundary(self) -> None:
        cases = (
            (Fraction(1), 1),
            (Fraction(1_800), 1),
            (Fraction(1_800_001, 1_000), 2),
            (Fraction(3_600), 2),
            (Fraction(3_600_001, 1_000), 3),
        )
        for duration, expected in cases:
            with self.subTest(duration=duration):
                self.assertEqual(target_part_count(duration), expected)

    def test_non_positive_duration_is_rejected(self) -> None:
        for duration in (0, -1):
            with self.subTest(duration=duration):
                with self.assertRaises(DomainInvariantError):
                    target_part_count(duration)

    def test_domain_exports_timeline_types(self) -> None:
        self.assertEqual(Timeline().target_fps, 30)
        self.assertEqual(FrameInterval(0, 1).frame_count, 1)


if __name__ == "__main__":
    unittest.main()
