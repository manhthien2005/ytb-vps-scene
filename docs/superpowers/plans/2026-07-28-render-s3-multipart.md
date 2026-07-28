# Render S3 Multipart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert S2's verified render chunks into independently resumable multipart files and upload every Part through a fenced multi-OUTPUT control-plane contract.

**Architecture:** Keep S2 chunk planning and artifacts as the durable base. Greedily group whole chunks into Parts, commit one render assembly and one local publication unit per Part, then make the native worker upload the ordered output descriptors. Extend Neon, Drive, and worker APIs so each OUTPUT has immutable Part identity and a job completes only when the exact set `1..N` is READY.

**Tech Stack:** Python 3.10–3.12, frozen dataclasses, SQLite state store, FFmpeg/ffprobe, pytest/unittest, Next.js, TypeScript, Zod, Vitest, PostgreSQL/Neon, Google Drive resumable uploads.

## Global Constraints

- Work only in `D:/Dev/Projects/ytb-vps-scene/.worktrees/render-s3-multipart` on `codex/render-s3-multipart`.
- Base implementation is `origin/rebuild/v2` at `294f5b7`; preserve the dirty main workspace.
- Default maximum Part target is exactly `1,800` seconds.
- Part boundaries must coincide with complete S2 render chunks.
- A single oversized chunk becomes one oversized Part; never split through the chunk.
- `RenderConfig.max_part_seconds` must be at least `MediaConfig.chunk_seconds`.
- Output names must be `part-{index}-of-{count}.mp4` with width `max(2, len(str(part_count)))`.
- Part count must be between `1` and `999`.
- Every new behavior follows RED → GREEN → REFACTOR; record the expected RED failure before production edits.
- Stage only the exact paths for each commit; never use `git add -A`.
- Never weaken `_verify_upstream`, canonical digest checks, lease fencing, or Drive property equality.
- Real media verification must use FFmpeg/ffprobe; string-only assertions are insufficient for duration and audio.
- S4–S8, user-selected boundaries, parallel heavy FFmpeg work, YouTube publication, and Publisher private-beta hardening remain out of scope.

## File map

### Python domain and canonical contracts

- Modify `src/ytb_vps_v2/domain/config.py`: add and validate `RenderConfig.max_part_seconds`.
- Modify `src/ytb_vps_v2/domain/render_chunks.py`: add Part packing and output naming.
- Modify `src/ytb_vps_v2/domain/pipeline.py`: add `RenderedPart`, multipart RenderPlan serialization/parsing, and legacy migration parsing.
- Modify `src/ytb_vps_v2/domain/__init__.py`: export new domain functions/value where appropriate.
- Modify `src/ytb_vps_v2/application/render_chunks.py`: add `part_local_request()`.

### Python execution

- Modify `src/ytb_vps_v2/application/chunked_render.py`: plan multipart, assemble/verify one Part per work unit, and return committed `RenderedPart` values.
- Create `src/ytb_vps_v2/application/multipart_publish.py`: independently commit/verify each published Part.
- Modify `src/ytb_vps_v2/application/offline_slice.py`: use multipart coordinators, classify auxiliary units, migrate legacy final output, and emit aligned canonical documents.
- Modify `src/ytb_vps_v2/adapters/filesystem/publish.py`: publish arbitrary valid Parts under deterministic names.
- Modify `src/ytb_vps_v2/adapters/native_media_job.py`: return ordered `MediaOutput` descriptors.
- Modify `src/ytb_vps_v2/application/media_job.py`: validate descriptors and upload all Parts.
- Modify `src/ytb_vps_v2/interfaces/cli.py`: report Part arrays.

### Web and Drive contract

- Modify `web/src/lib/repositories/worker-control-plane.ts`: add Part fields and multipart outcomes.
- Modify `web/src/lib/db/schema.sql`: migration v12 and per-job/per-Part live uniqueness.
- Modify `web/src/lib/repositories/neon-worker-control-plane.ts`: reserve and complete Parts transactionally.
- Modify `web/src/lib/ports/drive.ts`: pass Part identity to Drive.
- Modify `web/src/lib/adapters/google/drive-files.ts`: deterministic Part name/properties.
- Modify `web/src/app/api/v1/worker/jobs/[id]/output-session/route.ts`: multipart request, identity, and READY replay.
- Modify `web/src/app/api/v1/worker/jobs/[id]/complete/route.ts`: multipart validation and intermediate completion.
- Modify affected fakes and tests under `tests_v2/` and `web/src/`.

---

### Task 1: Part planning, naming, and configuration

**Files:**
- Modify: `src/ytb_vps_v2/domain/config.py`
- Modify: `src/ytb_vps_v2/domain/render_chunks.py`
- Modify: `src/ytb_vps_v2/domain/__init__.py`
- Modify: `tests_v2/config/test_config_types.py`
- Modify: `tests_v2/domain/test_render_chunks.py`

