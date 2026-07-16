# Phase 6 Staged Restore and Cleanup Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a verified checkpoint into an isolated staging tree and publish it only after every identity, checksum, SQLite, and migration gate passes, while making cleanup authorization deny by default unless fresh complete remote proof and safe deletion roots are present.

**Architecture:** Restore and cleanup policy values remain pure domain objects. The additive-store port gains bounded materialization and fresh verification; the local adapter supplies deterministic evidence for tests. A restore application service downloads the state snapshot first, validates and migrates only the staged copy, derives the exact archive/artifact layout from staged SQLite, materializes remaining objects, revalidates everything, then performs a no-replace same-parent directory publish into an absent target. Cleanup produces an authorization decision only; it does not delete data or enable runtime cleanup.

**Tech Stack:** Python 3.10–3.12 standard library (`dataclasses`, `enum`, `hashlib`, `json`, `os`, `pathlib`, `shutil`, `sqlite3`, `tempfile`, `typing.Protocol`, `unittest`).

## Global Constraints

- Work directly on `rebuild/v2`; preserve legacy and do not push.
- Restore never writes into an active target. The final target must be absent; an existing target is left byte-for-byte untouched and fails explicitly.
- Download into a random same-parent staging directory. A failure removes only that owned staging directory.
- Parse the canonical manifest before downloads; materialize the state snapshot first; verify every downloaded size/hash independently.
- Run SQLite `integrity_check`, reject future schema versions, migrate compatible older state only inside staging, and re-run integrity/schema/identity validation afterward.
- Validate exact manifest job/source identity against staged `jobs` and `input_archives` rows. Restore the input to `archive/<stored archive_key>` and artifacts to `workspace/<stored relative_path>`.
- Every valid staged SQLite artifact must have exactly one manifest object with the same size/hash; extra manifest artifact objects fail closed.
- Final publication is a same-parent no-replace rename. Reparse/symlink components and path swaps fail closed.
- Fresh remote evidence contains key, observed digest, observation time, and method; historic database booleans are never accepted as proof.
- Cleanup authorization defaults to denied and requires explicit operator enablement, fresh matching evidence for manifest/input/state/all artifacts/all Parts/all validation artifacts, a restorable snapshot, complete durable-work coverage, and deletion targets strictly below allowed roots.
- Phase 6 does not delete files and does not wire cleanup into CLI/queue/runtime. Cleanup remains disabled globally.
- Credentials, tokens, remote SDKs, clocks, and filesystem paths do not enter pure domain modules.
- Apply TDD and one-purpose Conventional Commits.

## File map

- `src/ytb_vps_v2/domain/restore.py`: remote evidence, restore result, cleanup denial reason/proof/decision values.
- `src/ytb_vps_v2/ports/backup.py`: fresh verify and materialize contracts.
- `src/ytb_vps_v2/ports/cleanup.py`: safe deletion-target policy protocol.
- `src/ytb_vps_v2/adapters/filesystem/additive.py`: local fresh evidence and staged materialization.
- `src/ytb_vps_v2/adapters/filesystem/cleanup.py`: no-delete allowed-root preflight policy.
- `src/ytb_vps_v2/adapters/sqlite/restore.py`: staged SQLite inspection/migration/layout validation.
- `src/ytb_vps_v2/application/restore.py`: staged restore orchestration and final no-replace publish.
- `src/ytb_vps_v2/application/cleanup.py`: deny-by-default cleanup assessment.
- `tests_v2/domain/test_restore.py`: evidence and cleanup decision invariants.
- `tests_v2/adapters/filesystem/test_restore_store.py`: verify/materialize/fault/path tests.
- `tests_v2/adapters/filesystem/test_cleanup_policy.py`: allowed-root preflight tests with no deletion.
- `tests_v2/adapters/sqlite/test_restore.py`: integrity, migration, identity, and layout tests.
- `tests_v2/application/test_restore.py`: full staged restore interruption matrix.
- `tests_v2/application/test_cleanup.py`: cleanup denial matrix.

### Task 1: Fresh evidence and cleanup decision values

**Files:** create `domain/restore.py`; update domain exports; create `tests_v2/domain/test_restore.py`.

**Interfaces:** `RemoteObjectEvidence`; `RestoreResult`; `CleanupDenialReason`; `CleanupProof`; `CleanupDecision`.

- [ ] Write failing tests for exact types, safe POSIX keys, matching digest, non-negative integer observation time, bounded method, unique evidence keys, exact Part/validation/work sets, immutable sorted denial reasons, and `allowed` being true only with an empty denial tuple.
- [ ] Run focused test and observe missing module.
- [ ] Implement frozen slotted values; no clock/path/provider imports.
- [ ] Run focused/full/compile gates and commit `feat(v2): define restore cleanup evidence contracts`.

