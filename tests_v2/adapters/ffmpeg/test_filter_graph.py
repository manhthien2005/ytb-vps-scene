from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ffmpeg.filter_graph import (
    MaskRegion, build_video_graph, merge_intervals,
)
from ytb_vps_v2.domain.models import BoundingBox

BAND = BoundingBox(0, 580, 1280, 676)
LOGO = BoundingBox(1064, 14, 1264, 78)


def band(intervals: tuple = ()) -> MaskRegion:
    return MaskRegion(box=BAND, intervals=intervals, glyph_height=44)


class MergeIntervalTests(unittest.TestCase):
    def test_padding_widens_each_interval(self) -> None:
        merged = merge_intervals(
            ((Fraction(2), Fraction(4)),),
            pad_seconds=Fraction(1, 5), gap_seconds=Fraction(1, 2),
        )
        self.assertEqual(merged, ((Fraction(9, 5), Fraction(21, 5)),))

    def test_padding_never_goes_below_zero(self) -> None:
        merged = merge_intervals(
            ((Fraction(0), Fraction(1)),),
            pad_seconds=Fraction(1, 5), gap_seconds=Fraction(1, 2),
        )
        self.assertEqual(merged[0][0], Fraction(0))

    def test_near_intervals_collapse_into_one(self) -> None:
        merged = merge_intervals(
            ((Fraction(1), Fraction(2)), (Fraction(2, 1) + Fraction(1, 10), Fraction(3))),
            pad_seconds=Fraction(0), gap_seconds=Fraction(1, 2),
        )
        self.assertEqual(merged, ((Fraction(1), Fraction(3)),))

    def test_far_intervals_stay_separate(self) -> None:
        merged = merge_intervals(
            ((Fraction(1), Fraction(2)), (Fraction(10), Fraction(11))),
            pad_seconds=Fraction(0), gap_seconds=Fraction(1, 2),
        )
        self.assertEqual(len(merged), 2)

    def test_unordered_input_is_sorted(self) -> None:
        merged = merge_intervals(
            ((Fraction(10), Fraction(11)), (Fraction(1), Fraction(2))),
            pad_seconds=Fraction(0), gap_seconds=Fraction(1, 2),
        )
        self.assertEqual(merged[0][0], Fraction(1))


class VideoGraphTests(unittest.TestCase):
    def test_always_on_region_has_no_enable_clause(self) -> None:
        graph = build_video_graph([band()], width=1280, height=720, subtitle_path=None)
        self.assertNotIn("enable=", graph)
        self.assertIn("boxblur=", graph)

    def test_timed_region_gets_a_between_clause_per_interval(self) -> None:
        graph = build_video_graph(
            [band(((Fraction(1), Fraction(4)), (Fraction(6), Fraction(9))))],
            width=1280, height=720, subtitle_path=None,
        )
        self.assertEqual(graph.count("between(t,"), 2)

    def test_crop_uses_chroma_aligned_even_coordinates(self) -> None:
        region = MaskRegion(box=BoundingBox(11, 21, 111, 141), intervals=(), glyph_height=20)
        graph = build_video_graph([region], width=1280, height=720, subtitle_path=None)
        self.assertIn("crop=102:122:10:20", graph)

    def test_two_regions_produce_two_overlays(self) -> None:
        logo = MaskRegion(box=LOGO, intervals=(), glyph_height=24)
        graph = build_video_graph([band(), logo], width=1280, height=720, subtitle_path=None)
        self.assertEqual(graph.count("overlay="), 2)

    def test_subtitle_filter_is_appended_last(self) -> None:
        graph = build_video_graph(
            [band()], width=1280, height=720, subtitle_path="chunk.ass"
        )
        self.assertLess(graph.index("overlay="), graph.index("subtitles="))

    def test_output_label_terminates_the_graph(self) -> None:
        graph = build_video_graph([band()], width=1280, height=720, subtitle_path=None)
        self.assertTrue(graph.rstrip().endswith("[vout]"))

    def test_no_regions_and_no_subtitles_still_yields_a_valid_passthrough(self) -> None:
        graph = build_video_graph([], width=1280, height=720, subtitle_path=None)
        self.assertIn("[0:v]", graph)
        self.assertTrue(graph.rstrip().endswith("[vout]"))

    def test_windows_subtitle_path_is_escaped_for_the_filter_parser(self) -> None:
        graph = build_video_graph(
            [], width=1280, height=720, subtitle_path=r"C:\work\chunk.ass"
        )
        self.assertIn(r"C\:", graph)
        self.assertNotIn("\\w", graph)