**Interfaces:**
- Consumes: `RenderChunk`, `Part`, `FrameInterval`, `MediaConfig.chunk_seconds`.
- Produces:
  - `plan_parts_for_chunks(*, frame_count: int, target_fps: int, max_part_seconds: int, chunks: tuple[RenderChunk, ...]) -> tuple[Part, ...]`
  - `part_file_name(part_index: int, part_count: int) -> str`
  - `RenderConfig.max_part_seconds: int = 1800`

- [ ] **Step 1: Add failing planner and naming tests**

Add tests that call the wished-for APIs:

```python
def test_groups_whole_chunks_under_the_part_target(self) -> None:
    chunks = (
        RenderChunk(0, FrameInterval(0, 600)),
        RenderChunk(1, FrameInterval(600, 1200)),
        RenderChunk(2, FrameInterval(1200, 1800)),
    )
    self.assertEqual(
        plan_parts_for_chunks(
            frame_count=1800,
            target_fps=1,
            max_part_seconds=1200,
            chunks=chunks,
        ),
        (
            Part(1, 2, FrameInterval(0, 1200), (0, 1)),
            Part(2, 2, FrameInterval(1200, 1800), (2,)),
        ),
    )

def test_oversized_chunk_is_not_split(self) -> None:
    chunks = (RenderChunk(0, FrameInterval(0, 1801)),)
    self.assertEqual(
        plan_parts_for_chunks(
            frame_count=1801,
            target_fps=1,
            max_part_seconds=1800,
            chunks=chunks,
        ),
        (Part(1, 1, FrameInterval(0, 1801), (0,)),),
    )

def test_part_file_name_matches_web_contract(self) -> None:
    self.assertEqual(part_file_name(1, 4), "part-01-of-04.mp4")
    self.assertEqual(part_file_name(12, 120), "part-012-of-120.mp4")
```

Also reject gaps, overlaps, non-canonical indexes, incomplete coverage, invalid
Part metadata, `part_count > 999`, and `RenderConfig(max_part_seconds=299)` with
`MediaConfig(chunk_seconds=300)` inside `EffectiveConfig`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/domain/test_render_chunks.py tests_v2/config/test_config_types.py -q
```

Expected: collection/import failure for `plan_parts_for_chunks` or
`part_file_name`, followed by the cross-config test failing because
`max_part_seconds` does not exist.

- [ ] **Step 3: Implement the planner and configuration**

Use exact type checks already established in `render_chunks.py`. The packing core
must follow this structure:

```python
target_frames = target_fps * max_part_seconds
groups: list[tuple[RenderChunk, ...]] = []
current: list[RenderChunk] = []
for chunk in chunks:
    candidate_frames = chunk.interval.end_frame - (
        current[0].interval.start_frame if current else chunk.interval.start_frame
    )
    if current and candidate_frames > target_frames:
        groups.append(tuple(current))
        current = []
    current.append(chunk)
groups.append(tuple(current))
part_count = len(groups)
return tuple(
    Part(
        index + 1,
        part_count,
        FrameInterval(group[0].interval.start_frame, group[-1].interval.end_frame),
        tuple(chunk.index for chunk in group),
    )
    for index, group in enumerate(groups)
)
```

`part_file_name()` validates exact integers, `1 <= index <= count <= 999`, then
uses `width = max(2, len(str(part_count)))`.

Add `max_part_seconds: int = MAX_PART_SECONDS` to `RenderConfig` and enforce the
cross-config relation in `EffectiveConfig.__post_init__`.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```powershell
pytest tests_v2/domain/test_render_chunks.py tests_v2/config/test_config_types.py tests_v2/domain/test_parts.py -q
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/domain/config.py src/ytb_vps_v2/domain/render_chunks.py src/ytb_vps_v2/domain/__init__.py tests_v2/config/test_config_types.py tests_v2/domain/test_render_chunks.py
git commit -m "feat(render): plan deterministic multipart outputs"
```

---

### Task 2: Multipart canonical RenderPlan identity

**Files:**
- Modify: `src/ytb_vps_v2/domain/pipeline.py`
- Modify: `tests_v2/domain/test_pipeline.py`

**Interfaces:**
- Consumes: `Part`, `FileDigest`, canonical document helpers.
- Produces:
  - `RenderedPart(part: Part, path: PurePosixPath, digest: FileDigest)`
  - `RenderPlanDocument.rendered_parts: tuple[RenderedPart, ...]`
  - legacy parser support for singular `rendered_path`/`rendered_digest`.

- [ ] **Step 1: Add failing canonical contract tests**

Construct a two-Part plan and assert:

```python
parts = (
    Part(1, 2, FrameInterval(0, 600), (0, 1)),
    Part(2, 2, FrameInterval(600, 900), (2,)),
)
rendered = (
    RenderedPart(parts[0], PurePosixPath("artifacts/render/parts/part-01-of-02.mp4"), SHA_A),
    RenderedPart(parts[1], PurePosixPath("artifacts/render/parts/part-02-of-02.mp4"), SHA_B),
)
document = replace(render_plan(), parts=parts, rendered_parts=rendered)
self.assertEqual(parse_render_plan_document_bytes(
    canonical_document_bytes(document), tts_document()
), document)
```

Add negative tests for reordered Parts, duplicate paths, mismatched digests,
legacy singular fields combined with new fields, and a legacy S2 one-Part JSON
payload parsing into one `RenderedPart`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/domain/test_pipeline.py -q
```

