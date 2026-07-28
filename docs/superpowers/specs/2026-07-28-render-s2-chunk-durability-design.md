# Render S2 Chunk Durability Design

Status: approved by delegated technical decision
Date: 2026-07-28
Branch: `rebuild/v2`
Starting commit: `e98ca14`

## 1. Goal

Make long-video rendering resumable at real render-chunk boundaries. A process
restart reuses every committed chunk. A restore after host loss resumes from the
latest remotely verified chunk checkpoint. Editing scene masks invalidates
RENDER and its downstream stages without repeating OCR, translation, or TTS.

S2 still publishes exactly one Part and one output file. Multipart publication
remains S3.

## 2. Current gap

S0+S1 removed the 30-second limit and connected the real FFmpeg render graph,
but the native runner still has one `render` work unit and one
`artifacts/render/rendered.mp4` side artifact for the entire video.

Consequences:

- interruption near the end of a long render repeats the whole render;
- SQLite cannot associate an artifact with a more specific owner than a stage;
- corruption of one future chunk would invalidate every RENDER artifact;
- checkpointing every chunk with the v1 object layout would copy every earlier
  chunk into a new checkpoint prefix, producing quadratic remote storage;
- stored configuration is immutable after `create_job`, so the existing
  invalidation planner is not connected to real job reconfiguration;
- native production fingerprints use `EffectiveConfig()` defaults and do not
  include the scene masks derived from the assignment.

## 3. Approaches considered

### 3.1 Metadata-only chunk progress

Keep one FFmpeg render and record synthetic chunk progress around it.

Rejected. It looks resumable in state but still repeats the whole encode after
an interruption. It does not satisfy the S2 acceptance criterion.

### 3.2 Real chunks plus multipart in one change

Render durable chunks and publish each group as a separate Part immediately.

Rejected for S2. It couples Python render changes to the web control plane,
Drive output ownership, job APIs, and UI. Those surfaces currently have
parallel changes and belong to S3.

### 3.3 Real chunks, one assembled output, incremental checkpoints

Selected. Render each bounded interval into an independently validated artifact,
checkpoint after every committed chunk, concatenate only after all chunks
succeed, and keep the existing single-Part publication contract.

This delivers the durability boundary without expanding into multipart or UI.

## 4. Scope

### Included

- deterministic render-chunk planning on the canonical frame timeline;
- real per-chunk FFmpeg render, validation, artifact commit, and resume;
- a dependency-aware work-unit graph for plan, chunks, assembly, publish, and
  backup;
- SQLite schema migration for exact artifact-to-work-unit ownership;
- an incremental checkpoint layout that reuses immutable remote objects;
- backwards-compatible restore of checkpoint manifest v1;
- scene-derived RENDER fingerprints and atomic job reconfiguration;
- per-chunk and pre-concatenation disk-space guards;
- fault-injection, corruption, restore, and real-FFmpeg tests.

### Excluded

- multipart output and web/control-plane changes (S3);
- real OCR, translation, or per-group TTS changes (S4-S6);
- scene-editor UI and automatic region analysis (S7-S8);
- deletion of committed chunk artifacts before the final durable checkpoint;
- parallel execution of heavyweight render chunks;
- automatic cleanup enablement.

## 5. Domain contracts

### 5.1 `RenderChunk`

Add a frozen domain value:

```python
@dataclass(frozen=True, slots=True)
class RenderChunk:
    index: int
    interval: FrameInterval
```

Invariants:

- `index` is an exact non-negative integer;
- `interval` is an exact, non-empty `FrameInterval`;
- a complete plan has indexes `0..N-1`;
- intervals tile `[0, frame_count)` with no gap or overlap.

### 5.2 Chunk planner

Add:

```python
def plan_render_chunks(
    *,
    frame_count: int,
    target_fps: int,
    chunk_seconds: int,
    cues: tuple[Cue, ...],
) -> tuple[RenderChunk, ...]:
```

The nominal boundary is `chunk_seconds * target_fps`. If it falls strictly
inside an active cue, move it forward to that cue's end. Repeat until the
boundary no longer splits a cue. The final chunk ends exactly at
`frame_count`.

