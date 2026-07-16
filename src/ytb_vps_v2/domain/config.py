from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import PipelineMode


class ConfigError(DomainInvariantError):
    """Raised when raw or typed v2 configuration is invalid."""


def _integer(name: str, value: object, *, minimum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ConfigError(f"{name} must be an integer >= {minimum}")


def _fraction(
    name: str,
    value: object,
    *,
    minimum: Fraction,
    maximum: Fraction | None = None,
    minimum_inclusive: bool = True,
) -> None:
    below_minimum = value < minimum if isinstance(value, Fraction) else True
    at_excluded_minimum = (
        isinstance(value, Fraction) and not minimum_inclusive and value == minimum
    )
    if not isinstance(value, Fraction) or below_minimum or at_excluded_minimum:
        operator = ">=" if minimum_inclusive else ">"
        raise ConfigError(f"{name} must be a Fraction {operator} {minimum}")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} must be <= {maximum}")


def _text(name: str, value: object) -> None:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ConfigError(f"{name} must be non-empty and trimmed")


def _boolean(name: str, value: object) -> None:
    if not isinstance(value, bool):
        raise ConfigError(f"{name} must be a boolean")


def _nested(name: str, value: object, expected: type[object]) -> None:
    if type(value) is not expected:
        raise ConfigError(f"{name} must be {expected.__name__}")


@dataclass(frozen=True, slots=True)
class MediaConfig:
    target_fps: int = 30
    max_width: int = 1920
    max_height: int = 1080
    chunk_seconds: int = 300

    def __post_init__(self) -> None:
        _integer("Media target FPS", self.target_fps, minimum=1)
        _integer("Media maximum width", self.max_width, minimum=1)
        _integer("Media maximum height", self.max_height, minimum=1)
        _integer("Media chunk seconds", self.chunk_seconds, minimum=1)


@dataclass(frozen=True, slots=True)
class OcrConfig:
    backend: str = "onnx"
    model_revision: str = "onnx-default"
    sample_fps: Fraction = Fraction(2)
    scan_width: int = 640
    language: str = "ch"
    minimum_confidence: Fraction = Fraction(55, 100)

    def __post_init__(self) -> None:
        _text("OCR backend", self.backend)
        _text("OCR model revision", self.model_revision)
        _fraction(
            "OCR sample FPS",
            self.sample_fps,
            minimum=Fraction(0),
            minimum_inclusive=False,
        )
        _integer("OCR scan width", self.scan_width, minimum=1)
        _text("OCR language", self.language)
        _fraction(
            "OCR minimum confidence",
            self.minimum_confidence,
            minimum=Fraction(0),
            maximum=Fraction(1),
        )


@dataclass(frozen=True, slots=True)
class TrackingConfig:
    max_gap_frames: int = 15
    minimum_duration_frames: int = 3
    cue_lead_frames: int = 3
    cue_tail_frames: int = 3
    text_similarity: Fraction = Fraction(72, 100)

    def __post_init__(self) -> None:
        _integer("Tracking maximum gap", self.max_gap_frames, minimum=0)
        _integer(
            "Tracking minimum duration", self.minimum_duration_frames, minimum=1
        )
        _integer("Tracking cue lead", self.cue_lead_frames, minimum=0)
        _integer("Tracking cue tail", self.cue_tail_frames, minimum=0)
        _fraction(
            "Tracking text similarity",
            self.text_similarity,
            minimum=Fraction(0),
            maximum=Fraction(1),
        )


@dataclass(frozen=True, slots=True)
class TranslationConfig:
    mode: PipelineMode = PipelineMode.CUE_TRANSLATION
    model: str = "gpt-5"
    prompt_revision: int = 1
    context_window_cues: int = 12

    def __post_init__(self) -> None:
        if not isinstance(self.mode, PipelineMode):
            raise ConfigError(f"Unsupported pipeline mode: {self.mode}")
        _text("Translation model", self.model)
        _integer("Translation prompt revision", self.prompt_revision, minimum=0)
        _integer(
            "Translation context window", self.context_window_cues, minimum=1
        )


@dataclass(frozen=True, slots=True)
class TtsConfig:
    provider: str = "capcut"
    voice: str = "BV074_streaming"
    resource_id: str = "7102355709945188865"
    rate: Fraction = Fraction(1)
    max_fit_speed: Fraction = Fraction(135, 100)

    def __post_init__(self) -> None:
        _text("TTS provider", self.provider)
        _text("TTS voice", self.voice)
        _text("TTS resource ID", self.resource_id)
        _fraction(
            "TTS rate",
            self.rate,
            minimum=Fraction(0),
            minimum_inclusive=False,
        )
        _fraction(
            "TTS maximum fit speed",
            self.max_fit_speed,
            minimum=Fraction(0),
            minimum_inclusive=False,
        )


@dataclass(frozen=True, slots=True)
class RenderConfig:
    profile_revision: str = "default"
    font_size: int = 42
    outline: int = 4
    mirror_video: bool = True
    blur_mode: str = "subtitle_band"

    def __post_init__(self) -> None:
        _text("Render profile revision", self.profile_revision)
        _integer("Render font size", self.font_size, minimum=1)
        _integer("Render outline", self.outline, minimum=0)
        _boolean("Render mirror flag", self.mirror_video)
        _text("Render blur mode", self.blur_mode)


@dataclass(frozen=True, slots=True)
class PublishConfig:
    remote_root: str = "gdrive:YTB-VPS"

    def __post_init__(self) -> None:
        _text("Publish remote root", self.remote_root)


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    ocr_parallelism: int = 1
    ffmpeg_threads: int = 6
    retry_attempts: int = 3
    timeout_seconds: int = 900

    def __post_init__(self) -> None:
        _integer("OCR parallelism", self.ocr_parallelism, minimum=1)
        _integer("FFmpeg threads", self.ffmpeg_threads, minimum=1)
        _integer("Retry attempts", self.retry_attempts, minimum=1)
        _integer("Timeout seconds", self.timeout_seconds, minimum=1)


@dataclass(frozen=True, slots=True)
class SafetyConfig:
    cleanup_after_upload: bool = False

    def __post_init__(self) -> None:
        _boolean("Cleanup after upload", self.cleanup_after_upload)
        if self.cleanup_after_upload:
            raise ConfigError("Cleanup remains disabled until durability gates pass")


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

    def __post_init__(self) -> None:
        for name, value, expected in (
            ("Media config", self.media, MediaConfig),
            ("OCR config", self.ocr, OcrConfig),
            ("Tracking config", self.tracking, TrackingConfig),
            ("Translation config", self.translation, TranslationConfig),
            ("TTS config", self.tts, TtsConfig),
            ("Render config", self.render, RenderConfig),
            ("Publish config", self.publish, PublishConfig),
            ("Runtime config", self.runtime, RuntimeConfig),
            ("Safety config", self.safety, SafetyConfig),
        ):
            _nested(name, value, expected)
        if self.ocr.sample_fps > self.media.target_fps:
            raise ConfigError("OCR sample FPS cannot exceed media target FPS")
