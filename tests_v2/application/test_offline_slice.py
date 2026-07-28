from __future__ import annotations

import importlib
import os
import json
import tempfile
import unittest
from dataclasses import replace
from fractions import Fraction
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaAdapter
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.filesystem.composition import (
    LocalArtifactWriterFactory,
    LocalFileDigestVerifier,
    LocalPartPublisherFactory,
)
from ytb_vps_v2.adapters.filesystem.integrity import LocalFileIntegrity, digest_file
from ytb_vps_v2.adapters.filesystem.publish import LocalPartPublisher
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicOcrProvider,
    DeterministicTranslationProvider,
    DeterministicWaveTtsProvider,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.adapters.sqlite.restore import LocalStagedRestoreWorkspace
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.offline_slice import (
    FreshWorkspaceRequired,
    InterruptionPoint,
    OfflineSliceError,
    OfflineSliceInterrupted,
    OfflineSliceRequest,
    OfflineSliceRunner,
)
from ytb_vps_v2.application.restore import CheckpointRestorer, RestoreError
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, Part, RegionKind
from ytb_vps_v2.domain.models import JobId, StageName, WorkStatus
from ytb_vps_v2.domain.pipeline import (
    CHECKPOINT_ARTIFACT_PATH,
    PIPELINE_ARTIFACT_PATHS,
    RENDER_CHUNK_PLAN_ARTIFACT_PATH,
    MediaDocument,
    PublicationDocument,
    RenderPlanDocument,
    RenderRequest,
    TtsDocument,
    parse_render_plan_document_bytes,
    parse_publication_document_bytes,
    parse_tts_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval
from ytb_vps_v2.domain.timeline import Timeline
from ytb_vps_v2.ports.pipeline import ArtifactWriteError


def _local_slice_ports():
    return (
        LocalArtifactWriterFactory(),
        LocalPartPublisherFactory(),
        LocalFileDigestVerifier(),
    )


class LocalPartPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.source = self.root / "rendered.mp4"
        self.source.write_bytes(b"verified rendered bytes")
        self.part = Part(1, 1, FrameInterval(0, 900), (0,))

    def test_publishes_fixed_part_additively_with_verified_readback(self) -> None:
        publisher = LocalPartPublisher(self.workspace)

        first = publisher.publish(self.source, self.part)
        second = publisher.publish(self.source, self.part)

        self.assertEqual(first, second)
        self.assertEqual(first.key, PurePosixPath("published/part-001.mp4"))
        self.assertEqual(
            self.workspace.joinpath(*first.key.parts).read_bytes(),
            self.source.read_bytes(),
        )

        self.workspace.joinpath(*first.key.parts).write_bytes(b"conflict")
        with self.assertRaises(ArtifactWriteError):
            publisher.publish(self.source, self.part)
        self.assertEqual(
            self.workspace.joinpath(*first.key.parts).read_bytes(),
            b"conflict",
        )


class OfflineSliceApiTests(unittest.TestCase):
    def test_restartable_offline_slice_application_api_exists(self) -> None:
        module = importlib.import_module("ytb_vps_v2.application.offline_slice")
        expected = (
            "OfflineSliceRunner",
            "OfflineSliceRequest",
            "OfflineSliceResult",
            "InterruptionPoint",
        )
        self.assertEqual(
            tuple(name for name in expected if not hasattr(module, name)),
            (),
        )

    def test_application_layer_has_no_adapter_imports(self) -> None:
        application = Path(
            importlib.import_module("ytb_vps_v2.application").__file__
        ).parent
        violations = tuple(
            path.name
            for path in sorted(application.glob("*.py"))
            if "ytb_vps_v2.adapters" in path.read_text(encoding="utf-8")
        )

        self.assertEqual(violations, ())

    def test_runner_never_parses_canonical_documents_through_path_read(self) -> None:
        source = Path(
            importlib.import_module(
                "ytb_vps_v2.application.offline_slice"
            ).__file__
        ).read_text(encoding="utf-8")

        self.assertNotIn(".read_bytes()", source)

    def test_runner_uses_typed_media_documents_and_prepared_stage_values(self) -> None:
        source = Path(
            importlib.import_module(
                "ytb_vps_v2.application.offline_slice"
            ).__file__
        ).read_text(encoding="utf-8")

        self.assertNotIn("media: object", source)
        self.assertNotIn("prepared: object", source)
        self.assertNotIn("dict[StageName, object]", source)
        self.assertNotIn("# type: ignore", source)


class OfflineSliceEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture_temp = tempfile.TemporaryDirectory()
        cls.fixture_root = Path(cls.fixture_temp.name)
        cls.media = FfmpegMediaAdapter()
        cls.media.require_tools()
        cls.audio_source = cls.fixture_root / "fixture-audio.mp4"
        cls.silent_source = cls.fixture_root / "fixture-silent.mp4"
        cls.media.create_fixture(cls.audio_source, with_audio=True)
        cls.media.create_fixture(cls.silent_source, with_audio=False)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture_temp.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.archive_root = self.root / "archive"
        self.remote_root = self.root / "remote"
        self.snapshot_root = self.root / "snapshots"
        self.state_root = self.root / "state"
        for directory in (
            self.workspace,
            self.archive_root,
            self.remote_root,
            self.snapshot_root,
            self.state_root,
        ):
            directory.mkdir()

    def _run_slice(self, source: Path, *, output_has_audio: bool):
        job_id = JobId("offline-e2e-job")
        archive = VerifiedInputArchiver(self.archive_root).archive(
            source,
            job_id,
            "2026-07-17T09:00:00+07:00",
        )
        archived_source = self.archive_root.joinpath(*archive.archive.key.parts)
        state_path = self.state_root / "job-v2.sqlite"
        state = SqliteStateStore(state_path)
        self.addCleanup(state.close)
        checkpoints = CheckpointPublisher(
            state,
            LocalAdditiveObjectStore(self.remote_root),
            self.archive_root,
            LocalFileIntegrity(),
        )
        request = OfflineSliceRequest(
            job_id=job_id,
            source=archived_source,
            verified_input=archive,
            config_fingerprints=stage_config_fingerprints(EffectiveConfig()),
            workspace_root=self.workspace,
            snapshot_dir=self.snapshot_root,
            output_has_audio=output_has_audio,
            at="2026-07-17T09:00:01+07:00",
            verification_observed_at=100,
            proof_checkpoint_id="offline-proof-v1",
            final_checkpoint_id="offline-final-v1",
            blur_regions=(
                BlurRegion(
                    RegionKind.STATIC,
                    FrameInterval(0, 900),
                    BoundingBox(8, 8, 64, 64),
                ),
            ),
        )
        runner = OfflineSliceRunner(
            state,
            checkpoints,
            self.media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        )
        result = runner.run(request)
        return state_path, state, request, result

    def _assert_complete(self, state: SqliteStateStore, request, result) -> None:
        self.assertEqual(result.workspace_root, self.workspace)
        self.assertEqual(
            tuple(unit.stage for unit in result.work_units),
            tuple(StageName),
        )
        self.assertTrue(
            all(unit.status is WorkStatus.SUCCEEDED for unit in result.work_units)
        )
        self.assertEqual(len(result.artifacts), 11)
        expected_paths = tuple(
            path
            for path in PIPELINE_ARTIFACT_PATHS.values()
            if path != RENDER_CHUNK_PLAN_ARTIFACT_PATH
        )
        primary_paths = set(expected_paths)
        primary_artifacts = tuple(
            artifact
            for artifact in result.artifacts
            if artifact.relative_path in primary_paths
        )
        self.assertEqual(len(primary_artifacts), 8)
        by_owner = {artifact.owner: artifact for artifact in primary_artifacts}
        self.assertEqual(set(by_owner), set(StageName))
        self.assertEqual(
            tuple(by_owner[stage].relative_path for stage in StageName),
            expected_paths,
        )
        for index, stage in enumerate(StageName):
            artifact = by_owner[stage]
            expected_dependencies = (
                () if index == 0 else (by_owner[tuple(StageName)[index - 1]].name,)
            )
            self.assertEqual(artifact.dependencies, expected_dependencies)
            LocalArtifactWriter(self.workspace).verify(
                artifact.relative_path,
                artifact_digest := digest_file(
                    self.workspace.joinpath(*artifact.relative_path.parts)
                ),
            )
            self.assertEqual(artifact.size_bytes, artifact_digest.size_bytes)
            self.assertEqual(artifact.sha256, artifact_digest.sha256)

        part_path = self.workspace.joinpath(*result.publication.part_paths[0].parts)
        self.assertEqual(digest_file(part_path), result.publication.part_digests[0])
        tts_artifact = by_owner[StageName.TTS]
        tts_document = parse_tts_document_bytes(
            self.workspace.joinpath(*tts_artifact.relative_path.parts).read_bytes()
        )
        render_artifact = by_owner[StageName.RENDER]
        render_plan = parse_render_plan_document_bytes(
            self.workspace.joinpath(*render_artifact.relative_path.parts).read_bytes()
        )
        self.assertTrue(any(region.kind is RegionKind.STATIC for region in render_plan.blur_regions))
        render_request = RenderRequest(
            *(
                getattr(render_plan, field)
                for field in (
                    "schema_version",
                    "job_id",
                    "media_digest",
                    "frame_count",
                    "width",
                    "height",
                    "dependency_path",
                    "dependency_digest",
                    "cues",
                    "blur_regions",
                    "tts_audio_path",
                    "tts_audio_digest",
                    "parts",
                    "output_has_audio",
                )
            )
        )
        rendered = self.media.validate_render(part_path, render_request)
        self.assertIs(rendered.has_audio, request.output_has_audio)
        side_by_name = {
            artifact.name: artifact
            for artifact in result.artifacts
            if artifact.relative_path not in primary_paths
        }
        expected_sides = {
            "tts-audio": (
                StageName.TTS,
                tts_document.audio_path,
                tts_document.audio_digest,
            ),
            "rendered-video": (
                StageName.RENDER,
                render_plan.rendered_path,
                render_plan.rendered_digest,
            ),
            "published-part-001": (
                StageName.PUBLISH,
                result.publication.part_paths[0],
                result.publication.part_digests[0],
            ),
        }
        self.assertEqual(set(side_by_name), set(expected_sides))
        for name, (owner, path, digest) in expected_sides.items():
            side = side_by_name[name]
            self.assertIs(side.owner, owner)
            self.assertEqual(side.relative_path, path)
            self.assertEqual(FileDigest(side.size_bytes, side.sha256), digest)
            self.assertEqual(side.dependencies, by_owner[owner].dependencies)
            LocalArtifactWriter(self.workspace).verify(path, digest)

        self.assertEqual(
            result.checkpoint.checkpoint_id,
            result.proof_manifest.checkpoint_id,
        )
        self.assertTrue(
            result.proof_manifest.checkpoint_id.startswith("offline-proof-v1-")
        )
        self.assertTrue(
            result.final_manifest.checkpoint_id.startswith("offline-final-v1-")
        )
        final_records = tuple(
            item
            for item in state.completed_checkpoints(request.job_id)
            if item.checkpoint_id == result.final_manifest.checkpoint_id
        )
        self.assertEqual(len(final_records), 1)
        self.assertEqual(result.final_checkpoint.manifest, final_records[0].manifest)
        self.assertEqual(len(result.final_manifest.artifacts), 11)
        self.assertEqual(len(result.proof_manifest.artifacts), 10)
        snapshot_path = self.remote_root.joinpath(
            *result.final_manifest.state_snapshot.key.parts
        )
        snapshot = SqliteStateStore(snapshot_path)
        try:
            self.assertEqual(len(snapshot.valid_artifacts(request.job_id)), 11)
            self.assertTrue(
                all(
                    snapshot.get_work_unit(request.job_id, stage.value.lower()).status
                    is WorkStatus.SUCCEEDED
                    for stage in StageName
                )
            )
        finally:
            snapshot.close()

    def _assert_clean_rerun_is_byte_identical(
        self,
        state_path: Path,
        state: SqliteStateStore,
        request: OfflineSliceRequest,
        first,
    ) -> None:
        before = {
            artifact.relative_path: self.workspace.joinpath(
                *artifact.relative_path.parts
            ).read_bytes()
            for artifact in first.artifacts
        }
        state.close()
        reopened = SqliteStateStore(state_path)
        self.addCleanup(reopened.close)
        runner = OfflineSliceRunner(
            reopened,
            CheckpointPublisher(
                reopened,
                LocalAdditiveObjectStore(self.remote_root),
                self.archive_root,
                LocalFileIntegrity(),
            ),
            self.media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        )

        second = runner.run(request)

        self.assertEqual(second.artifacts, first.artifacts)
        self.assertEqual(second.final_manifest, first.final_manifest)
        self.assertEqual(
            before,
            {
                artifact.relative_path: self.workspace.joinpath(
                    *artifact.relative_path.parts
                ).read_bytes()
                for artifact in second.artifacts
            },
        )

    def test_real_audio_fixture_completes_exact_restartable_graph(self) -> None:
        state_path, state, request, result = self._run_slice(
            self.audio_source,
            output_has_audio=True,
        )
        self._assert_complete(state, request, result)
        self._assert_clean_rerun_is_byte_identical(
            state_path, state, request, result
        )

    def test_real_no_audio_fixture_completes_with_explicit_silent_output(self) -> None:
        state_path, state, request, result = self._run_slice(
            self.silent_source,
            output_has_audio=False,
        )
        self._assert_complete(state, request, result)
        self._assert_clean_rerun_is_byte_identical(
            state_path, state, request, result
        )

    def test_final_checkpoint_restores_all_side_assets_for_zero_work_cold_resume(
        self,
    ) -> None:
        _, state, request, first = self._run_slice(
            self.audio_source,
            output_has_audio=True,
        )
        self._assert_complete(state, request, first)
        store = LocalAdditiveObjectStore(self.remote_root)
        restorer = CheckpointRestorer(store, LocalStagedRestoreWorkspace())
        restore_parent = self.root / "restores"
        restore_parent.mkdir()
        side_artifacts = tuple(
            artifact
            for artifact in first.artifacts
            if artifact.name
            in {"tts-audio", "rendered-video", "published-part-001"}
        )
        self.assertEqual(len(side_artifacts), 3)

        for artifact in side_artifacts:
            remote_entry = next(
                entry
                for entry in first.final_manifest.artifacts
                if entry.digest.size_bytes == artifact.size_bytes
                and entry.digest.sha256 == artifact.sha256
            )
            remote_path = self.remote_root.joinpath(*remote_entry.key.parts)
            original = remote_path.read_bytes()
            for damage in ("missing", "corrupt"):
                with self.subTest(side=artifact.name, damage=damage):
                    if damage == "missing":
                        remote_path.unlink()
                    else:
                        remote_path.write_bytes(b"corrupt restored side")
                    failed_target = restore_parent / f"{artifact.name}-{damage}"
                    try:
                        with self.assertRaises(RestoreError):
                            restorer.restore(
                                first.final_checkpoint.manifest,
                                failed_target,
                                restore_parent,
                                101,
                            )
                        self.assertFalse(failed_target.exists())
                    finally:
                        remote_path.write_bytes(original)

        target = restore_parent / "cold-resume"
        restored = restorer.restore(
            first.final_checkpoint.manifest,
            target,
            restore_parent,
            102,
        )
        self.assertEqual(restored.artifact_count, 11)
        restored_workspace = target / "workspace"
        restored_archive = target / "archive"
        restored_snapshots = target / "snapshots"
        restored_snapshots.mkdir()
        before_bytes = {
            artifact.name: self.workspace.joinpath(
                *artifact.relative_path.parts
            ).read_bytes()
            for artifact in side_artifacts
        }
        self.assertEqual(
            before_bytes,
            {
                artifact.name: restored_workspace.joinpath(
                    *artifact.relative_path.parts
                ).read_bytes()
                for artifact in side_artifacts
            },
        )

        restored_state = SqliteStateStore(target / "job-v2.sqlite")
        self.addCleanup(restored_state.close)
        restored_request = replace(
            request,
            source=restored_archive.joinpath(*request.verified_input.archive.key.parts),
            workspace_root=restored_workspace,
            snapshot_dir=restored_snapshots,
            fresh_workspace_root=None,
        )
        cold = OfflineSliceRunner(
            restored_state,
            CheckpointPublisher(
                restored_state,
                store,
                restored_archive,
                LocalFileIntegrity(),
            ),
            self.media,
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        ).run(restored_request)

        self.assertEqual(tuple(unit.attempts for unit in cold.work_units), (1,) * 8)
        self.assertEqual(
            tuple(unit.status for unit in cold.work_units),
            (WorkStatus.SUCCEEDED,) * 8,
        )
        self.assertEqual(cold.artifacts, first.artifacts)
        self.assertEqual(len(cold.artifacts), 11)
        self.assertEqual(
            len(
                tuple(
                    artifact
                    for artifact in cold.artifacts
                    if artifact.relative_path in set(PIPELINE_ARTIFACT_PATHS.values())
                )
            ),
            8,
        )
        render_artifact = next(
            artifact
            for artifact in cold.artifacts
            if artifact.relative_path == PIPELINE_ARTIFACT_PATHS[RenderPlanDocument]
        )
        render_plan = parse_render_plan_document_bytes(
            restored_workspace.joinpath(
                *render_artifact.relative_path.parts
            ).read_bytes()
        )
        render_request = RenderRequest(
            render_plan.schema_version,
            render_plan.job_id,
            render_plan.media_digest,
            render_plan.frame_count,
            render_plan.width,
            render_plan.height,
            render_plan.dependency_path,
            render_plan.dependency_digest,
            render_plan.cues,
            render_plan.blur_regions,
            render_plan.tts_audio_path,
            render_plan.tts_audio_digest,
            render_plan.parts,
            render_plan.output_has_audio,
        )
        restored_part = restored_workspace.joinpath(*cold.publication.part_paths[0].parts)
        self.assertEqual(digest_file(restored_part), cold.publication.part_digests[0])
        self.media.validate_render(restored_part, render_request)


class _LightweightMedia:
    @staticmethod
    def probe(source: Path) -> MediaDocument:
        return MediaDocument(
            1,
            JobId("offline-job"),
            PurePosixPath("inputs") / source.name,
            digest_file(source),
            Fraction(30),
            Fraction(30),
            Timeline(30),
            900,
            320,
            180,
            False,
        )

    def render(
        self,
        source: Path,
        tts_wav: Path,
        plan: RenderRequest,
        destination: Path,
    ) -> MediaDocument:
        if digest_file(source) != plan.media_digest:
            raise RuntimeError("lightweight render source mismatch")
        if digest_file(tts_wav) != plan.tts_audio_digest:
            raise RuntimeError("lightweight TTS mismatch")
        destination.write_bytes(
            b"lightweight-render-v1\0"
            + bytes.fromhex(plan.media_digest.sha256)
            + (b"audio" if plan.output_has_audio else b"silent")
        )
        return self.validate_render(destination, plan)

    @staticmethod
    def validate_render(path: Path, expected: RenderRequest) -> MediaDocument:
        raw = path.read_bytes()
        if not raw.startswith(b"lightweight-render-v1\0"):
            raise RuntimeError("lightweight rendered bytes are invalid")
        return MediaDocument(
            1,
            expected.job_id,
            PurePosixPath("inputs") / path.name,
            digest_file(path),
            Fraction(30),
            Fraction(30),
            Timeline(30),
            expected.frame_count,
            expected.width,
            expected.height,
            expected.output_has_audio,
        )


class _InterruptOnce:
    def __init__(self, stage: StageName, point: InterruptionPoint) -> None:
        self.stage = stage
        self.point = point
        self.raised = False

    def __call__(self, stage: StageName, point: InterruptionPoint) -> None:
        if not self.raised and stage is self.stage and point is self.point:
            self.raised = True
            raise OfflineSliceInterrupted(f"interrupt {stage.value} {point.value}")


class _CorruptProofStateOnFirstVerification:
    def __init__(self, root: Path) -> None:
        self.delegate = LocalAdditiveObjectStore(root)
        self.root = root
        self.armed = True
        self.proof_prefix = None
        self.observations = []

    def put(self, source, key, expected):
        if self.proof_prefix is None and key.name == "job-v2.sqlite":
            self.proof_prefix = key.parent.parent
        return self.delegate.put(source, key, expected)

    def read_bytes(self, key, max_bytes):
        return self.delegate.read_bytes(key, max_bytes)

    def verify(self, key, expected, observed_at, method):
        self.observations.append((observed_at, method))
        if (
            self.armed
            and self.proof_prefix is not None
            and key == self.proof_prefix / "manifest-v2.json"
        ):
            state_key = key.parent / "state" / "job-v2.sqlite"
            self.root.joinpath(*state_key.parts).write_bytes(b"corrupt proof state")
            self.armed = False
        return self.delegate.verify(key, expected, observed_at, method)

    def materialize(self, key, destination, expected):
        return self.delegate.materialize(key, destination, expected)


class OfflineSliceInterruptionTests(unittest.TestCase):
    def _runner(
        self,
        state: SqliteStateStore,
        remote: Path,
        archive_root: Path,
        interruption=None,
    ) -> OfflineSliceRunner:
        return OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                LocalAdditiveObjectStore(remote),
                archive_root,
                LocalFileIntegrity(),
            ),
            _LightweightMedia(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
            interruption,
        )

    def test_every_stage_boundary_restarts_without_duplication_or_overwrite(self) -> None:
        for stage in StageName:
            for point in InterruptionPoint:
                with self.subTest(stage=stage.value, point=point.value):
                    with tempfile.TemporaryDirectory() as temporary:
                        root = Path(temporary)
                        workspace = root / "workspace"
                        archive_root = root / "archive"
                        remote = root / "remote"
                        snapshots = root / "snapshots"
                        state_root = root / "state"
                        for directory in (
                            workspace,
                            archive_root,
                            remote,
                            snapshots,
                            state_root,
                        ):
                            directory.mkdir()
                        source = root / "source.mp4"
                        source.write_bytes(b"deterministic lightweight source")
                        job_id = JobId(f"matrix-{stage.value}-{point.value}")
                        archive = VerifiedInputArchiver(archive_root).archive(
                            source,
                            job_id,
                            "matrix-time",
                        )
                        archived_source = archive_root.joinpath(
                            *archive.archive.key.parts
                        )
                        request = OfflineSliceRequest(
                            job_id,
                            archived_source,
                            archive,
                            stage_config_fingerprints(EffectiveConfig()),
                            workspace,
                            snapshots,
                            True,
                            "matrix-time",
                            100,
                            "matrix-proof",
                            "matrix-final",
                        )
                        state_path = state_root / "job-v2.sqlite"
                        state = SqliteStateStore(state_path)
                        interrupter = _InterruptOnce(stage, point)
                        with self.assertRaises(OfflineSliceInterrupted):
                            self._runner(
                                state,
                                remote,
                                archive_root,
                                interrupter,
                            ).run(request)
                        self.assertTrue(interrupter.raised)
                        interrupted_unit = state.get_work_unit(
                            job_id, stage.value.lower()
                        )
                        expected_status = (
                            WorkStatus.SUCCEEDED
                            if point is InterruptionPoint.AFTER_SQLITE_COMMIT
                            else WorkStatus.RUNNING
                        )
                        self.assertIs(interrupted_unit.status, expected_status)
                        if (
                            stage is StageName.BACKUP
                            and point is InterruptionPoint.AFTER_SQLITE_COMMIT
                        ):
                            self.assertEqual(
                                len(state.completed_checkpoints(job_id)),
                                1,
                            )
                            self.assertTrue(
                                state.completed_checkpoints(job_id)[0]
                                .checkpoint_id.startswith("matrix-proof-")
                            )
                        state.close()

                        reopened = SqliteStateStore(state_path)
                        result = self._runner(
                            reopened,
                            remote,
                            archive_root,
                        ).run(request)
                        try:
                            self.assertEqual(len(result.artifacts), 11)
                            self.assertTrue(
                                all(
                                    unit.status is WorkStatus.SUCCEEDED
                                    for unit in result.work_units
                                )
                            )
                            self.assertEqual(
                                reopened.get_work_unit(
                                    job_id, stage.value.lower()
                                ).attempts,
                                1
                                if point is InterruptionPoint.AFTER_SQLITE_COMMIT
                                else 2,
                            )
                            self.assertEqual(
                                len(
                                    {
                                        artifact.owner
                                        for artifact in reopened.valid_artifacts(job_id)
                                    }
                                ),
                                8,
                            )
                            self.assertEqual(
                                tuple(snapshots.glob("offline-render-*.mp4")),
                                (),
                            )
                            checkpoint_ids = tuple(
                                item.checkpoint_id
                                for item in reopened.completed_checkpoints(job_id)
                            )
                            self.assertEqual(len(checkpoint_ids), 2)
                            self.assertTrue(
                                any(item.startswith("matrix-final-") for item in checkpoint_ids)
                            )
                            self.assertTrue(
                                any(item.startswith("matrix-proof-") for item in checkpoint_ids)
                            )
                        finally:
                            reopened.close()