Expected: import/construction failure for `RenderedPart` or unexpected
`rendered_path` constructor fields.

- [ ] **Step 3: Implement typed value and canonical form**

Define `RenderedPart` immediately before `RenderPlanDocument`. Validate exact
types and make `RenderPlanDocument.__post_init__` require:

```python
if tuple(item.part for item in self.rendered_parts) != parts:
    raise DomainInvariantError("Rendered Parts must align with the Part plan")
if len({item.path for item in self.rendered_parts}) != len(self.rendered_parts):
    raise DomainInvariantError("Rendered Part paths must be unique")
```

Canonical serialization emits:

```json
"rendered_parts": [
  {
    "part": { "part_index": 1, "part_count": 2, "interval": {...}, "chunk_indexes": [...] },
    "path": "artifacts/render/parts/part-01-of-02.mp4",
    "digest": { "size_bytes": 123, "sha256": "..." }
  }
]
```

The parser accepts either the exact new field set or the exact legacy singular
field set. Legacy parsing creates one `RenderedPart`; it does not preserve both
representations.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pytest tests_v2/domain/test_pipeline.py -q
```

Expected: all pipeline document tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/domain/pipeline.py tests_v2/domain/test_pipeline.py
git commit -m "feat(render): record canonical rendered Part identities"
```

---

### Task 3: Part-local requests and FFmpeg validation

**Files:**
- Modify: `src/ytb_vps_v2/application/render_chunks.py`
- Modify: `tests_v2/application/test_render_chunks.py`
- Modify: `tests_v2/adapters/ffmpeg/test_media.py`

**Interfaces:**
- Consumes: global `RenderRequest`, global `Part`, cue/blur frame intervals.
- Produces: `part_local_request(request: RenderRequest, part: Part) -> RenderRequest`.

- [ ] **Step 1: Add failing rebasing tests**

Use a global Part `[300, 900)` and assert:

```python
local = part_local_request(request, request.parts[1])
self.assertEqual(local.frame_count, 600)
self.assertEqual(local.parts, (Part(1, 1, FrameInterval(0, 600), (0,)),))
self.assertEqual(local.cues[0].interval, FrameInterval(0, 120))
self.assertEqual(local.blur_regions[0].interval, FrameInterval(450, 600))
```

Include cues/regions fully outside the Part (removed), values crossing either
boundary (clipped and rebased), and invalid Part membership (rejected).

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/application/test_render_chunks.py -q
```

Expected: `part_local_request` import failure.

- [ ] **Step 3: Implement exact clipping/rebasing**

Mirror the existing `chunk_local_request()` behavior, but derive the local
request from the Part interval and use the Part's global chunk membership only
for validation. The returned request always carries local `Part(1,1)` because
FFmpeg validates one standalone file.

- [ ] **Step 4: Exercise the existing concat validator**

Add a focused adapter test that concatenates the Paths for only one Part and
calls:

```python
adapter.concatenate_render_chunks(chunk_paths, part_local_request(plan, part), output)
adapter.validate_render(output, part_local_request(plan, part))
```

Run:

```powershell
pytest tests_v2/application/test_render_chunks.py tests_v2/adapters/ffmpeg/test_media.py -q
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/application/render_chunks.py tests_v2/application/test_render_chunks.py tests_v2/adapters/ffmpeg/test_media.py
git commit -m "feat(render): validate Part-local timelines"
```

---

### Task 4: Durable per-Part assembly

**Files:**
- Modify: `src/ytb_vps_v2/application/chunked_render.py`
- Modify: `tests_v2/application/test_chunked_render.py`

**Interfaces:**
- Consumes: `plan_parts_for_chunks()`, `part_local_request()`, verified chunk artifacts.
- Produces:
  - work units `render:part:{part_index:06d}`;
  - artifacts `render-part-{part_index:06d}`;
  - paths `artifacts/render/parts/<part_file_name>`;
  - `PreparedRender(request: RenderRequest, rendered_parts: tuple[RenderedPart, ...])`.

- [ ] **Step 1: Add failing two-Part coordinator test**

Use three fake chunks and `max_part_seconds=2` at one frame per second. Assert:

```python
prepared = coordinator.prepare(..., max_part_seconds=2)
self.assertEqual(prepared.request.parts, (
    Part(1, 2, FrameInterval(0, 2), (0, 1)),
    Part(2, 2, FrameInterval(2, 3), (2,)),
))
self.assertEqual(
    [call.chunks for call in media.concat_calls],
    [(chunk_0_path, chunk_1_path), (chunk_2_path,)],
)
self.assertEqual(
    [item.part.part_index for item in prepared.rendered_parts],
    [1, 2],
)
```

Add resume tests where Part 1 already succeeded, and corruption tests where only
Part 2 is invalidated/reassembled.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/application/test_chunked_render.py -q
```

