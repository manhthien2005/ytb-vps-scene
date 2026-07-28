# Render S3 Multipart Design

Status: approved for specification by delegated product decision
Date: 2026-07-28
Branch: `codex/render-s3-multipart`
Starting commit: `294f5b7`

## 1. Goal

Turn the durable render chunks delivered by S2 into multiple independently
identified, assembled, published, uploaded, and verified output Parts.

S3 must preserve S2's chunk-level resume guarantees. A worker restart must reuse
verified render chunks and verified output Parts. A failure in one Part must not
force unrelated chunks to render again.

The complete path is in scope:

- Python domain planning and canonical documents;
- per-Part assembly and local publication;
- native worker progress and direct Drive upload;
- Neon output identity, fencing, and job completion;
- Drive file naming and application properties;
- focused, integration, migration, resume, and real-FFmpeg verification.

## 2. Existing state and gap

S2 already provides:

- deterministic `RenderChunk` values;
- one durable work unit and artifact per chunk;
- incremental remote checkpoints;
- verified stream-copy concatenation;
- resume after interruption or host loss;
- `Part`, `part_count`, `target_part_count()`, and multipart-capable
  `PublicationDocument` domain shapes;
- web progress fields `currentPart` and `totalParts`;
- deterministic web output naming through `outputPartFileName()`.

The active runtime is still single-output:

- `single_part_for_chunks()` assigns every chunk to `Part(1, 1)`;
- `ChunkedRenderCoordinator` concatenates every chunk into one file;
- `RenderPlanDocument` records one rendered path and digest;
- `LocalPartPublisher` rejects every Part except `1/1`;
- `run_native_pipeline()` and `MediaJobExecutor` return/upload one path;
- output-session and complete APIs hard-code Part `1/1`;
- Neon enforces one live OUTPUT per job;
- Drive output identity omits Part index and Part count.

## 3. Approaches considered

### 3.1 Split the final S2 file after global assembly

Render and concatenate the whole video as S2 does, then stream-copy time ranges
into output Parts.

Rejected. It duplicates the largest file, introduces a second boundary planner,
and makes a Part retry depend on the global assembled output. It does not make
Part identity a first-class render result.

### 3.2 Group verified S2 chunks into Parts

Plan Parts over the canonical ordered chunk sequence. Concatenate only the chunks
owned by each Part and commit one assembly unit per Part.

Selected. It preserves S2 chunk durability, makes boundaries exact, avoids
re-encoding, and lets a damaged Part be rebuilt without touching sibling Parts
or source chunks.

### 3.3 Render directly by Part

Replace chunk rendering with one encode per Part.

Rejected. It removes the chunk-level restart boundary delivered by S2 and repeats
too much work after interruption.

## 4. Product decisions

### 4.1 Automatic sizing

Part planning is automatic. S3 does not add a user-facing Part-count control.

- default maximum target: `1,800` seconds;
- configuration: `RenderConfig.max_part_seconds`;
- invariant: `max_part_seconds >= MediaConfig.chunk_seconds`;
- Part boundaries always coincide with render-chunk boundaries;
- a chunk extended by one unusually long cue may exceed the target and becomes a
  one-chunk Part rather than being split through the cue;
- a short video remains exactly one Part.

The target is therefore a packing ceiling for normal chunks, not permission to
cut an already planned render chunk.

### 4.2 Deterministic naming

Python and TypeScript use the same algorithm:

```text
width = max(2, decimal digits in part_count)
part-{part_index zero-padded to width}-of-{part_count zero-padded to width}.mp4
```

Examples:

- `part-01-of-01.mp4`
- `part-01-of-04.mp4`
- `part-012-of-120.mp4`

Local paths:

- assembled: `artifacts/render/parts/<part-name>`;
- published: `published/<part-name>`.

### 4.3 Part identity

A Part is identified by:

- job ID;
- render fingerprint;
- `part_index`;
- `part_count`;
- exact global frame interval;
- exact ordered chunk indexes;
- output size and SHA-256 after assembly.

The control-plane artifact UUID includes job ID, Part index, Part count, size,
and checksum. Two Parts with identical bytes still receive different identities.

## 5. Domain design

### 5.1 Part planner

Add `plan_parts_for_chunks()` beside `plan_render_chunks()`.

Inputs:

- canonical `frame_count`;
- canonical `target_fps`;
- positive `max_part_seconds`;
- the complete ordered chunk tuple.

Algorithm:

1. Verify chunks are indexed `0..N-1` and tile `[0, frame_count)`.
2. Compute `target_frames = target_fps * max_part_seconds`.
3. Greedily append whole chunks to the current Part while the result does not
   exceed `target_frames`.
4. If the next chunk would exceed the target, close the non-empty Part and start
   another.
