from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from fractions import Fraction
from pathlib import PurePosixPath, PureWindowsPath
from types import MappingProxyType
from typing import TypeAlias

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
from ytb_vps_v2.domain.render_chunks import single_part_for_chunks
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


SCHEMA_VERSION = 1
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
CHECKPOINT_ARTIFACT_PATH = PurePosixPath("artifacts/backup/checkpoint.json")


def _require_exact(name: str, value: object, expected: type[object]) -> None:
    if type(value) is not expected:
        raise DomainInvariantError(f"{name} must be {expected.__name__}")


def _require_int(name: str, value: object, *, minimum: int | None = None) -> None:
    if type(value) is not int:
        raise DomainInvariantError(f"{name} must be an integer")
    if minimum is not None and value < minimum:
        raise DomainInvariantError(f"{name} must be at least {minimum}")


def _require_schema(value: object) -> None:
    if type(value) is not int or value != SCHEMA_VERSION:
        raise DomainInvariantError(
            f"Pipeline document schema version must be {SCHEMA_VERSION}"
        )


def _artifact_path(name: str, value: object) -> PurePosixPath:
    if type(value) is not PurePosixPath:
        raise DomainInvariantError(f"{name} must use portable POSIX format")
    raw = str(value)
    windows_view = PureWindowsPath(raw)
    if (
        raw in {"", "."}
        or "\\" in raw
        or value.is_absolute()
        or windows_view.is_absolute()
        or bool(windows_view.drive)
        or any(part in {"", ".", ".."} for part in value.parts)
    ):
        raise DomainInvariantError(f"{name} must be safe and relative")
    return value


def _digest(name: str, value: object) -> FileDigest:
    _require_exact(name, value, FileDigest)
    return value  # type: ignore[return-value]


def _job_id(name: str, value: object) -> JobId:
    _require_exact(name, value, JobId)
    _require_exact(f"{name} value", value.value, str)  # type: ignore[attr-defined]
    return value  # type: ignore[return-value]


def _frame_interval(name: str, value: object) -> FrameInterval:
    _require_exact(name, value, FrameInterval)
    _require_int(f"{name} start", value.start_frame)  # type: ignore[attr-defined]
    _require_int(f"{name} end", value.end_frame)  # type: ignore[attr-defined]
    return value  # type: ignore[return-value]


def _bounding_box(name: str, value: object) -> BoundingBox:
    _require_exact(name, value, BoundingBox)
    for coordinate in ("xmin", "ymin", "xmax", "ymax"):
        _require_int(
            f"{name} {coordinate}",
            getattr(value, coordinate),
        )
    return value  # type: ignore[return-value]


def _dimensions(frame_count: object, width: object, height: object) -> None:
    _require_int("Frame count", frame_count, minimum=1)
    _require_int("Media width", width, minimum=1)
    _require_int("Media height", height, minimum=1)


def _base(
    schema_version: object,
    job_id: object,
    media_digest: object,
    frame_count: object,
    width: object,
    height: object,
    dependency_path: object,
    dependency_digest: object,
    expected_dependency_path: PurePosixPath,
) -> None:
    _require_schema(schema_version)
    _job_id("Pipeline job ID", job_id)
    _digest("Media digest", media_digest)
    _dimensions(frame_count, width, height)
    validated_path = _artifact_path("Dependency path", dependency_path)
    _digest("Dependency digest", dependency_digest)
    if validated_path != expected_dependency_path:
        raise DomainInvariantError(
            f"Dependency path must be {expected_dependency_path.as_posix()}"
        )


def _cues(
    value: object,
    *,
    frame_count: int,
    width: int,
    height: int,
    target_required: bool,
) -> tuple[Cue, ...]:
    if type(value) is not tuple or any(type(item) is not Cue for item in value):
        raise DomainInvariantError("Document cues must be Cue values")
    cues = value
    indexes = tuple(item.cue_index for item in cues)
    if indexes != tuple(sorted(set(indexes))):
        raise DomainInvariantError("Cue indexes must be ordered and unique")
    for cue in cues:
        _require_int("Cue index", cue.cue_index)
        _frame_interval("Cue interval", cue.interval)
        _bounding_box("Cue box", cue.box)
        _require_exact("Cue source text", cue.source_text, str)
        if cue.interval.end_frame > frame_count:
            raise DomainInvariantError("Cue interval must stay inside media frames")
        if cue.box.xmax > width or cue.box.ymax > height:
            raise DomainInvariantError("Cue box must stay inside media pixels")
        if target_required and (
            type(cue.target_text) is not str or not cue.target_text.strip()
        ):
            raise DomainInvariantError("Cue target text must be non-empty")
        if not target_required and cue.target_text is not None:
            raise DomainInvariantError("Source cue target text must be absent")
    return cues


