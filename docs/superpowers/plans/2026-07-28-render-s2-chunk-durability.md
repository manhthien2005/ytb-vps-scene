# Render S2 Chunk Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render long videos as independently durable chunks, resume or restore without repeating successful chunks, and invalidate render output correctly when scene inputs change.

**Architecture:** Add a canonical chunk plan and dependency-aware work units, render and validate one local-timeline FFmpeg chunk at a time, checkpoint each committed chunk using deduplicated manifest-v2 object keys, then concatenate the verified chunks into the existing single-Part output. Keep S2 inside Python v2; S3 owns multipart and control-plane changes.

**Tech Stack:** Python 3.10-3.12, frozen dataclasses, SQLite WAL/schema migrations, FFmpeg/ffprobe, stdlib JSON/hashlib/pathlib, pytest/unittest.

## Global Constraints

- Do not modify `web/`, legacy `app/ytb_vps/`, or control-plane contracts.
- Keep one output Part in S2: `Part(1, 1, [0, frame_count), all_chunk_indexes)`.
- Every frame interval is half-open on the canonical target-FPS timeline.
- Start conversions floor; end conversions ceil; chunk intervals exactly tile the media.
- Use real chunk files and real work-unit commits; synthetic progress is forbidden.
- Preserve checkpoint-manifest v1 parsing and restore.
- New checkpoint publications use manifest v2 and immutable stable object keys.
- Never overwrite a committed artifact in place.
- Work-unit success and artifact rows commit in one SQLite transaction.
- Scene-only changes preserve OCR, TRACK, TRANSLATE, and TTS artifacts.
- Missing/corrupt one chunk preserves successful sibling chunks.
- Check disk space before every chunk and before concatenation.
- Cleanup remains disabled and S2 does not delete committed chunks early.
- Every code task follows RED → GREEN → relevant regression tests → scoped commit.
- Never stage unrelated dirty files; every `git add` command names exact paths.

---

### Task 1: Canonical render-chunk domain and plan document

**Files:**
- Create: `src/ytb_vps_v2/domain/render_chunks.py`
- Modify: `src/ytb_vps_v2/domain/models.py`
- Modify: `src/ytb_vps_v2/domain/pipeline.py`
- Modify: `src/ytb_vps_v2/domain/__init__.py`
- Create: `tests_v2/domain/test_render_chunks.py`
- Modify: `tests_v2/domain/test_pipeline.py`

**Interfaces:**
- Consumes: `FrameInterval`, `Cue`, `Part`, `TtsDocument`, canonical pipeline serialization helpers.
- Produces:
  - `RenderChunk(index: int, interval: FrameInterval)`
  - `plan_render_chunks(*, frame_count: int, target_fps: int, chunk_seconds: int, cues: tuple[Cue, ...]) -> tuple[RenderChunk, ...]`
  - `single_part_for_chunks(frame_count: int, chunks: tuple[RenderChunk, ...]) -> Part`
  - `RenderChunkPlanDocument`
  - `RENDER_CHUNK_PLAN_ARTIFACT_PATH`
  - `parse_render_chunk_plan_document_bytes(raw: bytes, upstream: TtsDocument | None = None) -> RenderChunkPlanDocument`

- [ ] **Step 1: Write failing planner tests**

Create `tests_v2/domain/test_render_chunks.py`:

```python
from __future__ import annotations

import unittest

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox, Cue, RenderChunk
from ytb_vps_v2.domain.render_chunks import (
    plan_render_chunks,
    single_part_for_chunks,
)
from ytb_vps_v2.domain.timeline import FrameInterval


def cue(index: int, start: int, end: int) -> Cue:
    return Cue(
        index,
        FrameInterval(start, end),
        BoundingBox(0, 80, 320, 120),
        f"source-{index}",
        f"target-{index}",
    )


class RenderChunkPlanningTests(unittest.TestCase):
    def test_exact_boundaries_and_short_tail_tile_the_media(self) -> None:
        chunks = plan_render_chunks(
            frame_count=751,
            target_fps=30,
            chunk_seconds=10,
            cues=(),
        )
        self.assertEqual(
            chunks,
            (
                RenderChunk(0, FrameInterval(0, 300)),
                RenderChunk(1, FrameInterval(300, 600)),
                RenderChunk(2, FrameInterval(600, 751)),
            ),
        )

    def test_boundary_moves_forward_until_it_splits_no_cue(self) -> None:
        chunks = plan_render_chunks(
            frame_count=900,
            target_fps=30,
            chunk_seconds=10,
            cues=(cue(1, 280, 330), cue(2, 320, 380)),
        )
        self.assertEqual(chunks[0].interval, FrameInterval(0, 380))
        self.assertEqual(chunks[1].interval, FrameInterval(380, 680))
        self.assertEqual(chunks[2].interval, FrameInterval(680, 900))

    def test_one_long_cue_creates_one_larger_chunk(self) -> None:
        chunks = plan_render_chunks(
            frame_count=1_200,
            target_fps=30,
            chunk_seconds=10,
            cues=(cue(1, 100, 850),),
        )
        self.assertEqual(chunks[0], RenderChunk(0, FrameInterval(0, 850)))
        self.assertEqual(chunks[1], RenderChunk(1, FrameInterval(850, 1_150)))
        self.assertEqual(chunks[2], RenderChunk(2, FrameInterval(1_150, 1_200)))

    def test_single_part_contains_every_chunk_index(self) -> None:
        chunks = plan_render_chunks(
            frame_count=601,
            target_fps=30,
            chunk_seconds=10,
            cues=(),
        )
        part = single_part_for_chunks(601, chunks)
        self.assertEqual(part.interval, FrameInterval(0, 601))
        self.assertEqual(part.chunk_indexes, (0, 1, 2))

    def test_invalid_exact_types_and_cue_bounds_fail(self) -> None:
        calls = (
            lambda: plan_render_chunks(
                frame_count=True,
                target_fps=30,
                chunk_seconds=10,
                cues=(),
            ),
            lambda: plan_render_chunks(
                frame_count=300,
                target_fps=0,
                chunk_seconds=10,
                cues=(),
            ),
            lambda: plan_render_chunks(
                frame_count=300,
                target_fps=30,
                chunk_seconds=10,
                cues=(cue(1, 250, 301),),
            ),
        )
        for call in calls:
            with self.subTest(call=call):
                with self.assertRaises(DomainInvariantError):
                    call()
```

- [ ] **Step 2: Run the planner tests to verify RED**

Run:

```powershell
python -m pytest tests_v2/domain/test_render_chunks.py -v
```

Expected: collection fails because `RenderChunk` and `domain.render_chunks` do not exist.

- [ ] **Step 3: Implement the domain value and planner**

Add to `domain/models.py`:

```python
@dataclass(frozen=True, slots=True)
class RenderChunk:
    index: int
    interval: FrameInterval

    def __post_init__(self) -> None:
        _require_int("Render chunk index", self.index, minimum=0)
        if type(self.interval) is not FrameInterval:
            raise DomainInvariantError("Render chunk interval must be FrameInterval")
```

Create `domain/render_chunks.py`:

```python
from __future__ import annotations

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Cue, Part, RenderChunk
from ytb_vps_v2.domain.timeline import FrameInterval


def _exact_positive(name: str, value: object) -> int:
    if type(value) is not int or value < 1:
        raise DomainInvariantError(f"{name} must be a positive integer")
    return value


def plan_render_chunks(
    *,
    frame_count: int,
    target_fps: int,
    chunk_seconds: int,
    cues: tuple[Cue, ...],
) -> tuple[RenderChunk, ...]:
    total = _exact_positive("Frame count", frame_count)
    fps = _exact_positive("Target FPS", target_fps)
    seconds = _exact_positive("Chunk seconds", chunk_seconds)
    if type(cues) is not tuple or any(type(item) is not Cue for item in cues):
        raise DomainInvariantError("Chunk-planning cues must be a Cue tuple")
    if any(item.interval.end_frame > total for item in cues):
        raise DomainInvariantError("Chunk-planning cue exceeds the media")

    target = fps * seconds
    result: list[RenderChunk] = []
    start = 0
    while start < total:
        end = min(total, start + target)
        if end < total:
            while True:
                extended = max(
                    (
                        item.interval.end_frame
                        for item in cues
                        if item.interval.start_frame < end < item.interval.end_frame
                    ),
                    default=end,
                )
                if extended == end:
                    break
                end = min(total, extended)
        result.append(RenderChunk(len(result), FrameInterval(start, end)))
        start = end
    return tuple(result)


def single_part_for_chunks(
    frame_count: int,
    chunks: tuple[RenderChunk, ...],
) -> Part:
    total = _exact_positive("Frame count", frame_count)
    if type(chunks) is not tuple or not chunks:
        raise DomainInvariantError("Part planning needs render chunks")
    expected_start = 0
    for index, chunk in enumerate(chunks):
        if (
            type(chunk) is not RenderChunk
            or chunk.index != index
            or chunk.interval.start_frame != expected_start
        ):
            raise DomainInvariantError("Render chunks must be ordered and contiguous")
        expected_start = chunk.interval.end_frame
    if expected_start != total:
        raise DomainInvariantError("Render chunks must cover every media frame")
    return Part(1, 1, FrameInterval(0, total), tuple(item.index for item in chunks))
```

- [ ] **Step 4: Add failing canonical document tests**

In `tests_v2/domain/test_pipeline.py`, add a fixture and tests that construct:

```python
RenderChunkPlanDocument(
    SCHEMA_VERSION,
    JOB_ID,
    DIGEST,
    601,
    320,
    180,
    TTS_ARTIFACT_PATH,
    tts_document_digest,
    Fingerprint("c" * 64),
    (
        RenderChunk(0, FrameInterval(0, 300)),
        RenderChunk(1, FrameInterval(300, 600)),
        RenderChunk(2, FrameInterval(600, 601)),
    ),
    (Part(1, 1, FrameInterval(0, 601), (0, 1, 2)),),
    True,
)
```

Assert:

```python
raw = canonical_document_bytes(document)
self.assertEqual(parse_render_chunk_plan_document_bytes(raw, tts), document)
self.assertEqual(canonical_document_bytes(parse_render_chunk_plan_document_bytes(raw)), raw)
```

Also mutate JSON to prove unknown fields, duplicate fields, non-contiguous chunks,
wrong dependency digest, missing indexes, and a Part/chunk mismatch fail with
`DomainInvariantError`.

- [ ] **Step 5: Implement `RenderChunkPlanDocument` serialization**

In `domain/pipeline.py`:

```python
RENDER_CHUNK_PLAN_ARTIFACT_PATH = PurePosixPath(
    "artifacts/render/chunk-plan.json"
)


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
            raise DomainInvariantError("Chunk plan Part must cover every render chunk")
        _require_exact("Chunk-plan audio flag", self.output_has_audio, bool)
```

Extend the canonical encoder with exact `render_fingerprint`, `chunks`, `parts`,
and `output_has_audio` fields. Add `_render_chunk_from`, reject non-canonical JSON,
and verify the upstream TTS dependency with `_verify_upstream`. Add the new
document to `PipelineDocument`, `PIPELINE_ARTIFACT_PATHS`, and every exact-type
dispatch used by `canonical_document_bytes`; it is an auxiliary RENDER
document, not a new `StageName`.

- [ ] **Step 6: Run domain tests**

Run:

```powershell
python -m pytest tests_v2/domain/test_render_chunks.py tests_v2/domain/test_pipeline.py -q
```

Expected: all pass.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- src/ytb_vps_v2/domain/render_chunks.py src/ytb_vps_v2/domain/models.py src/ytb_vps_v2/domain/pipeline.py src/ytb_vps_v2/domain/__init__.py tests_v2/domain/test_render_chunks.py tests_v2/domain/test_pipeline.py
git commit -m "feat(render): define canonical render chunk plans"
```

---

### Task 2: Typed work-unit dependency graph

**Files:**
- Modify: `src/ytb_vps_v2/domain/models.py`
- Modify: `src/ytb_vps_v2/ports/state.py`
- Modify: `tests_v2/domain/test_models.py`

**Interfaces:**
- Consumes: existing `WorkUnit`, `Artifact`, `StateRepository`.
- Produces:
  - `WorkUnit.dependencies: tuple[str, ...] = ()`
  - `StateRepository.work_units(job_id) -> tuple[WorkUnit, ...]`
  - `StateRepository.artifacts_for_unit(job_id, unit_key) -> tuple[Artifact, ...]`
  - `StateRepository.invalidate_work_units(job_id, unit_keys, at) -> tuple[str, ...]`

- [ ] **Step 1: Write failing WorkUnit invariant tests**

Add to `tests_v2/domain/test_models.py`:

```python
def test_work_unit_dependencies_are_typed_ordered_and_do_not_self_reference(self) -> None:
    unit = WorkUnit(
        "render:000001",
        StageName.RENDER,
        dependencies=("render:plan",),
    )
    self.assertEqual(unit.dependencies, ("render:plan",))

    invalid = (
        lambda: WorkUnit("render:1", StageName.RENDER, dependencies=["tts"]),
        lambda: WorkUnit("render:1", StageName.RENDER, dependencies=("tts", "tts")),
        lambda: WorkUnit("render:1", StageName.RENDER, dependencies=("z", "a")),
        lambda: WorkUnit(
            "render:1",
            StageName.RENDER,
            dependencies=("render:1",),
        ),
    )
    for factory in invalid:
        with self.subTest(factory=factory):
            with self.assertRaises(DomainInvariantError):
                factory()
