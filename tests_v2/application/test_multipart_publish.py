from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.composition import (
    LocalFileDigestVerifier,
)
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.filesystem.publish import LocalPartPublisher
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.multipart_publish import (
    MultipartPublishCoordinator,
)
from ytb_vps_v2.domain.backup import (
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
    RENDER_PLAN_ARTIFACT_PATH,
    TTS_ARTIFACT_PATH,
    RenderPlanDocument,
    RenderedPart,
    canonical_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval


class _CountingPublisher:
    def __init__(self, root: Path) -> None:
        self.delegate = LocalPartPublisher(root)
        self.calls: list[int] = []

    def publish(self, source: Path, part: Part):
        self.calls.append(part.part_index)
        return self.delegate.publish(source, part)


class MultipartPublishCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.job_id = JobId("multipart-publish-job")
        self.state = SqliteStateStore(self.root / "job-v2.sqlite")
        self.addCleanup(self.state.close)
        source = self.root / "source.mp4"
        source.write_bytes(b"source")
        source_digest = digest_file(source)
        self.state.create_job(
            self.job_id,
            Fingerprint(source_digest.sha256),
            stage_config_fingerprints(EffectiveConfig()),
            "created",
        )
        self.state.record_verified_input(
            self.job_id,
            VerifiedInputArchive(
                SourceIdentity(source.name, source_digest),
                ManifestEntry(
                    PurePosixPath("inputs/source.mp4"),
                    source_digest,
                ),
                "verified",
            ),
        )
        self.parts = (
            Part(1, 2, FrameInterval(0, 600), (0, 1)),
            Part(2, 2, FrameInterval(600, 901), (2, 3)),
        )
        rendered: list[RenderedPart] = []
        for part in self.parts:
            relative = PurePosixPath(
                "artifacts/render/parts/"
                f"part-{part.part_index:02d}-of-02.mp4"
            )
            path = self.workspace.joinpath(*relative.parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"rendered Part {part.part_index}".encode())
            digest = digest_file(path)
            rendered.append(RenderedPart(part, relative, digest))
            key = f"render:part:{part.part_index:06d}"
            self.state.put_work_unit(
                self.job_id,
                WorkUnit(key, StageName.RENDER),
                "planned",
            )
            self.state.start_work_unit(self.job_id, key, "started")
            self.state.commit_artifact(
                self.job_id,
                key,
                Artifact(
                    f"render-part-{part.part_index:06d}",
                    relative,
                    digest.size_bytes,
                    digest.sha256,
                    StageName.RENDER,
                ),
                "committed",
            )
        self.plan = RenderPlanDocument(
            1,
            self.job_id,
            FileDigest(100, "b" * 64),
            901,
            320,
            180,
            TTS_ARTIFACT_PATH,
            FileDigest(20, "c" * 64),
            (),
            (),
            PurePosixPath("artifacts/tts/voice.wav"),
            FileDigest(30, "d" * 64),
            self.parts,
            True,
            tuple(rendered),
        )
        part_keys = tuple(
            f"render:part:{part.part_index:06d}"
            for part in self.parts
        )
        self.state.put_work_unit(
            self.job_id,
            WorkUnit(
                "render",
                StageName.RENDER,
                dependencies=part_keys,
            ),
            "planned",
        )
        self.state.start_work_unit(self.job_id, "render", "started")
        raw = canonical_document_bytes(self.plan)
        render_digest = FileDigest(
            len(raw),
            hashlib.sha256(raw).hexdigest(),
        )
        self.state.commit_artifact(
            self.job_id,
            "render",
            Artifact(
                "render-document",
                RENDER_PLAN_ARTIFACT_PATH,
                render_digest.size_bytes,
                render_digest.sha256,
                StageName.RENDER,
                ("tts-document",),
            ),
            "committed",
        )
        self.state.put_work_unit(
            self.job_id,
            WorkUnit(
                "publish",
                StageName.PUBLISH,
                dependencies=("render",),
            ),
            "planned",
        )
        self.publisher = _CountingPublisher(self.workspace)
        self.coordinator = MultipartPublishCoordinator(
            self.state,
            LocalFileDigestVerifier(),
        )

    def _prepare(self, at: str):
        return self.coordinator.prepare(
            job_id=self.job_id,
            plan=self.plan,
            workspace=self.workspace,
            publisher=self.publisher,
            at=at,
        )

    def test_publishes_two_parts_as_independent_durable_units(self) -> None:
        document = self._prepare("first")

        self.assertEqual(self.publisher.calls, [1, 2])
        self.assertEqual(
            document.part_paths,
            (
                PurePosixPath("published/part-01-of-02.mp4"),
                PurePosixPath("published/part-02-of-02.mp4"),
            ),
        )
        self.assertEqual(
            document.part_digests,
            tuple(item.digest for item in self.plan.rendered_parts),
        )
        self.assertEqual(
            self.state.get_work_unit(
                self.job_id,
                "publish",
            ).dependencies,
            ("publish:part:000001", "publish:part:000002"),
        )
        for part in self.parts:
            key = f"publish:part:{part.part_index:06d}"
            unit = self.state.get_work_unit(self.job_id, key)
            artifact = self.state.artifacts_for_unit(
                self.job_id,
                key,
            )[0]
            self.assertIs(unit.status, WorkStatus.SUCCEEDED)
            self.assertEqual(
                unit.dependencies,
                (f"render:part:{part.part_index:06d}",),
            )
            self.assertEqual(
                artifact.name,
                f"published-part-{part.part_index:06d}",
            )
            self.assertEqual(
                artifact.dependencies,
                (f"render-part-{part.part_index:06d}",),
            )

    def test_resume_reuses_valid_parts_and_recopies_only_corrupt_part(self) -> None:
        first = self._prepare("first")
        attempts = tuple(
            self.state.get_work_unit(
                self.job_id,
                f"publish:part:{index:06d}",
            ).attempts
            for index in (1, 2)
        )

        self._prepare("clean-resume")
        self.assertEqual(self.publisher.calls, [1, 2])

        corrupt = self.workspace.joinpath(*first.part_paths[1].parts)
        corrupt.write_bytes(b"corrupt")
        repaired = self._prepare("repair")

        self.assertEqual(self.publisher.calls, [1, 2, 2])
        self.assertEqual(
            tuple(
                self.state.get_work_unit(
                    self.job_id,
                    f"publish:part:{index:06d}",
                ).attempts
                for index in (1, 2)
            ),
            (attempts[0], attempts[1] + 1),
        )
        self.assertEqual(digest_file(corrupt), repaired.part_digests[1])
        self.assertIs(
            self.state.get_work_unit(
                self.job_id,
                "publish",
            ).status,
            WorkStatus.INVALID,
        )


if __name__ == "__main__":
    unittest.main()
