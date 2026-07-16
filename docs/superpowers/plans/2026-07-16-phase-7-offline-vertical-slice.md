# Phase 7 Deterministic Offline Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a deterministic 30-second fixture through INGEST, OCR, TRACK, TRANSLATE, TTS, RENDER, PUBLISH, and BACKUP entirely offline, producing verified local artifacts and a restorable checkpoint while proving restart safety at every stage boundary for sources with and without audio.

**Architecture:** The application service owns the fixed stage graph and persists one work unit plus one primary artifact per stage in the existing SQLite state store. Pure canonical JSON contracts carry media, cue, track, translation, and render-plan data; deterministic fake provider adapters supply OCR, translation, and TTS outputs. FFprobe performs semantic media inspection and FFmpeg performs the real render. A local artifact committer publishes every output through an exclusive same-directory temporary file, read-back verification, and no-replace rename before SQLite commits the artifact. On restart, stale work is recovered and a succeeded unit is skipped only when its recorded artifact still matches disk; otherwise the existing invalidation rules force recomputation from the damaged stage onward.

**Tech Stack:** Python 3.10–3.12 standard library (`dataclasses`, `fractions`, `hashlib`, `json`, `math`, `os`, `pathlib`, `subprocess`, `tempfile`, `typing.Protocol`, `unittest`, `wave`) plus installed `ffmpeg` and `ffprobe` executables.

## Global Constraints

- Work directly on `rebuild/v2`; preserve legacy and do not push.
- Use only generated 30-second, 320x180, CFR 30 fps fixtures; commit no binary media.
- The slice must run without network access, credentials, model downloads, or external provider SDKs.
- Keep pure domain/provider contracts free of subprocess, filesystem, SQLite, clock, and environment access.
- Use integer frames as the timeline authority. Serialized fractions use exact numerator/denominator pairs; JSON is canonical UTF-8 with sorted keys and no insignificant whitespace.
- The stage graph is fixed: `INGEST -> OCR -> TRACK -> TRANSLATE -> TTS -> RENDER -> PUBLISH -> BACKUP`. Each artifact records the immediate upstream artifact name as a dependency, except INGEST.
- Archive and record the verified input before starting non-INGEST work. Use one job per SQLite file in this slice.
- Every filesystem artifact is durable and independently hashed before `commit_artifact`; SQLite never records a temporary or unverified file.
- Artifact paths are fixed, safe, relative POSIX paths under a secured workspace root. Existing conflicting outputs are never overwritten.
- Resume may skip a succeeded unit only after exact size/hash read-back. Missing or corrupt output invalidates that stage and all downstream stages, then recomputes additively into an explicitly fresh workspace.
- Recover stale `RUNNING` work before scheduling. Provider or process failures record a bounded retry event; interruption simulation may deliberately leave `RUNNING` for startup recovery.
- FFmpeg/FFprobe calls use argument arrays, bounded captured diagnostics, explicit overwrite policy, deterministic codec/filter settings, and no shell invocation.
- RENDER must semantically validate duration, frame rate, dimensions, decodability, and expected audio policy. No-audio input must still complete deterministically.
- PUBLISH is local and additive. BACKUP uses the existing `CheckpointPublisher`; its artifact is a canonical checkpoint summary recorded only after remote-store read-back and SQLite checkpoint evidence exist.
- Phase 7 deliberately uses fake OCR/translation/TTS and a minimal render. Production providers, tracking quality, audio mixing, subtitle layout, and full compositing remain Phases 8–12.
- Apply TDD, one-purpose Conventional Commits, full verification, and independent review.

## File map

