# tests_v2/adapters/ffmpeg/test_probe.py
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ffmpeg.probe import ProbeError, parse_probe_payload
from ytb_vps_v2.domain.media_input import FrameRateMode


def video_stream(index: int = 0, **overrides: object) -> dict:
    stream = {
        "index": index, "codec_type": "video", "width": 1280, "height": 720,
        "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
        "sample_aspect_ratio": "1:1", "pix_fmt": "yuv420p",
        "color_primaries": "bt709", "color_transfer": "bt709",
        "color_space": "bt709", "color_range": "tv",
        "start_time": "0.000000", "duration": "6.000000",
        "disposition": {"attached_pic": 0, "default": 1},
    }
    stream.update(overrides)
    return stream


def audio_stream(index: int = 1, **overrides: object) -> dict:
    stream = {"index": index, "codec_type": "audio", "start_time": "0.000000",
              "disposition": {"default": 1}}
    stream.update(overrides)
    return stream


def payload(*streams: dict, duration: str = "6.000000") -> dict:
    return {"streams": list(streams), "format": {"duration": duration}}


class StreamSelectionTests(unittest.TestCase):
    def test_attached_picture_is_not_treated_as_the_video_stream(self) -> None:
        cover = video_stream(index=2, width=64, height=64,
                             disposition={"attached_pic": 1, "default": 0})
        manifest = parse_probe_payload(payload(video_stream(0), audio_stream(1), cover))
        self.assertEqual(manifest.video_stream_index, 0)
        self.assertEqual(manifest.storage_width, 1280)

    def test_first_default_audio_track_wins_and_others_are_recorded(self) -> None:
        manifest = parse_probe_payload(
            payload(video_stream(0), audio_stream(1), audio_stream(2, disposition={"default": 0}))
        )
        self.assertEqual(manifest.audio_stream_index, 1)
        self.assertEqual(manifest.rejected_audio_indexes, (2,))

    def test_missing_audio_yields_none(self) -> None:
        self.assertIsNone(parse_probe_payload(payload(video_stream(0))).audio_stream_index)

    def test_audio_only_input_is_rejected(self) -> None:
        with self.assertRaises(ProbeError):
            parse_probe_payload(payload(audio_stream(0)))


class GeometryTests(unittest.TestCase):
    def test_rotation_side_data_is_read(self) -> None:
        stream = video_stream(side_data_list=[{"side_data_type": "Display Matrix",
                                              "rotation": -90}])
        self.assertEqual(parse_probe_payload(payload(stream)).rotation_degrees, 90)

    def test_undefined_sample_aspect_ratio_becomes_one(self) -> None:
        stream = video_stream(sample_aspect_ratio="0:1")
        self.assertEqual(parse_probe_payload(payload(stream)).sample_aspect_ratio, Fraction(1))


class TimingTests(unittest.TestCase):
    def test_mismatched_average_and_real_rate_is_variable(self) -> None:
        stream = video_stream(r_frame_rate="30/1", avg_frame_rate="17/1")
        manifest = parse_probe_payload(payload(stream))
        self.assertIs(manifest.frame_rate_mode, FrameRateMode.VFR)

    def test_decoded_evidence_overrides_container_duration(self) -> None:
        manifest = parse_probe_payload(
            payload(video_stream(0), duration="600.0"),
            duration_evidence_seconds=Fraction(6),
        )
        self.assertEqual(manifest.duration_seconds, Fraction(6))

    def test_container_duration_is_used_when_no_evidence_is_supplied(self) -> None:
        manifest = parse_probe_payload(payload(video_stream(0), duration="6.5"))
        self.assertEqual(manifest.duration_seconds, Fraction(13, 2))

    def test_negative_start_time_is_preserved(self) -> None:
        stream = video_stream(start_time="-0.500000")
        self.assertEqual(parse_probe_payload(payload(stream)).start_time_seconds,
                         Fraction(-1, 2))
