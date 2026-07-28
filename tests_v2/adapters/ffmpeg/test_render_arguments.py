from __future__ import annotations

import array
import hashlib
import math
import shutil
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.ffmpeg.media import (
    FfmpegMediaAdapter,
    FfmpegMediaError,
    RenderInputs,
)
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import (
    BlurRegion,
    BoundingBox,
    Cue,
    JobId,
    Part,
    RegionKind,
)
from ytb_vps_v2.domain.pipeline import TTS_ARTIFACT_PATH, RenderRequest
from ytb_vps_v2.domain.timeline import FrameInterval

DIGEST = FileDigest(1024, hashlib.sha256(b"x").hexdigest())


def request(*, output_has_audio: bool = True, frames: int = 900) -> RenderRequest:
    return RenderRequest(
        1,
        JobId("job-1"),
        DIGEST,
        frames,
        1280,
        720,
        TTS_ARTIFACT_PATH,
        DIGEST,
        (
            Cue(
                1,
                FrameInterval(30, 120),
                BoundingBox(0, 580, 1280, 676),
                "源",
                "xin chào",
            ),
        ),
        (
            BlurRegion(
                RegionKind.STATIC,
                FrameInterval(0, frames),
                BoundingBox(1064, 14, 1264, 78),
            ),
        ),
        PurePosixPath("artifacts/tts/voice.wav"),
        DIGEST,
        (Part(1, 1, FrameInterval(0, frames), (0,)),),
        output_has_audio,
    )


def inputs(**overrides: object) -> RenderInputs:
    values = dict(
        source=Path("in.mp4"),
        subtitle_path=Path("chunk.ass"),
        voice_paths=(Path("g0.wav"),),
        voice_starts=(Fraction(1),),
        source_has_audio=True,
    )
    values.update(overrides)
    return RenderInputs(**values)  # type: ignore[arg-type]


def build(
    plan: RenderRequest,
    value: RenderInputs,
    encoder: str = "libx264",
    target_fps: int = 30,
) -> list[str]:
    return FfmpegMediaAdapter().render_arguments(
        plan,
        value,
        canvas_width=1280,
        canvas_height=720,
        target_fps=target_fps,
        destination=Path("out.mp4"),
        encoder=encoder,
    )


def graph(arguments: list[str]) -> str:
    return arguments[arguments.index("-filter_complex") + 1]


class RenderInputTests(unittest.TestCase):
    def test_each_voice_path_needs_one_start_time(self) -> None:
        with self.assertRaises(FfmpegMediaError):
            inputs(voice_starts=())


class VideoGraphTests(unittest.TestCase):
    def test_blur_region_reaches_the_filter_graph(self) -> None:
        self.assertIn("boxblur=", graph(build(request(), inputs())))

    def test_full_timeline_region_is_explicitly_always_on(self) -> None:
        self.assertNotIn("enable=", graph(build(request(), inputs())))

    def test_subtitle_file_reaches_the_filter_graph(self) -> None:
        self.assertIn("subtitles=", graph(build(request(), inputs())))

    def test_render_no_longer_uses_the_no_op_scale_chain(self) -> None:
        arguments = build(request(), inputs())
        self.assertNotIn("-vf", arguments)

    def test_video_output_is_mapped_from_the_graph(self) -> None:
        self.assertIn("[vout]", build(request(), inputs()))


class AudioTests(unittest.TestCase):
    def test_voice_input_is_added_and_delayed(self) -> None:
        arguments = build(request(), inputs())
        self.assertIn("g0.wav", arguments)
        self.assertIn("adelay=1000|1000", graph(arguments))

    def test_audio_output_is_mapped_from_the_graph(self) -> None:
        self.assertIn("[aout]", build(request(), inputs()))

    def test_source_without_audio_uses_the_voice_bus_only(self) -> None:
        text = graph(build(request(), inputs(source_has_audio=False)))
        self.assertNotIn("[0:a]", text)
        self.assertIn("[1:a]", text)

    def test_silent_output_disables_audio(self) -> None:
        arguments = build(
            request(output_has_audio=False),
            inputs(voice_paths=(), voice_starts=()),
        )
        self.assertIn("-an", arguments)

    def test_audio_duration_follows_the_frame_count_and_target_rate(self) -> None:
        arguments = build(
            request(frames=90_000),
            inputs(),
            target_fps=25,
        )
        self.assertIn("apad=whole_dur=3600.000", graph(arguments))
        self.assertNotIn("whole_dur=30", graph(arguments))


class EncoderTests(unittest.TestCase):
    def test_nvenc_is_selected_when_requested(self) -> None:
        arguments = build(request(), inputs(), encoder="h264_nvenc")
        self.assertIn("h264_nvenc", arguments)
        self.assertNotIn("-crf", arguments)

    def test_libx264_is_the_fallback_and_writes_bt709_vui(self) -> None:
        arguments = build(request(), inputs(), encoder="libx264")
        self.assertIn("libx264", arguments)
        self.assertIn("-crf", arguments)
        self.assertIn(
            "colorprim=bt709:transfer=bt709:colormatrix=bt709",
            arguments,
        )

    def test_frame_count_is_not_hard_coded_to_900(self) -> None:
        arguments = build(request(frames=108_000), inputs())
        self.assertEqual(arguments[arguments.index("-frames:v") + 1], "108000")


