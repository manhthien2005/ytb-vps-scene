# Phase 3 Typed Configuration and Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build immutable effective configuration, an explicit legacy-key compatibility boundary, deterministic per-stage fingerprints, and dependency-graph invalidation that preserves unaffected work.

**Architecture:** Pure typed configuration and hashing live in `domain`; raw mappings are translated only by `interfaces/config_compat.py`; invalidation closure lives in `application`. Runtime-only settings are deliberately separated from content settings so worker counts, retry budgets, and timeouts cannot invalidate content.

**Tech Stack:** Python 3.10–3.12 standard library (`dataclasses`, `enum`, `fractions`, `hashlib`, `json`, `unittest`). No YAML or provider dependency is added in this phase.

## Global Constraints

- Work directly on `rebuild/v2`; do not create or switch product branches.
- V2 must not import `app/ytb_vps` or mutate the public `ytb-vps` entry point.
- Configuration values are immutable after parsing; malformed values raise `ConfigError`.
- Unknown keys use an explicit `UnknownKeyPolicy`: `WARN` records a warning and `ERROR` rejects the mapping.
- Existing safe keys are translated at the interface boundary; aliases emit a deprecation warning.
- `translation.mode=scene_voiceover` fails explicitly; only `cue_translation` is supported.
- `queue.cleanup_after_upload` must remain `false`; a true value fails explicitly.
- Content fingerprints use canonical JSON and SHA-256; no Python `hash()` values are persisted.
- Runtime parallelism, retry limits, and timeouts never enter content fingerprints.
- Stage dependency order is `INGEST -> OCR -> TRACK -> TRANSLATE -> TTS -> RENDER -> PUBLISH -> BACKUP`.
- Changing TTS content settings invalidates TTS and downstream work; changing OCR content settings invalidates OCR and downstream work.
- Apply TDD and one-purpose Conventional Commits; do not push.

---

## File map

- `src/ytb_vps_v2/domain/config.py`: immutable content/runtime configuration values and validation.
- `src/ytb_vps_v2/interfaces/config_compat.py`: raw mapping parser, legacy aliases, unknown-key policy, and warnings.
- `src/ytb_vps_v2/domain/fingerprints.py`: canonical serialization and per-stage configuration SHA-256 values.
- `src/ytb_vps_v2/application/invalidation.py`: dependency graph and exact invalidation plans.
- `src/ytb_vps_v2/application/__init__.py`: application package boundary.
- `tests_v2/config/test_config_types.py`: immutable type and constructor invariant tests.
- `tests_v2/config/test_config_compat.py`: compatibility, warning/error, cleanup, and mode tests.
- `tests_v2/domain/test_fingerprints.py`: stable hash and runtime-exclusion tests.
- `tests_v2/application/test_invalidation.py`: direct-change and downstream-closure tests.
- `src/ytb_vps_v2/domain/__init__.py`: stable Phase 3 domain exports.
- `docs/rebuild/AUDIT-LOG.md`: append-only Phase 3 evidence.

### Task 1: Immutable typed effective configuration

**Files:**
- Create: `src/ytb_vps_v2/domain/config.py`
- Create: `tests_v2/config/__init__.py`
- Create: `tests_v2/config/test_config_types.py`

**Interfaces:**
- Consumes: `DomainInvariantError`, `PipelineMode`.
- Produces: `ConfigError`; `MediaConfig`; `OcrConfig`; `TrackingConfig`; `TranslationConfig`; `TtsConfig`; `RenderConfig`; `PublishConfig`; `RuntimeConfig`; `SafetyConfig`; `EffectiveConfig`.

- [ ] **Step 1: Write failing constructor tests**

Create `tests_v2/config/__init__.py` and test defaults, frozen instances, and invalid values. The test must assert: target FPS and dimensions are positive integers and reject booleans; rational fields are positive `Fraction` values; names are non-empty and trimmed; `scene_voiceover` is rejected; cleanup cannot be true; runtime worker/retry values are positive integers.