def _blur_regions(
    value: object, *, frame_count: int, width: int, height: int
) -> tuple[BlurRegion, ...]:
    if type(value) is not tuple or any(type(item) is not BlurRegion for item in value):
        raise DomainInvariantError("Blur regions must be BlurRegion values")
    regions = value
    for region in regions:
        _require_exact("Blur region kind", region.kind, RegionKind)
        _frame_interval("Blur region interval", region.interval)
        _bounding_box("Blur region box", region.box)
        if region.interval.end_frame > frame_count:
            raise DomainInvariantError("Blur interval must stay inside media frames")
        if region.box.xmax > width or region.box.ymax > height:
            raise DomainInvariantError("Blur box must stay inside media pixels")
    return regions


def _parts(value: object, *, frame_count: int) -> tuple[Part, ...]:
    if type(value) is not tuple or not value or any(type(item) is not Part for item in value):
        raise DomainInvariantError("Document parts must be a non-empty tuple of Part values")
    parts = value
    for part in parts:
        _require_int("Part index", part.part_index)
        _require_int("Part count", part.part_count)
        _frame_interval("Part interval", part.interval)
        if type(part.chunk_indexes) is not tuple:
            raise DomainInvariantError("Part chunk indexes must be a tuple")
        for chunk_index in part.chunk_indexes:
            _require_int("Part chunk index", chunk_index)
    expected_indexes = tuple(range(1, len(parts) + 1))
    if (
        tuple(item.part_index for item in parts) != expected_indexes
        or any(item.part_count != len(parts) for item in parts)
        or any(item.interval.end_frame > frame_count for item in parts)
    ):
        raise DomainInvariantError("Parts must be ordered, complete, and inside media frames")
    # "Complete" must actually mean tiling: contiguous intervals covering all media
    # frames, with chunk indexes strictly increasing across the whole plan.
    if (
        parts[0].interval.start_frame != 0
        or parts[-1].interval.end_frame != frame_count
        or any(
            parts[position + 1].interval.start_frame != parts[position].interval.end_frame
            for position in range(len(parts) - 1)
        )
    ):
        raise DomainInvariantError("Parts must be ordered, complete, and inside media frames")
    all_chunk_indexes = tuple(
        chunk_index for part in parts for chunk_index in part.chunk_indexes
    )
    if any(
        later <= earlier
        for earlier, later in zip(all_chunk_indexes, all_chunk_indexes[1:])
    ):
        raise DomainInvariantError("Part chunk indexes must be disjoint and increasing")
    return parts


def _artifact_paths(name: str, value: object) -> tuple[PurePosixPath, ...]:
    if type(value) is not tuple:
        raise DomainInvariantError(f"{name} must be a tuple")
    paths = tuple(_artifact_path(name, item) for item in value)
    if len(paths) != len(set(paths)):
        raise DomainInvariantError(f"{name} must be unique")
    return paths


def _digests(name: str, value: object) -> tuple[FileDigest, ...]:
    if type(value) is not tuple or any(type(item) is not FileDigest for item in value):
        raise DomainInvariantError(f"{name} must be FileDigest values")
    return value


@dataclass(frozen=True, slots=True)
class MediaDocument:
    schema_version: int
    job_id: JobId
    source_path: PurePosixPath
    source_digest: FileDigest
    duration_seconds: Fraction
    source_fps: Fraction
    timeline: Timeline
    frame_count: int
    width: int
    height: int
    has_audio: bool

    def __post_init__(self) -> None:
        _require_schema(self.schema_version)
        _job_id("Media job ID", self.job_id)
        _artifact_path("Media source path", self.source_path)
        _digest("Media source digest", self.source_digest)
        _require_exact("Media duration", self.duration_seconds, Fraction)
        _require_exact("Media source FPS", self.source_fps, Fraction)
        _require_exact("Media timeline", self.timeline, Timeline)
        _require_int("Media timeline target FPS", self.timeline.target_fps)
        _dimensions(self.frame_count, self.width, self.height)
        _require_exact("Media audio flag", self.has_audio, bool)
        # The canonical timeline is the only clock in the system: every Cue,
        # BlurRegion and Part frame index lives on it. Pinning duration to
        # frames/target_fps is what stops audio drifting from video over an hour.
        if self.source_fps <= 0:
            raise DomainInvariantError("Media source FPS must be positive")
        if self.timeline.target_fps <= 0:
            raise DomainInvariantError("Media timeline FPS must be positive")
        if self.duration_seconds != Fraction(self.frame_count, self.timeline.target_fps):
            raise DomainInvariantError(
                "Media duration must equal frame count divided by the timeline FPS"
            )


