# V2 Rebuild Audit Log

This file records completed rebuild phases without secrets, credential content,
tokens, signed URLs, or sensitive device identifiers.

Each entry contains:

- local time with UTC offset;
- objective;
- contract or invariant;
- changed files;
- tests and gates executed;
- result;
- completed phase commit hash;
- remaining risk;
- next step.

Entries are append-only. Corrections are added as new notes rather than rewriting
historical evidence.

## 2026-07-16T19:45:00+07:00 — Phase 0 design record

- Objective: verify the audited baseline and record the approved v2 architecture,
  program gates, delivery phases, and audit format before implementation.
- Contract/invariant: v2 is built beside untouched legacy; canonical processing
  uses `media.target_fps` at 30 FPS by default; cleanup is deny-by-default; v2
  owns a separate schema; cutover is a dedicated reversible commit.
- Changed files: `docs/superpowers/specs/2026-07-16-v2-rebuild-design.md`,
  `docs/rebuild/00-MASTER-PLAN.md`, `docs/rebuild/AUDIT-LOG.md`, and
  `docs/rebuild/adr/0001-v2-modular-monolith-ports-adapters.md`.
- Tests/gates: verified branch `rebuild/v2`, baseline HEAD and annotated legacy
  tag, clean initial worktree, complete backup bundle, external CapCut secret
  location, tracked/history secret filename gate, Python 3.12.10 host runtime,
  compile gate, pipeline import gate, full unittest discovery, placeholder scan,
  staged filename review, and `git diff --check`.
- Result: baseline evidence matched the audit. Compile passed; legacy pipeline
  import failed at missing `run_static_ocr_samples`; unittest discovered 62 tests
  with 8 failures and 9 errors. Documentation gates passed and no credential path
  was staged.
- Phase commit: `a8bd58de576260138d63fea339f8f7d56c51eccf`.
- Remaining risk: the written spec still requires the mandated user review;
  implementation has not started; Python 3.10 is not installed on this dev host.
- Next step: obtain written-spec approval, invoke `superpowers:writing-plans`, and
  produce the detailed Phase 1 implementation plan before code changes.

## 2026-07-16T19:56:48+07:00 — Phase 1 package scaffold

- Objective: create an independent installable v2 package, development CLI,
  Python 3.10 CI contract, and developer guide without changing legacy runtime
  code or the public `ytb-vps` entry point.
- Contract/invariant: `src/ytb_vps_v2` does not import `ytb_vps`; only the
  temporary `ytb-vps-v2` script is registered; production targets Python 3.10;
  the legacy package and command remain unchanged until cutover.
- Changed files: `pyproject.toml`, `.github/workflows/v2-ci.yml`,
  `src/ytb_vps_v2/__init__.py`, `src/ytb_vps_v2/__main__.py`,
  `src/ytb_vps_v2/interfaces/__init__.py`,
  `src/ytb_vps_v2/interfaces/cli.py`, `tests_v2/__init__.py`,
  `tests_v2/test_package_smoke.py`, `tests_v2/test_cli.py`,
  `tests_v2/test_ci_contract.py`, `docs/rebuild/DEVELOPMENT.md`, and this audit
  log.
- Tests/gates: observed each new test fail before implementation; ran
  `python -m compileall -q src tests_v2`,
  `python -m unittest discover -s tests_v2 -t . -v`, the package import and
  Python-range assertion, `ytb-vps-v2 version`, legacy-import scan, public
  entry-point scan, editable install, wheel build, offline wheel install into a
  clean temporary venv, full phase diff review, staged filename review, secret
  filename gate, `git diff --check`, and independent code review.
- Result: all 6 v2 tests passed; compile, editable install, wheel build, clean
  install, import, module entry, and console entry passed on Python 3.12.10. The
  legacy suite remained at its audited baseline of 62 tests with 8 failures and
  9 errors. Independent review found no Critical or Important implementation
  defect; its required audit gap is resolved by this entry.
- Phase commits: `6441b81cb27f5c4eb275aece0dac0f034e27ffa9`,
  `f5ee7ae5e21fb7e3d2fe85f5a1d0e1fb5f4ef1b4`, and
  `7236a454050e271284fae48b52d150f0600bfe9f`.
- Remaining risk: Python 3.10 is not installed on the local Windows host. The
  configured GitHub Actions job becomes the Python 3.10 execution evidence only
  after an authorized user pushes the branch and CI runs.
- Next step: create and execute the Phase 2 canonical timeline and domain-model
  plan.