```python
from dataclasses import FrozenInstanceError
from fractions import Fraction
import unittest

from ytb_vps_v2.domain.config import (
    ConfigError,
    EffectiveConfig,
    MediaConfig,
    RuntimeConfig,
    SafetyConfig,
    TranslationConfig,
)


class ConfigTypeTests(unittest.TestCase):
    def test_defaults_are_typed_and_frozen(self) -> None:
        config = EffectiveConfig()
        self.assertEqual(config.media.target_fps, 30)
        self.assertEqual(config.ocr.sample_fps, Fraction(2))
        with self.assertRaises(FrozenInstanceError):
            config.media.target_fps = 25  # type: ignore[misc]

    def test_invalid_values_fail_at_construction(self) -> None:
        factories = (
            lambda: MediaConfig(target_fps=True),
            lambda: MediaConfig(max_width=0),
            lambda: RuntimeConfig(ocr_parallelism=0),
            lambda: TranslationConfig(mode="scene_voiceover"),
            lambda: SafetyConfig(cleanup_after_upload=True),
        )
        for factory in factories:
            with self.subTest(factory=factory):
                with self.assertRaises(ConfigError):
                    factory()  # type: ignore[misc]
```

- [ ] **Step 2: Run the focused test and observe the missing module**

Run: `python -m unittest tests_v2.config.test_config_types -v`

Expected: import error for `ytb_vps_v2.domain.config`.

- [ ] **Step 3: Implement the immutable types**

Use frozen, slotted dataclasses with these exact fields and defaults:

```python
class ConfigError(DomainInvariantError):
    """Raised when raw or typed v2 configuration is invalid."""


@dataclass(frozen=True, slots=True)
class MediaConfig:
    target_fps: int = 30
    max_width: int = 1920
    max_height: int = 1080
    chunk_seconds: int = 300


@dataclass(frozen=True, slots=True)
class OcrConfig:
    backend: str = "onnx"
    model_revision: str = "onnx-default"
    sample_fps: Fraction = Fraction(2)
    scan_width: int = 640
    language: str = "ch"
    minimum_confidence: Fraction = Fraction(55, 100)


@dataclass(frozen=True, slots=True)
class TrackingConfig:
    max_gap_frames: int = 15
    minimum_duration_frames: int = 3
    cue_lead_frames: int = 3
    cue_tail_frames: int = 3
    text_similarity: Fraction = Fraction(72, 100)


@dataclass(frozen=True, slots=True)
class TranslationConfig:
    mode: PipelineMode = PipelineMode.CUE_TRANSLATION
    model: str = "gpt-5"
    prompt_revision: int = 1
    context_window_cues: int = 12


@dataclass(frozen=True, slots=True)
class TtsConfig:
    provider: str = "capcut"
    voice: str = "BV074_streaming"
    resource_id: str = "7102355709945188865"
    rate: Fraction = Fraction(1)
    max_fit_speed: Fraction = Fraction(135, 100)


@dataclass(frozen=True, slots=True)
class RenderConfig:
    profile_revision: str = "default"
    font_size: int = 42
    outline: int = 4
    mirror_video: bool = True
    blur_mode: str = "subtitle_band"


@dataclass(frozen=True, slots=True)
class PublishConfig:
    remote_root: str = "gdrive:YTB-VPS"


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    ocr_parallelism: int = 1
    ffmpeg_threads: int = 6
    retry_attempts: int = 3
    timeout_seconds: int = 900


@dataclass(frozen=True, slots=True)
class SafetyConfig:
    cleanup_after_upload: bool = False


@dataclass(frozen=True, slots=True)
class EffectiveConfig:
    media: MediaConfig = field(default_factory=MediaConfig)
    ocr: OcrConfig = field(default_factory=OcrConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    translation: TranslationConfig = field(default_factory=TranslationConfig)
    tts: TtsConfig = field(default_factory=TtsConfig)
    render: RenderConfig = field(default_factory=RenderConfig)
    publish: PublishConfig = field(default_factory=PublishConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
    safety: SafetyConfig = field(default_factory=SafetyConfig)
```

Each `__post_init__` must use shared strict validators that reject `bool` as an integer, require exact nested dataclass/enum types, validate non-empty trimmed strings, and enforce these ranges: positive dimensions/FPS/chunk/scan widths; `0 < sample_fps <= target_fps` is checked by `EffectiveConfig`; confidence and similarity are within `[0, 1]`; frame padding/count values are non-negative except minimum duration is positive; rate and max fit speed are positive; font size positive, outline non-negative; runtime values positive. `TranslationConfig` must reject non-`PipelineMode` values. `SafetyConfig` must reject non-boolean values and `True`.

