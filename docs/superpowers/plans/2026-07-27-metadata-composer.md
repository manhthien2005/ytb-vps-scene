# Metadata Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a render completes, give the operator everything needed to publish the video by hand — an AI-drafted title, description and tags built from that episode's own translated subtitles, plus eight clean candidate thumbnail frames and a ready-to-paste image prompt.

**Architecture:** The worker gains two extra outputs at the end of a render — the translated subtitle text and eight JPEG frames — both uploaded straight to Drive through a new fenced `aux-session` endpoint that mirrors the existing output-session flow. The control plane reads the subtitle text back (text only, hard-capped), condenses it, and asks Gemini 3.5 Flash Lite for structured metadata using the per-channel prompts stored by the previous plan. Nothing but text crosses the control plane.

**Tech Stack:** Python 3.10–3.12 (hexagonal `domain`/`adapters`), FFmpeg, Next.js 16, TypeScript 5.8, Neon Postgres, Zod 4, Vitest 3, pytest. No new npm dependencies; no new Python dependencies beyond what the OCR path already installs.

## Global Constraints

- **Prerequisite:** `docs/superpowers/plans/2026-07-27-youtube-channels-and-stats.md` must be complete. This plan reads `youtube_channels.title_prompt` / `description_prompt` / `description_template` / `default_tags` / `thumbnail_prompt_template`, and relies on migration v11 having already widened `artifacts.kind` to accept `'TRANSCRIPT'` and `'THUMB_CANDIDATE'`.
- **The control plane never receives video or image bytes.** Frames and subtitles go worker → Drive directly. The control plane reads back only the subtitle text, capped at 2 MB.
- **`googleJson` cannot be reused for Gemini** — it caps `timeoutMs` at 5000 ms and `maxResponseBytes` at 65536. Gemini needs a separate bounded helper.
- **Frames are cut from the source video, never the output.** The output has Vietnamese subtitles and blur regions burned in.
- **No new npm dependencies.** Gemini is called with `fetch`.
- **`GEMINI_API_KEY` is server-only.** It must never appear in a client component or an API response.
- Python commands run from the repo root: `pytest`. Web commands run from `web/`: `npm test`, `npm run typecheck`, `npm run lint`.

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `src/ytb_vps_v2/domain/thumbnail_frames.py` | Pure frame-index selection from cue/blur intervals. No I/O. |
| `tests_v2/domain/test_thumbnail_frames.py` | Tests for the above. |
| `src/ytb_vps_v2/adapters/ffmpeg/frame_candidates.py` | Extract and score the chosen frames. |
| `src/ytb_vps_v2/adapters/control_plane/aux_upload.py` | Upload transcript + frames via `aux-session`. |
| `web/src/app/api/v1/worker/jobs/[id]/aux-session/route.ts` | Fenced resumable session for aux artifacts. |
| `web/src/lib/domain/transcript.ts` | Pure transcript condensation. |
| `web/src/lib/adapters/gemini/http.ts` | Bounded fetch helper for Gemini. |
| `web/src/lib/adapters/gemini/compose.ts` | The metadata composer adapter. |
| `web/src/lib/ports/composer.ts` | `MetadataComposerPort`. |
| `web/src/lib/repositories/neon-publication.ts` | Draft persistence. |
| `web/src/lib/application/compose-metadata.ts` | Orchestrates read → condense → compose → save. |
| `web/src/app/api/v1/publications/[jobId]/route.ts` | Read and update a draft. |
| `web/src/app/api/v1/publications/[jobId]/compose/route.ts` | Run the composer. |
| `web/src/components/publication-editor.tsx` | The per-video editor. |
| `web/src/components/thumbnail-picker.tsx` | The 8-frame grid. |
| `web/src/components/copy-field.tsx` | Labelled field with counter + copy button. |
| `web/src/components/publish-surface.tsx` | The surface. |

**Modify**

| Path | Change |
|---|---|
| `web/src/lib/db/schema.sql` | Append migration v12 (`publication_drafts`). |
| `web/src/lib/ports/drive.ts` | Add `readTextFile`. |
| `web/src/lib/adapters/google/drive-files.ts` | Implement `readTextFile`. |
| `web/src/lib/config/env.ts` | Add `GEMINI_API_KEY`. |
| `web/src/lib/domain/errors.ts` | Add composer error codes. |
| `web/src/components/dashboard-shell.tsx`, `dashboard-types.ts` | Add the `publish` surface. |
| `src/ytb_vps_v2/adapters/native_media_job.py` | Call the aux upload after render. |
| `web/.env.example`, `web/README.md` | Document `GEMINI_API_KEY`. |

---

## Task 1: Pure frame selection

This is the highest-value unit in the plan and the only one that can be tested without a video file, FFmpeg, or a network.

**Files:**
- Create: `src/ytb_vps_v2/domain/thumbnail_frames.py`
- Test: `tests_v2/domain/test_thumbnail_frames.py`

**Interfaces:**
- Consumes: `FrameInterval` from `ytb_vps_v2.domain.timeline`; `Cue`, `BlurRegion` from `ytb_vps_v2.domain.models`.
- Produces:
  ```python
  def pick_candidate_frames(
      duration_frames: int,
      cues: Sequence[Cue],
      blur_regions: Sequence[BlurRegion],
      count: int = 8,
      head_fraction: float = 0.05,
      tail_fraction: float = 0.08,
  ) -> list[int]
  ```
  Returns a strictly increasing list of frame indices, length ≤ `count`. `FrameInterval` is half-open: `start_frame` inclusive, `end_frame` exclusive.

- [ ] **Step 1: Write the failing test**

Create `tests_v2/domain/test_thumbnail_frames.py`:

```python
from __future__ import annotations

import pytest

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, Cue, RegionKind
from ytb_vps_v2.domain.thumbnail_frames import pick_candidate_frames
from ytb_vps_v2.domain.timeline import FrameInterval


def _box() -> BoundingBox:
    return BoundingBox(xmin=0, ymin=0, xmax=10, ymax=10)


def _cue(index: int, start: int, end: int) -> Cue:
    return Cue(
        cue_index=index,
        interval=FrameInterval(start_frame=start, end_frame=end),
        box=_box(),
        source_text="text",
    )


def _blur(start: int, end: int) -> BlurRegion:
    return BlurRegion(
        kind=RegionKind.DYNAMIC,
        interval=FrameInterval(start_frame=start, end_frame=end),
        box=_box(),
    )


def test_returns_requested_count_when_the_video_is_clean() -> None:
    frames = pick_candidate_frames(duration_frames=10_000, cues=(), blur_regions=(), count=8)

    assert len(frames) == 8
    assert frames == sorted(frames)
    assert len(set(frames)) == 8


def test_skips_the_head_and_tail_margins() -> None:
    frames = pick_candidate_frames(duration_frames=10_000, cues=(), blur_regions=(), count=8)

    assert min(frames) >= 500
    assert max(frames) < 9_200


def test_never_returns_a_frame_covered_by_a_cue() -> None:
    cues = [_cue(1, 500, 5_000), _cue(2, 5_100, 9_200)]

    frames = pick_candidate_frames(duration_frames=10_000, cues=cues, blur_regions=(), count=8)

    assert frames == [5_050]


def test_never_returns_a_frame_covered_by_a_blur_region() -> None:
    blur = [_blur(500, 9_000)]

    frames = pick_candidate_frames(duration_frames=10_000, cues=(), blur_regions=blur, count=8)

    assert all(frame >= 9_000 for frame in frames)


def test_treats_frame_intervals_as_half_open() -> None:
    cues = [_cue(1, 500, 9_199)]

    frames = pick_candidate_frames(duration_frames=10_000, cues=cues, blur_regions=(), count=8)

    assert frames == [9_199]


def test_returns_empty_when_every_usable_frame_is_covered() -> None:
    cues = [_cue(1, 0, 10_000)]

    assert pick_candidate_frames(duration_frames=10_000, cues=cues, blur_regions=(), count=8) == []


def test_spreads_candidates_across_the_timeline() -> None:
    frames = pick_candidate_frames(duration_frames=100_000, cues=(), blur_regions=(), count=4)

    gaps = [second - first for first, second in zip(frames, frames[1:])]
    assert min(gaps) > 10_000


def test_rejects_a_video_too_short_to_sample() -> None:
    assert pick_candidate_frames(duration_frames=5, cues=(), blur_regions=(), count=8) == []


def test_rejects_invalid_arguments() -> None:
    with pytest.raises(DomainInvariantError):
        pick_candidate_frames(duration_frames=-1, cues=(), blur_regions=(), count=8)
    with pytest.raises(DomainInvariantError):
        pick_candidate_frames(duration_frames=10_000, cues=(), blur_regions=(), count=0)
    with pytest.raises(DomainInvariantError):
        pick_candidate_frames(
            duration_frames=10_000, cues=(), blur_regions=(), count=8, head_fraction=0.9,
        )
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests_v2/domain/test_thumbnail_frames.py -v`
Expected: FAIL — `ModuleNotFoundError: ytb_vps_v2.domain.thumbnail_frames`.

- [ ] **Step 3: Implement**

Create `src/ytb_vps_v2/domain/thumbnail_frames.py`:

```python
from __future__ import annotations

from collections.abc import Sequence

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BlurRegion, Cue
from ytb_vps_v2.domain.timeline import FrameInterval

_MIN_SAMPLE_SPAN_FRAMES = 10


def _merge(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            previous_start, previous_end = merged[-1]
            merged[-1] = (previous_start, max(previous_end, end))
        else:
            merged.append((start, end))
    return merged


def _clean_gaps(low: int, high: int, blocked: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Half-open [low, high) minus every blocked half-open interval."""
    gaps: list[tuple[int, int]] = []
    cursor = low
    for start, end in blocked:
        if end <= cursor or start >= high:
            continue
        if start > cursor:
            gaps.append((cursor, min(start, high)))
        cursor = max(cursor, end)
        if cursor >= high:
            break
    if cursor < high:
        gaps.append((cursor, high))
    return [(start, end) for start, end in gaps if end > start]


def pick_candidate_frames(
    duration_frames: int,
    cues: Sequence[Cue],
    blur_regions: Sequence[BlurRegion],
    count: int = 8,
    head_fraction: float = 0.05,
    tail_fraction: float = 0.08,
) -> list[int]:
    if isinstance(duration_frames, bool) or not isinstance(duration_frames, int):
        raise DomainInvariantError("Duration frames must be an integer")
    if duration_frames < 0:
        raise DomainInvariantError("Duration frames must be non-negative")
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise DomainInvariantError("Candidate count must be a positive integer")
    for name, fraction in (("Head", head_fraction), ("Tail", tail_fraction)):
        if isinstance(fraction, bool) or not isinstance(fraction, (int, float)):
            raise DomainInvariantError(f"{name} fraction must be a number")
        if not 0.0 <= fraction < 0.5:
            raise DomainInvariantError(f"{name} fraction must be in [0, 0.5)")
    if head_fraction + tail_fraction >= 1.0:
        raise DomainInvariantError("Head and tail fractions must leave a usable span")

    low = int(duration_frames * head_fraction)
    high = duration_frames - int(duration_frames * tail_fraction)
    if high - low < _MIN_SAMPLE_SPAN_FRAMES:
        return []

    blocked = _merge([
        (interval.start_frame, interval.end_frame)
        for interval in _intervals(cues, blur_regions)
    ])
    gaps = _clean_gaps(low, high, blocked)
    if not gaps:
        return []

    chosen: list[int] = []
    span = high - low
    for index in range(count):
        window_start = low + span * index // count
        window_end = low + span * (index + 1) // count
        frame = _best_frame(gaps, window_start, window_end)
        if frame is not None and frame not in chosen:
            chosen.append(frame)
    if not chosen:
        widest = max(gaps, key=lambda gap: gap[1] - gap[0])
        chosen.append((widest[0] + widest[1]) // 2)
    return sorted(chosen)


def _intervals(
    cues: Sequence[Cue], blur_regions: Sequence[BlurRegion]
) -> list[FrameInterval]:
    return [cue.interval for cue in cues] + [region.interval for region in blur_regions]


def _best_frame(
    gaps: list[tuple[int, int]], window_start: int, window_end: int
) -> int | None:
    """Midpoint of the longest clean gap overlapping this window."""
    best: tuple[int, int] | None = None
    for start, end in gaps:
        overlap_start = max(start, window_start)
        overlap_end = min(end, window_end)
        if overlap_end <= overlap_start:
            continue
        if best is None or overlap_end - overlap_start > best[1] - best[0]:
            best = (overlap_start, overlap_end)
    if best is None:
        return None
    return (best[0] + best[1]) // 2
```

