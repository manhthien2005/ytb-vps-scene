# Phase 2 Canonical Timeline and Domain Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pure v2 canonical 30 FPS timeline and immutable domain models that reject invalid frames, boxes, work units, artifacts, and publish Parts.

**Architecture:** Keep the phase entirely inside the pure `domain` package with no filesystem, database, subprocess, network, clock, provider, or legacy imports. Use exact `fractions.Fraction` arithmetic for time conversion, half-open frame intervals, and dataclass invariants enforced at construction.

**Tech Stack:** Python 3.10–3.12 standard library (`dataclasses`, `decimal`, `enum`, `fractions`, `pathlib`, `re`, `unittest`).

## Global Constraints

- Work directly on `rebuild/v2`; do not create or switch product branches.
- Canonical FPS comes from `media.target_fps` and defaults to integer 30.
- All frame intervals are half-open `[start_frame, end_frame)`.
- Start conversion uses floor; end conversion uses ceiling; accepted intervals are clamped to total frames and never empty.
- Source FPS is metadata used only to map source-frame observations into the canonical timeline.
- Publish Part count is `max(1, ceil(duration_seconds / 1800))`.
- `src/ytb_vps_v2/domain/` must not import legacy, adapters, filesystem services, databases, subprocesses, networks, or wall-clock APIs.
- Support Python `>=3.10,<3.13`; do not use `StrEnum` or Python 3.11-only syntax.
- Apply TDD and one-purpose Conventional Commits; do not push.

## File map

- `src/ytb_vps_v2/domain/__init__.py`: stable exports for approved Phase 2 types and functions.
- `src/ytb_vps_v2/domain/errors.py`: shared invariant exception.
- `src/ytb_vps_v2/domain/timeline.py`: exact seconds conversion, half-open intervals, source-rate normalization.
- `src/ytb_vps_v2/domain/models.py`: immutable typed jobs, media, boxes, cues, regions, work units, and artifacts.
- `src/ytb_vps_v2/domain/parts.py`: 30-minute target Part count.
- `tests_v2/domain/__init__.py`: isolated domain test package.
- `tests_v2/domain/test_timeline.py`: rounding, clamp, invalid interval, and 24/25/29.97/30 FPS tests.
- `tests_v2/domain/test_models.py`: constructor invariant tests.
- `tests_v2/domain/test_parts.py`: Part ceiling rule tests.
- `docs/rebuild/AUDIT-LOG.md`: Phase 2 evidence and commit hashes.

---

### Task 1: Exact canonical timeline

**Files:**
- Create: `src/ytb_vps_v2/domain/errors.py`
- Create: `src/ytb_vps_v2/domain/timeline.py`
- Create: `tests_v2/domain/__init__.py`
- Create: `tests_v2/domain/test_timeline.py`

**Interfaces:**
- Consumes: Python numeric values representing seconds and source FPS.
- Produces: `DomainInvariantError`; `Seconds`; `to_fraction(value) -> Fraction`; `FrameInterval(start_frame: int, end_frame: int)`; `Timeline(target_fps: int = 30)`; `Timeline.total_frames(duration_seconds) -> int`; `Timeline.interval(start_seconds, end_seconds, duration_seconds) -> FrameInterval`; `Timeline.normalize_source_interval(start_source_frame, end_source_frame, source_fps, duration_seconds) -> FrameInterval`.

- [ ] **Step 1: Write failing timeline tests**

Create empty `tests_v2/domain/__init__.py` and create
`tests_v2/domain/test_timeline.py`:

```python
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


class TimelineTests(unittest.TestCase):
    def test_default_timeline_uses_floor_start_and_ceil_end(self) -> None:
        timeline = Timeline()

        interval = timeline.interval(
            Fraction(1, 100),
            Fraction(101, 100),
            Fraction(2),
        )

        self.assertEqual(timeline.target_fps, 30)
        self.assertEqual(interval, FrameInterval(start_frame=0, end_frame=31))
        self.assertTrue(interval.contains(0))
        self.assertFalse(interval.contains(31))

    def test_interval_clamps_end_to_total_frames(self) -> None:
        timeline = Timeline()

        interval = timeline.interval(9.9, 10.5, 10)

        self.assertEqual(timeline.total_frames(10), 300)
        self.assertEqual(interval, FrameInterval(start_frame=297, end_frame=300))

    def test_invalid_or_empty_intervals_are_rejected(self) -> None:
        timeline = Timeline()

        invalid = (
            (-0.1, 1, 10),
            (1, 1, 10),
            (2, 1, 10),
            (10, 11, 10),
        )
        for start, end, duration in invalid:
            with self.subTest(start=start, end=end, duration=duration):
                with self.assertRaises(DomainInvariantError):
                    timeline.interval(start, end, duration)

    def test_source_fps_fixtures_reach_the_canonical_timeline_end(self) -> None:
        timeline = Timeline()
        duration = Fraction(10)
        source_rates = (
            Fraction(24),
            Fraction(25),
            Fraction(30_000, 1_001),
            Fraction(30),
        )

        for source_fps in source_rates:
            source_frame_count = -(-(duration * source_fps).numerator // (duration * source_fps).denominator)
            with self.subTest(source_fps=source_fps):
                interval = timeline.normalize_source_interval(
                    source_frame_count - 1,
                    source_frame_count,
                    source_fps,
                    duration,
                )
                self.assertLess(interval.start_frame, interval.end_frame)
                self.assertEqual(interval.end_frame, 300)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run timeline tests and observe missing domain modules**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_timeline -v
```

Expected: import error because `ytb_vps_v2.domain` does not exist.

- [ ] **Step 3: Implement the invariant exception**

Create `src/ytb_vps_v2/domain/errors.py`:

```python
class DomainInvariantError(ValueError):
    """Raised when a value cannot represent a valid v2 domain object."""
```

- [ ] **Step 4: Implement exact timeline conversion**

Create `src/ytb_vps_v2/domain/timeline.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError


Seconds = int | float | str | Decimal | Fraction


def to_fraction(value: Seconds) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, Decimal):
        return Fraction(value)
    if isinstance(value, float):
        return Fraction(str(value))
    try:
        return Fraction(value)
    except (TypeError, ValueError, ZeroDivisionError) as exc:
        raise DomainInvariantError(f"Invalid rational value: {value!r}") from exc


def _floor(value: Fraction) -> int:
    return value.numerator // value.denominator


def _ceil(value: Fraction) -> int:
    return -(-value.numerator // value.denominator)


@dataclass(frozen=True, slots=True)
class FrameInterval:
    start_frame: int
    end_frame: int

    def __post_init__(self) -> None:
        if self.start_frame < 0:
            raise DomainInvariantError("Frame interval start must be non-negative")
        if self.end_frame <= self.start_frame:
            raise DomainInvariantError("Frame interval must be non-empty")

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame

    def contains(self, frame_index: int) -> bool:
        return self.start_frame <= frame_index < self.end_frame


@dataclass(frozen=True, slots=True)
class Timeline:
    target_fps: int = 30

    def __post_init__(self) -> None:
        if isinstance(self.target_fps, bool) or not isinstance(self.target_fps, int):
            raise DomainInvariantError("Target FPS must be an integer")
        if self.target_fps <= 0:
            raise DomainInvariantError("Target FPS must be positive")

    def total_frames(self, duration_seconds: Seconds) -> int:
        duration = to_fraction(duration_seconds)
        if duration <= 0:
            raise DomainInvariantError("Media duration must be positive")
        return _ceil(duration * self.target_fps)

    def interval(
        self,
        start_seconds: Seconds,
        end_seconds: Seconds,
        duration_seconds: Seconds,
    ) -> FrameInterval:
        start = to_fraction(start_seconds)
        end = to_fraction(end_seconds)
        duration = to_fraction(duration_seconds)
        if duration <= 0:
            raise DomainInvariantError("Media duration must be positive")
        if start < 0 or start >= duration:
            raise DomainInvariantError("Interval start is outside media duration")
        if end <= start:
            raise DomainInvariantError("Interval end must be after its start")

        total = self.total_frames(duration)
        start_frame = min(total - 1, _floor(start * self.target_fps))
        end_frame = min(total, _ceil(min(end, duration) * self.target_fps))
        return FrameInterval(start_frame=start_frame, end_frame=end_frame)

    def normalize_source_interval(
        self,
        start_source_frame: int,
        end_source_frame: int,
        source_fps: Seconds,
        duration_seconds: Seconds,
    ) -> FrameInterval:
        if start_source_frame < 0 or end_source_frame <= start_source_frame:
            raise DomainInvariantError("Source frame interval must be non-empty")
        source_rate = to_fraction(source_fps)
        if source_rate <= 0:
            raise DomainInvariantError("Source FPS must be positive")
        return self.interval(
            Fraction(start_source_frame, 1) / source_rate,
            Fraction(end_source_frame, 1) / source_rate,
            duration_seconds,
        )
```