## 2026-07-16T20:21:36+07:00 — Phase 2 canonical timeline and domain models

- Objective: implement the pure v2 canonical timeline, immutable typed domain
  models, portable artifact identifiers, and 30-minute publish Part count without
  importing or changing the legacy runtime.
- Contract/invariant: canonical processing uses exact `Fraction` arithmetic at
  integer 30 FPS by default; intervals are half-open with floor start and ceiling
  end; runtime constructors reject booleans, fractional indexes, invalid nested
  types, unsupported enums, non-finite rationals, unsafe paths, invalid checksums,
  and inconsistent Part metadata; artifact paths use `PurePosixPath` regardless
  of host OS; Part count is `max(1, ceil(duration / 1800))`.
- Changed files: `src/ytb_vps_v2/domain/__init__.py`,
  `src/ytb_vps_v2/domain/errors.py`, `src/ytb_vps_v2/domain/models.py`,
  `src/ytb_vps_v2/domain/parts.py`, `src/ytb_vps_v2/domain/timeline.py`,
  `tests_v2/domain/__init__.py`, `tests_v2/domain/test_models.py`,
  `tests_v2/domain/test_parts.py`, `tests_v2/domain/test_timeline.py`, and this
  audit log.
- Tests/gates: observed focused tests fail before each implementation slice; ran
  `python -m unittest discover -s tests_v2 -v`, `python -m compileall -q
  src/ytb_vps_v2 tests_v2`, direct 29.97 FPS end-frame and 30-minute ceiling
  assertions, forbidden legacy-import scans, full phase diff review, staged
  filename review, secret filename gate, `git diff --check`, legacy baseline
  discovery with `PYTHONPATH=app`, and two independent code-review passes.
- Result: all 24 v2 tests passed on Python 3.12.10; compile, exact timeline
  fixtures for 24/25/29.97/30 FPS, direct invariant assertions, import
  independence, and repository gates passed. The first independent review found
  runtime type, cross-platform path, enum/nested-type, and non-finite rational
  gaps; commit `ce66708` resolved them with regression tests. The second review
  found no Critical, Important, or Minor defect and returned `Ready: Yes`. The
  untouched legacy suite remained at its audited baseline of 62 tests with 8
  failures and 9 errors.
- Phase commits: `9ffa05b2fe57848b732d6d0425d21cabaaebe4da`,
  `47d94e5e2b4254641a41bea8d516c71edec72880`,
  `5729be846537a81b92c585fda4ccb23ef9aba1c3`, and
  `ce66708aaa7516ab7bddcc0646eeeccd37c6a460`.
- Remaining risk: Python 3.10 is not installed on the local Windows host, so its
  execution evidence still depends on the configured CI after an authorized
  push. Future adapters must convert filesystem-native paths into the canonical
  `PurePosixPath` artifact identifier at the domain boundary.
- Next step: create and execute the Phase 3 typed effective-configuration,
  compatibility-key, fingerprint, dependency-graph, and exact-invalidation plan.

## 2026-07-16T20:43:04+07:00 — Phase 3 typed configuration and invalidation

- Objective: implement immutable typed effective configuration, an explicit
  legacy-key compatibility boundary, deterministic per-stage SHA-256
  fingerprints, and exact dependency-graph invalidation while preserving
  unaffected work.
- Contract/invariant: unknown keys warn or fail according to an explicit policy
  and are never silently ignored; alias conflicts fail instead of guessing;
  warnings contain paths but no raw values; `scene_voiceover` and enabled cleanup
  fail explicitly; runtime parallelism, retry, and timeout values never enter
  content fingerprints; invalidation follows the immutable ordered graph from
  INGEST through BACKUP.
- Changed files: `src/ytb_vps_v2/domain/config.py`,
  `src/ytb_vps_v2/domain/fingerprints.py`,
  `src/ytb_vps_v2/domain/__init__.py`,
  `src/ytb_vps_v2/interfaces/config_compat.py`,
  `src/ytb_vps_v2/application/__init__.py`,
  `src/ytb_vps_v2/application/invalidation.py`,
  `tests_v2/config/__init__.py`, `tests_v2/config/test_config_types.py`,
  `tests_v2/config/test_config_compat.py`,
  `tests_v2/domain/test_fingerprints.py`,
  `tests_v2/application/__init__.py`,
  `tests_v2/application/test_invalidation.py`, this audit log, and the master
  plan status.