```

- [ ] **Step 2: Run the test to verify RED**

```powershell
python -m pytest tests_v2/domain/test_models.py -v
```

Expected: `WorkUnit` does not accept `dependencies`.

- [ ] **Step 3: Add the dependency field and port methods**

Append the field after `attempts` so existing positional constructors remain
valid:

```python
dependencies: tuple[str, ...] = ()
```

Validate exact tuple type, non-empty trimmed strings, sorted uniqueness, maximum
512 characters, and no self-reference.

Add the three read/invalidation methods to `StateRepository`. Do not add
filesystem or SQLite types to the port.

- [ ] **Step 4: Run domain and protocol tests**

```powershell
python -m pytest tests_v2/domain/test_models.py tests_v2/ports/ -q
```

Expected: all pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/ytb_vps_v2/domain/models.py src/ytb_vps_v2/ports/state.py tests_v2/domain/test_models.py
git commit -m "feat(state): model work unit dependencies"
```

---

### Task 3: SQLite schema v3 and per-unit artifact ownership

**Files:**
- Modify: `src/ytb_vps_v2/adapters/sqlite/schema.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/restore.py`
- Modify: `tests_v2/adapters/sqlite/test_schema.py`
- Modify: `tests_v2/adapters/sqlite/test_work_units.py`
- Modify: `tests_v2/adapters/sqlite/test_artifacts.py`
- Modify: `tests_v2/adapters/sqlite/test_restore.py`

**Interfaces:**
- Consumes: Task 2 `WorkUnit.dependencies` and new state-port methods.
- Produces: schema version 3, exact `artifacts.unit_key`, dependency closure invalidation, per-unit artifact reads.

- [ ] **Step 1: Write failing migration and ownership tests**

Add tests that:

1. create a real schema-v2 database with a succeeded `render` unit and artifact;
2. reopen through `SqliteStateStore`;
3. assert `PRAGMA user_version == 3`;
4. assert migrated artifact `unit_key == "render"`;
5. assert every pre-migration digest/status/attempt is unchanged.

Add an independent-chunk test:

```python
for key, dependencies in (
    ("render:plan", ("tts",)),
    ("render:000000", ("render:plan",)),
    ("render:000001", ("render:plan",)),
    ("render", ("render:000000", "render:000001")),
    ("publish", ("render",)),
):
    store.put_work_unit(
        job_id,
        WorkUnit(key, StageName.RENDER if key.startswith("render") else StageName.PUBLISH,
                 dependencies=dependencies),
        "planned",
    )
```

Commit two distinct chunk artifacts, invalidate `render:000001`, and assert:

- invalidated keys are `render:000001`, `render`, `publish`;
- `render:000000` and `render:plan` remain `SUCCEEDED`;
- `artifacts_for_unit(..., "render:000000")` remains valid;
- recommitting chunk 1 does not require submitting chunk 0's artifact.

- [ ] **Step 2: Run SQLite tests to verify RED**

```powershell
python -m pytest tests_v2/adapters/sqlite/test_schema.py tests_v2/adapters/sqlite/test_work_units.py tests_v2/adapters/sqlite/test_artifacts.py -q
```

Expected: schema version and new repository methods fail.

- [ ] **Step 3: Add migration 3**

Set `SCHEMA_VERSION = 3` and add a transaction that:

```sql
BEGIN IMMEDIATE;

CREATE TABLE work_unit_dependencies (
    job_id TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    depends_on_key TEXT NOT NULL,
    PRIMARY KEY (job_id, unit_key, depends_on_key),
    FOREIGN KEY (job_id, unit_key)
        REFERENCES work_units(job_id, unit_key) ON DELETE CASCADE,
    FOREIGN KEY (job_id, depends_on_key)
        REFERENCES work_units(job_id, unit_key) ON DELETE CASCADE,
    CHECK (unit_key <> depends_on_key)
);

INSERT INTO work_unit_dependencies(job_id, unit_key, depends_on_key)
SELECT later.job_id, later.unit_key, earlier.unit_key
FROM work_units AS later
JOIN work_units AS earlier ON earlier.job_id=later.job_id
WHERE
    (later.unit_key='ocr' AND earlier.unit_key='ingest')
 OR (later.unit_key='track' AND earlier.unit_key='ocr')
 OR (later.unit_key='translate' AND earlier.unit_key='track')
 OR (later.unit_key='tts' AND earlier.unit_key='translate')
 OR (later.unit_key='render' AND earlier.unit_key='tts')
 OR (later.unit_key='publish' AND earlier.unit_key='render')
 OR (later.unit_key='backup' AND earlier.unit_key='publish');

ALTER TABLE artifacts RENAME TO artifacts_v2;
CREATE TABLE artifacts (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    owner_stage TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name),
    UNIQUE (job_id, relative_path),
    FOREIGN KEY (job_id, unit_key)
        REFERENCES work_units(job_id, unit_key) ON DELETE CASCADE
);
INSERT INTO artifacts(
    job_id, name, relative_path, size_bytes, sha256, owner_stage,
    unit_key, dependencies_json, is_valid, committed_at
)
SELECT
    job_id, name, relative_path, size_bytes, sha256, owner_stage,
    lower(owner_stage), dependencies_json, is_valid, committed_at
FROM artifacts_v2;
DROP TABLE artifacts_v2;

CREATE INDEX artifacts_owner_unit
    ON artifacts(job_id, unit_key, is_valid);
CREATE INDEX work_unit_reverse_dependencies
    ON work_unit_dependencies(job_id, depends_on_key, unit_key);

PRAGMA user_version=3;
COMMIT;
```

Run migration 3 when version is 2. Preserve rollback behavior.

- [ ] **Step 4: Persist and return work-unit dependencies**

`put_work_unit` inserts the unit row first, verifies every dependency already
exists for the same job, then inserts dependency rows in the same transaction.
For an existing unit, compare stage/status/attempts and exact stored
dependencies.

Every `get_work_unit` and `work_units` call reconstructs:

```python
WorkUnit(
    row["unit_key"],
    StageName(row["stage"]),
    WorkStatus(row["status"]),
    row["attempts"],
    dependencies,
)
```

Enforce dependency success in `start_work_unit`:

```sql
SELECT d.depends_on_key
FROM work_unit_dependencies d
JOIN work_units u
  ON u.job_id=d.job_id AND u.unit_key=d.depends_on_key
WHERE d.job_id=? AND d.unit_key=? AND u.status<>'SUCCEEDED'
LIMIT 1
```

If a row exists, raise `StateTransitionError`.

- [ ] **Step 5: Scope artifacts to owner unit**

