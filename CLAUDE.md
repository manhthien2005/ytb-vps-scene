# CLAUDE.md

Project guidance for Claude Code in this repo.

## Project

`ytb-vps-scene-v2` — resumable VPS video localization pipeline (Python 3.10–3.12, `src/` layout, package `ytb_vps_v2`). Web UI under `web/` (Next.js).

## Testing

- Python: `pytest` (tests in `tests/` and `tests_v2/`)
- Web: run test/lint from `web/`

## Cross-Model Collaboration (Codex)

Claude Code can delegate work to OpenAI Codex via `.claude/bin/codex-bridge.sh`.
Both run on subscriptions — no API keys. The bridge script unsets `OPENAI_API_KEY`
so Codex never accidentally uses your project's API key for billing.

**Commands:**

| Command | Purpose |
|---------|---------|
| `/collab <task>` | Full collaboration: think, build, or debug with Codex |
| `/collab-review` | Quick second opinion from Codex on current changes |
| `/collab-test` | Codex writes behavior-first tests for a scoped diff (needs a base ref) |
| `/collab-doc` | Codex documents verified behavior of a scoped diff (needs a base ref) |
| `/collab-fleet <task>` | **Tech Lead mode:** decompose work → dispatch a fleet of parallel, worktree-isolated Codex workers → QC → integrate |
| `/collab-adversarial` | Independent adversarial review of a scoped diff (auth / data-loss / races / edge cases) |

**How it works:** Claude calls `codex exec` via bash. Think calls return directly. Build calls
use the Bash tool's `run_in_background: true`; the harness notifies on completion, so there is
no shell PID polling or shared output-file protocol. Claude reads an output artifact only when
diagnosis requires it, reviews the diff, runs tests, and synthesizes the result.

**Bridge modes:**
- `codex-bridge.sh think "prompt"` — read-only, for debate and review (sync)
- `codex-bridge.sh build "prompt"` — workspace-write, for implementation (async)
- `codex-bridge.sh build "prompt" path/to/spec.md` — build from spec file (async)

**Build specs** go in `.collab/specs/`. **Reports** go in `.collab/reports/`.

**Audit log:** every `build`-mode call appends a JSONL record to `.collab/collab.log`
(prompt SHA-256 — never the raw prompt, mode, exit code, duration, Codex version,
files actually changed via `git status`, denylist hits). If Codex touches a
protected path (`secrets/`, `web/.env*`, `web/src/lib/security/`, `config/`) the
bridge prints a loud stderr warning. This is transparency/audit, **not** a hard
block — always review Codex's diff before committing.

**Rules:**
- Never assign overlapping files to both Claude subagents and Codex
- Always run the test suite after Codex builds — never trust the self-report
- Keep Codex prompts concise (500 words max) — it has no session memory
- Synthesize Codex output for the user, don't relay it raw
- Compact context before starting a collab workflow
- Break large builds into 2-3 small focused Codex calls (max 3 files each)

## Fleet orchestration (Claude = Tech Lead, parallel Codex workers)

For work that splits into **independent, file-disjoint units**, Claude acts as Tech Lead
and fans it out to a **fleet of parallel Codex workers** via `.claude/bin/codex-fleet.sh`.
Use `/collab-fleet`. For one tightly-coupled change, use `/collab` build instead.

**Isolation via git worktrees (no tmux):** each worker runs in `.worktrees/<name>` on
branch `codex/<name>`, from an immutable base. Codex's `workspace-write` sandbox is scoped to
that worktree, so a worker **physically cannot** touch the main tree or a sibling's files.
Disjoint specs → clean merges (disjoint on files AND shared contracts/interfaces, not just
files). Lifecycle: plan → `check` → `run` → `status` → `collect` → QC → `approve` → `merge`
→ integration test → optional `rollback` → `clean`.

**Durable + resumable:** all worker state lives under `.collab/fleet/<name>/` (phase machine,
immutable base SHA, pinned spec/charter hashes, attempt metadata, report/diff ground truth,
approval, and merge journal). A fresh Claude runs `status` and recovers from durable classes:
`READY`, `BLOCKED`, `FAILED`, `APPROVED`, `STALE`, `MERGING`, `MERGED`, `ROLLED-BACK`,
`ORPHANED`, or `RECOVERY-REQUIRED`. `run` resumes only orphans; failed/blocked workers require
explicit `retry`. Missing durable branches are never recreated from current `HEAD`.

**Token contract — the reason this exists:**
- SAVE on dispatch: a worker's raw reasoning transcript goes to `.collab/fleet/<name>/log`,
  which **never enters Claude's context**. When a worker finishes, Claude reads only the
  compact report (`collect`), ~400 tokens.
- SPEND on QC: reading the real diff (`.collab/fleet/<name>/diff`) and running the tests is
  where the lead enforces quality. Never skimp here to save tokens.

**Safety gates (engine-enforced):** names/spec dependencies/allowlists are linted; Windows path
policy is separator- and case-normalized; SHA-256 tooling is required; the engineering charter,
spec, base, attempt, logs, and engine ground truth are durable; `FLEET_TIMEOUT_S` bounds worker
execution; approval pins tip/diff/evidence plus integration `HEAD`; a global lock serializes
merge; conflicts are aborted and journaled; rollback uses a revert commit. Scope uses tracked
and non-ignored untracked paths; benign ignored runtime/test caches are summarized but do not
fail workers or normal clean, while ignored protected paths still fail denylist policy. Normal
`clean` is limited to merged or rolled-back workers; other evidence needs explicit
`clean --discard`.

Before official production use, run one tiny harmless live Codex worker when auth, quota, and
service availability permit; otherwise record the exact environment limitation and retain the
disposable fake-Codex smoke evidence.

**Engine subcommands:** `run <name> <spec>` (launch worker — always via the Bash tool's
`run_in_background: true`, never shell `&`), `retry <name>`, `collect <name>`, `status`,
`check`, `approve <name> <evidence>`, `merge <name>`, `rollback <name>`, and
`clean [--discard] <name>`. Env: `CODEX_MODEL`, `WORKER_EFFORT` (default `xhigh`),
`FLEET_MAX_FILES` (default 3), `FLEET_TIMEOUT_S` (default 1800; `FLEET_TIMEOUT` alias),
`FLEET_CHARTER` (override charter path), `CODEX_FLEET_LAUNCHER` (optional executable wrapper or
`.ps1` launcher), and `CODEX_FLEET_PWSH` (PowerShell executable override). On WSL, a mounted
Windows npm Codex installation is launched through its adjacent `codex.ps1` so Windows receives a
normalized working directory; linked-worktree `.git` pointers are made relative so both WSL Git
and Windows Codex resolve the same metadata. PowerShell auto-selection prefers a non-`WindowsApps`
executable because Windows Store shims can be denied by the Codex sandbox; the Codex subprocess
`PATH` is also sanitized to remove `WindowsApps` and prefer system PowerShell for nested tools.
Launcher overrides are path/command values, never shell snippets, and missing or non-executable
launchers fail closed.
Run one harmless live Codex smoke before production use; if auth, quota, sandbox, path, or service
limitations prevent it, record the exact error and keep the fake smoke evidence instead of claiming
readiness.

**Not installed by design:** the official `openai/codex-plugin-cc` was evaluated and
declined for this repo — its parallel `agent-team` needs tmux (absent on this Windows/
Git-Bash box) and its MCP server adds idle token overhead every session. The worktree
fleet above gives the same parallelism, Windows-native, with zero idle cost.
