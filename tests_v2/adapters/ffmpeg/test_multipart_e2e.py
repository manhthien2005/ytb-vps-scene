from __future__ import annotations

import array
import copy
import json
import math
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from tests_v2.support.fixtures import ffmpeg_available
from ytb_vps_v2.adapters import native_media_job
from ytb_vps_v2.adapters.native_media_job import run_native_pipeline
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicWaveTtsProvider,
)
from ytb_vps_v2.application.media_job import MediaOutput
from ytb_vps_v2.domain.config import EffectiveConfig


def _run(arguments: list[str], *, timeout: int = 300) -> bytes:
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        timeout=timeout,
    ).stdout


def _duration(path: Path) -> float:
    return float(
        _run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ]
        ).decode().strip()
    )


def _video_pts(path: Path) -> tuple[float, ...]:
    payload = json.loads(
        _run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_frames",
                "-show_entries",
                "frame=best_effort_timestamp_time",
                "-of",
                "json",
                str(path),
            ]
        )
    )
    return tuple(
        float(frame["best_effort_timestamp_time"])
        for frame in payload["frames"]
    )


def _audio_rms(path: Path, *, start: float, duration: float) -> float:
    raw = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
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
    if not samples:
        return 0.0
    return math.sqrt(
        sum(sample * sample for sample in samples) / len(samples)
    ) / 32768


def _top_band_mean(path: Path, *, frame_index: int) -> float:
    raw = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-vf",
            (
                f"select=eq(n\\,{frame_index}),"
                "crop=320:36:0:0,format=gray"
            ),
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ]
    )
    if len(raw) != 320 * 36:
        raise AssertionError("expected one decoded top-band frame")
    return sum(raw) / len(raw)


@unittest.skipUnless(ffmpeg_available(), "ffmpeg and ffprobe required")
class MultipartNativePipelineEndToEndTests(unittest.TestCase):
    def test_real_pipeline_preserves_multipart_timeline_and_audio(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root)
            source = workspace / "source.mp4"
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    (
                        "nullsrc=size=320x180:rate=30:duration=12,"
                        "geq=lum='32+mod(N*73\\,192)':cb=128:cr=128"
                    ),
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=12",
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-frames:v",
                    "360",
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
                    "120",
                    "-keyint_min",
                    "120",
                    "-sc_threshold",
                    "0",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    str(source),
                ],
                timeout=180,
            )
            default = EffectiveConfig()
            config = replace(
                default,
                media=replace(default.media, chunk_seconds=4),
                render=replace(default.render, max_part_seconds=8),
            )
            settings = {
                "version": 3,
                "regions": [],
                "rate": 1.0,
            }
            with mock.patch.object(
                native_media_job,
                "CapCutTtsProvider",
                return_value=DeterministicWaveTtsProvider(),
            ):
                outputs = run_native_pipeline(
                    source,
                    workspace / "workspace",
                    copy.deepcopy(settings),
                    "native-multipart-e2e",
                    config=config,
                )

            self.assertEqual(
                tuple(
                    (
                        output.part_index,
                        output.part_count,
                        output.path.name,
                    )
                    for output in outputs
                ),
                (
                    (1, 2, "part-01-of-02.mp4"),
                    (2, 2, "part-02-of-02.mp4"),
                ),
            )
            self.assertTrue(
                all(type(output) is MediaOutput for output in outputs)
            )
            expected_frames = (240, 120)
            expected_durations = (8.0, 4.0)
            for output, frame_count, expected_duration in zip(
                outputs,
                expected_frames,
                expected_durations,
                strict=True,
            ):
                self.assertTrue(output.path.is_file())
                self.assertAlmostEqual(
                    _duration(output.path),
                    expected_duration,
                    delta=1 / 30,
                )
                pts = _video_pts(output.path)
                self.assertEqual(len(pts), frame_count)
                self.assertAlmostEqual(pts[0], 0.0, delta=1 / 30)
                self.assertAlmostEqual(
                    pts[-1] - pts[0],
                    (frame_count - 1) / 30,
                    delta=1 / 30,
                )
                self.assertGreater(
                    _audio_rms(
                        output.path,
                        start=0.0,
                        duration=0.5,
                    ),
                    0.001,
                )
                self.assertGreater(
                    _audio_rms(
                        output.path,
                        start=expected_duration - 0.5,
                        duration=0.5,
                    ),
                    0.001,
                )

            self.assertAlmostEqual(
                sum(_duration(output.path) for output in outputs),
                _duration(source),
                delta=1 / 30,
            )
            for output_path, output_frame, source_frame in (
                (outputs[0].path, 0, 0),
                (outputs[0].path, 239, 239),
                (outputs[1].path, 0, 240),
                (outputs[1].path, 119, 359),
            ):
                with self.subTest(
                    output=output_path.name,
                    frame=output_frame,
                ):
                    self.assertAlmostEqual(
                        _top_band_mean(
                            output_path,
                            frame_index=output_frame,
                        ),
                        _top_band_mean(
                            source,
                            frame_index=source_frame,
                        ),
                        delta=8.0,
                    )


if __name__ == "__main__":
    unittest.main()
