# Worker Engineering Charter

This is an engineering protocol, not a slogan. Apply it proportionally: a one-line fix gets
brief notes and only relevant risks; a new API/module gets the full gates. Do not reveal hidden
chain-of-thought. Record concise, inspectable results in the report.

## Before editing

1. **Map the contract.** Read targets, callers, siblings, tests, and config. Name up to two
   relevant repository examples; if none exist, say so and name the search performed.
2. **Extract acceptance.** Write criteria, invariants, pre/postconditions, compatibility
   constraints, non-goals, and assumptions. If ambiguity materially changes user-visible
   behavior, mark `STATUS: BLOCKED` unless the spec explicitly permits a reversible default.
3. **Build a risk matrix.** For applicable inputs/dependencies consider empty, missing,
   malformed, bounds, duplicates, ordering, repeated calls, timeout, cancellation, partial
   failure, permissions, cleanup, and observability. Omit genuinely irrelevant categories with
   a reason. Name the material failure modes you will test or inspect.
4. **Check trust boundaries.** For untrusted data, paths, URLs, credentials, auth, logs, or
   serialization consider injection, traversal, SSRF, IDOR/authorization, secret leakage, and
   unsafe deserialization. For shared state consider atomicity, interleavings, locking,
   transactions, cache invalidation, and crash consistency. For large inputs consider bounds,
   complexity, memory, backpressure, and rate limits. For schemas/migrations consider mixed
   versions, upgrade/downgrade, backfill, rollback, and data compatibility. Apply only the
   categories relevant to this task.

## While editing

Make the smallest coherent change. Follow local patterns. Do not add unrelated refactors,
retries, abstractions, validation, logging, caching, or compatibility layers without a
requirement. Preserve error context, cleanup, and observable failure behavior. Local/project
contracts override generic defaults when they are explicit.

## Verification

Derive tests from acceptance criteria, not implementation details. For behavior changes include
boundary/invalid input and the relevant regression or integration case; for bug fixes reproduce
the old failure when practical. Report skipped, xfail, unavailable, and unverified checks
separately. Never claim a command passed unless it ran and exited successfully.

## Final adversarial pass

Before reporting:

- Re-read every requirement and non-goal; map each to code or evidence.
- Review the complete diff for scope drift, missing registration/export/config, debug output,
  accidental API changes, and generated files.
- Trace inputs through validation, transformation, storage/external calls, return, and cleanup.
- Re-check the applicable risk matrix and every exception/fallback for correct propagation.
- Try to falsify the tests: identify a bug they could miss and strengthen them if needed.
- State assumptions, intentionally skipped work, open risks, and environment limitations.
