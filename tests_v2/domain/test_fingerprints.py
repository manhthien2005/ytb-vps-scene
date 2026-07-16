from __future__ import annotations

import unittest
from dataclasses import replace
from fractions import Fraction

from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain import (
    Fingerprint,
    fingerprint_value,
    stage_config_fingerprints,
)
from ytb_vps_v2.domain.models import PipelineMode, StageName


class FingerprintTests(unittest.TestCase):
    def test_canonical_values_hash_deterministically(self) -> None:
        first = fingerprint_value(
            {
                "fraction": Fraction(5, 2),
                "mode": PipelineMode.CUE_TRANSLATION,
                "items": (1, "text", True),
            }
        )
        second = fingerprint_value(
            {
                "items": (1, "text", True),
                "mode": PipelineMode.CUE_TRANSLATION,
                "fraction": Fraction(10, 4),
            }
        )

        self.assertEqual(first, second)
        self.assertRegex(first.sha256, r"^[0-9a-f]{64}$")
        with self.assertRaises(DomainInvariantError):
            Fingerprint("invalid")

    def test_each_content_setting_changes_only_its_direct_stage_hash(self) -> None:
        baseline = EffectiveConfig()
        cases = (
            (
                replace(baseline, ocr=replace(baseline.ocr, model_revision="ocr-v2")),
                StageName.OCR,
            ),
            (
                replace(baseline, tts=replace(baseline.tts, voice="voice-v2")),
                StageName.TTS,
            ),
            (
                replace(
                    baseline,
                    publish=replace(baseline.publish, remote_root="remote:new"),
                ),
                StageName.PUBLISH,
            ),
        )
        baseline_hashes = dict(
            (item.stage, item.fingerprint) for item in stage_config_fingerprints(baseline)
        )

        for changed, expected_stage in cases:
            with self.subTest(expected_stage=expected_stage):
                changed_hashes = dict(
                    (item.stage, item.fingerprint)
                    for item in stage_config_fingerprints(changed)
                )
                different = tuple(
                    stage
                    for stage in StageName
                    if baseline_hashes[stage] != changed_hashes[stage]
                )
                self.assertEqual(different, (expected_stage,))

    def test_runtime_and_safety_settings_do_not_change_content_hashes(self) -> None:
        baseline = EffectiveConfig()
        runtime_changed = replace(
            baseline,
            runtime=replace(
                baseline.runtime,
                ocr_parallelism=4,
                ffmpeg_threads=12,
                retry_attempts=8,
                timeout_seconds=1200,
            ),
        )

        self.assertEqual(
            stage_config_fingerprints(baseline),
            stage_config_fingerprints(runtime_changed),
        )

    def test_unsupported_values_fail_instead_of_using_repr(self) -> None:
        with self.assertRaisesRegex(DomainInvariantError, "Unsupported"):
            fingerprint_value(object())
        with self.assertRaises(DomainInvariantError):
            fingerprint_value({1: "not-a-string-key"})


if __name__ == "__main__":
    unittest.main()
