from __future__ import annotations

import importlib.util
import importlib
import hashlib
import json
import unittest
from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from fractions import Fraction
from pathlib import PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import Fingerprint
from ytb_vps_v2.domain.models import (
    BlurRegion,
    BoundingBox,
    Cue,
    JobId,
    Part,
    RenderChunk,
    RegionKind,
)
from ytb_vps_v2.domain.pipeline import (
    CheckpointDocument,
    MediaDocument,
    OcrDocument,
    PublicationDocument,
    RenderChunkPlanDocument,
    RenderPlanDocument,
    TrackDocument,
    TranslationDocument,
    TtsDocument,
    canonical_document_bytes,
    parse_checkpoint_document_bytes,
    parse_media_document_bytes,
    parse_ocr_document_bytes,
    parse_publication_document_bytes,
    parse_render_chunk_plan_document_bytes,
    parse_render_plan_document_bytes,
    parse_track_document_bytes,
    parse_translation_document_bytes,
    parse_tts_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


SHA_A = "a" * 64
SHA_B = "b" * 64
MEDIA_ARTIFACT_PATH = PurePosixPath("artifacts/ingest/media.json")
OCR_ARTIFACT_PATH = PurePosixPath("artifacts/ocr/ocr.json")
TRACK_ARTIFACT_PATH = PurePosixPath("artifacts/track/track.json")
TRANSLATION_ARTIFACT_PATH = PurePosixPath("artifacts/translate/translation.json")
TTS_ARTIFACT_PATH = PurePosixPath("artifacts/tts/tts.json")
RENDER_CHUNK_PLAN_ARTIFACT_PATH = PurePosixPath(
    "artifacts/render/chunk-plan.json"
)
RENDER_PLAN_ARTIFACT_PATH = PurePosixPath("artifacts/render/render-plan.json")
PUBLICATION_ARTIFACT_PATH = PurePosixPath("artifacts/publish/publication.json")


class FrameIntervalSubclass(FrameInterval):
    pass


class BoundingBoxSubclass(BoundingBox):
    pass


class IntSubclass(int):
    pass


class TextSubclass(str):
    pass


class TupleSubclass(tuple):
    pass


def digest(sha256: str = SHA_A, size: int = 10) -> FileDigest:
    return FileDigest(size, sha256)


def media() -> MediaDocument:
    return MediaDocument(
        1,
        JobId("job-001"),
        PurePosixPath("inputs/source.mp4"),
        digest(),
        Fraction(30),
        Fraction(30),
        Timeline(),
        900,
        320,
        180,
        True,
    )


def source_cues() -> tuple[Cue, ...]:
    return (
        Cue(1, FrameInterval(30, 90), BoundingBox(10, 20, 110, 60), "hello"),
        Cue(2, FrameInterval(120, 180), BoundingBox(20, 30, 140, 80), "world"),
    )


def translated_cues() -> tuple[Cue, ...]:
    return tuple(replace(cue, target_text=f"vi:{cue.source_text}") for cue in source_cues())


def common(dependency_path: PurePosixPath) -> tuple[object, ...]:
    return (
        1,
        JobId("job-001"),
        digest(),
        900,
        320,
        180,
        dependency_path,
        digest(SHA_B),
    )


def ocr() -> OcrDocument:
    return OcrDocument(*common(MEDIA_ARTIFACT_PATH), source_cues())  # type: ignore[arg-type]


def track() -> TrackDocument:
    return TrackDocument(
        *common(OCR_ARTIFACT_PATH),  # type: ignore[arg-type]
        source_cues(),
        (
            BlurRegion(
                RegionKind.DYNAMIC,
                FrameInterval(30, 90),
                BoundingBox(10, 20, 110, 60),
            ),
        ),
    )


def translation() -> TranslationDocument:
    return TranslationDocument(  # type: ignore[arg-type]
        *common(TRACK_ARTIFACT_PATH), translated_cues()
    )


def tts() -> TtsDocument:
    return TtsDocument(
        *common(TRANSLATION_ARTIFACT_PATH),  # type: ignore[arg-type]
        translated_cues(),
        PurePosixPath("artifacts/tts.wav"),
        digest(),
    )


def render_plan() -> RenderPlanDocument:
    return RenderPlanDocument(
        *common(TTS_ARTIFACT_PATH),  # type: ignore[arg-type]
        translated_cues(),
        track().blur_regions,
        PurePosixPath("artifacts/tts.wav"),
        digest(),
        (Part(1, 1, FrameInterval(0, 900), (0,)),),
        True,
        PurePosixPath("artifacts/render/rendered.mp4"),
        digest(SHA_B, 20),
    )


def render_chunk_plan() -> RenderChunkPlanDocument:
    upstream = replace(tts(), frame_count=601)
    chunks = (
        RenderChunk(0, FrameInterval(0, 300)),
        RenderChunk(1, FrameInterval(300, 600)),
        RenderChunk(2, FrameInterval(600, 601)),
    )
    return RenderChunkPlanDocument(
        1,
        upstream.job_id,
        upstream.media_digest,
        upstream.frame_count,
        upstream.width,
        upstream.height,
        TTS_ARTIFACT_PATH,
        document_digest(upstream),
        Fingerprint("c" * 64),
        chunks,
        (Part(1, 1, FrameInterval(0, 601), (0, 1, 2)),),
        True,
    )


def publication() -> PublicationDocument:
    return PublicationDocument(
        *common(RENDER_PLAN_ARTIFACT_PATH),  # type: ignore[arg-type]
        render_plan().parts,
        (PurePosixPath("published/part-001.mp4"),),
        (digest(),),
    )


def checkpoint() -> CheckpointDocument:
    return CheckpointDocument(
        *common(PUBLICATION_ARTIFACT_PATH),  # type: ignore[arg-type]
        "checkpoint-001",
        PurePosixPath("checkpoints/manifest-v1.json"),
        digest(),
        PurePosixPath("checkpoints/job-v2.sqlite"),
        digest(SHA_B),
    )


def canonical_payload(payload: object) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def document_digest(document: object) -> FileDigest:
    raw = canonical_document_bytes(document)
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


class PipelineModuleContractTests(unittest.TestCase):
    def test_pipeline_contract_module_exists(self) -> None:
        self.assertIsNotNone(importlib.util.find_spec("ytb_vps_v2.domain.pipeline"))

    def test_pipeline_contract_exports_every_document_and_codec(self) -> None:
        module = importlib.import_module("ytb_vps_v2.domain.pipeline")
        expected = (
            "MediaDocument",
            "OcrDocument",
            "TrackDocument",
            "TranslationDocument",
            "TtsDocument",
            "RenderChunkPlanDocument",
            "RenderPlanDocument",
            "PublicationDocument",
            "CheckpointDocument",
            "PipelineDocument",
            "canonical_document_bytes",
            "parse_media_document_bytes",
            "parse_ocr_document_bytes",
            "parse_track_document_bytes",
            "parse_translation_document_bytes",
            "parse_tts_document_bytes",
            "parse_render_chunk_plan_document_bytes",
            "parse_render_plan_document_bytes",
            "parse_publication_document_bytes",
            "parse_checkpoint_document_bytes",
        )

        self.assertEqual(
            tuple(name for name in expected if not hasattr(module, name)),
            (),
        )

    def test_domain_package_reexports_pipeline_contracts(self) -> None:
        domain = importlib.import_module("ytb_vps_v2.domain")
        expected = (
            "MediaDocument",
            "OcrDocument",
            "TrackDocument",
            "TranslationDocument",
            "TtsDocument",
            "RenderChunkPlanDocument",
            "RenderPlanDocument",
            "PublicationDocument",
            "CheckpointDocument",
            "PipelineDocument",
            "canonical_document_bytes",
            "parse_media_document_bytes",
            "parse_ocr_document_bytes",
            "parse_track_document_bytes",
            "parse_translation_document_bytes",
            "parse_tts_document_bytes",
            "parse_render_chunk_plan_document_bytes",
            "parse_render_plan_document_bytes",
            "parse_publication_document_bytes",
            "parse_checkpoint_document_bytes",
        )

        self.assertEqual(
            tuple(name for name in expected if not hasattr(domain, name)),
            (),
        )
        self.assertTrue(set(expected).issubset(domain.__all__))

    def test_documents_are_slotted_dataclasses_with_explicit_fields(self) -> None:
        module = importlib.import_module("ytb_vps_v2.domain.pipeline")
        expected_fields = {
            "MediaDocument": (
                "schema_version",
                "job_id",
                "source_path",
                "source_digest",
                "duration_seconds",
                "source_fps",
                "timeline",
                "frame_count",
                "width",
                "height",
                "has_audio",
            ),
            "OcrDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "cues",
            ),
            "TrackDocument": (
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
            ),
            "TranslationDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "cues",
            ),
            "TtsDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "cues",
                "audio_path",
                "audio_digest",
            ),
            "RenderChunkPlanDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "render_fingerprint",
                "chunks",
                "parts",
                "output_has_audio",
            ),
            "RenderPlanDocument": (
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
                "rendered_path",
                "rendered_digest",
            ),
            "PublicationDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "parts",
                "part_paths",
                "part_digests",
            ),
            "CheckpointDocument": (
                "schema_version",
                "job_id",
                "media_digest",
                "frame_count",
                "width",
                "height",
                "dependency_path",
                "dependency_digest",
                "checkpoint_id",
                "manifest_path",
                "manifest_digest",
                "state_snapshot_path",
                "state_snapshot_digest",
            ),
        }

        for name, names in expected_fields.items():
            document_type = getattr(module, name)
            with self.subTest(document=name):
                self.assertTrue(is_dataclass(document_type))
                self.assertEqual(tuple(item.name for item in fields(document_type)), names)
                self.assertIn("__slots__", document_type.__dict__)

    def test_render_plan_persists_the_rendered_side_asset_reference(self) -> None:
        self.assertEqual(
            tuple(item.name for item in fields(RenderPlanDocument))[-2:],
            ("rendered_path", "rendered_digest"),
        )

    def test_render_request_is_a_separate_typed_pre_render_contract(self) -> None:
        module = importlib.import_module("ytb_vps_v2.domain.pipeline")
        self.assertTrue(hasattr(module, "RenderRequest"))
        request_type = module.RenderRequest
        self.assertTrue(is_dataclass(request_type))
        self.assertEqual(
            tuple(item.name for item in fields(request_type)),
            tuple(item.name for item in fields(RenderPlanDocument))[:-2],
        )
        self.assertIn("__slots__", request_type.__dict__)


