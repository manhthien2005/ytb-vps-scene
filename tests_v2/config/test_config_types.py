from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError, dataclass
from fractions import Fraction

from ytb_vps_v2.domain.config import (
    ConfigError,
    EffectiveConfig,
    MediaConfig,
    OcrConfig,
    PublishConfig,
    RenderConfig,
    RuntimeConfig,
    SafetyConfig,
    TrackingConfig,
    TranslationConfig,
    TtsConfig,
)
from ytb_vps_v2.domain.models import PipelineMode


class ConfigTypeTests(unittest.TestCase):
    def test_defaults_are_typed_and_frozen(self) -> None:
        config = EffectiveConfig()

        self.assertEqual(config.media.target_fps, 30)
        self.assertEqual(config.ocr.sample_fps, Fraction(2))
        self.assertEqual(config.translation.mode, PipelineMode.CUE_TRANSLATION)
        self.assertFalse(config.safety.cleanup_after_upload)
        with self.assertRaises(FrozenInstanceError):
            config.media.target_fps = 25  # type: ignore[misc]

    def test_integer_fields_reject_booleans_fractions_and_invalid_ranges(self) -> None:
        invalid_factories = (
            lambda: MediaConfig(target_fps=True),
            lambda: MediaConfig(max_width=0),
            lambda: MediaConfig(chunk_seconds=1.5),
            lambda: OcrConfig(scan_width=False),
            lambda: TrackingConfig(minimum_duration_frames=0),
            lambda: TranslationConfig(prompt_revision=-1),
            lambda: RenderConfig(font_size=0),
            lambda: RenderConfig(outline=-1),
            lambda: RuntimeConfig(ocr_parallelism=0),
            lambda: RuntimeConfig(timeout_seconds=True),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(ConfigError):
                    factory()  # type: ignore[misc]

    def test_fraction_and_text_fields_are_strict(self) -> None:
        invalid_factories = (
            lambda: OcrConfig(sample_fps=2.0),
            lambda: OcrConfig(minimum_confidence=Fraction(101, 100)),
            lambda: OcrConfig(backend=" onnx"),
            lambda: TrackingConfig(text_similarity=Fraction(-1, 10)),
            lambda: TranslationConfig(model=""),
            lambda: TtsConfig(rate=Fraction(0)),
            lambda: TtsConfig(max_fit_speed=1.35),
            lambda: PublishConfig(remote_root=" "),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(ConfigError):
                    factory()  # type: ignore[misc]

    def test_unsupported_mode_and_cleanup_are_rejected(self) -> None:
        with self.assertRaisesRegex(ConfigError, "Unsupported pipeline mode"):
            TranslationConfig(mode="scene_voiceover")  # type: ignore[arg-type]
        with self.assertRaisesRegex(ConfigError, "Cleanup remains disabled"):
            SafetyConfig(cleanup_after_upload=True)
        with self.assertRaises(ConfigError):
            SafetyConfig(cleanup_after_upload=0)  # type: ignore[arg-type]

    def test_effective_config_validates_nested_types_and_cross_fields(self) -> None:
        @dataclass(frozen=True)
        class DerivedMediaConfig(MediaConfig):
            extra_field: str = "unapproved"

        with self.assertRaises(ConfigError):
            EffectiveConfig(media="media")  # type: ignore[arg-type]
        with self.assertRaises(ConfigError):
            EffectiveConfig(media=DerivedMediaConfig())
        with self.assertRaisesRegex(ConfigError, "sample FPS"):
            EffectiveConfig(
                media=MediaConfig(target_fps=1),
                ocr=OcrConfig(sample_fps=Fraction(2)),
            )

    def test_max_fit_speed_accepts_every_positive_fraction(self) -> None:
        config = TtsConfig(max_fit_speed=Fraction(1, 2))

        self.assertEqual(config.max_fit_speed, Fraction(1, 2))


if __name__ == "__main__":
    unittest.main()
