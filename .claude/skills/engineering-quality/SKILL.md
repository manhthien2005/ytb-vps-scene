---
name: engineering-quality
description: "Quality-first orchestration for Codex coding workers: complete specs, contract-safe decomposition, adversarial self-review, ground-truth reports, and evidence-based QC. Use before delegating implementation or reviewing worker output."
argument-hint: "[task or worker name]"
metadata:
  author: ytb-vps-scene
  version: "1.0.0"
---

# Engineering Quality — Tech Lead Protocol

Use this skill when Claude delegates implementation to a Codex worker. It does not train
model weights. It improves the worker's behavior by supplying a stable engineering charter,
complete input, observable quality gates, and independent verification.

## Before dispatch

1. Read the relevant source, callers, sibling implementations, tests, and configuration.
2. Write a spec from `.collab/specs/_TEMPLATE.md`.
3. Make the spec explicit about:
   - objective and acceptance criteria;
   - the exact ` ```files ` allowlist (maximum three files per worker);
   - interfaces, schemas, generated outputs, and dependencies;
   - non-goals and constraints;
   - exact verification commands.
4. Parallelize only when workers are disjoint in both files **and contracts**. Shared
   signatures, schemas, config keys, migrations, generated artifacts, or ordering make
   tasks sequential even when files differ.
5. Run:
   ```bash
   .claude/bin/codex-fleet.sh check
   ```
   Do not dispatch a spec that fails lint, dependency validation, or case-insensitive allowlist
   overlap. Fix the spec first; the engine does not provide a spec-lint bypass.

The engine injects `.claude/collab/worker-charter.md` automatically. Do not replace it with
vague instructions such as "think deeply" or "write production-quality code"; required
artifacts and stop-gates have higher signal.

## What the worker must produce

The worker's report must contain:

- `STATUS: PASS|FAIL|BLOCKED`;
- concise summary;
- design notes: repository contract/examples, applicable edge/failure decisions, and the
  three likely failure modes considered;
- every file changed, tests actually run, decisions, assumptions, out-of-scope work, and
  open risks.

The engine stores independent `ground-truth.md` from the cumulative Git diff, so compare the
self-report against that file. A worker cannot author or spoof engine evidence.

## QC after dispatch

1. Run `collect <name>`; read the report, error, and full diff.
2. Check allowlist, denylist, scope, public interfaces, error propagation, cleanup, and
   test quality. Scope ground truth excludes benign ignored runtime/test caches but records
   ignored protected-path hits as policy failures. Reject happy-path-only tests and tests that
   merely mirror implementation.
3. Treat worker test claims as advisory. On this Windows sandbox, Codex may be unable to
   spawn Python/PowerShell processes. Run authoritative tests in a disposable integration
   worktree or candidate branch before approving; use the main tree only after the candidate
   SHA has passed.
4. Record evidence, then run `codex-fleet.sh approve <name> <evidence-file>`. Approval pins
   the exact tip, diff/evidence hashes, and current integration `HEAD` as `integration_sha`.
5. Merge only after `phase=approved`, the approval is not `STALE`, reviewed tip and hashes
   match, and the integration tree is safe. The global merge lock serializes integration and
   conflicts are aborted before the engine reports normal failure. Run the full relevant suite
   after each merge. Then use
   `/collab-adversarial` for auth, data-loss, race, resource, and boundary-sensitive changes.
6. If the latest clean fleet merge must be undone, use `rollback`; it creates a revert commit
   and never resets or rebases integration history.

## Quality calibration

- Small fix: concise gates and only relevant edge cases.
- New module or public API: full contract, failure matrix, adversarial review, behavior tests.
- Do not add retries, abstractions, validation, logging, or compatibility layers without a
  requirement. Over-engineering is a quality failure.
- Never ask the worker to reveal hidden chain-of-thought. Require concise, inspectable design
  notes and evidence instead.

## Resuming after Claude interruption

State lives in `.collab/fleet/<name>/`; conversation memory is not required:

```bash
.claude/bin/codex-fleet.sh status
```

- `ORPHANED`: re-run the same spec; immutable base preserves the cumulative diff.
- `READY`: collect, QC, run authoritative tests, approve, then merge.
- `BLOCKED` / `FAILED`: read report, `error`, and ground truth; correct the cause, then `retry`.
- `STALE`: integration `HEAD` moved after approval; rerun QC and reapprove with fresh evidence.
- Timeout: inspect `failure_kind`; a proven timeout is `FAILED`, while unproven descendant
  cleanup is `RECOVERY-REQUIRED`.
- `MERGING`: run `status` to reconcile the durable merge journal.
- `MERGED`: run integration tests; use `rollback` only while it is the latest clean merge.
- `ROLLED-BACK`: retain the revert, then clean when appropriate.
- `RECOVERY-REQUIRED`: stop automation and verify process/Git state manually.

Normal `clean` is limited to `MERGED` and `ROLLED-BACK`. Retained evidence in other non-live
states requires the explicit destructive form `clean --discard <name>`.

Before official production use, run one tiny harmless live Codex worker when authentication and
service availability permit. If live execution is unavailable, report the exact reason and keep
the disposable fake-Codex smoke results as the strongest available evidence.