### Task 2: Fresh object verification, materialization, and allowed-root policy

**Files:** extend `ports/backup.py`; create `ports/cleanup.py`; modify filesystem additive/integrity exports; create `adapters/filesystem/cleanup.py`; add filesystem tests.

**Interfaces:** `AdditiveObjectStore.verify(key, expected, observed_at, method) -> RemoteObjectEvidence`; `materialize(key, destination, expected) -> ManifestEntry`; `DeletionTargetPolicy.preflight(targets, allowed_roots) -> tuple[PurePosixPath, ...]`.

- [ ] Write failing tests proving verify re-reads bytes every call; missing/corrupt objects fail; materialization uses an exclusive same-directory temporary file, fsync, no-replace publish, and independent read-back; repeat matching destination is idempotent; conflicting destination remains unchanged; injected failures leave no final/temp.
- [ ] Write failing allowed-root tests for exact `Path` values, absent roots, root-self deletion, `..`, absolute/drive tricks, symlink/junction/reparse components, duplicate/nested targets, and path-swap identity changes. Assert the policy has no delete method.
- [ ] Implement fresh local evidence, bounded streaming materialization, and full preflight-only path confinement through the anchored filesystem primitives from Phase 5.
- [ ] Run focused/fault/full gates and commit `feat(v2): verify restore objects and cleanup targets`.

### Task 3: Staged SQLite validation and no-replace restore

**Files:** create `adapters/sqlite/restore.py`; update SQLite exports; create `application/restore.py`; update application exports; add SQLite/application restore tests.

**Interfaces:** `inspect_staged_state(path, manifest) -> RestoreLayout`; `migrate_staged_state(path) -> None`; `CheckpointRestorer.restore(manifest_key, target, staging_parent, observed_at) -> RestoreResult`.

- [ ] Write failing SQLite tests for exact `integrity_check`, supported/future version handling, migration of a real v1 fixture only in staging, job/source mismatch, missing verified input, corrupt artifact rows, duplicate/extra/missing manifest artifacts, and post-migration revalidation.
- [ ] Write failing end-to-end tests that publish a real Phase 5 checkpoint, restore into an absent target, and verify `job-v2.sqlite`, `archive/<archive_key>`, and every `workspace/<artifact path>` byte. Interrupt before/after each materialization, during migration, before final rename, and after validation; the target must stay absent or unchanged and owned staging must be removed.
- [ ] Cover missing/corrupt manifest/input/state/artifact, unsafe staged paths, future schema, target conflict, retry, and successful restore into a fresh empty root.
- [ ] Implement manifest-first/state-first orchestration. Use store materialization, SQLite inspection, only staged migration, exact layout derivation, final full re-hash, and same-parent no-replace rename. Never overwrite or merge an active target.
- [ ] Run focused/interruption/full gates and commit `feat(v2): restore checkpoints through verified staging`.

### Task 4: Deny-by-default cleanup authorization

**Files:** create `application/cleanup.py`; create `tests_v2/application/test_cleanup.py`.

**Interfaces:** `CleanupGuard.assess(proof, targets, allowed_roots, now, max_age, operator_enabled) -> CleanupDecision`.

- [ ] Write a passing-proof fixture and first assert it is denied while operator enablement is false.
- [ ] Add one failing case per reason: missing/corrupt/stale input, manifest, snapshot, artifact, Part, validation object; snapshot not restorable; missing durable-work remote coverage; unsafe target/root; duplicate evidence; future observation; invalid freshness window.
- [ ] Implement exact evidence matching against the manifest plus explicitly required Part/validation entries, freshness calculation from caller-supplied integers, snapshot-restorable requirement, work coverage, and deletion-policy preflight. Accumulate deterministic reasons without short-circuiting and perform no deletion.
- [ ] Prove no cleanup API is connected to CLI/queue and default config remains false. Run full gates and commit `feat(v2): deny cleanup without fresh complete proof`.

### Task 5: Phase 6 verification, review, and audit

**Files:** update `docs/rebuild/AUDIT-LOG.md` and `docs/rebuild/00-MASTER-PLAN.md`.

- [ ] Run full v2/compile, real junction, corrupt/missing remote object, schema migration/future version, interruption-at-every-boundary, existing-target-untouched, cleanup denial matrix, forbidden import, secret filename, diff, and legacy baseline gates.
- [ ] Request independent review from the Phase 6 plan commit through implementation HEAD. Resolve all Critical/Important findings with TDD and re-review.
- [ ] Audit exact commits/results/remaining Python 3.10, production remote, active-target replacement, and cleanup-disabled risks. Hand off to Phase 7 offline slice.
- [ ] Commit `docs(rebuild): audit staged restore cleanup phase`.

Expected: clean worktree; cleanup remains disabled; no local deletion executor, push, merge, PR, public entry-point change, or production remote action.