@dataclass(frozen=True, slots=True)
class OcrDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            MEDIA_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=False,
        )


@dataclass(frozen=True, slots=True)
class TrackDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]
    blur_regions: tuple[BlurRegion, ...]

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            OCR_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=False,
        )
        _blur_regions(
            self.blur_regions,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
        )


@dataclass(frozen=True, slots=True)
class TranslationDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            TRACK_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=True,
        )


@dataclass(frozen=True, slots=True)
class TtsDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]
    audio_path: PurePosixPath
    audio_digest: FileDigest

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            TRANSLATION_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=True,
        )
        _artifact_path("TTS audio path", self.audio_path)
        _digest("TTS audio digest", self.audio_digest)


@dataclass(frozen=True, slots=True)
class RenderChunkPlanDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    render_fingerprint: Fingerprint
    chunks: tuple[RenderChunk, ...]
    parts: tuple[Part, ...]
    output_has_audio: bool

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            TTS_ARTIFACT_PATH,
        )
        if type(self.render_fingerprint) is not Fingerprint:
            raise DomainInvariantError("Chunk plan needs a render fingerprint")
        expected = single_part_for_chunks(self.frame_count, self.chunks)
        if self.parts != (expected,):
            raise DomainInvariantError(
                "Chunk plan Part must cover every render chunk"
            )
        _require_exact(
            "Chunk-plan audio flag",
            self.output_has_audio,
            bool,
        )


@dataclass(frozen=True, slots=True)
class RenderRequest:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]
    blur_regions: tuple[BlurRegion, ...]
    tts_audio_path: PurePosixPath
    tts_audio_digest: FileDigest
    parts: tuple[Part, ...]
    output_has_audio: bool

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            TTS_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=True,
        )
        _blur_regions(
            self.blur_regions,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
        )
        _artifact_path("Render-request TTS audio path", self.tts_audio_path)
        _digest("Render-request TTS audio digest", self.tts_audio_digest)
        _parts(self.parts, frame_count=self.frame_count)
        _require_exact("Render output audio flag", self.output_has_audio, bool)


@dataclass(frozen=True, slots=True)
class RenderPlanDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    cues: tuple[Cue, ...]
    blur_regions: tuple[BlurRegion, ...]
    tts_audio_path: PurePosixPath
    tts_audio_digest: FileDigest
    parts: tuple[Part, ...]
    output_has_audio: bool
    rendered_path: PurePosixPath
    rendered_digest: FileDigest

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            TTS_ARTIFACT_PATH,
        )
        _cues(
            self.cues,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
            target_required=True,
        )
        _blur_regions(
            self.blur_regions,
            frame_count=self.frame_count,
            width=self.width,
            height=self.height,
        )
        _artifact_path("Render-plan TTS audio path", self.tts_audio_path)
        _digest("Render-plan TTS audio digest", self.tts_audio_digest)
        _parts(self.parts, frame_count=self.frame_count)
        _require_exact("Render output audio flag", self.output_has_audio, bool)
        _artifact_path("Rendered media path", self.rendered_path)
        _digest("Rendered media digest", self.rendered_digest)


@dataclass(frozen=True, slots=True)
class PublicationDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    parts: tuple[Part, ...]
    part_paths: tuple[PurePosixPath, ...]
    part_digests: tuple[FileDigest, ...]

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            RENDER_PLAN_ARTIFACT_PATH,
        )
        parts = _parts(self.parts, frame_count=self.frame_count)
        paths = _artifact_paths("Published Part paths", self.part_paths)
        digests = _digests("Published Part digests", self.part_digests)
        if len(parts) != len(paths) or len(parts) != len(digests):
            raise DomainInvariantError("Published Parts, paths, and digests must align")


@dataclass(frozen=True, slots=True)
class CheckpointDocument:
    schema_version: int
    job_id: JobId
    media_digest: FileDigest
    frame_count: int
    width: int
    height: int
    dependency_path: PurePosixPath
    dependency_digest: FileDigest
    checkpoint_id: str
    manifest_path: PurePosixPath
    manifest_digest: FileDigest
    state_snapshot_path: PurePosixPath
    state_snapshot_digest: FileDigest

    def __post_init__(self) -> None:
        _base(
            self.schema_version,
            self.job_id,
            self.media_digest,
            self.frame_count,
            self.width,
            self.height,
            self.dependency_path,
            self.dependency_digest,
            PUBLICATION_ARTIFACT_PATH,
        )
        if (
            type(self.checkpoint_id) is not str
            or not self.checkpoint_id
            or self.checkpoint_id != self.checkpoint_id.strip()
        ):
            raise DomainInvariantError("Checkpoint ID must be non-empty and trimmed")
        _artifact_path("Checkpoint manifest path", self.manifest_path)
        _digest("Checkpoint manifest digest", self.manifest_digest)
        _artifact_path("Checkpoint state snapshot path", self.state_snapshot_path)
        _digest("Checkpoint state snapshot digest", self.state_snapshot_digest)
        if self.manifest_path == self.state_snapshot_path:
            raise DomainInvariantError("Checkpoint artifact paths must be distinct")


