from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator

from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import CoordinateTransform, OcrDetection


@dataclass(frozen=True, slots=True)
class RawFrame:
    frame_index: int
    data: bytes
    channel_order: str


def _positive_int(name: str, value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def iter_raw_frames(
    stream: BinaryIO,
    *,
    width: int,
    height: int,
    channel_order: str,
    start_frame: int,
    frame_step: int,
    expected_frames: int,
    frame_tolerance: int = 0,
) -> Iterator[RawFrame]:
    _positive_int("width", width)
    _positive_int("height", height)
    _positive_int("frame step", frame_step)
    _positive_int("expected frames", expected_frames)
    if type(start_frame) is not int or start_frame < 0:
        raise ValueError("start frame must be non-negative")
    if type(frame_tolerance) is not int or frame_tolerance < 0:
        raise ValueError("frame tolerance must be non-negative")
    if channel_order not in {"RGB", "BGR"}:
        raise ValueError("channel order must be RGB or BGR")
    frame_size = width * height * 3
    count = 0
    while count < expected_frames:
        chunks = bytearray()
        while len(chunks) < frame_size:
            block = stream.read(frame_size - len(chunks))
            if not block:
                break
            chunks.extend(block)
        if not chunks:
            break
        if len(chunks) != frame_size:
            raise ValueError(f"truncated frame: {len(chunks)} of {frame_size} bytes")
        yield RawFrame(start_frame + count * frame_step, bytes(chunks), channel_order)
        count += 1
    if count < expected_frames - frame_tolerance:
        raise ValueError(f"truncated stream: {count} of {expected_frames} frames")
    if stream.read(1):
        raise ValueError("overlong frame stream")


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def parse_worker_jsonl(
    raw: str | bytes,
    *,
    width: int,
    height: int,
    start_frame: int,
    frame_step: int,
    transform: CoordinateTransform,
    expected_frames: int | None = None,
) -> tuple[OcrDetection, ...]:
    if not isinstance(raw, (str, bytes)):
        raise ValueError("worker JSONL must be text or bytes")
    _positive_int("width", width)
    _positive_int("height", height)
    _positive_int("frame step", frame_step)
    if type(start_frame) is not int or start_frame < 0:
        raise ValueError("start frame must be non-negative")
    if expected_frames is not None:
        _positive_int("expected frames", expected_frames)
    result: list[OcrDetection] = []
    allowed = {"frame_index", "box", "text", "confidence"}
    for line_number, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line, parse_constant=_reject_constant)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid worker JSONL at line {line_number}") from exc
        if type(value) is not dict or set(value) != allowed:
            raise ValueError(f"worker JSONL record fields invalid at line {line_number}")
        try:
            relative = value["frame_index"]
            if type(relative) is not int or relative < 0:
                raise ValueError("frame index")
            if expected_frames is not None and relative >= expected_frames:
                raise ValueError("frame index outside expected range")
            box = value["box"]
            if type(box) is not list or len(box) != 4 or any(
                type(item) is not int for item in box
            ):
                raise ValueError("box")
            text = value["text"]
            if type(text) is not str or not text.strip():
                raise ValueError("text")
            confidence = value["confidence"]
            if type(confidence) not in (int, float) or isinstance(confidence, bool):
                raise ValueError("confidence")
            confidence_fraction = Fraction(str(confidence))
            if not 0 <= confidence_fraction <= 1:
                raise ValueError("confidence range")
            canonical_box = transform.box(box, width=width, height=height)
            result.append(
                OcrDetection(
                    start_frame + relative * frame_step,
                    canonical_box,
                    text,
                    confidence_fraction,
                )
            )
        except (ValueError, TypeError, ZeroDivisionError) as exc:
            raise ValueError(
                f"worker JSONL record invalid at line {line_number}"
            ) from exc
    return tuple(result)


def write_canonical_jsonl(
    destination: Path,
    detections: Iterable[OcrDetection],
) -> None:
    if not isinstance(destination, Path) or not destination.is_absolute():
        raise ValueError("JSONL destination must be an absolute Path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".part",
            delete=False,
        )
        temporary = Path(handle.name)
        with handle:
            values = sorted(
                detections,
                key=lambda item: (
                    item.frame_index,
                    item.box.xmin,
                    item.box.ymin,
                    item.box.xmax,
                    item.box.ymax,
                    item.text,
                ),
            )
            for item in values:
                if type(item) is not OcrDetection:
                    raise ValueError("JSONL detections must be OcrDetection values")
                payload = {
                    "box": [
                        item.box.xmin,
                        item.box.ymin,
                        item.box.xmax,
                        item.box.ymax,
                    ],
                    "confidence": str(item.confidence),
                    "frame_index": item.frame_index,
                    "text": item.text,
                }
                handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

