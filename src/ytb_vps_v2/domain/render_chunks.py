from __future__ import annotations

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import Cue, Part, RenderChunk
from ytb_vps_v2.domain.timeline import FrameInterval


def _exact_positive(name: str, value: object) -> int:
    if type(value) is not int or value < 1:
        raise DomainInvariantError(f"{name} must be a positive integer")
    return value


def _complete_chunks(
    frame_count: int,
    chunks: tuple[RenderChunk, ...],
) -> tuple[RenderChunk, ...]:
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
            raise DomainInvariantError(
                "Render chunks must be ordered and contiguous"
            )
        expected_start = chunk.interval.end_frame
    if expected_start != total:
        raise DomainInvariantError(
            "Render chunks must cover every media frame"
        )
    return chunks


def part_file_name(part_index: int, part_count: int) -> str:
    index = _exact_positive("Part index", part_index)
    count = _exact_positive("Part count", part_count)
    if count > 999 or index > count:
        raise DomainInvariantError("Part metadata must be within 1..999")
    width = max(2, len(str(count)))
    return (
        f"part-{index:0{width}d}-of-"
        f"{count:0{width}d}.mp4"
    )


def plan_parts_for_chunks(
    *,
    frame_count: int,
    target_fps: int,
    max_part_seconds: int,
    chunks: tuple[RenderChunk, ...],
) -> tuple[Part, ...]:
    total = _exact_positive("Frame count", frame_count)
    fps = _exact_positive("Target FPS", target_fps)
    seconds = _exact_positive("Maximum Part seconds", max_part_seconds)
    complete = _complete_chunks(total, chunks)
    target_frames = fps * seconds
    groups: list[tuple[RenderChunk, ...]] = []
    current: list[RenderChunk] = []
    for chunk in complete:
        candidate_frames = chunk.interval.end_frame - (
            current[0].interval.start_frame
            if current
            else chunk.interval.start_frame
        )
        if current and candidate_frames > target_frames:
            groups.append(tuple(current))
            current = []
        current.append(chunk)
    groups.append(tuple(current))
    if len(groups) > 999:
        raise DomainInvariantError("Part count must be within 1..999")
    part_count = len(groups)
    return tuple(
        Part(
            index + 1,
            part_count,
            FrameInterval(
                group[0].interval.start_frame,
                group[-1].interval.end_frame,
            ),
            tuple(chunk.index for chunk in group),
        )
        for index, group in enumerate(groups)
    )


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
    complete = _complete_chunks(total, chunks)
    return Part(
        1,
        1,
        FrameInterval(0, total),
        tuple(item.index for item in complete),
    )
