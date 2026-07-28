from __future__ import annotations

import shutil
import tempfile
import unittest
from dataclasses import replace
from fractions import Fraction
from pathlib import Path, PurePosixPath

from tests_v2.application.test_offline_slice import (
    _LightweightMedia,
    _local_slice_ports,
)
from ytb_vps_v2.adapters.filesystem.additive import LocalAdditiveObjectStore
from ytb_vps_v2.adapters.filesystem.archive import VerifiedInputArchiver
from ytb_vps_v2.adapters.filesystem.integrity import (
    LocalFileIntegrity,
    digest_file,
)
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicOcrProvider,
    DeterministicTranslationProvider,
    DeterministicWaveTtsProvider,
)
from ytb_vps_v2.adapters.sqlite.restore import LocalStagedRestoreWorkspace
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.offline_slice import (
    OfflineSliceError,
    OfflineSliceRequest,
    OfflineSliceRunner,
)
from ytb_vps_v2.application.restore import CheckpointRestorer
from ytb_vps_v2.domain.backup import CheckpointManifest, ManifestEntry
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import (
    RenderFingerprintInputs,
    stage_config_fingerprints,
)
from ytb_vps_v2.domain.models import (
    BlurRegion,
    BoundingBox,
    JobId,
    RegionKind,
    WorkStatus,
)
from ytb_vps_v2.domain.pipeline import MediaDocument
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


class _HostLoss(RuntimeError):
    pass


class _RecordingFourChunkMedia(_LightweightMedia):
    def __init__(self) -> None:
        self.rendered_chunks: list[int] = []

    @staticmethod
    def probe(source: Path) -> MediaDocument:
        return replace(
            _LightweightMedia.probe(source),
            duration_seconds=Fraction(901, 30),
            frame_count=901,
        )

    def render_chunk(
        self,
        source: Path,
        tts_wav: Path,
        plan,
        chunk,
        destination: Path,
    ) -> MediaDocument:
        self.rendered_chunks.append(chunk.index)
        return super().render_chunk(
            source,
            tts_wav,
            plan,
            chunk,
            destination,
        )

    @staticmethod
    def validate_render(path: Path, expected) -> MediaDocument:
        raw = path.read_bytes()
        if not raw.startswith(b"lightweight-render-v1\0"):
            raise RuntimeError("lightweight rendered bytes are invalid")
        return MediaDocument(
            1,
            expected.job_id,
            PurePosixPath("inputs") / path.name,
            digest_file(path),
            Fraction(expected.frame_count, 30),
            Fraction(30),
            Timeline(30),
            expected.frame_count,
            expected.width,
            expected.height,
            expected.output_has_audio,
        )


class _InterruptAfterSecondChunkCheckpoint:
    def __init__(
        self,
        delegate: CheckpointPublisher,
        state: SqliteStateStore,
    ) -> None:
        self.delegate = delegate
        self.state = state
        self.object_store = delegate.object_store
        self.manifest_entry: ManifestEntry | None = None

    def latest_verified_v2(
        self,
        job_id: JobId,
        checkpoint_prefix: str,
        observed_at: int,
    ) -> CheckpointManifest | None:
        return self.delegate.latest_verified_v2(
            job_id,
            checkpoint_prefix,
            observed_at,
        )

    def publish(self, *args, **kwargs) -> CheckpointManifest:
        return self.delegate.publish(*args, **kwargs)

    def verify_manifest(
        self,
        manifest: CheckpointManifest,
        observed_at: int,
        method: str = "sha256-readback",
    ) -> CheckpointManifest:
        verified = self.delegate.verify_manifest(
            manifest,
            observed_at,
            method,
        )
        if manifest.checkpoint_id.startswith("render-chunk-000001-"):
            record = next(
                item
                for item in self.state.completed_checkpoints(manifest.job_id)
                if item.checkpoint_id == manifest.checkpoint_id
            )
            self.manifest_entry = record.manifest
            raise _HostLoss("simulated host loss after chunk checkpoint")
        return verified


