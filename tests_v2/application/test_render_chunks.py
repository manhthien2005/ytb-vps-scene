from __future__ import annotations

import hashlib
import unittest
from dataclasses import replace
from pathlib import PurePosixPath

from ytb_vps_v2.application.render_chunks import (
    chunk_local_request,
    part_local_request,
)
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import (
    BlurRegion,
    BoundingBox,
    Cue,
    JobId,
    Part,
    RegionKind,
    RenderChunk,
)
from ytb_vps_v2.domain.pipeline import TTS_ARTIFACT_PATH, RenderRequest
from ytb_vps_v2.domain.timeline import FrameInterval


DIGEST = FileDigest(1, hashlib.sha256(b"x").hexdigest())
BOX = BoundingBox(10, 20, 110, 80)


def global_request() -> RenderRequest:
    return RenderRequest(
        1,
        JobId("chunk-local-job"),
        DIGEST,
        900,
        1280,
        720,
        TTS_ARTIFACT_PATH,
        DIGEST,
        (
            Cue(1, FrameInterval(0, 100), BOX, "outside", "ngoài"),
            Cue(2, FrameInterval(280, 330), BOX, "left", "trái"),
            Cue(3, FrameInterval(450, 650), BOX, "right", "phải"),
            Cue(4, FrameInterval(700, 800), BOX, "later", "sau"),
        ),
        (
            BlurRegion(
                RegionKind.DYNAMIC,
                FrameInterval(250, 350),
                BOX,
            ),
            BlurRegion(
                RegionKind.STATIC,
                FrameInterval(0, 900),
                BOX,
            ),
            BlurRegion(
                RegionKind.DYNAMIC,
                FrameInterval(700, 800),
                BOX,
            ),
        ),
        PurePosixPath("artifacts/tts/voice.wav"),
        DIGEST,
        (Part(1, 1, FrameInterval(0, 900), (0, 1, 2)),),
        True,
    )


class ChunkLocalRequestTests(unittest.TestCase):
    def test_intersects_and_rebases_timeline_content(self) -> None:
        plan = global_request()

        local = chunk_local_request(
            plan,
            RenderChunk(1, FrameInterval(300, 600)),
        )

        self.assertEqual(local.frame_count, 300)
        self.assertEqual(
            tuple(item.interval for item in local.cues),
            (FrameInterval(0, 30), FrameInterval(150, 300)),
        )
        self.assertEqual(tuple(item.cue_index for item in local.cues), (2, 3))
        self.assertEqual(
            tuple(item.interval for item in local.blur_regions),
            (FrameInterval(0, 50), FrameInterval(0, 300)),
        )
        self.assertEqual(
            local.parts,
            (Part(1, 1, FrameInterval(0, 300), (1,)),),
        )

    def test_preserves_non_timeline_render_identity(self) -> None:
        plan = global_request()

        local = chunk_local_request(
            plan,
            RenderChunk(1, FrameInterval(300, 600)),
        )

        self.assertEqual(local.schema_version, plan.schema_version)
        self.assertEqual(local.job_id, plan.job_id)
        self.assertEqual(local.media_digest, plan.media_digest)
        self.assertEqual((local.width, local.height), (plan.width, plan.height))
        self.assertEqual(local.dependency_path, plan.dependency_path)
        self.assertEqual(local.dependency_digest, plan.dependency_digest)
        self.assertEqual(local.tts_audio_path, plan.tts_audio_path)
        self.assertEqual(local.tts_audio_digest, plan.tts_audio_digest)
        self.assertIs(local.output_has_audio, plan.output_has_audio)

    def test_rejects_chunk_outside_the_global_request(self) -> None:
        with self.assertRaisesRegex(
            DomainInvariantError,
            "inside",
        ):
            chunk_local_request(
                global_request(),
                RenderChunk(3, FrameInterval(600, 901)),
            )


class PartLocalRequestTests(unittest.TestCase):
    def test_clips_rebases_and_preserves_the_parts_chunk_count(self) -> None:
        plan = global_request()
        first = Part(1, 2, FrameInterval(0, 300), (0,))
        second = Part(2, 2, FrameInterval(300, 900), (1, 2))
        plan = replace(plan, parts=(first, second))

        local = part_local_request(plan, second)

        self.assertEqual(local.frame_count, 600)
        self.assertEqual(
            tuple(item.interval for item in local.cues),
            (
                FrameInterval(0, 30),
                FrameInterval(150, 350),
                FrameInterval(400, 500),
            ),
        )
        self.assertEqual(
            tuple(item.interval for item in local.blur_regions),
            (
                FrameInterval(0, 50),
                FrameInterval(0, 600),
                FrameInterval(400, 500),
            ),
        )
        self.assertEqual(
            local.parts,
            (Part(1, 1, FrameInterval(0, 600), (1, 2)),),
        )

    def test_rejects_a_part_not_owned_by_the_global_request(self) -> None:
        foreign = Part(1, 1, FrameInterval(0, 450), (0,))

        with self.assertRaisesRegex(DomainInvariantError, "global request"):
            part_local_request(global_request(), foreign)


if __name__ == "__main__":
    unittest.main()
