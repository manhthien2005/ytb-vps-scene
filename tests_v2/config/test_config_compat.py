from __future__ import annotations

import copy
import unittest
from decimal import Decimal
from fractions import Fraction

from ytb_vps_v2.domain.config import ConfigError
from ytb_vps_v2.domain.models import PipelineMode
from ytb_vps_v2.interfaces.config_compat import (
    UnknownKeyPolicy,
    parse_config,
)


class ConfigCompatibilityTests(unittest.TestCase):
    def test_legacy_keys_translate_to_typed_effective_values(self) -> None:
        raw = {
            "media": {"target_fps": 30, "ffmpeg_threads": 8},
            "ocr": {
                "det_model_dir": "/models/det",
                "rec_model_dir": "/models/rec",
                "parallel_chunks": 2,
                "sample_fps": "2.5",
            },
            "translation": {
                "style_version": 7,
                "model": "gpt-test",
                "mode": "cue_translation",
            },
            "tts": {"rate": "1.1", "max_fit_speed": 1.35},
            "drive": {"remote_root": "remote:root"},
            "queue": {"cleanup_after_upload": False},
        }
        original = copy.deepcopy(raw)

        result = parse_config(raw)

        self.assertEqual(raw, original)
        self.assertEqual(result.config.runtime.ffmpeg_threads, 8)
        self.assertEqual(result.config.runtime.ocr_parallelism, 2)
        self.assertEqual(
            result.config.ocr.model_revision,
            "det=/models/det;rec=/models/rec",
        )
        self.assertEqual(result.config.ocr.sample_fps, Fraction(5, 2))
        self.assertEqual(result.config.translation.prompt_revision, 7)
        self.assertEqual(result.config.translation.mode, PipelineMode.CUE_TRANSLATION)
        self.assertEqual(result.config.tts.rate, Fraction(11, 10))
        self.assertEqual(result.config.tts.max_fit_speed, Fraction(27, 20))
        self.assertEqual(result.config.publish.remote_root, "remote:root")
        self.assertTrue(
            any(
                warning.path == "translation.style_version"
                for warning in result.warnings
            )
        )

    def test_unknown_keys_follow_explicit_policy_without_leaking_values(self) -> None:
        secret_like_value = "do-not-echo-this-value"
        raw = {
            "ocr": {"future_option": secret_like_value},
            "future_section": {"key": secret_like_value},
        }

        warned = parse_config(raw, unknown_policy=UnknownKeyPolicy.WARN)

        self.assertEqual(
            tuple(warning.path for warning in warned.warnings),
            ("ocr.future_option", "future_section"),
        )
        self.assertNotIn(secret_like_value, repr(warned.warnings))
        with self.assertRaisesRegex(ConfigError, "ocr.future_option"):
            parse_config(raw, unknown_policy=UnknownKeyPolicy.ERROR)

    def test_unsafe_legacy_modes_and_cleanup_fail_explicitly(self) -> None:
        invalid = (
            {"translation": {"mode": "scene_voiceover"}},
            {"queue": {"cleanup_after_upload": True}},
            {"safety": {"cleanup_after_upload": True}},
        )
        for raw in invalid:
            with self.subTest(raw=raw):
                with self.assertRaises(ConfigError):
                    parse_config(raw)

    def test_alias_conflicts_are_rejected_instead_of_guessing_precedence(self) -> None:
        conflicts = (
            {
                "translation": {
                    "prompt_revision": 2,
                    "style_version": 3,
                }
            },
            {
                "ocr": {
                    "model_revision": "new",
                    "det_model_dir": "/det",
                    "rec_model_dir": "/rec",
                }
            },
            {"publish": {"remote_root": "new"}, "drive": {"remote_root": "old"}},
            {"runtime": {"ffmpeg_threads": 4}, "media": {"ffmpeg_threads": 8}},
        )
        for raw in conflicts:
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(ConfigError, "conflict"):
                    parse_config(raw)

    def test_raw_types_and_policy_types_are_strict(self) -> None:
        invalid = (
            {"media": []},
            {"media": {"target_fps": True}},
            {"render": {"mirror_video": 1}},
            {"ocr": {"sample_fps": "nan"}},
            {"translation": {"model": " padded"}},
            {"tts": {"rate": Fraction(1)}},
            {"tts": {"rate": Decimal("1.0")}},
        )
        for raw in invalid:
            with self.subTest(raw=raw):
                with self.assertRaises(ConfigError):
                    parse_config(raw)  # type: ignore[arg-type]
        with self.assertRaises(ConfigError):
            parse_config({}, unknown_policy="warn")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
