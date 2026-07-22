# /collab-test — Codex Writes Tests

Delegate test authoring to Codex for a well-scoped change. Codex writes tests
that verify **required behavior**, not tests that merely mirror the current
implementation (mirror-tests pass even when the code is wrong).

## Establish scope FIRST (non-negotiable)

A vague "test what I just built" produces vague tests. Before calling Codex,
pin down exactly what is under test:

1. **Base ref.** Determine the diff to be tested:
   - Uncommitted work → `git diff HEAD` (and list untracked files with `git status --porcelain`)
   - A specific range → `git diff <base>..<head>` (use the ref the user gives, e.g. `main..HEAD`)
2. **List the changed source files** (exclude tests/docs). These are the test targets.
3. **State the required behavior** in your own words: what each changed unit is
   *supposed* to do, its inputs, outputs, and edge cases. This is the spec Codex
   tests against — derive it from requirements/conversation, not from reading the
   implementation back.
4. If scope is unclear or spans unrelated changes, ask the user to narrow it.

## Call Codex (build mode — it writes test files)

Keep the prompt tight. Codex is stateless and can read the files itself.

```bash
.claude/bin/codex-bridge.sh build "Write tests for the following change. Test the REQUIRED BEHAVIOR described below, not the implementation details — a test must fail if the behavior is wrong.

Test framework: pytest (project convention). Place tests under tests_v2/ mirroring the source path. For web/ changes use its own test setup.

Changed source files (test targets):
[list paths]

Required behavior (the spec to test against):
[your behavior description — inputs, outputs, edge cases, error paths]

Do NOT modify any non-test file. Do NOT touch: secrets/, web/.env*, web/src/lib/security/, config/. Run the relevant tests when done and report pass/fail." > .collab/codex-output.txt 2>&1 &
CODEX_PID=$!
echo "Codex PID: $CODEX_PID"
```

Async: tell the user Codex is writing tests, check per the /collab polling rules.

## Review when done (never trust the self-report)

1. Check PID done, read `.collab/codex-output.txt`, then `rm -f` it.
2. `git status --porcelain` — confirm Codex only added/changed test files. Reject writes to source or denylist paths (the bridge logs a warning too).
3. Read the tests: do they assert *behavior*, or just restate the code? Flag tautological/trivial tests.
4. Run `pytest` yourself. Report real coverage of the behavior, and any gaps Codex missed.

## Rules

- Behavior-first, not implementation-mirroring.
- Codex writes ONLY test files here — source stays owned by Claude.
- Always run the suite yourself; synthesize results, don't relay raw output.
- If there is no change to test, tell the user and ask what to cover.

$ARGUMENTS
