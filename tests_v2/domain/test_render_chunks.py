from __future__ import annotations

import unittest

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox, Cue, RenderChunk
from ytb_vps_v2.domain.render_chunks import (
    plan_render_chunks,
    single_part_for_chunks,
)
from ytb_vps_v2.domain.timeline import FrameInterval


def cue(index: int, start: int, end: int) -> Cue:
    return Cue(
        index,
        FrameInterval(start, end),
        BoundingBox(0, 80, 320, 120),
        f"source-{index}",
        f"target-{index}",
    )


class RenderChunkPlanningTests(unittest.TestCase):
    def test_exact_boundaries_and_short_tail_tile_the_media(self) -> None:
        chunks = plan_render_chunks(
            frame_count=751,
            target_fps=30,
            chunk_seconds=10,
            cues=(),
        )
        self.assertEqual(
            chunks,
            (
                RenderChunk(0, FrameInterval(0, 300)),
                RenderChunk(1, FrameInterval(300, 600)),
                RenderChunk(2, FrameInterval(600, 751)),
            ),
        )

    def test_boundary_moves_forward_until_it_splits_no_cue(self) -> None:
        chunks = plan_render_chunks(
            frame_count=900,
            target_fps=30,
            chunk_seconds=10,
            cues=(cue(1, 280, 330), cue(2, 320, 380)),
        )
        self.assertEqual(chunks[0].interval, FrameInterval(0, 380))
        self.assertEqual(chunks[1].interval, FrameInterval(380, 680))
        self.assertEqual(chunks[2].interval, FrameInterval(680, 900))

    def test_one_long_cue_creates_one_larger_chunk(self) -> None:
        chunks = plan_render_chunks(
            frame_count=1_200,
            target_fps=30,
            chunk_seconds=10,
            cues=(cue(1, 100, 850),),
        )
        self.assertEqual(chunks[0], RenderChunk(0, FrameInterval(0, 850)))
        self.assertEqual(chunks[1], RenderChunk(1, FrameInterval(850, 1_150)))
        self.assertEqual(chunks[2], RenderChunk(2, FrameInterval(1_150, 1_200)))

    def test_single_part_contains_every_chunk_index(self) -> None:
        chunks = plan_render_chunks(
            frame_count=601,
            target_fps=30,
            chunk_seconds=10,
            cues=(),
        )
        part = single_part_for_chunks(601, chunks)
        self.assertEqual(part.interval, FrameInterval(0, 601))
        self.assertEqual(part.chunk_indexes, (0, 1, 2))

    def test_invalid_exact_types_and_cue_bounds_fail(self) -> None:
        calls = (
            lambda: plan_render_chunks(
                frame_count=True,
                target_fps=30,
                chunk_seconds=10,
                cues=(),
            ),
            lambda: plan_render_chunks(
                frame_count=300,
                target_fps=0,
                chunk_seconds=10,
                cues=(),
            ),
            lambda: plan_render_chunks(
                frame_count=300,
                target_fps=30,
                chunk_seconds=10,
                cues=(cue(1, 250, 301),),
            ),
        )
        for call in calls:
            with self.subTest(call=call):
                with self.assertRaises(DomainInvariantError):
                    call()