Expected: `prepare()` rejects `max_part_seconds` or still performs one concat.

- [ ] **Step 3: Implement Part assembly units**

Add helpers:

```python
def _part_unit_key(part: Part) -> str:
    return f"render:part:{part.part_index:06d}"

def _part_artifact_path(part: Part) -> PurePosixPath:
    return PurePosixPath("artifacts/render/parts") / part_file_name(
        part.part_index, part.part_count
    )
```

For each planned Part:

1. ensure a WorkUnit depending on its exact chunk unit keys;
2. verify a succeeded canonical artifact and Part-local media;
3. otherwise stream-copy concatenate only its chunks into a temporary file;
4. write, verify, validate, and atomically commit its artifact;
5. append a `RenderedPart`.

Change final `render` dependencies from chunk keys to Part-unit keys. Keep S2
chunk checkpoints unchanged.

For an existing S2 chunk-plan artifact, parse and accept it only when every
non-Part field and the exact chunk tuple match. New plans write the multipart
Part tuple.

- [ ] **Step 4: Verify GREEN and S2 resume regressions**

Run:

```powershell
pytest tests_v2/application/test_chunked_render.py tests_v2/application/test_offline_slice.py -q
```

Expected: multipart tests and all existing S2 interruption/checkpoint tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/application/chunked_render.py tests_v2/application/test_chunked_render.py
git commit -m "feat(render): assemble durable output Parts"
```

---

### Task 5: Durable multipart local publication and legacy migration

**Files:**
- Create: `src/ytb_vps_v2/application/multipart_publish.py`
- Create: `tests_v2/application/test_multipart_publish.py`
- Modify: `src/ytb_vps_v2/adapters/filesystem/publish.py`
- Create: `tests_v2/adapters/filesystem/test_publish.py`
- Modify: `src/ytb_vps_v2/application/offline_slice.py`
- Modify: `tests_v2/application/test_offline_slice.py`

**Interfaces:**
- Consumes: `RenderPlanDocument.rendered_parts`, `PartPublisher`, state repository.
- Produces:
  - `MultipartPublishCoordinator.prepare(...) -> PublicationDocument`;
  - work units `publish:part:{part_index:06d}`;
  - artifacts `published-part-{part_index:06d}`.

- [ ] **Step 1: Add failing publisher tests**

Assert `LocalPartPublisher` accepts:

```python
part = Part(2, 3, FrameInterval(600, 900), (2,))
entry = publisher.publish(source, part)
self.assertEqual(entry.key, PurePosixPath("published/part-02-of-03.mp4"))
```

For the coordinator, assert two render Parts create two publication units, two
files, and one aligned `PublicationDocument`. Add a resume case where Part 1 is
already verified and a corruption case where only Part 2 is copied again.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/application/test_multipart_publish.py tests_v2/application/test_offline_slice.py -q
```

Expected: missing module/import and the adapter's single-Part rejection.

- [ ] **Step 3: Implement coordinator and runner wiring**

`MultipartPublishCoordinator` mirrors the canonical verification pattern from
`ChunkedRenderCoordinator`:

```python
unit_key = f"publish:part:{part.part_index:06d}"
artifact_name = f"published-part-{part.part_index:06d}"
```

Each work unit depends on the matching render-Part unit. The final `publish` unit
depends on all publication Part units and commits only the Publication document.

Update `OfflineSliceRunner` so:

- final RENDER and PUBLISH stage units no longer own media side artifacts;
- auxiliary render/publish Part artifacts are verified during resume;
- the new RenderPlan document is built from `PreparedRender.rendered_parts`;
- legacy `artifacts/render/rendered.mp4` marks only final RENDER and downstream
  documents invalid while preserving verified chunk units;
- legacy `published/part-001.mp4` is accepted for a completed old one-Part job,
  but a rerun publishes the new deterministic `part-01-of-01.mp4` name;
- `OfflineSliceRequest.max_part_seconds` defaults to `MAX_PART_SECONDS`.

- [ ] **Step 4: Verify GREEN and corruption isolation**

Run:

```powershell
pytest tests_v2/application/test_multipart_publish.py tests_v2/application/test_offline_slice.py tests_v2/adapters/filesystem/test_publish.py -q
```

Expected: all selected tests pass and attempt counts show only the damaged Part
unit reruns.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/application/multipart_publish.py tests_v2/application/test_multipart_publish.py src/ytb_vps_v2/adapters/filesystem/publish.py tests_v2/adapters/filesystem/test_publish.py src/ytb_vps_v2/application/offline_slice.py tests_v2/application/test_offline_slice.py
git commit -m "feat(publish): commit local output Parts independently"
```

---

### Task 6: Native output descriptors and worker upload loop

**Files:**
- Modify: `src/ytb_vps_v2/application/media_job.py`
- Modify: `src/ytb_vps_v2/adapters/native_media_job.py`
- Modify: `src/ytb_vps_v2/interfaces/cli.py`
- Modify: `tests_v2/application/test_media_job.py`
- Modify: `tests_v2/adapters/test_native_media_job.py`
- Modify: `tests_v2/test_cli.py`

**Interfaces:**
- Produces:
  - `MediaOutput(part_index: int, part_count: int, path: Path)`;
  - native pipeline result `tuple[MediaOutput, ...]`.
- Consumes output-session response:
  - `{status: "READY", artifactId, driveFileId}`;
  - `{status: "UPLOAD", artifactId, driveFileId, sessionUri, expiresAt}`.

- [ ] **Step 1: Add failing worker multipart tests**

Use a fake pipeline returning:

```python
(
    MediaOutput(1, 2, output_1),
    MediaOutput(2, 2, output_2),
)
```

Assert two output-session requests contain exact Part metadata, two uploads and
completions occur in order, progress reports `1/2` then `2/2`, and workspace
cleanup happens only after `COMPLETED`.

Add:

- READY replay for Part 1 skips `upload_resumable` and continues to Part 2;
- `PART_COMPLETED` is accepted only before the final Part;
- `COMPLETED` before the final Part fails closed;
- malformed/missing/duplicate output descriptors fail before upload;
- cancellation between Parts does not start the next upload.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/application/test_media_job.py tests_v2/adapters/test_native_media_job.py tests_v2/test_cli.py -q
```

Expected: `MediaOutput` import failure or single-Path assumptions fail.

- [ ] **Step 3: Implement descriptor validation and upload loop**

Define:

```python
@dataclass(frozen=True, slots=True)
class MediaOutput:
    part_index: int
    part_count: int
    path: Path
```

Validate one ordered tuple with indexes `1..N`, a common count, maximum `999`,
and existing files.

For each output, calculate digest, report progress, request a session with
`partIndex` and `partCount`, skip bytes for status READY, otherwise upload, then
complete with the same Part metadata. Require `PART_COMPLETED` for Parts `1..N-1`
and `COMPLETED` or exact final replay for Part `N`.

`run_native_pipeline()` maps the aligned `PublicationDocument` values to
descriptors instead of returning `part-001.mp4`.

CLI JSON emits:

```json
{
  "renderedParts": ["..."],
  "publishedParts": ["..."]
}
```

For one Part, retain `"rendered"` and `"published"` aliases using the new
`part-01-of-01.mp4` path.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pytest tests_v2/application/test_media_job.py tests_v2/adapters/test_native_media_job.py tests_v2/test_cli.py -q
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/ytb_vps_v2/application/media_job.py src/ytb_vps_v2/adapters/native_media_job.py src/ytb_vps_v2/interfaces/cli.py tests_v2/application/test_media_job.py tests_v2/adapters/test_native_media_job.py tests_v2/test_cli.py
git commit -m "feat(worker): upload ordered multipart outputs"
```

---

### Task 7: Drive Part identity

**Files:**
- Modify: `web/src/lib/ports/drive.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts`
- Modify: `web/src/lib/adapters/google/drive-files.test.ts`
- Modify: `web/src/test/fakes/fake-google-drive.ts`

**Interfaces:**
- Extends `ensureOutputFile()` input with `partIndex: number` and `partCount: number`.
- Drive app properties add string values `ytbVpsPartIndex` and `ytbVpsPartCount`.

- [ ] **Step 1: Add failing adapter tests**

Call:

```typescript
await adapter(fetcher).ensureOutputFile(ACCESS_TOKEN, {
  projectId: PROJECT_ID,
  jobId: JOB_ID,
  artifactId: ARTIFACT_ID,
  parentId: OUTPUT_PARENT_ID,
  partIndex: 2,
  partCount: 4,
});
```

Assert the deterministic name is `part-02-of-04.mp4`, query/create properties
contain exact Part strings, and invalid indexes/counts are rejected before HTTP.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --run src/lib/adapters/google/drive-files.test.ts
```

from `web/`.

Expected: type/test failure because `ensureOutputFile` ignores Part metadata.

