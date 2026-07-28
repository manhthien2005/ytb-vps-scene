# Render S3 Multipart Progress

## Integration identity

- Repository: `https://github.com/manhthien2005/ytb-vps-scene`
- Target branch: `rebuild/v2`
- Feature branch: `codex/render-s3-multipart`
- Base SHA: `294f5b79fc67f1024ddf9989e802e6e380b174ae`
- Pull request: pending
- Merge SHA: pending

## Commits

| Commit | Evidence delivered |
|---|---|
| `a61f9ac` | S3 multipart design |
| `97f4666` | Executable implementation plan |
| `6dc4ade` | Deterministic chunk-to-Part planning |
| `58ffb7d` | Canonical rendered Part identities |
| `7ccd0cf` | Part-local timeline validation |
| `7e907d0` | Durable Part assembly |
| `7ac4438` | Independent local Part publication |
| `c7b9d17` | Ordered multipart worker uploads |
| `39e796a` | Drive multipart identity |
| `cca33e7` | Multipart OUTPUT persistence |
| `b9cbd0e` | Multipart upload resume API |
| `d581c0d` | Control-plane multipart projections |
| `a59078f` | Real FFmpeg multipart E2E |
| `2220343` | Serialized multipart output plan and stale-fence hardening |
| `ee1049d` | S2-compatible chunk reuse and configured-FPS propagation |
| `55e2dfd` | Atomic multipart completion and expiry-sweep lock ordering |

## Acceptance evidence

- Part planning is deterministic, contiguous, bounded by whole render chunks,
  and uses the canonical media FPS instead of a hard-coded 30 FPS.
- Every chunk and every Part has an independent work unit and durable artifact.
  Corrupt or missing chunks/Parts rerun only their affected units and downstream
  finalization.
- A real S2 render fingerprint and legacy single-output plan migrate to S3
  without increasing any completed chunk attempt count.
- FFmpeg E2E renders a 12-second source as 8-second and 4-second Parts with
  240 and 120 frames, zero-based timestamps, audio signal at both ends, and no
  missing or duplicated visual boundary.
- Neon schema v12 stores `(part_index, part_count)`, v13 freezes one
  `output_part_count` per job, and v14 backfills durable Part identity/progress
  maps for databases that already applied v13. Job-row serialization rejects
  conflicting totals, stale reserve/complete calls after lease takeover, and
  duplicate READY Part ownership.
- A crashed PENDING identity can be superseded; deterministic A→B→A retry can
  resurrect the exact DELETED identity without mutating READY bytes.
- A job completes only after the exact ordered READY Part set exists. Replay of
  an already READY Part is idempotent.
- Drive list/delete/read models preserve stable Part order and Part identity.
- Native configuration parses `render.max_part_seconds`; canonicalization,
  chunk planning, rendering, concat, and validation all use configured media
  FPS and canvas limits.

## Verification

| Command | Result |
|---|---|
| `PYTHONPATH=src python -m pytest tests_v2 -q` | `620 passed, 13 skipped, 484 subtests passed` |
| `npm test` in `web` | Passed; `npx vitest list` reports `1207` tests |
| `npm run typecheck` in `web` | Passed |
| `npm run lint` in `web` | `0` errors; `3` pre-existing unrelated warnings |
| `npm run build` in `web` | Next.js production build passed |
| `git diff --check` | Passed |

The legacy root suite still stops while collecting
`tests/test_pipeline_resume.py`: `app/ytb_vps/pipeline.py` imports the absent
`run_static_ocr_samples`. The same missing symbol exists on
`origin/rebuild/v2`; S3 changes no file under `app/` or `tests/`.

## Review closure

The independent review findings were addressed with focused regressions:

- output-plan count and lease/takeover races are serialized;
- S2 fingerprints no longer invalidate completed render chunks;
- `max_part_seconds` is parsed by the compatibility loader;
- configured FPS reaches every multipart media operation;
- deterministic DELETED artifact identities can be replayed safely;
- concurrent same-Part reservations and different-Part completions serialize on
  the job row under PostgreSQL `READ COMMITTED`;
- expiry recovery follows `job → attempt/worker` lock ordering, closing the
  completion-versus-sweep deadlock cycles.

Final independent re-review: no remaining findings.

## Deferred S4-S8 scope

S4-S8 remain out of scope: user-selected Part boundaries, parallel heavy FFmpeg
execution, additional OCR/translation/TTS/analyze and scene-editor work,
YouTube publication, and Publisher private-beta hardening.
