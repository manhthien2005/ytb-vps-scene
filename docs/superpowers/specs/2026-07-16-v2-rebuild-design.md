# YTB VPS Scene v2 Rebuild Design

Status: approved for documentation
Approved: 2026-07-16
Branch: `rebuild/v2`
Baseline: `ba1ad85fe73330376ceb4ba048d9b6fd8392ba38`

## 1. Purpose

Build a clean, production-grade v2 implementation beside the audited legacy
application. The new implementation must be contract-first, test-first,
resumable after process or host loss, safe to restore, deny cleanup unless
durability is proven, and independently installable on Python 3.10.

Legacy source remains unchanged and available for behavioral comparison until
the final cutover commit. Source and tests are the final evidence when legacy
documentation conflicts with runtime behavior.

## 2. Confirmed product decisions

- The canonical timeline is `media.target_fps`; the default is 30 FPS.
- Publish Part count is `max(1, ceil(duration_seconds / 1800))`.
- Production OCR prefers ONNX. Docker legacy OCR is optional and must pass the
  same provider contract tests.
- `scene_voiceover` fails clearly until it has a supported implementation.
- `cleanup_after_upload` defaults to `false`.
- Cleanup cannot be enabled by an upgrade and cannot run until all durability
  and fault-injection gates pass.
- TTS audio is never truncated without an explicit, observable policy result.
- Cached `remote_verified` state is not evidence of current remote integrity.
- Large legacy modules are not copied or refactored into v2.
- User-facing compatibility is preserved where safe: existing CLI commands,
  configuration names, and Google Drive layout remain accepted through explicit
  compatibility adapters and deprecation warnings.
- V2 owns a new state schema. It never mutates a legacy job database in place.

## 3. Considered approaches

### 3.1 Modular monolith with ports and adapters — selected

Domain rules and application orchestration remain plain Python. External
systems are accessed through small interfaces. This provides deterministic
tests, low operational overhead, and explicit failure boundaries on a
resource-constrained VPS.

### 3.2 Strangler wrappers around legacy stages — rejected

Wrapping legacy stages would produce an earlier demo, but it would also carry
forward the known timeline, backup, remote verification, and checkpoint
coupling. It conflicts with the requirement not to preserve bugs or copy large
legacy modules.

### 3.3 External workflow engine — rejected

A separate workflow service would duplicate SQLite resume semantics and add
deployment, memory, recovery, and authentication overhead. The target VPS does
not justify that operational cost.

## 4. Package and dependency boundaries

V2 lives in `src/ytb_vps_v2/`. It does not import `app/ytb_vps/`.

- `domain/`: timeline, typed identifiers, jobs, cues, regions, Parts,
  artifacts, state transitions, and dependency fingerprints. No filesystem,
  subprocess, database, network, wall-clock, or vendor imports.
- `application/`: use cases and stage orchestration. It coordinates ports and
  owns retry, resume, invalidation, and safe-boundary rules.
- `ports/`: protocols for state, artifacts, OCR, translation, TTS, rendering,
  publishing, remote storage, clock, and identity generation.
- `adapters/`: SQLite, local filesystem, FFmpeg, ONNX OCR, optional Docker OCR,
  Codex, CapCut, and Google Drive/rclone implementations.
- `interfaces/`: CLI, doctor, configuration compatibility, and service runner.

The public `ytb-vps` command remains mapped to legacy until a dedicated cutover
commit. Before cutover, the v2 CLI is available through an explicit development
entry point so both implementations can be exercised side by side.

## 5. Canonical timeline

All processing coordinates use a `Timeline` value whose FPS comes from
`media.target_fps`. Source FPS is probe metadata and an input normalization
concern only.

- Frame intervals are half-open: `[start_frame, end_frame)`.
- Start times convert with floor; end times convert with ceiling.
- Intervals are clamped to `[0, total_frames]`.
- Empty regions are rejected and no accepted region may have
  `start_frame > end_frame`.
- OCR detections, cue tracking, blur regions, TTS slots, render chunks, and
  publish boundaries use the same frame coordinate system.