- Tests/gates: observed every focused test module and review regression fail
  before implementation; ran 47-test v2 discovery, focused config/fingerprint/
  invalidation suites, compileall, direct TTS invalidation assertion,
  cross-process fingerprint stability, forbidden legacy-import scan, full phase
  diff review, staged filename review, secret filename gate, `git diff --check`,
  legacy discovery with `PYTHONPATH=app`, and two independent review passes.
- Result: all 47 v2 tests passed on Python 3.12.10; compile, canonical hashing,
  unknown-key handling, alias conflicts, runtime hash exclusion, typed ordered
  invalidation, and repository gates passed. The first review found positive
  max-fit range, exact nested-schema, raw rational-type, and mutable dependency-
  graph gaps; commit `3f3bfd5` resolved all four with regression tests. Re-review
  found no Critical, Important, or Minor issue and returned `Ready: Yes`. The
  untouched legacy suite remained at 62 tests with 8 failures and 9 errors.
- Phase commits: `f9dc86fb81a711bfd2b4d6f78301a31c455fd26b`,
  `6c430b451aa0d537cc114d2bba6565eb1497084a`,
  `2948f66d6c8366b9e073496bca956c2dba49f817`,
  `f71236ff534b74c3738aad3cced870615610c4cd`, and
  `3f3bfd5b31e1f9dd442d0d10c830c8e11df91a8f`.
- Remaining risk: Python 3.10 is not installed on the local Windows host. This
  phase parses already-loaded mappings; YAML file loading, doctor/inspection
  presentation, and expansion of the safe compatibility-key surface remain
  explicit later interface/operations work rather than hidden behavior here.
- Next step: create and execute the Phase 4 versioned SQLite state, migration,
  work-unit transition, artifact commit, retry-history, and stale-run plan.

## 2026-07-16T21:03:26+07:00 — Phase 4 SQLite state and artifact contracts

- Objective: implement a versioned SQLite state store with durable job and work-
  unit transitions, retry history, atomic artifact records, exact invalidation,
  and stale-run recovery.
- Contract/invariant: schema version 1 is explicit and rejects unknown future
  versions; foreign keys, WAL, synchronous FULL, and busy timeout are enabled and
  verified; state transitions use compare-and-swap guards; artifact insertion and
  SUCCEEDED transition share one transaction; every exceptional transaction path
  rolls back; invalidation affects only selected stages and their artifacts.
- Changed files: `src/ytb_vps_v2/adapters/__init__.py`,
  `src/ytb_vps_v2/adapters/sqlite/__init__.py`,
  `src/ytb_vps_v2/adapters/sqlite/schema.py`,
  `src/ytb_vps_v2/adapters/sqlite/state.py`,
  `src/ytb_vps_v2/domain/state.py`,
  `src/ytb_vps_v2/domain/invalidation.py`,
  `src/ytb_vps_v2/domain/__init__.py`,
  `src/ytb_vps_v2/application/invalidation.py`,
  `src/ytb_vps_v2/ports/__init__.py`, `src/ytb_vps_v2/ports/state.py`,
  the SQLite and invalidation tests under `tests_v2/`, the Phase 4 plan, the
  master plan status, and this audit log.
- Tests/gates: observed focused schema, transition, artifact, invalidation, and
  review-regression tests fail before implementation; ran 65-test v2 discovery,
  compileall, rollback and reopen checks, dependency-direction and forbidden-
  legacy-import scans, full phase diff review, staged filename review, secret
  filename gate, `git diff --check`, the legacy discovery baseline, and two
  independent review passes.
- Result: all 65 v2 tests passed on Python 3.12.10; compile, schema and pragma
  verification, guarded transitions, atomic rollback, stale recovery, canonical
  dependency decoding, and repository gates passed. The first independent review
  found transaction rollback, dependency JSON validation, dependency direction,
  and durability readback gaps; commit `ae22de2` resolved all findings and added
  the requested regression coverage. Re-review found no Critical, Important, or
  Minor issue and returned `Ready: Yes`. The untouched legacy suite remained at
  62 tests with 8 failures and 9 errors.
- Phase commits: `da18806d0f6ab37a6e131f74082457414a7103c0`,
  `b74e30dd5f59ef572144e48316b495f544726730`,
  `57680f23755f5c9a014ebc7f33e4ffb3fcbbcfc1`, and
  `ae22de204f2563da81cf9f232a519f79acc2648b`.
