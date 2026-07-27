from __future__ import annotations

import subprocess
import unittest
from fractions import Fraction

from tests_v2.support.fixtures import ffmpeg_available
from ytb_vps_v2.domain.blur_geometry import (
    MINIMUM_RADIUS_RATIO, RegionTooSmallError, align_to_chroma_grid, blur_radii,
)
from ytb_vps_v2.domain.models import BoundingBox


class ChromaAlignmentTests(unittest.TestCase):
    def test_even_box_is_unchanged(self) -> None:
        box = BoundingBox(10, 20, 110, 140)
        self.assertEqual(align_to_chroma_grid(box, width=1280, height=720), box)

    def test_odd_origin_expands_outward(self) -> None:
        aligned = align_to_chroma_grid(BoundingBox(11, 21, 111, 141), width=1280, height=720)
        self.assertEqual((aligned.xmin, aligned.ymin), (10, 20))
        self.assertEqual((aligned.xmax, aligned.ymax), (112, 142))

    def test_expansion_never_leaves_the_frame(self) -> None:
        aligned = align_to_chroma_grid(BoundingBox(0, 0, 1279, 719), width=1280, height=720)
        self.assertEqual((aligned.xmin, aligned.ymin), (0, 0))
        self.assertEqual((aligned.xmax, aligned.ymax), (1280, 720))

    def test_all_edges_are_even(self) -> None:
        aligned = align_to_chroma_grid(BoundingBox(3, 7, 99, 101), width=1280, height=720)
        for value in (aligned.xmin, aligned.ymin, aligned.xmax, aligned.ymax):
            self.assertEqual(value % 2, 0)


class RadiusClampTests(unittest.TestCase):
    """FFmpeg requires radius < min(plane_w, plane_h) / 2 on EVERY plane, and
    yuv420p chroma planes are half size. The legacy formula ignored the strict
    inequality and the chroma plane, which killed whole filter graphs."""

    def test_wide_band_uses_the_requested_strength(self) -> None:
        luma, chroma = blur_radii(1280, 96, glyph_height=44)
        self.assertGreaterEqual(luma, 14)
        self.assertLessEqual(luma, 96 // 2 - 1)
        self.assertLessEqual(chroma, 48 // 2 - 1)

    def test_thin_band_stays_inside_the_luma_limit(self) -> None:
        luma, _ = blur_radii(1280, 40, glyph_height=12)
        self.assertLessEqual(luma, 40 // 2 - 1)

    def test_small_logo_stays_inside_both_limits(self) -> None:
        luma, chroma = blur_radii(180, 24, glyph_height=20)
        self.assertLessEqual(luma, 24 // 2 - 1)
        self.assertLessEqual(chroma, 12 // 2 - 1)

    def test_radius_scales_with_glyph_height(self) -> None:
        small, _ = blur_radii(1280, 200, glyph_height=24)
        large, _ = blur_radii(1280, 200, glyph_height=80)
        self.assertLess(small, large)

    def test_radius_reaches_the_measured_concealment_ratio(self) -> None:
        # Measured against rapidocr: text stops being recoverable at about
        # 0.25 x glyph height. MINIMUM_RADIUS_RATIO carries a safety margin.
        for glyph in (24, 32, 44, 64, 80):
            with self.subTest(glyph=glyph):
                luma, _ = blur_radii(1920, 400, glyph_height=glyph)
                self.assertGreaterEqual(luma, int(MINIMUM_RADIUS_RATIO * glyph))

    def test_region_too_short_to_conceal_is_rejected_not_silently_weakened(self) -> None:
        with self.assertRaises(RegionTooSmallError):
            blur_radii(1280, 12, glyph_height=44)

    def test_chroma_radius_never_exceeds_half_the_luma_radius(self) -> None:
        luma, chroma = blur_radii(1920, 300, glyph_height=60)
        self.assertLessEqual(chroma, luma // 2)

    def test_degenerate_sizes_are_rejected(self) -> None:
        for width, height in ((0, 100), (100, 0), (-2, 100)):
            with self.subTest(size=(width, height)):
                with self.assertRaises(RegionTooSmallError):
                    blur_radii(width, height, glyph_height=20)


@unittest.skipUnless(ffmpeg_available(), "ffmpeg required")
class RadiusAcceptedByFfmpegTests(unittest.TestCase):
    SIZES = (
        (1900, 90), (1280, 96), (200, 64), (64, 10), (40, 8), (180, 24),
        (1280, 40), (96, 96), (1920, 300), (8, 8), (300, 12), (1920, 1080),
        (16, 16), (10, 4), (6, 6), (1280, 6),
    )

    def test_every_clamped_radius_is_accepted_by_ffmpeg(self) -> None:
        for width, height in self.SIZES:
            with self.subTest(size=(width, height)):
                glyph = max(1, min(width, height) // 3)
                try:
                    luma, chroma = blur_radii(width, height, glyph_height=glyph)
                except RegionTooSmallError:
                    continue  # a refusal is a valid, loud outcome
                completed = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error",
                     "-f", "lavfi", "-i", f"color=size={width}x{height}:d=0.04",
                     "-pix_fmt", "yuv420p",
                     "-vf", f"boxblur=luma_radius={luma}:luma_power=1:"
                            f"chroma_radius={chroma}:chroma_power=1",
                     "-frames:v", "1", "-f", "null", "-"],
                    capture_output=True, text=True, timeout=60,
                )
                self.assertEqual(
                    completed.returncode, 0,
                    f"{width}x{height} luma={luma} chroma={chroma}: {completed.stderr}",
                )

    def test_the_luma_cap_is_exactly_tight_not_merely_safe(self) -> None:
        """A cap that is merely legal is not good enough.

        `N // 2 - 1` is legal for every N but one short of the true limit whenever N
        is odd, which silently weakens the blur or turns a workable region into a
        false refusal. This asserts both directions: the cap is accepted AND cap+1
        is rejected. Without the second half, an off-by-one cap passes unnoticed."""
        for size in (96, 99, 100, 101, 45, 49, 90, 24):
            with self.subTest(plane=size):
                cap = (size - 1) // 2
                for radius, expected_ok in ((cap, True), (cap + 1, False)):
                    completed = subprocess.run(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error",
                         "-f", "lavfi", "-i", f"color=size={size}x{size}:d=0.04",
                         "-pix_fmt", "yuv444p",  # 444 keeps the luma plane the binding one
                         "-vf", f"boxblur=luma_radius={radius}:luma_power=1:chroma_radius=0",
                         "-frames:v", "1", "-f", "null", "-"],
                        capture_output=True, text=True, timeout=60,
                    )
                    self.assertEqual(
                        completed.returncode == 0, expected_ok,
                        f"plane {size}, radius {radius}: expected ok={expected_ok}, "
                        f"got {completed.returncode}: {completed.stderr}",
                    )