- [ ] **Step 3: Implement Drive identity**

Extend `outputProperties()` and `ensureOutputFile()`:

```typescript
name: outputPartFileName(input.partIndex, input.partCount),
appProperties: {
  ...outputProperties(input.projectId, input.jobId, input.artifactId),
  ytbVpsPartIndex: String(input.partIndex),
  ytbVpsPartCount: String(input.partCount),
},
```

Validate through `outputPartFileName()` before provider calls.

- [ ] **Step 4: Verify GREEN**

Run from `web/`:

```powershell
npm test -- --run src/lib/domain/output-part.test.ts src/lib/adapters/google/drive-files.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- web/src/lib/ports/drive.ts web/src/lib/adapters/google/drive-files.ts web/src/lib/adapters/google/drive-files.test.ts web/src/test/fakes/fake-google-drive.ts
git commit -m "feat(drive): identify multipart output files"
```

---

### Task 8: Neon multipart schema and repository

**Files:**
- Modify: `web/src/lib/db/schema.sql`
- Modify: `web/src/lib/repositories/worker-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-worker-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-worker-control-plane.test.ts`
- Modify: `web/src/lib/application/worker-control.test.ts`

**Interfaces:**
- `OutputReservation` and `OutputCompletion` add `partIndex`, `partCount`.
- Reservation returns `RESERVED | PENDING_REPLAY | READY_REPLAY | LEASE_LOST`.
- Completion returns `PART_COMPLETED | COMPLETED | REPLAY | LEASE_LOST`.

- [ ] **Step 1: Add failing schema/repository tests**

Assert the migration:

```sql
alter table artifacts add column if not exists part_index integer;
alter table artifacts add column if not exists part_count integer;
drop index if exists artifacts_one_live_output_per_job_idx;
create unique index ... on artifacts(job_id, part_index)
  where kind='OUTPUT' and status <> 'DELETED';
```

Repository tests must cover:

- reserve Parts 1 and 2 live for one job;
- READY/PENDING replay distinction;
- retire a changed PENDING artifact only for the same index;
- reject total mismatch;
- Part 1 completion returns `PART_COMPLETED` without changing worker/job/lease;
- Part 2 completion with exact READY set returns `COMPLETED` and releases them;
- replay READY Part is mutation-free.

- [ ] **Step 2: Verify RED**

Run from `web/`:

```powershell
npm test -- --run src/lib/repositories/neon-worker-control-plane.test.ts src/lib/application/worker-control.test.ts
```

Expected: repository inputs lack Part fields and SQL still enforces one OUTPUT.

- [ ] **Step 3: Implement migration v12**

Backfill live and historical OUTPUT rows to `1/1`, then add checks with a
PostgreSQL `do $$ ... $$` guard so a partially applied migration is safe.

The final invariants are:

```sql
(kind='OUTPUT' and part_index between 1 and part_count and part_count between 1 and 999)
or
(kind<>'OUTPUT' and part_index is null and part_count is null)
```

- [ ] **Step 4: Implement reservation SQL**

Require the active fence. Check all existing live rows use the same total.
Classify exact identity by status. Supersede only a different PENDING row with
the same `part_index`. Insert display name with
`outputPartFileName(input.partIndex, input.partCount)`.

- [ ] **Step 5: Implement completion SQL**

In one CTE transaction:

1. mark the exact Part READY;
2. compute READY indexes and the common count;
3. finalize only when count equals `partCount`, min index is `1`, max is
   `partCount`, and every row uses that count;
4. otherwise keep the lease and return `PART_COMPLETED`.

Do not release the worker, close the attempt, or delete the lease for an
intermediate Part.

- [ ] **Step 6: Verify GREEN**

Run from `web/`:

```powershell
npm test -- --run src/lib/repositories/neon-worker-control-plane.test.ts src/lib/application/worker-control.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```powershell
git add -- web/src/lib/db/schema.sql web/src/lib/repositories/worker-control-plane.ts web/src/lib/repositories/neon-worker-control-plane.ts web/src/lib/repositories/neon-worker-control-plane.test.ts web/src/lib/application/worker-control.test.ts
git commit -m "feat(control-plane): persist multipart OUTPUT artifacts"
```

---

### Task 9: Multipart output-session and completion APIs

**Files:**
- Modify: `web/src/app/api/v1/worker/jobs/[id]/output-session/route.ts`
- Modify: `web/src/app/api/v1/worker/jobs/[id]/output-session/route.test.ts`
- Modify: `web/src/app/api/v1/worker/jobs/[id]/complete/route.ts`
- Modify: `web/src/app/api/v1/worker/jobs/[id]/complete/route.test.ts`

**Interfaces:**
- Output artifact UUID domain becomes `ytb-vps/output-artifact/v2`.
- Identity payload is `[jobId, partIndex, partCount, sizeBytes, checksumSha256]`.
- Output-session response has `status: "READY" | "UPLOAD"`.

- [ ] **Step 1: Add failing route tests**

Output-session tests assert:

- two byte-identical Parts produce different artifact UUIDs;
- Part metadata reaches Drive and repository;
- `READY_REPLAY` returns no resumable session;
- `PENDING_REPLAY` returns a new resumable update session;
- invalid `partIndex`, `partCount`, and count above `999` return 400.

Complete tests assert exact Drive name/properties for Part 2/4 and propagate
`PART_COMPLETED`, `COMPLETED`, and `REPLAY`.

- [ ] **Step 2: Verify RED**

Run from `web/`:

```powershell
npm test -- --run src/app/api/v1/worker/jobs/[id]/output-session/route.test.ts src/app/api/v1/worker/jobs/[id]/complete/route.test.ts
```

Expected: strict Zod schemas reject Part fields and routes hard-code `1/1`.

- [ ] **Step 3: Implement output-session**

Extend the strict schema with:

```typescript
partIndex: z.number().int().min(1).max(999),
partCount: z.number().int().min(1).max(999),
```

Refine `partIndex <= partCount`. Derive artifact ID from the full Part identity.
Call `ensureOutputFile()` and `reserveOutput()` with exact metadata. If the
outcome is `READY_REPLAY`, return:

```json
{ "status": "READY", "artifactId": "...", "driveFileId": "..." }
```

Otherwise create the resumable session and return `status: "UPLOAD"`.

- [ ] **Step 4: Implement completion**

Add Part fields to the strict schema and repository call. Validate Drive name
with `outputPartFileName(partIndex, partCount)` and exact properties including
`ytbVpsPartIndex`/`ytbVpsPartCount`.

- [ ] **Step 5: Verify GREEN**

Run from `web/`:

```powershell
npm test -- --run src/app/api/v1/worker/jobs/[id]/output-session/route.test.ts src/app/api/v1/worker/jobs/[id]/complete/route.test.ts
```

Expected: all selected route tests pass.

- [ ] **Step 6: Commit**

```powershell
git add -- web/src/app/api/v1/worker/jobs/[id]/output-session/route.ts web/src/app/api/v1/worker/jobs/[id]/output-session/route.test.ts web/src/app/api/v1/worker/jobs/[id]/complete/route.ts web/src/app/api/v1/worker/jobs/[id]/complete/route.test.ts
git commit -m "feat(api): negotiate fenced multipart uploads"
```

---

### Task 10: Query/UI compatibility and cross-language integration

**Files:**
- Modify if the failing tests require it: `web/src/lib/repositories/neon-control-plane.ts`
- Modify if the failing tests require it: `web/src/lib/repositories/neon-drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-control-plane.test.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.test.ts`
- Modify: `web/src/lib/application/drive-workspace.test.ts`
- Modify: `web/src/components/job-list.test.tsx`
- Modify: `tests_v2/application/test_media_job.py`

**Interfaces:**
- OUTPUT collections are ordered by `part_index`, never collapsed to one row.
- Existing job progress renders `currentPart/totalParts` without new controls.

- [ ] **Step 1: Add failing compatibility tests**

Seed two READY outputs for one job and assert both appear, in Part order, in the
managed Drive workspace and repository projections. Assert job progress renders
`Part 2/4`. Add a Python contract test checking worker JSON uses the same
one-based index/count and deterministic file names as TypeScript.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/application/test_media_job.py -q
Push-Location web
npm test -- --run src/lib/repositories/neon-control-plane.test.ts src/lib/repositories/neon-drive-control-plane.test.ts src/lib/application/drive-workspace.test.ts src/components/job-list.test.tsx
Pop-Location
```

Expected: any remaining single-output query or display assumption fails. If all
query/UI tests already pass, retain the tests as proof and make no production
change in those files.

- [ ] **Step 3: Remove only proven single-output assumptions**

Use `order by part_index, id` for OUTPUT collections. Do not redesign the
dashboard. Keep existing display names and telemetry components.

- [ ] **Step 4: Verify GREEN**

Repeat the Step 2 commands. Expected: all selected Python/web compatibility tests
pass.

- [ ] **Step 5: Commit**

Stage only files actually changed:

```powershell
git add -- web/src/lib/repositories/neon-control-plane.test.ts web/src/lib/repositories/neon-drive-control-plane.test.ts web/src/lib/application/drive-workspace.test.ts web/src/components/job-list.test.tsx tests_v2/application/test_media_job.py
git commit -m "test(render): cover multipart control-plane projections"
```

Include repository implementation paths in `git add` only if Step 3 changed them.

---

### Task 11: Real FFmpeg multipart E2E and full verification

