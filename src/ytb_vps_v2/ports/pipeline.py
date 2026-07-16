from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.pipeline import (
    MediaDocument,
    OcrDocument,
    TrackDocument,
    TranslationDocument,
    TtsDocument,
)


class ArtifactWriteError(RuntimeError):
    """Raised when a workspace artifact cannot be durably committed."""


class ProviderError(RuntimeError):
    """Raised when an offline provider cannot satisfy its typed contract."""


@dataclass(frozen=True, slots=True)
class TtsSynthesis:
    document: TtsDocument
    audio_bytes: bytes


@runtime_checkable
class ArtifactWriter(Protocol):
    def write_bytes(self, key: PurePosixPath, raw: bytes) -> ManifestEntry: ...

    def write_file(self, key: PurePosixPath, source: Path) -> ManifestEntry: ...

    def verify(self, key: PurePosixPath, expected: FileDigest) -> ManifestEntry: ...


@runtime_checkable
class OcrProvider(Protocol):
    def detect(self, media: MediaDocument) -> OcrDocument: ...


@runtime_checkable
class TranslationProvider(Protocol):
    def translate(self, track: TrackDocument) -> TranslationDocument: ...


@runtime_checkable
class TtsProvider(Protocol):
    def synthesize(self, translation: TranslationDocument) -> TtsSynthesis: ...
