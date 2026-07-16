# V2 Rebuild Master Plan

Status: Phases 0–6 complete; Phase 7 offline 30-second vertical slice is next
Branch: `rebuild/v2`
Legacy baseline: `ba1ad85fe73330376ceb4ba048d9b6fd8392ba38`
Legacy rollback tag: `legacy-audited-baseline-2026-07-16`

## Operating rules

- Build v2 beside legacy under `src/ytb_vps_v2/`.
- Do not import or copy large modules from `app/ytb_vps/`.
- Use contract-first and test-first development for every slice.
- Keep at least one runnable, verifiable vertical path after each phase.
- Commit one purpose at a time with Conventional Commits.
- Do not push without explicit user authorization.
- Keep cleanup disabled until the full durability fault suite passes.
- Record each completed phase in `docs/rebuild/AUDIT-LOG.md`.

## Program gates

| Gate | Required evidence |
|---|---|
| G0 Baseline | Correct branch/HEAD, clean worktree, valid legacy tag/bundle, secret path gate, baseline compile/import/test results |
| G1 Foundation | Python 3.10 package install, canonical timeline fixtures, typed config, domain and invalidation tests |
| G2 Durability | SQLite migrations, atomic artifact commit, input archive, staged restore, deny-by-default cleanup and fault tests |
| G3 Offline slice | Deterministic 30-second end-to-end run, restart at every stage, audio/no-audio fixtures |
| G4 Providers | ONNX OCR contract, optional Docker contract, translation/TTS fakes and production smoke interfaces |
| G5 Media quality | Tracking, cue, blur, TTS fit, render, subtitle, logo and Part validation tests |
| G6 Operations | CLI compatibility, doctor, disk guard, packaging, CI, service and runbook |
| G7 Release | All discovered tests pass, clean Python 3.10 install, fault injection, restore rehearsal, soak test and secret scan |
| G8 Cutover | Dedicated reversible entry-point commit; rollback to legacy tag rehearsed |

## Phases

### Phase 0 — Baseline and design record

Outcome: verified baseline evidence, approved v2 architecture, master plan, audit
format, and architecture ADR.

Gate: G0.

### Phase 1 — Package scaffold

Create the independent `src/` package, development CLI entry point, test layout,
Python 3.10 packaging metadata, lint/type/test configuration, and CI skeleton.

Gate: clean install and smoke import without touching the legacy entry point.

### Phase 2 — Canonical timeline and domain models

Implement typed timeline, intervals, Job, Cue, Region, Artifact, WorkUnit, Part,
and invariant errors.

Gate: 24/25/29.97/30 FPS fixtures and no accepted invalid interval.

### Phase 3 — Typed config and invalidation

Implement typed effective configuration, legacy-key compatibility, unknown-key
policy, per-stage fingerprints, and dependency graph invalidation.

Gate: configuration changes invalidate exactly the expected nodes.

### Phase 4 — SQLite state and artifact contracts

Implement versioned migrations, repositories, unit-of-work transitions,
atomic artifact commit records, retry history, and stale-run recovery.

Gate: restart and corruption tests preserve or invalidate the correct units.

### Phase 5 — Verified input and checkpoint backup

Implement source identity, input archive verification, additive remote copy,
snapshot manifests, and SQLite backup snapshots.

Gate: expensive stages cannot start before verified input durability.

### Phase 6 — Staged restore and cleanup guard

Implement staging restore, checksum and integrity gates, atomic swap, fresh remote
evidence, allowed-root deletion policy, and cleanup denial reasons.

Gate: remote Part loss, corrupt snapshots, unarchived input, and unsafe paths all
deny cleanup without destroying local data.

### Phase 7 — Offline 30-second vertical slice

Connect fake OCR, fake translation, fake TTS, FFmpeg rendering, local publishing,
state snapshots, and resume.

Gate: complete offline flow plus interruption after every stage and within every
work-unit type.

### Phase 8 — OCR providers

Implement production ONNX adapter and optional Docker legacy adapter against a
shared coordinate and output contract.

Gate: contract suite, provider smoke, deterministic fake, and explicit failure
without silent CPU fallback.

### Phase 9 — Tracking, cue, and blur plan

Implement tracking, cue timing, dynamic/static blur, per-video regions, and
canonical frame-coordinate invariants.

Gate: representative fixtures cover logo/subtitle positions and timeline ends.

### Phase 10 — Translation

Implement prepass, context, deterministic batching, exact-ID validation,
fingerprinted cache, retry/split behavior, and provider fake.

Gate: resume reuses correct batches and invalidates only changed context/model
work.

### Phase 11 — TTS

Implement provider interface, CapCut adapter, fit/shorten policy, micro-cue rules,
observable degradation, and deterministic fake audio.

Gate: no silent truncation and restart never re-requests a valid completed group.

### Phase 12 — Render and media composition

Implement bounded render chunks, audio/no-audio composition, subtitle scheduling,
logo, blur, validation, and disk reserve checks.

Gate: full decode and semantic validation across all FPS/audio fixtures.

### Phase 13 — Publish and remote validation

Implement 30-minute Part planning, checksums, fresh remote evidence, manifest
versioning, partial publish retry, and durable checkpoint backup.

Gate: missing/corrupt remote Part is detected and blocks cleanup.

### Phase 14 — Queue, CLI, doctor, packaging, and service

Implement compatibility commands/config, job inspection/retry, provider and disk
doctor checks, least-privilege service files, and installation documentation.

Gate: a clean Python 3.10 host installs and processes the offline fixture through
the documented CLI.

### Phase 15 — Regression, fault injection, and soak

Run the full suite, host-loss simulations, damaged-local-state restore, provider
interruptions, disk pressure, and 10-minute resource soak.

Gate: G7.

### Phase 16 — Migration, runbook, and rollback

Implement migration dry-run, legacy artifact revalidation, operator runbook,
restore rehearsal, and rollback rehearsal.

Gate: a fresh workspace can recover from supported remote checkpoints and the
legacy tag remains runnable.

### Phase 17 — Cutover

Switch the public `ytb-vps` entry point to v2 in a dedicated commit. Do not enable
cleanup. Preserve the documented rollback path.

Gate: G8.

## Phase completion record

A phase is complete only when its tests and gates pass, the full diff and staged
filenames have been reviewed, `git diff --check` is clean, the audit entry names
remaining risks and the next phase, and the single-purpose commit succeeds.