A single cue longer than the target is allowed to produce one larger chunk.
The planner never shortens or splits the cue and never creates an empty chunk.

S6 is responsible for adding indivisible TTS-group intervals to the same
boundary planner. S2 does not invent group timing that the current
`TtsDocument` does not carry.

### 5.3 Canonical chunk-plan document

Add `RenderChunkPlanDocument` at:

`artifacts/render/chunk-plan.json`

It contains:

- normal pipeline identity and the exact TTS document dependency;
- the RENDER fingerprint used to create the plan;
- the ordered `RenderChunk` tuple;
- the single S2 `Part(1, 1, [0, frame_count), all_chunk_indexes)`;
- output audio policy.

Canonical JSON stays closed, duplicate-key rejecting, and byte-stable.

The plan is owned by work unit `render:plan`. Chunk units depend on it. This
makes the chunk graph durable before the first expensive encode and prevents a
resume from silently accepting a different plan.

## 6. Work-unit and artifact graph

The S2 graph is:

```text
tts
  -> render:plan
       -> render:000000
       -> render:000001
       -> ...
            -> render
                 -> publish
                      -> backup
```

`render` remains the final assembly unit so existing stage-level result and
publication contracts stay recognizable.

Each chunk unit owns exactly one media artifact:

```text
name: render-chunk-000000
path: artifacts/render/chunks/chunk-000000.mp4
```

The assembly unit owns:

- `artifacts/render/render-plan.json`;
- `artifacts/render/rendered.mp4`.

Work-unit dependencies are persisted as typed, ordered, unique keys. The state
repository exposes unit-level invalidation with dependent closure.

Two invalidation modes remain distinct:

- configuration change: invalidate every work unit whose stage is affected;
- missing/corrupt artifact: invalidate only its owner unit and dependent units.

Therefore corruption of `render:000007` preserves all other successful chunks,
but invalidates `render`, `publish`, and `backup`.

## 7. SQLite schema version 3

Migration 3 adds:

1. `work_unit_dependencies(job_id, unit_key, depends_on_key)` with foreign keys
   to `work_units`;
2. `unit_key` ownership on `artifacts`, with a composite foreign key to
   `work_units`;
3. indexes for owner-unit lookup and reverse dependency traversal.

Existing v2 artifact rows are migrated with `unit_key = lower(owner_stage)`,
which matches the current stage work-unit keys. Migration is transactional and
must preserve every checksum, status, attempt count, and checkpoint record.
When an existing job next runs, `_ensure_units` fills and verifies the
dependency edges that did not exist in schema v2 before any work starts.

Artifact recommit ambiguity is evaluated per owner unit, not per stage. This is
required for independently invalidated chunks to recommit one at a time.

## 8. Atomic job reconfiguration

The state port gains:

```python
def stored_config_fingerprints(
    job_id: JobId,
) -> tuple[StageConfigFingerprint, ...] | None: ...

def reconfigure_job(
    job_id: JobId,
    previous: tuple[StageConfigFingerprint, ...],
    current: tuple[StageConfigFingerprint, ...],
    invalidation: InvalidationPlan,
    at: str,
) -> tuple[str, ...]: ...
```

`reconfigure_job` performs one SQLite transaction:

1. compare the stored snapshot with `previous`;
2. invalidate affected work units and artifacts;
3. update every stored stage fingerprint;
4. return invalidated unit keys.

A mismatch is a concurrency error. The transaction changes nothing.

For a new job, `create_job` keeps its current behavior. For an existing job,
the runner reads the stored snapshot, calculates `plan_invalidation`, and calls
`reconfigure_job` before resume validation.

## 9. RENDER fingerprint join

Add a typed `RenderFingerprintInputs` value containing:

- canonical `blur_regions`;
- output audio policy.

`stage_config_fingerprints` accepts that value and hashes the RENDER projection
as:

```text
(
  media.chunk_seconds,
  render_config,
  render_fingerprint_inputs,
)
```