Include `unit_key` in insert/update queries. Recommit identity checks select
invalid artifacts only for `job_id + unit_key`, not `owner_stage`.

Implement `artifacts_for_unit` as valid artifacts ordered by name, using the
same strict JSON dependency parser as `valid_artifacts`.

- [ ] **Step 6: Implement recursive unit invalidation**

Inside one transaction, compute closure in Python from `work_units(job_id)`:

```python
affected = set(requested)
changed = True
while changed:
    before = len(affected)
    affected.update(
        unit.key
        for unit in units
        if any(dependency in affected for dependency in unit.dependencies)
    )
    changed = len(affected) != before
```

Validate every requested key exists. Mark affected units `INVALID` except
already-invalid rows, clear errors, and mark artifacts invalid by `unit_key`.
Return affected keys sorted by `(stage order, unit key)`.

Keep `apply_invalidation` for stage-level config closure; it now invalidates all
units in affected stages and their artifacts by owner unit.

- [ ] **Step 7: Update staged restore inspection**

Read `unit_key` from schema-v3 artifact rows and verify:

- referenced work unit exists;
- its stage equals `owner_stage`;
- every valid artifact belongs to a `SUCCEEDED` work unit.

Schema-v2 snapshots are migrated in staging before this inspection, so one
post-migration path is sufficient.

- [ ] **Step 8: Run SQLite and restore suites**

```powershell
python -m pytest tests_v2/adapters/sqlite/ tests_v2/application/test_restore.py -q
```

Expected: all pass.

- [ ] **Step 9: Commit Task 3**

```powershell
git add -- src/ytb_vps_v2/adapters/sqlite/schema.py src/ytb_vps_v2/adapters/sqlite/state.py src/ytb_vps_v2/adapters/sqlite/restore.py tests_v2/adapters/sqlite/test_schema.py tests_v2/adapters/sqlite/test_work_units.py tests_v2/adapters/sqlite/test_artifacts.py tests_v2/adapters/sqlite/test_restore.py
git commit -m "feat(state): persist per-unit chunk dependencies"
```

---

### Task 4: Atomic reconfiguration and truthful RENDER fingerprints

**Files:**
- Modify: `src/ytb_vps_v2/domain/fingerprints.py`
- Modify: `src/ytb_vps_v2/domain/__init__.py`
- Modify: `src/ytb_vps_v2/ports/state.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Modify: `src/ytb_vps_v2/application/offline_slice.py`
- Modify: `tests_v2/domain/test_fingerprints.py`
- Modify: `tests_v2/adapters/sqlite/test_work_units.py`
- Modify: `tests_v2/application/test_offline_slice.py`

**Interfaces:**
- Consumes: typed `BlurRegion`, `EffectiveConfig`, stage invalidation.
- Produces:
  - `RenderFingerprintInputs(blur_regions, output_has_audio)`
  - `stage_config_fingerprints(config, *, render_inputs=...)`
  - `stored_config_fingerprints`
  - atomic compare-and-swap `reconfigure_job`

- [ ] **Step 1: Write failing fingerprint-closure tests**

Add:

```python
render_inputs = RenderFingerprintInputs(
    (
        BlurRegion(
            RegionKind.STATIC,
            FrameInterval(0, 900),
            BoundingBox(0, 700, 1280, 720),
        ),
    ),
    True,
)
baseline = stage_config_fingerprints(
    EffectiveConfig(),
    render_inputs=render_inputs,
)
changed = stage_config_fingerprints(
    EffectiveConfig(),
    render_inputs=replace(
        render_inputs,
        blur_regions=(
            replace(
                render_inputs.blur_regions[0],
                box=BoundingBox(0, 680, 1280, 720),
            ),
        ),
    ),
)
plan = plan_invalidation(baseline, changed)
self.assertEqual(plan.direct_stages, (StageName.RENDER,))
self.assertEqual(
    plan.affected_stages,
    (StageName.RENDER, StageName.PUBLISH, StageName.BACKUP),
)
```

Also assert a UI-only label cannot enter `RenderFingerprintInputs`, and
`media.chunk_seconds` changes both OCR and RENDER direct hashes.

- [ ] **Step 2: Run fingerprint tests to verify RED**

```powershell
python -m pytest tests_v2/domain/test_fingerprints.py tests_v2/application/test_invalidation.py -q
```

Expected: `RenderFingerprintInputs` and keyword argument are absent.

- [ ] **Step 3: Implement the render join**

```python
@dataclass(frozen=True, slots=True)
class RenderFingerprintInputs:
    blur_regions: tuple[BlurRegion, ...] = ()
    output_has_audio: bool = True

    def __post_init__(self) -> None:
        if type(self.blur_regions) is not tuple or any(
            type(item) is not BlurRegion for item in self.blur_regions
        ):
            raise DomainInvariantError("Render fingerprint masks are invalid")
        if type(self.output_has_audio) is not bool:
            raise DomainInvariantError("Render fingerprint audio policy is invalid")
```

Change the RENDER projection to:

```python
StageName.RENDER: (
    config.media.chunk_seconds,
    config.render,
    render_inputs,
),
```

Keep OCR's current ownership of `media.chunk_seconds`.

- [ ] **Step 4: Write failing atomic reconfiguration tests**

Test that:

- `stored_config_fingerprints` returns `None` for no job and the exact snapshot
  after creation;
- reconfiguration from expected previous to current invalidates render units,
  updates stored hashes, and preserves OCR/TTS units;
- passing a stale `previous` raises and changes neither hashes nor statuses;
- injecting a database failure between invalidation and update rolls back both.

- [ ] **Step 5: Implement state-port and SQLite reconfiguration**

Add:

```python
def stored_config_fingerprints(
    self,
    job_id: JobId,
) -> tuple[StageConfigFingerprint, ...] | None
```

Return values in `StageName` order and reject incomplete/corrupt snapshots.

Implement `reconfigure_job` in one `_transaction`. Compare every stored stage
hash with `previous`, apply the supplied affected-stage closure to units and
artifacts, then update all hashes. Do not call public `apply_invalidation`
inside the transaction.

- [ ] **Step 6: Reconcile before resume**

In `OfflineSliceRunner.run`, replace unconditional current-snapshot
`create_job` with:

```python
stored = self.state.stored_config_fingerprints(request.job_id)
if stored is None:
    self.state.create_job(
        request.job_id,
        source_fingerprint,
        request.config_fingerprints,
        request.at,
    )
else:
    self.state.create_job(
        request.job_id,
        source_fingerprint,
        stored,
        request.at,
    )
    invalidation = plan_invalidation(stored, request.config_fingerprints)
    if invalidation.affected_stages:
        self.state.reconfigure_job(
            request.job_id,
            stored,
            request.config_fingerprints,
            invalidation,
            request.at,
        )