PipelineDocument: TypeAlias = (
    MediaDocument
    | OcrDocument
    | TrackDocument
    | TranslationDocument
    | TtsDocument
    | RenderChunkPlanDocument
    | RenderPlanDocument
    | PublicationDocument
    | CheckpointDocument
)


PIPELINE_ARTIFACT_PATHS = MappingProxyType(
    {
        MediaDocument: MEDIA_ARTIFACT_PATH,
        OcrDocument: OCR_ARTIFACT_PATH,
        TrackDocument: TRACK_ARTIFACT_PATH,
        TranslationDocument: TRANSLATION_ARTIFACT_PATH,
        TtsDocument: TTS_ARTIFACT_PATH,
        RenderChunkPlanDocument: RENDER_CHUNK_PLAN_ARTIFACT_PATH,
        RenderPlanDocument: RENDER_PLAN_ARTIFACT_PATH,
        PublicationDocument: PUBLICATION_ARTIFACT_PATH,
        CheckpointDocument: CHECKPOINT_ARTIFACT_PATH,
    }
)


def _fraction_dict(value: Fraction) -> dict[str, int]:
    return {"denominator": value.denominator, "numerator": value.numerator}


def _digest_dict(value: FileDigest) -> dict[str, object]:
    return {"sha256": value.sha256, "size_bytes": value.size_bytes}


def _interval_dict(value: object) -> dict[str, int]:
    return {
        "end_frame": value.end_frame,  # type: ignore[attr-defined]
        "start_frame": value.start_frame,  # type: ignore[attr-defined]
    }


def _box_dict(value: object) -> dict[str, int]:
    return {
        "xmax": value.xmax,  # type: ignore[attr-defined]
        "xmin": value.xmin,  # type: ignore[attr-defined]
        "ymax": value.ymax,  # type: ignore[attr-defined]
        "ymin": value.ymin,  # type: ignore[attr-defined]
    }


def _cue_dict(value: Cue) -> dict[str, object]:
    return {
        "box": _box_dict(value.box),
        "cue_index": value.cue_index,
        "interval": _interval_dict(value.interval),
        "source_text": value.source_text,
        "target_text": value.target_text,
    }


def _blur_dict(value: BlurRegion) -> dict[str, object]:
    return {
        "box": _box_dict(value.box),
        "interval": _interval_dict(value.interval),
        "kind": value.kind.value,
    }


def _part_dict(value: Part) -> dict[str, object]:
    return {
        "chunk_indexes": list(value.chunk_indexes),
        "interval": _interval_dict(value.interval),
        "part_count": value.part_count,
        "part_index": value.part_index,
    }


def _render_chunk_dict(value: RenderChunk) -> dict[str, object]:
    return {
        "index": value.index,
        "interval": _interval_dict(value.interval),
    }


def _base_dict(document: object, document_type: str) -> dict[str, object]:
    return {
        "dependency_digest": _digest_dict(document.dependency_digest),  # type: ignore[attr-defined]
        "dependency_path": str(document.dependency_path),  # type: ignore[attr-defined]
        "document_type": document_type,
        "frame_count": document.frame_count,  # type: ignore[attr-defined]
        "height": document.height,  # type: ignore[attr-defined]
        "job_id": document.job_id.value,  # type: ignore[attr-defined]
        "media_digest": _digest_dict(document.media_digest),  # type: ignore[attr-defined]
        "schema_version": document.schema_version,  # type: ignore[attr-defined]
        "width": document.width,  # type: ignore[attr-defined]
    }


