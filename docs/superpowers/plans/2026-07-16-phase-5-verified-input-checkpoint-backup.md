# Phase 5 Verified Input and Checkpoint Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source identity, verified input archival, additive checkpoint copies, canonical manifests, and integrity-checked SQLite snapshots durable enough that no expensive stage can start before the source is recoverable.

**Architecture:** Pure identity, evidence, and manifest values live in `domain`; application services coordinate narrow filesystem, additive-store, and state ports. Filesystem adapters stream hashes, publish through same-directory temporary files, fsync completed files, and reject unsafe paths. SQLite migrates monotonically to schema v2, enforces the input-durability gate when starting post-ingest work, creates snapshots only through the SQLite backup API, and verifies `integrity_check` before a snapshot can be copied. A local additive store is the deterministic provider used by tests and the later offline slice; production remote providers will implement the same port without changing this phase's contracts.

**Tech Stack:** Python 3.10–3.12 standard library (`dataclasses`, `hashlib`, `json`, `os`, `pathlib`, `sqlite3`, `tempfile`, `typing.Protocol`, `unittest`).

## Global Constraints

- Work directly on `rebuild/v2`; do not create or switch product branches.
- Preserve the legacy package, database, public entry point, tag, and bundle.
- Treat every source, workspace, manifest, and store path as untrusted; resolved paths must stay inside their declared root.
- Hash with streaming SHA-256 reads; never load video or database files fully into memory.
- Input archive publication is same-directory temporary copy, file fsync, atomic replace into an absent destination, read-back size/hash verification, and parent-directory sync where supported.
- An existing matching archive or additive object is idempotent; an existing mismatching object is a hard conflict and is never overwritten or deleted.
- Additive checkpoint publication copies data objects first and the manifest last. No operation may delete or replace an already-published checkpoint object.
- Canonical manifests are versioned JSON with sorted keys, compact separators, portable POSIX keys, exact lowercase SHA-256 hashes, exact sizes, job/source identity, and an integrity-checked state snapshot.
- SQLite schema v2 stores verified input and completed checkpoint evidence. Post-ingest work cannot transition to RUNNING without a verified-input row matching the job source hash.
- SQLite snapshots use `sqlite3.Connection.backup`, are opened independently, and must return exactly `ok` from `PRAGMA integrity_check` before hashing or publication.
- Artifact files are re-read and checked against committed SQLite metadata before checkpoint publication. Missing or mismatching artifacts fail without publishing the manifest.
- Credentials, provider SDKs, network access, clocks, and local filesystem paths do not enter `domain`.
- Cleanup remains disabled. Restore, cleanup, fresh remote evidence, and production remote providers remain later phases.
- Apply TDD and one-purpose Conventional Commits; do not push.

---

## File map

- `src/ytb_vps_v2/domain/backup.py`: immutable digest, source identity, archive evidence, manifest entry, and checkpoint manifest values.
- `src/ytb_vps_v2/domain/__init__.py`: domain exports.
- `src/ytb_vps_v2/ports/backup.py`: source archiver, additive object store, and checkpoint state protocols.
- `src/ytb_vps_v2/ports/state.py`: verified-input/checkpoint evidence methods.
- `src/ytb_vps_v2/adapters/filesystem/__init__.py`: filesystem adapter exports.
- `src/ytb_vps_v2/adapters/filesystem/integrity.py`: streaming digest and root-confinement helpers.
- `src/ytb_vps_v2/adapters/filesystem/archive.py`: verified input archive adapter.
- `src/ytb_vps_v2/adapters/filesystem/additive.py`: deterministic additive local object store.
- `src/ytb_vps_v2/adapters/sqlite/schema.py`: monotonic schema v2 migration.
- `src/ytb_vps_v2/adapters/sqlite/state.py`: verified-input gate and checkpoint evidence persistence.
- `src/ytb_vps_v2/adapters/sqlite/backup.py`: SQLite backup API snapshot and integrity validation.
- `src/ytb_vps_v2/application/checkpoints.py`: canonical manifest construction and publish-last checkpoint orchestration.
- `tests_v2/domain/test_backup.py`: pure value and canonical manifest tests.
- `tests_v2/adapters/filesystem/test_archive.py`: archival, idempotence, conflict, path, and fault tests.
- `tests_v2/adapters/filesystem/test_additive.py`: additive-copy and no-overwrite tests.
- `tests_v2/adapters/sqlite/test_durability.py`: schema v2, verified-input gate, and snapshot tests.
- `tests_v2/application/test_checkpoints.py`: full checkpoint ordering, verification, and fault tests.
- `docs/rebuild/AUDIT-LOG.md`: append-only Phase 5 evidence.
- `docs/rebuild/00-MASTER-PLAN.md`: status handoff to Phase 6.

