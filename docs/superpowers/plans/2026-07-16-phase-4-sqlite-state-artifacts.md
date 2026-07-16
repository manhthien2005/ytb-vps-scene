# Phase 4 SQLite State and Artifact Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned v2 SQLite store whose work-unit transitions, retry history, stale-run recovery, artifact records, and invalidation updates are transactional and independently testable.

**Architecture:** Persistence is isolated under `adapters/sqlite`; application code depends on a narrow protocol under `ports`. SQLite owns durable rows but receives timestamps from callers, uses `PRAGMA foreign_keys=ON`, WAL, and `synchronous=FULL`, and never imports legacy state.

**Tech Stack:** Python 3.10–3.12 standard library (`sqlite3`, `contextlib`, `json`, `pathlib`, `typing.Protocol`, `unittest`, `tempfile`).

## Global Constraints

- Work directly on `rebuild/v2`; do not create or switch product branches.
- Each v2 job database is named `job-v2.sqlite`; never open or migrate a legacy `job.sqlite` in place.
- Schema migrations are monotonic and tracked with `PRAGMA user_version`; a future schema version fails explicitly.
- Work-unit transitions are compare-and-set operations inside transactions; invalid source states raise `StateTransitionError`.
- `RUNNING` work becomes `PENDING` during stale recovery without losing its attempt history.
- A unit becomes `SUCCEEDED` only in the same transaction that records its validated durable artifact.
- Failed artifact insertion rolls back the success transition and leaves the work unit `RUNNING`.
- Artifacts store portable POSIX paths, sizes, checksums, owner stages, dependencies, validity, and commit time.
- Invalidation marks affected work units `INVALID` and their owned artifacts invalid while preserving independent rows.
- SQLite code must not create, rename, validate, or delete artifact files; filesystem durability belongs to later adapters.
- No database, subprocess, filesystem, network, clock, or vendor import enters `domain`.
- Apply TDD and one-purpose Conventional Commits; do not push.

---

## File map

- `src/ytb_vps_v2/domain/state.py`: state-specific errors and transition rules.
- `src/ytb_vps_v2/ports/__init__.py`: ports package.
- `src/ytb_vps_v2/ports/state.py`: repository protocol used by application code.
- `src/ytb_vps_v2/adapters/__init__.py`: adapters package.
- `src/ytb_vps_v2/adapters/sqlite/__init__.py`: SQLite adapter exports.
- `src/ytb_vps_v2/adapters/sqlite/schema.py`: schema version, migration SQL, connection configuration.
- `src/ytb_vps_v2/adapters/sqlite/state.py`: transactional repository implementation.
- `tests_v2/adapters/sqlite/test_schema.py`: migration, reopen, future-version, and corruption tests.
- `tests_v2/adapters/sqlite/test_work_units.py`: transition, retry, stale recovery, and restart tests.
- `tests_v2/adapters/sqlite/test_artifacts.py`: atomic success, rollback, and invalidation tests.
- `docs/rebuild/AUDIT-LOG.md`: append-only Phase 4 evidence.
- `docs/rebuild/00-MASTER-PLAN.md`: status handoff to Phase 5.

### Task 1: Versioned schema and connection policy

