from __future__ import annotations

import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import (
    Artifact,
    BlurRegion,
    BoundingBox,
    Cue,
    JobId,
    Part,
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
        cue = Cue(1, self.interval, self.box, "你好")
        region = BlurRegion(RegionKind.DYNAMIC, self.interval, self.box)

        self.assertEqual(cue.source_text, "你好")
        self.assertIsNone(cue.target_text)
        self.assertEqual(region.kind, RegionKind.DYNAMIC)

    def test_invalid_box_cue_and_media_are_rejected(self) -> None:
        invalid_factories = (
            lambda: BoundingBox(10, 0, 10, 5),
            lambda: Cue(0, self.interval, self.box, "你好"),
            lambda: Cue(1, self.interval, self.box, ""),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()

    def test_work_unit_and_artifact_validate_identity_and_checksum(self) -> None:
        unit = WorkUnit("ocr:000001", StageName.OCR)
        artifact = Artifact(
            name="ocr-chunk-000001",
            relative_path=PurePosixPath("ocr/chunk-000001.jsonl"),
            size_bytes=42,
            sha256="a" * 64,
            owner=StageName.OCR,
            dependencies=("input:sha256",),
        )

        self.assertEqual(unit.status, WorkStatus.PENDING)
        self.assertEqual(unit.attempts, 0)
        self.assertEqual(artifact.owner, StageName.OCR)
        with self.assertRaises(DomainInvariantError):
            Artifact("bad", PurePosixPath("bad"), 1, "not-a-sha", StageName.OCR)

    def test_work_unit_dependencies_are_typed_ordered_and_do_not_self_reference(
        self,
    ) -> None:
        unit = WorkUnit(
            "render:000001",
            StageName.RENDER,
            dependencies=("render:plan",),
        )
        self.assertEqual(unit.dependencies, ("render:plan",))

        invalid = (
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=["tts"],  # type: ignore[arg-type]
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=("tts", "tts"),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=("z", "a"),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=("render:1",),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=("",),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=(" tts",),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=("x" * 513,),
            ),
            lambda: WorkUnit(
                "render:1",
                StageName.RENDER,
                dependencies=(1,),  # type: ignore[arg-type]
            ),
        )
        for factory in invalid:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()

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

    def test_integer_fields_reject_booleans_and_fractional_values(self) -> None:
        invalid_factories = (
            lambda: BoundingBox(False, 0, 10, 10),
            lambda: BoundingBox(0, 0, 10.5, 10),
            lambda: Cue(1.5, self.interval, self.box, "text"),
            lambda: WorkUnit("ocr:1", StageName.OCR, attempts=False),
            lambda: Artifact("a", PurePosixPath("a.json"), 1.5, "a" * 64, StageName.OCR),
            lambda: Part(True, 1, self.interval, (0,)),
            lambda: Part(1, 1.5, self.interval, (0,)),
            lambda: Part(1, 1, self.interval, (False,)),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()  # type: ignore[misc]

    def test_nested_models_and_enums_are_validated_at_runtime(self) -> None:
        invalid_factories = (
            lambda: Cue(1, "interval", self.box, "text"),
            lambda: Cue(1, self.interval, "box", "text"),
            lambda: BlurRegion("dynamic_blur", self.interval, self.box),
            lambda: WorkUnit("ocr:1", "OCR"),
            lambda: WorkUnit("ocr:1", StageName.OCR, "PENDING"),
            lambda: Artifact("a", PurePosixPath("a.json"), 1, "a" * 64, "OCR"),
            lambda: Part(1, 1, "interval", (0,)),
        )
        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()  # type: ignore[misc]

    def test_artifact_paths_use_portable_relative_posix_format(self) -> None:
        invalid_paths = (
            PurePosixPath("."),
            PurePosixPath("../secret"),
            PurePosixPath(r"..\secret"),
            PurePosixPath(r"\secret"),
            PurePosixPath("C:secret"),
            PurePosixPath(r"C:\secret"),
            PurePosixPath(r"\\server\share"),
            PurePosixPath(r"nested\artifact.json"),
            PureWindowsPath("nested/artifact.json"),
            Path("nested/artifact.json"),
        )
        for path in invalid_paths:
            with self.subTest(path=path):
                with self.assertRaises(DomainInvariantError):
                    Artifact("a", path, 1, "a" * 64, StageName.OCR)

        artifact = Artifact(
            "a",
            PurePosixPath("nested/artifact.json"),
            1,
            "a" * 64,
            StageName.OCR,
        )
        self.assertEqual(artifact.relative_path.as_posix(), "nested/artifact.json")


if __name__ == "__main__":
    unittest.main()
