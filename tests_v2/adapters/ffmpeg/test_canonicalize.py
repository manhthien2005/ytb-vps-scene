# tests_v2/adapters/ffmpeg/test_canonicalize.py
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ffmpeg.canonicalize import (
    CanvasSpec, canonicalize_arguments, plan_canvas,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.media_input import ColourProfile, FrameRateMode, InputManifest


def manifest(**overrides: object) -> InputManifest:
    values = dict(
        video_stream_index=0, audio_stream_index=1,
        storage_width=1280, storage_height=720, rotation_degrees=0,
        sample_aspect_ratio=Fraction(1), frame_rate=Fraction(30),
        frame_rate_mode=FrameRateMode.CFR,
        colour=ColourProfile("bt709", "bt709", "bt709", "tv", 8),
        start_time_seconds=Fraction(0), duration_seconds=Fraction(6),
        rejected_audio_indexes=(), subtitle_stream_indexes=(),
    )
    values.update(overrides)
    return InputManifest(**values)  # type: ignore[arg-type]


def video_filter(arguments: list[str]) -> str:
    return arguments[arguments.index("-vf") + 1]


class CanvasTests(unittest.TestCase):
    def test_canvas_dimensions_must_be_even(self) -> None:
        with self.assertRaises(DomainInvariantError):
            CanvasSpec(1281, 720, 30)

    def test_display_size_within_limits_is_kept(self) -> None:
        canvas = plan_canvas(manifest(), max_width=1920, max_height=1080, target_fps=30)
        self.assertEqual((canvas.width, canvas.height), (1280, 720))

    def test_oversized_source_is_scaled_down_preserving_aspect(self) -> None:
        canvas = plan_canvas(
            manifest(storage_width=3840, storage_height=2160),
            max_width=1920, max_height=1080, target_fps=30,
        )
        self.assertEqual((canvas.width, canvas.height), (1920, 1080))

    def test_rotated_source_plans_the_rotated_canvas(self) -> None:
        canvas = plan_canvas(
            manifest(rotation_degrees=90), max_width=1920, max_height=1080, target_fps=30
        )
        self.assertEqual((canvas.width, canvas.height), (720, 1280))

    def test_anamorphic_source_plans_the_square_pixel_canvas(self) -> None:
        canvas = plan_canvas(
            manifest(sample_aspect_ratio=Fraction(2)),
            max_width=1920, max_height=1080, target_fps=30,
        )
        self.assertEqual((canvas.width, canvas.height), (1920, 540))

    def test_odd_scaled_dimensions_are_rounded_to_even(self) -> None:
        canvas = plan_canvas(
            manifest(storage_width=1000, storage_height=563),
            max_width=640, max_height=640, target_fps=30,
        )
        self.assertEqual(canvas.width % 2, 0)
        self.assertEqual(canvas.height % 2, 0)


class ArgumentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.canvas = CanvasSpec(1280, 720, 30)

    def build(self, value: InputManifest) -> list[str]:
        return canonicalize_arguments(
            value, self.canvas, source="in.mp4", destination="out.mp4", ffmpeg="ffmpeg"
        )

    def test_explicit_stream_maps_avoid_attached_pictures(self) -> None:
        arguments = self.build(manifest(video_stream_index=0, audio_stream_index=3))
        self.assertIn("0:0", arguments)
        self.assertIn("0:3", arguments)

    def test_missing_audio_disables_the_audio_track(self) -> None:
        self.assertIn("-an", self.build(manifest(audio_stream_index=None)))

    def test_square_pixels_are_forced(self) -> None:
        self.assertIn("setsar=1", video_filter(self.build(manifest())))

    def test_frames_are_padded_onto_the_fixed_canvas(self) -> None:
        graph = video_filter(self.build(manifest()))
        self.assertIn("pad=1280:720", graph)

    def test_constant_frame_rate_is_forced(self) -> None:
        arguments = self.build(manifest())
        self.assertIn("-fps_mode", arguments)
        self.assertEqual(arguments[arguments.index("-fps_mode") + 1], "cfr")
        self.assertIn("fps=30", video_filter(arguments))

    def test_high_dynamic_range_is_tone_mapped(self) -> None:
        colour = ColourProfile("bt2020", "smpte2084", "bt2020nc", "tv", 10)
        graph = video_filter(self.build(manifest(colour=colour)))
        self.assertIn("tonemap", graph)
        self.assertIn("zscale", graph)

    def test_standard_dynamic_range_is_not_tone_mapped(self) -> None:
        self.assertNotIn("tonemap", video_filter(self.build(manifest())))

    def test_output_is_tagged_bt709_limited(self) -> None:
        arguments = self.build(manifest())
        for flag in ("-color_primaries", "-color_trc", "-colorspace"):
            self.assertEqual(arguments[arguments.index(flag) + 1], "bt709")
        self.assertEqual(arguments[arguments.index("-color_range") + 1], "tv")

    def test_timestamps_are_rebased_to_zero(self) -> None:
        graph = video_filter(self.build(manifest(start_time_seconds=Fraction(-1, 2))))
        self.assertIn("setpts=PTS-STARTPTS", graph)

    def test_audio_is_resampled_onto_the_video_clock(self) -> None:
        arguments = self.build(manifest())
        self.assertIn("-af", arguments)
        self.assertIn("aresample=async=1", arguments[arguments.index("-af") + 1])
