from __future__ import annotations

import unittest
from fractions import Fraction
from pathlib import Path

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import (
    Artifact,
    BlurRegion,
    BoundingBox,
    Cue,
    Job,
    JobId,
    MediaIdentity,
    Part,
    PipelineMode,
    RegionKind,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


class DomainModelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.interval = FrameInterval(0, 30)
        self.box = BoundingBox(10, 20, 110, 70)

    def test_media_cue_and_region_preserve_typed_contracts(self) -> None:
        media = MediaIdentity(
            duration_seconds=Fraction(10),
            source_fps=Fraction(30_000, 1_001),
            timeline=Timeline(),
            width=1920,
            height=1080,
            has_audio=False,
        )
        job = Job(JobId("abc123"), media)
        cue = Cue(1, self.interval, self.box, "你好")
        region = BlurRegion(RegionKind.DYNAMIC, self.interval, self.box)

        self.assertEqual(media.timeline.target_fps, 30)
        self.assertEqual(job.mode, PipelineMode.CUE_TRANSLATION)
        self.assertEqual(cue.source_text, "你好")
        self.assertIsNone(cue.target_text)
        self.assertEqual(region.kind, RegionKind.DYNAMIC)

    def test_invalid_box_cue_and_media_are_rejected(self) -> None:
        invalid_factories = (
            lambda: BoundingBox(10, 0, 10, 5),
            lambda: Cue(0, self.interval, self.box, "你好"),
            lambda: Cue(1, self.interval, self.box, ""),
            lambda: MediaIdentity(Fraction(0), Fraction(30), Timeline(), 1920, 1080, True),
            lambda: MediaIdentity(Fraction(1), Fraction(0), Timeline(), 1920, 1080, True),
            lambda: MediaIdentity(Fraction(1), Fraction(30), Timeline(), 0, 1080, True),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()

    def test_work_unit_and_artifact_validate_identity_and_checksum(self) -> None:
        unit = WorkUnit("ocr:000001", StageName.OCR)
        artifact = Artifact(
            name="ocr-chunk-000001",
            relative_path=Path("ocr/chunk-000001.jsonl"),
            size_bytes=42,
            sha256="a" * 64,
            owner=StageName.OCR,
            dependencies=("input:sha256",),
        )

        self.assertEqual(unit.status, WorkStatus.PENDING)
        self.assertEqual(unit.attempts, 0)
        self.assertEqual(artifact.owner, StageName.OCR)
        with self.assertRaises(DomainInvariantError):
            Artifact("bad", Path("bad"), 1, "not-a-sha", StageName.OCR)

    def test_part_requires_valid_index_and_ordered_unique_chunks(self) -> None:
        part = Part(1, 2, self.interval, (0, 1, 2))

        self.assertEqual(part.chunk_indexes, (0, 1, 2))
        for invalid_chunks in ((), (1, 1), (2, 1), (-1, 0)):
            with self.subTest(chunks=invalid_chunks):
                with self.assertRaises(DomainInvariantError):
                    Part(1, 2, self.interval, invalid_chunks)
        with self.assertRaises(DomainInvariantError):
            Part(3, 2, self.interval, (0,))

    def test_job_id_rejects_empty_or_whitespace_padded_values(self) -> None:
        self.assertEqual(JobId("abc123").value, "abc123")
        for value in ("", " ", " abc"):
            with self.subTest(value=value):
                with self.assertRaises(DomainInvariantError):
                    JobId(value)

    def test_job_rejects_unsupported_scene_voiceover_mode(self) -> None:
        media = MediaIdentity(
            Fraction(10),
            Fraction(30),
            Timeline(),
            1920,
            1080,
            True,
        )

        with self.assertRaisesRegex(DomainInvariantError, "Unsupported pipeline mode"):
            Job(JobId("abc123"), media, "scene_voiceover")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