**Files:**
- Create: `src/ytb_vps_v2/adapters/__init__.py`
- Create: `src/ytb_vps_v2/adapters/sqlite/__init__.py`
- Create: `src/ytb_vps_v2/adapters/sqlite/schema.py`
- Create: `tests_v2/adapters/__init__.py`
- Create: `tests_v2/adapters/sqlite/__init__.py`
- Create: `tests_v2/adapters/sqlite/test_schema.py`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 1`; `StateStoreError`; `connect_database(path: Path) -> sqlite3.Connection`; `migrate(connection) -> None`.

- [ ] **Step 1: Write failing schema tests**

Tests create only temporary `job-v2.sqlite` paths and assert:

```python
connection = connect_database(path)
self.addCleanup(connection.close)
self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
self.assertTrue({"jobs", "config_fingerprints", "work_units", "artifacts", "retry_events"}.issubset(table_names(connection)))
```

Also reopen the same database twice and verify no rows disappear; set `user_version=2` and assert reopen raises `StateStoreError`; write non-SQLite bytes and assert a domain-specific error rather than a leaked `sqlite3.DatabaseError`.

- [ ] **Step 2: Run the focused test and observe missing SQLite modules**

Run: `python -m unittest tests_v2.adapters.sqlite.test_schema -v`

Expected: import error.

- [ ] **Step 3: Implement schema version 1**

Migration 1 creates exactly:

```sql
CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE config_fingerprints (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (job_id, stage)
);
CREATE TABLE work_units (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error_kind TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, unit_key)
);
CREATE TABLE artifacts (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    owner_stage TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name),
    UNIQUE (job_id, relative_path)
);
CREATE TABLE retry_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    error_kind TEXT NOT NULL,
    error_message TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (job_id, unit_key) REFERENCES work_units(job_id, unit_key) ON DELETE CASCADE
);
```

Run migration inside `BEGIN IMMEDIATE`; set `PRAGMA user_version=1` before commit. `connect_database` requires an exact `Path`, rejects filenames other than `job-v2.sqlite`, creates parent directories only when already present is not required (missing parent fails), sets row factory, foreign keys, WAL, busy timeout, and synchronous FULL, then calls `migrate`. Wrap SQLite errors as `StateStoreError` and close a failed connection.

- [ ] **Step 4: Run focused and full v2 tests**

Expected: schema tests and all 47 prior v2 tests pass.

- [ ] **Step 5: Review and commit**

Run compile, diff, staged filename, secret filename, and `git diff --check` gates. Commit:

`git commit -m "feat(v2): add versioned sqlite schema"`

### Task 2: Work-unit transitions, retry history, and stale recovery

**Files:**
- Create: `src/ytb_vps_v2/domain/state.py`
- Create: `src/ytb_vps_v2/ports/__init__.py`
- Create: `src/ytb_vps_v2/ports/state.py`
- Create: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Create: `tests_v2/adapters/sqlite/test_work_units.py`

**Interfaces:**
- Produces: `StateTransitionError`; `SqliteStateStore`; `StateRepository` protocol.
- `SqliteStateStore.create_job(job_id, source_fingerprint, config_fingerprints, at) -> None`.
- `SqliteStateStore.put_work_unit(job_id, unit, at) -> None`.
- `SqliteStateStore.get_work_unit(job_id, unit_key) -> WorkUnit`.
- `SqliteStateStore.start_work_unit(job_id, unit_key, at) -> WorkUnit`.
- `SqliteStateStore.fail_work_unit(job_id, unit_key, error_kind, error_message, at) -> WorkUnit`.
- `SqliteStateStore.recover_stale_work(at) -> tuple[tuple[JobId, str], ...]`.
- `SqliteStateStore.retry_events(job_id, unit_key) -> tuple[RetryEvent, ...]`.

- [ ] **Step 1: Write failing transition tests**

Cover: create/reopen job and unit; duplicate create is idempotent only when source/config identities match; `PENDING -> RUNNING` increments attempts; `RUNNING -> FAILED` stores one retry event; `FAILED -> RUNNING` increments attempts again; starting `RUNNING` or `SUCCEEDED` fails; failing a non-running unit fails; stale recovery converts every `RUNNING` unit to `PENDING` in one transaction and persists across reopen; missing jobs/units fail explicitly.

- [ ] **Step 2: Run focused tests and observe missing state interfaces**

Run: `python -m unittest tests_v2.adapters.sqlite.test_work_units -v`

Expected: import error.

- [ ] **Step 3: Implement typed rows and compare-and-set transitions**

Add this domain value:

```python
@dataclass(frozen=True, slots=True)
class RetryEvent:
    job_id: JobId
    unit_key: str
    stage: StageName
    attempt: int
    error_kind: str
    error_message: str
    recorded_at: str
