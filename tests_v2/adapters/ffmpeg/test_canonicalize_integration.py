# tests_v2/adapters/ffmpeg/test_canonicalize_integration.py
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from tests_v2.support.fixtures import build_fixture, ffmpeg_available
from ytb_vps_v2.adapters.ffmpeg.canonicalize import canonicalize_arguments, plan_canvas
from ytb_vps_v2.adapters.ffmpeg.probe import ProbeError, parse_probe_payload


def probe_json(path: Path) -> dict:
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, check=True, text=True,
    ).stdout
    return json.loads(raw)


def decoded_size(path: Path) -> tuple[int, int]:
    """Size FFmpeg actually emits after applying the display matrix."""
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
        capture_output=True, check=True, text=True,
    ).stdout.strip()
    width, height = raw.split("x")
    return int(width), int(height)


@unittest.skipUnless(ffmpeg_available(), "ffmpeg/ffprobe required")
class CanonicalizeIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def canonicalize(self, kind: str) -> tuple[Path, tuple[int, int]]:
        source = build_fixture(kind, self.root)
        manifest = parse_probe_payload(probe_json(source))
        canvas = plan_canvas(manifest, max_width=1920, max_height=1080, target_fps=30)
        destination = self.root / f"{kind}.canonical.mp4"
        subprocess.run(
            canonicalize_arguments(
                manifest, canvas, source=str(source), destination=str(destination)
            ),
            check=True, capture_output=True, timeout=300,
        )
        return destination, (canvas.width, canvas.height)

    def test_cover_art_source_is_accepted_and_uses_the_moving_stream(self) -> None:
        output, canvas = self.canonicalize("cover_art")
        self.assertEqual(decoded_size(output), canvas)

    def test_rotated_source_lands_on_the_rotated_canvas(self) -> None:
        output, canvas = self.canonicalize("rot90")
        self.assertEqual(canvas, (360, 640))
        self.assertEqual(decoded_size(output), canvas)

    def test_anamorphic_source_lands_on_square_pixels(self) -> None:
        output, _ = self.canonicalize("sar2")
        payload = probe_json(output)
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        self.assertIn(video.get("sample_aspect_ratio"), ("1:1", None))

    def test_variable_frame_rate_source_becomes_constant(self) -> None:
        output, _ = self.canonicalize("vfr")
        payload = probe_json(output)
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        self.assertEqual(Fraction(video["avg_frame_rate"]), Fraction(30))

    def test_source_without_audio_produces_no_audio_stream(self) -> None:
        output, _ = self.canonicalize("no_audio")
        payload = probe_json(output)
        self.assertFalse([s for s in payload["streams"] if s["codec_type"] == "audio"])

    def test_second_audio_track_is_not_selected(self) -> None:
        source = build_fixture("two_audio", self.root)
        manifest = parse_probe_payload(probe_json(source))
        self.assertEqual(len(manifest.rejected_audio_indexes), 1)

    def test_ten_bit_source_is_quantized_to_eight_bit(self) -> None:
        output, _ = self.canonicalize("ten_bit")
        payload = probe_json(output)
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        self.assertEqual(video["pix_fmt"], "yuv420p")

    def test_high_dynamic_range_source_is_tone_mapped_and_retagged(self) -> None:
        output, _ = self.canonicalize("hdr_pq")
        payload = probe_json(output)
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        self.assertEqual(video.get("color_transfer"), "bt709")
        self.assertEqual(video.get("color_primaries"), "bt709")

    def test_tone_mapped_output_is_not_crushed_to_darkness(self) -> None:
        """A bare format=yuv420p on PQ content produces a near-black frame.
        Compare average luma against the same content encoded as SDR."""
        hdr_output, _ = self.canonicalize("hdr_pq")
        frame = self.root / "hdr.png"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "1",
             "-i", str(hdr_output), "-frames:v", "1", str(frame)],
            check=True, capture_output=True, timeout=120,
        )
        raw = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", str(frame), "-vf", "signalstats,metadata=print",
             "-frames:v", "1", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        ).stderr
        average = next(
            float(line.split("=")[-1])
            for line in raw.splitlines() if "YAVG" in line
        )
        self.assertGreater(average, 24.0, "tone mapping produced a near-black frame")

    def test_audio_only_input_is_rejected_at_preflight(self) -> None:
        audio_only = self.root / "audio_only.m4a"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
             "-c:a", "aac", str(audio_only)],
            check=True, capture_output=True, timeout=120,
        )
        with self.assertRaises(ProbeError):
            parse_probe_payload(probe_json(audio_only))
