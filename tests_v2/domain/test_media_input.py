# tests_v2/domain/test_media_input.py
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.media_input import ColourProfile, FrameRateMode, InputManifest


def manifest(**overrides: object) -> InputManifest:
    values = dict(
        video_stream_index=0,
        audio_stream_index=1,
        storage_width=1280,
        storage_height=720,
        rotation_degrees=0,
        sample_aspect_ratio=Fraction(1),
        frame_rate=Fraction(30),
        frame_rate_mode=FrameRateMode.CFR,
        colour=ColourProfile("bt709", "bt709", "bt709", "tv", 8),
        start_time_seconds=Fraction(0),
        duration_seconds=Fraction(6),
        rejected_audio_indexes=(),
        subtitle_stream_indexes=(),
    )
    values.update(overrides)
    return InputManifest(**values)  # type: ignore[arg-type]


class DisplaySizeTests(unittest.TestCase):
    def test_square_pixels_upright_keeps_storage_size(self) -> None:
        self.assertEqual(manifest().display_size, (1280, 720))

    def test_rotation_90_swaps_axes(self) -> None:
        self.assertEqual(manifest(rotation_degrees=90).display_size, (720, 1280))

    def test_rotation_270_swaps_axes(self) -> None:
        self.assertEqual(manifest(rotation_degrees=270).display_size, (720, 1280))

    def test_rotation_180_keeps_axes(self) -> None:
        self.assertEqual(manifest(rotation_degrees=180).display_size, (1280, 720))

    def test_anamorphic_widens_before_rotation_is_applied(self) -> None:
        self.assertEqual(manifest(sample_aspect_ratio=Fraction(2)).display_size, (2560, 720))

    def test_rotation_and_sar_compose(self) -> None:
        value = manifest(rotation_degrees=90, sample_aspect_ratio=Fraction(2))
        self.assertEqual(value.display_size, (720, 2560))


class ValidationTests(unittest.TestCase):
    def test_rotation_must_be_a_quarter_turn(self) -> None:
        with self.assertRaises(DomainInvariantError):
            manifest(rotation_degrees=45)

    def test_sample_aspect_ratio_must_be_positive(self) -> None:
        with self.assertRaises(DomainInvariantError):
            manifest(sample_aspect_ratio=Fraction(0))

    def test_audio_stream_index_may_be_absent(self) -> None:
        self.assertIsNone(manifest(audio_stream_index=None).audio_stream_index)
