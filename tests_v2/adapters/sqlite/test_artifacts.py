from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.invalidation import plan_invalidation
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import Fingerprint, stage_config_fingerprints
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.state import StateTransitionError


class SqliteArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "job-v2.sqlite"
        self.store = SqliteStateStore(self.path)
        self.addCleanup(lambda: self.store.close())
        self.job_id = JobId("job-1")
        self.config = EffectiveConfig()
        self.store.create_job(
            self.job_id,
            Fingerprint("a" * 64),
            stage_config_fingerprints(self.config),
            "t0",
        )

    def _artifact(
        self,
        name: str,
        stage: StageName,
        path: str | None = None,
    ) -> Artifact:
        return Artifact(
            name=name,
            relative_path=PurePosixPath(path or f"artifacts/{name}.json"),
            size_bytes=42,
            sha256=(name[0].lower() if name[0].lower() in "abcdef" else "a") * 64,
            owner=stage,
            dependencies=("input:sha256", "config:sha256"),
        )

    def _running(self, key: str, stage: StageName) -> None:
        self.store.put_work_unit(self.job_id, WorkUnit(key, stage), "planned")
        self.store.start_work_unit(self.job_id, key, "started")

    def test_artifact_and_success_commit_atomically_and_survive_reopen(self) -> None:
        self._running("ocr:1", StageName.OCR)
        artifact = self._artifact("ocr-one", StageName.OCR)

        self.store.commit_artifact(self.job_id, "ocr:1", artifact, "committed")
        self.store.close()
        self.store = SqliteStateStore(self.path)

        self.assertEqual(
            self.store.get_work_unit(self.job_id, "ocr:1").status,
            WorkStatus.SUCCEEDED,
        )
        self.assertEqual(self.store.valid_artifacts(self.job_id), (artifact,))

    def test_commit_rejects_non_running_and_owner_mismatch(self) -> None:
        self.store.put_work_unit(
            self.job_id,
            WorkUnit("ocr:pending", StageName.OCR),
            "planned",
        )
        with self.assertRaises(StateTransitionError):
            self.store.commit_artifact(
                self.job_id,
                "ocr:pending",
                self._artifact("pending", StageName.OCR),
                "commit",
            )

        self._running("ocr:running", StageName.OCR)
        with self.assertRaises(StateTransitionError):
            self.store.commit_artifact(
                self.job_id,
                "ocr:running",
                self._artifact("wrong-owner", StageName.TTS),
                "commit",
            )
        self.assertEqual(self.store.valid_artifacts(self.job_id), ())

    def test_constraint_failure_rolls_back_success_transition(self) -> None:
        self._running("ocr:first", StageName.OCR)
        self.store.commit_artifact(
            self.job_id,
            "ocr:first",
            self._artifact("first", StageName.OCR, "artifacts/shared.json"),
            "commit-1",
        )
        self._running("ocr:second", StageName.OCR)

        with self.assertRaises(StateStoreError):
            self.store.commit_artifact(
                self.job_id,
                "ocr:second",
                self._artifact("second", StageName.OCR, "artifacts/shared.json"),
                "commit-2",
            )

        self.assertEqual(
            self.store.get_work_unit(self.job_id, "ocr:second").status,
            WorkStatus.RUNNING,
        )
        self.assertEqual(
            tuple(item.name for item in self.store.valid_artifacts(self.job_id)),
            ("first",),
        )

    def test_failed_and_succeeded_units_reject_new_commits_and_restarts(self) -> None:
        self._running("ocr:failed", StageName.OCR)
        self.store.fail_work_unit(
            self.job_id,
            "ocr:failed",
            "ProviderError",
            "failed",
            "failure",
        )
        with self.assertRaises(StateTransitionError):
            self.store.commit_artifact(
                self.job_id,
                "ocr:failed",
                self._artifact("failed", StageName.OCR),
                "commit-failed",
            )

        self._running("ocr:succeeded", StageName.OCR)
        self.store.commit_artifact(
            self.job_id,
            "ocr:succeeded",
            self._artifact("succeeded", StageName.OCR),
            "commit-success",
        )
        with self.assertRaises(StateTransitionError):
            self.store.start_work_unit(self.job_id, "ocr:succeeded", "restart")
        with self.assertRaises(StateTransitionError):
            self.store.commit_artifact(
                self.job_id,
                "ocr:succeeded",
                self._artifact("second-success", StageName.OCR),
                "commit-again",
            )

    def test_malformed_artifact_dependency_json_is_rejected(self) -> None:
        self._running("ocr:1", StageName.OCR)
        self.store.commit_artifact(
            self.job_id,
            "ocr:1",
            self._artifact("ocr-one", StageName.OCR),
            "committed",
        )
        self.store.connection.execute(
            "UPDATE artifacts SET dependencies_json=? WHERE job_id=?",
            ('"abc"', self.job_id.value),
        )

        with self.assertRaises(StateStoreError):
            self.store.valid_artifacts(self.job_id)

    def test_invalidation_preserves_independent_units_and_artifacts(self) -> None:
        for index, stage in enumerate(StageName):
            key = f"{stage.value.lower()}:1"
            self._running(key, stage)
            self.store.commit_artifact(
                self.job_id,
                key,
                self._artifact(f"artifact-{index}", stage),
                f"commit-{index}",
            )
        changed = replace(
            self.config,
            tts=replace(self.config.tts, voice="voice-v2"),
        )
        invalidation = plan_invalidation(
            stage_config_fingerprints(self.config),
            stage_config_fingerprints(changed),
        )

        changed_keys = self.store.apply_invalidation(
            self.job_id,
            invalidation,
            "invalidated",
        )
        repeated = self.store.apply_invalidation(
            self.job_id,
            invalidation,
            "invalidated-again",
        )

        self.assertEqual(
            changed_keys,
            ("backup:1", "publish:1", "render:1", "tts:1"),
        )
        self.assertEqual(repeated, ())
        for stage in StageName:
            status = self.store.get_work_unit(
                self.job_id,
                f"{stage.value.lower()}:1",
            ).status
            expected = (
                WorkStatus.INVALID
                if stage in invalidation.affected_stages
                else WorkStatus.SUCCEEDED
            )
            self.assertEqual(status, expected)
        self.assertEqual(
            tuple(item.owner for item in self.store.valid_artifacts(self.job_id)),
            (
                StageName.INGEST,
                StageName.OCR,
                StageName.TRACK,
                StageName.TRANSLATE,
            ),
        )


if __name__ == "__main__":
    unittest.main()