def _document_dict(document: object) -> dict[str, object]:
    if type(document) is MediaDocument:
        return {
            "document_type": "media",
            "duration_seconds": _fraction_dict(document.duration_seconds),
            "frame_count": document.frame_count,
            "has_audio": document.has_audio,
            "height": document.height,
            "job_id": document.job_id.value,
            "schema_version": document.schema_version,
            "source_digest": _digest_dict(document.source_digest),
            "source_fps": _fraction_dict(document.source_fps),
            "source_path": str(document.source_path),
            "target_fps": document.timeline.target_fps,
            "width": document.width,
        }
    if type(document) is OcrDocument:
        return dict(_base_dict(document, "ocr"), cues=[_cue_dict(item) for item in document.cues])
    if type(document) is TrackDocument:
        return dict(
            _base_dict(document, "track"),
            blur_regions=[_blur_dict(item) for item in document.blur_regions],
            cues=[_cue_dict(item) for item in document.cues],
        )
    if type(document) is TranslationDocument:
        return dict(
            _base_dict(document, "translation"),
            cues=[_cue_dict(item) for item in document.cues],
        )
    if type(document) is TtsDocument:
        return dict(
            _base_dict(document, "tts"),
            audio_digest=_digest_dict(document.audio_digest),
            audio_path=str(document.audio_path),
            cues=[_cue_dict(item) for item in document.cues],
        )
    if type(document) is RenderChunkPlanDocument:
        return dict(
            _base_dict(document, "render_chunk_plan"),
            chunks=[
                _render_chunk_dict(item)
                for item in document.chunks
            ],
            output_has_audio=document.output_has_audio,
            parts=[_part_dict(item) for item in document.parts],
            render_fingerprint=document.render_fingerprint.sha256,
        )
    if type(document) is RenderPlanDocument:
        return dict(
            _base_dict(document, "render_plan"),
            blur_regions=[_blur_dict(item) for item in document.blur_regions],
            cues=[_cue_dict(item) for item in document.cues],
            output_has_audio=document.output_has_audio,
            parts=[_part_dict(item) for item in document.parts],
            rendered_digest=_digest_dict(document.rendered_digest),
            rendered_path=str(document.rendered_path),
            tts_audio_digest=_digest_dict(document.tts_audio_digest),
            tts_audio_path=str(document.tts_audio_path),
        )
    if type(document) is PublicationDocument:
        return dict(
            _base_dict(document, "publication"),
            part_digests=[_digest_dict(item) for item in document.part_digests],
            part_paths=[str(item) for item in document.part_paths],
            parts=[_part_dict(item) for item in document.parts],
        )
    if type(document) is CheckpointDocument:
        return dict(
            _base_dict(document, "checkpoint"),
            checkpoint_id=document.checkpoint_id,
            manifest_digest=_digest_dict(document.manifest_digest),
            manifest_path=str(document.manifest_path),
            state_snapshot_digest=_digest_dict(document.state_snapshot_digest),
            state_snapshot_path=str(document.state_snapshot_path),
        )
    raise DomainInvariantError(
        "Canonical serialization requires an exact pipeline document type"
    )


def canonical_document_bytes(document: object) -> bytes:
    payload = _document_dict(document)
    try:
        return json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except UnicodeEncodeError as exc:
        raise DomainInvariantError("Pipeline document contains invalid Unicode") from exc


_DIGEST_FIELDS = {"sha256", "size_bytes"}
_FRACTION_FIELDS = {"denominator", "numerator"}
_INTERVAL_FIELDS = {"end_frame", "start_frame"}
_BOX_FIELDS = {"xmax", "xmin", "ymax", "ymin"}
_CUE_FIELDS = {"box", "cue_index", "interval", "source_text", "target_text"}
_BLUR_FIELDS = {"box", "interval", "kind"}
_RENDER_CHUNK_FIELDS = {"index", "interval"}
_PART_FIELDS = {"chunk_indexes", "interval", "part_count", "part_index"}
_BASE_FIELDS = {
    "dependency_digest",
    "dependency_path",
    "document_type",
    "frame_count",
    "height",
    "job_id",
    "media_digest",
    "schema_version",
    "width",
}
_MEDIA_FIELDS = {
    "document_type",
    "duration_seconds",
    "frame_count",
    "has_audio",
    "height",
    "job_id",
    "schema_version",
    "source_digest",
    "source_fps",
    "source_path",
    "target_fps",
    "width",
}


def _closed_dict(name: str, value: object, expected: set[str]) -> dict[str, object]:
    if type(value) is not dict or set(value) != expected:
        raise DomainInvariantError(f"{name} has missing or unknown fields")
    return value


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DomainInvariantError("Pipeline document JSON contains a duplicate field")
        result[key] = value
    return result


def _decode(
    raw: object, *, document_type: str, fields: set[str]
) -> tuple[bytes, dict[str, object]]:
    if type(raw) is not bytes:
        raise DomainInvariantError("Pipeline document input must be bytes")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
        )
    except DomainInvariantError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise DomainInvariantError("Pipeline document JSON is invalid") from exc
    root = _closed_dict("Pipeline document", payload, fields)
    if root["document_type"] != document_type:
        raise DomainInvariantError(f"Expected {document_type} pipeline document")
    return raw, root