### Task 1: Source identity and canonical backup values

**Files:**
- Create: `src/ytb_vps_v2/domain/backup.py`
- Modify: `src/ytb_vps_v2/domain/__init__.py`
- Create: `tests_v2/domain/test_backup.py`

**Interfaces:**
- Produces: `FileDigest`; `SourceIdentity`; `VerifiedInputArchive`; `ManifestEntry`; `CheckpointManifest`; `canonical_manifest_bytes(manifest) -> bytes`; `parse_manifest_bytes(raw) -> CheckpointManifest`.

- [ ] **Step 1: Write failing domain and serialization tests**

Cover exact runtime types, boolean/integer rejection, non-empty bounded text, safe portable POSIX keys, lowercase SHA-256, non-negative sizes, unique sorted manifest keys, manifest version 1, exact `JobId`, matching source/archive digest, required state snapshot entry, deterministic UTF-8 bytes across insertion orders, strict unknown/missing JSON fields, duplicate keys, non-canonical JSON, and malformed Unicode/JSON.

- [ ] **Step 2: Run the focused test and observe the missing backup module**

Run: `python -m unittest tests_v2.domain.test_backup -v`

Expected: import error.

- [ ] **Step 3: Implement pure immutable values and strict canonical JSON**

Use frozen, slotted dataclasses. `CheckpointManifest` contains `version`, `checkpoint_id`, `job_id`, `source`, `input_archive`, `state_snapshot`, `artifacts`, and `created_at`. Serialization uses a closed schema, `sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False`, and one trailing newline. Parsing accepts only bytes, rejects duplicate JSON object keys with `object_pairs_hook`, reconstructs exact domain values, and requires re-serialization to match the original bytes.

- [ ] **Step 4: Run focused, full v2, and compile tests**

Expected: backup domain tests and all 65 prior v2 tests pass.

- [ ] **Step 5: Review and commit**

Run diff, staged filename, secret filename, and `git diff --check` gates. Commit:

`git commit -m "feat(v2): define checkpoint manifest contracts"`

### Task 2: Verified input archive and additive local store

**Files:**
- Create: `src/ytb_vps_v2/ports/backup.py`
- Modify: `src/ytb_vps_v2/ports/__init__.py`
- Create: `src/ytb_vps_v2/adapters/filesystem/__init__.py`
- Create: `src/ytb_vps_v2/adapters/filesystem/integrity.py`
- Create: `src/ytb_vps_v2/adapters/filesystem/archive.py`
- Create: `src/ytb_vps_v2/adapters/filesystem/additive.py`
- Create: `tests_v2/adapters/filesystem/__init__.py`
- Create: `tests_v2/adapters/filesystem/test_archive.py`
- Create: `tests_v2/adapters/filesystem/test_additive.py`

**Interfaces:**
- Produces: `BackupStoreError`; `SourceArchiver` protocol; `AdditiveObjectStore` protocol; `digest_file(path) -> FileDigest`; `VerifiedInputArchiver(root).archive(source, job_id, at) -> VerifiedInputArchive`; `LocalAdditiveObjectStore(root).put(source, key, expected) -> ManifestEntry`.

- [ ] **Step 1: Write failing filesystem contract tests**

Use temporary roots and chunked fixture files. Prove streamed digest correctness; archive naming derives from source SHA-256 and a sanitized suffix rather than an untrusted filename; source mutation during copy fails; publication leaves no `.part` files; matching repeat calls are idempotent; conflicting existing destinations fail unchanged; symlinks/reparse escapes, absolute keys, `..`, Windows drive paths, directories, missing files, and roots that are not exact `Path` values fail explicitly.