class GraphScriptTests(unittest.TestCase):
    def test_large_filter_graph_is_externalized_out_of_the_argument_list(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "filter.txt"
            large_graph = "[0:v]" + ("null," * 8_000) + "format=yuv420p[vout]"
            arguments = ["ffmpeg", "-filter_complex", large_graph, "out.mp4"]

            externalized = FfmpegMediaAdapter._externalize_filter_graph(
                arguments,
                script,
            )

            self.assertNotIn("-filter_complex", externalized)
            self.assertEqual(
                externalized[externalized.index("-filter_complex_script") + 1],
                str(script),
            )
            self.assertNotIn(large_graph, externalized)
            self.assertEqual(script.read_text(encoding="utf-8"), large_graph)


class RuntimeBudgetTests(unittest.TestCase):
    def test_default_timeouts_do_not_cancel_hour_long_media_work(self) -> None:
        adapter = FfmpegMediaAdapter()
        self.assertGreaterEqual(adapter.probe_timeout_seconds, 3_600)
        self.assertGreaterEqual(adapter.render_timeout_seconds, 3_600)
        self.assertGreaterEqual(adapter.decode_timeout_seconds, 3_600)


def _run_ffmpeg(arguments: list[str]) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments],
        check=True,
        capture_output=True,
        timeout=180,
    ).stdout


def _gray_crop(
    video: Path,
    *,
    at_seconds: float,
    x: int,
    y: int,
    width: int,
    height: int,
) -> bytes:
    return _run_ffmpeg(
        [
            "-ss",
            str(at_seconds),
            "-i",
            str(video),
            "-vf",
            f"crop={width}:{height}:{x}:{y},format=gray",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ]
    )


def _edge_energy(frame: bytes, *, width: int, height: int) -> float:
    horizontal = sum(
        abs(frame[row * width + column] - frame[row * width + column - 1])
        for row in range(height)
        for column in range(1, width)
    )
    vertical = sum(
        abs(frame[row * width + column] - frame[(row - 1) * width + column])
        for row in range(1, height)
        for column in range(width)
    )
    comparisons = height * (width - 1) + (height - 1) * width
    return (horizontal + vertical) / comparisons


def _band_rms(
    video: Path,
    *,
    start_seconds: float,
    duration_seconds: float,
) -> float:
    raw = _run_ffmpeg(
        [
            "-ss",
            str(start_seconds),
            "-i",
            str(video),
            "-t",
            str(duration_seconds),
            "-vn",
            "-af",
            "bandpass=f=220:width_type=h:width=40",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-",
        ]
    )
    samples = array.array("h")
    samples.frombytes(raw)
    return math.sqrt(
        sum(sample * sample for sample in samples) / len(samples)
    ) / 32768


@unittest.skipUnless(
    shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
    "ffmpeg and ffprobe required",
)
class RenderIntegrationTests(unittest.TestCase):
    def test_render_applies_blur_ass_subtitles_and_audio_ducking(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root)
            source = workspace / "source.mp4"
            voice = workspace / "voice.wav"
            output = workspace / "output.mp4"
            _run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:size=640x360:rate=30:duration=3",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x100:rate=30:duration=3",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=220:sample_rate=48000:duration=3",
                    "-filter_complex",
                    "[0:v][1:v]overlay=0:0:shortest=1[v]",
                    "-map",
                    "[v]",
                    "-map",
                    "2:a",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    str(source),
                ]
            )
            _run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=1000:sample_rate=48000:duration=2",
                    "-c:a",
                    "pcm_s16le",
                    str(voice),
                ]
            )

            adapter = FfmpegMediaAdapter()
            media = adapter.probe(source)
            plan = RenderRequest(
                1,
                JobId("render-integration"),
                media.source_digest,
                media.frame_count,
                media.width,
                media.height,
                TTS_ARTIFACT_PATH,
                DIGEST,
                (
                    Cue(
                        1,
                        FrameInterval(30, 60),
                        BoundingBox(0, 260, 640, 350),
                        "source",
                        "Phụ đề tiếng Việt",
                    ),
                ),
                (
                    BlurRegion(
                        RegionKind.STATIC,
                        FrameInterval(0, media.frame_count),
                        BoundingBox(0, 0, 320, 100),
                    ),
                ),
                PurePosixPath("artifacts/tts/voice.wav"),
                adapter._digest(voice),
                (
                    Part(
                        1,
                        1,
                        FrameInterval(0, media.frame_count),
                        (0,),
                    ),
                ),
                True,
            )

            adapter.render(source, voice, plan, output)

            source_mask = _gray_crop(
                source,
                at_seconds=1.5,
                x=0,
                y=0,
                width=320,
                height=100,
            )
            output_mask = _gray_crop(
                output,
                at_seconds=1.5,
                x=0,
                y=0,
                width=320,
                height=100,
            )
            self.assertLess(
                _edge_energy(output_mask, width=320, height=100),
                _edge_energy(source_mask, width=320, height=100) * 0.5,
            )

            source_subtitle = _gray_crop(
                source,
                at_seconds=1.5,
                x=0,
                y=260,
                width=640,
                height=90,
            )
            output_subtitle = _gray_crop(
                output,
                at_seconds=1.5,
                x=0,
                y=260,
                width=640,
                height=90,
            )
            self.assertGreater(
                sum(value > 200 for value in output_subtitle),
                sum(value > 200 for value in source_subtitle) + 50,
            )

            ducked = _band_rms(
                output,
                start_seconds=0.5,
                duration_seconds=0.8,
            )
            recovered = _band_rms(
                output,
                start_seconds=2.6,
                duration_seconds=0.3,
            )
            self.assertLess(ducked, recovered * 0.75)
