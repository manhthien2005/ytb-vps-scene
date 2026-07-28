from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
from fractions import Fraction

from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BlurRegion, StageName


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class Fingerprint:
    sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.sha256, str) or _SHA256.fullmatch(self.sha256) is None:
            raise DomainInvariantError("Fingerprint must be lowercase SHA-256")


@dataclass(frozen=True, slots=True)
class StageConfigFingerprint:
    stage: StageName
    fingerprint: Fingerprint

    def __post_init__(self) -> None:
        if not isinstance(self.stage, StageName):
            raise DomainInvariantError("Fingerprint stage must be StageName")
        if not isinstance(self.fingerprint, Fingerprint):
            raise DomainInvariantError("Stage fingerprint must be Fingerprint")


@dataclass(frozen=True, slots=True)
class RenderFingerprintInputs:
    blur_regions: tuple[BlurRegion, ...] = ()
    output_has_audio: bool = True

    def __post_init__(self) -> None:
        if type(self.blur_regions) is not tuple or any(
            type(item) is not BlurRegion
            for item in self.blur_regions
        ):
            raise DomainInvariantError(
                "Render fingerprint masks are invalid"
            )
        if type(self.output_has_audio) is not bool:
            raise DomainInvariantError(
                "Render fingerprint audio policy is invalid"
            )


def _canonical(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        return {
            "type": f"{type(value).__module__}.{type(value).__qualname__}",
            "fields": {
                item.name: _canonical(getattr(value, item.name))
                for item in fields(value)
            },
        }
    if isinstance(value, Enum):
        return {
            "enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": _canonical(value.value),
        }
    if isinstance(value, Fraction):
        return {"fraction": [value.numerator, value.denominator]}
    if isinstance(value, tuple):
        return {"tuple": [_canonical(item) for item in value]}
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise DomainInvariantError("Fingerprint dictionary keys must be strings")
        return {
            "dict": {
                key: _canonical(value[key])
                for key in sorted(value)
            }
        }
    if value is None or isinstance(value, (bool, int, str)):
        return value
    raise DomainInvariantError(
        f"Unsupported fingerprint value type: {type(value).__name__}"
    )


def _fingerprint_canonical(value: object) -> Fingerprint:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return Fingerprint(hashlib.sha256(payload).hexdigest())


def fingerprint_value(value: object) -> Fingerprint:
    return _fingerprint_canonical(_canonical(value))


def legacy_s2_render_fingerprint(
    config: EffectiveConfig,
    *,
    render_inputs: RenderFingerprintInputs | None = None,
) -> Fingerprint:
    """Reproduce the S2 RENDER fingerprint before Part sizing was added."""
    if not isinstance(config, EffectiveConfig):
        raise DomainInvariantError(
            "Legacy render fingerprint requires EffectiveConfig"
        )
    render = (
        RenderFingerprintInputs()
        if render_inputs is None
        else render_inputs
    )
    if type(render) is not RenderFingerprintInputs:
        raise DomainInvariantError(
            "Legacy render fingerprint inputs are invalid"
        )
    legacy_render_config = {
        "type": (
            f"{type(config.render).__module__}."
            f"{type(config.render).__qualname__}"
        ),
        "fields": {
            item.name: _canonical(
                getattr(config.render, item.name)
            )
            for item in fields(config.render)
            if item.name != "max_part_seconds"
        },
    }
    return _fingerprint_canonical(
        {
            "tuple": [
                _canonical(config.media.chunk_seconds),
                legacy_render_config,
                _canonical(render),
            ]
        }
    )


def stage_config_projection(
    config: EffectiveConfig,
    stage: StageName,
    *,
    render_inputs: RenderFingerprintInputs | None = None,
) -> object:
    if not isinstance(config, EffectiveConfig):
        raise DomainInvariantError("Stage configuration requires EffectiveConfig")
    if not isinstance(stage, StageName):
        raise DomainInvariantError("Stage configuration requires StageName")
    render = (
        RenderFingerprintInputs()
        if render_inputs is None
        else render_inputs
    )
    if type(render) is not RenderFingerprintInputs:
        raise DomainInvariantError(
            "Stage configuration render inputs are invalid"
        )
    return {
        StageName.INGEST: (
            config.media.target_fps,
            config.media.max_width,
            config.media.max_height,
        ),
        StageName.OCR: (config.media.chunk_seconds, config.ocr),
        StageName.TRACK: config.tracking,
        StageName.TRANSLATE: config.translation,
        StageName.TTS: config.tts,
        StageName.RENDER: (
            config.media.chunk_seconds,
            config.render,
            render,
        ),
        StageName.PUBLISH: config.publish,
        StageName.BACKUP: (),
    }[stage]


def stage_config_fingerprints(
    config: EffectiveConfig,
    *,
    render_inputs: RenderFingerprintInputs | None = None,
) -> tuple[StageConfigFingerprint, ...]:
    if not isinstance(config, EffectiveConfig):
        raise DomainInvariantError("Stage fingerprints require EffectiveConfig")
    return tuple(
        StageConfigFingerprint(
            stage,
            fingerprint_value(
                stage_config_projection(
                    config,
                    stage,
                    render_inputs=render_inputs,
                )
            ),
        )
        for stage in StageName
    )