**Files:**
- Modify: `tests_v2/adapters/test_native_media_job.py`
- Create: `tests_v2/adapters/ffmpeg/test_multipart_e2e.py`
- Modify: `docs/superpowers/specs/2026-07-28-render-s3-multipart-design.md` only if verified behavior exposes a specification correction.

**Interfaces:**
- Exercises the complete Python path with a test-only Part target.
- Verifies duration, audio, boundary continuity, and one-Part regression.

- [ ] **Step 1: Add a failing real-FFmpeg multipart acceptance test**

Build a 12-second canonical fixture with three 4-second chunks and
`RenderConfig(max_part_seconds=8)`. Assert two output descriptors:

```python
self.assertEqual(
    [(item.part_index, item.part_count, item.path.name) for item in outputs],
    [
        (1, 2, "part-01-of-02.mp4"),
        (2, 2, "part-02-of-02.mp4"),
    ],
)
```

Use ffprobe to assert:

- Part 1 duration is approximately 8 seconds;
- Part 2 duration is approximately 4 seconds;
- sum equals the canonical 12-second duration within existing frame tolerance;
- audio RMS is non-zero at the beginning and end of each Part;
- first/last decoded timestamps show no missing or duplicated boundary frame.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pytest tests_v2/adapters/test_native_media_job.py tests_v2/adapters/ffmpeg/test_multipart_e2e.py -q
```

Expected: the pipeline still returns a single output or multipart duration
assertions fail.

- [ ] **Step 3: Make only integration corrections exposed by real media**

For every discovered bug, first narrow it to a focused failing regression test,
then adjust the responsible production code. Do not relax duration or audio
tolerances to hide a real defect.

- [ ] **Step 4: Run focused S3 suites**

```powershell
pytest tests_v2/config/test_config_types.py tests_v2/domain/test_pipeline.py tests_v2/domain/test_render_chunks.py tests_v2/application/test_render_chunks.py tests_v2/application/test_chunked_render.py tests_v2/application/test_multipart_publish.py tests_v2/application/test_offline_slice.py tests_v2/application/test_media_job.py tests_v2/adapters/test_native_media_job.py tests_v2/adapters/ffmpeg/test_multipart_e2e.py -q
Push-Location web
npm test -- --run
npm run lint
Pop-Location
```

Expected: zero failures and zero lint errors.

- [ ] **Step 5: Run complete repository verification**

```powershell
pytest -q
Push-Location web
npm test -- --run
npm run lint
npm run build
Pop-Location
git diff --check
git status --short
```

Expected: complete Python and web suites pass, production build succeeds, no
whitespace errors, and only intentional S3 paths are modified.

- [ ] **Step 6: Commit final evidence**

```powershell
git add -- tests_v2/adapters/test_native_media_job.py tests_v2/adapters/ffmpeg/test_multipart_e2e.py
git commit -m "test(render): verify multipart FFmpeg output end to end"
```

If Step 3 changed production files, stage their exact paths in the same commit
only when they are inseparable from the new failing regression.

---

### Task 12: Review, status, and integration handoff

**Files:**
- Create: `.superpowers/sdd/2026-07-28-render-s3-multipart/progress.md`
- Modify: `C:/Users/MrThien/.claude/projects/D--Dev-Projects-ytb-vps-scene/memory/render-module-status.md`

**Interfaces:**
- Durable completion evidence for the next session.

- [ ] **Step 1: Audit scope and history**

Run:

```powershell
git log --oneline origin/rebuild/v2..HEAD
git diff --stat origin/rebuild/v2...HEAD
git diff --check origin/rebuild/v2...HEAD
git status --short --branch
```

Confirm no unrelated workspace, YouTube, security, secrets, or connector files
entered the branch.

- [ ] **Step 2: Review against every acceptance criterion**

Record exact commands and counts proving:

- deterministic Part planning;
- independent chunk/Part resume;
- multi-OUTPUT Neon completion;
- READY remote Part replay;
- Drive identity;
- FFmpeg duration/audio/boundary behavior;
- full Python/web/lint/build results.

- [ ] **Step 3: Write durable progress evidence**

The ledger contains:

```markdown
# Render S3 Multipart Progress

- Branch and base SHA
- Commit table
- Acceptance-criterion evidence
- Focused/full test commands and counts
- Known deferred S4-S8 scope
- PR URL and merge SHA when available
```

Update external render memory to mark S3 complete only after verification.

- [ ] **Step 4: Commit repository ledger**

```powershell
git add -- .superpowers/sdd/2026-07-28-render-s3-multipart/progress.md
git commit -m "docs(render): record S3 multipart evidence"
```

- [ ] **Step 5: Finish the branch**

Invoke `superpowers:verification-before-completion`,
`superpowers:requesting-code-review`, then
`superpowers:finishing-a-development-branch`. Push only to
`https://github.com/manhthien2005/ytb-vps-scene` and open a PR targeting
`rebuild/v2`.
