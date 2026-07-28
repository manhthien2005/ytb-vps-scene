# Render S2 — Chunk Durability Progress

Status: complete on isolated branch `codex/render-s2-chunk-durability`.

Base: `rebuild/v2` at `2149c8a`.

## Delivered commits

| Commit | Outcome |
|---|---|
| `d2f232d` | S2 design |
| `2149c8a` | Executable S2 plan |
| `aa51cc3` | Canonical render chunk plans |
| `1d3915f` | Work-unit dependency model |
| `25037b2` | SQLite per-unit dependency persistence |
| `0b72820` | Scene render inputs in invalidation identity |
| `34604ff` | Deduplicated chunk checkpoint objects |
| `08d9583` | Exact local-timeline FFmpeg chunk encoding |
| `8064b57` | Verified stream-copy chunk concatenation |
| `353dbe1` | Resume from committed chunks |
| `61d928c` | Native scene/config fingerprints and three-chunk E2E |
| `ba2b0c7` | Host-loss restore and corruption isolation acceptance |

## Acceptance evidence

- Focused Render/Checkpoint/Offline/FFmpeg/native suite:
  `61 passed, 1 skipped, 63 subtests`.
- Complete v2 suite:
  `587 passed, 13 skipped, 464 subtests`.
- Real FFmpeg native test:
  12-second 320×180 source, three 4-second chunks, audio present in
  0–4/4–8/8–12 second windows, timed mask active only from seconds 3–8,
  and all three chunk units committed in SQLite.
- Host-loss test:
  restored the second verified chunk checkpoint into an empty host and rendered
  only chunks 2 and 3; chunks 0 and 1 retained attempts and checksums.
- Corruption test:
  corrupting chunk 2 rerendered only chunk 2 plus final
  Render/Publish/Backup; OCR/Track/Translate/TTS and sibling chunks were reused.
- Scene invalidation test:
  a mask-only change preserved OCR/Translate/TTS and invalidated Render and its
  downstream stages.

## Durability decisions

- Chunk artifact paths and work-unit keys are canonical and stable.
- Every committed chunk receives a verified v2 checkpoint.
- A restored worker may adopt an already verified remote checkpoint only when
  job identity, input identity, and the complete artifact set match exactly.
- Auxiliary render plan/chunk artifacts are verified during resume even when
  the final rendered file is still valid.
- Damaged chunk recovery uses an empty fresh workspace, copies only verified
  siblings, and never overwrites a corrupt stable path.

## Deferred scope

S3–S8 remain outside this slice. No merge, push, PR, cleanup-policy enablement,
or changes to unrelated web/tools work were performed.
