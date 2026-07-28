# tests_v2/adapters/ffmpeg/test_subtitles_ass.py
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ffmpeg.subtitles_ass import (
    SubtitleRectangle, SubtitleStyle, ass_timestamp, build_ass_document, escape_ass_text,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox, Cue
from ytb_vps_v2.domain.timeline import FrameInterval

RECTANGLE = SubtitleRectangle(Fraction(5, 100), Fraction(78, 100),
                              Fraction(90, 100), Fraction(16, 100))


def cue(index: int, start: int, end: int, target: str) -> Cue:
    return Cue(index, FrameInterval(start, end), BoundingBox(0, 600, 1280, 700), "源文本", target)


def document(*cues: Cue, style: SubtitleStyle | None = None) -> str:
    return build_ass_document(
        cues, canvas_width=1280, canvas_height=720, target_fps=30,
        rectangle=RECTANGLE, style=style or SubtitleStyle(),
    )


class TimestampTests(unittest.TestCase):
    def test_zero(self) -> None:
        self.assertEqual(ass_timestamp(Fraction(0)), "0:00:00.00")

    def test_centisecond_precision(self) -> None:
        self.assertEqual(ass_timestamp(Fraction(3, 2)), "0:00:01.50")

    def test_hours_minutes_seconds(self) -> None:
        self.assertEqual(ass_timestamp(Fraction(3661)), "1:01:01.00")

    def test_negative_time_clamps_to_zero(self) -> None:
        self.assertEqual(ass_timestamp(Fraction(-5)), "0:00:00.00")


class EscapeTests(unittest.TestCase):
    def test_braces_are_neutralised(self) -> None:
        self.assertNotIn("{", escape_ass_text("a {b} c"))

    def test_newlines_become_hard_breaks(self) -> None:
        self.assertEqual(escape_ass_text("a\nb"), r"a\Nb")

    def test_bare_carriage_returns_become_hard_breaks(self) -> None:
        self.assertEqual(escape_ass_text("a\rb"), r"a\Nb")

    def test_backslash_is_neutralised(self) -> None:
        self.assertNotIn("\\p", escape_ass_text(r"a\pos b"))

    def test_vietnamese_diacritics_survive(self) -> None:
        self.assertEqual(escape_ass_text("Đây là phụ đề"), "Đây là phụ đề")


class StyleValidationTests(unittest.TestCase):
    def test_ass_record_delimiters_are_rejected_in_style_fields(self) -> None:
        for field in ("font_name", "primary_colour", "outline_colour"):
            for character in ",\r\n{}":
                value = f"Arial{character}Injected" if field == "font_name" else (
                    f"&H00FF{character}FFFF"
                )
                with self.subTest(field=field, character=repr(character)):
                    with self.assertRaises(DomainInvariantError):
                        SubtitleStyle(**{field: value})

    def test_colours_must_use_ass_hex_notation(self) -> None:
        for field in ("primary_colour", "outline_colour"):
            with self.subTest(field=field):
                with self.assertRaises(DomainInvariantError):
                    SubtitleStyle(**{field: "white"})


class DocumentTests(unittest.TestCase):
    def test_play_resolution_matches_the_canvas(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"))
        self.assertIn("PlayResX: 1280", text)
        self.assertIn("PlayResY: 720", text)

    def test_font_size_follows_frame_height(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"))
        self.assertIn(",36,", text)  # 720 * 5%

    def test_margins_come_from_the_rectangle(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"))
        style_line = next(line for line in text.splitlines() if line.startswith("Style:"))
        fields = style_line.split(",")
        self.assertEqual(fields[-4:-1], ["64", "64", "43"])

    def test_each_cue_becomes_one_dialogue_event(self) -> None:
        text = document(cue(1, 30, 120, "một"), cue(2, 150, 240, "hai"))
        self.assertEqual(text.count("\nDialogue:"), 2)

    def test_frame_intervals_convert_to_wall_clock(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"))
        self.assertIn("0:00:01.00,0:00:04.00", text)

    def test_cues_without_a_translation_are_skipped(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"),
                        Cue(2, FrameInterval(150, 240), BoundingBox(0, 600, 1280, 700), "源"))
        self.assertEqual(text.count("\nDialogue:"), 1)

    def test_wrap_style_allows_libass_to_wrap_at_the_rectangle_margins(self) -> None:
        self.assertIn("WrapStyle: 0", document(cue(1, 30, 120, "xin chào")))

    def test_scaled_border_keeps_outline_proportional(self) -> None:
        self.assertIn("ScaledBorderAndShadow: yes", document(cue(1, 30, 120, "xin chào")))

    def test_fractional_outline_and_shadow_are_not_truncated_away(self) -> None:
        text = document(cue(1, 30, 120, "xin chào"))
        style_line = next(line for line in text.splitlines() if line.startswith("Style:"))
        fields = style_line.split(",")
        self.assertEqual(fields[16:18], ["2.2", "0.7"])

    def test_empty_cue_list_still_produces_a_loadable_document(self) -> None:
        text = document()
        self.assertIn("[Events]", text)
        self.assertNotIn("\nDialogue:", text)

    def test_document_is_utf8_encodable(self) -> None:
        document(cue(1, 30, 120, "Đây là phụ đề tiếng Việt")).encode("utf-8")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
