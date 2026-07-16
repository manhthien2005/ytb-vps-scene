from __future__ import annotations

import unittest
import logging
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

from tests.support import test_settings
from ytb_vps.state import JobStore
from ytb_vps.translation import (
    PROMPT_REVISION,
    TranslationError,
    CodexTranslator,
    _prompt,
    _shorten_prompt,
    _validate,
    shorten_tts_group,
    translate_cues,
    translation_cues_complete,
)


class TranslationTests(unittest.TestCase):
    def test_schema_result_requires_exact_ids(self) -> None:
        result = _validate(
            {"translations": [{"id": 1, "text": "Xin chào"}, {"id": 2, "text": "Cảm ơn"}]},
            [1, 2],
        )
        self.assertEqual(result[2], "Cảm ơn")
        with self.assertRaises(TranslationError):
            _validate({"translations": [{"id": 1, "text": "Xin chào"}]}, [1, 2])


    def test_9router_array_result_is_accepted(self) -> None:
        result = _validate([{"id": 1, "vietnamese": "Xin chao"}], [1])
        self.assertEqual(result[1], "Xin chao")

    def test_failed_single_entry_is_skipped(self) -> None:
        translator = object.__new__(CodexTranslator)
        translator.config = {"retry_attempts": 1, "skip_failed_cues": True}
        translator.logger = logging.getLogger("test")
        translator._call = Mock(side_effect=TranslationError("provider unavailable"))

        skipped: dict[int, str] = {}
        result = translator.translate_entries(
            [{"cue_index": 7}],
            skipped_errors=skipped,
        )

        self.assertEqual(result, {})
        self.assertEqual(skipped, {7: "provider unavailable"})

    def test_story_prompt_uses_adapter_hook_and_json_contract(self) -> None:
        entries = [
            {
                "cue_index": 2,
                "start_frame": 30,
                "end_frame": 60,
                "source_text": "他抬头看去",
                "source_hash": "b",
                "target_text": "Anh ngẩng đầu nhìn",
            }
        ]
        context = [
            {
                "cue_index": 1,
                "source_text": "十三醒了",
                "source_hash": "a",
                "target_text": "Thập Tam tỉnh lại",
            },
            *entries,
        ]

        prompt = _prompt(entries, context)
        shorten = _shorten_prompt(
            entries,
            context,
            slot_seconds=1.0,
            required_speed=1.7,
            hard_speed=1.25,
        )

        self.assertEqual(PROMPT_REVISION, 10)
        self.assertIn("Cue 2 is the opening hook", prompt)
        self.assertIn("Giữ lời thoại là lời thoại", prompt)
        self.assertIn("vietnamese_character_budget", prompt)
        self.assertIn("Chỉ trả JSON đúng schema", prompt)
        self.assertIn("surrounding_context", prompt)
        self.assertNotIn("[NỘI DUNG]", prompt)
        self.assertIn("maximum_vietnamese_characters", shorten)
        self.assertIn("no more than 1.25x", shorten)

    def test_story_prompt_does_not_mark_later_cues_as_hook(self) -> None:
        entry = {
            "cue_index": 3,
            "start_frame": 60,
            "end_frame": 120,
            "source_text": "后续剧情",
            "source_hash": "c",
        }

        prompt = _prompt([entry])

        self.assertNotIn("opening hook", prompt)
        self.assertIn("không gộp, bỏ, đổi thứ tự hoặc tạo cue mới", prompt)

    def test_second_shorten_pass_uses_current_text(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="abc",
                    output_path=root / "output.mp4",
                    config_signature="cfg",
                )
                store.replace_cues(
                    "job",
                    [
                        {
                            "cue_index": 1,
                            "start_frame": 0,
                            "end_frame": 30,
                            "box": [0, 0, 10, 10],
                            "source_text": "原文",
                            "target_text": "Câu rất dài ban đầu",
                            "source_hash": "hash",
                        }
                    ],
                )
                with patch(
                    "ytb_vps.translation.CodexTranslator.shorten_entries",
                    return_value={1: "Ngắn hơn"},
                ) as shorten:
                    result = shorten_tts_group(
                        settings=settings,
                        store=store,
                        job_id="job",
                        workspace=root,
                        logger=logging.getLogger("test"),
                        cue_indices=[1],
                        slot_seconds=1.0,
                        required_speed=2.0,
                        hard_speed=1.25,
                        current_texts={1: "Câu rút lần một"},
                    )

                entries = shorten.call_args.args[0]
                self.assertEqual(entries[0]["target_text"], "Câu rút lần một")
                self.assertEqual(result, {1: "Ngắn hơn"})


if __name__ == "__main__":
    unittest.main()