The TTS rate and voice are represented in `TtsConfig`, not duplicated into the
RENDER projection. The TTS artifact digest remains the runtime dependency of
the chunk plan.

The native runner constructs the effective TTS configuration from the actual
accepted assignment instead of using a default-only `EffectiveConfig()`.

Expected closures:

- blur/logo geometry, enabled state, or time range change:
  `RENDER -> PUBLISH -> BACKUP`;
- render style change: `RENDER -> PUBLISH -> BACKUP`;
- `media.chunk_seconds` change: direct ownership by OCR and RENDER, therefore
  the closure begins at `OCR` while the setting remains shared;
- voice/rate change:
  `TTS -> RENDER -> PUBLISH -> BACKUP`;
- OCR settings change:
  `OCR -> TRACK -> TRANSLATE -> TTS -> RENDER -> PUBLISH -> BACKUP`.

Only pixel- or audio-affecting normalized values enter the hash. UI labels,
region IDs, preset display names, and `sourceArtifactId` do not.

## 10. FFmpeg chunk rendering

The media port adds explicit methods:

```python
def render_chunk(
    source: Path,
    tts_wav: Path,
    plan: RenderRequest,
    chunk: RenderChunk,
    destination: Path,
) -> MediaDocument: ...

def concatenate_render_chunks(
    chunks: tuple[Path, ...],
    plan: RenderRequest,
    destination: Path,
) -> MediaDocument: ...
```

`render_chunk` first probes the complete canonical source and verifies it
against the global plan. It then derives a chunk-local request:

- local frame count equals the chunk interval length;
- cues and masks are intersected with the chunk and rebased to frame zero;
- the local Part covers the entire local interval;
- source video/audio and the current full-timeline TTS audio are sought to the
  chunk start and bounded to the exact chunk duration;
- all filter timestamps are chunk-local.

The adapter must produce valid audio even when the selected TTS slice has no
samples. Source audio or explicit silence continues through the entire chunk.

Each chunk uses identical codec, timebase, geometry, color, audio sample rate,
channel count, and metadata settings. Concatenation uses an escaped manifest
file and stream copy. The final output is fully decoded, probed, and validated
against the global render request before atomic publication.

Seeking is input-side accurate seek on the already canonical CFR source. The
chunk-local graph intentionally evaluates time from zero; no global `enable=`
expression is applied after timestamps have been rebased.

The existing whole-file `render` method remains during S2 for compatibility
tests and delegates to the same graph-building primitives. The native runner
uses only `render_chunk` plus `concatenate_render_chunks`.

## 11. Durable chunk execution

For each planned chunk, in index order:

1. verify whether its work unit is already `SUCCEEDED`;
2. if succeeded, verify its exact artifact checksum and semantic media
   contract;
3. if missing or corrupt, invalidate that unit and its dependents;
4. check free disk space using three times the estimated chunk bytes, where
   estimate is
   `max(16 MiB, ceil(source_size * chunk_frames / total_frames))`;
5. start the chunk work unit;
6. render to an owned temporary path;
7. fully decode and validate the chunk;
8. atomically publish the local artifact;
9. commit the artifact and `SUCCEEDED` status in one SQLite transaction;
10. publish and remotely verify the chunk checkpoint.

An interruption before step 9 leaves the unit retryable and no committed
artifact. An interruption after step 9 reuses the local chunk. If the host is
lost before step 10 completes, restore falls back to the preceding checkpoint
and rerenders at most one chunk.

Before concatenation, the runner checks free disk space using
`ceil(sum(committed_chunk_sizes) * 5 / 2)`.

## 12. Checkpoint manifest version 2

Manifest v2 retains the existing manifest fields and `ManifestEntry` values,
but uses two object namespaces:

- checkpoint-specific metadata:
  `checkpoints/<job-token>/<checkpoint-token>/...`;
- stable immutable content:
  `objects/<job-token>/input/<sha256>` and
  `objects/<job-token>/workspace/<relative-path>/<sha256>`.

