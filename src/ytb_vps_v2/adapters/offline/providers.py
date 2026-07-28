from __future__ import annotations

import hashlib
import io
import subprocess
import struct
import tempfile
import wave
from dataclasses import replace
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import BoundingBox, Cue
from ytb_vps_v2.domain.pipeline import (
    MEDIA_ARTIFACT_PATH,
    TRACK_ARTIFACT_PATH,
    TRANSLATION_ARTIFACT_PATH,
    MediaDocument,
    OcrDocument,
    TrackDocument,
    TranslationDocument,
    TtsDocument,
    canonical_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval
from ytb_vps_v2.ports.pipeline import ProviderError, TtsSynthesis


DEFAULT_TTS_AUDIO_PATH = PurePosixPath("artifacts/tts/voice.wav")


def _digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


def _dependency(document: object) -> FileDigest:
    return _digest(canonical_document_bytes(document))


class DeterministicOcrProvider:
    def detect(self, media: MediaDocument) -> OcrDocument:
        if type(media) is not MediaDocument:
            raise ProviderError("OCR input must be a MediaDocument")
        fixture_cues = (
            (
                Cue(
                    1,
                    FrameInterval(90, 240),
                    BoundingBox(32, 126, 288, 154),
                    "OFFLINE CUE ONE",
                ),
                Cue(
                    2,
                    FrameInterval(450, 660),
                    BoundingBox(48, 120, 272, 150),
                    "OFFLINE CUE TWO",
                ),
            )
            if media.frame_count >= 660
            else (
                Cue(
                    1,
                    FrameInterval(30, 75),
                    BoundingBox(32, 126, 288, 154),
                    "OFFLINE CUE ONE",
                ),
            )
        )
        cues = tuple(
            cue
            for cue in fixture_cues
            if cue.interval.end_frame <= media.frame_count
        )
        return OcrDocument(
            media.schema_version,
            media.job_id,
            media.source_digest,
            media.frame_count,
            media.width,
            media.height,
            MEDIA_ARTIFACT_PATH,
            _dependency(media),
            cues,
        )


class DeterministicTranslationProvider:
    def __init__(self, *, target_language: str = "vi") -> None:
        if (
            type(target_language) is not str
            or not target_language
            or target_language != target_language.strip()
        ):
            raise ProviderError("Target language must be non-empty and trimmed")
        self.target_language = target_language

    def translate(self, track: TrackDocument) -> TranslationDocument:
        if type(track) is not TrackDocument:
            raise ProviderError("Translation input must be a TrackDocument")
        cues = tuple(
            replace(cue, target_text=f"{self.target_language}:{cue.source_text}")
            for cue in track.cues
        )
        return TranslationDocument(
            track.schema_version,
            track.job_id,
            track.media_digest,
            track.frame_count,
            track.width,
            track.height,
            TRACK_ARTIFACT_PATH,
            _dependency(track),
            cues,
        )


class DeterministicWaveTtsProvider:
    def __init__(
        self,
        *,
        sample_rate: int = 8_000,
        audio_path: PurePosixPath = DEFAULT_TTS_AUDIO_PATH,
    ) -> None:
        if type(sample_rate) is not int or not 8_000 <= sample_rate <= 48_000:
            raise ProviderError("TTS sample rate must be between 8000 and 48000")
        if type(audio_path) is not PurePosixPath:
            raise ProviderError("TTS audio path must use portable POSIX format")
        self.sample_rate = sample_rate
        self.audio_path = audio_path

    def _pcm_bytes(self, translation: TranslationDocument) -> bytes:
        sample_count = self.sample_rate * 30
        pcm = bytearray(sample_count * 2)
        signatures = tuple(
            40 + hashlib.sha256((cue.target_text or "").encode("utf-8")).digest()[0]
            for cue in translation.cues
        )
        for sample_index in range(sample_count):
            frame = sample_index * 30 // self.sample_rate
            value = 0
            for cue, signature in zip(translation.cues, signatures):
                if cue.interval.start_frame <= frame < cue.interval.end_frame:
                    half_period = max(1, self.sample_rate // (2 * signature))
                    value = 4_000 if (sample_index // half_period) % 2 == 0 else -4_000
                    break
            struct.pack_into("<h", pcm, sample_index * 2, value)
        return bytes(pcm)

    def synthesize(self, translation: TranslationDocument) -> TtsSynthesis:
        if type(translation) is not TranslationDocument:
            raise ProviderError("TTS input must be a TranslationDocument")
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(self.sample_rate)
            writer.setcomptype("NONE", "not compressed")
            writer.writeframes(self._pcm_bytes(translation))
        audio_bytes = output.getvalue()
        document = TtsDocument(
            translation.schema_version,
            translation.job_id,
            translation.media_digest,
            translation.frame_count,
            translation.width,
            translation.height,
            TRANSLATION_ARTIFACT_PATH,
            _dependency(translation),
            translation.cues,
            self.audio_path,
            _digest(audio_bytes),
        )
        return TtsSynthesis(document, audio_bytes)


class EdgeTtsProvider:
    """Small native bridge to the free ``edge-tts`` CLI used on the VPS.

    The command is intentionally invoked with argv (never a shell) and the
    generated file is converted to the canonical WAV artifact before it enters
    the v2 pipeline.  Tests can continue using the deterministic provider.
    """

    def __init__(
        self,
        *,
        voice: str = "vi-VN-HoaiMyNeural",
        rate: float = 1.0,
        command: str = "edge-tts",
        ffmpeg: str = "ffmpeg",
        audio_path: PurePosixPath = DEFAULT_TTS_AUDIO_PATH,
    ) -> None:
        if not isinstance(voice, str) or not voice.strip() or len(voice) > 80:
            raise ProviderError("Edge TTS voice is invalid")
        if not isinstance(rate, (int, float)) or not 0.8 <= rate <= 1.2:
            raise ProviderError("Edge TTS rate is invalid")
        if not isinstance(command, str) or not command.strip() or not isinstance(ffmpeg, str) or not ffmpeg.strip():
            raise ProviderError("Edge TTS executable is invalid")
        if type(audio_path) is not PurePosixPath:
            raise ProviderError("TTS audio path must use portable POSIX format")
        self.voice = voice.strip()
        self.rate = float(rate)
        self.command = command
        self.ffmpeg = ffmpeg
        self.audio_path = audio_path

    def synthesize(self, translation: TranslationDocument) -> TtsSynthesis:
        if type(translation) is not TranslationDocument:
            raise ProviderError("TTS input must be a TranslationDocument")
        text = " ".join((cue.target_text or cue.source_text).strip() for cue in translation.cues).strip()
        if not text:
            raise ProviderError("Edge TTS input is empty")
        rate_percent = round((self.rate - 1.0) * 100)
        rate_flag = f"{rate_percent:+d}%"
        with tempfile.TemporaryDirectory(prefix="ytb-edge-tts-") as directory:
            mp3 = Path(directory) / "voice.mp3"
            wav = Path(directory) / "voice.wav"
            try:
                subprocess.run(
                    [self.command, "--voice", self.voice, "--rate", rate_flag, "--text", text, "--write-media", str(mp3)],
                    check=True,
                    capture_output=True,
                    timeout=180,
                )
                subprocess.run(
                    [self.ffmpeg, "-y", "-v", "error", "-i", str(mp3), "-ac", "1", "-ar", "24000", str(wav)],
                    check=True,
                    capture_output=True,
                    timeout=180,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise ProviderError("Edge TTS synthesis failed") from error
            try:
                audio_bytes = wav.read_bytes()
            except OSError as error:
                raise ProviderError("Edge TTS output is missing") from error
        if not audio_bytes:
            raise ProviderError("Edge TTS output is empty")
        document = TtsDocument(
            translation.schema_version,
            translation.job_id,
            translation.media_digest,
            translation.frame_count,
            translation.width,
            translation.height,
            TRANSLATION_ARTIFACT_PATH,
            _dependency(translation),
            translation.cues,
            self.audio_path,
            _digest(audio_bytes),
        )
        return TtsSynthesis(document, audio_bytes)
