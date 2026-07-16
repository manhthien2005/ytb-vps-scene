from __future__ import annotations

import unittest
import json
import tempfile
from pathlib import Path

from ytb_vps.media import probe_duration, run_ffmpeg
from ytb_vps.tts import (
    CapCutSharkBlock,
    TtsFitError,
    apply_tts_text_overrides,
    fit_audio,
    group_cues,
    is_capcut_shark_block,
    is_silent_tts_text,
)
from ytb_vps.vendor import capcut_client


class TtsGroupingTests(unittest.TestCase):
    def test_vendored_protocol_escapes_text_and_signs_payload(self) -> None:
        device = capcut_client.deepcopy(capcut_client.DEFAULT_DEVICE)
        _, body = capcut_client.tts_new_body(
            ["A & B"], "voice", "resource", "1.0", device
        )
        payload = json.loads(body["tasks"][0]["payload"])
        self.assertIn("A &amp; B", payload["ssml"])
        self.assertGreater(len(payload["sign"]), 100)

    def test_groups_do_not_cross_render_chunk(self) -> None:
        cues = [
            {"cue_index": 1, "start_frame": 50, "end_frame": 58, "target_text": "Một"},
            {"cue_index": 2, "start_frame": 60, "end_frame": 65, "target_text": "Hai"},
        ]
        groups = group_cues(
            cues,
            30,
            {"group_gap_seconds": 1, "max_group_chars": 620, "max_group_duration_seconds": 24},
            chunk_end_frames=[60, 120],
        )
        self.assertEqual(len(groups), 2)
        self.assertLess(groups[0].start, 2)
        self.assertGreaterEqual(groups[1].start, 2)

    def test_micro_cue_merges_with_nearby_successor_on_new_job(self) -> None:
        cues = [
            {"cue_index": 1, "start_frame": 0, "end_frame": 6, "target_text": "Mê"},
            {"cue_index": 2, "start_frame": 21, "end_frame": 96, "target_text": "Ý chí kích hoạt"},
        ]
        groups = group_cues(
            cues,
            30,
            {"group_gap_seconds": 0, "max_group_chars": 90, "max_group_duration_seconds": 4},
            chunk_end_frames=[120],
        )
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].cue_indices, (1, 2))

    def test_pending_micro_cue_borrows_full_gap_across_render_boundary(self) -> None:
        cues = [
            {"cue_index": 1, "start_frame": 58, "end_frame": 61, "target_text": "Mê"},
            {"cue_index": 2, "start_frame": 70, "end_frame": 145, "target_text": "Ý chí kích hoạt"},
        ]
        groups = group_cues(
            cues,
            30,
            {"group_gap_seconds": 0, "max_group_chars": 90, "max_group_duration_seconds": 4},
            chunk_end_frames=[61, 180],
            merge_micro_cues=False,
            micro_borrow_indices={0},
        )
        self.assertEqual(len(groups), 2)
        self.assertAlmostEqual(groups[0].end, 61 / 30 + 1.0)
        self.assertGreater(groups[0].end, groups[1].start)

    def test_detects_capcut_shark_block_errors(self) -> None:
        self.assertTrue(is_capcut_shark_block(CapCutSharkBlock("ret=-6 shark block only")))
        self.assertFalse(is_capcut_shark_block(RuntimeError("CapCut TTS timed out")))

    def test_punctuation_only_text_is_silent_tts(self) -> None:
        self.assertTrue(is_silent_tts_text("..."))
        self.assertTrue(is_silent_tts_text("?!"))
        self.assertFalse(is_silent_tts_text("toi..."))
        self.assertFalse(is_silent_tts_text("42"))

    def test_tts_text_override_updates_display_cues(self) -> None:
        cues = [
            {"cue_index": 1, "target_text": "Câu dài ban đầu"},
            {"cue_index": 2, "target_text": "Giữ nguyên"},
        ]
        groups = [
            {"metadata": {"shortened_cues": {"1": "Câu kể ngắn"}}}
        ]

        display = apply_tts_text_overrides(cues, groups)

        self.assertEqual(display[0]["target_text"], "Câu kể ngắn")
        self.assertEqual(display[1]["target_text"], "Giữ nguyên")
        self.assertEqual(cues[0]["target_text"], "Câu dài ban đầu")

    def test_fit_audio_preserves_overflow_at_speed_cap(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = root / "raw.wav"
            fitted = root / "fitted.wav"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1.2",
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    str(raw),
                ],
                duration_seconds=1.2,
            )

            metadata = fit_audio(
                raw,
                fitted,
                0.5,
                max_speed=1.12,
                hard_speed=1.12,
                tolerance_seconds=0.02,
            )

            self.assertTrue(fitted.exists())
            self.assertGreater(metadata["overflow_seconds"], 0.4)
            self.assertGreater(probe_duration(fitted), 1.0)

    def test_fit_audio_preserves_internal_silence(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = root / "raw.wav"
            fitted = root / "fitted.wav"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    (
                        "aevalsrc=if(lt(t\\,0.1)\\,0\\,"
                        "if(lt(t\\,0.5)\\,sin(2*PI*440*t)\\,"
                        "if(lt(t\\,0.9)\\,0\\,"
                        "if(lt(t\\,1.3)\\,sin(2*PI*440*t)\\,0)))):"
                        "s=44100:d=1.4"
                    ),
                    "-ac",
                    "2",
                    str(raw),
                ],
                duration_seconds=1.4,
            )

            metadata = fit_audio(raw, fitted, 2.0, tolerance_seconds=0.03)

            self.assertGreater(metadata["trimmed_input_seconds"], 1.15)
            self.assertGreater(probe_duration(fitted), 1.15)
            self.assertEqual(metadata["fit_algorithm_version"], 2)

    def test_fit_audio_uses_speed_without_slot_trim(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = root / "raw.wav"
            fitted = root / "nested" / "fitted.wav"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=0.8",
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    str(raw),
                ],
                duration_seconds=0.8,
            )

            metadata = fit_audio(raw, fitted, 0.7, max_speed=1.2, tolerance_seconds=0.03)

            self.assertTrue(fitted.exists())
            self.assertFalse(metadata["speech_trimmed"])
            self.assertLessEqual(probe_duration(fitted), 0.73)
            self.assertGreater(probe_duration(fitted), 0.64)


if __name__ == "__main__":
    unittest.main()
