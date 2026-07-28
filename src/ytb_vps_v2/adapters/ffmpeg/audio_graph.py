# src/ytb_vps_v2/adapters/ffmpeg/audio_graph.py
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError


@dataclass(frozen=True, slots=True)
class VoiceSegment:
    """One synthesized group, and where on the canonical timeline it belongs.

    Placement is per segment on purpose: concatenating every cue into a single
    untimed wav is what made the voice drift away from the picture."""

    input_index: int
    start_seconds: Fraction

    def __post_init__(self) -> None:
        if not isinstance(self.input_index, int) or self.input_index < 0:
            raise DomainInvariantError("Voice segment input index must be non-negative")
        if not isinstance(self.start_seconds, Fraction) or self.start_seconds < 0:
            raise DomainInvariantError("Voice segment start must be a non-negative Fraction")


@dataclass(frozen=True, slots=True)
class AudioMixPolicy:
    source_volume: Fraction = Fraction(35, 100)
    ducking: bool = True
    duck_threshold: Fraction = Fraction(2, 100)
    duck_ratio: int = 12
    attack_ms: int = 20
    release_ms: int = 400

    def __post_init__(self) -> None:
        if not isinstance(self.source_volume, Fraction) or not 0 <= self.source_volume <= 1:
            raise DomainInvariantError("Source volume must be a ratio 0..1")
        if not isinstance(self.duck_ratio, int) or self.duck_ratio < 1:
            raise DomainInvariantError("Duck ratio must be at least 1")


def _seconds(value: Fraction) -> str:
    return f"{float(value):.3f}"


def build_audio_graph(
    segments: Sequence[VoiceSegment],
    *,
    source_input_index: int | None,
    duration_seconds: Fraction,
    policy: AudioMixPolicy,
    output_label: str = "aout",
) -> str:
    if not isinstance(duration_seconds, Fraction) or duration_seconds <= 0:
        raise DomainInvariantError("Audio duration must be a positive Fraction")

    statements: list[str] = []
    keep_source = source_input_index is not None and policy.source_volume > 0
    duration = _seconds(duration_seconds)

    voice_label: str | None = None
    if segments:
        for position, segment in enumerate(segments):
            delay = int(segment.start_seconds * 1000)
            statements.append(
                f"[{segment.input_index}:a]aresample=48000,"
                f"adelay={delay}|{delay}[voice{position}]"
            )
        if len(segments) == 1:
            voice_label = "voice0"
        else:
            inputs = "".join(f"[voice{position}]" for position in range(len(segments)))
            statements.append(
                f"{inputs}amix=inputs={len(segments)}:duration=longest:normalize=0[voicemix]"
            )
            voice_label = "voicemix"

    if not keep_source and voice_label is None:
        statements.append(
            f"anullsrc=channel_layout=stereo:sample_rate=48000,"
            f"atrim=duration={duration}[{output_label}]"
        )
        return ";".join(statements)

    if voice_label is None:
        statements.append(
            f"[{source_input_index}:a]aresample=48000,"
            f"volume={float(policy.source_volume):.6f},"
            f"apad=whole_dur={duration},atrim=duration={duration}[{output_label}]"
        )
        return ";".join(statements)

    if not keep_source:
        statements.append(
            f"[{voice_label}]apad=whole_dur={duration},"
            f"atrim=duration={duration},alimiter=limit=0.95[{output_label}]"
        )
        return ";".join(statements)

    if policy.ducking:
        # sidechaincompress emits only as long as its SHORTER input. Measured against
        # ffmpeg N-124716: a 20s bed keyed by a 15s speech track yields 15s of audio,
        # silently truncating the last 5s of music. Both the key and the bed must
        # therefore be padded to the full runtime BEFORE they reach the compressor --
        # padding only after the mix does not recover the lost tail.
        statements.append(f"[{voice_label}]asplit=2[voiceout][sidekey]")
        statements.append(f"[sidekey]apad=whole_dur={duration}[sidechain]")
        statements.append(
            f"[{source_input_index}:a]aresample=48000,"
            f"volume={float(policy.source_volume):.6f},"
            f"apad=whole_dur={duration}[bed]"
        )
        statements.append(
            f"[bed][sidechain]sidechaincompress="
            f"threshold={float(policy.duck_threshold):.4f}:ratio={policy.duck_ratio}:"
            f"attack={policy.attack_ms}:release={policy.release_ms}[ducked]"
        )
        mix_inputs = "[ducked][voiceout]"
    else:
        statements.append(
            f"[{source_input_index}:a]aresample=48000,"
            f"volume={float(policy.source_volume):.6f}[bed]"
        )
        mix_inputs = f"[bed][{voice_label}]"

    statements.append(
        f"{mix_inputs}amix=inputs=2:duration=longest:normalize=0,"
        f"alimiter=limit=0.95,apad=whole_dur={duration},"
        f"atrim=duration={duration}[{output_label}]"
    )
    return ";".join(statements)
