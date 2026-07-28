from __future__ import annotations

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Cue, Part, RenderChunk
from ytb_vps_v2.domain.timeline import FrameInterval


def _exact_positive(name: str, value: object) -> int:
    if type(value) is not int or value < 1:
        raise DomainInvariantError(f"{name} must be a positive integer")
    return value


def plan_render_chunks(
    *,
    frame_count: int,
    target_fps: int,
    chunk_seconds: int,
    cues: tuple[Cue, ...],
) -> tuple[RenderChunk, ...]:
    total = _exact_positive("Frame count", frame_count)
    fps = _exact_positive("Target FPS", target_fps)
    seconds = _exact_positive("Chunk seconds", chunk_seconds)
    if type(cues) is not tuple or any(type(item) is not Cue for item in cues):
        raise DomainInvariantError("Chunk-planning cues must be a Cue tuple")
    if any(item.interval.end_frame > total for item in cues):
        raise DomainInvariantError("Chunk-planning cue exceeds the media")

    target = fps * seconds
    result: list[RenderChunk] = []
    start = 0
    while start < total:
        end = min(total, start + target)
        if end < total:
            while True:
                extended = max(
                    (
                        item.interval.end_frame
                        for item in cues
                        if item.interval.start_frame < end < item.interval.end_frame
                    ),
                    default=end,
                )
                if extended == end:
                    break
                end = min(total, extended)
        result.append(RenderChunk(len(result), FrameInterval(start, end)))
        start = end
    return tuple(result)


def single_part_for_chunks(
    frame_count: int,
    chunks: tuple[RenderChunk, ...],
) -> Part:
    total = _exact_positive("Frame count", frame_count)
    if type(chunks) is not tuple or not chunks:
        raise DomainInvariantError("Part planning needs render chunks")
    expected_start = 0
    for index, chunk in enumerate(chunks):
        if (
            type(chunk) is not RenderChunk
            or chunk.index != index
            or chunk.interval.start_frame != expected_start
        ):
            raise DomainInvariantError("Render chunks must be ordered and contiguous")
        expected_start = chunk.interval.end_frame
    if expected_start != total:
        raise DomainInvariantError("Render chunks must cover every media frame")
    return Part(1, 1, FrameInterval(0, total), tuple(item.index for item in chunks))