class PipelineValueTests(unittest.TestCase):
    def test_accepts_exact_existing_domain_values_and_is_frozen(self) -> None:
        documents = (
            media(),
            ocr(),
            track(),
            translation(),
            tts(),
            render_plan(),
            publication(),
            checkpoint(),
        )

        self.assertEqual([item.schema_version for item in documents], [1] * 8)
        for document in documents:
            with self.subTest(document=type(document).__name__):
                with self.assertRaises(FrozenInstanceError):
                    document.schema_version = 2  # type: ignore[misc]

    def test_rejects_unsupported_schema_versions_and_impostor_runtime_types(self) -> None:
        invalid_factories = (
            lambda: replace(media(), schema_version=2),
            lambda: replace(media(), schema_version=True),
            lambda: replace(media(), job_id="job-001"),
            lambda: replace(media(), source_digest=SHA_A),
            lambda: replace(media(), duration_seconds=30.0),
            lambda: replace(media(), source_fps=30),
            lambda: replace(media(), timeline="30fps"),
            lambda: replace(media(), frame_count=True),
            lambda: replace(media(), width=320.0),
            lambda: replace(media(), has_audio=1),
            lambda: replace(ocr(), cues=list(source_cues())),
            lambda: replace(track(), blur_regions=list(track().blur_regions)),
            lambda: replace(render_plan(), parts=list(render_plan().parts)),
            lambda: replace(publication(), part_digests=[digest()]),
        )

        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()

    def test_media_is_exactly_the_thirty_second_canonical_timeline(self) -> None:
        invalid_factories = (
            lambda: replace(media(), duration_seconds=Fraction(29)),
            lambda: replace(media(), timeline=Timeline(25)),
            lambda: replace(media(), frame_count=899),
            lambda: replace(media(), source_fps=Fraction(0)),
            lambda: replace(media(), width=0),
            lambda: replace(media(), height=-1),
        )

        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()

    def test_cues_are_ordered_unique_and_inside_media_frames_and_pixels(self) -> None:
        first, second = source_cues()
        invalid_cues = (
            (second, first),
            (first, first),
            (replace(first, interval=FrameInterval(899, 901)),),
            (replace(first, box=BoundingBox(10, 20, 321, 60)),),
        )

        for cues in invalid_cues:
            with self.subTest(cues=cues):
                with self.assertRaises(DomainInvariantError):
                    replace(ocr(), cues=cues)

    def test_translation_and_tts_require_non_empty_target_text(self) -> None:
        invalid_cues = (replace(translated_cues()[0], target_text=""),)

        for document in (translation(), tts(), render_plan()):
            with self.subTest(document=type(document).__name__):
                with self.assertRaises(DomainInvariantError):
                    replace(document, cues=invalid_cues)

    def test_blur_regions_and_parts_stay_inside_thirty_second_frame(self) -> None:
        invalid_blur = BlurRegion(
            RegionKind.DYNAMIC,
            FrameInterval(899, 901),
            BoundingBox(1, 1, 2, 2),
        )
        invalid_part = Part(1, 1, FrameInterval(0, 901), (0,))

        with self.assertRaises(DomainInvariantError):
            replace(track(), blur_regions=(invalid_blur,))
        with self.assertRaises(DomainInvariantError):
            replace(render_plan(), parts=(invalid_part,))

    def test_artifact_references_are_safe_relative_posix_paths_with_file_digests(self) -> None:
        invalid_paths = (
            PurePosixPath("."),
            PurePosixPath("../escape"),
            PurePosixPath("/absolute"),
            PurePosixPath("C:/windows"),
            PurePosixPath(r"nested\artifact.json"),
        )
        for path in invalid_paths:
            with self.subTest(path=path):
                with self.assertRaises(DomainInvariantError):
                    replace(ocr(), dependency_path=path)
                with self.assertRaises(DomainInvariantError):
                    replace(tts(), audio_path=path)
                with self.assertRaises(DomainInvariantError):
                    replace(render_plan(), rendered_path=path)

        with self.assertRaises(DomainInvariantError):
            replace(ocr(), dependency_digest=SHA_A)
        with self.assertRaises(DomainInvariantError):
            replace(render_plan(), rendered_digest=SHA_A)

    def test_publication_parts_paths_and_digests_are_aligned_and_unique(self) -> None:
        with self.assertRaises(DomainInvariantError):
            replace(publication(), part_paths=())
        with self.assertRaises(DomainInvariantError):
            replace(
                publication(),
                parts=(
                    Part(1, 2, FrameInterval(0, 450), (0,)),
                    Part(2, 2, FrameInterval(450, 900), (1,)),
                ),
                part_paths=(PurePosixPath("published/same.mp4"),) * 2,
                part_digests=(digest(), digest()),
            )

    def test_checkpoint_identity_and_distinct_artifacts_are_required(self) -> None:
        with self.assertRaises(DomainInvariantError):
            replace(checkpoint(), checkpoint_id="")
        with self.assertRaises(DomainInvariantError):
            replace(
                checkpoint(),
                state_snapshot_path=checkpoint().manifest_path,
            )

    def test_documents_reject_nested_subclasses_and_impostors(self) -> None:
        cue = source_cues()[0]
        blur = track().blur_regions[0]
        part = render_plan().parts[0]

        def forged_region_kind() -> TrackDocument:
            region = replace(blur)
            object.__setattr__(region, "kind", RegionKind.DYNAMIC.value)
            return replace(track(), blur_regions=(region,))

        invalid_factories = (
            lambda: replace(media(), job_id=JobId(TextSubclass("job-001"))),
            lambda: replace(media(), timeline=Timeline(IntSubclass(30))),
            lambda: replace(
                ocr(),
                cues=(replace(cue, cue_index=IntSubclass(1)),),
            ),
            lambda: replace(
                ocr(),
                cues=(
                    replace(cue, interval=FrameIntervalSubclass(30, 90)),
                ),
            ),
            lambda: replace(
                ocr(),
                cues=(
                    replace(cue, box=BoundingBoxSubclass(10, 20, 110, 60)),
                ),
            ),
            lambda: replace(
                ocr(),
                cues=(
                    replace(
                        cue,
                        box=BoundingBox(IntSubclass(10), 20, 110, 60),
                    ),
                ),
            ),
            lambda: replace(
                ocr(),
                cues=(replace(cue, source_text=TextSubclass("hello")),),
            ),
            forged_region_kind,
            lambda: replace(
                track(),
                blur_regions=(
                    replace(blur, interval=FrameIntervalSubclass(30, 90)),
                ),
            ),
            lambda: replace(
                track(),
                blur_regions=(
                    replace(blur, box=BoundingBoxSubclass(10, 20, 110, 60)),
                ),
            ),
            lambda: replace(
                render_plan(),
                parts=(replace(part, part_index=IntSubclass(1)),),
            ),
            lambda: replace(
                render_plan(),
                parts=(replace(part, interval=FrameIntervalSubclass(0, 900)),),
            ),
            lambda: replace(
                render_plan(),
                parts=(replace(part, chunk_indexes=TupleSubclass((0,))),),
            ),
            lambda: replace(
                render_plan(),
                parts=(replace(part, chunk_indexes=(IntSubclass(0),)),),
            ),
        )

        for factory in invalid_factories:
            with self.subTest(factory=factory):
                with self.assertRaises(DomainInvariantError):
                    factory()