Use these validator bodies; each dataclass calls them for every field before any
comparison so malformed input cannot leak a raw Python exception:

```python
def _integer(name: str, value: object, *, minimum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ConfigError(f"{name} must be an integer >= {minimum}")


def _fraction(
    name: str,
    value: object,
    *,
    minimum: Fraction,
    maximum: Fraction | None = None,
) -> None:
    if not isinstance(value, Fraction) or value < minimum:
        raise ConfigError(f"{name} must be a Fraction >= {minimum}")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} must be <= {maximum}")


def _text(name: str, value: object) -> None:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ConfigError(f"{name} must be non-empty and trimmed")


def _boolean(name: str, value: object) -> None:
    if not isinstance(value, bool):
        raise ConfigError(f"{name} must be a boolean")
```

- [ ] **Step 4: Run focused and regression tests**

Run: `python -m unittest tests_v2.config.test_config_types -v`

Run: `python -m unittest discover -s tests_v2 -v`

Expected: focused tests and all existing 24 v2 tests pass.

- [ ] **Step 5: Review and commit Task 1**

Run `git diff --check`, review the two new files, stage only them, inspect staged filenames, and commit:

`git commit -m "feat(v2): add typed effective config"`

### Task 2: Explicit raw/legacy compatibility boundary

**Files:**
- Create: `src/ytb_vps_v2/interfaces/config_compat.py`
- Create: `tests_v2/config/test_config_compat.py`

**Interfaces:**
- Consumes: Phase 3 configuration dataclasses and a nested `Mapping[str, object]`.
- Produces: `UnknownKeyPolicy(ERROR, WARN)`; `ConfigWarning(path, message)`; `ConfigLoadResult(config, warnings)`; `parse_config(raw, unknown_policy=UnknownKeyPolicy.WARN)`.

- [ ] **Step 1: Write failing compatibility tests**

Tests must cover all of these exact contracts:

```python
result = parse_config({
    "media": {"target_fps": 30, "ffmpeg_threads": 8},
    "ocr": {"det_model_dir": "/models/det", "rec_model_dir": "/models/rec", "parallel_chunks": 2},
    "translation": {"style_version": 7, "model": "gpt-test"},
    "drive": {"remote_root": "remote:root"},
    "queue": {"cleanup_after_upload": False},
})
self.assertEqual(result.config.runtime.ffmpeg_threads, 8)
self.assertEqual(result.config.runtime.ocr_parallelism, 2)
self.assertEqual(result.config.ocr.model_revision, "det=/models/det;rec=/models/rec")
self.assertEqual(result.config.translation.prompt_revision, 7)
self.assertEqual(result.config.publish.remote_root, "remote:root")
self.assertTrue(any(warning.path == "translation.style_version" for warning in result.warnings))
```

Also assert that `translation.mode: scene_voiceover` and `queue.cleanup_after_upload: true` raise `ConfigError`; an unknown leaf produces a warning under `WARN`; the same leaf raises under `ERROR`; unknown root sections are handled by the same policy; inputs are not mutated; warnings never include raw values.

- [ ] **Step 2: Run the focused test and observe the missing parser**

Run: `python -m unittest tests_v2.config.test_config_compat -v`

Expected: import error for `ytb_vps_v2.interfaces.config_compat`.

- [ ] **Step 3: Implement strict parsing and compatibility translations**

Implement `UnknownKeyPolicy` as a string enum and the result/warning values as frozen slotted dataclasses. Copy every section into a plain dict before popping values. Strict helper functions must parse only: non-boolean integers; finite `Fraction`-compatible int/float/str values; booleans; trimmed strings; nested mappings. A helper must record or raise unknown paths without including their values.

Use this exact public shape and parsing flow:

```python
class UnknownKeyPolicy(str, Enum):
    WARN = "warn"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class ConfigWarning:
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class ConfigLoadResult:
    config: EffectiveConfig
    warnings: tuple[ConfigWarning, ...]


def _unknown(
    paths: Iterable[str],
    policy: UnknownKeyPolicy,
    warnings: list[ConfigWarning],
) -> None:
    for path in sorted(paths):
        if policy is UnknownKeyPolicy.ERROR:
            raise ConfigError(f"Unknown configuration key: {path}")
        warnings.append(ConfigWarning(path, "Unknown configuration key ignored"))


def parse_config(
    raw: Mapping[str, object],
    *,
    unknown_policy: UnknownKeyPolicy = UnknownKeyPolicy.WARN,
) -> ConfigLoadResult:
    if not isinstance(raw, Mapping):
        raise ConfigError("Configuration root must be a mapping")
    if not isinstance(unknown_policy, UnknownKeyPolicy):
        raise ConfigError("Unknown-key policy is invalid")
    root = dict(raw)
    warnings: list[ConfigWarning] = []
    sections = {
        name: _section(root.pop(name, {}), name)
        for name in (
            "media", "ocr", "tracking", "translation", "tts", "render",
            "publish", "runtime", "queue", "safety", "drive",
        )
    }
    config = _build_effective_config(sections, warnings)
    for name, section in sections.items():
        _unknown((f"{name}.{key}" for key in section), unknown_policy, warnings)
    _unknown(root, unknown_policy, warnings)
    return ConfigLoadResult(config, tuple(warnings))
```

`_build_effective_config` constructs each dataclass using `_pop_int`,
`_pop_fraction`, `_pop_bool`, and `_pop_text`; each helper returns the supplied
typed default when a key is absent and removes a present key from the copied
section. It performs the alias-conflict checks before popping canonical and
legacy values, appends `ConfigWarning(path, "Deprecated alias translated")` for
each alias used, and never stores a raw value in warning text.

Recognize these paths:

- `media.target_fps`, `max_width`, `max_height`, `chunk_seconds`; legacy `media.ffmpeg_threads` maps to `RuntimeConfig.ffmpeg_threads`.
- `ocr.backend`, `model_revision`, `sample_fps`, `scan_width`, `language`, `minimum_confidence`; legacy `det_model_dir` plus `rec_model_dir` form `model_revision`; legacy `parallel_chunks` maps to runtime parallelism.
- `tracking.max_gap_frames`, `minimum_duration_frames`, `cue_lead_frames`, `cue_tail_frames`, `text_similarity`.
- `translation.mode`, `model`, `prompt_revision`, `context_window_cues`; legacy `style_version` maps to `prompt_revision` and emits a deprecation warning.
- `tts.provider`, `voice`, `resource_id`, `rate`, `max_fit_speed`.
- `render.profile_revision`, `font_size`, `outline`, `mirror_video`, `blur_mode`.
- `publish.remote_root`; legacy `drive.remote_root` maps to it.
- `runtime.ocr_parallelism`, `ffmpeg_threads`, `retry_attempts`, `timeout_seconds`.
- `queue.cleanup_after_upload` and `safety.cleanup_after_upload` map to `SafetyConfig`.

If both a canonical path and its legacy alias are present, raise `ConfigError` instead of guessing precedence. Remaining keys are processed by `UnknownKeyPolicy`. Build `EffectiveConfig` only after every section is parsed so cross-field validation runs once.

- [ ] **Step 4: Run focused and regression tests**

Run: `python -m unittest tests_v2.config.test_config_compat -v`

Run: `python -m unittest discover -s tests_v2 -v`

Expected: compatibility tests and all prior v2 tests pass.

- [ ] **Step 5: Review and commit Task 2**

Run diff, staged filename, secret filename, and `git diff --check` gates. Commit:

`git commit -m "feat(v2): translate legacy config explicitly"`

### Task 3: Deterministic per-stage configuration fingerprints

**Files:**
- Create: `src/ytb_vps_v2/domain/fingerprints.py`
- Create: `tests_v2/domain/test_fingerprints.py`
- Modify: `src/ytb_vps_v2/domain/__init__.py`

**Interfaces:**
- Consumes: `EffectiveConfig`, `StageName`.
- Produces: `Fingerprint(sha256)`; `StageConfigFingerprint(stage, fingerprint)`; `fingerprint_value(value)`; `stage_config_projection(config, stage)`; `stage_config_fingerprints(config)`.

- [ ] **Step 1: Write failing fingerprint tests**

Tests must prove: identical values hash identically; tuple/dataclass/enum/Fraction serialization is deterministic; the digest is 64 lowercase hex characters; changing `tts.voice` changes only the TTS direct configuration hash; changing OCR model revision changes only OCR direct hash; changing runtime parallelism/retry/timeout changes no stage hash; changing `publish.remote_root` changes only PUBLISH; unsupported objects raise `DomainInvariantError` rather than using `repr()`.

- [ ] **Step 2: Run the focused test and observe missing fingerprint interfaces**