5. If one chunk itself exceeds the target, place it alone.
6. Assign final one-based indexes and the same final `part_count` to every Part.

The result must tile the complete media interval and assign each render chunk
exactly once, in increasing order.

### 5.2 Rendered Part value

Add a frozen value:

```python
@dataclass(frozen=True, slots=True)
class RenderedPart:
    part: Part
    path: PurePosixPath
    digest: FileDigest
```

`RenderPlanDocument` replaces the single `rendered_path` and `rendered_digest`
contract with:

```python
rendered_parts: tuple[RenderedPart, ...]
```

The tuple must align exactly with `parts`. Paths and Part indexes are unique.

`PublicationDocument` keeps its existing aligned `parts`, `part_paths`, and
`part_digests` fields because that shape already represents multipart output.

### 5.3 Canonical document compatibility

The parser accepts the legacy S2 single-output RenderPlan shape only as migration
input. The resume layer recognizes it, invalidates the final RENDER, PUBLISH, and
BACKUP documents, and preserves verified `render:plan` and `render:NNNNNN` chunk
units.

The coordinator may accept an existing S2 chunk-plan artifact when its job,
fingerprint, chunk tuple, dimensions, dependency, and audio policy match the new
request. Its legacy synthetic `Part(1,1)` does not invalidate verified chunks.
Newly written chunk-plan documents contain the real multipart plan.

New canonical RenderPlan documents emit only `rendered_parts`; they never emit
the legacy singular fields.

## 6. Python execution design

### 6.1 Assembly units

After every render chunk is verified, create one work unit per Part:

```text
render:part:000001
render:part:000002
...
```

Each unit:

- belongs to `StageName.RENDER`;
- depends on the exact chunk work units owned by that Part;
- owns one `render-part-NNNNNN` artifact;
- validates the assembled media against a Part-local request;
- is independently reusable or invalidatable.

The final `render` unit depends on all Part assembly units and owns only the
canonical RenderPlan document. Media side artifacts remain owned by their Part
units.

### 6.2 Part-local validation

Add `part_local_request(global_request, part)`.

It rebases cue and blur intervals from the global frame interval to a local
`[0, part.frame_count)` timeline, clips values at the Part boundaries, and uses a
local `Part(1,1)` for FFmpeg validation. The global RenderPlan retains the
original Part identity and global intervals.

Assembly uses the existing verified stream-copy concat path over only the chunk
files named by the Part.

### 6.3 Local publication units

Create one auxiliary PUBLISH work unit per Part:

```text
publish:part:000001
publish:part:000002
...
```

Each unit depends on its matching render-Part unit and owns one published file.
The final `publish` unit depends on every publication unit and owns only the
canonical Publication document.

`LocalPartPublisher` accepts every valid Part and derives its path from the
shared deterministic naming function.

### 6.4 Native result

`run_native_pipeline()` returns an ordered tuple of immutable output descriptors:

```python
@dataclass(frozen=True, slots=True)
class MediaOutput:
    part_index: int
    part_count: int
    path: Path
```

The tuple must contain indexes `1..N`, use one common `part_count`, and point to
existing published files.

The CLI reports `renderedParts` and `publishedParts` arrays. It may retain the
legacy singular keys only when `N == 1`.

## 7. Worker and control-plane protocol

### 7.1 Worker upload loop

After rendering, the worker knows `totalParts`.

For each ordered output:

1. report `state=UPLOADING`, `currentPart=i`, `totalParts=N`;
2. renew the lease and honor cancellation before starting a new Part;
3. request an output session with Part index/count, size, and checksum;
4. skip byte upload when the API reports that the exact Part is already READY;
5. otherwise upload resumably and complete that Part;
6. continue while the completion outcome is `PART_COMPLETED`;
7. accept `COMPLETED` only for the final exact Part set.

A retry never re-renders chunks or re-uploads READY Parts with matching identity.

### 7.2 API request shapes

Output-session adds:

```json
{
  "partIndex": 1,
  "partCount": 4,
  "sizeBytes": 123,
  "checksumSha256": "<64 lowercase hex>"
}
```

Complete adds the same `partIndex` and `partCount` beside the existing artifact,
Drive file, fence, and size fields.

Both routes reject:

- indexes outside `1..partCount`;
- `partCount > 999`;
- Part metadata inconsistent with an existing live output for the job;
- Drive name or application properties that do not exactly match the Part.

### 7.3 Drive identity

`ensureOutputFile()` receives `partIndex` and `partCount`.

The file name uses `outputPartFileName(partIndex, partCount)`. Application
properties add:

```text
ytbVpsPartIndex
ytbVpsPartCount
```

The existing project, job, artifact, role, and schema properties remain.

## 8. Neon migration and repository semantics

