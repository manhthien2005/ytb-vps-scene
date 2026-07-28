# tests_v2/support/fixtures.py
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

HARDSUB_TEXT = "这是中文硬字幕测试内容"
_CJK_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
)
CJK_FONT = next((path for path in _CJK_CANDIDATES if Path(path).is_file()), None)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _run(arguments: list[str]) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments],
        check=True, capture_output=True, timeout=300,
    )


def _escape_font(path: str) -> str:
    # drawtext parses ':' as an option separator, so a Windows drive letter must be escaped.
    return path.replace(":", r"\:")


def _base(destination: Path, *, size: str, rate: str, seconds: int, audio: bool) -> Path:
    arguments = ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={seconds}"]
    if audio:
        arguments += ["-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}"]
    arguments += ["-map", "0:v", *(["-map", "1:a", "-c:a", "aac"] if audio else ["-an"])]
    arguments += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(destination)]
    _run(arguments)
    return destination


def build_fixture(kind: str, root: Path) -> Path:
    """Build fixture `kind` into `root`, returning root/<kind>.mp4.

    Caching is atomic on purpose. Presence alone is not proof of a good file: an
    ffmpeg run killed midway leaves a readable-but-truncated container, and a
    cache keyed on existence would hand that corpse to every later test forever."""
    root.mkdir(parents=True, exist_ok=True)
    final = root / f"{kind}.mp4"
    if final.exists():
        return final
    staging = root / f".{kind}.partial.mp4"
    try:
        _build_into(kind, staging, root)
        staging.replace(final)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise
    return final


def _build_into(kind: str, destination: Path, root: Path) -> Path:
    """Write fixture `kind` to the exact path `destination`.

    `root` is still needed: several kinds are derived from a cached base fixture."""
    if kind == "cfr30":
        return _base(destination, size="640x360", rate="30", seconds=6, audio=True)
    if kind == "cfr25":
        return _base(destination, size="640x360", rate="25", seconds=6, audio=True)
    if kind == "cfr23976":
        return _base(destination, size="640x360", rate="24000/1001", seconds=6, audio=True)
    if kind == "no_audio":
        return _base(destination, size="640x360", rate="30", seconds=6, audio=False)
    if kind == "vertical":
        return _base(destination, size="360x640", rate="30", seconds=6, audio=True)

    if kind == "vfr":
        source = build_fixture("cfr30", root)
        _run(["-i", str(source), "-vf", "select='not(mod(n,3))'", "-vsync", "vfr",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(destination)])
        return destination

    if kind == "rot90":
        source = build_fixture("cfr30", root)
        _run(["-display_rotation", "90", "-i", str(source), "-c", "copy", str(destination)])
        return destination

    if kind == "sar2":
        source = build_fixture("cfr30", root)
        _run(["-i", str(source), "-vf", "setsar=2/1", "-c:v", "libx264",
              "-pix_fmt", "yuv420p", "-c:a", "copy", str(destination)])
        return destination

    if kind == "cover_art":
        source = build_fixture("cfr30", root)
        cover = root / "cover.png"
        _run(["-f", "lavfi", "-i", "color=red:size=64x64:d=0.04", "-frames:v", "1", str(cover)])
        _run(["-i", str(source), "-i", str(cover), "-map", "0", "-map", "1",
              "-c", "copy", "-disposition:v:1", "attached_pic", str(destination)])
        return destination

    if kind == "two_audio":
        source = build_fixture("cfr30", root)
        _run(["-i", str(source), "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
              "-map", "0:v", "-map", "0:a", "-map", "1:a",
              "-c:v", "copy", "-c:a", "aac", str(destination)])
        return destination

    if kind == "letterbox":
        _run(["-f", "lavfi", "-i", "testsrc2=size=640x270:rate=30:duration=6",
              "-vf", "pad=640:360:0:45:black", "-c:v", "libx264",
              "-pix_fmt", "yuv420p", "-an", str(destination)])
        return destination

    if kind == "ten_bit":
        _run(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
              "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-profile:v", "high10",
              "-an", str(destination)])
        return destination

    if kind == "hdr_pq":
        # BT.2020 primaries + SMPTE 2084 transfer is what a real HDR download carries;
        # a bare format=yuv420p crushes it to a dark, desaturated frame.
        _run(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
              "-vf", "format=yuv420p10le",
              "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-profile:v", "high10",
              "-color_primaries", "bt2020", "-color_trc", "smpte2084",
              "-colorspace", "bt2020nc", "-color_range", "tv",
              "-an", str(destination)])
        return destination

    if kind == "no_text":
        _run(["-f", "lavfi", "-i", "color=c=0x203040:size=640x360:rate=30:duration=6",
              "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
              "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
              "-c:a", "aac", str(destination)])
        return destination

    if kind == "hardsub_cn":
        if CJK_FONT is None:
            raise RuntimeError("hardsub_cn fixture requires a CJK font")
        font = _escape_font(CJK_FONT)
        drawtext = (
            f"drawtext=fontfile='{font}':text='{HARDSUB_TEXT}':fontsize=44:"
            "fontcolor=white:borderw=3:bordercolor=black:"
            "x=(w-text_w)/2:y=h-110:enable='between(t,1,4)'"
        )
        _run(["-f", "lavfi", "-i", "color=c=0x1a1a2e:size=1280x720:rate=30:duration=6",
              "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
              "-map", "0:v", "-map", "1:a", "-vf", drawtext,
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(destination)])
        return destination

    raise ValueError(f"unknown fixture kind: {kind}")