For the additive store, prove a new object is verified after copy, a matching existing object is reused, mismatching existing content is never overwritten, nested POSIX keys remain confined, injected read/write failures publish no final object, and no public delete/replace operation exists.

- [ ] **Step 2: Run focused tests and observe missing ports/adapters**

Run: `python -m unittest discover -s tests_v2/adapters/filesystem -v`

Expected: import errors.

- [ ] **Step 3: Implement streaming, confinement, atomic publication, and additive semantics**

Resolve and compare roots with `Path.resolve(strict=True)` and `os.path.commonpath`; reject symlinked source/archive/store targets at every existing path component. Copy into a random same-directory temporary file opened exclusively, hash while writing, flush and `os.fsync`, verify source identity did not change, then publish only if the final path is absent. Always remove owned temporary files in `finally`; never remove a final destination. Verify final bytes independently before returning evidence. Parent directory fsync is required on POSIX and best-effort on Windows when the platform does not support directory handles.

- [ ] **Step 4: Run fault, focused, full v2, and compile tests**

Expected: all filesystem fault cases and all prior tests pass.

- [ ] **Step 5: Review and commit**

Run repository gates and commit:

`git commit -m "feat(v2): archive inputs with verified additive copies"`

### Task 3: Schema v2, durable input gate, and SQLite snapshots

**Files:**
- Modify: `src/ytb_vps_v2/adapters/sqlite/schema.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/__init__.py`
- Create: `src/ytb_vps_v2/adapters/sqlite/backup.py`
- Modify: `src/ytb_vps_v2/ports/state.py`
- Create: `tests_v2/adapters/sqlite/test_durability.py`
- Modify: existing SQLite work-unit tests only to establish verified input where a post-ingest start is intended.

**Interfaces:**
- Raises `SCHEMA_VERSION` to 2.
- Produces: `SqliteStateStore.record_verified_input(job_id, evidence) -> None`; `verified_input(job_id) -> VerifiedInputArchive | None`; `record_checkpoint(job_id, manifest_entry, state_entry, at) -> None`; `completed_checkpoints(job_id) -> tuple[CheckpointRecord, ...]`; `create_sqlite_snapshot(connection, destination, expected_name) -> ManifestEntry`.

- [ ] **Step 1: Write failing migration, gate, persistence, and snapshot tests**

Prove a fresh database and a real schema-v1 fixture migrate to v2 without losing rows. Schema v2 adds `input_archives` and `checkpoint_snapshots`, with foreign keys and uniqueness constraints. Recording input requires a digest equal to `jobs.source_sha256`; repeat matching evidence is idempotent and conflict fails. INGEST may start before archival; OCR/TRACK/TRANSLATE/TTS/RENDER/PUBLISH/BACKUP may not. After a matching input record, post-ingest starts succeed and the gate survives reopen.

Snapshot tests hold a live WAL connection with committed rows, invoke the SQLite backup API into an absent same-directory target, independently open the snapshot, require exact `integrity_check == ok` and schema compatibility, and verify its hash/size. Inject backup interruption, corrupt snapshot bytes, existing conflicting target, and integrity failure; each must leave no published snapshot or checkpoint evidence.

- [ ] **Step 2: Run focused tests and observe schema/API failures**

Run: `python -m unittest tests_v2.adapters.sqlite.test_durability -v`

Expected: schema version and missing-method failures.

- [ ] **Step 3: Implement migration 2 and enforce the database-level durability invariant**

Migration 2 runs inside `BEGIN IMMEDIATE`, creates closed-schema evidence tables, sets `user_version=2`, and rolls back completely on failure. `start_work_unit` adds a database predicate requiring a matching `input_archives` row for every stage except INGEST; a zero-row update distinguishes missing durability from an invalid transition without weakening compare-and-set behavior.

`create_sqlite_snapshot` accepts the owned live connection and an absent exact `Path`, uses `connection.backup(snapshot_connection)`, checks integrity and schema on the independent connection, closes it, fsyncs the file, verifies digest, and atomically publishes. It never uses raw file copy on the live database.