- [ ] **Step 4: Run the test**

Run: `pytest tests_v2/domain/test_thumbnail_frames.py -v`
Expected: PASS, all ten cases.

- [ ] **Step 5: Run the whole Python suite**

Run: `pytest`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/ytb_vps_v2/domain/thumbnail_frames.py tests_v2/domain/test_thumbnail_frames.py
git commit -m "feat(domain): pick clean thumbnail frames from the cue and blur timeline"
```

---

## Task 2: Frame extraction and scoring

**Files:**
- Create: `src/ytb_vps_v2/adapters/ffmpeg/frame_candidates.py`
- Test: `tests_v2/adapters/test_frame_candidates.py`

**Interfaces:**
- Consumes: `pick_candidate_frames` from Task 1.
- Produces:
  ```python
  @dataclass(frozen=True, slots=True)
  class ScoredFrame:
      frame_index: int
      path: Path
      score: float

  def extract_candidates(
      source: Path,
      workspace: Path,
      frame_indices: Sequence[int],
      fps: Fraction,
      ffmpeg: str,
      keep: int = 8,
  ) -> list[ScoredFrame]
  ```

- [ ] **Step 1: Write the failing test**

Create `tests_v2/adapters/test_frame_candidates.py`. Use the existing short fixture clip in `tests_v2/` (find it with `grep -rn "fixture" tests_v2/adapters | head`), and mark the extraction case with the same FFmpeg-availability guard the other adapter tests use. Cover:

```python
def test_extracts_one_jpeg_per_requested_frame(tmp_path) -> None: ...
def test_keeps_only_the_highest_scoring_frames(tmp_path) -> None: ...
def test_drops_a_fully_black_frame(tmp_path) -> None: ...
def test_returns_empty_for_an_empty_index_list(tmp_path) -> None: ...
```

Write each body out in full. The scoring cases can call the scoring function directly on synthetic images so they run without FFmpeg.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests_v2/adapters/test_frame_candidates.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/ytb_vps_v2/adapters/ffmpeg/frame_candidates.py`:

- One FFmpeg invocation per frame: `ffmpeg -nostdin -ss <seconds> -i <source> -frames:v 1 -q:v 3 -y <out.jpg>` where `seconds = frame_index / fps`. Seeking before `-i` is the fast path and is accurate enough for a thumbnail.
- Drain both stdout and stderr — `docs/11-DOI-CHIEU-CROSS-REVIEW.md` §M-05 records that undrained FFmpeg stderr has deadlocked this codebase before.
- Score each written JPEG:
  - mean luma outside `[35, 225]` ⇒ score `0.0` (reject; too dark or blown out)
  - sharpness = variance of the Laplacian; normalise and weight `0.6`
  - colourfulness = mean saturation; weight `0.2`
  - face detected by OpenCV's bundled frontal-face Haar cascade ⇒ `+0.2`
- Import OpenCV lazily inside the scoring function and degrade to sharpness-only if the import fails, so a worker without OpenCV still produces frames.
- Sort by score descending, keep `keep`, delete the rejected files, return sorted by `frame_index`.

- [ ] **Step 4: Run the test**

Run: `pytest tests_v2/adapters/test_frame_candidates.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ytb_vps_v2/adapters/ffmpeg/frame_candidates.py tests_v2/adapters/test_frame_candidates.py
git commit -m "feat(ffmpeg): extract and score candidate thumbnail frames"
```

---

## Task 3: Migration v12 and the draft repository

**Files:**
- Modify: `web/src/lib/db/schema.sql`
- Create: `web/src/lib/repositories/neon-publication.ts`
- Test: `web/src/lib/db/schema.test.ts`, `web/src/lib/repositories/neon-publication.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PublicationDraft = Readonly<{
    id: string; jobId: string; channelId: string | null;
    title: string | null; description: string | null; tags: readonly string[];
    thumbnailPrompt: string | null; chosenThumbArtifactId: string | null;
    status: "DRAFT" | "READY" | "PUBLISHED";
    youtubeVideoUrl: string | null; composedAt: string | null;
  }>;
  export interface PublicationRepository {
    getByJobId(jobId: string): Promise<PublicationDraft | null>;
    upsert(input: Readonly<{ jobId: string } & Partial<Omit<PublicationDraft, "id" | "jobId">>>): Promise<PublicationDraft>;
    listPublishable(): Promise<readonly Readonly<{ jobId: string; projectName: string; draft: PublicationDraft | null }>[]>;
  }
  ```

- [ ] **Step 1: Write the failing migration test**

Append to `web/src/lib/db/schema.test.ts`:

```ts
it("migration v12 creates publication_drafts with YouTube field limits", async () => {
  const db = await migratedDatabase();

  const version = await db.query<{ count: number }>(
    "select count(*)::int as count from schema_migrations where version = 12",
  );
  expect(version.rows[0]!.count).toBe(1);

  await db.exec(`insert into jobs (id, project_name, state) values ('job-1', 'P', 'COMPLETED')`);
  await db.exec(`
    insert into publication_drafts (id, job_id, status, tags)
    values ('44444444-4444-4444-8444-444444444444', 'job-1', 'DRAFT', '[]'::jsonb)
  `);

  await expect(db.exec(`
    update publication_drafts set title = repeat('x', 101)
    where id = '44444444-4444-4444-8444-444444444444'
  `)).rejects.toThrow();

  await expect(db.exec(`
    insert into publication_drafts (id, job_id, status, tags)
    values ('55555555-5555-4555-8555-555555555555', 'job-1', 'DRAFT', '[]'::jsonb)
  `)).rejects.toThrow();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/db/schema.test.ts -t "migration v12"`
Expected: FAIL — `relation "publication_drafts" does not exist`.

- [ ] **Step 3: Append migration v12**

```sql
-- migration v12: per-video publication drafts for the manual publishing workflow
create table if not exists publication_drafts (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  job_id text not null unique references jobs(id),
  channel_id text references youtube_channels(id),
  title text check (title is null or length(title) between 1 and 100),
  description text check (description is null or length(description) <= 5000),
  tags jsonb not null default '[]'::jsonb check (
    jsonb_typeof(tags) = 'array' and pg_column_size(tags) <= 2048
  ),
  thumbnail_prompt text check (thumbnail_prompt is null or length(thumbnail_prompt) <= 4000),
  chosen_thumb_artifact_id text references artifacts(id),
  status text not null check (status in ('DRAFT','READY','PUBLISHED')),
  youtube_video_url text check (
    youtube_video_url is null
    or (length(youtube_video_url) between 1 and 512 and youtube_video_url like 'https://%')
  ),
  composed_at timestamptz,
  published_marked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'PUBLISHED') = (published_marked_at is not null))
);
create index if not exists publication_drafts_status_idx on publication_drafts(status);

insert into schema_migrations(version) values (12) on conflict (version) do nothing;
```

- [ ] **Step 4: Write the repository test, then the repository**

Create `web/src/lib/repositories/neon-publication.test.ts` mirroring `neon-youtube-control-plane.test.ts`. Cover: upsert creates then updates the same row; `getByJobId` returns null for an unknown job; `listPublishable` returns completed jobs whose draft is still absent or not `PUBLISHED`; marking `PUBLISHED` without a URL is allowed but without `published_marked_at` is rejected by the DB.

Then implement `web/src/lib/repositories/neon-publication.ts`.

- [ ] **Step 5: Run and commit**

Run: `cd web && npx vitest run src/lib/db/schema.test.ts src/lib/repositories/neon-publication.test.ts`

```bash
git add web/src/lib/db/schema.sql web/src/lib/db/schema.test.ts web/src/lib/repositories/neon-publication.ts web/src/lib/repositories/neon-publication.test.ts
git commit -m "feat(db): add publication drafts"
```

---

## Task 4: The aux-session worker endpoint

**Files:**
- Create: `web/src/app/api/v1/worker/jobs/[id]/aux-session/route.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `requireWorkerSession`, `getFencedExecution`, `createConfiguredDrive` — all already used by `output-session/route.ts`.
- Produces: `POST /api/v1/worker/jobs/:id/aux-session` accepting
  ```ts
  { fencingToken: number; kind: "TRANSCRIPT" | "THUMB_CANDIDATE"; ordinal: number;
    sizeBytes: number; checksumSha256: string; mimeType: "text/plain" | "image/jpeg" }
  ```
  and returning `{ artifactId, driveFileId, sessionUri, expiresAt }`.

- [ ] **Step 1: Read the route being mirrored**

Run: `cd web && cat src/app/api/v1/worker/jobs/\[id\]/output-session/route.ts`

Copy its structure exactly, including the comment explaining why a stale lease must not delete the Drive file.

- [ ] **Step 2: Write the failing test**

Create the sibling `.test.ts` covering:

```ts
it("rejects a request without a worker session", async () => { /* 401 WORKER_AUTH_REQUIRED */ });
it("rejects a stale fencing token", async () => { /* 409 LEASE_LOST */ });
it("derives a stable artifact id for the same kind and ordinal", async () => { /* two calls, same id */ });
it("derives different artifact ids for different ordinals", async () => { /* v differs */ });
it("rejects an unknown kind", async () => { /* 400 INVALID_REQUEST */ });
it("rejects a transcript larger than the text cap", async () => { /* 400 UPLOAD_TOO_LARGE */ });
```

Write each body out in full.

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd web && npx vitest run "src/app/api/v1/worker/jobs/[id]/aux-session"`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Schema:

```ts
const schema = z.object({
  fencingToken: z.number().int().positive(),
  kind: z.enum(["TRANSCRIPT", "THUMB_CANDIDATE"]),
  ordinal: z.number().int().min(0).max(31),
  sizeBytes: z.number().int().safe().min(1).max(8 * 1_024 * 1_024),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(["text/plain", "image/jpeg"]),
}).strict();
```

Additional rules beyond the schema:
- `kind === "TRANSCRIPT"` requires `mimeType === "text/plain"`, `ordinal === 0`, and `sizeBytes <= 2 * 1_024 * 1_024`; otherwise `new AppError("UPLOAD_TOO_LARGE", 400)` / `new AppError("INVALID_REQUEST", 400)`
- `kind === "THUMB_CANDIDATE"` requires `mimeType === "image/jpeg"` and `sizeBytes <= 2 * 1_024 * 1_024`
- Artifact id derivation copies `deriveOutputArtifactId` but with domain `"ytb-vps/aux-artifact/v1"` and payload `JSON.stringify([jobId, kind, ordinal])` — deliberately **not** including the checksum, so a retry of the same slot reuses the same Drive file instead of littering
- Reuse the Drive `ensureOutputFile` + `createResumableUpdateSession` pair, passing `execution.outputParentId` and the request's `mimeType`
- Persist the artifact row with `kind` and `status='PENDING'`; **do not** call `reserve_drive_upload_capacity` — these files are ≤ 2 MB and the reservation machinery is for GB-scale sources
- `export const runtime = "nodejs"` and `const HEADERS = { "cache-control": "no-store" }`