class OfflineSliceResumeTests(unittest.TestCase):
    def _environment(self, root: Path):
        workspace = root / "workspace"
        archive_root = root / "archive"
        remote = root / "remote"
        snapshots = root / "snapshots"
        state_root = root / "state"
        for directory in (
            workspace,
            archive_root,
            remote,
            snapshots,
            state_root,
        ):
            directory.mkdir()
        source = root / "source.mp4"
        source.write_bytes(b"deterministic corruption source")
        job_id = JobId("resume-job")
        archive = VerifiedInputArchiver(archive_root).archive(
            source,
            job_id,
            "resume-time",
        )
        request = OfflineSliceRequest(
            job_id,
            archive_root.joinpath(*archive.archive.key.parts),
            archive,
            stage_config_fingerprints(EffectiveConfig()),
            workspace,
            snapshots,
            True,
            "resume-time",
            100,
            "resume-proof",
            "resume-final",
        )
        state = SqliteStateStore(state_root / "job-v2.sqlite")
        runner = OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                LocalAdditiveObjectStore(remote),
                archive_root,
                LocalFileIntegrity(),
            ),
            _LightweightMedia(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        )
        return workspace, archive_root, remote, state, runner, request

    def test_render_configuration_change_reconciles_before_resume(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, _, _, state, runner, request = self._environment(root)
        self.addCleanup(state.close)
        first = runner.run(request)
        changed_config = replace(
            EffectiveConfig(),
            render=replace(
                EffectiveConfig().render,
                profile_revision="render-v2",
            ),
        )
        changed_fingerprints = stage_config_fingerprints(changed_config)
        fresh = root / "fresh"
        fresh.mkdir()

        resumed = runner.run(
            replace(
                request,
                config_fingerprints=changed_fingerprints,
                fresh_workspace_root=fresh,
            )
        )

        self.assertEqual(
            state.stored_config_fingerprints(request.job_id),
            changed_fingerprints,
        )
        before = {unit.stage: unit.attempts for unit in first.work_units}
        after = {unit.stage: unit.attempts for unit in resumed.work_units}
        for stage in (
            StageName.INGEST,
            StageName.OCR,
            StageName.TRACK,
            StageName.TRANSLATE,
            StageName.TTS,
        ):
            self.assertEqual(after[stage], before[stage])
        for stage in (
            StageName.RENDER,
            StageName.PUBLISH,
            StageName.BACKUP,
        ):
            self.assertEqual(after[stage], before[stage] + 1)

    def test_corrupt_primary_invalidates_owner_and_recomputes_only_in_fresh_workspace(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        with self.subTest(resume="corrupt-primary"):
            root = Path(temporary.name)
            workspace, archive_root, remote, state, runner, request = (
                self._environment(root)
            )
            self.addCleanup(state.close)
            first = runner.run(request)
            attempts_before = {
                unit.stage: unit.attempts for unit in first.work_units
            }
            ocr_artifact = next(
                item for item in first.artifacts if item.owner is StageName.OCR
            )
            workspace.joinpath(*ocr_artifact.relative_path.parts).write_bytes(
                b"corrupt canonical OCR"
            )

            with self.assertRaises(FreshWorkspaceRequired):
                runner.run(request)

            self.assertIs(
                state.get_work_unit(request.job_id, "ingest").status,
                WorkStatus.SUCCEEDED,
            )
            self.assertTrue(
                all(
                    state.get_work_unit(request.job_id, stage.value.lower()).status
                    is WorkStatus.INVALID
                    for stage in tuple(StageName)[1:]
                )
            )
            fresh = root / "fresh-workspace"
            fresh.mkdir()
            resumed = runner.run(replace(request, fresh_workspace_root=fresh))
            try:
                self.assertEqual(resumed.workspace_root, fresh)
                self.assertEqual(
                    resumed.work_units[0].attempts,
                    attempts_before[StageName.INGEST],
                )
                self.assertTrue(
                    all(
                        unit.attempts == attempts_before[unit.stage] + 1
                        for unit in resumed.work_units[1:]
                    )
                )
                self.assertEqual(len(resumed.artifacts), 11)
                self.assertEqual(
                    digest_file(
                        fresh.joinpath(*ocr_artifact.relative_path.parts)
                    ).sha256,
                    next(
                        item.sha256
                        for item in resumed.artifacts
                        if item.owner is StageName.OCR
                    ),
                )
                refreshed_snapshot = remote.joinpath(
                    *resumed.final_manifest.state_snapshot.key.parts
                )
                snapshot = SqliteStateStore(refreshed_snapshot)
                try:
                    self.assertEqual(
                        snapshot.get_work_unit(request.job_id, "ocr").attempts,
                        attempts_before[StageName.OCR] + 1,
                    )
                finally:
                    snapshot.close()
            finally:
                state.close()

    def test_missing_side_assets_invalidate_their_owning_stage_and_downstream(self) -> None:
        cases = (
            (StageName.TTS, parse_tts_document_bytes, "audio_path"),
            (StageName.RENDER, parse_render_plan_document_bytes, "rendered_path"),
            (StageName.PUBLISH, parse_publication_document_bytes, "part_paths"),
        )
        for owner, parser, path_field in cases:
            with self.subTest(owner=owner.value):
                temporary = tempfile.TemporaryDirectory()
                self.addCleanup(temporary.cleanup)
                root = Path(temporary.name)
                workspace, _, _, state, runner, request = self._environment(root)
                self.addCleanup(state.close)
                first = runner.run(request)
                primary_path = PIPELINE_ARTIFACT_PATHS[
                    {
                        StageName.TTS: TtsDocument,
                        StageName.RENDER: RenderPlanDocument,
                        StageName.PUBLISH: PublicationDocument,
                    }[owner]
                ]
                primary = next(
                    item
                    for item in first.artifacts
                    if item.owner is owner and item.relative_path == primary_path
                )
                document = parser(
                    workspace.joinpath(*primary.relative_path.parts).read_bytes()
                )
                reference = getattr(document, path_field)
                side_path = reference[0] if isinstance(reference, tuple) else reference
                workspace.joinpath(*side_path.parts).unlink()

                with self.assertRaises(FreshWorkspaceRequired):
                    runner.run(request)

                fresh = root / "fresh"
                fresh.mkdir()
                resumed = runner.run(
                    replace(request, fresh_workspace_root=fresh)
                )
                owner_index = tuple(StageName).index(owner)
                self.assertTrue(
                    all(
                        resumed.work_units[index].attempts
                        == first.work_units[index].attempts
                        for index in range(owner_index)
                    )
                )
                self.assertTrue(
                    all(
                        resumed.work_units[index].attempts
                        == first.work_units[index].attempts + 1
                        for index in range(owner_index, len(tuple(StageName)))
                    )
                )
                self.assertEqual(resumed.workspace_root, fresh)
                self.assertEqual(len(resumed.artifacts), 11)

    def test_ambiguous_owner_and_dependency_mismatch_are_rejected_fail_closed(self) -> None:
        for variant in ("ambiguous-owner", "dependency-mismatch"):
            with self.subTest(variant=variant):
                temporary = tempfile.TemporaryDirectory()
                self.addCleanup(temporary.cleanup)
                root = Path(temporary.name)
                _, _, _, state, runner, request = self._environment(root)
                self.addCleanup(state.close)
                completed = runner.run(request)
                attempts = tuple(unit.attempts for unit in completed.work_units)
                if variant == "ambiguous-owner":
                    state.connection.execute(
                        "INSERT INTO artifacts("
                        "job_id,name,relative_path,size_bytes,sha256,owner_stage,"
                        "unit_key,dependencies_json,is_valid,committed_at"
                        ") VALUES (?,?,?,?,?,?,?,?,1,?)",
                        (
                            request.job_id.value,
                            "ambiguous-ocr-document",
                            "artifacts/ocr/ambiguous.json",
                            1,
                            "a" * 64,
                            StageName.OCR.value,
                            StageName.OCR.value.lower(),
                            json.dumps(("ingest-document",), separators=(",", ":")),
                            "tampered",
                        ),
                    )
                else:
                    state.connection.execute(
                        "UPDATE artifacts SET dependencies_json=? "
                        "WHERE job_id=? AND owner_stage=?",
                        (
                            json.dumps(("wrong-upstream",), separators=(",", ":")),
                            request.job_id.value,
                            StageName.OCR.value,
                        ),
                    )

                with self.assertRaisesRegex(
                    OfflineSliceError,
                    "ambiguous|inconsistent",
                ):
                    runner.run(request)

                self.assertEqual(
                    tuple(
                        state.get_work_unit(
                            request.job_id, stage.value.lower()
                        ).attempts
                        for stage in StageName
                    ),
                    attempts,
                )

    def test_provider_failure_records_one_bounded_retry_event_and_can_retry(self) -> None:
        class FailingProbe(_LightweightMedia):
            @staticmethod
            def probe(source: Path) -> MediaDocument:
                raise RuntimeError("x" * 10_000)

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, archive_root, remote, state, _, request = self._environment(root)
        self.addCleanup(state.close)
        failing = OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                LocalAdditiveObjectStore(remote),
                archive_root,
                LocalFileIntegrity(),
            ),
            FailingProbe(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        )

        with self.assertRaisesRegex(OfflineSliceError, "INGEST"):
            failing.run(request)

        events = state.retry_events(request.job_id, "ingest")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].error_kind, "RuntimeError")
        self.assertEqual(len(events[0].error_message), 4096)
        resumed = OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                LocalAdditiveObjectStore(remote),
                archive_root,
                LocalFileIntegrity(),
            ),
            _LightweightMedia(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        ).run(request)
        self.assertEqual(resumed.work_units[0].attempts, 2)
        self.assertTrue(
            all(unit.status is WorkStatus.SUCCEEDED for unit in resumed.work_units)
        )

    def test_missing_proof_state_invalidates_backup_and_uses_new_additive_proof(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, _, remote, state, runner, request = self._environment(root)
        self.addCleanup(state.close)
        first = runner.run(request)
        remote.joinpath(*first.checkpoint.state_snapshot_path.parts).unlink()

        with self.assertRaises(FreshWorkspaceRequired):
            runner.run(request)

        self.assertTrue(
            all(
                state.get_work_unit(request.job_id, stage.value.lower()).status
                is WorkStatus.SUCCEEDED
                for stage in tuple(StageName)[:-1]
            )
        )
        self.assertIs(
            state.get_work_unit(request.job_id, "backup").status,
            WorkStatus.INVALID,
        )
        fresh = root / "fresh"
        fresh.mkdir()
        resumed = runner.run(replace(request, fresh_workspace_root=fresh))
        self.assertNotEqual(
            resumed.proof_manifest.checkpoint_id,
            first.proof_manifest.checkpoint_id,
        )
        self.assertEqual(resumed.work_units[-1].attempts, 2)

    def test_proof_repair_token_is_run_local_and_not_retained_by_runner(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, _, remote, state, runner, request = self._environment(root)
        self.addCleanup(state.close)
        first = runner.run(request)
        remote.joinpath(*first.checkpoint.state_snapshot_path.parts).unlink()

        with self.assertRaises(FreshWorkspaceRequired):
            runner.run(request)

        fresh = root / "fresh-run-local"
        fresh.mkdir()
        repaired_request = replace(request, fresh_workspace_root=fresh)
        repaired = runner.run(repaired_request)

        self.assertFalse(hasattr(runner, "_proof_repair_token"))
        clean = runner.run(
            replace(
                repaired_request,
                workspace_root=fresh,
                fresh_workspace_root=None,
            )
        )
        self.assertEqual(
            clean.proof_manifest.checkpoint_id,
            repaired.proof_manifest.checkpoint_id,
        )

    def test_first_proof_remote_corruption_fails_backup_then_rotates_additively(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        workspace, archive_root, remote, state, _, request = self._environment(root)
        self.addCleanup(state.close)
        faulty_store = _CorruptProofStateOnFirstVerification(remote)
        faulty_runner = OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                faulty_store,
                archive_root,
                LocalFileIntegrity(),
            ),
            _LightweightMedia(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        )

        with self.assertRaisesRegex(OfflineSliceError, "BACKUP"):
            faulty_runner.run(request)

        failed_record = state.completed_checkpoints(request.job_id)[0]
        self.assertIs(
            state.get_work_unit(request.job_id, "backup").status,
            WorkStatus.FAILED,
        )
        self.assertEqual(len(state.retry_events(request.job_id, "backup")), 1)
        self.assertEqual(
            faulty_store.observations,
            [(100, "sha256-readback"), (100, "sha256-readback")],
        )
        self.assertFalse(
            workspace.joinpath(*CHECKPOINT_ARTIFACT_PATH.parts).exists()
        )
        self.assertFalse(
            any(
                artifact.owner is StageName.BACKUP
                for artifact in state.valid_artifacts(request.job_id)
            )
        )

        resumed = OfflineSliceRunner(
            state,
            CheckpointPublisher(
                state,
                LocalAdditiveObjectStore(remote),
                archive_root,
                LocalFileIntegrity(),
            ),
            _LightweightMedia(),
            DeterministicOcrProvider(),
            DeterministicTranslationProvider(),
            DeterministicWaveTtsProvider(),
            *_local_slice_ports(),
        ).run(request)
        self.assertNotEqual(
            resumed.proof_manifest.checkpoint_id,
            failed_record.checkpoint_id,
        )
        self.assertTrue(resumed.proof_manifest.checkpoint_id.endswith("-repair-1"))
        self.assertEqual(resumed.work_units[-1].attempts, 2)

    def test_corrupt_final_state_rotates_once_and_reuses_valid_repair(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, _, remote, state, runner, request = self._environment(root)
        self.addCleanup(state.close)
        first = runner.run(request)
        remote.joinpath(*first.final_manifest.state_snapshot.key.parts).write_bytes(
            b"corrupt final state"
        )

        repaired = runner.run(request)
        repaired_manifest_path = remote.joinpath(*repaired.final_checkpoint.manifest.key.parts)
        repaired_state_path = remote.joinpath(
            *repaired.final_checkpoint.state_snapshot.key.parts
        )
        repaired_manifest_bytes = repaired_manifest_path.read_bytes()
        repaired_state_bytes = repaired_state_path.read_bytes()
        self.assertNotEqual(
            repaired.final_manifest.checkpoint_id,
            first.final_manifest.checkpoint_id,
        )
        self.assertTrue(repaired.final_manifest.checkpoint_id.endswith("-repair-1"))

        clean = runner.run(request)
        self.assertEqual(
            clean.final_manifest.checkpoint_id,
            repaired.final_manifest.checkpoint_id,
        )
        self.assertEqual(repaired_manifest_path.read_bytes(), repaired_manifest_bytes)
        self.assertEqual(repaired_state_path.read_bytes(), repaired_state_bytes)
        self.assertEqual(len(state.completed_checkpoints(request.job_id)), 3)
        self.assertEqual(len(repaired.final_manifest.artifacts), 11)
        inspection_root = root / "repaired-final-inspection"
        inspection_root.mkdir()
        inspection_path = inspection_root / "job-v2.sqlite"
        inspection_path.write_bytes(repaired_state_bytes)
        inspection = SqliteStateStore(inspection_path)
        try:
            self.assertEqual(len(inspection.valid_artifacts(request.job_id)), 11)
            self.assertTrue(
                all(
                    inspection.get_work_unit(
                        request.job_id,
                        stage.value.lower(),
                    ).status
                    is WorkStatus.SUCCEEDED
                    for stage in StageName
                )
            )
        finally:
            inspection.close()

    def test_corrupt_stable_side_artifact_fails_closed_without_overwrite(
        self,
    ) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        _, _, remote, state, runner, request = self._environment(root)
        self.addCleanup(state.close)
        first = runner.run(request)
        side_entry = next(
            entry
            for entry in first.final_manifest.artifacts
            if entry.key.parts[-2] == "voice.wav"
        )
        side_path = remote.joinpath(*side_entry.key.parts)
        original = side_path.read_bytes()
        side_path.write_bytes(b"corrupt final side artifact")

        with self.assertRaises(FreshWorkspaceRequired):
            runner.run(request)

        self.assertNotEqual(original, b"corrupt final side artifact")
        self.assertEqual(side_path.read_bytes(), b"corrupt final side artifact")
        self.assertEqual(len(state.completed_checkpoints(request.job_id)), 2)

    def test_missing_or_corrupt_final_manifest_rotates_to_valid_repair(self) -> None:
        for damage in ("missing", "corrupt"):
            with self.subTest(damage=damage):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    _, _, remote, state, runner, request = self._environment(root)
                    try:
                        first = runner.run(request)
                        manifest_path = remote.joinpath(
                            *first.final_checkpoint.manifest.key.parts
                        )
                        if damage == "missing":
                            manifest_path.unlink()
                        else:
                            manifest_path.write_bytes(b"corrupt final manifest")

                        repaired = runner.run(request)
                        self.assertTrue(
                            repaired.final_manifest.checkpoint_id.endswith("-repair-1")
                        )
                        self.assertNotEqual(
                            repaired.final_manifest.checkpoint_id,
                            first.final_manifest.checkpoint_id,
                        )
                        self.assertEqual(
                            runner.run(request).final_manifest.checkpoint_id,
                            repaired.final_manifest.checkpoint_id,
                        )
                    finally:
                        state.close()


if __name__ == "__main__":
    unittest.main()
