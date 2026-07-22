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

**How it works:** Claude calls `codex exec` via bash. Codex's response streams
directly into Claude's context. Claude reads it, reasons about it, synthesizes.
No tmux, no file polling, no third-party tools. Build tasks run asynchronously
in the background so the user can keep talking to Claude while Codex works.

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
branch `codex/<name>`, from current `HEAD`. Codex's `workspace-write` sandbox is scoped to
that worktree, so a worker **physically cannot** touch the main tree or a sibling's files.
Disjoint specs → clean merges (disjoint on files AND shared contracts/interfaces, not just
files). Lifecycle: `run` → `collect` → review → `merge` → `clean`.

**Durable + resumable:** all worker state lives under `.collab/fleet/<name>/` (phase machine,
immutable base SHA, reviewed tip, PID). If a session dies mid-fleet, a fresh Claude runs
`status` — each worker shows `DONE`/`RUNNING`/`ORPHANED`/`FAILED`/`MERGED` from durable phase +
PID liveness — and recovers: re-`run` orphans (idempotent, base preserved), QC+`merge` the done
ones. Intended workers = specs in `.collab/specs/`; merged work is also permanent in git history.

**Token contract — the reason this exists:**
- SAVE on dispatch: a worker's raw reasoning transcript goes to `.collab/fleet/<name>/log`,
  which **never enters Claude's context**. When a worker finishes, Claude reads only the
  compact report (`collect`), ~400 tokens.
- SPEND on QC: reading the real diff (`.collab/fleet/<name>/diff`) and running the tests is
  where the lead enforces quality. Never skimp here to save tokens.

**Safety gates (engine-enforced):** worker names must be `[a-z0-9][a-z0-9-]*`; stale non-worktree
dirs are rejected (isolation); denylist writes (`secrets/`, `web/.env*`, `web/src/lib/security/`,
`config/`) auto-fail a worker; `merge` requires phase=complete + tip match + clean main tree;
`clean` refuses a live worker; background `codex exec` uses `< /dev/null` (else it hangs on stdin).

**Engine subcommands:** `run <name> <spec>` (launch worker — always via the Bash tool's
`run_in_background: true`, never shell `&`), `collect <name>`, `status`, `check` (flag
files claimed by >1 spec), `merge <name>`, `clean <name>`. Env: `CODEX_MODEL`,
`WORKER_EFFORT` (default `xhigh`), `FLEET_MAX_FILES` (soft warn, default 3).

**Not installed by design:** the official `openai/codex-plugin-cc` was evaluated and
declined for this repo — its parallel `agent-team` needs tmux (absent on this Windows/
Git-Bash box) and its MCP server adds idle token overhead every session. The worktree
fleet above gives the same parallelism, Windows-native, with zero idle cost.
