from __future__ import annotations

import array
import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.ffmpeg.media import (
    FfmpegMediaAdapter,
    FfmpegMediaError,
    _concat_line,
)
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import JobId, Part
from ytb_vps_v2.domain.pipeline import TTS_ARTIFACT_PATH, RenderRequest
from ytb_vps_v2.domain.timeline import FrameInterval


DIGEST = FileDigest(1, hashlib.sha256(b"x").hexdigest())


def plan(*, frame_count: int = 180, chunk_count: int = 3) -> RenderRequest:
    return RenderRequest(
        1,
        JobId("concat-job"),
        DIGEST,
        frame_count,
        160,
        90,
        TTS_ARTIFACT_PATH,
        DIGEST,
        (),
        (),
        PurePosixPath("artifacts/tts/voice.wav"),
        DIGEST,
        (
            Part(
                1,
                1,
                FrameInterval(0, frame_count),
                tuple(range(chunk_count)),
            ),
        ),
        True,
    )


class ChunkConcatContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.chunks = tuple(
            self.root / f"chunk-{index}.mp4"
            for index in range(3)
        )
        for index, path in enumerate(self.chunks):
            path.write_bytes(f"chunk-{index}".encode("ascii"))
        self.adapter = FfmpegMediaAdapter()

    def test_manifest_line_escapes_absolute_apostrophe_path(self) -> None:
        folder = self.root / "director's cut"
        folder.mkdir()
        source = folder / "chunk.mp4"
        source.write_bytes(b"chunk")
        resolved = source.resolve(strict=True).as_posix()

        self.assertEqual(
            _concat_line(source),
            f"file '{resolved.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n",
        )

    def test_concat_arguments_use_safe_stream_copy_with_optional_audio(
        self,
    ) -> None:
        manifest = self.root / "chunks.txt"
        output = self.root / "output.mp4"

        arguments = self.adapter._concat_arguments(manifest, output)

        expected = (
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(manifest),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
        )
        joined = "\0".join(arguments)
        self.assertIn("\0".join(expected), joined)

    def test_rejects_empty_missing_duplicate_and_wrong_count(self) -> None:
        destination = self.root / "output.mp4"
        invalid = (
            (),
            (self.root / "missing.mp4",),
            (self.chunks[0], self.chunks[0], self.chunks[2]),
            self.chunks[:2],
        )
        for chunks in invalid:
            with self.subTest(chunks=chunks):
                with self.assertRaises(FfmpegMediaError):
                    self.adapter.concatenate_render_chunks(
                        chunks,
                        plan(),
                        destination,
                    )

    def test_rejects_symlink_chunk(self) -> None:
        link = self.root / "chunk-link.mp4"
        try:
            link.symlink_to(self.chunks[0])
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")

        with self.assertRaises(FfmpegMediaError):
            self.adapter.concatenate_render_chunks(
                (link, self.chunks[1], self.chunks[2]),
                plan(),
                self.root / "output.mp4",
            )


def _run_ffmpeg(arguments: list[str]) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments],
        check=True,
        capture_output=True,
        timeout=180,
    ).stdout


def _audio_rms(path: Path, *, start: float, duration: float) -> float:
    raw = _run_ffmpeg(
        [
            "-ss",
            str(start),
            "-i",
            str(path),
            "-t",
            str(duration),
            "-vn",
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


def _format_duration(path: Path) -> float:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return float(completed.stdout.strip())


@unittest.skipUnless(
    shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
    "ffmpeg and ffprobe required",
)
class ChunkConcatIntegrationTests(unittest.TestCase):
    def test_stream_copy_has_exact_seams_duration_and_final_audio(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / "director's chunks"
            workspace.mkdir()
            chunks = tuple(
                workspace / f"chunk-{index}.mp4"
                for index in range(3)
            )
            for index, chunk in enumerate(chunks):
                offset = index * 60
                _run_ffmpeg(
                    [
                        "-f",
                        "lavfi",
                        "-i",
                        (
                            "nullsrc=size=160x90:rate=30:duration=2,"
                            f"geq=lum='16+N+{offset}':cb=128:cr=128"
                        ),
                        "-f",
                        "lavfi",
                        "-i",
                        (
                            "sine=frequency=440:sample_rate=48000:"
                            "duration=2"
                        ),
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-frames:v",
                        "60",
                        "-r",
                        "30",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "medium",
                        "-qp",
                        "0",
                        "-pix_fmt",
                        "yuv420p",
                        "-g",
                        "60",
                        "-keyint_min",
                        "60",
                        "-sc_threshold",
                        "0",
                        "-c:a",
                        "aac",
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                        str(chunk),
                    ]
                )
            output = workspace / "joined.mp4"
            adapter = FfmpegMediaAdapter()

            rendered = adapter.concatenate_render_chunks(
                chunks,
                plan(),
                output,
            )

            self.assertEqual(rendered.frame_count, 180)
            self.assertEqual(rendered.duration_seconds, Fraction(6))
            self.assertTrue(rendered.has_audio)
            self.assertEqual(_format_duration(output), 6.0)
            self.assertGreater(
                _audio_rms(output, start=5.5, duration=0.5),
                0.001,
            )
            raw = _run_ffmpeg(
                [
                    "-i",
                    str(output),
                    "-map",
                    "0:v:0",
                    "-fps_mode",
                    "passthrough",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                    "-",
                ]
            )
            frame_size = 160 * 90
            self.assertEqual(len(raw), frame_size * 180)
            means = tuple(
                sum(raw[start : start + frame_size]) / frame_size
                for start in range(0, len(raw), frame_size)
            )
            for seam in (60, 120):
                with self.subTest(seam=seam):
                    delta = means[seam] - means[seam - 1]
                    self.assertGreater(delta, 0.5)
                    self.assertLess(delta, 2.0)


if __name__ == "__main__":
    unittest.main()