def _runner(
    state: SqliteStateStore,
    checkpoints,
    media: _RecordingFourChunkMedia,
) -> OfflineSliceRunner:
    return OfflineSliceRunner(
        state,
        checkpoints,
        media,
        DeterministicOcrProvider(),
        DeterministicTranslationProvider(),
        DeterministicWaveTtsProvider(),
        *_local_slice_ports(),
    )


class ChunkCheckpointRestoreTests(unittest.TestCase):
    def _environment(
        self,
        root: Path,
        *,
        job_id: JobId,
    ):
        workspace = root / "workspace"
        archive_root = root / "archive"
        remote_root = root / "remote"
        snapshot_root = root / "snapshots"
        state_root = root / "state"
        for directory in (
            workspace,
            archive_root,
            remote_root,
            snapshot_root,
            state_root,
        ):
            directory.mkdir(parents=True)
        source = root / "source.mp4"
        source.write_bytes(b"four chunk host-loss source")
        archive = VerifiedInputArchiver(archive_root).archive(
            source,
            job_id,
            "host-loss-archive",
        )
        config = EffectiveConfig()
        config = replace(
            config,
            media=replace(config.media, chunk_seconds=8),
        )
        request = OfflineSliceRequest(
            job_id=job_id,
            source=archive_root.joinpath(*archive.archive.key.parts),
            verified_input=archive,
            config_fingerprints=stage_config_fingerprints(config),
            workspace_root=workspace,
            snapshot_dir=snapshot_root,
            output_has_audio=True,
            at="host-loss-run",
            verification_observed_at=100,
            proof_checkpoint_id="host-loss-proof",
            final_checkpoint_id="host-loss-final",
            chunk_seconds=8,
        )
        state_path = state_root / "job-v2.sqlite"
        state = SqliteStateStore(state_path)
        store = LocalAdditiveObjectStore(remote_root)
        checkpoints = CheckpointPublisher(
            state,
            store,
            archive_root,
            LocalFileIntegrity(),
        )
        return (
            workspace,
            archive_root,
            remote_root,
            snapshot_root,
            state_root,
            state,
            store,
            checkpoints,
            request,
        )

    def test_restores_second_chunk_checkpoint_after_host_loss_and_resumes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = JobId("chunk-host-loss")
            (
                workspace,
                _archive_root,
                _remote_root,
                _snapshot_root,
                state_root,
                state,
                store,
                checkpoints,
                request,
            ) = self._environment(root, job_id=job_id)
            interrupted_media = _RecordingFourChunkMedia()
            interrupted = _InterruptAfterSecondChunkCheckpoint(
                checkpoints,
                state,
            )
            try:
                with self.assertRaisesRegex(
                    OfflineSliceError,
                    "Offline stage failed: RENDER",
                ):
                    _runner(state, interrupted, interrupted_media).run(request)

                rendered_before_loss = tuple(interrupted_media.rendered_chunks)
                manifest_entry = interrupted.manifest_entry
                before = {
                    index: (
                        state.get_work_unit(
                            job_id,
                            f"render:{index:06d}",
                        ).attempts,
                        state.artifacts_for_unit(
                            job_id,
                            f"render:{index:06d}",
                        )[0].sha256,
                    )
                    for index in (0, 1)
                }
            finally:
                state.close()
            self.assertEqual(rendered_before_loss, (0, 1))
            self.assertIsNotNone(manifest_entry)
            assert manifest_entry is not None
            shutil.rmtree(workspace)
            shutil.rmtree(state_root)

            restore_parent = root / "restored"
            restore_parent.mkdir()
            target = restore_parent / "active"
            CheckpointRestorer(
                store,
                LocalStagedRestoreWorkspace(),
            ).restore(
                manifest_entry,
                target,
                restore_parent,
                101,
            )
            restored_workspace = target / "workspace"
            restored_archive = target / "archive"
            restored_snapshots = target / "snapshots"
            restored_snapshots.mkdir()
            restored_state = SqliteStateStore(target / "job-v2.sqlite")
            try:
                restored_request = replace(
                    request,
                    source=restored_archive.joinpath(
                        *request.verified_input.archive.key.parts
                    ),
                    workspace_root=restored_workspace,
                    snapshot_dir=restored_snapshots,
                    at="host-loss-resume",
                    verification_observed_at=102,
                )
                resumed_media = _RecordingFourChunkMedia()
                resumed = _runner(
                    restored_state,
                    CheckpointPublisher(
                        restored_state,
                        store,
                        restored_archive,
                        LocalFileIntegrity(),
                    ),
                    resumed_media,
                ).run(restored_request)

                self.assertEqual(resumed_media.rendered_chunks, [2, 3])
                for index in (0, 1):
                    unit = restored_state.get_work_unit(
                        job_id,
                        f"render:{index:06d}",
                    )
                    artifact = restored_state.artifacts_for_unit(
                        job_id,
                        f"render:{index:06d}",
                    )[0]
                    self.assertEqual(
                        (unit.attempts, artifact.sha256),
                        before[index],
                    )
                    self.assertIs(unit.status, WorkStatus.SUCCEEDED)
                self.assertTrue(
                    all(
                        restored_state.get_work_unit(
                            job_id,
                            f"render:{index:06d}",
                        ).status
                        is WorkStatus.SUCCEEDED
                        for index in range(4)
                    )
                )
                resumed_part = restored_workspace.joinpath(
                    *resumed.publication.part_paths[0].parts
                )
                resumed_bytes = resumed_part.read_bytes()
            finally:
                restored_state.close()

            control_root = root / "control"
            (
                _control_workspace,
                _control_archive,
                _control_remote,
                _control_snapshots,
                _control_state_root,
                control_state,
                _control_store,
                control_checkpoints,
                control_request,
            ) = self._environment(control_root, job_id=job_id)
            try:
                control_media = _RecordingFourChunkMedia()
                control = _runner(
                    control_state,
                    control_checkpoints,
                    control_media,
                ).run(control_request)
                control_part = control.workspace_root.joinpath(
                    *control.publication.part_paths[0].parts
                )
                self.assertEqual(control_media.rendered_chunks, [0, 1, 2, 3])
                self.assertEqual(resumed_bytes, control_part.read_bytes())
                self.assertEqual(
                    resumed.publication.part_digests,
                    control.publication.part_digests,
                )
            finally:
                control_state.close()

    def test_corrupt_chunk_rerenders_only_that_chunk_and_downstream(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = JobId("chunk-corruption")
            (
                workspace,
                archive_root,
                _remote_root,
                _snapshot_root,
                _state_root,
                state,
                store,
                checkpoints,
                request,
            ) = self._environment(root, job_id=job_id)
            try:
                first_media = _RecordingFourChunkMedia()
                first = _runner(
                    state,
                    checkpoints,
                    first_media,
                ).run(request)
                self.assertEqual(first_media.rendered_chunks, [0, 1, 2, 3])
                stage_attempts = {
                    unit.key: unit.attempts
                    for unit in state.work_units(job_id)
                    if ":" not in unit.key
                }
                chunk_evidence = {
                    index: (
                        state.get_work_unit(
                            job_id,
                            f"render:{index:06d}",
                        ).attempts,
                        state.artifacts_for_unit(
                            job_id,
                            f"render:{index:06d}",
                        )[0].sha256,
                    )
                    for index in range(4)
                }
                damaged = state.artifacts_for_unit(
                    job_id,
                    "render:000002",
                )[0]
                workspace.joinpath(*damaged.relative_path.parts).write_bytes(
                    b"corrupt chunk two"
                )
                fresh = root / "fresh"
                fresh.mkdir()
                resumed_media = _RecordingFourChunkMedia()

                resumed = _runner(
                    state,
                    CheckpointPublisher(
                        state,
                        store,
                        archive_root,
                        LocalFileIntegrity(),
                    ),
                    resumed_media,
                ).run(
                    replace(
                        request,
                        fresh_workspace_root=fresh,
                        at="chunk-corruption-resume",
                        verification_observed_at=101,
                    )
                )

                self.assertEqual(resumed.workspace_root, fresh)
                self.assertEqual(resumed_media.rendered_chunks, [2])
                for index in (0, 1, 3):
                    unit = state.get_work_unit(
                        job_id,
                        f"render:{index:06d}",
                    )
                    artifact = state.artifacts_for_unit(
                        job_id,
                        f"render:{index:06d}",
                    )[0]
                    self.assertEqual(
                        (unit.attempts, artifact.sha256),
                        chunk_evidence[index],
                    )
                self.assertEqual(
                    state.get_work_unit(
                        job_id,
                        "render:000002",
                    ).attempts,
                    chunk_evidence[2][0] + 1,
                )
                for key in ("ingest", "ocr", "track", "translate", "tts"):
                    self.assertEqual(
                        state.get_work_unit(job_id, key).attempts,
                        stage_attempts[key],
                    )
                for key in ("render", "publish", "backup"):
                    self.assertEqual(
                        state.get_work_unit(job_id, key).attempts,
                        stage_attempts[key] + 1,
                    )
                self.assertEqual(
                    fresh.joinpath(
                        *resumed.publication.part_paths[0].parts
                    ).read_bytes(),
                    workspace.joinpath(
                        *first.publication.part_paths[0].parts
                    ).read_bytes(),
                )
            finally:
                state.close()

    def test_scene_mask_change_invalidates_render_and_downstream_only(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job_id = JobId("scene-mask-change")
            (
                _workspace,
                archive_root,
                _remote_root,
                _snapshot_root,
                _state_root,
                state,
                store,
                checkpoints,
                request,
            ) = self._environment(root, job_id=job_id)
            try:
                _runner(
                    state,
                    checkpoints,
                    _RecordingFourChunkMedia(),
                ).run(request)
                before = {
                    unit.key: unit.attempts
                    for unit in state.work_units(job_id)
                }
                region = BlurRegion(
                    RegionKind.STATIC,
                    FrameInterval(90, 240),
                    BoundingBox(16, 16, 96, 64),
                )
                config = EffectiveConfig()
                config = replace(
                    config,
                    media=replace(config.media, chunk_seconds=8),
                )
                changed_fingerprints = stage_config_fingerprints(
                    config,
                    render_inputs=RenderFingerprintInputs(
                        (region,),
                        output_has_audio=True,
                    ),
                )
                fresh = root / "scene-change"
                fresh.mkdir()

                changed = _runner(
                    state,
                    CheckpointPublisher(
                        state,
                        store,
                        archive_root,
                        LocalFileIntegrity(),
                    ),
                    _RecordingFourChunkMedia(),
                ).run(
                    replace(
                        request,
                        config_fingerprints=changed_fingerprints,
                        blur_regions=(region,),
                        fresh_workspace_root=fresh,
                        at="scene-mask-change-resume",
                        verification_observed_at=101,
                    )
                )

                self.assertEqual(changed.workspace_root, fresh)
                for key in ("ocr", "translate", "tts"):
                    self.assertEqual(
                        state.get_work_unit(job_id, key).attempts,
                        before[key],
                    )
                for key in (
                    "render:000000",
                    "render",
                    "publish",
                    "backup",
                ):
                    self.assertGreater(
                        state.get_work_unit(job_id, key).attempts,
                        before[key],
                    )
            finally:
                state.close()


if __name__ == "__main__":
    unittest.main()
