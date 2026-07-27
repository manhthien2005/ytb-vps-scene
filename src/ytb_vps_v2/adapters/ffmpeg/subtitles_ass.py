# src/ytb_vps_v2/adapters/ffmpeg/subtitles_ass.py
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Cue

_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: VI,{font},{size},{primary},{primary},{outline_colour},&H80000000,{bold},0,0,0,\
100,100,0,0,1,{outline},{shadow},2,{margin_l},{margin_r},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""


@dataclass(frozen=True, slots=True)
class SubtitleRectangle:
    x: Fraction
    y: Fraction
    width: Fraction
    height: Fraction

    def __post_init__(self) -> None:
        for name, value in (("x", self.x), ("y", self.y),
                            ("width", self.width), ("height", self.height)):
            if not isinstance(value, Fraction) or not 0 <= value <= 1:
                raise DomainInvariantError(f"Subtitle rectangle {name} must be a ratio 0..1")
        if self.width <= 0 or self.height <= 0:
            raise DomainInvariantError("Subtitle rectangle must have positive area")
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise DomainInvariantError("Subtitle rectangle must stay inside the frame")


@dataclass(frozen=True, slots=True)
class SubtitleStyle:
    font_name: str = "Arial"
    height_ratio: Fraction = Fraction(5, 100)
    outline_ratio: Fraction = Fraction(6, 100)
    shadow_ratio: Fraction = Fraction(2, 100)
    primary_colour: str = "&H00FFFFFF"
    outline_colour: str = "&H00000000"
    bold: bool = True
    max_lines: int = 2

    def __post_init__(self) -> None:
        if not isinstance(self.font_name, str) or not self.font_name.strip():
            raise DomainInvariantError("Subtitle font name must be non-empty")
        if not isinstance(self.height_ratio, Fraction) or not 0 < self.height_ratio <= 1:
            raise DomainInvariantError("Subtitle height ratio must be within (0, 1]")
        if not isinstance(self.max_lines, int) or self.max_lines < 1:
            raise DomainInvariantError("Subtitle max lines must be at least 1")


def ass_timestamp(seconds: Fraction) -> str:
    """Format a time as ASS's `H:MM:SS.cc`, the only precision the format carries.

    Clamps negatives to zero: a padded cue start can go below zero, and libass
    reads a leading '-' as a malformed field and drops the whole event."""
    total = max(Fraction(0), seconds)
    centiseconds = int(total * 100)
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole, hundredths = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole:02d}.{hundredths:02d}"


def escape_ass_text(value: str) -> str:
    """Neutralise ASS override syntax so translated text cannot inject styling.

    Translated text is machine-generated from OCR of an untrusted video, so it is
    not trusted input. In ASS, `{...}` delimits override tags and `\\` starts an
    escape, which together can reposition, restyle, or hide an event. Braces
    become parentheses and a backslash becomes U+2216 SET MINUS, a glyph that
    looks like a backslash but carries no meaning to the parser. The newline
    replacement runs last so the `\\N` hard breaks it emits survive."""
    return (
        value.replace("\\", "∖")
        .replace("{", "(")
        .replace("}", ")")
        .replace("\r\n", "\n")
        .replace("\n", r"\N")
    )


def build_ass_document(
    cues: Iterable[Cue],
    *,
    canvas_width: int,
    canvas_height: int,
    target_fps: int,
    rectangle: SubtitleRectangle,
    style: SubtitleStyle,
) -> str:
    """Render every translated cue as one ASS document for libass to draw.

    Sizes are derived from the canvas rather than fixed, so the same style holds
    at any resolution; ScaledBorderAndShadow keeps the outline proportional when
    libass renders at a different scale than PlayRes declares."""
    if target_fps <= 0:
        raise DomainInvariantError("Subtitle target FPS must be positive")
    size = max(1, int(canvas_height * style.height_ratio))
    header = _HEADER.format(
        width=canvas_width,
        height=canvas_height,
        font=style.font_name,
        size=size,
        primary=style.primary_colour,
        outline_colour=style.outline_colour,
        bold=-1 if style.bold else 0,
        outline=max(1, int(size * style.outline_ratio)),
        shadow=max(0, int(size * style.shadow_ratio)),
        margin_l=int(canvas_width * rectangle.x),
        margin_r=int(canvas_width * (1 - rectangle.x - rectangle.width)),
        # ASS MarginV measures from the bottom edge for bottom-anchored alignments.
        margin_v=int(canvas_height * (1 - rectangle.y - rectangle.height)),
    )
    lines = [header]
    for cue in cues:
        if cue.target_text is None or not cue.target_text.strip():
            continue
        start = ass_timestamp(Fraction(cue.interval.start_frame, target_fps))
        end = ass_timestamp(Fraction(cue.interval.end_frame, target_fps))
        lines.append(
            f"Dialogue: 0,{start},{end},VI,,0,0,0,,{escape_ass_text(cue.target_text.strip())}"
        )
    return "\n".join(lines) + "\n"
