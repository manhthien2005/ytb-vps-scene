from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ytb_vps.media import plan_chunks, plan_render_chunks
from ytb_vps.render import _subtitle_band_geometry
from ytb_vps.state import JobStore
from ytb_vps.subtitles import (
    build_blur_regions,
    build_cues,
    build_static_blur_regions,
    clean_ocr_text,
    parse_srt,
    write_srt,
)


class MediaSubtitleTests(unittest.TestCase):
    def test_subtitle_band_geometry_uses_most_common_ymax_cluster(self) -> None:
        cues = [
            {"source_text": "噪声", "ymin": 626, "ymax": 934},
            {"source_text": "字幕一", "ymin": 934, "ymax": 1076},
            {"source_text": "字幕二", "ymin": 937, "ymax": 1076},
            {"source_text": "字幕三", "ymin": 931, "ymax": 1076},
        ]
        result = _subtitle_band_geometry(
            {
                "subtitle_band_auto": True,
                "subtitle_band_x_ratio": 0.0,
                "subtitle_band_width_ratio": 1.0,
                "subtitle_band_candidate_min_y_ratio": 0.58,
                "subtitle_band_candidate_max_y_ratio": 0.98,
            },
            width=1920,
            height=1080,
            cues=cues,
        )
        self.assertEqual(result, (0, 931, 1920, 145))

    def test_subtitle_band_geometry_uses_full_width_auto_ocr_region(self) -> None:
        cues = [
            {"source_text": "\u4f60\u597d", "ymin": 604, "ymax": 648},
            {"source_text": "\u4e16\u754c", "ymin": 610, "ymax": 652},
            {"source_text": "\u5b57\u5e55", "ymin": 600, "ymax": 646},
            {"source_text": "TITLE", "ymin": 120, "ymax": 160},
        ]
        x, y, width, height = _subtitle_band_geometry(
            {
                "subtitle_band_auto": True,
                "subtitle_band_x_ratio": 0.0,
                "subtitle_band_width_ratio": 1.0,
                "subtitle_band_y_ratio": 0.83,
                "subtitle_band_height_ratio": 0.14,
                "subtitle_band_candidate_min_y_ratio": 0.58,
                "subtitle_band_candidate_max_y_ratio": 0.98,
                "subtitle_band_y_percentile": 0.05,
                "subtitle_band_y_offset_ratio": 0.0,
                "box_padding_y": 4,
            },
            width=1280,
            height=720,
            cues=cues,
        )
        self.assertEqual(x, 0)
        self.assertEqual(width, 1280)
        self.assertLessEqual(y, 596)
        self.assertGreaterEqual(y + height, 660)
        self.assertLess(height, 100)

    def test_subtitle_band_geometry_chooses_stable_bottom_cluster(self) -> None:
        cues = [
            {"source_text": "标题", "ymin": 110, "ymax": 160},
            {"source_text": "广告", "ymin": 420, "ymax": 465},
            {"source_text": "你好", "ymin": 604, "ymax": 648},
            {"source_text": "世界", "ymin": 610, "ymax": 652},
            {"source_text": "字幕", "ymin": 600, "ymax": 646},
        ]
        x, y, width, height = _subtitle_band_geometry(
            {
                "subtitle_band_auto": True,
                "subtitle_band_x_ratio": 0.0,
                "subtitle_band_width_ratio": 1.0,
                "subtitle_band_y_ratio": 0.83,
                "subtitle_band_height_ratio": 0.14,
                "subtitle_band_candidate_min_y_ratio": 0.0,
                "subtitle_band_candidate_max_y_ratio": 0.98,
                "subtitle_band_y_percentile": 0.05,
                "subtitle_band_y_offset_ratio": 0.0,
                "box_padding_y": 4,
            },
            width=1280,
            height=720,
            cues=cues,
        )
        self.assertEqual((x, width), (0, 1280))
        self.assertLessEqual(y, 596)
        self.assertGreaterEqual(y + height, 660)
        self.assertLess(height, 100)

    def test_clean_ocr_text_strips_common_watermark_variants(self) -> None:
        cases = {
            "Lilibili": "",
            "bililb\u5e2e\u6211\u8fd9\u4e2a\u75c5\u4eba": "\u5e2e\u6211\u8fd9\u4e2a\u75c5\u4eba",
            "\u54fc\u5e08\u5c0aEslibili": "\u54fc\u5e08\u5c0a",
            "bilibii\u5e08\u59b9\u5c31\u4e0d\u4f1a\u6765": "\u5e08\u59b9\u5c31\u4e0d\u4f1a\u6765",
            "\u539f\u521b@\u7167\u6708\u541b": "",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(clean_ocr_text(source), expected)

    def test_chunk_plan_has_no_frame_gap(self) -> None:
        chunks = plan_chunks(6.2, fps=30, chunk_seconds=2)
        self.assertEqual(chunks[0]["start_frame"], 0)
        self.assertEqual(chunks[-1]["end_frame"], round(6.2 * 30))
        for left, right in zip(chunks, chunks[1:]):
            self.assertEqual(left["end_frame"], right["start_frame"])

    def test_render_boundary_moves_past_active_cue(self) -> None:
        chunks = plan_render_chunks(
            4,
            fps=30,
            chunk_seconds=2,
            cues=[{"start_frame": 58, "end_frame": 66}],
        )
        self.assertEqual(chunks[0]["end_frame"], 66)
        self.assertEqual(chunks[1]["start_frame"], 66)

    def test_render_boundary_keeps_micro_cue_with_successor(self) -> None:
        chunks = plan_render_chunks(
            5,
            fps=30,
            chunk_seconds=2,
            cues=[
                {"start_frame": 58, "end_frame": 61},
                {"start_frame": 70, "end_frame": 120},
            ],
        )
        self.assertEqual(chunks[0]["end_frame"], 120)
        self.assertEqual(chunks[1]["start_frame"], 120)

    def test_detections_become_stable_cue_and_srt(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = [
                    {"frame_index": frame, "line_index": 0, "box": [100, 600, 500, 660], "text": "你好世界", "confidence": 0.95}
                    for frame in range(10, 21)
                ]
                store.replace_chunk_detections("job", 0, detections)
                cues = build_cues(
                    store,
                    "job",
                    media={"width": 1280, "height": 720},
                    ocr_config={"minimum_confidence": 0.4, "subtitle_min_y_ratio": 0.5, "subtitle_max_y_ratio": 0.98},
                    tracking_config={"max_gap_frames": 4, "minimum_duration_frames": 3, "text_similarity": 0.72},
                )
                self.assertEqual(len(cues), 1)
                srt = root / "out.srt"
                write_srt(srt, cues, fps=30)
                parsed = parse_srt(srt)
                self.assertEqual(parsed[0]["text"], "你好世界")
                self.assertAlmostEqual(parsed[0]["start"], 10 / 30, places=3)


    def test_tracking_prefers_best_subtitle_cluster(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = []
                for frame in range(10, 21):
                    detections.extend(
                        [
                            {"frame_index": frame, "line_index": 0, "box": [220, 600, 860, 650], "text": "MAIN SUBTITLE", "confidence": 0.96},
                            {"frame_index": frame, "line_index": 1, "box": [900, 665, 980, 700], "text": "AD", "confidence": 0.58},
                        ]
                    )
                store.replace_chunk_detections("job", 0, detections)
                cues = build_cues(
                    store,
                    "job",
                    media={"width": 1280, "height": 720},
                    ocr_config={"minimum_confidence": 0.55, "subtitle_min_y_ratio": 0.55, "subtitle_max_y_ratio": 0.98},
                    tracking_config={
                        "max_gap_frames": 4,
                        "minimum_duration_frames": 3,
                        "text_similarity": 0.72,
                        "line_cluster_y_ratio": 0.055,
                        "minimum_text_chars": 2,
                    },
                )
                self.assertEqual(cues[0]["source_text"], "MAIN SUBTITLE")

    def test_full_frame_blur_regions_are_separate_from_subtitle_cues(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = []
                for frame in range(10, 21):
                    detections.extend(
                        [
                            {"frame_index": frame, "line_index": 0, "box": [80, 80, 320, 130], "text": "\u539f\u521b@\u7167\u6708\u541b", "confidence": 0.92},
                            {"frame_index": frame, "line_index": 1, "box": [220, 600, 860, 650], "text": "\u4f60\u597d\u4e16\u754c", "confidence": 0.96},
                            {"frame_index": frame, "line_index": 2, "box": [920, 660, 1010, 700], "text": "bilibili", "confidence": 0.95},
                        ]
                    )
                store.replace_chunk_detections("job", 0, detections)
                ocr_config = {
                    "minimum_confidence": 0.55,
                    "sample_fps": 3.0,
                    "subtitle_min_y_ratio": 0.55,
                    "subtitle_max_y_ratio": 0.98,
                }
                tracking_config = {
                    "max_gap_frames": 4,
                    "minimum_duration_frames": 3,
                    "text_similarity": 0.72,
                    "line_cluster_y_ratio": 0.055,
                    "minimum_text_chars": 2,
                }
                media = {"width": 1280, "height": 720, "fps": 30, "duration_seconds": 2.0}
                cues = build_cues(
                    store,
                    "job",
                    media=media,
                    ocr_config=ocr_config,
                    tracking_config=tracking_config,
                )
                regions = build_blur_regions(
                    store,
                    "job",
                    media=media,
                    ocr_config=ocr_config,
                    tracking_config=tracking_config,
                )
                self.assertEqual(len(cues), 1)
                self.assertEqual(cues[0]["source_text"], "\u4f60\u597d\u4e16\u754c")
                self.assertTrue(any(region["ymin"] < 200 for region in regions))
                self.assertFalse(any(region["source_text"] == "bilibili" for region in regions))

    def test_static_blur_plan_requires_five_of_ten_stationary_samples(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = [
                    {"frame_index": frame, "line_index": 0, "box": [40, 30, 180, 70], "text": "固定水印", "confidence": 0.95}
                    for frame in (0, 10, 20, 30, 40)
                ]
                detections.extend(
                    {"frame_index": frame, "line_index": 1, "box": [200 + frame, 100, 320 + frame, 140], "text": "移动", "confidence": 0.95}
                    for frame in (0, 10, 20, 30, 40)
                )
                store.replace_chunk_detections("job", 0, detections)
                plan = build_static_blur_regions(
                    store,
                    "job",
                    media={"width": 640, "height": 360, "fps": 30, "duration_seconds": 3.0},
                    ocr_config={"minimum_confidence": 0.55, "sample_fps": 3.0},
                    tracking_config={
                        "static_blur_sample_frames": 10,
                        "static_blur_min_samples": 5,
                        "static_blur_position_tolerance_px": 8,
                        "minimum_text_chars": 2,
                    },
                )
                self.assertEqual(len(plan), 1)
                self.assertEqual(plan[0]["kind"], "static_blur")
                self.assertEqual(plan[0]["source_text"], "固定水印")
                self.assertEqual((plan[0]["start_frame"], plan[0]["end_frame"]), (0, 90))

    def test_static_blur_uses_position_and_excludes_subtitle_area(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = [
                    {
                        "frame_index": frame,
                        "line_index": 0,
                        "box": [40, 30, 180, 70],
                        "text": text,
                        "confidence": 0.95,
                    }
                    for frame, text in zip(
                        (0, 20, 40, 60, 80),
                        ("BRAND", "8RAND", "BR4ND", "BRAND", "BRAND"),
                    )
                ]
                detections.extend(
                    {
                        "frame_index": frame,
                        "line_index": 1,
                        "box": [220, 300, 420, 340],
                        "text": "subtitle",
                        "confidence": 0.95,
                    }
                    for frame in (0, 20, 40, 60, 80, 100)
                )
                store.replace_chunk_detections("job", 0, detections)
                plan = build_static_blur_regions(
                    store,
                    "job",
                    media={"width": 640, "height": 360, "fps": 30, "duration_seconds": 6.0},
                    ocr_config={"minimum_confidence": 0.55, "sample_fps": 1.5},
                    tracking_config={
                        "static_blur_sample_frames": 10,
                        "static_blur_min_samples": 5,
                        "static_blur_position_tolerance_px": 8,
                        "static_blur_max_y_ratio": 0.55,
                        "minimum_text_chars": 2,
                    },
                )
                self.assertEqual(len(plan), 1)
                self.assertEqual(len(plan[0]["sample_indexes"]), 5)
                self.assertEqual((plan[0]["xmin"], plan[0]["ymin"]), (40, 30))

    def test_static_blur_plan_rejects_short_lived_target_text(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = [
                    {"frame_index": frame, "line_index": 0, "box": [40, 30, 180, 70], "text": "BRAND", "confidence": 0.95}
                    for frame in (0, 300, 600, 900)
                ]
                store.replace_chunk_detections("job", 0, detections)
                plan = build_static_blur_regions(
                    store,
                    "job",
                    media={"width": 640, "height": 360, "fps": 30, "duration_seconds": 100.0},
                    ocr_config={"minimum_confidence": 0.55, "sample_fps": 0.1},
                    tracking_config={
                        "static_blur_sample_frames": 10,
                        "static_blur_min_samples": 5,
                        "static_blur_position_tolerance_px": 8,
                        "minimum_text_chars": 2,
                    },
                )
                self.assertEqual(plan, [])

    def test_tracking_strips_bilibili_watermark_text(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                detections = []
                for frame in range(10, 21):
                    detections.extend(
                        [
                            {"frame_index": frame, "line_index": 0, "box": [220, 600, 860, 650], "text": "不过先去谁那好呢bilibili", "confidence": 0.96},
                            {"frame_index": frame, "line_index": 1, "box": [900, 665, 980, 700], "text": "照月君 bilibili", "confidence": 0.90},
                        ]
                    )
                store.replace_chunk_detections("job", 0, detections)
                cues = build_cues(
                    store,
                    "job",
                    media={"width": 1280, "height": 720},
                    ocr_config={"minimum_confidence": 0.55, "subtitle_min_y_ratio": 0.55, "subtitle_max_y_ratio": 0.98},
                    tracking_config={
                        "max_gap_frames": 4,
                        "minimum_duration_frames": 3,
                        "text_similarity": 0.72,
                        "line_cluster_y_ratio": 0.055,
                        "minimum_text_chars": 2,
                    },
                )
                self.assertEqual(cues[0]["source_text"], "不过先去谁那好呢")


if __name__ == "__main__":
    unittest.main()