- Fixtures at 24, 25, 29.97, and 30 source FPS prove normalization into the
  canonical timeline.

Render chunks remain bounded and move forward to avoid splitting an active cue
or an indivisible TTS unit. Publish Parts are formed from whole render chunks
and target at most 30 minutes through
`max(1, ceil(duration_seconds / 1800))`.

## 6. Typed configuration and invalidation

Configuration is parsed into typed immutable values. Unknown keys produce a
clear warning or error according to compatibility policy; they are never
silently ignored.

Each stage declares the configuration and upstream artifact fingerprints on
which it depends. Invalidation follows the dependency graph instead of a single
pipeline-wide signature. Runtime parallelism does not invalidate content.
Changing a TTS voice invalidates TTS and downstream work; changing an OCR model
invalidates OCR and downstream work.

Legacy configuration names are translated at the interface boundary. The
translated typed configuration, warnings, and effective values are visible in
doctor and job inspection output.

## 7. State, migrations, and artifact commit

Each v2 job owns `job-v2.sqlite`. Schema changes are monotonic migrations with
an explicit schema version and migration tests. Core records cover:

- job identity and probed media;
- stage runs and attempt/error history;
- work units for chunks, batches, groups, and Parts;
- artifacts with owner, size, checksum, and dependency fingerprint;
- current remote evidence;
- snapshot and restore metadata.

A work unit succeeds only through this sequence:

1. Write output to a `.part` path.
2. Close and flush the output.
3. Validate its semantic contract.
4. Atomically rename it to the durable local path.
5. Calculate and record its checksum.
6. In one SQLite transaction, record the artifact and mark the work unit
   `SUCCEEDED`.

After restart, stale `RUNNING` work returns to `PENDING`. A succeeded artifact
is revalidated under its declared policy. Missing or corrupt data invalidates
only its owning unit and dependent nodes. Completed independent work remains
reusable.

## 8. Provider contracts

Every external capability has a narrow port and deterministic fake.

- OCR returns typed detections in canonical frame coordinates. ONNX and Docker
  implementations run the same schema, coordinate transform, smoke, and error
  contract suite.
- Translation accepts typed batches and context, returns exactly the requested
  IDs, and fingerprints model, prompt revision, and context.
- TTS returns audio plus provider identity and fit metadata. Provider, voice,
  text, and fit policy are part of the cache signature.
- Rendering accepts an immutable render plan and produces a validated chunk.
- Remote storage exposes upload, download, stat, and verification operations;
  presence is not inferred from a local flag.

Provider failures use bounded retry. Exhausted work fails clearly without
deleting successful independent artifacts. Fakes never require network access,
credentials, vendor SDKs, or production models.

## 9. Offline vertical slice

The first end-to-end slice processes a 30-second fixture through ingest,
checkpoint, fake OCR, tracking, blur planning, fake translation, fake TTS,
FFmpeg render, Part publication, and state snapshot.

It is fully offline and deterministic. Where codec bytes cannot be guaranteed
identical across platforms, manifests and semantic validation remain
deterministic. Restart tests interrupt the slice at every stage and within each
work-unit type, then prove reuse of previously committed artifacts.

## 10. Backup and remote evidence

Input is archived and verified before expensive processing. Durable state and
artifacts are backed up after safe boundaries with additive copy operations.
Local deletion never drives remote deletion.

Remote evidence records the remote path, observed size, available hash,
verification time, and verification method. Resume, publish, and cleanup obtain
fresh evidence; a historic boolean is insufficient.

SQLite snapshots use the SQLite backup API and pass `integrity_check` before
upload. Snapshot manifests identify all artifacts required for a supported
restore point.

## 11. Staged restore

Restore never writes directly over the active workspace:

1. Download into a new staging directory.
2. Verify the manifest and every required artifact checksum.
3. Run SQLite `integrity_check`.
4. Validate job identity, source identity, and migration compatibility.
5. Migrate in staging when required and re-run validation.
6. Atomically swap staging into place only after every gate succeeds.

Failure leaves the current workspace untouched and produces an actionable
report.