```

It validates exact nested/enum/integer/text types. `StateRepository` is a runtime-checkable `Protocol` containing the public methods above. `SqliteStateStore` owns one connection, supports `close` and context-manager methods, uses `BEGIN IMMEDIATE` transactions, and converts rows into already-validated `WorkUnit`/`RetryEvent` values.

`start_work_unit` runs an UPDATE with `WHERE status IN ('PENDING','FAILED','INVALID')`; `fail_work_unit` runs an UPDATE with `WHERE status='RUNNING'` and inserts the retry event in the same transaction. Zero updated rows raise `StateTransitionError` and roll back. Timestamps must be non-empty trimmed strings supplied by the caller; error kind/message are trimmed and bounded to 128/4096 characters.

- [ ] **Step 4: Run focused, restart, and full tests**

Expected: every transition/restart case and all prior v2 tests pass.

- [ ] **Step 5: Review and commit**

Run repository gates and commit:

`git commit -m "feat(v2): persist work unit transitions"`

### Task 3: Atomic artifact success and exact invalidation

**Files:**
- Modify: `src/ytb_vps_v2/ports/state.py`
- Modify: `src/ytb_vps_v2/adapters/sqlite/state.py`
- Create: `tests_v2/adapters/sqlite/test_artifacts.py`

**Interfaces:**
- Produces: `SqliteStateStore.commit_artifact(job_id, unit_key, artifact, at) -> None`; `valid_artifacts(job_id) -> tuple[Artifact, ...]`; `apply_invalidation(job_id, plan, at) -> tuple[str, ...]`.

- [ ] **Step 1: Write failing atomicity and invalidation tests**

Tests must prove:

- committing from RUNNING inserts one valid artifact and changes the owning unit to SUCCEEDED;
- committing from PENDING/FAILED/SUCCEEDED fails without inserting or replacing rows;
- a duplicate artifact path/name constraint rolls back the unit success transition and leaves it RUNNING;
- reopening preserves the succeeded unit and artifact;
- a TTS invalidation plan marks only TTS/RENDER/PUBLISH/BACKUP units INVALID and invalidates only artifacts owned by those stages;
- OCR/independent INGEST rows are preserved;
- repeating the same invalidation is idempotent and returns an empty changed-key tuple;
- dependencies JSON is canonical and round-trips to the exact artifact tuple.

- [ ] **Step 2: Run focused tests and observe missing methods**

Run: `python -m unittest tests_v2.adapters.sqlite.test_artifacts -v`

Expected: attribute failures for the new methods.

- [ ] **Step 3: Implement atomic commit and invalidation transactions**

`commit_artifact` validates exact `JobId`, `Artifact`, and timestamp types; begins one immediate transaction; verifies the work unit is RUNNING and its stage equals `artifact.owner`; inserts the artifact with `json.dumps(dependencies, separators=(",", ":"), ensure_ascii=False)`; then compare-and-set updates that unit to SUCCEEDED and clears errors. Any insert/update error rolls back both operations and is wrapped as `StateStoreError` or `StateTransitionError` without logging artifact content.

`apply_invalidation` validates an exact `InvalidationPlan`, updates only units whose stage is in `affected_stages` and status is not already INVALID, sets their error columns null, marks artifacts with matching owners invalid, and returns changed unit keys sorted lexically. Both updates share one transaction.

- [ ] **Step 4: Run focused, fault, full, and compile tests**

Expected: atomic rollback and invalidation tests plus all prior v2 tests pass.

- [ ] **Step 5: Review and commit**

Run repository gates and commit:

`git commit -m "feat(v2): commit artifacts atomically"`

### Task 4: Phase 4 verification, review, and audit

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`
- Modify: `docs/rebuild/00-MASTER-PLAN.md`

- [ ] **Step 1: Run fresh Phase 4 gates**

Run compile and full v2 discovery, reopen/restart focused tests, a direct transaction rollback assertion, forbidden-import scan, `git diff --check`, and legacy discovery with `PYTHONPATH=app`.

- [ ] **Step 2: Request independent review**

Use `superpowers:requesting-code-review` from the Phase 4 plan commit through Task 3 HEAD. Resolve every Critical and Important finding using TDD and request re-review.

- [ ] **Step 3: Audit and update status**

Append exact hashes, commands, results, review outcome, remaining Python 3.10/filesystem-durability risks, and Phase 5 handoff. Update master status to show Phases 0–4 complete.

- [ ] **Step 4: Commit documentation**

Run documentation, secret filename, staged filename, and diff gates. Commit:

`git commit -m "docs(rebuild): audit sqlite state phase"`

Expected: worktree clean; no push, merge, PR, cleanup, or public entry-point change.