- [ ] **Step 5: Run the tests**

Run: `cd web && npx vitest run "src/app/api/v1/worker" && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/api/v1/worker/jobs/[id]/aux-session"
git commit -m "feat(api): let workers upload transcript and thumbnail artifacts"
```

---

## Task 5: Worker-side upload

**Files:**
- Create: `src/ytb_vps_v2/adapters/control_plane/aux_upload.py`
- Test: `tests_v2/adapters/test_aux_upload.py`
- Modify: `src/ytb_vps_v2/adapters/native_media_job.py:98` (`run_native_pipeline`)

**Interfaces:**
- Consumes: Task 1, Task 2, the endpoint from Task 4.
- Produces:
  ```python
  def upload_aux_artifacts(
      client: Any,
      job_id: str,
      fencing_token: int,
      transcript_path: Path | None,
      frames: Sequence[ScoredFrame],
  ) -> None
  ```

- [ ] **Step 1: Read how the worker uploads the output today**

Run: `grep -rn "output-session\|output_session" src/ytb_vps_v2 | head -20`

Reuse that client and its resumable PUT helper. Do not write a second HTTP stack.

- [ ] **Step 2: Write the failing test**

Create `tests_v2/adapters/test_aux_upload.py` with a fake client recording calls. Cover:

```python
def test_uploads_the_transcript_with_ordinal_zero() -> None: ...
def test_uploads_each_frame_with_an_increasing_ordinal() -> None: ...
def test_skips_the_transcript_when_there_is_none() -> None: ...
def test_a_failed_frame_upload_does_not_abort_the_remaining_frames() -> None: ...
def test_computes_the_sha256_of_each_uploaded_file(tmp_path) -> None: ...
```

Write each body out in full.

- [ ] **Step 3: Run it and confirm it fails**

Run: `pytest tests_v2/adapters/test_aux_upload.py -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

For each file: compute SHA-256 and byte size, POST to `aux-session`, PUT the bytes to the returned `sessionUri`, then report completion the same way the output upload does.

**Aux uploads must never fail the job.** Wrap each upload in try/except, log the failure, and continue — a missing thumbnail is a nuisance; a failed render is a lost GPU hour.

- [ ] **Step 5: Wire it into the pipeline**

In `run_native_pipeline`, after the output file is finalised:

```python
frame_indices = pick_candidate_frames(
    duration_frames=timeline.duration_frames,
    cues=timeline.cues,
    blur_regions=timeline.blur_regions,
    count=8,
)
frames = extract_candidates(
    source=canonical_source,
    workspace=workspace,
    frame_indices=frame_indices,
    fps=timeline.fps,
    ffmpeg=ffmpeg,
    keep=8,
)
transcript_path = write_transcript(timeline, workspace)
upload_aux_artifacts(client, job_id_value, fencing_token, transcript_path, frames)
```

`write_transcript` is a small local helper in the same module: one cue per line, `cue.target_text or cue.source_text`, UTF-8, written to `workspace / "transcript.txt"`.

Adapt the exact variable names to what `run_native_pipeline` actually has in scope — read the function before editing.

- [ ] **Step 6: Run the suite and commit**

Run: `pytest`

```bash
git add src/ytb_vps_v2/adapters/control_plane/aux_upload.py src/ytb_vps_v2/adapters/native_media_job.py tests_v2/adapters/test_aux_upload.py
git commit -m "feat(worker): upload transcript and thumbnail candidates after render"
```

---

## Task 6: Drive text read

**Files:**
- Modify: `web/src/lib/ports/drive.ts`, `web/src/lib/adapters/google/drive-files.ts`
- Test: `web/src/lib/adapters/google/drive-files.test.ts`

**Interfaces:**
- Produces: `readTextFile(accessToken: string, fileId: string, maxBytes: number): Promise<string>` on `DriveFilesPort`.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/adapters/google/drive-files.test.ts`:

```ts
it("reads a small text file with alt=media", async () => {
  const fetcher = vi.fn(async () => new Response("dòng một\ndòng hai", {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "21" },
  }));

  const text = await createGoogleDriveFilesAdapter(fetcher)
    .readTextFile("token", "file-id", 2_048);

  expect(text).toBe("dòng một\ndòng hai");
  expect(String(fetcher.mock.calls[0]![0])).toContain("alt=media");
});

it("refuses a file larger than the cap without buffering it", async () => {
  const fetcher = vi.fn(async () => new Response("x".repeat(5_000), {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "5000" },
  }));

  await expect(createGoogleDriveFilesAdapter(fetcher)
    .readTextFile("token", "file-id", 1_024))
    .rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/adapters/google/drive-files.test.ts`
Expected: FAIL — `readTextFile` is not a function.

- [ ] **Step 3: Implement**

`GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`. This returns raw bytes, not JSON, so it cannot go through `googleJson`. Write a small local reader that:

- rejects immediately when `content-length` exceeds `maxBytes`
- otherwise streams and aborts once the running total passes `maxBytes`
- caps `maxBytes` itself at `2 * 1_024 * 1_024`
- decodes UTF-8 and throws `new AppError("REQUEST_TOO_LARGE", 413)` on overflow, `new AppError("DRIVE_FILE_NOT_FOUND", 404)` on 404

- [ ] **Step 4: Run and commit**

Run: `cd web && npx vitest run src/lib/adapters/google/drive-files.test.ts && npm run typecheck`

```bash
git add web/src/lib/ports/drive.ts web/src/lib/adapters/google/drive-files.ts web/src/lib/adapters/google/drive-files.test.ts
git commit -m "feat(drive): read a bounded text file"
```

---

## Task 7: Transcript condensation

**Files:**
- Create: `web/src/lib/domain/transcript.ts`
- Test: `web/src/lib/domain/transcript.test.ts`

