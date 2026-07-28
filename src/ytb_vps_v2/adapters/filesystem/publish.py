from __future__ import annotations

from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.domain.backup import ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Part
from ytb_vps_v2.domain.render_chunks import part_file_name
from ytb_vps_v2.ports.pipeline import ArtifactWriteError


class LocalPartPublisher:
    def __init__(self, root: Path) -> None:
        self.writer = LocalArtifactWriter(root)

    def publish(self, source: Path, part: Part) -> ManifestEntry:
        if type(part) is not Part:
            raise ArtifactWriteError("Published Part must be a Part")
        key = PurePosixPath("published") / part_file_name(
            part.part_index,
            part.part_count,
        )
        try:
            entry = self.writer.write_file(key, source)
            return self.writer.verify(key, entry.digest)
        except (ArtifactWriteError, DomainInvariantError) as exc:
            raise ArtifactWriteError("Local Part could not be published") from exc