```

The second `create_job` verifies source identity without pretending the new
configuration was previously stored.

- [ ] **Step 7: Run fingerprint, invalidation, and offline tests**

```powershell
python -m pytest tests_v2/domain/test_fingerprints.py tests_v2/application/test_invalidation.py tests_v2/adapters/sqlite/test_work_units.py tests_v2/application/test_offline_slice.py -q
```

Expected: all pass.

- [ ] **Step 8: Commit Task 4**

```powershell
git add -- src/ytb_vps_v2/domain/fingerprints.py src/ytb_vps_v2/domain/__init__.py src/ytb_vps_v2/ports/state.py src/ytb_vps_v2/adapters/sqlite/state.py src/ytb_vps_v2/application/offline_slice.py tests_v2/domain/test_fingerprints.py tests_v2/adapters/sqlite/test_work_units.py tests_v2/application/test_offline_slice.py
git commit -m "feat(render): join scene inputs into render invalidation"
```

---

### Task 5: Checkpoint manifest v2 with stable immutable objects

**Files:**
- Modify: `src/ytb_vps_v2/domain/backup.py`
- Modify: `src/ytb_vps_v2/application/checkpoints.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/restore.py`
- Modify: `tests_v2/domain/test_backup.py`
- Modify: `tests_v2/application/test_checkpoints.py`
- Modify: `tests_v2/application/test_restore.py`
- Modify: `tests_v2/adapters/sqlite/test_restore.py`

**Interfaces:**
- Consumes: existing `CheckpointManifest`, additive object store, SQLite snapshot, staged restore.
- Produces:
  - manifest parser for versions 1 and 2;
  - v2 stable object-key derivation;
  - `CheckpointPublisher.latest_verified_v2(...)`;
  - `publish(..., reuse: CheckpointManifest | None = None)`.

- [ ] **Step 1: Add failing manifest compatibility tests**

Pin canonical bytes for one v1 fixture and one v2 fixture. Assert:

```python
self.assertEqual(parse_manifest_bytes(V1_BYTES).version, 1)
self.assertEqual(parse_manifest_bytes(V2_BYTES).version, 2)
self.assertEqual(canonical_manifest_bytes(parse_manifest_bytes(V1_BYTES)), V1_BYTES)
self.assertEqual(canonical_manifest_bytes(parse_manifest_bytes(V2_BYTES)), V2_BYTES)
```

Versions `0`, `3`, booleans, unknown fields, and duplicate fields must fail.

- [ ] **Step 2: Run domain backup tests to verify RED**

```powershell
python -m pytest tests_v2/domain/test_backup.py -v
```

Expected: version 2 is rejected.

- [ ] **Step 3: Accept and write exact manifest versions**

Change `CheckpointManifest.__post_init__` to accept exact integers in `{1, 2}`.
Keep the field set identical. `canonical_manifest_bytes` writes the instance's
version; `parse_manifest_bytes` remains canonical-byte enforcing.

- [ ] **Step 4: Add failing stable-key and dedup tests**

Publish checkpoint `render-chunk-000000`, commit a second chunk, then publish
`render-chunk-000001` with reuse of the first manifest.

Record calls to `object_store.put` and assert:

- input key is `objects/<job-token>/input/<sha256>`;
- chunk keys end in their digest;
- chunk 0's media key is put once total;
- chunk 1's media key is put once;
- each checkpoint has a distinct state and manifest key;
- the second manifest includes both chunk entries;
- remote verification is called for the reused chunk 0 entry.

- [ ] **Step 5: Implement v2 keys and reuse**

Add helpers:

```python
def _object_prefix(job_id: JobId) -> PurePosixPath:
    return PurePosixPath("objects", _token(job_id.value))


def _input_object(job_id: JobId, digest: FileDigest) -> PurePosixPath:
    return _object_prefix(job_id) / "input" / digest.sha256


def _artifact_object(job_id: JobId, artifact: Artifact) -> PurePosixPath:
    return (
        _object_prefix(job_id)
        / "workspace"
        / artifact.relative_path
        / artifact.sha256
    )
```

New `publish` calls create `CheckpointManifest(2, ...)`.

When `reuse` is version 2, build a map by stable key. For an exact key+digest
match, call remote `verify` and reuse the entry without calling
`files.existing` or `object_store.put`. New or changed entries follow the full
local verification and upload path.

`latest_verified_v2(job_id, checkpoint_prefix, observed_at)` filters completed
checkpoint IDs by the supplied prefix, sorts their zero-padded chunk index,
and returns the newest manifest whose full remote evidence verifies.

- [ ] **Step 6: Add failing v1/v2 restore tests**

Keep the existing real v1 checkpoint restore fixture. Add a v2 fixture whose:

- input lives under `objects/<job>/input/<digest>`;
- artifact lives under
  `objects/<job>/workspace/<relative-path>/<digest>`;
- state and manifest remain under the checkpoint prefix.

Both must restore into absent targets and produce identical local layouts.

- [ ] **Step 7: Branch staged layout validation by manifest version**

For v1, preserve the exact existing prefix checks.

For v2, derive each expected stable remote key from the staged SQLite artifact
row and digest. Require exact set equality with `manifest.artifacts`. Derive the
stable input key from source digest. State and manifest keys remain under the
checkpoint-specific prefix.

- [ ] **Step 8: Run checkpoint and restore suites**

```powershell
python -m pytest tests_v2/domain/test_backup.py tests_v2/application/test_checkpoints.py tests_v2/application/test_restore.py tests_v2/adapters/sqlite/test_restore.py -q
```

Expected: all pass, including unchanged v1 tests.

- [ ] **Step 9: Commit Task 5**

```powershell
git add -- src/ytb_vps_v2/domain/backup.py src/ytb_vps_v2/application/checkpoints.py src/ytb_vps_v2/adapters/sqlite/restore.py tests_v2/domain/test_backup.py tests_v2/application/test_checkpoints.py tests_v2/application/test_restore.py tests_v2/adapters/sqlite/test_restore.py
git commit -m "feat(backup): checkpoint chunks without duplicating media"
```

---

### Task 6: Chunk-local render request and real FFmpeg chunk encode

**Files:**
- Create: `src/ytb_vps_v2/application/render_chunks.py`
- Modify: `src/ytb_vps_v2/adapters/ffmpeg/media.py`
- Modify: `src/ytb_vps_v2/ports/pipeline.py`
- Create: `tests_v2/application/test_render_chunks.py`
- Modify: `tests_v2/adapters/ffmpeg/test_render_arguments.py`
- Modify: `tests_v2/adapters/ffmpeg/test_media.py`

**Interfaces:**
- Consumes: global `RenderRequest`, `RenderChunk`, Task 1 planner.
- Produces:
  - `chunk_local_request(plan, chunk) -> RenderRequest`
  - `MediaPipeline.render_chunk(...)`
  - exact source/TTS input seek and chunk duration.

- [ ] **Step 1: Write failing local-rebase tests**

Create tests with a global chunk `[300, 600)` and:

- cue `[280, 330)` becomes `[0, 30)`;
- cue `[450, 650)` becomes `[150, 300)`;
- cue outside the chunk is absent;
- mask `[250, 350)` becomes `[0, 50)`;
- full-timeline mask becomes local full-timeline mask;
- local Part is `[0, 300)` and retains the global chunk index.

Expected construction:

```python
local = chunk_local_request(global_plan, RenderChunk(1, FrameInterval(300, 600)))
self.assertEqual(local.frame_count, 300)
self.assertEqual(
    tuple(item.interval for item in local.cues),
    (FrameInterval(0, 30), FrameInterval(150, 300)),
)
self.assertEqual(local.parts[0].chunk_indexes, (1,))
```

- [ ] **Step 2: Run local-rebase tests to verify RED**

```powershell
python -m pytest tests_v2/application/test_render_chunks.py -v
```

Expected: module/function absent.

- [ ] **Step 3: Implement exact intersection and rebasing**

Use:

```python
def _local_interval(
    value: FrameInterval,
    chunk: FrameInterval,
) -> FrameInterval | None:
    start = max(value.start_frame, chunk.start_frame)
    end = min(value.end_frame, chunk.end_frame)
    if start >= end:
        return None
    return FrameInterval(start - chunk.start_frame, end - chunk.start_frame)