Every chunk checkpoint has a new manifest and SQLite snapshot, but previously
uploaded input/artifact objects reuse the same additive keys. Repeated
publication verifies the exact existing object instead of copying it.

The publisher starts from the newest verified v2 manifest. An unchanged entry
whose stable key and digest are already present is verified remotely and reused
without rehashing or re-uploading the local file. Only new or changed entries
perform the full local verification and upload path. Thus both remote bytes and
local checkpoint I/O grow linearly with committed artifacts.

The canonical parser accepts manifest versions 1 and 2. New publications write
version 2. Restore dispatches layout validation by version:

- v1 preserves the existing checkpoint-prefix layout;
- v2 derives stable object keys from the staged SQLite artifact rows and their
  digests.

This keeps existing checkpoints restorable and makes total remote video storage
linear in the number of chunks.

Checkpoint IDs include the chunk index, render fingerprint token, and committed
chunk digest token. They are deterministic, additive, and shorter than the
existing 128-character limit.

## 13. Failure and concurrency behavior

- stale `RUNNING` plan/chunk/assembly work returns to `PENDING`;
- two processes racing to reconfigure the same job fail compare-and-swap
  without partially updating fingerprints;
- an existing chunk path with the wrong digest is never overwritten in place;
- a changed chunk plan invalidates every old RENDER unit before new chunk
  artifacts are accepted;
- a checkpoint is complete only after manifest read-back and remote verification;
- concat never starts until every planned chunk is `SUCCEEDED` and verified;
- PUBLISH and BACKUP cannot reuse outputs after any upstream chunk changes;
- unrelated OCR, translation, and TTS artifacts remain valid after scene-only
  changes.

## 14. Testing strategy

### Domain

- exact tiling at zero remainder, short final chunk, and one-frame tail;
- boundary moves forward across overlapping cues;
- a cue longer than the target creates one bounded-by-cue chunk;
- malformed indexes, gaps, overlaps, booleans, and out-of-range intervals fail;
- canonical chunk-plan serialization round-trips and rejects unknown or
  duplicate fields.

### SQLite and invalidation

- real v2 database migrates to v3 with exact artifact ownership;
- artifact recommit is scoped to one chunk unit;
- reverse dependency invalidation preserves sibling chunks;
- scene-only reconfiguration invalidates RENDER/PUBLISH/BACKUP;
- compare-and-swap failure rolls back both invalidation and fingerprints.

### Checkpoint and restore

- v1 checkpoint fixture remains restorable;
- v2 checkpoint restores into an empty workspace;
- N chunk checkpoints store each chunk media object once;
- failure before/after each object publication is retryable;
- restore from checkpoint K reuses chunks `0..K` and renders only `K+1..N-1`.

### Real FFmpeg

- chunk duration and frame count are exact;
- timed masks crossing a chunk boundary are active on both sides;
- subtitles crossing a boundary remain visible for their full interval;
- source audio is present in every chunk;
- a TTS slice that has ended still yields valid source audio or silence;
- concatenated duration, FPS, geometry, audio policy, and full decode match the
  global plan;
- frames immediately before and after every seam show no missing/duplicated
  frame.

### Fault injection

Interrupt each chunk:

- before provider work;
- after FFmpeg returns;
- after local artifact publication;
- after SQLite commit;
- during checkpoint publication.

Every resumed result must be semantically identical to an uninterrupted run,
and already committed sibling chunks must keep their attempt counts and
checksums.

## 15. Acceptance criteria

S2 is complete when:

1. a multi-chunk real video renders and publishes as one valid Part;
2. killing the worker at every chunk boundary rerenders no successful chunk;
3. restoring the latest chunk checkpoint into an empty workspace completes the
   same output;
4. corrupting one chunk rerenders only that chunk plus assembly/downstream work;
5. editing a mask invalidates RENDER/PUBLISH/BACKUP but preserves OCR,
   translation, and TTS;
6. repeated chunk checkpoints do not duplicate committed media objects;
7. the complete `tests_v2` suite passes;
8. no `web/`, legacy `app/ytb_vps/`, or control-plane behavior changes.
