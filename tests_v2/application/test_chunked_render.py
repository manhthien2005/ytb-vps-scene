from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.filesystem.composition import (
    LocalFileDigestVerifier,
)
from ytb_vps_v2.adapters.filesystem.integrity import (
    digest_file,
)
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.chunked_render import (
    ChunkInterruptionPoint,
    ChunkedRenderCoordinator,
)
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import (
    Fingerprint,
    stage_config_fingerprints,
)
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    Part,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.pipeline import (
    RENDER_CHUNK_PLAN_ARTIFACT_PATH,
    TTS_ARTIFACT_PATH,
    RenderRequest,
)
from ytb_vps_v2.domain.timeline import FrameInterval


def _digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


class _FakeMedia:
    def __init__(self) -> None:
        self.rendered: list[int] = []
        self.validated: list[Path] = []
        self.concatenated: tuple[Path, ...] | None = None

    def render_chunk(
        self,
        source: Path,
        tts_wav: Path,
        plan: RenderRequest,
        chunk,
        destination: Path,
    ):
        self.rendered.append(chunk.index)
        destination.write_bytes(
            f"chunk:{chunk.index}:{chunk.interval.start_frame}:"
            f"{chunk.interval.end_frame}".encode("ascii")
        )
        return object()

    def validate_render(
        self,
        path: Path,
        expected: RenderRequest,
        **_: object,
    ):
        raw = path.read_bytes()
        self.validated.append(path)
        if path.name.startswith("chunk-"):
            index = expected.parts[0].chunk_indexes[0]
            if not raw.startswith(f"chunk:{index}:".encode("ascii")):
                raise RuntimeError("invalid fake chunk")
        return object()

    def concatenate_render_chunks(
        self,
        chunks: tuple[Path, ...],
        plan: RenderRequest,
        destination: Path,
    ):
        self.concatenated = chunks
        destination.write_bytes(
            b"|".join(path.read_bytes() for path in chunks)
        )
        return object()


class _FakeCheckpoints:
    def __init__(self, archive: VerifiedInputArchive) -> None:
        self.archive = archive
        self.calls: list[tuple[str, CheckpointManifest | None]] = []
        self.manifests: list[CheckpointManifest] = []

    def latest_verified_v2(
        self,
        job_id: JobId,
        checkpoint_prefix: str,
        observed_at: int,
    ) -> CheckpointManifest | None:
        self.latest = (job_id, checkpoint_prefix, observed_at)
        return None if not self.manifests else self.manifests[-1]

    def publish(
        self,
        job_id: JobId,
        checkpoint_id: str,
        workspace_root: Path,
        snapshot_dir: Path,
        at: str,
        *,
        verification_observed_at: int,
        verification_method: str,
        reuse: CheckpointManifest | None = None,
    ) -> CheckpointManifest:
        self.calls.append((checkpoint_id, reuse))
        token = hashlib.sha256(checkpoint_id.encode("utf-8")).hexdigest()
        manifest = CheckpointManifest(
            2,
            checkpoint_id,
            job_id,
            self.archive.source,
            ManifestEntry(
                PurePosixPath("objects/input") / token,
                self.archive.source.digest,
            ),
            ManifestEntry(
                PurePosixPath("checkpoints/state") / token,
                _digest(token.encode("ascii")),
            ),
            (),
            at,
        )
        self.manifests.append(manifest)
        return manifest

    def verify_manifest(
        self,
        manifest: CheckpointManifest,
        observed_at: int,
        method: str = "sha256-readback",
    ) -> CheckpointManifest:
        self.verified = (manifest.checkpoint_id, observed_at, method)
        return manifest


class ChunkedRenderCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.snapshots = self.root / "snapshots"
        self.workspace.mkdir()
        self.snapshots.mkdir()
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"s" * 9_010)
        self.voice = self.workspace / "artifacts" / "tts" / "voice.wav"
        self.voice.parent.mkdir(parents=True)
        self.voice.write_bytes(b"voice")
        self.job_id = JobId("chunked-render-job")
        source_digest = digest_file(self.source)
        self.archive = VerifiedInputArchive(
            SourceIdentity(self.source.name, source_digest),
            ManifestEntry(
                PurePosixPath("inputs/source.mp4"),
                source_digest,
            ),
            "verified",
        )
        self.state = SqliteStateStore(self.root / "job-v2.sqlite")
        self.addCleanup(self.state.close)
        self.state.create_job(
            self.job_id,
            Fingerprint(source_digest.sha256),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )
        self.state.record_verified_input(self.job_id, self.archive)
        self.state.put_work_unit(
            self.job_id,
            WorkUnit("tts", StageName.TTS),
            "planned",
        )
        self.state.start_work_unit(self.job_id, "tts", "started")
        tts_raw = b'{"tts":"document"}'
        tts_path = self.workspace.joinpath(*TTS_ARTIFACT_PATH.parts)
        tts_path.write_bytes(tts_raw)
        tts_digest = digest_file(tts_path)
        self.state.commit_artifact(
            self.job_id,
            "tts",
            Artifact(
                "tts-document",
                TTS_ARTIFACT_PATH,
                tts_digest.size_bytes,
                tts_digest.sha256,
                StageName.TTS,
            ),
            "committed",
        )
        self.state.put_work_unit(
            self.job_id,
            WorkUnit(
                "render",
                StageName.RENDER,
                dependencies=("tts",),
            ),
            "planned",
        )
        self.plan = RenderRequest(
            1,
            self.job_id,
            source_digest,
            901,
            320,
            180,
            TTS_ARTIFACT_PATH,
            tts_digest,
            (),
            (),
            PurePosixPath("artifacts/tts/voice.wav"),
            digest_file(self.voice),
            (Part(1, 1, FrameInterval(0, 901), (0,)),),
            True,
        )
        self.media = _FakeMedia()
        self.checkpoints = _FakeCheckpoints(self.archive)
        self.disk_needs: list[int] = []
        self.coordinator = ChunkedRenderCoordinator(
            self.state,
            self.checkpoints,
            self.media,
            LocalFileDigestVerifier(),
            free_space=lambda path, need_bytes: self.disk_needs.append(
                need_bytes
            ),
        )

    def test_prepares_four_durable_chunks_and_temporary_assembly(self) -> None:
        prepared = self.coordinator.prepare(
            job_id=self.job_id,
            source=self.source,
            tts_wav=self.voice,
            request=self.plan,
            render_fingerprint=Fingerprint("f" * 64),
            chunk_seconds=10,
            workspace=self.workspace,
            snapshot_dir=self.snapshots,
            writer=LocalArtifactWriter(self.workspace),
            at="run",
            verification_observed_at=100,
        )

        self.assertEqual(self.media.rendered, [0, 1, 2, 3])
        self.assertEqual(
            tuple(
                self.state.get_work_unit(
                    self.job_id,
                    f"render:{index:06d}",
                ).status
                for index in range(4)
            ),
            (WorkStatus.SUCCEEDED,) * 4,
        )
        self.assertIs(
            self.state.get_work_unit(
                self.job_id,
                "render:plan",
            ).status,
            WorkStatus.SUCCEEDED,
        )
        chunk_keys = tuple(
            f"render:{index:06d}"
            for index in range(4)
        )
        self.assertEqual(
            self.state.get_work_unit(
                self.job_id,
                "render",
            ).dependencies,
            chunk_keys,
        )
        artifacts = tuple(
            self.state.artifacts_for_unit(self.job_id, key)[0]
            for key in chunk_keys
        )
        self.assertEqual(
            tuple(artifact.relative_path for artifact in artifacts),
            tuple(
                PurePosixPath(
                    f"artifacts/render/chunks/chunk-{index:06d}.mp4"
                )
                for index in range(4)
            ),
        )
        for artifact in artifacts:
            path = self.workspace.joinpath(*artifact.relative_path.parts)
            self.assertEqual(
                digest_file(path),
                FileDigest(artifact.size_bytes, artifact.sha256),
            )
        self.assertEqual(
            self.media.concatenated,
            tuple(
                self.workspace.joinpath(*artifact.relative_path.parts)
                for artifact in artifacts
            ),
        )
        self.assertEqual(len(self.checkpoints.calls), 4)
        self.assertTrue(
            all(
                checkpoint_id.startswith(
                    f"render-chunk-{index:06d}-{'f' * 12}-"
                )
                for index, (checkpoint_id, _) in enumerate(
                    self.checkpoints.calls
                )
            )
        )
        self.assertIsNone(self.checkpoints.calls[0][1])
        self.assertTrue(
            all(reuse is not None for _, reuse in self.checkpoints.calls[1:])
        )
        self.assertEqual(
            self.checkpoints.latest,
            (self.job_id, "render-chunk-", 100),
        )
        self.assertEqual(
            prepared.request.parts[0].chunk_indexes,
            (0, 1, 2, 3),
        )
        self.assertTrue(prepared.temporary_path.is_file())
        self.assertFalse(
            self.workspace.joinpath(
                "artifacts",
                "render",
                "rendered.mp4",
            ).exists()
        )
        self.assertTrue(
            self.workspace.joinpath(
                *RENDER_CHUNK_PLAN_ARTIFACT_PATH.parts
            ).is_file()
        )
        self.assertEqual(
            self.disk_needs[:4],
            [3 * 16 * 1024 * 1024] * 4,
        )
        self.assertEqual(
            self.disk_needs[4],
            (
                sum(artifact.size_bytes for artifact in artifacts)
                * 5
                + 1
            )
            // 2,
        )
        prepared.temporary_path.unlink()

    def _assert_restart(
        self,
        point: ChunkInterruptionPoint,
    ) -> None:
        raised = False

        def interrupt(
            index: int,
            observed: ChunkInterruptionPoint,
        ) -> None:
            nonlocal raised
            if not raised and index == 1 and observed is point:
                raised = True
                raise RuntimeError(f"interrupt {point.value}")

        self.coordinator.interruption = interrupt
        with self.assertRaisesRegex(RuntimeError, "interrupt"):
            self.coordinator.prepare(
                job_id=self.job_id,
                source=self.source,
                tts_wav=self.voice,
                request=self.plan,
                render_fingerprint=Fingerprint("f" * 64),
                chunk_seconds=10,
                workspace=self.workspace,
                snapshot_dir=self.snapshots,
                writer=LocalArtifactWriter(self.workspace),
                at="first",
                verification_observed_at=100,
            )
        self.assertTrue(raised)
        first_chunk = self.state.artifacts_for_unit(
            self.job_id,
            "render:000000",
        )[0]
        first_attempts = self.state.get_work_unit(
            self.job_id,
            "render:000000",
        ).attempts
        interrupted = self.state.get_work_unit(
            self.job_id,
            "render:000001",
        )
        committed_before_interrupt = point in {
            ChunkInterruptionPoint.AFTER_SQLITE_COMMIT,
            ChunkInterruptionPoint.DURING_CHECKPOINT,
        }
        self.assertIs(
            interrupted.status,
            (
                WorkStatus.SUCCEEDED
                if committed_before_interrupt
                else WorkStatus.FAILED
            ),
        )

        self.coordinator.interruption = None
        prepared = self.coordinator.prepare(
            job_id=self.job_id,
            source=self.source,
            tts_wav=self.voice,
            request=self.plan,
            render_fingerprint=Fingerprint("f" * 64),
            chunk_seconds=10,
            workspace=self.workspace,
            snapshot_dir=self.snapshots,
            writer=LocalArtifactWriter(self.workspace),
            at="resume",
            verification_observed_at=101,
        )
        try:
            self.assertEqual(
                self.state.artifacts_for_unit(
                    self.job_id,
                    "render:000000",
                )[0],
                first_chunk,
            )
            self.assertEqual(
                self.state.get_work_unit(
                    self.job_id,
                    "render:000000",
                ).attempts,
                first_attempts,
            )
            self.assertEqual(
                self.state.get_work_unit(
                    self.job_id,
                    "render:000001",
                ).attempts,
                1 if committed_before_interrupt else 2,
            )
            self.assertEqual(self.media.rendered.count(0), 1)
            self.assertEqual(
                self.media.rendered.count(1),
                (
                    1
                    if point
                    in {
                        ChunkInterruptionPoint.BEFORE_RENDER,
                        ChunkInterruptionPoint.AFTER_SQLITE_COMMIT,
                        ChunkInterruptionPoint.DURING_CHECKPOINT,
                    }
                    else 2
                ),
            )
            self.assertEqual(
                prepared.temporary_path.read_bytes(),
                (
                    b"chunk:0:0:300|chunk:1:300:600|"
                    b"chunk:2:600:900|chunk:3:900:901"
                ),
            )
            self.assertTrue(
                all(
                    self.state.get_work_unit(
                        self.job_id,
                        f"render:{index:06d}",
                    ).status
                    is WorkStatus.SUCCEEDED
                    for index in range(4)
                )
            )
        finally:
            prepared.temporary_path.unlink()

    def test_restart_before_chunk_render(self) -> None:
        self._assert_restart(ChunkInterruptionPoint.BEFORE_RENDER)

    def test_restart_after_chunk_render(self) -> None:
        self._assert_restart(ChunkInterruptionPoint.AFTER_RENDER)

    def test_restart_after_chunk_filesystem_publication(self) -> None:
        self._assert_restart(
            ChunkInterruptionPoint.AFTER_FILESYSTEM_PUBLICATION
        )

    def test_restart_after_chunk_sqlite_commit_reuses_local_chunk(self) -> None:
        self._assert_restart(
            ChunkInterruptionPoint.AFTER_SQLITE_COMMIT
        )

    def test_checkpoint_interruption_keeps_committed_chunk_succeeded(
        self,
    ) -> None:
        self._assert_restart(ChunkInterruptionPoint.DURING_CHECKPOINT)

    def test_missing_chunk_rerenders_only_its_unit_and_dependents(self) -> None:
        first = self.coordinator.prepare(
            job_id=self.job_id,
            source=self.source,
            tts_wav=self.voice,
            request=self.plan,
            render_fingerprint=Fingerprint("f" * 64),
            chunk_seconds=10,
            workspace=self.workspace,
            snapshot_dir=self.snapshots,
            writer=LocalArtifactWriter(self.workspace),
            at="first",
            verification_observed_at=100,
        )
        first.temporary_path.unlink()
        before = {
            index: self.state.get_work_unit(
                self.job_id,
                f"render:{index:06d}",
            ).attempts
            for index in range(4)
        }
        missing = self.state.artifacts_for_unit(
            self.job_id,
            "render:000001",
        )[0]
        self.workspace.joinpath(*missing.relative_path.parts).unlink()

        resumed = self.coordinator.prepare(
            job_id=self.job_id,
            source=self.source,
            tts_wav=self.voice,
            request=self.plan,
            render_fingerprint=Fingerprint("f" * 64),
            chunk_seconds=10,
            workspace=self.workspace,
            snapshot_dir=self.snapshots,
            writer=LocalArtifactWriter(self.workspace),
            at="resume",
            verification_observed_at=101,
        )
        try:
            self.assertEqual(self.media.rendered, [0, 1, 2, 3, 1])
            for index in (0, 2, 3):
                self.assertEqual(
                    self.state.get_work_unit(
                        self.job_id,
                        f"render:{index:06d}",
                    ).attempts,
                    before[index],
                )
            self.assertEqual(
                self.state.get_work_unit(
                    self.job_id,
                    "render:000001",
                ).attempts,
                before[1] + 1,
            )
            self.assertIs(
                self.state.get_work_unit(
                    self.job_id,
                    "render",
                ).status,
                WorkStatus.INVALID,
            )
        finally:
            resumed.temporary_path.unlink()

    def test_succeeded_plan_rejects_changed_canonical_bytes(self) -> None:
        first = self.coordinator.prepare(
            job_id=self.job_id,
            source=self.source,
            tts_wav=self.voice,
            request=self.plan,
            render_fingerprint=Fingerprint("f" * 64),
            chunk_seconds=10,
            workspace=self.workspace,
            snapshot_dir=self.snapshots,
            writer=LocalArtifactWriter(self.workspace),
            at="first",
            verification_observed_at=100,
        )
        first.temporary_path.unlink()

        with self.assertRaisesRegex(
            RuntimeError,
            "differs",
        ):
            self.coordinator.prepare(
                job_id=self.job_id,
                source=self.source,
                tts_wav=self.voice,
                request=self.plan,
                render_fingerprint=Fingerprint("f" * 64),
                chunk_seconds=11,
                workspace=self.workspace,
                snapshot_dir=self.snapshots,
                writer=LocalArtifactWriter(self.workspace),
                at="changed",
                verification_observed_at=101,
            )

    def test_disk_guard_stops_before_first_chunk_render(self) -> None:
        def reject(path: Path, need_bytes: int) -> None:
            raise RuntimeError(f"disk:{need_bytes}")

        self.coordinator.free_space = reject

        with self.assertRaisesRegex(RuntimeError, "disk:"):
            self.coordinator.prepare(
                job_id=self.job_id,
                source=self.source,
                tts_wav=self.voice,
                request=self.plan,
                render_fingerprint=Fingerprint("f" * 64),
                chunk_seconds=10,
                workspace=self.workspace,
                snapshot_dir=self.snapshots,
                writer=LocalArtifactWriter(self.workspace),
                at="guarded",
                verification_observed_at=100,
            )

        self.assertEqual(self.media.rendered, [])
        self.assertIs(
            self.state.get_work_unit(
                self.job_id,
                "render:000000",
            ).status,
            WorkStatus.PENDING,
        )


if __name__ == "__main__":
    unittest.main()
