from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ffmpeg.filter_graph import (
    MAX_TERMS_PER_STAGE, MaskRegion, build_video_graph, merge_intervals,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox

BAND = BoundingBox(0, 580, 1280, 676)
LOGO = BoundingBox(1064, 14, 1264, 78)


def band(intervals: tuple = ()) -> MaskRegion:
    """A band region: timed when intervals are given, permanent when not."""
    if intervals:
        return MaskRegion(box=BAND, intervals=intervals, glyph_height=44)
    return MaskRegion(box=BAND, intervals=(), glyph_height=44, always_on=True)


def spans(count: int) -> tuple[tuple[Fraction, Fraction], ...]:
    """`count` non-adjacent one-second intervals, spaced so none can merge."""
    return tuple(
        (Fraction(index * 10), Fraction(index * 10 + 1)) for index in range(count)
    )


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
        region = MaskRegion(
            box=BoundingBox(11, 21, 111, 141), intervals=(), glyph_height=20, always_on=True
        )
        graph = build_video_graph([region], width=1280, height=720, subtitle_path=None)
        self.assertIn("crop=102:122:10:20", graph)

    def test_two_regions_produce_two_overlays(self) -> None:
        logo = MaskRegion(box=LOGO, intervals=(), glyph_height=24, always_on=True)
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

    def test_subtitle_path_with_apostrophe_is_escaped(self) -> None:
        """Verified against ffmpeg N-124716 with a real file at .../AA'BB/real.ass.

        The value passes through TWO unescape passes (the quote remover, then
        the option-value unescaper), so only close-quote + THREE backslashes +
        two quotes survives both passes intact. Weaker forms were tried against
        the real binary and rejected:
          \\'      -> the quote never re-closes; ffmpeg swallows the rest of the
                      GRAPH into the filename ("Unable to open ...AABB/real.ass
                      [sub];[sub]format=yuv420p[vout]") -- silent corruption.
          '\\''    -> the documented shell-style escape; parses, but the
                      apostrophe itself is dropped ("AABB", not "AA'BB").
          '\\\\''  -> parses, but yields a literal backslash instead of a quote
                      ("AA\\BB").
          '\\\\\\''  -> correct; the value round-trips to "AA'BB".
        """
        graph = build_video_graph(
            [], width=1280, height=720, subtitle_path="C:/work/chunk's.ass"
        )
        self.assertIn("chunk'\\\\\\''s.ass", graph)
        # Weaker forms that were measured to corrupt or misparse must not appear.
        self.assertNotIn("chunk\\'s.ass", graph)
        self.assertNotIn("chunk'\\''s.ass", graph)


class IntervalChunkingTests(unittest.TestCase):
    """FFmpeg accepts at most 100 between() terms in one enable= expression and
    fails the WHOLE filter on the 101st. A 60-minute video with sparse dialogue
    yields ~360 intervals, so a single expression is not an option."""

    def intervals(self, count: int) -> tuple:
        return tuple(
            (Fraction(index * 10), Fraction(index * 10 + 2)) for index in range(count)
        )

    def test_intervals_under_the_limit_use_one_overlay_stage(self) -> None:
        graph = build_video_graph(
            [band(self.intervals(5))], width=1280, height=720, subtitle_path=None
        )
        self.assertEqual(graph.count("overlay="), 1)
        self.assertEqual(graph.count("between(t,"), 5)

    def test_intervals_over_the_limit_split_into_chained_stages(self) -> None:
        graph = build_video_graph(
            [band(self.intervals(150))], width=1280, height=720, subtitle_path=None
        )
        self.assertEqual(graph.count("overlay="), 3)
        self.assertEqual(graph.count("between(t,"), 150)

    def test_no_single_enable_expression_exceeds_the_measured_limit(self) -> None:
        graph = build_video_graph(
            [band(self.intervals(400))], width=1280, height=720, subtitle_path=None
        )
        for clause in graph.split(":enable='")[1:]:
            expression = clause.split("'")[0]
            with self.subTest(terms=expression.count("between(t,")):
                self.assertLessEqual(expression.count("between(t,"), MAX_TERMS_PER_STAGE)

    def test_every_interval_survives_chunking(self) -> None:
        wanted = self.intervals(250)
        graph = build_video_graph(
            [band(wanted)], width=1280, height=720, subtitle_path=None
        )
        self.assertEqual(graph.count("between(t,"), len(wanted))

    def test_one_blur_branch_is_shared_by_all_stages_of_a_region(self) -> None:
        """Chunking must not re-blur the same crop once per stage."""
        graph = build_video_graph(
            [band(self.intervals(150))], width=1280, height=720, subtitle_path=None
        )
        self.assertEqual(graph.count("boxblur="), 1)


class MaskRegionValidationTests(unittest.TestCase):
    def test_no_intervals_without_always_on_is_rejected(self) -> None:
        """merge_intervals() returns () when OCR found nothing. Reading that as
        'blur forever' is the v1 defect this rebuild removes."""
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=(), glyph_height=44)

    def test_always_on_with_intervals_is_rejected(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(
                box=BAND,
                intervals=((Fraction(1), Fraction(2)),),
                glyph_height=44,
                always_on=True,
            )

    def test_box_must_be_a_bounding_box(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=(0, 0, 10, 10), intervals=(), glyph_height=44, always_on=True)  # type: ignore[arg-type]

    def test_intervals_must_be_a_tuple(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=[(Fraction(1), Fraction(2))], glyph_height=44)  # type: ignore[arg-type]

    def test_inverted_interval_is_rejected(self) -> None:
        """between(t,5,3) is accepted by ffmpeg and is permanently false, so an
        inverted pair would silently leave the region unblurred."""
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=((Fraction(5), Fraction(3)),), glyph_height=44)

    def test_interval_bounds_must_be_fractions(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=((1.0, 2.0),), glyph_height=44)  # type: ignore[arg-type]

    def test_glyph_height_must_be_positive(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=(), glyph_height=0, always_on=True)

    def test_always_on_must_be_a_bool(self) -> None:
        with self.assertRaises(DomainInvariantError):
            MaskRegion(box=BAND, intervals=(), glyph_height=44, always_on="yes")  # type: ignore[arg-type]