Run: `python -m unittest tests_v2.domain.test_fingerprints -v`

Expected: import error.

- [ ] **Step 3: Implement canonical hashing and projections**

Canonicalization must encode values with explicit type tags: dataclasses as field-name maps, enums by value, `Fraction` as numerator/denominator, tuples as ordered arrays, dictionaries only with sorted string keys, and primitive `None`/bool/int/str values directly. Serialize using `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)` and hash UTF-8 bytes with SHA-256.

Use this exact core implementation:

```python
def _canonical(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        return {
            "type": f"{type(value).__module__}.{type(value).__qualname__}",
            "fields": {item.name: _canonical(getattr(value, item.name)) for item in fields(value)},
        }
    if isinstance(value, Enum):
        return {"enum": f"{type(value).__module__}.{type(value).__qualname__}", "value": value.value}
    if isinstance(value, Fraction):
        return {"fraction": [value.numerator, value.denominator]}
    if isinstance(value, tuple):
        return {"tuple": [_canonical(item) for item in value]}
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {"dict": {key: _canonical(value[key]) for key in sorted(value)}}
    if value is None or isinstance(value, (bool, int, str)):
        return value
    raise DomainInvariantError(f"Unsupported fingerprint value type: {type(value).__name__}")


def fingerprint_value(value: object) -> Fingerprint:
    payload = json.dumps(
        _canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return Fingerprint(hashlib.sha256(payload).hexdigest())
```

`stage_config_projection` must return exactly:

```python
{
    StageName.INGEST: config.media,
    StageName.OCR: (config.media.chunk_seconds, config.ocr),
    StageName.TRACK: config.tracking,
    StageName.TRANSLATE: config.translation,
    StageName.TTS: config.tts,
    StageName.RENDER: config.render,
    StageName.PUBLISH: config.publish,
    StageName.BACKUP: (),
}[stage]
```

Runtime and safety values are intentionally absent. Validate all public input types and publish the new symbols from `domain/__init__.py`.

- [ ] **Step 4: Run focused, full, and stability tests**

Run the focused module twice in separate Python processes, then run full v2 discovery. Expected: the saved digest printed by both processes is identical and all tests pass.

- [ ] **Step 5: Review and commit Task 3**

Run repository gates and commit:

`git commit -m "feat(v2): fingerprint stage configuration"`

### Task 4: Exact dependency-graph invalidation

**Files:**
- Create: `src/ytb_vps_v2/application/__init__.py`
- Create: `src/ytb_vps_v2/application/invalidation.py`
- Create: `tests_v2/application/__init__.py`
- Create: `tests_v2/application/test_invalidation.py`

**Interfaces:**
- Consumes: previous/current `StageConfigFingerprint` collections and changed upstream artifact-owner stages.
- Produces: `STAGE_DEPENDENCIES`; `InvalidationPlan(direct_stages, affected_stages)`; `plan_invalidation(previous, current, changed_artifact_owners=())`.

- [ ] **Step 1: Write failing invalidation tests**

Test exact ordered tuples for these cases:

- unchanged config: both tuples empty;
- runtime-only change: both tuples empty;
- TTS voice: direct `(TTS,)`, affected `(TTS, RENDER, PUBLISH, BACKUP)`;
- OCR model: direct `(OCR,)`, affected `(OCR, TRACK, TRANSLATE, TTS, RENDER, PUBLISH, BACKUP)`;
- render profile: direct `(RENDER,)`, affected `(RENDER, PUBLISH, BACKUP)`;
- remote root: direct `(PUBLISH,)`, affected `(PUBLISH, BACKUP)`;
- changed TRACK artifact with unchanged config: direct `(TRACK,)`, affected `(TRACK, TRANSLATE, TTS, RENDER, PUBLISH, BACKUP)`;
- multiple direct changes are deduplicated and emitted in pipeline order;
- missing/duplicate stage fingerprints and invalid artifact owner types raise `DomainInvariantError`.

- [ ] **Step 2: Run focused tests and observe the missing application package**

Run: `python -m unittest tests_v2.application.test_invalidation -v`

Expected: import error.

- [ ] **Step 3: Implement dependency closure**

