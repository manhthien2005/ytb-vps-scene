from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
from fractions import Fraction

from ytb_vps_v2.domain.config import (
    ConfigError,
    EffectiveConfig,
    MediaConfig,
    OcrConfig,
    PublishConfig,
    RenderConfig,
    RuntimeConfig,
    SafetyConfig,
    TrackingConfig,
    TranslationConfig,
    TtsConfig,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import PipelineMode
from ytb_vps_v2.domain.timeline import to_fraction


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


def _section(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ConfigError(f"Configuration section must be a mapping: {path}")
    if any(not isinstance(key, str) for key in value):
        raise ConfigError(f"Configuration keys must be strings: {path}")
    return dict(value)


def _pop_int(
    section: dict[str, object],
    key: str,
    default: int,
    path: str,
) -> int:
    value = section.pop(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{path}.{key} must be an integer")
    return value


def _pop_fraction(
    section: dict[str, object],
    key: str,
    default: Fraction,
    path: str,
) -> Fraction:
    if key not in section:
        return default
    value = section.pop(key)
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ConfigError(f"{path}.{key} must be an int, float, or string")
    try:
        return to_fraction(value)
    except DomainInvariantError as exc:
        raise ConfigError(f"{path}.{key} must be a finite rational") from exc


def _pop_text(
    section: dict[str, object],
    key: str,
    default: str,
    path: str,
) -> str:
    value = section.pop(key, default)
    if not isinstance(value, str) or not value or value != value.strip():
        raise ConfigError(f"{path}.{key} must be non-empty and trimmed")
    return value


def _pop_bool(
    section: dict[str, object],
    key: str,
    default: bool,
    path: str,
) -> bool:
    value = section.pop(key, default)
    if not isinstance(value, bool):
        raise ConfigError(f"{path}.{key} must be a boolean")
    return value


def _unknown(
    paths: Iterable[str],
    policy: UnknownKeyPolicy,
    warnings: list[ConfigWarning],
) -> None:
    for path in sorted(paths):
        if policy is UnknownKeyPolicy.ERROR:
            raise ConfigError(f"Unknown configuration key: {path}")
        warnings.append(ConfigWarning(path, "Unknown configuration key ignored"))


def _warn_alias(warnings: list[ConfigWarning], path: str) -> None:
    warnings.append(ConfigWarning(path, "Deprecated alias translated"))


def _conflict(*paths: str) -> None:
    raise ConfigError(f"Configuration conflict between {', '.join(paths)}")


def _build_effective_config(
    sections: dict[str, dict[str, object]],
    warnings: list[ConfigWarning],
) -> EffectiveConfig:
    defaults = EffectiveConfig()
    media = sections["media"]
    ocr = sections["ocr"]
    tracking = sections["tracking"]
    translation = sections["translation"]
    tts = sections["tts"]
    render = sections["render"]
    publish = sections["publish"]
    runtime = sections["runtime"]
    queue = sections["queue"]
    safety = sections["safety"]
    drive = sections["drive"]

    if "ffmpeg_threads" in runtime and "ffmpeg_threads" in media:
        _conflict("runtime.ffmpeg_threads", "media.ffmpeg_threads")
    if "ocr_parallelism" in runtime and "parallel_chunks" in ocr:
        _conflict("runtime.ocr_parallelism", "ocr.parallel_chunks")
    if "prompt_revision" in translation and "style_version" in translation:
        _conflict("translation.prompt_revision", "translation.style_version")
    legacy_models_present = "det_model_dir" in ocr or "rec_model_dir" in ocr
    if "model_revision" in ocr and legacy_models_present:
        _conflict("ocr.model_revision", "ocr.det_model_dir/rec_model_dir")
    if legacy_models_present and not {
        "det_model_dir",
        "rec_model_dir",
    }.issubset(ocr):
        raise ConfigError(
            "Legacy OCR model configuration requires det_model_dir and rec_model_dir"
        )
    if "remote_root" in publish and "remote_root" in drive:
        _conflict("publish.remote_root", "drive.remote_root")
    if "cleanup_after_upload" in safety and "cleanup_after_upload" in queue:
        _conflict(
            "safety.cleanup_after_upload",
            "queue.cleanup_after_upload",
        )

    ffmpeg_threads = _pop_int(
        runtime,
        "ffmpeg_threads",
        defaults.runtime.ffmpeg_threads,
        "runtime",
    )
    if "ffmpeg_threads" in media:
        ffmpeg_threads = _pop_int(
            media,
            "ffmpeg_threads",
            defaults.runtime.ffmpeg_threads,
            "media",
        )
        _warn_alias(warnings, "media.ffmpeg_threads")

    ocr_parallelism = _pop_int(
        runtime,
        "ocr_parallelism",
        defaults.runtime.ocr_parallelism,
        "runtime",
    )
    if "parallel_chunks" in ocr:
        ocr_parallelism = _pop_int(
            ocr,
            "parallel_chunks",
            defaults.runtime.ocr_parallelism,
            "ocr",
        )
        _warn_alias(warnings, "ocr.parallel_chunks")

    prompt_revision = _pop_int(
        translation,
        "prompt_revision",
        defaults.translation.prompt_revision,
        "translation",
    )
    if "style_version" in translation:
        prompt_revision = _pop_int(
            translation,
            "style_version",
            defaults.translation.prompt_revision,
            "translation",
        )
        _warn_alias(warnings, "translation.style_version")

    model_revision = _pop_text(
        ocr,
        "model_revision",
        defaults.ocr.model_revision,
        "ocr",
    )
    if legacy_models_present:
        det_model = _pop_text(ocr, "det_model_dir", "", "ocr")
        rec_model = _pop_text(ocr, "rec_model_dir", "", "ocr")
        model_revision = f"det={det_model};rec={rec_model}"
        _warn_alias(warnings, "ocr.det_model_dir")
        _warn_alias(warnings, "ocr.rec_model_dir")

    remote_root = _pop_text(
        publish,
        "remote_root",
        defaults.publish.remote_root,
        "publish",
    )
    if "remote_root" in drive:
        remote_root = _pop_text(
            drive,
            "remote_root",
            defaults.publish.remote_root,
            "drive",
        )
        _warn_alias(warnings, "drive.remote_root")

    cleanup_after_upload = _pop_bool(
        safety,
        "cleanup_after_upload",
        defaults.safety.cleanup_after_upload,
        "safety",
    )
    if "cleanup_after_upload" in queue:
        cleanup_after_upload = _pop_bool(
            queue,
            "cleanup_after_upload",
            defaults.safety.cleanup_after_upload,
            "queue",
        )
        _warn_alias(warnings, "queue.cleanup_after_upload")

    mode_value = _pop_text(
        translation,
        "mode",
        defaults.translation.mode.value,
        "translation",
    )
    try:
        mode = PipelineMode(mode_value)
    except ValueError as exc:
        raise ConfigError(f"Unsupported pipeline mode: {mode_value}") from exc

    return EffectiveConfig(
        media=MediaConfig(
            target_fps=_pop_int(
                media, "target_fps", defaults.media.target_fps, "media"
            ),
            max_width=_pop_int(
                media, "max_width", defaults.media.max_width, "media"
            ),
            max_height=_pop_int(
                media, "max_height", defaults.media.max_height, "media"
            ),
            chunk_seconds=_pop_int(
                media, "chunk_seconds", defaults.media.chunk_seconds, "media"
            ),
        ),
        ocr=OcrConfig(
            backend=_pop_text(ocr, "backend", defaults.ocr.backend, "ocr"),
            model_revision=model_revision,
            sample_fps=_pop_fraction(
                ocr, "sample_fps", defaults.ocr.sample_fps, "ocr"
            ),
            scan_width=_pop_int(
                ocr, "scan_width", defaults.ocr.scan_width, "ocr"
            ),
            language=_pop_text(ocr, "language", defaults.ocr.language, "ocr"),
            minimum_confidence=_pop_fraction(
                ocr,
                "minimum_confidence",
                defaults.ocr.minimum_confidence,
                "ocr",
            ),
        ),
        tracking=TrackingConfig(
            max_gap_frames=_pop_int(
                tracking,
                "max_gap_frames",
                defaults.tracking.max_gap_frames,
                "tracking",
            ),
            minimum_duration_frames=_pop_int(
                tracking,
                "minimum_duration_frames",
                defaults.tracking.minimum_duration_frames,
                "tracking",
            ),
            cue_lead_frames=_pop_int(
                tracking,
                "cue_lead_frames",
                defaults.tracking.cue_lead_frames,
                "tracking",
            ),
            cue_tail_frames=_pop_int(
                tracking,
                "cue_tail_frames",
                defaults.tracking.cue_tail_frames,
                "tracking",
            ),
            text_similarity=_pop_fraction(
                tracking,
                "text_similarity",
                defaults.tracking.text_similarity,
                "tracking",
            ),
        ),
        translation=TranslationConfig(
            mode=mode,
            model=_pop_text(
                translation, "model", defaults.translation.model, "translation"
            ),
            prompt_revision=prompt_revision,
            context_window_cues=_pop_int(
                translation,
                "context_window_cues",
                defaults.translation.context_window_cues,
                "translation",
            ),
        ),
        tts=TtsConfig(
            provider=_pop_text(tts, "provider", defaults.tts.provider, "tts"),
            voice=_pop_text(tts, "voice", defaults.tts.voice, "tts"),
            resource_id=_pop_text(
                tts, "resource_id", defaults.tts.resource_id, "tts"
            ),
            rate=_pop_fraction(tts, "rate", defaults.tts.rate, "tts"),
            max_fit_speed=_pop_fraction(
                tts, "max_fit_speed", defaults.tts.max_fit_speed, "tts"
            ),
        ),
        render=RenderConfig(
            profile_revision=_pop_text(
                render,
                "profile_revision",
                defaults.render.profile_revision,
                "render",
            ),
            font_size=_pop_int(
                render, "font_size", defaults.render.font_size, "render"
            ),
            outline=_pop_int(render, "outline", defaults.render.outline, "render"),
            mirror_video=_pop_bool(
                render,
                "mirror_video",
                defaults.render.mirror_video,
                "render",
            ),
            blur_mode=_pop_text(
                render, "blur_mode", defaults.render.blur_mode, "render"
            ),
        ),
        publish=PublishConfig(remote_root=remote_root),
        runtime=RuntimeConfig(
            ocr_parallelism=ocr_parallelism,
            ffmpeg_threads=ffmpeg_threads,
            retry_attempts=_pop_int(
                runtime,
                "retry_attempts",
                defaults.runtime.retry_attempts,
                "runtime",
            ),
            timeout_seconds=_pop_int(
                runtime,
                "timeout_seconds",
                defaults.runtime.timeout_seconds,
                "runtime",
            ),
        ),
        safety=SafetyConfig(cleanup_after_upload=cleanup_after_upload),
    )


def parse_config(
    raw: Mapping[str, object],
    *,
    unknown_policy: UnknownKeyPolicy = UnknownKeyPolicy.WARN,
) -> ConfigLoadResult:
    if not isinstance(raw, Mapping):
        raise ConfigError("Configuration root must be a mapping")
    if any(not isinstance(key, str) for key in raw):
        raise ConfigError("Configuration root keys must be strings")
    if not isinstance(unknown_policy, UnknownKeyPolicy):
        raise ConfigError("Unknown-key policy is invalid")

    root = dict(raw)
    warnings: list[ConfigWarning] = []
    section_names = (
        "media",
        "ocr",
        "tracking",
        "translation",
        "tts",
        "render",
        "publish",
        "runtime",
        "queue",
        "safety",
        "drive",
    )
    sections = {
        name: _section(root.pop(name, {}), name)
        for name in section_names
    }
    config = _build_effective_config(sections, warnings)
    for name in section_names:
        _unknown(
            (f"{name}.{key}" for key in sections[name]),
            unknown_policy,
            warnings,
        )
    _unknown(root, unknown_policy, warnings)
    return ConfigLoadResult(config, tuple(warnings))
