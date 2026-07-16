from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


class TimelineTests(unittest.TestCase):
    def test_default_timeline_uses_floor_start_and_ceil_end(self) -> None:
        timeline = Timeline()

        interval = timeline.interval(
            Fraction(1, 100),
            Fraction(101, 100),
            Fraction(2),
        )

        self.assertEqual(timeline.target_fps, 30)
        self.assertEqual(interval, FrameInterval(start_frame=0, end_frame=31))
        self.assertTrue(interval.contains(0))
        self.assertFalse(interval.contains(31))

    def test_interval_clamps_end_to_total_frames(self) -> None:
        timeline = Timeline()

        interval = timeline.interval(9.9, 10.5, 10)

        self.assertEqual(timeline.total_frames(10), 300)
        self.assertEqual(interval, FrameInterval(start_frame=297, end_frame=300))

    def test_invalid_or_empty_intervals_are_rejected(self) -> None:
        timeline = Timeline()

        invalid = (
            (-0.1, 1, 10),
            (1, 1, 10),
            (2, 1, 10),
            (10, 11, 10),
        )
        for start, end, duration in invalid:
            with self.subTest(start=start, end=end, duration=duration):
                with self.assertRaises(DomainInvariantError):
                    timeline.interval(start, end, duration)

    def test_source_fps_fixtures_reach_the_canonical_timeline_end(self) -> None:
        timeline = Timeline()
        duration = Fraction(10)
        source_rates = (
            Fraction(24),
            Fraction(25),
            Fraction(30_000, 1_001),
            Fraction(30),
        )

        for source_fps in source_rates:
            source_frames = duration * source_fps
            source_frame_count = -(-source_frames.numerator // source_frames.denominator)
            with self.subTest(source_fps=source_fps):
                interval = timeline.normalize_source_interval(
                    source_frame_count - 1,
                    source_frame_count,
                    source_fps,
                    duration,
                )
                self.assertLess(interval.start_frame, interval.end_frame)
                self.assertEqual(interval.end_frame, 300)


if __name__ == "__main__":
    unittest.main()
