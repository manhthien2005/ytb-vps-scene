from __future__ import annotations

import difflib
import importlib.util
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from tests_v2.support.fixtures import (
    CJK_FONT,
    HARDSUB_TEXT,
    build_fixture,
    ffmpeg_available,
)
from ytb_vps_v2.adapters.ffmpeg.filter_graph import MaskRegion, build_video_graph
from ytb_vps_v2.adapters.ffmpeg.subtitles_ass import (
    SubtitleRectangle,
    SubtitleStyle,
    build_ass_document,
)
from ytb_vps_v2.domain.models import BoundingBox, Cue
from ytb_vps_v2.domain.timeline import FrameInterval

HAS_OCR = importlib.util.find_spec("rapidocr_onnxruntime") is not None
BAND = BoundingBox(0, 580, 1280, 676)
MAX_RECOVERY = 0.10


def extract_frame(video: Path, at_seconds: float, destination: Path) -> Path:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(at_seconds),
            "-i",
            str(video),
            "-frames:v",
            "1",
            str(destination),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    return destination


def crop(image: Path, box: BoundingBox, destination: Path) -> Path:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(image),
            "-vf",
            (
                f"crop={box.xmax - box.xmin}:{box.ymax - box.ymin}:"
                f"{box.xmin}:{box.ymin}"
            ),
            "-frames:v",
            "1",
            str(destination),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    return destination


def recovered_text(image: Path) -> str:
    from rapidocr_onnxruntime import RapidOCR

    result, _ = RapidOCR()(str(image))
    return "".join(text for _, text, _ in (result or []))


def recovery_ratio(image: Path) -> float:
    return difflib.SequenceMatcher(
        None,
        HARDSUB_TEXT,
        recovered_text(image),
    ).ratio()


@unittest.skipUnless(ffmpeg_available(), "ffmpeg required")
@unittest.skipUnless(CJK_FONT is not None, "CJK font required")
class GoldenFrameTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = build_fixture("hardsub_cn", self.root)
        self.output = self.render()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def render(self) -> Path:
        subtitle = self.root / "chunk.ass"
        subtitle.write_text(
            build_ass_document(
                [
                    Cue(
                        1,
                        FrameInterval(30, 75),
                        BAND,
                        "源文本",
                        "Đây là phụ đề tiếng Việt",
                    )
                ],
                canvas_width=1280,
                canvas_height=720,
                target_fps=30,
                rectangle=SubtitleRectangle(
                    Fraction(5, 100),
                    Fraction(78, 100),
                    Fraction(90, 100),
                    Fraction(16, 100),
                ),
                style=SubtitleStyle(),
            ),
            encoding="utf-8",
        )
        graph = build_video_graph(
            [
                MaskRegion(
                    box=BAND,
                    intervals=((Fraction(4, 5), Fraction(5, 2)),),
                    glyph_height=44,
                )
            ],
            width=1280,
            height=720,
            subtitle_path=str(subtitle),
        )
        destination = self.root / "rendered.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(self.source),
                "-filter_complex",
                graph,
                "-map",
                "[vout]",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-an",
                str(destination),
            ],
            check=True,
            capture_output=True,
            timeout=300,
        )
        return destination

    @unittest.skipUnless(HAS_OCR, "rapidocr_onnxruntime required")
    def test_source_text_is_recoverable_before_blurring(self) -> None:
        frame = extract_frame(self.source, 2.0, self.root / "src.png")
        band = crop(frame, BAND, self.root / "src_band.png")
        self.assertGreater(recovery_ratio(band), 0.6)

    @unittest.skipUnless(HAS_OCR, "rapidocr_onnxruntime required")
    def test_blurred_band_defeats_optical_character_recognition(self) -> None:
        frame = extract_frame(self.output, 2.0, self.root / "out.png")
        band = crop(frame, BAND, self.root / "out_band.png")
        self.assertLess(recovery_ratio(band), MAX_RECOVERY)

    @unittest.skipUnless(HAS_OCR, "rapidocr_onnxruntime required")
    def test_concealment_survives_a_second_encode(self) -> None:
        reencoded = self.root / "reencoded.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(self.output),
                "-c:v",
                "libx264",
                "-crf",
                "28",
                "-an",
                str(reencoded),
            ],
            check=True,
            capture_output=True,
            timeout=300,
        )
        frame = extract_frame(reencoded, 2.0, self.root / "re.png")
        band = crop(frame, BAND, self.root / "re_band.png")
        self.assertLess(recovery_ratio(band), MAX_RECOVERY)

    @unittest.skipUnless(HAS_OCR, "rapidocr_onnxruntime required")
    def test_source_text_is_recoverable_after_the_mask_turns_off(self) -> None:
        clear = crop(
            extract_frame(self.output, 3.5, self.root / "clear.png"),
            BAND,
            self.root / "clear_band.png",
        )
        self.assertGreater(recovery_ratio(clear), 0.6)

    def test_output_keeps_the_source_duration(self) -> None:
        def duration(path: Path) -> float:
            raw = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "csv=p=0",
                    str(path),
                ],
                capture_output=True,
                check=True,
                text=True,
            ).stdout.strip()
            return float(raw)

        self.assertAlmostEqual(
            duration(self.output),
            duration(self.source),
            delta=0.1,
        )
