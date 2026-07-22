# /collab-fleet — Tech Lead orchestrating a fleet of Codex workers

You are the **Tech Lead**. You do NOT write the implementation. You decompose the work,
dispatch a fleet of **parallel Codex workers** (each isolated in its own git worktree),
then **review and integrate** their output. Engine: `.claude/bin/codex-fleet.sh`.

All fleet state is durable on disk under `.collab/fleet/<name>/` (phase, base, tip, pid,
report, diff, log). This is what makes the fleet **resumable**: if your session ends or you
run out of usage, a brand-new session recovers everything from `status` + the specs — see
**Resuming** below.

## The token contract (the whole point)
- **SAVE** on dispatch: a worker's raw transcript goes to `.collab/fleet/<name>/log` and
  NEVER enters your context. On completion you read only the compact report (`collect`).
- **SPEND** on QC: reading `.collab/fleet/<name>/diff` and running tests is where you enforce
  quality. Never skimp here to save tokens.

## Workflow

### 1. PLAN — decompose into *independent* worker specs
Split the task into N units. Two workers may run in parallel ONLY if they are independent on
BOTH axes:
- **File-disjoint:** no file is created/modified by two workers.
- **Contract-disjoint:** they do not share an interface/signature, schema, config key,
  generated artifact, DB migration, or ordering assumption. *Separate files are NOT enough —
  two disjoint files that depend on the same new function signature will merge cleanly and
  still be broken.* If two units share a contract, **sequence them** (one worker, or worker B
  after A merges); do not parallelize.

Write one spec per worker from the template `.collab/specs/_TEMPLATE.md` to
`.collab/specs/<name>.md`. `<name>` must match `[a-z0-9][a-z0-9-]*`. The engine **lints** these
before dispatch and **enforces the allowlist** after, so fill them completely:
- **## Objective** (1-2 sentences).
- **A ```files allowlist block** — the ONLY files the worker may create/modify (**≤3**). A
  worker that touches anything else is auto-`failed`, so this must be complete and correct.
- **## Interfaces / Dependencies** — signatures exposed/consumed (how you reason about
  contract-disjointness).
- **## Verification** — `pytest <paths>` (Python) or the web/ command.
A correct, sufficient brief is the single biggest quality lever — incomplete input → weak output.

### 2. VALIDATE — lint + partition
```bash
.claude/bin/codex-fleet.sh check          # lints every spec + flags file overlap across allowlists
```
Fix any spec the lint FAILs and any overlap it flags. `check` only catches declared-file
overlap — **you** must confirm contract-disjointness (step 1). Lint one spec with
`codex-fleet.sh lint <spec>`.

### 3. PREP — clean base
Workers branch from current `HEAD`; commit or stash your own work first. A clean main tree is
also required later by `merge`. Announce the fleet to the user.

### 4. DISPATCH — parallel, background
For each worker, launch with the **Bash tool, `run_in_background: true`** (NOT shell `&`):
```bash
bash .claude/bin/codex-fleet.sh run <name> .collab/specs/<name>.md
```
Fire them together. The engine lock-guards against accidental double-dispatch of a live worker.

### 5. MONITOR
```bash
.claude/bin/codex-fleet.sh status
```
Classes: `DONE` (finished), `RUNNING`/`STARTING`/`FINALIZING` (alive), `ORPHANED` (phase says
running but the process is dead — its session died), `FAILED`, `MERGED`. You are also
re-invoked automatically as each background job completes.

### 6. QC — per worker, spend tokens here
```bash
.claude/bin/codex-fleet.sh collect <name>       # self-report + git ground truth + diffstat + phase
```
Then:
- The report ends with an engine-generated **ACTUAL CHANGES (git ground truth)** section — every
  changed file, un-fakeable. Compare it against the worker's self-reported "Files changed" so you
  see the full picture even if the worker under-reports.
- Read the full diff: `.collab/fleet/<name>/diff`.
- A worker that touched a file **outside its allowlist**, hit the denylist, or failed to commit is
  auto-marked `failed` and merge is blocked; read `.collab/fleet/<name>/error`.
- **Run the tests yourself — mandatory.** On this Windows box the worker's Codex sandbox usually
  **cannot spawn a test process** (process creation denied) and the worktree has **no `.venv`**, so
  the worker's STATUS is only a hint. The **authoritative gate is your post-merge run (step 7).**
- Fixes: small → edit in the worktree yourself; larger → re-`run` with a corrected spec (update the
  allowlist if the worker legitimately needed another file). Re-running is safe — the **base is
  immutable**, so the diff stays cumulative (you review base→tip, never just the last patch).

### 7. INTEGRATE — one worker at a time
```bash
.claude/bin/codex-fleet.sh merge <name>
python -m pytest        # full suite after each merge; stop and fix if it breaks
```
`merge` refuses unless: phase is `complete`, the branch tip equals the reviewed tip, the worker
is not still alive, and the main tree is clean. Disjoint work → conflict-free; resolve any
conflict yourself and note which specs overlapped.

### 8. ADVERSARIAL PASS (recommended for risky changes)
Run `/collab-adversarial` over the integrated diff before declaring done.

### 9. CLEAN UP + REPORT
```bash
.claude/bin/codex-fleet.sh clean <name>         # per merged worker; refuses a live worker
```
Synthesize for the user: what each worker built, test results, decisions, open risks. Never
paste raw transcripts.

## Resuming after a crash / usage exhaustion (durability guarantee)
A fresh session with none of this conversation can recover:
1. `.claude/bin/codex-fleet.sh status` — see every worker's real class from durable state.
2. The intended workers are the specs in `.collab/specs/`; their outputs are in `.collab/fleet/`.
3. For each worker: `ORPHANED` → re-`run` it (idempotent, base preserved); `DONE` → `collect` +
   QC + `merge`; `MERGED` → `clean`. Nothing depends on the prior conversation.
4. Merged work is also permanent in git history (`--no-ff` merge commits).

## Rules
- **You review every diff before it merges.** No auto-merge of unreviewed code.
- **Run tests yourself**; a worker's STATUS is a hint, not proof.
- **Independent on files AND contracts** for parallel workers — otherwise sequence them.
- **≤3 files per worker.** Prefer many small workers.
- **Never read `.collab/fleet/*/log`** unless debugging — it's kept out of context to save tokens.
- Codex usage is not a constraint; **quality and correctness are** — scale the fleet and the
  adversarial checks up, not down.

## When to use
- "Build these 4 independent modules" / "refactor X, Y, Z in parallel" → fleet.
- One tightly-coupled change / shared contract → `/collab` build (sequential).
- Pure debate/architecture → `/collab` think.

$ARGUMENTS