- Remaining risk: Python 3.10 is unavailable locally, so its evidence still
  depends on CI after an authorized push. SQLite now durably records artifact
  metadata but does not yet create, fsync, rename, or validate filesystem
  artifacts. Input archival, checkpoint copies, config snapshots, and their
  orchestration remain later phases.
- Next step: create and execute the Phase 5 verified-input, additive checkpoint-
  backup, manifest, and SQLite-snapshot plan.

## 2026-07-16T21:47:22+07:00 — Phase 5 verified input and checkpoint backup

- Objective: make source identity, input archival, additive checkpoint objects,
  canonical manifests, and SQLite backup snapshots durable and independently
  verifiable before expensive processing starts.
- Contract/invariant: source and object paths are confined and reject symlink,
  junction, and reparse components; files are streamed through SHA-256, fsynced,
  published without replacement, and read back; post-INGEST work requires a
  matching verified-input row; schema v2 migration preserves v1 state; SQLite
  snapshots use the backup API and exact `integrity_check`; checkpoint data is
  published before its manifest and completion is recorded only after manifest
  read-back succeeds.
- Changed files: `src/ytb_vps_v2/domain/backup.py`, domain exports,
  `src/ytb_vps_v2/ports/backup.py`, state-port methods,
  `src/ytb_vps_v2/adapters/filesystem/{__init__,integrity,archive,additive}.py`,
  `src/ytb_vps_v2/adapters/sqlite/{__init__,schema,state,backup}.py`,
  `src/ytb_vps_v2/application/{__init__,checkpoints}.py`, the Phase 5 domain,
  filesystem, SQLite, and checkpoint tests under `tests_v2/`, the Phase 5 plan,
  the master plan status, and this audit log.
- Tests/gates: observed focused manifest, filesystem, migration, input-gate,
  snapshot, and checkpoint tests fail before each implementation slice; ran 114-
  test v2 discovery, the 49-test Phase 5 suite, compileall, real schema-v1
  migration, active-transaction rejection, backup and integrity faults, directory-
  sync and guarded-publication faults, retry with a changed timestamp, strict
  manifest/Unicode round trips, a real Windows junction-source rejection,
  dependency-direction and forbidden-legacy-import scans, secret filename and
  staged filename gates, `git diff --check`, the legacy baseline, and three
  independent review passes.
- Result: all 114 v2 tests passed on Python 3.12.10; one synthetic symlink test was
  skipped because this Windows account cannot create symlinks, while the real
  junction reproduction passed. The first review found directory-sync retry,
  changed-timestamp retry, reparse/path-race, and lone-surrogate gaps; `b147156`
  fixed them with regressions. Re-review found remaining source-parent junction
  and transient pathname-swap gaps; `1869ff3` added full parent-component checks,
  a non-delete-sharing Windows directory guard, and POSIX `dir_fd`/`O_NOFOLLOW`
  publication. Final re-review found no Critical, Important, or Minor issue and
  returned `Ready: Yes`. The untouched legacy suite remained at 62 tests with 8
  failures and 9 errors.
- Phase commits: `dc5722c3625913b07acea63a42b3eff057c6689b`,
  `458add607770ac669522f2a09bc9e31bbb8c4565`,
  `a8655948177e9f8c6174e0aae9192d1ca22156e0`,
  `628e9b3fdd61b83c9f489efb9e4058e796c8b15a`,
  `b1471566409d250226e9059024e846999a3b97e6`, and
  `1869ff359e7125296da3a183a66e8a01a701019b`.
- Remaining risk: Python 3.10 and the POSIX directory-descriptor path are not
  executable on this Windows host and still require CI after an authorized push.
  The additive local store is the deterministic contract adapter, not a production
  remote provider; fresh remote evidence arrives with publishing work. Staged
  restore, cleanup policy/fault denial, and supported empty-workspace recovery are
  Phase 6 and later gates. Windows directory fsync remains best-effort where the
  platform does not expose a supported directory handle operation. Cleanup remains
  disabled.
- Next step: create and execute the Phase 6 staged-restore, checksum/integrity,
  atomic-swap, allowed-root, and deny-by-default cleanup plan.

## 2026-07-16T22:31:14+07:00 — Phase 6 staged restore and cleanup guard

- Objective: restore a trusted additive checkpoint through isolated staging and
  an atomic no-replace directory publication, while exposing only a deny-by-
  default cleanup authorization decision backed by fresh complete remote proof.