```

Rebuild cues and blur regions with `dataclasses.replace`; preserve indexes,
boxes, text, digests, and output policy.

- [ ] **Step 4: Write failing render-argument seek tests**

Assert a chunk starting at frame 300 at 30 FPS produces:

```text
-ss 10.000 -t 10.000 -i source.mp4
-ss 10.000 -t 10.000 -i voice.wav
```

The filter graph uses local mask/cue times beginning at zero and
`-frames:v 300`.

Add the no-TTS-overlap case: when probed TTS duration is at or before chunk
start, render arguments contain no TTS input and still map `[aout]`.

- [ ] **Step 5: Refactor the adapter around a shared private render**

Extend `RenderInputs` with exact Fractions:

```python
source_start: Fraction = Fraction(0)
source_duration: Fraction | None = None
voice_trim_starts: tuple[Fraction, ...] = ()
```

Validate lengths and non-negative values. Emit `-ss` and `-t` immediately
before each applicable `-i`.

Extract current atomic staging, ASS generation, graph externalization, process
execution, and validation into `_render_prevalidated(...)`. Keep `render`
behavior unchanged by passing zero start and no bounded duration.

Add `_probe_audio_duration(path: Path) -> Fraction` using the existing
`ffprobe` JSON path. Parse the exact decimal duration with
`Fraction(str(value))`, reject missing/non-positive duration, and cover malformed
probe output in `test_media.py`.

Implement `render_chunk`:

1. probe and verify the full source against the global plan;
2. derive the local request;
3. probe TTS duration;
4. include a trimmed TTS input only if it overlaps the chunk;
5. call `_render_prevalidated` with source seek and exact duration;
6. return the validated chunk `MediaDocument`.

When no source audio and no overlapping TTS exist, `build_audio_graph` already
creates explicit stereo silence for the complete chunk.

- [ ] **Step 6: Run argument and adapter tests**

```powershell
python -m pytest tests_v2/application/test_render_chunks.py tests_v2/adapters/ffmpeg/test_render_arguments.py tests_v2/adapters/ffmpeg/test_media.py -q
```

Expected: all pass.

- [ ] **Step 7: Add real-FFmpeg chunk tests**

Generate a 12-second CFR fixture with source tone, a 5-second TTS tone, a timed
mask crossing second 4, and a subtitle cue crossing second 8. Render three
4-second chunks.

Assert each chunk:

- has 120 frames at 30 FPS;
- decodes fully;
- contains audio;
- chunk 2 remains valid after TTS has ended;
- mask and subtitle evidence exists on both sides of boundaries.

- [ ] **Step 8: Run real-FFmpeg tests**

```powershell
python -m pytest tests_v2/adapters/ffmpeg/test_render_arguments.py -k "chunk" -v
```

Expected: all chunk integration tests pass.

- [ ] **Step 9: Commit Task 6**

```powershell
git add -- src/ytb_vps_v2/application/render_chunks.py src/ytb_vps_v2/adapters/ffmpeg/media.py src/ytb_vps_v2/ports/pipeline.py tests_v2/application/test_render_chunks.py tests_v2/adapters/ffmpeg/test_render_arguments.py tests_v2/adapters/ffmpeg/test_media.py
git commit -m "feat(render): encode exact local-timeline chunks"
```

---

### Task 7: Verified stream-copy chunk concatenation

**Files:**
- Modify: `src/ytb_vps_v2/adapters/ffmpeg/media.py`
- Modify: `src/ytb_vps_v2/ports/pipeline.py`
- Create: `tests_v2/adapters/ffmpeg/test_chunk_concat.py`

**Interfaces:**
- Consumes: validated chunk files and global `RenderRequest`.
- Produces:
  - `MediaPipeline.concatenate_render_chunks(chunks, plan, destination)`
  - atomic, fully validated global output.

- [ ] **Step 1: Write failing concat argument/path tests**

Test safe manifest encoding for normal paths and a workspace containing an
apostrophe. Reject:

- empty chunk tuple;
- missing/symlink chunk;
- duplicate path;
- chunk count different from the global Part's chunk indexes.

Assert the command includes:

```text
-f concat -safe 0 -i <manifest> -map 0:v:0 -map 0:a:0? -c copy
```

- [ ] **Step 2: Run test to verify RED**

```powershell
python -m pytest tests_v2/adapters/ffmpeg/test_chunk_concat.py -v
```

Expected: method/module behavior absent.

- [ ] **Step 3: Implement concat manifest and atomic output**

Use an owned temporary directory. Encode each absolute path as:

```python
def _concat_line(path: Path) -> str:
    escaped = path.resolve(strict=True).as_posix().replace("'", "'\\''")
    return f"file '{escaped}'\n"