- `src/ytb_vps_v2/domain/pipeline.py`: canonical media/cue/track/translation/TTS/render/publication document contracts and codecs.
- `src/ytb_vps_v2/ports/pipeline.py`: probe, OCR, translation, TTS, renderer, publisher, artifact writer, and interruption protocols.
- `src/ytb_vps_v2/adapters/offline/providers.py`: deterministic fake OCR, translation, and WAV TTS providers.
- `src/ytb_vps_v2/adapters/ffmpeg/media.py`: fixture generation, ffprobe inspection, FFmpeg render, and semantic validation.
- `src/ytb_vps_v2/adapters/filesystem/artifacts.py`: secured durable artifact publication and verification.
- `src/ytb_vps_v2/adapters/filesystem/publish.py`: additive local Part publisher.
- `src/ytb_vps_v2/application/offline_slice.py`: fixed graph orchestration, resume validation, invalidation, failure recording, publish, and checkpoint integration.
- `tests_v2/domain/test_pipeline.py`: contract and canonical serialization tests.
- `tests_v2/adapters/offline/test_providers.py`: fake provider determinism tests.
- `tests_v2/adapters/ffmpeg/test_media.py`: audio/no-audio probe, render, corruption, and semantic validation tests.
- `tests_v2/adapters/filesystem/test_artifacts.py`: atomicity, conflict, path, and fault-injection tests.
- `tests_v2/application/test_offline_slice.py`: full slice and stage-boundary restart matrix.

### Task 1: Canonical offline pipeline contracts

**Files:** create `domain/pipeline.py`; update domain exports; create `tests_v2/domain/test_pipeline.py`.

**Interfaces:** `MediaDocument`; `OcrDocument`; `TrackDocument`; `TranslationDocument`; `TtsDocument`; `RenderPlanDocument`; `PublicationDocument`; `CheckpointDocument`; `canonical_document_bytes`; strict per-document parse functions.

- [ ] Write failing tests for exact runtime types, schema version, 30-second frame bounds, ordered unique cue indexes, in-frame boxes, exact fraction encoding, non-empty text, safe relative artifact references, SHA-256 syntax, and cross-document identity/dependency consistency.
- [ ] Write failing canonical JSON round-trip tests and reject unknown/missing keys, booleans-as-integers, floats, duplicate semantic indexes, unsafe paths, non-canonical bytes, and unsupported versions.
- [ ] Implement frozen slotted values and strict explicit codecs; reuse existing `Timeline`, `FrameInterval`, `BoundingBox`, `Cue`, `BlurRegion`, `Part`, and `FileDigest` values instead of parallel primitives.
- [ ] Run focused/full/compile gates and commit `feat(v2): define offline pipeline documents`.

### Task 2: Durable workspace artifact commits and deterministic fakes

**Files:** create `ports/pipeline.py`, `adapters/filesystem/artifacts.py`, `adapters/offline/providers.py`, package exports, and focused tests.

**Interfaces:** `ArtifactWriter.write_bytes/write_file/verify`; `OcrProvider.detect`; `TranslationProvider.translate`; `TtsProvider.synthesize`; `DeterministicOcrProvider`; `DeterministicTranslationProvider`; `DeterministicWaveTtsProvider`.

- [ ] Write failing artifact tests for anchored safe paths, exact bytes/file streaming, exclusive random `.part`, file and parent sync, no-replace publication, independent read-back, idempotent matching destination, conflicting destination unchanged, symlink/reparse rejection, source mutation, injected write/sync/rename/read-back failures, and no orphan temporary files.
- [ ] Write failing fake-provider tests proving identical input/config yields byte-identical results across instances, OCR emits fixed frame-bounded detections, translation preserves cue identity/order, and TTS produces a valid deterministic PCM WAV plus exact cue timing metadata.
- [ ] Implement ports and adapters using Phase 5 filesystem primitives where applicable. Provider results must derive only from typed inputs and explicit configuration; no current time, randomness, locale, machine path, or environment data enters output bytes.
- [ ] Run focused/fault/full gates and commit `feat(v2): commit deterministic offline artifacts`.

### Task 3: FFmpeg fixture, probe, render, and validation adapter

**Files:** create `adapters/ffmpeg/media.py`, exports, and `tests_v2/adapters/ffmpeg/test_media.py`.

**Interfaces:** `FfmpegMediaAdapter.require_tools`; `create_fixture(destination, with_audio)`; `probe(source) -> MediaDocument`; `render(source, tts_wav, plan, destination)`; `validate_render(path, expected) -> MediaDocument`.