- Contract/invariant: restore requires a trusted manifest `ManifestEntry`, binds
  canonical manifest bytes to its digest and checkpoint prefix, materializes the
  state snapshot first, requires exact SQLite integrity/foreign-key/schema-v2
  conformance, derives the archive/workspace layout from staged state, re-hashes
  every local file, and never merges with or overwrites an existing target.
  Publication and failure cleanup carry a pinned staging identity; Windows uses
  handle-based rename/removal, POSIX uses anchored directory descriptors and
  post-rename identity rollback, and rollback conflicts evacuate the target to
  a random no-replace quarantine. Cleanup assessment requires independent,
  non-empty Part/validation/work requirements, canonical manifest binding,
  exact `sha256-readback` evidence, freshness, restorable snapshot state, full
  work coverage, explicit operator enablement, and allowed-root preflight. It
  performs no deletion and is not wired to the CLI or runtime.
- Changed files: `src/ytb_vps_v2/domain/restore.py` and domain exports;
  `src/ytb_vps_v2/ports/{backup,cleanup,restore}.py` and port exports;
  `src/ytb_vps_v2/adapters/filesystem/{additive,cleanup,integrity}.py` and
  exports; `src/ytb_vps_v2/adapters/sqlite/restore.py` and exports;
  `src/ytb_vps_v2/application/{restore,cleanup}.py` and exports; Phase 6 domain,
  filesystem, SQLite, restore, cleanup, and architecture tests under `tests_v2/`;
  the Phase 6 plan, this audit log, and the master-plan status.
- Tests/gates: observed focused domain, object-store, allowed-root, staged-SQLite,
  end-to-end restore, cleanup-denial, architecture, and every review regression
  fail before implementation; ran the 165-test v2 discovery, compileall, exact
  schema-v1 migration and schema-v2 conformance checks, corrupt/missing object
  cases, canonical forged-manifest rejection, interruption before and after each
  materialization, migration interruption, final-validation and publish faults,
  existing-target and target-creation races, staging-swap cleanup, directory-
  sync rollback `EEXIST`, the full cleanup denial matrix, a real Windows junction
  preflight, dependency-direction and forbidden-legacy-import scans, package
  independence, secret filename and diff gates, the legacy baseline, and final
  independent re-review.
- Result: all 165 v2 tests passed on Python 3.12.10; two synthetic symlink tests
  were skipped because this Windows account cannot create symlinks, while the
  real Windows junction check returned `REAL_WINDOWS_JUNCTION_REJECTED`.
  Compile, dependency direction, trusted-manifest binding, exact staged schema,
  interruption/retry, pinned Windows publication, fail-closed rollback,
  independent cleanup coverage, runtime cleanup-disablement, and repository
  gates passed. The initial review found Important manifest authenticity,
  cleanup completeness, staging publication/removal race, inward-dependency,
  and incomplete-schema gaps; the fix commits below added reproductions and
  resolved them. Final re-review found no Critical, Important, or Minor issue
  and returned `Ready: Yes`. The untouched legacy suite remained at 62 tests
  with 8 failures and 9 errors.
- Phase commits: `16fdd017d158c51fbebc3b41a328c1ddf71dee03`,
  `bfdfa905add7eb49c5d61d7341e10ef0d376cad7`,
  `ea69ca484deb26a55193d68b1249fee309d85d8f`,
  `3ad617ee5b7d9bafe7598f3f47bdce02adf157e4`,
  `9d6055e08ea83b19bda10944bce316de80cb01cd`,
  `a35d95bf15da4f6da38fdaf3698a568ab2f39d8d`,
  `2309adc736fd3476a626d3205344531aa09f14e2`,
  `0fa8c0c06feb6a2706341f515d9528533c7c46aa`, and
  `54f1b81811e1bc0992b886bf2b1bce464cd29284`.
- Remaining risk: Python 3.10 and the POSIX handle/rollback path are unavailable
  on this Windows host and still require CI after an authorized push. The local
  additive adapter is not a production remote provider. A rollback conflict can
  intentionally retain a random quarantine for operator inspection rather than
  risk leaving a target published or deleting an unowned directory. Restore
  callers must obtain trusted manifest evidence from durable state; runtime/CLI
  wiring arrives later. Schema-v1 structural migration is tested, but a genuine
  v1 checkpoint without the v2 verified-input row still fails closed. Windows
  directory fsync remains best-effort. Active-target replacement is intentionally
  unsupported. Cleanup remains disabled globally, has no deletion executor, and
  is not connected to any public entry point.
- Next step: create and execute the Phase 7 deterministic offline 30-second
  vertical-slice, stage interruption, resume, audio, and no-audio plan.
