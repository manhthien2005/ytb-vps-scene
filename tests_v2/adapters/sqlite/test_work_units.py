from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.invalidation import plan_invalidation
from ytb_vps_v2.domain.backup import (
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.config import EffectiveConfig, OcrConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.state import StateTransitionError


class SqliteWorkUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "job-v2.sqlite"
        self.store = SqliteStateStore(self.path)
        self.addCleanup(lambda: self.store.close())
        self.job_id = JobId("job-1")
        self.source = Fingerprint("a" * 64)
        self.config = stage_config_fingerprints(EffectiveConfig())
        self.store.create_job(self.job_id, self.source, self.config, "t0")
        digest = FileDigest(1, "a" * 64)
        self.store.record_verified_input(
            self.job_id,
            VerifiedInputArchive(
                SourceIdentity("source.mp4", digest),
                ManifestEntry(PurePosixPath("inputs/source.mp4"), digest),
                "verified",
            ),
        )

    def test_job_and_pending_unit_survive_reopen(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("ocr:000001", StageName.OCR),
            "t1",
        )
        self.store.close()
        self.store = SqliteStateStore(self.path)

        unit = self.store.get_work_unit(self.job_id, "ocr:000001")

        self.assertEqual(unit, WorkUnit("ocr:000001", StageName.OCR))

    def test_dependencies_survive_reopen_and_gate_start(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("tts", StageName.TTS),
            "t1",
        )
        dependent = WorkUnit(
            "render:plan",
            StageName.RENDER,
            dependencies=("tts",),
        )
        self.store.put_work_unit(self.job_id, dependent, "t1")

        with self.assertRaises(StateTransitionError):
            self.store.start_work_unit(self.job_id, "render:plan", "blocked")

        self.store.close()
        self.store = SqliteStateStore(self.path)
        self.assertEqual(
            self.store.get_work_unit(self.job_id, "render:plan"),
            dependent,
        )
        self.assertEqual(
            self.store.work_units(self.job_id),
            (
                WorkUnit("render:plan", StageName.RENDER, dependencies=("tts",)),
                WorkUnit("tts", StageName.TTS),
            ),
        )

    def test_dependency_must_exist_and_idempotent_put_requires_exact_graph(
        self,
    ) -> None:
        with self.assertRaises(StateStoreError):
            self.store.put_work_unit(
                self.job_id,
                WorkUnit(
                    "render:plan",
                    StageName.RENDER,
                    dependencies=("tts",),
                ),
                "missing",
            )

        self.store.put_work_unit(
            self.job_id,
            WorkUnit("tts", StageName.TTS),
            "t1",
        )
        self.store.put_work_unit(
            self.job_id,
            WorkUnit(
                "render:plan",
                StageName.RENDER,
                dependencies=("tts",),
            ),
            "t2",
        )
        with self.assertRaises(StateStoreError):
            self.store.put_work_unit(
                self.job_id,
                WorkUnit("render:plan", StageName.RENDER),
                "changed",
            )

    def test_pending_dependencies_replace_with_exact_compare_and_swap(
        self,
    ) -> None:
        for unit in (
            WorkUnit("tts", StageName.TTS),
            WorkUnit(
                "render:plan",
                StageName.RENDER,
                dependencies=("tts",),
            ),
            WorkUnit(
                "render:000000",
                StageName.RENDER,
                dependencies=("render:plan",),
            ),
            WorkUnit("render", StageName.RENDER),
        ):
            self.store.put_work_unit(self.job_id, unit, "planned")

        self.store.replace_work_unit_dependencies(
            self.job_id,
            "render",
            (),
            ("render:000000",),
            "rewired",
        )

        self.assertEqual(
            self.store.get_work_unit(self.job_id, "render").dependencies,
            ("render:000000",),
        )
        with self.assertRaises(StateStoreError):
            self.store.replace_work_unit_dependencies(
                self.job_id,
                "render",
                (),
                ("tts",),
                "stale",
            )
        self.assertEqual(
            self.store.get_work_unit(self.job_id, "render").dependencies,
            ("render:000000",),
        )

    def test_dependency_replacement_rejects_running_or_cyclic_graph(
        self,
    ) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("tts", StageName.TTS),
            "planned",
        )
        self.store.put_work_unit(
            self.job_id,
            WorkUnit(
                "render:plan",
                StageName.RENDER,
                dependencies=("tts",),
            ),
            "planned",
        )
        self.store.start_work_unit(self.job_id, "tts", "started")
        with self.assertRaises(StateStoreError):
            self.store.replace_work_unit_dependencies(
                self.job_id,
                "tts",
                (),
                ("render:plan",),
                "running",
            )
        self.store.commit_artifact(
            self.job_id,
            "tts",
            # The content identity is irrelevant to graph replacement.
            Artifact(
                "tts",
                PurePosixPath("artifacts/tts/tts.json"),
                1,
                "b" * 64,
                StageName.TTS,
            ),
            "committed",
        )
        with self.assertRaises(StateStoreError):
            self.store.replace_work_unit_dependencies(
                self.job_id,
                "render:plan",
                ("tts",),
                ("render:plan",),
                "self-cycle",
            )

    def test_job_creation_is_idempotent_only_for_matching_identity(self) -> None:
        self.store.create_job(self.job_id, self.source, self.config, "t1")

        with self.assertRaisesRegex(StateStoreError, "identity"):
            self.store.create_job(
                self.job_id,
                Fingerprint("b" * 64),
                self.config,
                "t2",
            )
        changed_config = stage_config_fingerprints(
            EffectiveConfig(ocr=OcrConfig(model_revision="v2"))
        )
        with self.assertRaisesRegex(StateStoreError, "configuration"):
            self.store.create_job(
                self.job_id,
                self.source,
                changed_config,
                "t3",
            )

    def test_stored_configuration_and_atomic_reconfiguration_preserve_upstream(
        self,
    ) -> None:
        self.assertIsNone(
            self.store.stored_config_fingerprints(JobId("missing-job"))
        )
        self.assertEqual(
            self.store.stored_config_fingerprints(self.job_id),
            self.config,
        )
        for stage in (
            StageName.OCR,
            StageName.TTS,
            StageName.RENDER,
            StageName.PUBLISH,
            StageName.BACKUP,
        ):
            self.store.put_work_unit(
                self.job_id,
                WorkUnit(stage.value.lower(), stage),
                "planned",
            )
        changed = stage_config_fingerprints(
            replace(
                EffectiveConfig(),
                render=replace(
                    EffectiveConfig().render,
                    profile_revision="render-v2",
                ),
            )
        )
        invalidation = plan_invalidation(self.config, changed)

        affected = self.store.reconfigure_job(
            self.job_id,
            self.config,
            changed,
            invalidation,
            "reconfigured",
        )

        self.assertEqual(
            affected,
            ("backup", "publish", "render"),
        )
        self.assertEqual(
            self.store.stored_config_fingerprints(self.job_id),
            changed,
        )
        self.assertIs(
            self.store.get_work_unit(self.job_id, "ocr").status,
            WorkStatus.PENDING,
        )
        self.assertIs(
            self.store.get_work_unit(self.job_id, "tts").status,
            WorkStatus.PENDING,
        )
        for key in ("render", "publish", "backup"):
            self.assertIs(
                self.store.get_work_unit(self.job_id, key).status,
                WorkStatus.INVALID,
            )

    def test_stale_reconfiguration_changes_neither_hashes_nor_units(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("render", StageName.RENDER),
            "planned",
        )
        changed = stage_config_fingerprints(
            replace(
                EffectiveConfig(),
                render=replace(
                    EffectiveConfig().render,
                    profile_revision="render-v2",
                ),
            )
        )
        invalidation = plan_invalidation(self.config, changed)

        with self.assertRaises(StateStoreError):
            self.store.reconfigure_job(
                self.job_id,
                changed,
                changed,
                invalidation,
                "stale",
            )

        self.assertEqual(
            self.store.stored_config_fingerprints(self.job_id),
            self.config,
        )
        self.assertIs(
            self.store.get_work_unit(self.job_id, "render").status,
            WorkStatus.PENDING,
        )

    def test_render_only_reconfiguration_can_preserve_s2_plan_and_chunks(
        self,
    ) -> None:
        for key, stage in (
            ("render:plan", StageName.RENDER),
            ("render:000000", StageName.RENDER),
            ("render:part:000001", StageName.RENDER),
            ("render", StageName.RENDER),
            ("publish", StageName.PUBLISH),
            ("backup", StageName.BACKUP),
        ):
            self.store.put_work_unit(
                self.job_id,
                WorkUnit(key, stage),
                "planned",
            )
        changed = stage_config_fingerprints(
            replace(
                EffectiveConfig(),
                render=replace(
                    EffectiveConfig().render,
                    max_part_seconds=600,
                ),
            )
        )
        invalidation = plan_invalidation(self.config, changed)

        affected = self.store.reconfigure_job(
            self.job_id,
            self.config,
            changed,
            invalidation,
            "migrated",
            preserve_render_units=(
                "render:000000",
                "render:plan",
            ),
        )

        self.assertEqual(
            affected,
            (
                "backup",
                "publish",
                "render",
                "render:part:000001",
            ),
        )
        for key in ("render:000000", "render:plan"):
            self.assertIs(
                self.store.get_work_unit(self.job_id, key).status,
                WorkStatus.PENDING,
            )
        for key in affected:
            self.assertIs(
                self.store.get_work_unit(self.job_id, key).status,
                WorkStatus.INVALID,
            )

    def test_reconfiguration_database_failure_rolls_back_hashes_and_units(
        self,
    ) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("render", StageName.RENDER),
            "planned",
        )
        changed = stage_config_fingerprints(
            replace(
                EffectiveConfig(),
                render=replace(
                    EffectiveConfig().render,
                    profile_revision="render-v2",
                ),
            )
        )
        invalidation = plan_invalidation(self.config, changed)
        self.store.connection.executescript(
            """
            CREATE TRIGGER fail_render_fingerprint_update
            BEFORE UPDATE ON config_fingerprints
            WHEN NEW.stage='RENDER'
            BEGIN
                SELECT RAISE(ABORT, 'injected config update failure');
            END;
            """
        )

        with self.assertRaises(StateStoreError):
            self.store.reconfigure_job(
                self.job_id,
                self.config,
                changed,
                invalidation,
                "failed",
            )

        self.assertEqual(
            self.store.stored_config_fingerprints(self.job_id),
            self.config,
        )
        self.assertIs(
            self.store.get_work_unit(self.job_id, "render").status,
            WorkStatus.PENDING,
        )

    def test_failure_records_retry_and_retry_increments_attempt(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("ocr:000001", StageName.OCR),
            "t1",
        )

        running = self.store.start_work_unit(self.job_id, "ocr:000001", "t2")
        failed = self.store.fail_work_unit(
            self.job_id,
            "ocr:000001",
            "ProviderUnavailable",
            "provider unavailable",
            "t3",
        )
        retried = self.store.start_work_unit(self.job_id, "ocr:000001", "t4")
        events = self.store.retry_events(self.job_id, "ocr:000001")

        self.assertEqual((running.status, running.attempts), (WorkStatus.RUNNING, 1))
        self.assertEqual((failed.status, failed.attempts), (WorkStatus.FAILED, 1))
        self.assertEqual((retried.status, retried.attempts), (WorkStatus.RUNNING, 2))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].attempt, 1)
        self.assertEqual(events[0].stage, StageName.OCR)
        self.assertEqual(events[0].error_kind, "ProviderUnavailable")

    def test_invalid_transitions_and_missing_rows_fail_explicitly(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("ocr:000001", StageName.OCR),
            "t1",
        )
        with self.assertRaises(StateTransitionError):
            self.store.fail_work_unit(
                self.job_id,
                "ocr:000001",
                "Error",
                "not running",
                "t2",
            )
        self.store.start_work_unit(self.job_id, "ocr:000001", "t3")
        with self.assertRaises(StateTransitionError):
            self.store.start_work_unit(self.job_id, "ocr:000001", "t4")
        with self.assertRaises(StateStoreError):
            self.store.get_work_unit(self.job_id, "missing")

    def test_stale_running_work_returns_to_pending_and_persists(self) -> None:
        for key, stage in (("ocr:1", StageName.OCR), ("tts:1", StageName.TTS)):
            self.store.put_work_unit(self.job_id, WorkUnit(key, stage), "t1")
            self.store.start_work_unit(self.job_id, key, "t2")

        recovered = self.store.recover_stale_work("restart")
        self.store.close()
        self.store = SqliteStateStore(self.path)

        self.assertEqual(
            recovered,
            ((self.job_id, "ocr:1"), (self.job_id, "tts:1")),
        )
        for key in ("ocr:1", "tts:1"):
            unit = self.store.get_work_unit(self.job_id, key)
            self.assertEqual(unit.status, WorkStatus.PENDING)
            self.assertEqual(unit.attempts, 1)

    def test_corrupt_row_conversion_rolls_back_and_releases_transaction(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("ocr:corrupt", StageName.OCR),
            "t1",
        )
        self.store.connection.execute(
            "UPDATE work_units SET stage='BROKEN' WHERE job_id=? AND unit_key=?",
            (self.job_id.value, "ocr:corrupt"),
        )

        with self.assertRaises(StateStoreError):
            self.store.start_work_unit(self.job_id, "ocr:corrupt", "t2")

        row = self.store.connection.execute(
            "SELECT status FROM work_units WHERE job_id=? AND unit_key=?",
            (self.job_id.value, "ocr:corrupt"),
        ).fetchone()
        self.assertEqual(row["status"], WorkStatus.PENDING.value)
        self.assertFalse(self.store.connection.in_transaction)


if __name__ == "__main__":
    unittest.main()