def _text_path(name: str, value: object) -> PurePosixPath:
    if type(value) is not str:
        raise DomainInvariantError(f"{name} must be text")
    return PurePosixPath(value)


def _fraction_from(name: str, value: object) -> Fraction:
    item = _closed_dict(name, value, _FRACTION_FIELDS)
    numerator = item["numerator"]
    denominator = item["denominator"]
    _require_int(f"{name} numerator", numerator)
    _require_int(f"{name} denominator", denominator)
    if denominator <= 0:
        raise DomainInvariantError(f"{name} denominator must be positive")
    return Fraction(numerator, denominator)


def _digest_from(name: str, value: object) -> FileDigest:
    item = _closed_dict(name, value, _DIGEST_FIELDS)
    return FileDigest(item["size_bytes"], item["sha256"])  # type: ignore[arg-type]


def _interval_from(value: object) -> FrameInterval:
    item = _closed_dict("Frame interval", value, _INTERVAL_FIELDS)
    return FrameInterval(
        item["start_frame"],  # type: ignore[arg-type]
        item["end_frame"],  # type: ignore[arg-type]
    )


def _box_from(value: object) -> BoundingBox:
    item = _closed_dict("Bounding box", value, _BOX_FIELDS)
    return BoundingBox(
        item["xmin"],  # type: ignore[arg-type]
        item["ymin"],  # type: ignore[arg-type]
        item["xmax"],  # type: ignore[arg-type]
        item["ymax"],  # type: ignore[arg-type]
    )


def _cue_from(value: object) -> Cue:
    item = _closed_dict("Cue", value, _CUE_FIELDS)
    return Cue(
        item["cue_index"],  # type: ignore[arg-type]
        _interval_from(item["interval"]),
        _box_from(item["box"]),
        item["source_text"],  # type: ignore[arg-type]
        item["target_text"],  # type: ignore[arg-type]
    )


def _blur_from(value: object) -> BlurRegion:
    item = _closed_dict("Blur region", value, _BLUR_FIELDS)
    try:
        kind = RegionKind(item["kind"])
    except (TypeError, ValueError) as exc:
        raise DomainInvariantError("Blur region kind is unsupported") from exc
    return BlurRegion(
        kind,
        _interval_from(item["interval"]),
        _box_from(item["box"]),
    )


def _part_from(value: object) -> Part:
    item = _closed_dict("Part", value, _PART_FIELDS)
    indexes = item["chunk_indexes"]
    if type(indexes) is not list:
        raise DomainInvariantError("Part chunk indexes must be a JSON array")
    return Part(
        item["part_index"],  # type: ignore[arg-type]
        item["part_count"],  # type: ignore[arg-type]
        _interval_from(item["interval"]),
        tuple(indexes),  # type: ignore[arg-type]
    )


def _render_chunk_from(value: object) -> RenderChunk:
    item = _closed_dict("Render chunk", value, _RENDER_CHUNK_FIELDS)
    return RenderChunk(
        item["index"],  # type: ignore[arg-type]
        _interval_from(item["interval"]),
    )


def _array(name: str, value: object) -> list[object]:
    if type(value) is not list:
        raise DomainInvariantError(f"{name} must be a JSON array")
    return value


def _base_from(root: dict[str, object]) -> tuple[object, ...]:
    return (
        root["schema_version"],
        JobId(root["job_id"]),  # type: ignore[arg-type]
        _digest_from("Media digest", root["media_digest"]),
        root["frame_count"],
        root["width"],
        root["height"],
        _text_path("Dependency path", root["dependency_path"]),
        _digest_from("Dependency digest", root["dependency_digest"]),
    )


def _finish(raw: bytes, document: object) -> object:
    if canonical_document_bytes(document) != raw:
        raise DomainInvariantError("Pipeline document JSON is not canonical")
    return document


def _source_cue_identity(cue: Cue) -> tuple[object, ...]:
    return (
        cue.cue_index,
        cue.interval,
        cue.box,
        cue.source_text,
    )


