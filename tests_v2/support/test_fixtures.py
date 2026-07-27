# tests_v2/support/test_fixtures.py
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests_v2.support.fixtures import build_fixture, ffmpeg_available


def probe(path: Path) -> dict:
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, check=True, text=True,
    ).stdout
    return json.loads(raw)


@unittest.skipUnless(ffmpeg_available(), "ffmpeg/ffprobe required")
class FixtureShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_cover_art_fixture_has_two_video_streams(self) -> None:
        payload = probe(build_fixture("cover_art", self.root))
        videos = [s for s in payload["streams"] if s["codec_type"] == "video"]
        self.assertEqual(len(videos), 2)
        self.assertTrue(any(s.get("disposition", {}).get("attached_pic") for s in videos))

    def test_rot90_fixture_declares_rotation_side_data(self) -> None:
        payload = probe(build_fixture("rot90", self.root))
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        rotations = [
            item.get("rotation")
            for item in video.get("side_data_list", [])
            if "rotation" in item
        ]
        self.assertIn(90, [abs(int(value)) for value in rotations])

    def test_sar2_fixture_declares_non_square_pixels(self) -> None:
        payload = probe(build_fixture("sar2", self.root))
        video = next(s for s in payload["streams"] if s["codec_type"] == "video")
        self.assertEqual(video["sample_aspect_ratio"], "2:1")

    def test_no_audio_fixture_has_no_audio_stream(self) -> None:
        payload = probe(build_fixture("no_audio", self.root))
        self.assertFalse([s for s in payload["streams"] if s["codec_type"] == "audio"])
