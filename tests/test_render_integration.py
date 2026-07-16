from __future__ import annotations

import logging
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tests.support import test_settings
from ytb_vps.media import executable, probe_video, run_ffmpeg
from ytb_vps.render import (
    _logo_layer,
    _scheduled_tts_groups,
    schedule_cue_subtitles,
    _subtitle_band_geometry,
    compose_audio_chunk,
    mux_chunk,
    render_video_chunk,
    speed_up_media,
    validate_final,
)


class RenderIntegrationTests(unittest.TestCase):
    def test_subtitles_follow_scheduled_audio_overflow(self) -> None:
        cues = [
            {"cue_index": 1, "start_frame": 0, "end_frame": 30, "target_text": "Mot"},
            {"cue_index": 2, "start_frame": 30, "end_frame": 60, "target_text": "Hai"},
        ]
        subtitles = schedule_cue_subtitles(
            cues,
            [
                {
                    "group_index": 0,
                    "start_seconds": 0.0,
                    "end_seconds": 2.0,
                    "metadata": {"fitted_seconds": 3.0, "cue_indices": [1, 2]},
                }
            ],
            fps=30,
        )
        self.assertEqual(subtitles[0]["start_frame"], 0)
        self.assertEqual(subtitles[-1]["end_frame"], 90)

    def test_micro_spill_delays_following_tts_without_overlap(self) -> None:
        groups = _scheduled_tts_groups(
            [
                {
                    "group_index": 1,
                    "start_seconds": 10.0,
                    "end_seconds": 11.2,
                    "metadata": {"fitted_seconds": 0.95},
                },
                {
                    "group_index": 2,
                    "start_seconds": 10.5,
                    "end_seconds": 13.0,
                    "metadata": {"fitted_seconds": 2.0},
                },
            ]
        )

        self.assertAlmostEqual(groups[0]["mix_start_seconds"], 10.0)
        self.assertAlmostEqual(groups[0]["mix_end_seconds"], 10.95)
        self.assertAlmostEqual(groups[1]["mix_start_seconds"], 10.95)
        self.assertAlmostEqual(groups[1]["mix_end_seconds"], 12.95)

    def test_subtitle_band_auto_uses_bottom_cjk_cues(self) -> None:
        render = {
            "subtitle_band_auto": True,
            "subtitle_band_candidate_min_y_ratio": 0.86,
            "subtitle_band_y_percentile": 0.05,
            "subtitle_band_x_ratio": 0.0,
            "subtitle_band_y_ratio": 0.83,
            "subtitle_band_width_ratio": 1.0,
            "subtitle_band_height_ratio": 0.14,
            "box_padding_y": 4,
            "subtitle_band_y_offset_ratio": 0.025,
        }
        cues = [
            {"source_text": "YE", "ymin": 417, "ymax": 523},
            {"source_text": "\u8d77\u6728", "ymin": 417, "ymax": 473},
            {"source_text": "\u613f\u521b\u7167", "ymin": 614, "ymax": 688},
            {"source_text": "\u6211\u5e2e\u60a8", "ymin": 620, "ymax": 688},
            {"source_text": "\u884c\u4e86", "ymin": 628, "ymax": 688},
            {"source_text": "\u4e0d\u5bf9", "ymin": 622, "ymax": 688},
            {"source_text": "\u4f60\u76f4\u574f", "ymin": 624, "ymax": 688},
        ]

        self.assertEqual(
            _subtitle_band_geometry(render, width=1280, height=720, cues=cues),
            (0, 624, 1280, 90),
        )

    def test_bounded_render_audio_mux_and_decode(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root,
                render={"preset": "ultrafast", "crf": 28, "font_size": 18, "outline": 2},
            )
            source = root / "source.mp4"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=320x180:rate=30:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=44100:duration=2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(source),
                ],
                duration_seconds=2,
            )
            media = probe_video(source)
            chunk = {
                "chunk_index": 0,
                "start_frame": 0,
                "end_frame": 60,
                "start_seconds": 0.0,
                "end_seconds": 2.0,
            }
            cues = [
                {
                    "cue_index": 1,
                    "start_frame": 5,
                    "end_frame": 50,
                    "xmin": 70,
                    "ymin": 130,
                    "xmax": 250,
                    "ymax": 165,
                    "source_text": "你好",
                    "target_text": "Xin chào Việt Nam",
                }
            ]
            video = root / "rendered.mp4"
            render_video_chunk(
                settings=settings,
                input_path=source,
                output_path=video,
                media=media,
                chunk=chunk,
                cues=cues,
                logger=logging.getLogger("render-test"),
            )
            audio = root / "audio.m4a"
            compose_audio_chunk(groups=[], chunk=chunk, output=audio)
            final = root / "final.mp4"
            mux_chunk(video, audio, final)
            report = validate_final(final, media, 30)
            self.assertTrue(report["full_decode"])
            self.assertTrue(report["has_audio"])

    def test_speed_up_media_shortens_video_and_audio(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root,
                render={"encoder": "libx264", "preset": "ultrafast", "crf": 30},
            )
            source = root / "source.mp4"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=160x90:rate=30:duration=2.2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=44100:duration=2.2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(source),
                ],
                duration_seconds=2.2,
            )
            media = probe_video(source)
            output = root / "speed.mp4"
            speed_up_media(
                source,
                output,
                speed=1.1,
                render=settings.section("render"),
                threads=1,
            )
            report = validate_final(output, media, 30, duration_seconds=2.2 / 1.1)
            self.assertTrue(report["full_decode"])
            self.assertTrue(report["has_audio"])
            self.assertAlmostEqual(float(report["duration_seconds"]), 2.0, delta=0.5)

    def test_mirror_video_flips_frame_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root,
                render={
                    "encoder": "libx264",
                    "preset": "ultrafast",
                    "crf": 28,
                    "mirror_video": True,
                },
            )
            source = root / "source.mp4"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=32x32:r=30:d=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=32x32:r=30:d=1",
                    "-filter_complex",
                    "[0:v][1:v]hstack=inputs=2,format=yuv420p[v]",
                    "-map",
                    "[v]",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    str(source),
                ],
                duration_seconds=1,
            )
            media = probe_video(source)
            chunk = {
                "chunk_index": 0,
                "start_frame": 0,
                "end_frame": 30,
                "start_seconds": 0.0,
                "end_seconds": 1.0,
            }
            video = root / "mirrored.mp4"
            render_video_chunk(
                settings=settings,
                input_path=source,
                output_path=video,
                media=media,
                chunk=chunk,
                cues=[],
                logger=logging.getLogger("render-test"),
            )
            result = subprocess.run(
                [
                    executable("ffmpeg"),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                check=True,
            )
            first_frame = result.stdout
            left_pixel = first_frame[0:3]
            right_pixel = first_frame[(64 - 1) * 3 : 64 * 3]
            self.assertGreater(left_pixel[2], left_pixel[0])
            self.assertGreater(right_pixel[0], right_pixel[2])

    def test_render_overlays_logo_in_top_left(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            logo = root / "new-logo.png"
            Image.new("RGBA", (12, 12), (0, 255, 0, 255)).save(logo)
            settings = test_settings(
                root,
                render={
                    "encoder": "libx264",
                    "preset": "ultrafast",
                    "crf": 28,
                    "mirror_video": False,
                    "blur_mode": "none",
                    "logo_path": str(logo),
                    "logo_width_px": 12,
                    "logo_margin_x": 2,
                    "logo_margin_y": 2,
                },
            )
            source = root / "source.mp4"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=64x64:r=30:d=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    str(source),
                ],
                duration_seconds=1,
            )
            media = probe_video(source)
            chunk = {
                "chunk_index": 0,
                "start_frame": 0,
                "end_frame": 30,
                "start_seconds": 0.0,
                "end_seconds": 1.0,
            }
            video = root / "logo-output.mp4"
            render_video_chunk(
                settings=settings,
                input_path=source,
                output_path=video,
                media=media,
                chunk=chunk,
                cues=[],
                logger=logging.getLogger("render-test"),
            )
            result = subprocess.run(
                [
                    executable("ffmpeg"),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                check=True,
            )
            offset = ((2 * 64) + 2) * 3
            pixel = result.stdout[offset : offset + 3]
            self.assertGreater(pixel[1], 120)
            self.assertLess(pixel[0], 80)
            self.assertLess(pixel[2], 80)

    def test_logo_layer_uses_transparent_new_logo_when_legacy_logo_is_configured(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            legacy_logo = root / "logo.png"
            Image.new("RGB", (12, 12), (255, 255, 255)).save(legacy_logo)

            layer = _logo_layer(
                {"logo_enabled": True, "logo_path": str(legacy_logo)},
                frame_width=64,
                frame_height=64,
            )

            self.assertIsNotNone(layer)
            assert layer is not None
            _bgr, alpha, _x, _y = layer
            self.assertLess(float(alpha.min()), 1.0)


if __name__ == "__main__":
    unittest.main()