```

Write with exclusive creation, flush, and `os.fsync`.

Use the same `_destination`, `_OwnedRenderStaging` /
`_AnonymousPosixRender`, and `validate_render` safety pattern as render.
Run stream copy, full decode, probe, and global-plan validation before atomic
publication.

- [ ] **Step 4: Add real seam tests**

Create three independently encoded 2-second chunks with a frame counter pattern
and audio. Concatenate and assert:

- 180 frames total at 30 FPS;
- duration is 6 seconds within one frame;
- audio exists through the final 0.5-second window;
- sampled frames immediately before/after both seams are consecutive, not
  duplicated or missing;
- full decode succeeds.

- [ ] **Step 5: Run concat tests**

```powershell
python -m pytest tests_v2/adapters/ffmpeg/test_chunk_concat.py tests_v2/adapters/ffmpeg/test_media.py -q
```

Expected: all pass.

- [ ] **Step 6: Commit Task 7**

```powershell
git add -- src/ytb_vps_v2/adapters/ffmpeg/media.py src/ytb_vps_v2/ports/pipeline.py tests_v2/adapters/ffmpeg/test_chunk_concat.py
git commit -m "feat(render): concatenate verified render chunks"
```

---

### Task 8: Chunk coordinator, resume, disk guard, and checkpoints

**Files:**
- Create: `src/ytb_vps_v2/application/chunked_render.py`
- Modify: `src/ytb_vps_v2/application/offline_slice.py`
- Modify: `src/ytb_vps_v2/ports/state.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Modify: `tests_v2/application/test_offline_slice.py`
- Create: `tests_v2/application/test_chunked_render.py`
- Modify: `tests_v2/adapters/sqlite/test_work_units.py`

**Interfaces:**
- Consumes: Tasks 1-7, `CheckpointPublisher`, `StateRepository`, `ArtifactWriter`, `ensure_free_space`.
- Produces:
  - `ChunkedRenderCoordinator`
  - canonical work-unit graph;
  - independently resumable render chunks;
  - `PreparedRender` for the existing final RENDER publication.

- [ ] **Step 1: Build deterministic fakes and failing happy-path test**

In `test_chunked_render.py`, create:

- fake media recording render/concat calls and writing deterministic bytes;
- fake checkpoint publisher recording checkpoint IDs;
- real `SqliteStateStore` and local artifact writer;
- 901-frame plan with `chunk_seconds=10`.

Assert after coordination:

- `render:plan` and four chunk units are `SUCCEEDED`;
- four chunk artifact paths exist and match state digests;
- render call indexes are `(0, 1, 2, 3)`;
- concat receives the four paths in order;
- four remotely verified checkpoint IDs were requested;
- coordinator returns a temporary assembled output, not a published stage
  document.

- [ ] **Step 2: Run the test to verify RED**

```powershell
python -m pytest tests_v2/application/test_chunked_render.py -v
```

Expected: coordinator absent.

- [ ] **Step 3: Implement plan/unit creation**

`ChunkedRenderCoordinator.prepare(...)`:

1. derive or verify `RenderChunkPlanDocument`;
2. ensure `render:plan`;
3. ensure `render:{index:06d}` for every chunk;
4. replace final `render` unit dependencies with every chunk key while it is
   non-running;
5. reject any succeeded plan whose canonical bytes differ.

Add a state-port method:

```python
def replace_work_unit_dependencies(
    job_id: JobId,
    unit_key: str,
    expected: tuple[str, ...],
    current: tuple[str, ...],
    at: str,
) -> None: ...
```

SQLite permits replacement only while the unit is `PENDING`, `FAILED`, or
`INVALID`; compare-and-swap the exact previous edge set.

- [ ] **Step 4: Implement chunk verification and execution**

For a succeeded chunk:

- require exactly one artifact for its unit;
- require exact canonical name/path;
- verify local digest;
- call media semantic validation against `chunk_local_request`.

On failure, call `invalidate_work_units` for that chunk key and continue with
rerender.

For a pending/failed/invalid chunk:

```python
estimated = max(
    16 * 1024 * 1024,
    -(
        -(source_size * chunk.interval.frame_count)
        // global_plan.frame_count
    ),
)
ensure_free_space(workspace, need_bytes=estimated * 3)
```

Then start, render to a temporary file, write atomically to the canonical chunk
path, verify, and `commit_artifact`.

- [ ] **Step 5: Publish one checkpoint after each chunk commit**

Use checkpoint base:

```text
render-chunk-<index:06d>-<render-fingerprint[:12]>-<chunk-digest[:12]>
```

Pass the preceding verified v2 manifest as `reuse`. Verify the returned
manifest and record it for the next chunk.

- [ ] **Step 6: Concatenate after all chunks verify**

Compute:

```python
need = (sum(item.size_bytes for item in chunk_artifacts) * 5 + 1) // 2
ensure_free_space(workspace, need_bytes=need)
```

Call `concatenate_render_chunks` into an owned temporary path and return
`PreparedRender(global_request, temporary_path)`.

- [ ] **Step 7: Integrate without starting RENDER too early**

In `OfflineSliceRunner.run`, special-case RENDER:

1. run the chunk coordinator while final `render` is not RUNNING;
2. after every chunk dependency succeeds, start final `render`;
3. publish final render plan and assembled file through the existing atomic
   stage path.

For all stage resume classification, read artifacts by exact stage work-unit
key. Do not treat chunk artifacts as extra final-stage artifacts.

When a canonical stage artifact is damaged, invalidate that exact unit and its
dependents. Do not call stage-wide invalidation unless a configuration
fingerprint changed.

- [ ] **Step 8: Add restart/fault tests**

Inject interruption for every chunk:

- before render;
- after fake media returns;
- after filesystem publication;
- after SQLite commit;
- during checkpoint publication.

Run again with the same workspace and assert:

- previously committed sibling chunks retain checksum and attempt count;
- interruption before SQLite commit rerenders that chunk;
- interruption after SQLite commit does not rerender locally;
- checkpoint failure does not mark the committed chunk failed;
- final output is identical to uninterrupted fake output.

- [ ] **Step 9: Run application suites**

```powershell
python -m pytest tests_v2/application/test_chunked_render.py tests_v2/application/test_offline_slice.py tests_v2/application/test_checkpoints.py -q
```

Expected: all pass.

- [ ] **Step 10: Commit Task 8**

```powershell
git add -- src/ytb_vps_v2/application/chunked_render.py src/ytb_vps_v2/application/offline_slice.py src/ytb_vps_v2/ports/state.py src/ytb_vps_v2/adapters/sqlite/state.py tests_v2/application/test_chunked_render.py tests_v2/application/test_offline_slice.py tests_v2/adapters/sqlite/test_work_units.py
git commit -m "feat(worker): resume rendering at committed chunks"
```

---

### Task 9: Native runner uses actual config and scene render identity

**Files:**
- Modify: `src/ytb_vps_v2/adapters/native_media_job.py`
- Modify: `src/ytb_vps_v2/application/media_job.py`
- Modify: `tests_v2/adapters/test_native_media_job.py`
- Modify: `tests_v2/application/test_media_job.py`

**Interfaces:**
- Consumes: `RenderFingerprintInputs`, typed scene masks, `EffectiveConfig`.
- Produces: production fingerprints built from accepted assignment values; optional config injection for deterministic tests.

