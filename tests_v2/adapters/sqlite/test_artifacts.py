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
        digest = FileDigest(1, "a" * 64)
        self.store.record_verified_input(
            self.job_id,
            VerifiedInputArchive(
                SourceIdentity("source.mp4", digest),
                ManifestEntry(PurePosixPath("inputs/source.mp4"), digest),
                "verified",
            ),
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

    def test_multiple_artifacts_and_success_commit_in_one_transaction(self) -> None:
        self._running("tts:multi", StageName.TTS)
        primary = self._artifact(
            "tts-document",
            StageName.TTS,
            "artifacts/tts/tts.json",
        )
        side = self._artifact(
            "tts-audio",
            StageName.TTS,
            "artifacts/tts/voice.wav",
        )

        self.store.commit_artifacts(
            self.job_id,
            "tts:multi",
            (primary, side),
            "committed",
        )

        self.assertIs(
            self.store.get_work_unit(self.job_id, "tts:multi").status,
            WorkStatus.SUCCEEDED,
        )
        self.assertEqual(
            set(self.store.valid_artifacts(self.job_id)),
            {primary, side},
        )

    def test_multiple_artifact_collision_rolls_back_every_insert_and_success(self) -> None:
        self._running("ocr:existing", StageName.OCR)
        existing = self._artifact(
            "existing",
            StageName.OCR,
            "artifacts/shared.bin",
        )
        self.store.commit_artifact(
            self.job_id,
            "ocr:existing",
            existing,
            "existing",
        )
        self._running("tts:multi", StageName.TTS)
        primary = self._artifact("tts-document", StageName.TTS)
        collision = self._artifact(
            "tts-audio",
            StageName.TTS,
            "artifacts/shared.bin",
        )

        with self.assertRaises(StateStoreError):
            self.store.commit_artifacts(
                self.job_id,
                "tts:multi",
                (primary, collision),
                "conflict",
            )

        self.assertIs(
            self.store.get_work_unit(self.job_id, "tts:multi").status,
            WorkStatus.RUNNING,
        )
        self.assertEqual(self.store.valid_artifacts(self.job_id), (existing,))

    def test_multiple_artifact_contract_rejects_empty_duplicate_and_mixed_owner(self) -> None:
        self._running("tts:multi", StageName.TTS)
        first = self._artifact("tts-document", StageName.TTS)
        duplicate_name = replace(
            self._artifact("tts-audio", StageName.TTS),
            name=first.name,
        )
        duplicate_path = replace(
            self._artifact("tts-audio", StageName.TTS),
            relative_path=first.relative_path,
        )
        mixed_owner = self._artifact("rendered", StageName.RENDER)

        for artifacts in (
            (),
            (first, duplicate_name),
            (first, duplicate_path),
            (first, mixed_owner),
        ):
            with self.subTest(artifacts=artifacts):
                with self.assertRaises((StateStoreError, StateTransitionError)):
                    self.store.commit_artifacts(
                        self.job_id,
                        "tts:multi",
                        artifacts,
                        "invalid",
                    )
                self.assertIs(
                    self.store.get_work_unit(
                        self.job_id,
                        "tts:multi",
                    ).status,
                    WorkStatus.RUNNING,
                )
                self.assertEqual(self.store.valid_artifacts(self.job_id), ())

    def test_multiple_invalidated_artifacts_require_exact_identity_set(self) -> None:
        self._running("tts:multi", StageName.TTS)
        primary = self._artifact("tts-document", StageName.TTS)
        side = self._artifact("tts-audio", StageName.TTS)
        self.store.commit_artifacts(
            self.job_id,
            "tts:multi",
            (primary, side),
            "first",
        )
        invalidation = plan_invalidation(
            stage_config_fingerprints(self.config),
            stage_config_fingerprints(self.config),
            changed_artifact_owners=(StageName.TTS,),
        )
        self.store.apply_invalidation(self.job_id, invalidation, "invalidated")
        self.store.start_work_unit(self.job_id, "tts:multi", "restarted")
        changed = tuple(
            replace(item, size_bytes=84, sha256="b" * 64)
            for item in (primary, side)
        )

        with self.assertRaises(StateStoreError):
            self.store.commit_artifacts(
                self.job_id,
                "tts:multi",
                (changed[0],),
                "missing-side",
            )
        self.assertEqual(self.store.valid_artifacts(self.job_id), ())

        self.store.commit_artifacts(
            self.job_id,
            "tts:multi",
            changed,
            "complete",
        )
        self.assertEqual(set(self.store.valid_artifacts(self.job_id)), set(changed))

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

    def test_invalidated_canonical_artifact_can_be_recommitted_atomically(self) -> None:
        self._running("ocr:canonical", StageName.OCR)
        original = self._artifact(
            "ocr-canonical",
            StageName.OCR,
            "artifacts/ocr/ocr.json",
        )
        self.store.commit_artifact(
            self.job_id,
            "ocr:canonical",
            original,
            "committed-original",
        )
        invalidation = plan_invalidation(
            stage_config_fingerprints(self.config),
            stage_config_fingerprints(self.config),
            changed_artifact_owners=(StageName.OCR,),
        )
        self.store.apply_invalidation(self.job_id, invalidation, "invalidated")
        self.store.start_work_unit(self.job_id, "ocr:canonical", "restarted")
        replacement = replace(
            original,
            size_bytes=84,
            sha256="b" * 64,
            dependencies=("media-canonical",),
        )

        self.store.commit_artifact(
            self.job_id,
            "ocr:canonical",
            replacement,
            "committed-replacement",
        )

        self.assertEqual(
            self.store.get_work_unit(self.job_id, "ocr:canonical").status,
            WorkStatus.SUCCEEDED,
        )
        self.assertEqual(self.store.valid_artifacts(self.job_id), (replacement,))
        row_count = self.store.connection.execute(
            "SELECT COUNT(*) FROM artifacts WHERE job_id=?",
            (self.job_id.value,),
        ).fetchone()[0]
        self.assertEqual(row_count, 1)

    def test_invalidated_recommit_rejects_name_or_path_identity_changes(self) -> None:
        self._running("ocr:canonical", StageName.OCR)
        original = self._artifact(
            "ocr-canonical",
            StageName.OCR,
            "artifacts/ocr/ocr.json",
        )
        self.store.commit_artifact(
            self.job_id,
            "ocr:canonical",
            original,
            "committed-original",
        )
        invalidation = plan_invalidation(
            stage_config_fingerprints(self.config),
            stage_config_fingerprints(self.config),
            changed_artifact_owners=(StageName.OCR,),
        )
        self.store.apply_invalidation(self.job_id, invalidation, "invalidated")
        self.store.start_work_unit(self.job_id, "ocr:canonical", "restarted")

        for conflicting in (
            replace(original, relative_path=PurePosixPath("artifacts/ocr/other.json")),
            replace(original, name="ocr-other"),
            replace(
                original,
                name="ocr-other",
                relative_path=PurePosixPath("artifacts/ocr/other.json"),
            ),
        ):
            with self.subTest(conflicting=conflicting):
                with self.assertRaises(StateStoreError):
                    self.store.commit_artifact(
                        self.job_id,
                        "ocr:canonical",
                        conflicting,
                        "conflicting-recommit",
                    )
                self.assertIs(
                    self.store.get_work_unit(
                        self.job_id, "ocr:canonical"
                    ).status,
                    WorkStatus.RUNNING,
                )
                self.assertEqual(self.store.valid_artifacts(self.job_id), ())
                stored = self.store.connection.execute(
                    "SELECT name,relative_path,size_bytes,sha256,owner_stage,is_valid "
                    "FROM artifacts WHERE job_id=?",
                    (self.job_id.value,),
                ).fetchone()
                self.assertEqual(
                    tuple(stored),
                    (
                        original.name,
                        str(original.relative_path),
                        original.size_bytes,
                        original.sha256,
                        original.owner.value,
                        0,
                    ),
                )


if __name__ == "__main__":
    unittest.main()