## 12. Deny-by-default cleanup

`cleanup_after_upload` defaults to `false`. Cleanup requires fresh proof that:

- the input archive exists and matches;
- every published Part and validation artifact exists and matches remotely;
- a valid, restorable state snapshot exists;
- all required durable work units have remote copies;
- every deletion target resolves inside an explicitly allowed root.

A missing or corrupt remote Part, unarchived input, invalid snapshot, stale
evidence, or unsafe path denies cleanup. Cleanup remains disabled until all
fault-injection tests pass and an operator enables it deliberately.

## 13. Security

- Credentials remain outside source, Git, backups, logs, and test fixtures.
- Subprocess calls use argument arrays without shell interpolation.
- Paths from filenames, manifests, providers, and remotes are untrusted.
- Network download adapters require HTTPS, explicit host policy, private and
  link-local address rejection, timeouts, and size limits.
- Production services run with least privilege. Docker access is not granted to
  the service user merely to support an optional backend.
- Secret and tracked-filename gates run before each phase commit.

## 14. Test strategy and quality gates

- Unit tests cover timeline conversion, invariants, domain transitions,
  dependency invalidation, and cleanup decisions.
- Contract tests run against deterministic fakes and real adapters where the
  environment permits.
- The offline 30-second integration test covers the complete v2 flow.
- Audio and no-audio fixtures run at source FPS 24, 25, 29.97, and 30.
- Restart tests interrupt every stage and unit type.
- Fault injection covers remote loss/corruption, upload interruption, TTS and
  render interruption, damaged local SQLite, and failed staged restore.
- CI performs a clean install and full suite on Python 3.10.
- A 10-minute soak test measures RAM, swap, VRAM, disk, inodes, runtime, and
  remote growth before production-length inputs are allowed.

The release gate is all discovered tests with zero failures and zero errors.
Live provider smoke tests are separate from offline CI and never print secrets.

## 15. Compatibility, migration, and cutover

Existing CLI commands, supported configuration keys, and Drive paths remain
accepted where safety permits. Unsupported legacy behavior fails explicitly.
V2 manifests are versioned so legacy and v2 artifacts can coexist.

Migration has a dry-run mode and never trusts legacy `DONE` state without
revalidating artifacts. Legacy source and the audited tag remain intact.

Cutover is a dedicated commit performed only after:

- all discovered tests pass;
- Python 3.10 clean install passes;
- offline integration, fault injection, and soak gates pass;
- backup/restore succeeds into an empty workspace;
- production doctor passes;
- the new Git history passes secret checks;
- rollback to the legacy tag is documented and rehearsed.

The cutover commit changes the public entry point to v2. It does not enable
cleanup.

## 16. Delivery decomposition

The rebuild is executed through small specs and implementation plans:

1. Package scaffold and development entry point.
2. Canonical timeline and domain models.
3. Typed configuration and dependency invalidation.
4. SQLite state, migrations, and artifact contracts.
5. Verified input and checkpoint backup.
6. Staged restore and cleanup guard.
7. Offline 30-second vertical slice.
8. ONNX OCR and optional Docker contract.
9. Tracking, cue generation, and blur planning.
10. Translation prepass, context, and cache.
11. TTS provider, fit, shorten, and micro-cue behavior.
12. Render, audio, subtitles, and logo.
13. Publish Parts, checksums, and remote validation.
14. Queue, CLI, doctor, disk guard, packaging, CI, and service.
15. Full regression, fault injection, and soak testing.
16. Migration, runbook, and rollback rehearsal.
17. Dedicated cutover.

Every slice follows contract discovery, a small gated plan, failing tests,
minimal implementation, relevant and regression tests, diff/security/failure
review, audit update, and a single-purpose Conventional Commit.

## 17. Explicit non-goals for the initial rebuild

- No concurrent heavyweight video jobs.
- No neural inpainting, voice cloning, diarization, or full ASR replacement.
- No silent CPU OCR fallback in production.
- No automatic provider or model upgrades.
- No implementation of `scene_voiceover` before its own approved spec.
- No automatic cleanup enablement.