- [ ] **Step 5: Run timeline tests and v2 regression suite**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_timeline -v
python -m unittest discover -s tests_v2 -t . -v
```

Expected: 4 focused timeline tests pass and 10 total v2 tests pass.

- [ ] **Step 6: Review and commit Task 1**

```powershell
git diff --check
git diff -- src/ytb_vps_v2/domain/errors.py src/ytb_vps_v2/domain/timeline.py tests_v2/domain
git add -- src/ytb_vps_v2/domain/errors.py src/ytb_vps_v2/domain/timeline.py tests_v2/domain/__init__.py tests_v2/domain/test_timeline.py
git diff --cached --name-status
git commit -m "feat(v2): add canonical timeline"
```

### Task 2: Immutable invariant domain models

**Files:**
- Create: `src/ytb_vps_v2/domain/models.py`
- Create: `tests_v2/domain/test_models.py`

**Interfaces:**
- Consumes: `DomainInvariantError`, `FrameInterval`, and `Timeline`.
- Produces: `StageName`, `WorkStatus`, `RegionKind`, `PipelineMode`, `JobId`, `BoundingBox`, `MediaIdentity`, `Job`, `Cue`, `BlurRegion`, `WorkUnit`, `Artifact`, and `Part`.

- [ ] **Step 1: Write failing domain model tests**

Create `tests_v2/domain/test_models.py`:

```python
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
```

- [ ] **Step 2: Run tests and observe the missing models module**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_models -v
```

Expected: import error because `ytb_vps_v2.domain.models` does not exist.

- [ ] **Step 3: Implement immutable models and invariants**

Create `src/ytb_vps_v2/domain/models.py`:

```python
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
```

- [ ] **Step 4: Run model tests and v2 regression suite**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_models -v
python -m unittest discover -s tests_v2 -t . -v
```

Expected: 6 focused model tests pass and 16 total v2 tests pass.

- [ ] **Step 5: Review and commit Task 2**

```powershell
git diff --check
git diff -- src/ytb_vps_v2/domain/models.py tests_v2/domain/test_models.py
git add -- src/ytb_vps_v2/domain/models.py tests_v2/domain/test_models.py
git diff --cached --name-status
git commit -m "feat(v2): add invariant domain models"
```

### Task 3: Thirty-minute Part count and stable domain exports

**Files:**
- Create: `src/ytb_vps_v2/domain/parts.py`
- Create: `src/ytb_vps_v2/domain/__init__.py`
- Create: `tests_v2/domain/test_parts.py`

**Interfaces:**
- Consumes: `Seconds`, `to_fraction`, and `DomainInvariantError`.
- Produces: `MAX_PART_SECONDS = 1800`; `target_part_count(duration_seconds: Seconds) -> int`; stable imports from `ytb_vps_v2.domain` for every approved Phase 2 symbol.

- [ ] **Step 1: Write failing Part and export tests**

Create `tests_v2/domain/test_parts.py`:

```python
from __future__ import annotations

import unittest
from fractions import Fraction

from ytb_vps_v2.domain import FrameInterval, Timeline, target_part_count
from ytb_vps_v2.domain.errors import DomainInvariantError


class PartPlanningTests(unittest.TestCase):
    def test_part_count_uses_ceiling_at_thirty_minute_boundary(self) -> None:
        cases = (
            (Fraction(1), 1),
            (Fraction(1_800), 1),
            (Fraction(1_800_001, 1_000), 2),
            (Fraction(3_600), 2),
            (Fraction(3_600_001, 1_000), 3),
        )
        for duration, expected in cases:
            with self.subTest(duration=duration):
                self.assertEqual(target_part_count(duration), expected)

    def test_non_positive_duration_is_rejected(self) -> None:
        for duration in (0, -1):
            with self.subTest(duration=duration):
                with self.assertRaises(DomainInvariantError):
                    target_part_count(duration)

    def test_domain_exports_timeline_types(self) -> None:
        self.assertEqual(Timeline().target_fps, 30)
        self.assertEqual(FrameInterval(0, 1).frame_count, 1)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests and observe missing Part/export interfaces**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_parts -v
