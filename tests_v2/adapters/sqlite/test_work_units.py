from __future__ import annotations

import tempfile
import unittest
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.domain.backup import (
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.config import EffectiveConfig, OcrConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import JobId, StageName, WorkStatus, WorkUnit
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
