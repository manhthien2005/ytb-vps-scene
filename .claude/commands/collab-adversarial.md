# /collab-adversarial — Independent adversarial review by Codex

Same-model self-review is a known anti-pattern: a model is blind to its own mistakes in
the same way twice. This command gets an **independent** model (Codex) to attack a scoped
diff, hunting the high-severity failure classes. Use it before merging anything
security- or data-sensitive. (This replaces the `codex-plugin-cc` `/codex:adversarial-review`
command without needing the plugin, MCP, or tmux.)

Codex runs **read-only** here — it reports, it does not edit.

## 1. Scope the diff
- Uncommitted work → `git diff HEAD` (+ untracked via `git status --porcelain`).
- A fleet worker → its branch: `git -C .worktrees/<name> diff <base>..HEAD` (or read
  `.collab/fleet/<name>/diff`).
- A range the user gives → `git diff <base>..<head>`.

List the changed source files and write a 2-3 sentence summary of intent (Codex is
stateless — give it the "supposed to do", so it can judge against intent, not just style).

## 2. Call Codex (read-only, deepest reasoning)
```bash
CODEX_EFFORT=max .claude/bin/codex-bridge.sh think "Adversarially review this change. You are trying to BREAK it, not praise it. Hunt specifically for, in priority order:
1. Auth / authorization holes (missing checks, privilege escalation, IDOR).
2. Data loss / corruption (destructive ops without guards, bad migrations, lost writes).
3. Race conditions & concurrency (TOCTOU, unguarded shared state, ordering assumptions).
4. Resource leaks (unclosed handles/connections, unbounded growth).
5. Unhandled edge cases & error paths (empty/None, boundary values, partial failure).
For each finding: file:line, the concrete failure scenario (inputs → wrong outcome), and severity. If you find nothing in a category, say so. Do not invent issues.

Files changed: [list paths]
Intended behavior: [your 2-3 sentence summary]
[Any specific concern the user raised]"
```
(Codex reads the files itself; keep the prompt tight. Bump nothing else — `max` effort is
set inline for this call only.)

## 3. Synthesize
Present to the user, most severe first:
- Confirmed real issues (with the failure scenario) — and your fix recommendation.
- Findings you assessed and **dismissed**, with why (don't relay noise as if it were real).
- Anything you independently spotted that Codex missed.

If it's a fleet integration, feed confirmed issues back as a corrective `run` for the
owning worker, or fix small ones yourself.

## Rules
- Read-only — Codex must not modify files in this command.
- Verify each finding against the actual code before reporting it as real; a plausible-
  sounding bug that can't actually happen is noise.
- Synthesize, don't paste raw Codex output.
- If the diff is empty, tell the user and ask what to review.

$ARGUMENTS