def _verify_upstream(
    document: object,
    upstream: object | None,
    expected_type: type[object],
) -> None:
    if upstream is None:
        return
    if type(upstream) is not expected_type:
        raise DomainInvariantError(
            f"Pipeline dependency must be {expected_type.__name__}"
        )
    upstream_bytes = canonical_document_bytes(upstream)
    expected_digest = FileDigest(
        len(upstream_bytes), hashlib.sha256(upstream_bytes).hexdigest()
    )
    upstream_media_digest = (
        upstream.source_digest
        if type(upstream) is MediaDocument
        else upstream.media_digest  # type: ignore[attr-defined]
    )
    identity = (
        document.job_id,  # type: ignore[attr-defined]
        document.media_digest,  # type: ignore[attr-defined]
        document.frame_count,  # type: ignore[attr-defined]
        document.width,  # type: ignore[attr-defined]
        document.height,  # type: ignore[attr-defined]
    )
    upstream_identity = (
        upstream.job_id,  # type: ignore[attr-defined]
        upstream_media_digest,
        upstream.frame_count,  # type: ignore[attr-defined]
        upstream.width,  # type: ignore[attr-defined]
        upstream.height,  # type: ignore[attr-defined]
    )
    expected_path = PIPELINE_ARTIFACT_PATHS[expected_type]
    if (
        identity != upstream_identity
        or document.dependency_path != expected_path  # type: ignore[attr-defined]
        or document.dependency_digest != expected_digest  # type: ignore[attr-defined]
    ):
        raise DomainInvariantError("Pipeline document dependency identity is inconsistent")

    if type(document) is TrackDocument and document.cues != upstream.cues:  # type: ignore[attr-defined]
        raise DomainInvariantError("Track cues must match OCR cues")
    if type(document) is TranslationDocument and (
        tuple(_source_cue_identity(cue) for cue in document.cues)
        != tuple(_source_cue_identity(cue) for cue in upstream.cues)  # type: ignore[attr-defined]
    ):
        raise DomainInvariantError("Translation cues must preserve tracked cue identity")
    if type(document) is TtsDocument and document.cues != upstream.cues:  # type: ignore[attr-defined]
        raise DomainInvariantError("TTS cues must match translated cues")
    if type(document) is RenderPlanDocument and (
        document.cues != upstream.cues  # type: ignore[attr-defined]
        or document.tts_audio_path != upstream.audio_path  # type: ignore[attr-defined]
        or document.tts_audio_digest != upstream.audio_digest  # type: ignore[attr-defined]
    ):
        raise DomainInvariantError("Render plan must match TTS output")
    if type(document) is PublicationDocument and document.parts != upstream.parts:  # type: ignore[attr-defined]
        raise DomainInvariantError("Publication Parts must match the render plan")


def parse_media_document_bytes(raw: bytes) -> MediaDocument:
    try:
        encoded, root = _decode(raw, document_type="media", fields=_MEDIA_FIELDS)
        document = MediaDocument(
            root["schema_version"],  # type: ignore[arg-type]
            JobId(root["job_id"]),  # type: ignore[arg-type]
            _text_path("Media source path", root["source_path"]),
            _digest_from("Media source digest", root["source_digest"]),
            _fraction_from("Media duration", root["duration_seconds"]),
            _fraction_from("Media source FPS", root["source_fps"]),
            Timeline(root["target_fps"]),  # type: ignore[arg-type]
            root["frame_count"],  # type: ignore[arg-type]
            root["width"],  # type: ignore[arg-type]
            root["height"],  # type: ignore[arg-type]
            root["has_audio"],  # type: ignore[arg-type]
        )
        return _finish(encoded, document)  # type: ignore[return-value]
    except DomainInvariantError:
        raise
    except (TypeError, ValueError) as exc:
        raise DomainInvariantError("Media pipeline document is invalid") from exc


def parse_ocr_document_bytes(
    raw: bytes, upstream: MediaDocument | None = None
) -> OcrDocument:
    encoded, root = _decode(raw, document_type="ocr", fields=_BASE_FIELDS | {"cues"})
    document = OcrDocument(
        *_base_from(root),
        tuple(_cue_from(item) for item in _array("Cues", root["cues"])),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, MediaDocument)
    return result  # type: ignore[return-value]


def parse_track_document_bytes(
    raw: bytes, upstream: OcrDocument | None = None
) -> TrackDocument:
    encoded, root = _decode(
        raw,
        document_type="track",
        fields=_BASE_FIELDS | {"blur_regions", "cues"},
    )
    document = TrackDocument(
        *_base_from(root),
        tuple(_cue_from(item) for item in _array("Cues", root["cues"])),
        tuple(
            _blur_from(item)
            for item in _array("Blur regions", root["blur_regions"])
        ),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, OcrDocument)
    return result  # type: ignore[return-value]


def parse_translation_document_bytes(
    raw: bytes, upstream: TrackDocument | None = None
) -> TranslationDocument:
    encoded, root = _decode(
        raw,
        document_type="translation",
        fields=_BASE_FIELDS | {"cues"},
    )
    document = TranslationDocument(
        *_base_from(root),
        tuple(_cue_from(item) for item in _array("Cues", root["cues"])),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, TrackDocument)
    return result  # type: ignore[return-value]


