# /collab-fleet - Tech Lead orchestrating Codex workers

You are the **Tech Lead**. Decompose work, dispatch isolated Codex workers, review engine
ground truth, approve exact candidates, and integrate one at a time. Engine:
`.claude/bin/codex-fleet.sh`.

Fleet state is durable under `.collab/fleet/<name>/`. Conversation history is never required
for recovery. Raw Codex output stays in each worker's `log`; quality decisions use the canonical
report, engine ground truth, diff, candidate SHA, and Tech Lead evidence.

## Lifecycle

### 1. PLAN - write complete, dependency-aware specs

Start from `.collab/specs/_TEMPLATE.md`. Each worker name must match its spec filename and
`# Spec:` value. Every spec declares:

- observable acceptance criteria and Definition of Done;
- exactly one ` ```files ` allowlist with at most three repo-relative files;
- interfaces and shared contracts;
- `depends-on: none` or a comma-separated worker list;
- constraints, non-goals, recovery behavior, and exact verification.

Parallelize only when workers are disjoint in both files and contracts. Shared signatures,
schemas, config keys, migrations, generated artifacts, or ordering require sequential work.
Dispatch dependencies in waves: every named dependency must reach `MERGED` before a dependent
worker can run.

Routing is a Tech Lead decision, not an engine scheduler:

- Small mechanical worker: default model with `xhigh` effort.
- Public API, concurrency, data-loss, or security work: higher effort plus adversarial review.
- Tightly coupled shared-contract change: sequential work, not fleet parallelism.

### 2. CHECK - lint contracts and partitioning

```bash
.claude/bin/codex-fleet.sh check
```

`check` rejects incomplete specs, unsafe paths, unknown/self/duplicate/cyclic dependencies,
and case-insensitive exact or prefix allowlist overlap. It cannot prove semantic contract
disjointness; the Tech Lead still reviews wave boundaries.

### 3. DISPATCH - use the Bash tool's background execution

Start each worker with the Bash tool and `run_in_background: true`; never use shell `&`:

```bash
bash .claude/bin/codex-fleet.sh run <name> .collab/specs/<name>.md
```

The harness notifies when the command completes. `run` creates a new worker or resumes only an
`ORPHANED` `created`/`running` worker. It refuses `READY`, `APPROVED`, `MERGING`, `MERGED`,
`ROLLED-BACK`, `FAILED`, `BLOCKED`, and `RECOVERY-REQUIRED`. If durable state exists but the
worker branch is missing, the engine fails instead of recreating it from current `HEAD`.

Retry an intentional terminal failure explicitly:

```bash
.claude/bin/codex-fleet.sh retry <name>
```

`retry` is allowed only from `FAILED` or `BLOCKED`. It validates immutable base/spec/charter
hashes before replacing attempt outputs, increments `attempt`, archives prior evidence where
practical, and appends a log separator.

Set `FLEET_TIMEOUT_S` to a positive number of seconds (default `1800`); `FLEET_TIMEOUT` is a
compatibility alias. A proven timeout becomes `FAILED` with `failure_kind=timeout`. If fallback
watchdog cleanup cannot prove descendants stopped, the engine uses `RECOVERY-REQUIRED`.

Before production use, run one tiny harmless live Codex smoke with a one-file allowlist. On
Windows/WSL, the engine automatically uses the adjacent `codex.ps1` through `pwsh.exe` when the
`codex` npm launcher is on a mounted Windows path; this keeps the worker working directory in
Windows form instead of passing `/mnt/...` to Windows Node. For PowerShell-launched workers it
also rewrites the linked-worktree `.git` pointers to portable relative paths that both WSL Git
and Windows Codex can resolve. Set `CODEX_FLEET_LAUNCHER` to an
executable wrapper when a site-specific launcher is required, or set it to a `.ps1` path to use
PowerShell explicitly. PowerShell auto-selection prefers a non-`WindowsApps` executable
(`powershell.exe`/`pwsh.exe`) because Windows Store shims can be denied by the Codex sandbox;
the Codex subprocess `PATH` is also sanitized to remove `WindowsApps` and prefer system
PowerShell for nested tool execution. `CODEX_FLEET_PWSH` overrides that executable when needed.
These overrides are path/command values only, not shell snippets; an unavailable or
non-executable launcher fails closed before dispatch. If the live smoke still fails, record the exact launcher,
path, sandbox, auth, quota, or service error and keep the fake smoke evidence; do not claim live
readiness.

### 4. STATUS - monitor durable state

```bash
.claude/bin/codex-fleet.sh status
```

Classes:

- `READY`: clean PASS candidate awaiting Tech Lead QC.
- `BLOCKED`: valid BLOCKED report with clean engine gates; use `retry` after resolving it.
- `FAILED`: worker FAIL, timeout, malformed report, nonzero exit, or engine gate failure.
- `APPROVED`: exact tip/diff/evidence approved against the current integration SHA.
- `STALE`: durable phase is `approved`, but integration `HEAD` moved since approval.
- `MERGING`: merge journal is active under the global merge lock.
- `MERGED`: recorded merge commit passed parent/tree verification.
- `ROLLED-BACK`: the recorded merge was reverted successfully.
- `ORPHANED`: `created` or `running` has a dead PID; resume with `run`.
- `RECOVERY-REQUIRED`: cleanup, merge, or rollback safety could not be proven; inspect state
  before taking manual action.

PID liveness is ignored outside `created`/`running`, and terminal transitions remove the PID.
On restart, `status` reconciles an abandoned `merging` phase: unchanged clean `HEAD` restores
`approved`; an expected merge commit with the recorded parents becomes `merged`; anything else
becomes `recovery-required`.

### 5. COLLECT + QC - trust engine ground truth

```bash
.claude/bin/codex-fleet.sh collect <name>
```

Review:

- `.collab/fleet/<name>/report.md` (worker claim);
- `ground-truth.md`, `changed.paths`, `diff`, `tip`, `error`, and `failure_kind`
  (engine-owned facts);
- the raw `log` only when diagnosing a failure.

The report must contain one `STATUS: PASS|FAIL|BLOCKED` and every canonical report section.
Malformed or missing reports become `FAILED` with a minimal engine report. Valid FAIL and
BLOCKED reports are preserved. `changed.paths` contains tracked and non-ignored untracked scope
only. Benign ignored runtime/test artifacts (for example `.pytest_cache`, `__pycache__`,
`web/.next`, `web/node_modules`, and coverage caches) are summarized separately and do not fail
scope or normal clean. Ignored protected paths such as `.env`, `secrets/`, `config/`, and
`web/src/lib/security/` remain denylist failures, including case variants; ignored paths that
overlap the allowlist are recorded separately. Ground truth always wins if the worker
under-reports.

Run authoritative tests against the exact candidate tip in a disposable integration context.
Write non-empty evidence with the SHA, exact commands, exit statuses, counts, skipped checks,
and review decisions.

### 6. APPROVE - pin candidate and integration context

```bash
.claude/bin/codex-fleet.sh approve <name> .collab/evidence/<name>.md
```

Approval is allowed from `READY`, or from a `STALE` approval after fresh QC. It records the
candidate `tip`, diff hash, evidence hash, current integration `HEAD` as `integration_sha`,
reviewer, and time. Approval briefly holds the global integration lock while snapshotting HEAD,
so a concurrent fleet merge cannot race the approval record. Never auto-rebase or auto-reapprove.
If integration `HEAD` moves, status shows `STALE` and merge refuses until fresh evidence is
approved.

### 7. MERGE - serialize and fail cleanly

```bash
.claude/bin/codex-fleet.sh merge <name>
```

The atomic global lock `.collab/fleet/merge.lock` spans preflight, hash checks, merge, journal,
and phase update. A stale lock is recovered only when its PID is dead. Merge requires:

- phase `approved` and current `HEAD == integration_sha`;
- exact approved branch tip, diff hash, and evidence hash;
- worker branch ancestry from immutable base;
- clean tracked integration state and no interfering non-ignored untracked path.

The engine writes `merge.before`, `merge.worker_tip`, `merge.commit`, and `merge.after`. It sets
`merging` before invoking Git. A conflict is aborted automatically; only a verified original
HEAD and clean index become normal `FAILED` with `failure_kind=merge-conflict`. An unverified
abort becomes `RECOVERY-REQUIRED`. There is no auto-conflict resolution or auto-merge.

### 8. INTEGRATION TEST - verify after every merge

Run the relevant integration/regression suite after each merge and compare the result with the
original task acceptance criteria. For risky changes, run `/collab-adversarial`. A worker
report is never proof that integration tests passed.

### 9. ROLLBACK - revert only the latest clean fleet merge

```bash
.claude/bin/codex-fleet.sh rollback <name>
```

Rollback is allowed only from `MERGED`, with a fully clean tree and current `HEAD` exactly equal
to the recorded merge commit. It uses `git revert --no-edit -m 1`, never reset or rebase. A
conflict is aborted and verified; success records `rollback.sha` and phase `rolled-back`.
Rollback writes a pre-revert journal, and `status` reconciles a crash after a verified revert
commit or marks ambiguous state `RECOVERY-REQUIRED`.

### 10. CLEAN - retain unresolved evidence by default

```bash
.claude/bin/codex-fleet.sh clean <name>
```

Normal clean is allowed only for `MERGED` or `ROLLED-BACK` and always refuses a live worker.
Benign ignored caches in a completed worker worktree do not block normal clean.
It does not delete `READY`, `APPROVED`, `BLOCKED`, `FAILED`, or `RECOVERY-REQUIRED` evidence.
Do not clean a merged dependency until its dependent workers no longer need dispatch or retry.
Destruction of retained non-live state requires an explicit decision:

```bash
.claude/bin/codex-fleet.sh clean --discard <name>
```

## Recovery rules

- `ORPHANED`: verify why the process died, then resume with `run <name>`; immutable hashes and
  branch must still exist.
- `BLOCKED` / `FAILED`: inspect report, error, ground truth, and diff; correct the cause, then
  use `retry`.
- `STALE`: rerun QC against current integration `HEAD`, then reapprove with fresh evidence.
- `MERGING`: run `status` to reconcile the merge journal.
- `RECOVERY-REQUIRED`: stop automation and inspect Git HEAD/index, worker process descendants,
  and durable journal before manual recovery.

## Non-goals

No daemon, service, database, scheduler, auto-retry, auto-rebase, auto-conflict-resolution,
auto-approval, auto-merge, or reset-based rollback.

$ARGUMENTS
