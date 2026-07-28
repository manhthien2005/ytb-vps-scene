from __future__ import annotations

import tempfile
import unittest
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.publish import LocalPartPublisher
from ytb_vps_v2.domain.models import Part
from ytb_vps_v2.domain.timeline import FrameInterval


class LocalPartPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.source = self.root / "rendered.mp4"
        self.source.write_bytes(b"verified rendered bytes")

    def test_publishes_each_part_under_its_deterministic_name(self) -> None:
        part = Part(
            2,
            3,
            FrameInterval(600, 900),
            (2,),
        )

        entry = LocalPartPublisher(self.workspace).publish(
            self.source,
            part,
        )

        self.assertEqual(
            entry.key,
            PurePosixPath("published/part-02-of-03.mp4"),
        )
        self.assertEqual(
            self.workspace.joinpath(*entry.key.parts).read_bytes(),
            self.source.read_bytes(),
        )


if __name__ == "__main__":
    unittest.main()