Define `STAGE_ORDER` as the eight stages in the global constraint and `STAGE_DEPENDENCIES` as a mapping where each stage after INGEST depends directly on its predecessor. Validate that previous/current snapshots each contain exactly one fingerprint for every stage. A stage is direct when its digest changed or it appears in `changed_artifact_owners`. Compute affected stages by repeatedly adding any node whose dependencies intersect the affected set. Return direct and affected tuples sorted by `STAGE_ORDER`. Do not mutate either input.

Use this exact closure implementation after `_snapshot` has validated and converted
each collection to `dict[StageName, Fingerprint]`:

```python
STAGE_ORDER = (
    StageName.INGEST,
    StageName.OCR,
    StageName.TRACK,
    StageName.TRANSLATE,
    StageName.TTS,
    StageName.RENDER,
    StageName.PUBLISH,
    StageName.BACKUP,
)
STAGE_DEPENDENCIES = {
    stage: (() if index == 0 else (STAGE_ORDER[index - 1],))
    for index, stage in enumerate(STAGE_ORDER)
}


def plan_invalidation(
    previous: Iterable[StageConfigFingerprint],
    current: Iterable[StageConfigFingerprint],
    *,
    changed_artifact_owners: Iterable[StageName] = (),
) -> InvalidationPlan:
    old = _snapshot(previous)
    new = _snapshot(current)
    owners = tuple(changed_artifact_owners)
    if any(not isinstance(stage, StageName) for stage in owners):
        raise DomainInvariantError("Artifact owners must be StageName values")
    direct = {stage for stage in STAGE_ORDER if old[stage] != new[stage]}
    direct.update(owners)
    affected = set(direct)
    changed = True
    while changed:
        before = len(affected)
        affected.update(
            stage
            for stage in STAGE_ORDER
            if any(parent in affected for parent in STAGE_DEPENDENCIES[stage])
        )
        changed = len(affected) != before
    return InvalidationPlan(
        tuple(stage for stage in STAGE_ORDER if stage in direct),
        tuple(stage for stage in STAGE_ORDER if stage in affected),
    )
```

- [ ] **Step 4: Run focused and full regression tests**

Run: `python -m unittest tests_v2.application.test_invalidation -v`

Run: `python -m unittest discover -s tests_v2 -v`

Expected: all exact-closure cases and all prior v2 tests pass.

- [ ] **Step 5: Review and commit Task 4**

Run diff, compile, forbidden-import, secret filename, and staged filename gates. Commit:

`git commit -m "feat(v2): plan exact stage invalidation"`

### Task 5: Phase 3 verification, independent review, and audit

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`
- Modify: `docs/rebuild/00-MASTER-PLAN.md`

**Interfaces:**
- Consumes: Task 1–4 commits and verification evidence.
- Produces: Phase 3 completion evidence and an accurate master-plan status.

- [ ] **Step 1: Run fresh Phase 3 gates**

Run:

```powershell
python -m compileall -q src/ytb_vps_v2 tests_v2
python -m unittest discover -s tests_v2 -v
python -c "from dataclasses import replace; from ytb_vps_v2.domain.config import EffectiveConfig; from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints; from ytb_vps_v2.application.invalidation import plan_invalidation; c=EffectiveConfig(); n=replace(c, tts=replace(c.tts, voice='other')); assert tuple(s.value for s in plan_invalidation(stage_config_fingerprints(c), stage_config_fingerprints(n)).affected_stages)==('TTS','RENDER','PUBLISH','BACKUP')"
```

Also run compile/import independence scans, `git diff --check`, and the legacy suite with `PYTHONPATH=app` to confirm its audited baseline remains 62 tests with 8 failures and 9 errors.

- [ ] **Step 2: Request independent code review**

Use `superpowers:requesting-code-review` for the Phase 3 plan base through Task 4 HEAD. Resolve every Critical and Important finding with TDD and a dedicated fix commit, then request re-review.

- [ ] **Step 3: Append audit evidence and update plan status**

Append objective, invariants, complete file list, exact commands/results, full commit hashes, review outcome, remaining Python 3.10 risk, and Phase 4 handoff to `AUDIT-LOG.md`. Change the master status to show Phases 0–3 complete and Phase 4 next. Do not rewrite prior audit entries.

- [ ] **Step 4: Review and commit documentation**

Run documentation diff, secret filename, staged filename, and `git diff --check` gates. Commit:

`git commit -m "docs(rebuild): audit config invalidation phase"`

Expected: commit succeeds and `git status --short --branch` is clean.
