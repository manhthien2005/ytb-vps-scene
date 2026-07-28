from __future__ import annotations

from dataclasses import replace

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Part, RenderChunk
from ytb_vps_v2.domain.pipeline import RenderRequest
from ytb_vps_v2.domain.timeline import FrameInterval


def _local_interval(
    value: FrameInterval,
    chunk: FrameInterval,
) -> FrameInterval | None:
    start = max(value.start_frame, chunk.start_frame)
    end = min(value.end_frame, chunk.end_frame)
    if start >= end:
        return None
    return FrameInterval(
        start - chunk.start_frame,
        end - chunk.start_frame,
    )


def chunk_local_request(
    plan: RenderRequest,
    chunk: RenderChunk,
) -> RenderRequest:
    if type(plan) is not RenderRequest:
        raise DomainInvariantError(
            "Chunk render plan must be a RenderRequest"
        )
    if type(chunk) is not RenderChunk:
        raise DomainInvariantError("Chunk must be a RenderChunk")
    if chunk.interval.end_frame > plan.frame_count:
        raise DomainInvariantError(
            "Render chunk must stay inside the global request"
        )

    cues = tuple(
        replace(cue, interval=local)
        for cue in plan.cues
        if (local := _local_interval(cue.interval, chunk.interval))
        is not None
    )
    blur_regions = tuple(
        replace(region, interval=local)
        for region in plan.blur_regions
        if (local := _local_interval(region.interval, chunk.interval))
        is not None
    )
    frame_count = chunk.interval.frame_count
    return replace(
        plan,
        frame_count=frame_count,
        cues=cues,
        blur_regions=blur_regions,
        parts=(
            Part(
                1,
                1,
                FrameInterval(0, frame_count),
                (chunk.index,),
            ),
        ),
    )
