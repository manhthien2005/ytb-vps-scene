# /collab-doc — Codex Writes Documentation

Delegate documentation to Codex for a well-scoped change. Codex documents
**verified, actual behavior** — not aspirational behavior, and not a restatement
of the code. Docs that describe what the code *should* do (rather than what it
*does*) are worse than no docs.

## Establish scope FIRST

1. **Base ref.** Pin the change to document:
   - Uncommitted work → `git diff HEAD` (+ untracked via `git status --porcelain`)
   - A range → `git diff <base>..<head>` (use the ref the user gives)
2. **List what changed** and, in your own words, the behavior you have actually
   verified (from tests passing, from running it, from the conversation). Codex
   documents *this* — do not let it invent behavior it hasn't confirmed.
3. **Decide the doc target and format:**
   - Module/API reference → docstrings or a file under `docs/`
   - Architecture decision → an ADR under `docs/rebuild/adr/`
   - Feature/usage → the relevant README or `docs/` page
   - Ask the user if the target is ambiguous.

## Call Codex (build mode — it writes doc files)

```bash
.claude/bin/codex-bridge.sh build "Document the following change. Describe ACTUAL, VERIFIED behavior only — do not speculate about behavior you cannot confirm from the code, and do not just paraphrase the implementation line by line. Explain purpose, inputs/outputs, and how to use it.

Doc target: [path + format, e.g. docstrings in X, or docs/foo.md, or an ADR]
Follow existing doc style/structure in that location.

Changed files being documented:
[list paths]

Verified behavior to document:
[what you have confirmed the code does]

Do NOT modify source logic — docs and docstrings only. Do NOT touch: secrets/, web/.env*, web/src/lib/security/, config/. Do NOT document unrelated code outside this change." > .collab/codex-output.txt 2>&1 &
CODEX_PID=$!
echo "Codex PID: $CODEX_PID"
```

Async: tell the user Codex is documenting, poll per the /collab rules.

## Review when done

1. PID done → read `.collab/codex-output.txt` → `rm -f` it.
2. `git status --porcelain` — Codex should only touch doc files / docstrings. Reject changes to source logic or denylist paths (bridge logs a warning too).
3. Read the docs: are claims accurate against the real behavior? Delete any speculative or invented statements. Check it didn't drift into unrelated areas.
4. Report what was documented and where; note anything you corrected.

## Rules

- Document verified behavior, never aspiration or guesses.
- Docs/docstrings only — no source logic changes.
- Match the existing documentation style in the target location.
- Stay within the change's scope; reject scope creep.
- Synthesize the result for the user; don't relay raw Codex output.

$ARGUMENTS
