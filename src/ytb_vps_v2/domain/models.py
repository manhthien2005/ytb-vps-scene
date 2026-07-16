from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from fractions import Fraction
from pathlib import Path

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


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
        if not self.value or self.value != self.value.strip():
            raise DomainInvariantError("Job ID must be non-empty and trimmed")


@dataclass(frozen=True, slots=True)
class BoundingBox:
    xmin: int
    ymin: int
    xmax: int
    ymax: int

    def __post_init__(self) -> None:
        if min(self.xmin, self.ymin, self.xmax, self.ymax) < 0:
            raise DomainInvariantError("Bounding box coordinates must be non-negative")
        if self.xmax <= self.xmin or self.ymax <= self.ymin:
            raise DomainInvariantError("Bounding box must have positive area")


@dataclass(frozen=True, slots=True)
class MediaIdentity:
    duration_seconds: Fraction
    source_fps: Fraction
    timeline: Timeline
    width: int
    height: int
    has_audio: bool

    def __post_init__(self) -> None:
        if self.duration_seconds <= 0:
            raise DomainInvariantError("Media duration must be positive")
        if self.source_fps <= 0:
            raise DomainInvariantError("Source FPS must be positive")
        if self.width <= 0 or self.height <= 0:
            raise DomainInvariantError("Media dimensions must be positive")


@dataclass(frozen=True, slots=True)
class Job:
    job_id: JobId
    media: MediaIdentity
    mode: PipelineMode = PipelineMode.CUE_TRANSLATION

    def __post_init__(self) -> None:
        if not isinstance(self.mode, PipelineMode):
            raise DomainInvariantError(f"Unsupported pipeline mode: {self.mode}")


@dataclass(frozen=True, slots=True)
class Cue:
    cue_index: int
    interval: FrameInterval
    box: BoundingBox
    source_text: str
    target_text: str | None = None

    def __post_init__(self) -> None:
        if self.cue_index <= 0:
            raise DomainInvariantError("Cue index must be positive")
        if not self.source_text.strip():
            raise DomainInvariantError("Cue source text must be non-empty")


@dataclass(frozen=True, slots=True)
class BlurRegion:
    kind: RegionKind
    interval: FrameInterval
    box: BoundingBox


@dataclass(frozen=True, slots=True)
class WorkUnit:
    key: str
    stage: StageName
    status: WorkStatus = WorkStatus.PENDING
    attempts: int = 0

    def __post_init__(self) -> None:
        if not self.key or self.key != self.key.strip():
            raise DomainInvariantError("Work unit key must be non-empty and trimmed")
        if self.attempts < 0:
            raise DomainInvariantError("Work unit attempts must be non-negative")


@dataclass(frozen=True, slots=True)
class Artifact:
    name: str
    relative_path: Path
    size_bytes: int
    sha256: str
    owner: StageName
    dependencies: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.name or self.name != self.name.strip():
            raise DomainInvariantError("Artifact name must be non-empty and trimmed")
        if self.relative_path.is_absolute() or ".." in self.relative_path.parts:
            raise DomainInvariantError("Artifact path must be safe and relative")
        if self.size_bytes < 0:
            raise DomainInvariantError("Artifact size must be non-negative")
        if _SHA256.fullmatch(self.sha256) is None:
            raise DomainInvariantError("Artifact checksum must be lowercase SHA-256")
        if any(not item or item != item.strip() for item in self.dependencies):
            raise DomainInvariantError("Artifact dependencies must be non-empty and trimmed")


@dataclass(frozen=True, slots=True)
class Part:
    part_index: int
    part_count: int
    interval: FrameInterval
    chunk_indexes: tuple[int, ...]

    def __post_init__(self) -> None:
        if self.part_count <= 0 or not 1 <= self.part_index <= self.part_count:
            raise DomainInvariantError("Part index must be within its Part count")
        if not self.chunk_indexes:
            raise DomainInvariantError("Part must contain at least one render chunk")
        if any(index < 0 for index in self.chunk_indexes):
            raise DomainInvariantError("Render chunk indexes must be non-negative")
        if tuple(sorted(set(self.chunk_indexes))) != self.chunk_indexes:
            raise DomainInvariantError("Render chunk indexes must be ordered and unique")
