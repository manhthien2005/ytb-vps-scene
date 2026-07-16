from __future__ import annotations

import unittest
from dataclasses import replace

from ytb_vps_v2.application.invalidation import (
    STAGE_DEPENDENCIES,
    InvalidationPlan,
    plan_invalidation,
)
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import StageName


class InvalidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.baseline = EffectiveConfig()

    def _plan(self, changed: EffectiveConfig):
        return plan_invalidation(
            stage_config_fingerprints(self.baseline),
            stage_config_fingerprints(changed),
        )

    def test_unchanged_and_runtime_only_changes_preserve_all_work(self) -> None:
        unchanged = self._plan(self.baseline)
        runtime_changed = self._plan(
            replace(
                self.baseline,
                runtime=replace(
                    self.baseline.runtime,
                    ocr_parallelism=4,
                    retry_attempts=8,
                ),
            )
        )

        for plan in (unchanged, runtime_changed):
            self.assertEqual(plan.direct_stages, ())
            self.assertEqual(plan.affected_stages, ())

    def test_tts_change_invalidates_tts_and_downstream_only(self) -> None:
        plan = self._plan(
            replace(
                self.baseline,
                tts=replace(self.baseline.tts, voice="voice-v2"),
            )
        )

        self.assertEqual(plan.direct_stages, (StageName.TTS,))
        self.assertEqual(
            plan.affected_stages,
            (
                StageName.TTS,
                StageName.RENDER,
                StageName.PUBLISH,
                StageName.BACKUP,
            ),
        )

    def test_ocr_change_invalidates_ocr_and_all_downstream_stages(self) -> None:
        plan = self._plan(
            replace(
                self.baseline,
                ocr=replace(self.baseline.ocr, model_revision="ocr-v2"),
            )
        )

        self.assertEqual(plan.direct_stages, (StageName.OCR,))
        self.assertEqual(
            plan.affected_stages,
            (
                StageName.OCR,
                StageName.TRACK,
                StageName.TRANSLATE,
                StageName.TTS,
                StageName.RENDER,
                StageName.PUBLISH,
                StageName.BACKUP,
            ),
        )

    def test_render_and_publish_changes_have_exact_closures(self) -> None:
        cases = (
            (
                replace(
                    self.baseline,
                    render=replace(self.baseline.render, profile_revision="render-v2"),
                ),
                StageName.RENDER,
                (StageName.RENDER, StageName.PUBLISH, StageName.BACKUP),
            ),
            (
                replace(
                    self.baseline,
                    publish=replace(
                        self.baseline.publish,
                        remote_root="remote:new",
                    ),
                ),
                StageName.PUBLISH,
                (StageName.PUBLISH, StageName.BACKUP),
            ),
        )
        for changed, direct, affected in cases:
            with self.subTest(direct=direct):
                plan = self._plan(changed)
                self.assertEqual(plan.direct_stages, (direct,))
                self.assertEqual(plan.affected_stages, affected)

    def test_artifact_owner_changes_join_and_deduplicate_config_changes(self) -> None:
        previous = stage_config_fingerprints(self.baseline)
        current = stage_config_fingerprints(
            replace(
                self.baseline,
                tts=replace(self.baseline.tts, voice="voice-v2"),
            )
        )

        plan = plan_invalidation(
            previous,
            current,
            changed_artifact_owners=(StageName.TRACK, StageName.TTS),
        )

        self.assertEqual(
            plan.direct_stages,
            (StageName.TRACK, StageName.TTS),
        )
        self.assertEqual(
            plan.affected_stages,
            (
                StageName.TRACK,
                StageName.TRANSLATE,
                StageName.TTS,
                StageName.RENDER,
                StageName.PUBLISH,
                StageName.BACKUP,
            ),
        )

    def test_snapshots_and_artifact_owner_types_are_validated(self) -> None:
        snapshot = stage_config_fingerprints(self.baseline)
        invalid_calls = (
            lambda: plan_invalidation(snapshot[:-1], snapshot),
            lambda: plan_invalidation(snapshot + (snapshot[0],), snapshot),
            lambda: plan_invalidation(
                snapshot,
                snapshot,
                changed_artifact_owners=("TRACK",),
            ),
        )
        for call in invalid_calls:
            with self.subTest(call=call):
                with self.assertRaises(DomainInvariantError):
                    call()  # type: ignore[misc]

    def test_invalidation_plan_enforces_typed_ordered_stage_sets(self) -> None:
        invalid_plans = (
            lambda: InvalidationPlan(("OCR",), ()),
            lambda: InvalidationPlan([StageName.OCR], (StageName.OCR,)),
            lambda: InvalidationPlan((StageName.TTS,), (StageName.RENDER,)),
            lambda: InvalidationPlan(
                (StageName.TTS, StageName.OCR),
                (StageName.TTS, StageName.OCR),
            ),
        )
        for factory in invalid_plans:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()  # type: ignore[misc]

    def test_stage_dependency_graph_cannot_be_mutated(self) -> None:
        with self.assertRaises(TypeError):
            STAGE_DEPENDENCIES[StageName.OCR] = ()  # type: ignore[index]

    def test_invalidation_plan_is_an_inward_domain_contract(self) -> None:
        self.assertEqual(
            InvalidationPlan.__module__,
            "ytb_vps_v2.domain.invalidation",
        )


if __name__ == "__main__":
    unittest.main()