class PipelineCanonicalSerializationTests(unittest.TestCase):
    def test_serializer_emits_canonical_utf8_and_exact_fraction_pairs(self) -> None:
        value = replace(media(), source_fps=Fraction(30_000, 1_001))
        try:
            raw = canonical_document_bytes(value)
        except NotImplementedError:
            raw = None

        self.assertIsInstance(raw, bytes)
        assert raw is not None
        self.assertFalse(raw.endswith(b"\n"))
        self.assertEqual(
            raw,
            json.dumps(
                json.loads(raw),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        )
        payload = json.loads(raw)
        self.assertEqual(payload["duration_seconds"], {"denominator": 1, "numerator": 30})
        self.assertEqual(payload["source_fps"], {"denominator": 1001, "numerator": 30000})

    def test_serializer_accepts_exactly_the_nine_document_types(self) -> None:
        documents = (
            media(),
            ocr(),
            track(),
            translation(),
            tts(),
            render_chunk_plan(),
            render_plan(),
            publication(),
            checkpoint(),
        )

        for document in documents:
            with self.subTest(document=type(document).__name__):
                try:
                    raw = canonical_document_bytes(document)
                except NotImplementedError:
                    raw = None
                self.assertIsInstance(raw, bytes)

        try:
            canonical_document_bytes({})
        except Exception as exc:  # RED captures the not-yet-implemented codec.
            invalid_error = exc
        else:
            invalid_error = None
        self.assertIsInstance(invalid_error, DomainInvariantError)

    def test_every_strict_parser_round_trips_its_exact_document_type(self) -> None:
        cases = (
            (media(), parse_media_document_bytes),
            (ocr(), parse_ocr_document_bytes),
            (track(), parse_track_document_bytes),
            (translation(), parse_translation_document_bytes),
            (tts(), parse_tts_document_bytes),
            (render_chunk_plan(), parse_render_chunk_plan_document_bytes),
            (render_plan(), parse_render_plan_document_bytes),
            (publication(), parse_publication_document_bytes),
            (checkpoint(), parse_checkpoint_document_bytes),
        )

        for expected, parser in cases:
            raw = canonical_document_bytes(expected)
            try:
                actual = parser(raw)
            except NotImplementedError:
                actual = None
            with self.subTest(document=type(expected).__name__):
                self.assertEqual(actual, expected)
                if actual is not None:
                    self.assertIs(type(actual), type(expected))
                    self.assertIs(type(actual.job_id), JobId)
                    self.assertIs(type(actual.job_id.value), str)
                    if type(actual) is MediaDocument:
                        self.assertIs(type(actual.timeline), Timeline)
                        self.assertIs(type(actual.timeline.target_fps), int)
                    for cue in getattr(actual, "cues", ()):
                        self.assertIs(type(cue), Cue)
                        self.assertIs(type(cue.cue_index), int)
                        self.assertIs(type(cue.interval), FrameInterval)
                        self.assertIs(type(cue.box), BoundingBox)
                        self.assertIs(type(cue.source_text), str)
                    for region in getattr(actual, "blur_regions", ()):
                        self.assertIs(type(region), BlurRegion)
                        self.assertIs(type(region.kind), RegionKind)
                        self.assertIs(type(region.interval), FrameInterval)
                        self.assertIs(type(region.box), BoundingBox)
                    for chunk in getattr(actual, "chunks", ()):
                        self.assertIs(type(chunk), RenderChunk)
                        self.assertIs(type(chunk.index), int)
                        self.assertIs(type(chunk.interval), FrameInterval)
                    for part in getattr(actual, "parts", ()):
                        self.assertIs(type(part), Part)
                        self.assertIs(type(part.part_index), int)
                        self.assertIs(type(part.part_count), int)
                        self.assertIs(type(part.interval), FrameInterval)
                        self.assertIs(type(part.chunk_indexes), tuple)
                        self.assertTrue(
                            all(type(index) is int for index in part.chunk_indexes)
                        )
                    self.assertEqual(canonical_document_bytes(actual), raw)

    def test_render_chunk_plan_round_trips_and_verifies_its_tts_dependency(
        self,
    ) -> None:
        upstream = replace(tts(), frame_count=601)
        document = render_chunk_plan()
        raw = canonical_document_bytes(document)

        self.assertEqual(
            parse_render_chunk_plan_document_bytes(raw, upstream),
            document,
        )
        self.assertEqual(
            canonical_document_bytes(
                parse_render_chunk_plan_document_bytes(raw)
            ),
            raw,
        )

    def test_render_chunk_plan_parser_rejects_malformed_chunk_topology(
        self,
    ) -> None:
        upstream = replace(tts(), frame_count=601)
        invalid_payloads: list[dict[str, object]] = []

        unknown = json.loads(canonical_document_bytes(render_chunk_plan()))
        unknown["chunks"][0]["unexpected"] = True
        invalid_payloads.append(unknown)

        non_contiguous = json.loads(canonical_document_bytes(render_chunk_plan()))
        non_contiguous["chunks"][1]["interval"]["start_frame"] = 301
        invalid_payloads.append(non_contiguous)

        missing_index = json.loads(canonical_document_bytes(render_chunk_plan()))
        missing_index["chunks"][1]["index"] = 2
        invalid_payloads.append(missing_index)

        wrong_dependency = json.loads(canonical_document_bytes(render_chunk_plan()))
        wrong_dependency["dependency_digest"]["sha256"] = "d" * 64
        invalid_payloads.append(wrong_dependency)

        part_mismatch = json.loads(canonical_document_bytes(render_chunk_plan()))
        part_mismatch["parts"][0]["chunk_indexes"] = [0, 2]
        invalid_payloads.append(part_mismatch)

        duplicate = canonical_document_bytes(render_chunk_plan()).replace(
            b'{"chunks":',
            b'{"chunks":[],"chunks":',
            1,
        )

        for raw in (
            *(canonical_payload(item) for item in invalid_payloads),
            duplicate,
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(DomainInvariantError):
                    parse_render_chunk_plan_document_bytes(raw, upstream)

    def test_parsers_reject_non_bytes_noncanonical_and_wrong_document_types(self) -> None:
        raw = canonical_document_bytes(media())
        payload = json.loads(raw)
        variants = (
            raw.decode("utf-8"),
            json.dumps(payload, indent=2).encode("utf-8"),
            raw + b"\n",
            raw + b" ",
            b"not-json\n",
            b"\xff\n",
        )
        for variant in variants:
            with self.subTest(variant=variant):
                with self.assertRaises(DomainInvariantError):
                    parse_media_document_bytes(variant)  # type: ignore[arg-type]

        with self.assertRaises(DomainInvariantError):
            parse_ocr_document_bytes(raw)

    def test_parsers_reject_unknown_missing_and_duplicate_json_fields(self) -> None:
        payload = json.loads(canonical_document_bytes(ocr()))
        unknown = dict(payload, unexpected=True)
        missing = dict(payload)
        del missing["job_id"]
        nested_unknown = json.loads(canonical_document_bytes(ocr()))
        nested_unknown["cues"][0]["unexpected"] = True
        nested_missing = json.loads(canonical_document_bytes(ocr()))
        del nested_missing["dependency_digest"]["sha256"]
        duplicate = b'{"document_type":"ocr","document_type":"ocr"}\n'

        for raw in (
            canonical_payload(unknown),
            canonical_payload(missing),
            canonical_payload(nested_unknown),
            canonical_payload(nested_missing),
            duplicate,
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(DomainInvariantError):
                    parse_ocr_document_bytes(raw)

    def test_parsers_reject_booleans_floats_versions_and_non_fraction_encoding(self) -> None:
        invalid_payloads: list[dict[str, object]] = []
        for field, value in (
            ("schema_version", 2),
            ("schema_version", True),
            ("frame_count", 900.0),
            ("width", True),
        ):
            payload = json.loads(canonical_document_bytes(media()))
            payload[field] = value
            invalid_payloads.append(payload)
        for field, value in (("numerator", True), ("denominator", 1.0)):
            payload = json.loads(canonical_document_bytes(media()))
            payload["duration_seconds"][field] = value
            invalid_payloads.append(payload)
        payload = json.loads(canonical_document_bytes(media()))
        payload["duration_seconds"] = 30
        invalid_payloads.append(payload)

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(DomainInvariantError):
                    parse_media_document_bytes(canonical_payload(payload))

    def test_parsers_reject_duplicate_semantic_indexes_unsafe_paths_and_bad_sha256(self) -> None:
        payloads: list[dict[str, object]] = []
        duplicate_cues = json.loads(canonical_document_bytes(ocr()))
        duplicate_cues["cues"][1]["cue_index"] = 1
        payloads.append(duplicate_cues)
        unsafe = json.loads(canonical_document_bytes(ocr()))
        unsafe["dependency_path"] = "../escape.json"
        payloads.append(unsafe)
        bad_sha = json.loads(canonical_document_bytes(ocr()))
        bad_sha["dependency_digest"]["sha256"] = SHA_A.upper()
        payloads.append(bad_sha)
        bool_size = json.loads(canonical_document_bytes(ocr()))
        bool_size["dependency_digest"]["size_bytes"] = True
        payloads.append(bool_size)

        for payload in payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(DomainInvariantError):
                    parse_ocr_document_bytes(canonical_payload(payload))

    def test_track_parser_wraps_unsupported_region_kind_as_domain_error(self) -> None:
        payload = json.loads(canonical_document_bytes(track()))
        payload["blur_regions"][0]["kind"] = "unsupported"

        try:
            parse_track_document_bytes(canonical_payload(payload))
        except Exception as exc:
            error = exc
        else:
            error = None

        self.assertIsInstance(error, DomainInvariantError)

    def test_parser_can_verify_cross_document_identity_payload_and_dependency_digest(self) -> None:
        source = media()
        ocr_value = replace(
            ocr(),
            job_id=source.job_id,
            media_digest=source.source_digest,
            frame_count=source.frame_count,
            width=source.width,
            height=source.height,
            dependency_digest=document_digest(source),
        )
        track_value = replace(
            track(),
            job_id=ocr_value.job_id,
            media_digest=ocr_value.media_digest,
            frame_count=ocr_value.frame_count,
            width=ocr_value.width,
            height=ocr_value.height,
            dependency_digest=document_digest(ocr_value),
            cues=ocr_value.cues,
        )
        translation_value = replace(
            translation(),
            job_id=track_value.job_id,
            media_digest=track_value.media_digest,
            frame_count=track_value.frame_count,
            width=track_value.width,
            height=track_value.height,
            dependency_digest=document_digest(track_value),
        )
        tts_value = replace(
            tts(),
            job_id=translation_value.job_id,
            media_digest=translation_value.media_digest,
            frame_count=translation_value.frame_count,
            width=translation_value.width,
            height=translation_value.height,
            dependency_digest=document_digest(translation_value),
            cues=translation_value.cues,
        )
        render_value = replace(
            render_plan(),
            job_id=tts_value.job_id,
            media_digest=tts_value.media_digest,
            frame_count=tts_value.frame_count,
            width=tts_value.width,
            height=tts_value.height,
            dependency_digest=document_digest(tts_value),
            cues=tts_value.cues,
            tts_audio_path=tts_value.audio_path,
            tts_audio_digest=tts_value.audio_digest,
        )
        publication_value = replace(
            publication(),
            job_id=render_value.job_id,
            media_digest=render_value.media_digest,
            frame_count=render_value.frame_count,
            width=render_value.width,
            height=render_value.height,
            dependency_digest=document_digest(render_value),
            parts=render_value.parts,
        )
        checkpoint_value = replace(
            checkpoint(),
            job_id=publication_value.job_id,
            media_digest=publication_value.media_digest,
            frame_count=publication_value.frame_count,
            width=publication_value.width,
            height=publication_value.height,
            dependency_digest=document_digest(publication_value),
        )

        try:
            parsed = (
                parse_ocr_document_bytes(canonical_document_bytes(ocr_value), source),
                parse_track_document_bytes(
                    canonical_document_bytes(track_value), ocr_value
                ),
                parse_translation_document_bytes(
                    canonical_document_bytes(translation_value), track_value
                ),
                parse_tts_document_bytes(
                    canonical_document_bytes(tts_value), translation_value
                ),
                parse_render_plan_document_bytes(
                    canonical_document_bytes(render_value), tts_value
                ),
                parse_publication_document_bytes(
                    canonical_document_bytes(publication_value), render_value
                ),
                parse_checkpoint_document_bytes(
                    canonical_document_bytes(checkpoint_value), publication_value
                ),
            )
        except TypeError:
            parsed = None
        self.assertEqual(
            parsed,
            (
                ocr_value,
                track_value,
                translation_value,
                tts_value,
                render_value,
                publication_value,
                checkpoint_value,
            ),
        )

        mismatched = replace(source, job_id=JobId("other-job"))
        try:
            parse_ocr_document_bytes(canonical_document_bytes(ocr_value), mismatched)
        except Exception as exc:
            mismatch_error = exc
        else:
            mismatch_error = None
        self.assertIsInstance(mismatch_error, DomainInvariantError)

    def test_parser_rejects_wrong_immediate_upstream_path_with_correct_digest(self) -> None:
        source = media()
        ocr_value = replace(
            ocr(),
            job_id=source.job_id,
            media_digest=source.source_digest,
            frame_count=source.frame_count,
            width=source.width,
            height=source.height,
            dependency_digest=document_digest(source),
        )
        payload = json.loads(canonical_document_bytes(ocr_value))
        payload["dependency_path"] = str(OCR_ARTIFACT_PATH)

        try:
            parse_ocr_document_bytes(canonical_payload(payload), source)
        except Exception as exc:
            error = exc
        else:
            error = None

        self.assertIsInstance(error, DomainInvariantError)


if __name__ == "__main__":
    unittest.main()
