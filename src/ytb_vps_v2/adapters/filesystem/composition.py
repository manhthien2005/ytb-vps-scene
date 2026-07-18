from __future__ import annotations

from pathlib import Path

from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.filesystem.publish import LocalPartPublisher
from ytb_vps_v2.domain.backup import FileDigest


class LocalArtifactWriterFactory:
    def __call__(self, root: Path) -> LocalArtifactWriter:
        return LocalArtifactWriter(root)


class LocalPartPublisherFactory:
    def __call__(self, root: Path) -> LocalPartPublisher:
        return LocalPartPublisher(root)


class LocalFileDigestVerifier:
    @staticmethod
    def digest(path: Path) -> FileDigest:
        return digest_file(path)
