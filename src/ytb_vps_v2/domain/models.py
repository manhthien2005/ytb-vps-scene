from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath, PureWindowsPath

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import FrameInterval


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _require_int(name: str, value: object, *, minimum: int | None = None) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DomainInvariantError(f"{name} must be an integer")
    if minimum is not None and value < minimum:
        raise DomainInvariantError(f"{name} must be at least {minimum}")


def _require_type(name: str, value: object, expected: type[object]) -> None:
    if not isinstance(value, expected):
        raise DomainInvariantError(f"{name} must be {expected.__name__}")


def _validate_artifact_path(value: object) -> None:
    if type(value) is not PurePosixPath:
        raise DomainInvariantError("Artifact path must use portable POSIX format")
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
        raise DomainInvariantError("Artifact path must be safe and relative")


class StageName(str, Enum):
    INGEST = "INGEST"
    OCR = "OCR"
    TRACK = "TRACK"
    TRANSLATE = "TRANSLATE"
    TTS = "TTS"
    RENDER = "RENDER"
    PUBLISH = "PUBLISH"
    BACKUP = "BACKUP"


class WorkStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    INVALID = "INVALID"


class RegionKind(str, Enum):
    DYNAMIC = "dynamic_blur"
    STATIC = "static_blur"


class PipelineMode(str, Enum):
    CUE_TRANSLATION = "cue_translation"


@dataclass(frozen=True, slots=True)
class JobId:
    value: str

    def __post_init__(self) -> None:
        _require_type("Job ID", self.value, str)
        if not self.value or self.value != self.value.strip():
            raise DomainInvariantError("Job ID must be non-empty and trimmed")


@dataclass(frozen=True, slots=True)
class BoundingBox:
    xmin: int
    ymin: int
    xmax: int
    ymax: int

    def __post_init__(self) -> None:
        for name, value in (
            ("Bounding box xmin", self.xmin),
            ("Bounding box ymin", self.ymin),
            ("Bounding box xmax", self.xmax),
            ("Bounding box ymax", self.ymax),
        ):
            _require_int(name, value, minimum=0)
        if self.xmax <= self.xmin or self.ymax <= self.ymin:
            raise DomainInvariantError("Bounding box must have positive area")


@dataclass(frozen=True, slots=True)
class Cue:
    cue_index: int
    interval: FrameInterval
    box: BoundingBox
    source_text: str
    target_text: str | None = None

    def __post_init__(self) -> None:
        _require_int("Cue index", self.cue_index, minimum=1)
        _require_type("Cue interval", self.interval, FrameInterval)
        _require_type("Cue bounding box", self.box, BoundingBox)
        _require_type("Cue source text", self.source_text, str)
        if self.target_text is not None:
            _require_type("Cue target text", self.target_text, str)
        if not self.source_text.strip():
            raise DomainInvariantError("Cue source text must be non-empty")


@dataclass(frozen=True, slots=True)
class BlurRegion:
    kind: RegionKind
    interval: FrameInterval
    box: BoundingBox

    def __post_init__(self) -> None:
        _require_type("Blur region kind", self.kind, RegionKind)
        _require_type("Blur region interval", self.interval, FrameInterval)
        _require_type("Blur region bounding box", self.box, BoundingBox)


@dataclass(frozen=True, slots=True)
class WorkUnit:
    key: str
    stage: StageName
    status: WorkStatus = WorkStatus.PENDING
    attempts: int = 0
    dependencies: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_type("Work unit key", self.key, str)
        _require_type("Work unit stage", self.stage, StageName)
        _require_type("Work unit status", self.status, WorkStatus)
        _require_int("Work unit attempts", self.attempts, minimum=0)
        if not self.key or self.key != self.key.strip():
            raise DomainInvariantError("Work unit key must be non-empty and trimmed")
        if len(self.key) > 512:
            raise DomainInvariantError("Work unit key must be at most 512 characters")
        if type(self.dependencies) is not tuple:
            raise DomainInvariantError("Work unit dependencies must be a tuple")
        if any(
            type(item) is not str
            or not item
            or item != item.strip()
            or len(item) > 512
            for item in self.dependencies
        ):
            raise DomainInvariantError(
                "Work unit dependencies must be non-empty trimmed keys"
            )
        if tuple(sorted(set(self.dependencies))) != self.dependencies:
            raise DomainInvariantError(
                "Work unit dependencies must be ordered and unique"
            )
        if self.key in self.dependencies:
            raise DomainInvariantError("Work unit cannot depend on itself")


@dataclass(frozen=True, slots=True)
class Artifact:
    name: str
    relative_path: PurePosixPath
    size_bytes: int
    sha256: str
    owner: StageName
    dependencies: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_type("Artifact name", self.name, str)
        if not self.name or self.name != self.name.strip():
            raise DomainInvariantError("Artifact name must be non-empty and trimmed")
        _validate_artifact_path(self.relative_path)
        _require_int("Artifact size", self.size_bytes, minimum=0)
        _require_type("Artifact checksum", self.sha256, str)
        _require_type("Artifact owner", self.owner, StageName)
        _require_type("Artifact dependencies", self.dependencies, tuple)
        if _SHA256.fullmatch(self.sha256) is None:
            raise DomainInvariantError("Artifact checksum must be lowercase SHA-256")
        if any(
            not isinstance(item, str) or not item or item != item.strip()
            for item in self.dependencies
        ):
            raise DomainInvariantError("Artifact dependencies must be non-empty and trimmed")


@dataclass(frozen=True, slots=True)
class Part:
    part_index: int
    part_count: int
    interval: FrameInterval
    chunk_indexes: tuple[int, ...]

    def __post_init__(self) -> None:
        _require_int("Part index", self.part_index, minimum=1)
        _require_int("Part count", self.part_count, minimum=1)
        _require_type("Part interval", self.interval, FrameInterval)
        _require_type("Render chunk indexes", self.chunk_indexes, tuple)
        for index in self.chunk_indexes:
            _require_int("Render chunk index", index, minimum=0)
        if not 1 <= self.part_index <= self.part_count:
            raise DomainInvariantError("Part index must be within its Part count")
        if not self.chunk_indexes:
            raise DomainInvariantError("Part must contain at least one render chunk")
        if tuple(sorted(set(self.chunk_indexes))) != self.chunk_indexes:
            raise DomainInvariantError("Render chunk indexes must be ordered and unique")


@dataclass(frozen=True, slots=True)
class RenderChunk:
    index: int
    interval: FrameInterval

    def __post_init__(self) -> None:
        _require_int("Render chunk index", self.index, minimum=0)
        if type(self.interval) is not FrameInterval:
            raise DomainInvariantError("Render chunk interval must be FrameInterval")