- [ ] Write failing tests that generate audio and no-audio fixtures, assert exact 900-frame/30-second/320x180/30-fps identity, and prove repeated generation has the same semantic identity.
- [ ] Write failing render tests for both fixtures, full decode success, exact dimensions/frame rate, duration tolerance of at most one frame, expected output audio, and rejection of truncated, malformed, wrong-duration, wrong-size, and non-video outputs.
- [ ] Write failure tests for missing executables, nonzero exit, timeout, bounded diagnostic text, invalid ffprobe JSON, unsafe destination conflict, and temporary-output cleanup.
- [ ] Implement shell-free subprocess calls. Generate fixtures with lavfi; use deterministic metadata, bitstream, pixel format, CFR, codec, and thread settings. Render to a caller-owned temporary path, map video and the deterministic TTS WAV, then validate before the artifact writer publishes it.
- [ ] Run focused audio/no-audio/corruption/full gates and commit `feat(v2): add deterministic ffmpeg media adapter`.

### Task 4: Restartable eight-stage offline orchestration

**Files:** create `adapters/filesystem/publish.py`, `application/offline_slice.py`, exports, and `tests_v2/application/test_offline_slice.py`.

**Interfaces:** `OfflineSliceRunner.run(request) -> OfflineSliceResult`; `OfflineSliceRequest`; `OfflineSliceResult`; `InterruptionPoint`; `LocalPartPublisher.publish`.

- [ ] Start with an end-to-end failing test: create fixture, archive input, create job/config fingerprints, run all eight stages, assert eight succeeded units, exact dependency chain, verified local Part, semantic render validation, completed checkpoint, state snapshot, and byte-identical canonical metadata on a clean rerun.
- [ ] Add the no-audio fixture and assert the same complete stage graph and deterministic result with explicit output-audio policy.
- [ ] Add interruption cases before provider/process work, after provider/process work, before filesystem publication, after filesystem publication but before SQLite commit, and after SQLite commit for every stage. Restart with a new runner/store connection; recover stale work; never duplicate or overwrite committed outputs; finish with one valid artifact per stage.
- [ ] Add corruption/missing-artifact resume tests. Verify exact on-disk hashes before skipping, compute an existing Phase 3 invalidation plan from the first damaged stage, mark downstream work/artifacts invalid, and recompute only into a fresh workspace. Reject ambiguous duplicate artifact names and dependency mismatches.
- [ ] Implement the fixed stage table and stage handlers: INGEST probe document; OCR fake detections; TRACK cues/blur plan; TRANSLATE target cues; TTS WAV plus metadata; RENDER MP4 plus semantic evidence; PUBLISH additive `Part 1/1`; BACKUP checkpoint plus canonical summary. Record bounded failures and preserve retry semantics.
- [ ] Keep the public CLI unchanged in Phase 7; exercise the application API directly. Run focused/interruption/full gates and commit `feat(v2): run restartable offline vertical slice`.

### Task 5: Phase 7 verification, review, and audit

**Files:** update `docs/rebuild/AUDIT-LOG.md` and `docs/rebuild/00-MASTER-PLAN.md`.

- [ ] Run the full v2 suite, compile gate, forbidden-import/secret scan, diff check, and unchanged legacy baseline.
- [ ] Run fresh real-tool evidence for both 30-second fixtures: end-to-end, full decode, ffprobe assertions, cold rerun, and interruption/restart at every declared boundary. Confirm no network access or provider credentials are required.
- [ ] Request independent review from the Phase 7 plan commit through implementation HEAD. Resolve every Critical/Important finding with TDD and re-review.
- [ ] Audit exact commits, test counts, media evidence, interruption coverage, and remaining Python 3.10/POSIX/production-provider/render-quality risks. Hand off to Phase 8 OCR preprocessing/provider contracts.
- [ ] Commit `docs(rebuild): audit offline vertical slice phase`.

Expected: clean worktree; two deterministic offline 30-second fixtures complete all eight stages with verified local Part and checkpoint evidence; restart succeeds at every stage boundary; no network, push, merge, PR, public CLI behavior change, production provider, cleanup execution, or committed binary fixture.