```

Expected: import error because `target_part_count` and stable domain exports do not exist.

- [ ] **Step 3: Implement the ceiling rule**

Create `src/ytb_vps_v2/domain/parts.py`:

```python
from __future__ import annotations

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.timeline import Seconds, to_fraction


MAX_PART_SECONDS = 30 * 60


def target_part_count(duration_seconds: Seconds) -> int:
    duration = to_fraction(duration_seconds)
    if duration <= 0:
        raise DomainInvariantError("Media duration must be positive")
    ratio = duration / MAX_PART_SECONDS
    return max(1, -(-ratio.numerator // ratio.denominator))
```

- [ ] **Step 4: Publish stable domain exports**

Create `src/ytb_vps_v2/domain/__init__.py`:

```python
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
from ytb_vps_v2.domain.parts import MAX_PART_SECONDS, target_part_count
from ytb_vps_v2.domain.timeline import FrameInterval, Seconds, Timeline, to_fraction


__all__ = [
    "Artifact",
    "BlurRegion",
    "BoundingBox",
    "Cue",
    "DomainInvariantError",
    "FrameInterval",
    "Job",
    "JobId",
    "MAX_PART_SECONDS",
    "MediaIdentity",
    "Part",
    "PipelineMode",
    "RegionKind",
    "Seconds",
    "StageName",
    "Timeline",
    "WorkStatus",
    "WorkUnit",
    "target_part_count",
    "to_fraction",
]
```

- [ ] **Step 5: Run focused, full, compile, and independence gates**

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.domain.test_parts -v
python -m unittest discover -s tests_v2 -t . -v
python -m compileall -q src tests_v2
rg -n '(^|\s)(from|import)\s+ytb_vps(\s|\.|$)' src/ytb_vps_v2
```

Expected: 3 focused Part tests and 19 total v2 tests pass; compile passes; `rg` exits 1 with no legacy imports.

- [ ] **Step 6: Review and commit Task 3**

```powershell
git diff --check
git diff -- src/ytb_vps_v2/domain/__init__.py src/ytb_vps_v2/domain/parts.py tests_v2/domain/test_parts.py
git add -- src/ytb_vps_v2/domain/__init__.py src/ytb_vps_v2/domain/parts.py tests_v2/domain/test_parts.py
git diff --cached --name-status
git commit -m "feat(v2): enforce thirty minute part count"
```

### Task 4: Phase 2 verification, review, and audit

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`

**Interfaces:**
- Consumes: Task 1–3 implementation commits and Phase 2 test evidence.
- Produces: an append-only Phase 2 audit entry with actual hashes, reviewer findings, remaining risks, and Phase 3 handoff.

- [ ] **Step 1: Run fresh Phase 2 verification**

```powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
python -c "from fractions import Fraction; from ytb_vps_v2.domain import Timeline, target_part_count; assert Timeline().normalize_source_interval(299, 300, Fraction(30000, 1001), 10).end_frame == 300; assert target_part_count(Fraction(1800001, 1000)) == 2"
```

Expected: compile passes, all 19 v2 tests pass, and the direct invariant assertion exits zero.

- [ ] **Step 2: Request independent review of the Phase 2 commit range**

Use `superpowers:requesting-code-review` with the commit before Task 1 as the base and the Task 3 commit as the head. Resolve every Critical and Important finding before audit.

- [ ] **Step 3: Capture hashes, time, and worktree state**

```powershell
git log -3 --format='%H %s'
Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
git status --short --branch
```

Expected: three Phase 2 implementation commits and a clean worktree.

- [ ] **Step 4: Append and commit the Phase 2 audit entry**

Use `apply_patch` to append the objective, timeline/domain invariants, complete changed-file list, exact tests/gates, result, actual full implementation hashes, reviewer result, remaining risk, and Phase 3 typed-config/invalidation next step to `docs/rebuild/AUDIT-LOG.md`. Then run:

```powershell
git diff --check
git diff -- docs/rebuild/AUDIT-LOG.md
git add -- docs/rebuild/AUDIT-LOG.md
git diff --cached --name-status
git commit -m "docs(rebuild): audit timeline domain phase"
git status --short --branch
```

Expected: audit commit succeeds and worktree is clean.
