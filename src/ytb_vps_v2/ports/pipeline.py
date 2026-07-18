from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.models import Part
from ytb_vps_v2.domain.pipeline import (
    MediaDocument,
    OcrDocument,
    RenderRequest,
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

    def read_verified_bytes(
        self,
        key: PurePosixPath,
        expected: FileDigest,
        max_bytes: int,
    ) -> bytes: ...


@runtime_checkable
class ArtifactWriterFactory(Protocol):
    def __call__(self, root: Path) -> ArtifactWriter: ...


@runtime_checkable
class PartPublisher(Protocol):
    def publish(self, source: Path, part: Part) -> ManifestEntry: ...


@runtime_checkable
class PartPublisherFactory(Protocol):
    def __call__(self, root: Path) -> PartPublisher: ...


@runtime_checkable
class FileDigestVerifier(Protocol):
    def digest(self, path: Path) -> FileDigest: ...


@runtime_checkable
class MediaPipeline(Protocol):
    def probe(
        self,
        source: Path,
        *,
        pass_fds: tuple[int, ...] = (),
        logical_name: str | None = None,
    ) -> MediaDocument: ...

    def render(
        self,
        source: Path,
        tts_wav: Path,
        plan: RenderRequest,
        destination: Path,
    ) -> MediaDocument: ...

    def validate_render(
        self,
        path: Path,
        expected: RenderRequest,
        *,
        pass_fds: tuple[int, ...] = (),
        logical_name: str | None = None,
    ) -> MediaDocument: ...


@runtime_checkable
class OcrProvider(Protocol):
    def detect(self, media: MediaDocument) -> OcrDocument: ...


@runtime_checkable
class TranslationProvider(Protocol):
    def translate(self, track: TrackDocument) -> TranslationDocument: ...


@runtime_checkable
class TtsProvider(Protocol):
    def synthesize(self, translation: TranslationDocument) -> TtsSynthesis: ...