**Interfaces:**
- Produces: `condenseTranscript(text: string, budgetChars: number): string` — pure, no I/O.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/domain/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { condenseTranscript } from "./transcript";

describe("condenseTranscript", () => {
  it("returns short input unchanged apart from trimming", () => {
    expect(condenseTranscript("  một\nhai  ", 1_000)).toBe("một\nhai");
  });

  it("drops consecutive duplicate lines", () => {
    expect(condenseTranscript("a\na\na\nb", 1_000)).toBe("a\nb");
  });

  it("drops blank lines", () => {
    expect(condenseTranscript("a\n\n\nb", 1_000)).toBe("a\nb");
  });

  it("stays within the budget", () => {
    const long = Array.from({ length: 5_000 }, (_, index) => `dòng ${index}`).join("\n");
    const result = condenseTranscript(long, 1_000);
    expect(result.length).toBeLessThanOrEqual(1_000);
  });

  it("samples evenly across the timeline rather than truncating the head", () => {
    const long = Array.from({ length: 1_000 }, (_, index) => `L${index}`).join("\n");
    const result = condenseTranscript(long, 200);
    expect(result).toContain("L0");
    expect(result).toContain("L999");
  });

  it("returns an empty string for empty input", () => {
    expect(condenseTranscript("   ", 1_000)).toBe("");
  });

  it("rejects a non-positive budget", () => {
    expect(() => condenseTranscript("a", 0)).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/domain/transcript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Split on newlines, trim each line, drop blanks and consecutive duplicates. If the joined result fits the budget, return it. Otherwise sample evenly: keep line 0, keep the last line, and pick the remaining slots at even indices across the array so the summary covers beginning, middle and end. Never emit a partial line.

- [ ] **Step 4: Run and commit**

Run: `cd web && npx vitest run src/lib/domain/transcript.test.ts`

```bash
git add web/src/lib/domain/transcript.ts web/src/lib/domain/transcript.test.ts
git commit -m "feat(domain): condense a transcript to a character budget"
```

---

## Task 8: Gemini composer adapter

**Files:**
- Create: `web/src/lib/ports/composer.ts`, `web/src/lib/adapters/gemini/http.ts`, `web/src/lib/adapters/gemini/compose.ts`
- Test: `web/src/lib/adapters/gemini/compose.test.ts`
- Modify: `web/src/lib/config/env.ts`, `web/src/lib/config/env.test.ts`, `web/.env.example`, `web/src/lib/domain/errors.ts`

**Interfaces:**
- Consumes: `YOUTUBE_TITLE_MAX_CHARS`, `YOUTUBE_DESCRIPTION_MAX_CHARS`, `YOUTUBE_TAGS_MAX_TOTAL_CHARS`.
- Produces:
  ```ts
  export type ComposedMetadata = Readonly<{
    titles: readonly [string, string, string];
    description: string;
    tags: readonly string[];
  }>;
  export interface MetadataComposerPort {
    compose(input: Readonly<{
      transcript: string; titlePrompt: string; descriptionPrompt: string;
      descriptionTemplate: string | null; defaultTags: readonly string[];
    }>): Promise<ComposedMetadata>;
  }
  export function createGeminiComposer(options: Readonly<{
    apiKey: string; model?: string; fetcher?: typeof fetch;
  }>): MetadataComposerPort;
  ```
  Default model: `gemini-3.5-flash-lite`.

- [ ] **Step 1: Add `GEMINI_API_KEY` to env**

Same pattern as `YOUTUBE_TOKEN_KEY_V1` in the previous plan: `GEMINI_API_KEY: z.string().trim().min(1).max(256)` in `cp2Schema`, `geminiApiKey: string` on `ServerEnv`, a test case, and a line in `.env.example`. Add the public codes `"COMPOSER_UNAVAILABLE"` and `"COMPOSER_REJECTED"` to `PUBLIC_CODES`.

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/adapters/gemini/compose.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createGeminiComposer } from "./compose";

function geminiResponse(payload: unknown): Response {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });
}

const input = {
  transcript: "nội dung tập phim",
  titlePrompt: "Đặt tiêu đề hấp dẫn",
  descriptionPrompt: "Viết mô tả",
  descriptionTemplate: "---\nĐăng ký kênh!",
  defaultTags: ["phim", "thuyết minh"],
};

describe("gemini composer", () => {
  it("returns three titles, a description, and tags", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["Một", "Hai", "Ba"],
      description: "Mô tả tập này",
      tags: ["tag-a", "tag-b"],
    }));

    const result = await createGeminiComposer({ apiKey: "k", fetcher }).compose(input);

    expect(result.titles).toEqual(["Một", "Hai", "Ba"]);
    expect(result.description).toContain("Mô tả tập này");
    expect(result.tags).toEqual(["tag-a", "tag-b"]);
  });

  it("sends a responseSchema so the model must return structured JSON", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["a", "b", "c"], description: "d", tags: [],
    }));

    await createGeminiComposer({ apiKey: "k", fetcher }).compose(input);

    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeTruthy();
  });

  it("never puts the api key in the url query string", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["a", "b", "c"], description: "d", tags: [],
    }));

    await createGeminiComposer({ apiKey: "super-secret", fetcher }).compose(input);

    expect(String(fetcher.mock.calls[0]![0])).not.toContain("super-secret");
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({
      "x-goog-api-key": "super-secret",
    });
  });

  it("appends the description template to the model output", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["a", "b", "c"], description: "Thân bài", tags: [],
    }));

    const result = await createGeminiComposer({ apiKey: "k", fetcher }).compose(input);
    expect(result.description.endsWith("---\nĐăng ký kênh!")).toBe(true);
  });

  it("truncates a title past the YouTube limit rather than failing", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["x".repeat(200), "b", "c"], description: "d", tags: [],
    }));

    const result = await createGeminiComposer({ apiKey: "k", fetcher }).compose(input);
    expect(result.titles[0]!.length).toBeLessThanOrEqual(100);
  });

  it("drops tags once the total character budget is exhausted", async () => {
    const fetcher = vi.fn(async () => geminiResponse({
      titles: ["a", "b", "c"], description: "d",
      tags: Array.from({ length: 100 }, (_, index) => `tag-${index}-${"y".repeat(20)}`),
    }));

    const result = await createGeminiComposer({ apiKey: "k", fetcher }).compose(input);
    const total = result.tags.reduce((sum, tag) => sum + tag.length, 0);
    expect(total).toBeLessThanOrEqual(500);
  });

  it("rejects a response that is not the expected shape", async () => {
    const fetcher = vi.fn(async () => geminiResponse({ titles: ["only-one"] }));

    await expect(createGeminiComposer({ apiKey: "k", fetcher }).compose(input))
      .rejects.toMatchObject({ code: "COMPOSER_REJECTED" });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/adapters/gemini/compose.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the bounded HTTP helper**

`web/src/lib/adapters/gemini/http.ts` — same shape as `google/http.ts` but with `timeoutMs` capped at 45000 and `maxResponseBytes` at 256 KB, and it maps failures to `COMPOSER_UNAVAILABLE` (502) / `COMPOSER_REJECTED` (502).

- [ ] **Step 5: Implement the composer**

- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
- Auth: header `x-goog-api-key`. **Never** as a query parameter — URLs land in logs.
- Body: `systemInstruction` built from `titlePrompt` + `descriptionPrompt`; `contents` carrying the condensed transcript; `generationConfig.responseMimeType = "application/json"` and a `responseSchema` requiring `titles` (exactly 3 strings), `description` (string), `tags` (array of strings).
- Post-process: parse the JSON from `candidates[0].content.parts[0].text`; truncate each title to `YOUTUBE_TITLE_MAX_CHARS`; append `descriptionTemplate` (separated by `\n\n`) then truncate to `YOUTUBE_DESCRIPTION_MAX_CHARS`; merge `defaultTags` ahead of the model's tags, de-duplicate case-insensitively, and drop from the end until the total length is within `YOUTUBE_TAGS_MAX_TOTAL_CHARS`.
- Any shape mismatch throws `new AppError("COMPOSER_REJECTED", 502)`.

- [ ] **Step 6: Run and commit**

Run: `cd web && npm test && npm run typecheck`

```bash
git add web/src/lib/ports/composer.ts web/src/lib/adapters/gemini web/src/lib/config/env.ts web/src/lib/config/env.test.ts web/src/lib/domain/errors.ts web/.env.example
git commit -m "feat(gemini): compose YouTube metadata from a condensed transcript"
```

---

## Task 9: Compose use-case and routes

**Files:**
- Create: `web/src/lib/application/compose-metadata.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/publications/[jobId]/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/publications/[jobId]/compose/route.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: Tasks 3, 6, 7, 8, plus `YouTubeControlPlaneRepository.getChannel` from the previous plan.
- Produces:
  - `composeMetadataForJob(input: { jobId: string; channelId: string }, deps): Promise<ComposedMetadata>`
  - `GET /api/v1/publications/:jobId` → `{ draft, thumbnails: [{ artifactId, driveFileId }] }`
  - `PUT /api/v1/publications/:jobId` → `{ draft }`
  - `POST /api/v1/publications/:jobId/compose` → `{ draft }`

- [ ] **Step 1: Write the failing use-case test**

Create `web/src/lib/application/compose-metadata.test.ts` covering:

```ts
it("fails cleanly when the job has no transcript artifact", async () => { /* COMPOSER_UNAVAILABLE */ });
it("condenses the transcript before handing it to the composer", async () => { /* assert composer saw <= budget chars */ });
it("uses the selected channel's prompts", async () => { /* assert titlePrompt/descriptionPrompt passed through */ });
it("falls back to a built-in prompt when the channel has none", async () => { /* non-empty prompt still sent */ });
it("stores the first title as the draft title and records composed_at", async () => { /* assert upsert payload */ });
```

Write each body out in full with explicit fakes.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/application/compose-metadata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

Order: load draft (or create an empty one) → find the job's `TRANSCRIPT` artifact → `drive.files.readTextFile(token, driveFileId, 2 * 1024 * 1024)` → `condenseTranscript(text, 30_000)` → load channel prompts → `composer.compose(...)` → `upsert` with the first title, the description, the tags, `composedAt`, and the channel's `thumbnailPromptTemplate` rendered as `thumbnailPrompt` → `recordAudit("PUBLICATION_COMPOSED")`.

Built-in fallback prompts live as constants in this module so a channel with empty prompt fields still works.

- [ ] **Step 4: Write the route tests, then the routes**

Cover per route: unauthenticated → 401; unknown job → 404; happy path. On the compose route also cover a missing transcript → 502 `COMPOSER_UNAVAILABLE`.

The `PUT` schema:

```ts
const updateSchema = z.object({
  channelId: z.string().uuid().nullable().optional(),
  title: z.string().max(YOUTUBE_TITLE_MAX_CHARS).nullable().optional(),
  description: z.string().max(YOUTUBE_DESCRIPTION_MAX_CHARS).nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  thumbnailPrompt: z.string().max(4_000).nullable().optional(),
  chosenThumbArtifactId: z.string().uuid().nullable().optional(),
  status: z.enum(["DRAFT", "READY", "PUBLISHED"]).optional(),
  youtubeVideoUrl: z.string().url().startsWith("https://").max(512).nullable().optional(),
}).strict();
```

The compose route declares `export const maxDuration = 60`.

- [ ] **Step 5: Run and commit**

Run: `cd web && npm test && npm run typecheck && npm run lint`

```bash
git add web/src/lib/application/compose-metadata.ts web/src/lib/application/compose-metadata.test.ts web/src/app/api/v1/publications
git commit -m "feat(api): compose and persist publication drafts"
```

---

## Task 10: The Publish surface

**Files:**
- Create: `web/src/components/copy-field.tsx` (+ `.test.tsx`)
- Create: `web/src/components/thumbnail-picker.tsx` (+ `.test.tsx`)
- Create: `web/src/components/publication-editor.tsx` (+ `.test.tsx`)
- Create: `web/src/components/publish-surface.tsx` (+ `.test.tsx`)
- Modify: `web/src/components/dashboard-shell.tsx`, `web/src/components/dashboard-types.ts`

**Interfaces:**
- Consumes: the routes from Task 9.
- Produces: a `publish` entry in `SurfaceId` and the sidebar.

- [ ] **Step 1: Write the failing component tests**

`copy-field.test.tsx`:

```tsx
it("shows the remaining character budget", () => {
  render(<CopyField label="Tiêu đề" value="abc" maxChars={100} onChange={() => {}} />);
  expect(screen.getByText("3/100")).toBeInTheDocument();
});

it("marks the counter as over budget past the limit", () => {
  render(<CopyField label="Tiêu đề" value={"x".repeat(101)} maxChars={100} onChange={() => {}} />);
  expect(screen.getByTestId("counter")).toHaveAttribute("data-over", "true");
});

it("copies the value to the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<CopyField label="Tiêu đề" value="giá trị" maxChars={100} onChange={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /chép/i }));
  expect(writeText).toHaveBeenCalledWith("giá trị");
});
```

`thumbnail-picker.test.tsx`:

```tsx
it("renders one option per candidate frame", () => { /* 8 images */ });
it("marks the chosen frame as selected", () => { /* aria-pressed true */ });
it("offers a download link for the chosen frame", () => { /* anchor has download attr */ });
it("shows an empty state when the render produced no candidates", () => { /* explanatory text */ });
```

`publication-editor.test.tsx`:

```tsx
it("disables the compose button until a channel is selected", () => { /* ... */ });
it("offers the three generated titles and applies the picked one", async () => { /* ... */ });
it("blocks marking as published without a video url", async () => { /* ... */ });
```

`publish-surface.test.tsx`:

```tsx
it("lists rendered jobs that are not yet published", () => { /* ... */ });
it("shows an empty state when nothing is ready to publish", () => { /* ... */ });
```

Write each body out in full.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && npx vitest run src/components/publish src/components/copy-field src/components/thumbnail-picker src/components/publication-editor`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Follow the existing component conventions: Vietnamese copy, classes from `app/globals.css`, no inline styles.

`PublicationEditor` layout, top to bottom: channel selector → **Soạn bằng AI** button → three title options (radio) → `CopyField` for title, description, tags → `ThumbnailPicker` → `CopyField` for the thumbnail prompt → a row with **Mở Studio** (`https://studio.youtube.com/channel/<CHANNEL_ID>/videos/upload`, `target="_blank"`, `rel="noopener noreferrer"`), a video-URL input, and **Đánh dấu đã đăng**.

Add a short note above the Studio button explaining that YouTube cannot pre-fill metadata from a link, so each field must be pasted. This is the single most likely source of confusion.

- [ ] **Step 4: Wire the nav**

`dashboard-types.ts`: add `"publish"` to `SurfaceId`. `dashboard-shell.tsx`: add a `PublishIcon`, add `{ id: "publish", label: "Publish", Icon: PublishIcon }` to `WORKSPACE_ITEMS`, add `publish: "Workspace"` to `SURFACE_EYEBROW`, and render `{surface === "publish" && <PublishSurface />}`.

- [ ] **Step 5: Run everything**

Run: `cd web && npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components
git commit -m "feat(web): add the publish surface with AI-composed metadata and frame picking"
```

---

## Task 11: Documentation

**Files:**
- Modify: `web/README.md`

- [ ] **Step 1: Write the section**

Add "Bàn biên soạn (Publish)" to `web/README.md` covering: obtaining a `GEMINI_API_KEY` from Google AI Studio; that `gemini-3.5-flash-lite` has a free tier and paid usage is roughly $0.30/$2.50 per million input/output tokens; the manual publishing loop (download the output from Drive, upload in Studio, paste each field, pick a frame, generate the thumbnail elsewhere); and the explicit statement that YouTube offers no URL parameter to pre-fill upload metadata, which is why every field has a copy button.

- [ ] **Step 2: Commit**

```bash
git add web/README.md
git commit -m "docs(web): document the publish workbench"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-07-27-youtube-workbench-design.md`:

- Spec §5.1 transcript export → Task 5. §5.2 frame picker split into pure domain + adapter → Tasks 1, 2. §5.3 aux-session → Task 4.
- Spec §6 composer, including the 2 MB read cap, condensation, `responseSchema`, and `maxDuration = 60` → Tasks 6, 7, 8, 9. The spec's note that `googleJson` cannot be reused is honoured by the separate helper in Task 8 Step 4 and the separate reader in Task 6 Step 3.
- Spec §7 Publish surface, including character counters, the frame grid, the thumbnail prompt, the Studio deeplink, and mark-as-published → Task 10.
- Spec §8.4 `publication_drafts` → Task 3 (migration v12; v11 came from the previous plan).
- Spec §9 `GEMINI_API_KEY` → Task 8 Step 1. §10 "prompt sinh thumbnail không đảm bảo dấu tiếng Việt" → surfaced to the operator in Task 11.
- Spec §3, §4 (channels, stats, per-channel prompts) belong to the previous plan and are consumed here, not rebuilt.
- Type consistency: `ScoredFrame` (Task 2) is used by Task 5. `ComposedMetadata` and `MetadataComposerPort` (Task 8) are used by Task 9. `PublicationDraft` and `PublicationRepository` (Task 3) are used by Tasks 9 and 10. `pick_candidate_frames` keeps the same signature in Tasks 1, 2 and 5.
- Deliberate divergence from the spec, recorded here: the spec called `write_transcript` part of §5.1 without naming it; this plan defines it as a helper inside `native_media_job.py` rather than a new module, because it is six lines and has no other consumer.
