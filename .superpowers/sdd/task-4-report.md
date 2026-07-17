# Task 4 Phase 7 — Restartable offline vertical slice

Status: DONE

## Scope and result

- Implemented the fixed `INGEST -> OCR -> TRACK -> TRANSLATE -> TTS -> RENDER -> PUBLISH -> BACKUP` application graph.
- SQLite ends with exactly eight valid primary artifacts, one fixed `PIPELINE_ARTIFACT_PATHS` document per `StageName`. WAV, rendered MP4, and `published/part-001.mp4` are durable verified side assets and are never extra SQLite artifacts.
- Added additive `LocalPartPublisher`, strict `RenderRequest`, and required rendered-path/digest evidence on persisted `RenderPlanDocument`.
- Kept the public CLI and Task 5 audit documents unchanged.

## TDD RED evidence

- SQLite invalidation/recommit initially failed with `UNIQUE constraint failed: artifacts.job_id, artifacts.relative_path`; exact invalid canonical identity now updates atomically, while name/path/owner ambiguity and simultaneous name+path drift fail closed.
- `LocalPartPublisher` began at `NotImplementedError`; it now delegates to `LocalArtifactWriter`, publishes only Part 1/1 at the fixed path, independently verifies read-back, reuses matching bytes, and never replaces conflicts.
- Persisted render contract RED showed `RenderPlanDocument` ended at `(parts, output_has_audio)`; it now requires canonical `rendered_path` and `rendered_digest`. FFmpeg RED expected `RenderRequest` but received `RenderPlanDocument`; the adapter now consumes the separate typed pre-render request.
- Real E2E RED reached `OfflineSliceRunner.run -> NotImplementedError`; both real 30-second fixtures now complete all eight stages and cold-rerun byte-identically.
- Interruption RED found orphan render staging at RENDER `after_provider` and `before_filesystem_publication`; both interruption and failure paths now discard owned staging.
- Corruption RED tried to overwrite corrupt OCR canonical bytes in the old root; persisted INVALID work now requires and pivots to an explicitly empty fresh workspace, seeds only verified upstream outputs, and recomputes the owning stage plus downstream.
- Checkpoint-generation RED returned the pre-corruption final snapshot (OCR attempt 1 instead of 2); deterministic generation IDs now bind work attempts, while ordinary BACKUP interruption reuses one stable proof.
- Proof-side RED deleted the referenced proof state but BACKUP incorrectly skipped; resume now hashes both remote proof manifest and proof state. Repair rotates only with a deterministic repair token.
- Final-side RED corrupted the final state snapshot but clean rerun returned success; result publication now verifies both final manifest and state objects.
- Independent review found simultaneous SQLite identity drift and final-state verification gaps; both were reproduced RED and fixed GREEN. Re-review returned no Critical or Important findings.

## Checkpoint protocol

1. BACKUP starts as durable RUNNING work after PUBLISH is committed.
2. BACKUP provider work publishes a deterministic proof checkpoint containing verified input, the seven primary artifacts through PUBLISH, and a SQLite snapshot. The manifest is last, read back, and recorded as SQLite checkpoint evidence.
3. BACKUP writes the sole primary `CheckpointDocument`, which refers to the proof manifest and proof SQLite snapshot, then commits that artifact and BACKUP success atomically.
4. The runner epilogue always publishes a deterministic final checkpoint after BACKUP success. Its snapshot contains all eight SUCCEEDED units and all eight primary artifacts.
5. A crash after BACKUP commit but before the epilogue is repaired by the next run. A crash after BACKUP filesystem publication reuses the verified uncommitted canonical document. Ordinary retry keeps exactly one proof plus one final checkpoint; damaged proof evidence rotates to a new additive repair generation.
6. `OfflineSliceResult` returns the final manifest plus exact SQLite `CheckpointRecord`; proof and final manifest/state objects are hash-verified before success.

## Verification evidence

- Baseline at `3d2191a`: 248 tests passed, 11 skipped, 33.491s.
- Domain pipeline focused: 25 passed, 0 failed, 0.011s.
- FFmpeg focused after `RenderRequest` migration: 39 passed, 8 platform skips, 27.129s.
- Real audio/no-audio E2E: 2 passed, 0 failed, 9.874s. These use real 30-second FFmpeg fixtures, real SQLite/archive/checkpoint/local object store, full semantic render validation, and cold rerun.
- Full interruption matrix: all 40 stage/point combinations passed. Points cover before provider/process, after provider/process, before filesystem publication, after filesystem publication before SQLite, and after SQLite commit.
- Corruption/resume covers primary hash corruption; missing TTS WAV, rendered MP4, and published Part; proof/final remote state corruption; fresh-workspace-only recompute; graph ambiguity; dependency mismatch; bounded retry events.
- Final full v2 discovery: 264 tests passed, 11 skipped, 74.294s.
- `python -m compileall -q src tests_v2`: exit 0.
- Forbidden legacy/domain-adapter import scans, secret filename scan, binary media/database scan, `git diff --check`, and CLI/config-compat diff gate: exit 0.
- Independent latest-diff re-review: Ready; no remaining Critical/Important findings.

## Commit and concerns

- Commit subject: `feat(v2): run restartable offline vertical slice`.
- The resulting commit hash is reported in the task handoff; embedding a commit's own final hash inside its contents is self-referential.
- Local verification used Python 3.12 on Windows. Python 3.10 is covered by repository CI configuration but was not separately installed in this workspace.
- Eleven existing platform-specific tests remain skipped on Windows (POSIX anonymous publication and unavailable symlink privileges); the real audio/no-audio FFmpeg evidence ran on Windows.
- Deterministic media bytes are demonstrated across reruns on this toolchain. Cross-version FFmpeg bitstream identity is not claimed; semantic identity and exact local read-back are enforced.