- [ ] **Step 4: Run schema-v1 migration, restart, snapshot-fault, full, and compile tests**

Expected: every prior SQLite contract remains green and all new durability tests pass.

- [ ] **Step 5: Review and commit**

Run repository gates and commit:

`git commit -m "feat(v2): gate work on durable input snapshots"`

### Task 4: Publish-last checkpoint orchestration

**Files:**
- Create: `src/ytb_vps_v2/application/checkpoints.py`
- Modify: `src/ytb_vps_v2/application/__init__.py`
- Modify: `src/ytb_vps_v2/ports/backup.py`
- Create: `tests_v2/application/test_checkpoints.py`

**Interfaces:**
- Produces: `CheckpointError`; `CheckpointPublisher`; `CheckpointPublisher.publish(job_id, checkpoint_id, workspace_root, snapshot_dir, at) -> CheckpointManifest`.

- [ ] **Step 1: Write failing orchestration and ordering tests**

Build real temporary state/workspace files with the SQLite and local additive adapters. Prove publishing requires verified input evidence; creates an integrity-checked SQLite snapshot; verifies every valid committed artifact file against size/hash; emits one canonical manifest containing the archive, snapshot, and exactly the valid artifacts; copies data objects before the manifest; records checkpoint evidence only after the manifest verifies; and repeats idempotently with the identical manifest.

Fault tests cover missing/mutated artifacts, invalid artifact paths, snapshot failure, store failure before the manifest, store failure on the manifest, manifest conflict, state-record failure, and retry after every fault. No failure may publish a success record; failures before the final put must publish no manifest; already-published additive objects remain unchanged and safely reusable on retry.

- [ ] **Step 2: Run focused tests and observe the missing application service**

Run: `python -m unittest tests_v2.application.test_checkpoints -v`

Expected: import error.

- [ ] **Step 3: Implement narrow orchestration with manifest-last completion**

Load verified input and valid artifact metadata through ports. Resolve every local file under its declared root, re-hash it, and compare exact metadata. Create the state snapshot, build sorted `ManifestEntry` values, serialize the manifest once, and publish archive/artifacts/snapshot first. Write canonical manifest bytes to an owned temporary local file, publish it last under `checkpoints/<job>/<checkpoint>/manifest-v1.json`, read/parse it back through the additive-store contract, then record the completed checkpoint in SQLite. Wrap adapter errors without exposing paths outside declared roots or file content.

- [ ] **Step 4: Run interruption matrix, focused, full v2, compile, and import-direction tests**

Expected: deterministic idempotent checkpoint publication, safe retry at every boundary, and all prior tests pass.

- [ ] **Step 5: Review and commit**

Run repository gates and commit:

`git commit -m "feat(v2): publish verified checkpoint manifests"`

### Task 5: Phase 5 verification, review, and audit

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`
- Modify: `docs/rebuild/00-MASTER-PLAN.md`

- [ ] **Step 1: Run fresh Phase 5 gates**

Run compile and full v2 discovery, schema-v1 migration, input mutation and additive conflict faults, SQLite backup integrity checks, checkpoint interruption matrix, canonical manifest round-trip, forbidden legacy/import-direction scans, `git diff --check`, and legacy discovery with `PYTHONPATH=app`.

- [ ] **Step 2: Request independent review**

Use `superpowers:requesting-code-review` from the Phase 5 plan commit through Task 4 HEAD. Resolve every Critical and Important finding using `superpowers:receiving-code-review`, systematic debugging where applicable, and TDD; request re-review.

- [ ] **Step 3: Audit and update status**

Append exact hashes, commands, results, review outcome, remaining Python 3.10/production-remote/restore/cleanup risks, and Phase 6 handoff. Update the master status to show Phases 0–5 complete.

- [ ] **Step 4: Commit documentation**

Run documentation, secret filename, staged filename, and diff gates. Commit:

`git commit -m "docs(rebuild): audit verified checkpoint phase"`

Expected: worktree clean; cleanup remains disabled; no push, merge, PR, public entry-point change, or production remote action.