def parse_tts_document_bytes(
    raw: bytes, upstream: TranslationDocument | None = None
) -> TtsDocument:
    encoded, root = _decode(
        raw,
        document_type="tts",
        fields=_BASE_FIELDS | {"audio_digest", "audio_path", "cues"},
    )
    document = TtsDocument(
        *_base_from(root),
        tuple(_cue_from(item) for item in _array("Cues", root["cues"])),
        _text_path("TTS audio path", root["audio_path"]),
        _digest_from("TTS audio digest", root["audio_digest"]),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, TranslationDocument)
    return result  # type: ignore[return-value]


def parse_render_chunk_plan_document_bytes(
    raw: bytes,
    upstream: TtsDocument | None = None,
) -> RenderChunkPlanDocument:
    fields = _BASE_FIELDS | {
        "chunks",
        "output_has_audio",
        "parts",
        "render_fingerprint",
    }
    encoded, root = _decode(
        raw,
        document_type="render_chunk_plan",
        fields=fields,
    )
    document = RenderChunkPlanDocument(
        *_base_from(root),
        Fingerprint(root["render_fingerprint"]),  # type: ignore[arg-type]
        tuple(
            _render_chunk_from(item)
            for item in _array("Render chunks", root["chunks"])
        ),
        tuple(_part_from(item) for item in _array("Parts", root["parts"])),
        root["output_has_audio"],  # type: ignore[arg-type]
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, TtsDocument)
    return result  # type: ignore[return-value]


def parse_render_plan_document_bytes(
    raw: bytes, upstream: TtsDocument | None = None
) -> RenderPlanDocument:
    fields = _BASE_FIELDS | {
        "blur_regions",
        "cues",
        "output_has_audio",
        "parts",
        "rendered_digest",
        "rendered_path",
        "tts_audio_digest",
        "tts_audio_path",
    }
    encoded, root = _decode(raw, document_type="render_plan", fields=fields)
    document = RenderPlanDocument(
        *_base_from(root),
        tuple(_cue_from(item) for item in _array("Cues", root["cues"])),
        tuple(
            _blur_from(item)
            for item in _array("Blur regions", root["blur_regions"])
        ),
        _text_path("Render-plan TTS audio path", root["tts_audio_path"]),
        _digest_from("Render-plan TTS audio digest", root["tts_audio_digest"]),
        tuple(_part_from(item) for item in _array("Parts", root["parts"])),
        root["output_has_audio"],  # type: ignore[arg-type]
        _text_path("Rendered media path", root["rendered_path"]),
        _digest_from("Rendered media digest", root["rendered_digest"]),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, TtsDocument)
    return result  # type: ignore[return-value]


def parse_publication_document_bytes(
    raw: bytes, upstream: RenderPlanDocument | None = None
) -> PublicationDocument:
    fields = _BASE_FIELDS | {"part_digests", "part_paths", "parts"}
    encoded, root = _decode(raw, document_type="publication", fields=fields)
    document = PublicationDocument(
        *_base_from(root),
        tuple(_part_from(item) for item in _array("Parts", root["parts"])),
        tuple(
            _text_path("Published Part path", item)
            for item in _array("Published Part paths", root["part_paths"])
        ),
        tuple(
            _digest_from("Published Part digest", item)
            for item in _array("Published Part digests", root["part_digests"])
        ),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, RenderPlanDocument)
    return result  # type: ignore[return-value]


def parse_checkpoint_document_bytes(
    raw: bytes, upstream: PublicationDocument | None = None
) -> CheckpointDocument:
    fields = _BASE_FIELDS | {
        "checkpoint_id",
        "manifest_digest",
        "manifest_path",
        "state_snapshot_digest",
        "state_snapshot_path",
    }
    encoded, root = _decode(raw, document_type="checkpoint", fields=fields)
    document = CheckpointDocument(
        *_base_from(root),
        root["checkpoint_id"],  # type: ignore[arg-type]
        _text_path("Checkpoint manifest path", root["manifest_path"]),
        _digest_from("Checkpoint manifest digest", root["manifest_digest"]),
        _text_path("Checkpoint state snapshot path", root["state_snapshot_path"]),
        _digest_from(
            "Checkpoint state snapshot digest", root["state_snapshot_digest"]
        ),
    )
    result = _finish(encoded, document)
    _verify_upstream(result, upstream, PublicationDocument)
    return result  # type: ignore[return-value]