- [ ] **Step 1: Write failing identity tests**

Assert:

- changing only one mask rectangle changes only the RENDER direct fingerprint;
- changing scene `rate` changes TTS and downstream, not OCR/TRANSLATE direct
  fingerprints;
- labels, IDs, origin metadata, and preset display names do not change any
  content fingerprint;
- production default chunk size remains 300 seconds.

- [ ] **Step 2: Run tests to verify RED**

```powershell
python -m pytest tests_v2/adapters/test_native_media_job.py tests_v2/application/test_media_job.py -q
```

Expected: native runner still supplies default-only fingerprints.

- [ ] **Step 3: Add typed scene projection**

Return one value from scene parsing:

```python
@dataclass(frozen=True, slots=True)
class SceneRenderProjection:
    blur_regions: tuple[BlurRegion, ...]
    tts_rate: Fraction
```

Build `tts_rate` with `Fraction(str(settings.get("rate", 1)))` and validate it
inside the accepted CapCut range already enforced by the web contract
`[0.8, 1.2]`. Map the two accepted legacy aliases
`vi-VN-HoaiMyNeural` and `vi-VN-NamMinhNeural` to `BV074_streaming`. Reject any
other post-compatibility voice rather than silently ignoring it.

- [ ] **Step 4: Build actual effective configuration**

Change:

```python
def run_native_pipeline(
    source: Path,
    workspace: Path,
    settings: Mapping[str, Any],
    job_id_value: str,
    *,
    config: EffectiveConfig | None = None,
) -> Path:
```

Use the supplied config for tests, otherwise defaults. Replace its TTS rate
with the accepted scene rate. Compute:

```python
render_inputs = RenderFingerprintInputs(
    projection.blur_regions,
    output_has_audio=True,
)
fingerprints = stage_config_fingerprints(
    effective,
    render_inputs=render_inputs,
)
```

Pass `effective.media.chunk_seconds` and the fingerprints into the offline
request/coordinator.

- [ ] **Step 5: Add a real three-chunk native test**

Run a 12-second 320×180 source with:

- `EffectiveConfig(media=replace(default.media, chunk_seconds=4), ...)`;
- source audio;
- mask active from seconds 3-8;
- deterministic TTS provider patch only.

Assert:

- final duration equals source within one frame;
- audio RMS is non-zero in seconds 0-4, 4-8, and 8-12;
- mask is active during seconds 3-8 and absent after;
- SQLite contains three succeeded chunk units;
- chunk paths and final output exist.

- [ ] **Step 6: Run native tests**

```powershell
python -m pytest tests_v2/adapters/test_native_media_job.py tests_v2/application/test_media_job.py -q
```

Expected: all pass.

- [ ] **Step 7: Commit Task 9**

```powershell
git add -- src/ytb_vps_v2/adapters/native_media_job.py src/ytb_vps_v2/application/media_job.py tests_v2/adapters/test_native_media_job.py tests_v2/application/test_media_job.py
git commit -m "feat(worker): fingerprint real scene render inputs"
```

---

### Task 10: Host-loss restore, corruption isolation, and final gates

**Files:**
- Create: `tests_v2/application/test_chunk_restore.py`
- Modify: `tests_v2/application/test_chunked_render.py`
- Modify: `tests_v2/adapters/test_native_media_job.py`
- Create: `.superpowers/sdd/2026-07-28-render-s2-chunk-durability/progress.md`
- Modify: `C:/Users/MrThien/.claude/projects/D--Dev-Projects-ytb-vps-scene/memory/render-module-status.md` outside Git after commit.

**Interfaces:**
- Consumes: complete S2 implementation.
- Produces: acceptance evidence only.

- [ ] **Step 1: Write the host-loss restore test**

Use real local additive storage:

1. run a four-chunk job and interrupt after checkpoint for chunk 1;
2. delete the active workspace/state copy inside the test temporary directory;
3. restore the newest verified chunk checkpoint into an empty target;
4. reopen restored SQLite and workspace;
5. resume with the same request;
6. assert chunks 0 and 1 keep attempt counts and checksums;
7. assert only chunks 2 and 3 call render;
8. assert the final semantic media report matches an uninterrupted control run.

- [ ] **Step 2: Add single-chunk corruption isolation**

After a successful four-chunk run, alter chunk 2 bytes. Resume and assert:

- chunk 2 rerenders;
- chunks 0, 1, and 3 are unchanged;
- assembly, publish, and backup rerun;
- OCR, TRACK, TRANSLATE, and TTS attempt counts are unchanged.

- [ ] **Step 3: Add scene-only invalidation acceptance**

Run once, change one mask rectangle, and run with the same job/source.

Assert:

```python
self.assertEqual(after["ocr"].attempts, before["ocr"].attempts)
self.assertEqual(after["translate"].attempts, before["translate"].attempts)
self.assertEqual(after["tts"].attempts, before["tts"].attempts)
self.assertGreater(after["render:000000"].attempts, before["render:000000"].attempts)
self.assertGreater(after["render"].attempts, before["render"].attempts)
self.assertGreater(after["publish"].attempts, before["publish"].attempts)
```

- [ ] **Step 4: Run focused acceptance suites**

```powershell
python -m pytest tests_v2/domain/test_render_chunks.py tests_v2/application/test_chunked_render.py tests_v2/application/test_chunk_restore.py tests_v2/adapters/ffmpeg/test_chunk_concat.py tests_v2/adapters/test_native_media_job.py -v
```

Expected: all pass.

- [ ] **Step 5: Run the complete v2 suite**

```powershell
python -m pytest tests_v2/ -q
```

Expected: all discovered tests pass; only environment-gated tests skip.

- [ ] **Step 6: Check diff and commit the acceptance tests**

```powershell
git diff --check
git add -- tests_v2/application/test_chunk_restore.py tests_v2/application/test_chunked_render.py tests_v2/adapters/test_native_media_job.py .superpowers/sdd/2026-07-28-render-s2-chunk-durability/progress.md
git commit -m "test(render): prove chunk restore and invalidation isolation"
```

- [ ] **Step 7: Update status records**

Append exact S2 commit hashes, test counts, real-FFmpeg evidence, and any
deliberately deferred S3-S8 items to the SDD ledger and external memory status.
Do not stage the external memory file. Do not stage unrelated plan/spec files
that predated S2.

- [ ] **Step 8: Perform final scoped review**

Verify:

```powershell
git status --short --branch
git log -12 --oneline --decorate
git diff --cached --name-only
git diff HEAD -- src/ytb_vps_v2 tests_v2
```

Expected:

- no staged files;
- no uncommitted S2 source/test changes;
- unrelated existing web/tools changes remain untouched;
- S2 commits are on `rebuild/v2`;
- no merge, push, or PR occurs without explicit authorization.
