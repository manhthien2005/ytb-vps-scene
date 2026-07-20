# CP-4 Drive Media Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the attached native VPS into a render worker that claims one source-ready project, downloads the private Drive source directly, applies saved blur/TTS settings, renders locally, and uploads a verified output directly to Drive.

**Architecture:** Vercel remains a metadata and credential broker only. A fenced job assignment contains immutable project/source/settings metadata plus one short-lived Drive access token held only in worker memory; media bytes flow directly between Google Drive and the VPS. The worker requests a resumable output session after render, uploads the MP4 directly, and completion is accepted only after Drive metadata and the active lease fence match.

**Tech Stack:** Next.js 16; strict TypeScript; Neon/Postgres; Google Drive v3/resumable upload; Python 3.10 standard library; existing v2 FFmpeg pipeline; Vitest/PGlite; unittest.

## Global Constraints

- Keep source/checkpoint/output private until output validation succeeds.
- Never persist or log Google access tokens or resumable session URIs.
- Video bytes never transit Vercel or Neon.
- Every worker mutation requires an unexpired worker session and the active fencing token.
- CP-4 supports the existing canonical 30 FPS/900-frame media slice; longer-video orchestration remains a later phase.
- Use TDD for each production behavior and commit each completed task.

---

### Task 1: Immutable media assignment contract

**Files:**
- Modify: `web/src/lib/domain/worker.ts`
- Modify: `web/src/lib/repositories/worker-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-worker-control-plane.ts`
- Test: `web/src/lib/repositories/neon-worker-control-plane.test.ts`

**Interfaces:**
- Produces: `MediaExecutionDescriptor` and `JobAssignment.execution`.
- Descriptor fields: project ID, source Drive file ID/name/MIME/size, output parent ID, and parsed scene settings.

- [ ] Add a failing repository test asserting claim returns the exact source and settings while rejecting malformed stored rows.
- [ ] Run the targeted Vitest file and verify the new assertion fails because `execution` is absent.
- [ ] Add strict descriptor parsing and extend the atomic claim query with project/source/settings joins.
- [ ] Run targeted tests and commit.

### Task 2: Ephemeral Drive credential broker

**Files:**
- Create: `web/src/lib/application/configured-drive.ts`
- Modify: `web/src/lib/application/configured-health.ts`
- Modify: `web/src/app/api/v1/worker/claim/route.ts`
- Create: `web/src/app/api/v1/worker/claim/route.test.ts`

**Interfaces:**
- Produces: `createConfiguredDrive(env, repository)` and claim JSON `{ job, lease, execution, driveAccessToken }`.

- [ ] Write a failing route test proving the response contains a bounded access token but no refresh token, credential envelope, or Drive session URI.
- [ ] Verify RED.
- [ ] Build the configured Drive factory and enrich only successful claims with a fresh access token.
- [ ] Verify errors stay `{code}` and responses remain `no-store`; run tests and commit.

### Task 3: Fenced output reservation and completion

**Files:**
- Modify: `web/src/lib/ports/drive.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts`
- Modify: `web/src/lib/repositories/worker-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-worker-control-plane.ts`
- Modify: `web/src/lib/db/schema.sql`
- Create: `web/src/app/api/v1/worker/jobs/[id]/output-session/route.ts`
- Create: `web/src/app/api/v1/worker/jobs/[id]/complete/route.ts`
- Test: corresponding adapter/repository/route tests.

**Interfaces:**
- Produces: `createOutputUploadSession`, `reserveOutput`, and `completeOutput`.

- [ ] Write failing tests for safe Drive metadata, exact parent/appProperties, stale fence rejection, replay safety, and remote metadata mismatch.
- [ ] Verify RED for each boundary.
- [ ] Add schema v9 output reservation columns/constraints and repository transactions.
- [ ] Implement Drive output creation/session initiation and the two fenced routes.
- [ ] Run adapter/repository/route tests and commit.

### Task 4: Direct Drive transfer client

**Files:**
- Create: `src/ytb_vps_v2/adapters/drive/media_transfer.py`
- Create: `src/ytb_vps_v2/adapters/drive/__init__.py`
- Create: `tests_v2/adapters/drive/test_media_transfer.py`

**Interfaces:**
- Produces: `DriveMediaTransfer.download_source(...)` and `upload_resumable(...)` with streaming SHA-256 evidence.

- [ ] Write failing fake-HTTPS tests for hostname allowlists, redirect rejection, exact length/hash, bounded errors, resume offsets, and no proxy use.
- [ ] Verify RED.
- [ ] Implement streaming download and chunked resumable PUT without loading the whole video into RAM.
- [ ] Run tests and commit.

### Task 5: Native media job executor

**Files:**
- Create: `src/ytb_vps_v2/application/media_job.py`
- Modify: `src/ytb_vps_v2/interfaces/worker.py`
- Modify: `src/ytb_vps_v2/interfaces/cli.py`
- Test: `tests_v2/application/test_media_job.py`
- Test: `tests_v2/interfaces/test_worker.py`

**Interfaces:**
- Consumes: CP-4 assignment, Drive transfer client, existing `OfflineSliceRunner`.
- Produces: one resumable output and fenced progress transitions.

- [ ] Write failing tests for normalized rectangle conversion, source verification, stage progress, lease renewal, Edge TTS selection, retry/restart, and completion.
- [ ] Verify RED.
- [ ] Implement executor and switch evidence to `cp4-media-v1` only when all required tools pass doctor.
- [ ] Run tests and commit.

### Task 6: VPS bootstrap and dashboard readiness

**Files:**
- Modify: `ops/native-v2/bootstrap-worker.sh`
- Modify: `ops/native-v2/ytb-vps-worker.service`
- Modify: `web/src/components/worker-card.tsx`
- Modify: `web/src/components/job-list.tsx`
- Test: component/bootstrap contract tests.

**Interfaces:**
- Produces: one-command media-ready installation and honest Vietnamese readiness/job copy.

- [ ] Write failing tests that require FFmpeg, Edge TTS, writable run storage, `cp4-media-v1`, and no “ready” label for a failed doctor.
- [ ] Verify RED.
- [ ] Update bootstrap/service/UI with bounded disk cleanup and restart behavior.
- [ ] Run tests and commit.

### Task 7: Full acceptance and deployment handoff

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`
- Modify: `web/.env.example`

**Interfaces:**
- Produces: reproducible local gate and a live acceptance checklist.

- [ ] Run all 333+ Python tests, all web tests, typecheck, lint, build, and npm audit.
- [ ] Run the canonical Test 1 media smoke with two static rectangles and verify MP4/WAV artifacts.
- [ ] Scan tracked files for secrets, session URIs, `.env`, and media.
- [ ] Record exact evidence and commit.
- [ ] Push/deploy only with user authorization; then attach one disposable VPS and verify Drive source-to-output flow.