Add schema migration v12:

- nullable integer columns `part_index` and `part_count`;
- backfill every existing non-deleted OUTPUT to `1/1`;
- require valid Part metadata for OUTPUT rows;
- keep Part columns null for non-OUTPUT rows;
- drop `artifacts_one_live_output_per_job_idx`;
- create a unique live index on `(job_id, part_index)` for OUTPUT rows.

Reservation rules:

- all live OUTPUT rows for one job must use the same `part_count`;
- exact READY identity returns `READY_REPLAY`;
- exact PENDING identity returns `PENDING_REPLAY`;
- a different PENDING artifact may be retired only for the same Part index;
- a different READY artifact for the same job/Part is immutable and rejects the
  reservation.

Completion is one transaction:

1. fence the active lease;
2. mark the exact PENDING Part READY;
3. count the exact READY set `1..partCount`;
4. if incomplete, keep job, worker, attempt, and lease active and return
   `PART_COMPLETED`;
5. if complete, mark the job COMPLETED, release worker and lease, close the
   attempt, and return `COMPLETED`.

Replaying an already READY Part returns `REPLAY` without mutation.

## 9. UI and query behavior

No new page or editor control is required for S3.

The existing job telemetry already carries Part progress, and the Drive workspace
already lists multiple output artifacts by their stored display names. Repository
queries must stop assuming a single OUTPUT row and must preserve stable ordering
by `part_index`.

The job remains non-terminal until every planned Part is READY.

## 10. Failure and resume behavior

- Render interruption: reuse all committed chunks and assembled Parts.
- One corrupt chunk: rerender that chunk, then invalidate/reassemble only Parts
  depending on it; PUBLISH and BACKUP refresh from the new RenderPlan.
- One corrupt assembled Part: reassemble only that Part.
- One corrupt local published Part: republish only that Part.
- Worker crash after remote Part 1 is READY: the next attempt skips Part 1 and
  resumes at the first non-READY Part.
- PENDING remote Part with matching identity: create a fresh resumable session
  for the same Drive file and continue safely.
- Lease loss: no further reservation, upload, or completion is authorized.
- Part-count mismatch: fail closed; never mix outputs from different plans under
  one job.

## 11. Testing strategy

### Domain

- exact 30-minute boundary;
- just over the boundary;
- multiple chunks packed greedily;
- a single oversized chunk;
- cue-extended chunk boundaries;
- invalid gaps, overlaps, indexes, and incomplete coverage;
- deterministic file naming parity with TypeScript examples;
- RenderPlan/Publication alignment and canonical parser rejection cases.

### Python application

- three verified chunks grouped into two Parts;
- Part-local interval rebasing;
- interruption after first Part commit resumes without render calls;
- corrupt one Part reassembles only that Part;
- corrupt one chunk rerenders it and only its owning Part;
- local publication produces every deterministic path;
- legacy S2 final document migration preserves verified chunks.

### Web/control plane

- migration backfill and new unique index;
- reserve two live Parts for one job;
- reject inconsistent totals and duplicate live Part indexes;
- READY and PENDING replay outcomes;
- complete an intermediate Part without completing the job;
- complete the exact final set atomically;
- deterministic artifact UUID differs by Part identity;
- Drive name and application properties include Part metadata;
- output-session/complete validation and lease-loss cases.

### End to end

- real FFmpeg fixture with three chunks and a test Part limit producing two
  stream-copy Parts;
- concatenated Part durations sum to the canonical duration;
- audio signal exists at the beginning and end of every Part;
- Part boundaries contain neither missing nor duplicated frames within the
  existing canonical duration tolerance;
- single-Part regression remains green;
- complete Python and web suites pass.

## 12. Out of scope

- user-selected Part count or manual boundaries;
- parallel heavy FFmpeg assembly;
- deleting S2 chunks before the final verified checkpoint;
- OCR, translation, TTS, ANALYZE, or scene-editor work from S4-S8;
- YouTube publishing policy;
- Publisher private-beta hardening work that happens to use the separate label
  “S3” in its own readiness document.

## 13. Acceptance criteria

S3 is complete when:

1. a long canonical timeline deterministically produces multiple Parts aligned
   to whole render chunks;
2. RenderPlan and Publication documents identify every Part and checksum;
3. local execution materializes and resumes each Part independently;
4. the native worker uploads ordered Parts with accurate progress;
5. Neon holds multiple live OUTPUT rows for one job and completes the job only
   after the exact Part set is READY;
6. Drive files have deterministic names and exact Part application properties;
7. a restart skips verified chunks, assembled Parts, and remote READY Parts;
8. legacy one-Part behavior remains valid;
9. focused, migration, integration, real-FFmpeg, Python, and web suites pass.
