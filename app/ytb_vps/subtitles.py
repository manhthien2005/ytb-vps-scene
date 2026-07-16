from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Iterator

from ytb_vps.state import JobStore
from ytb_vps.util import atomic_write_text


HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def normalize_text(value: str) -> str:
    return re.sub(r"[\s\W_]+", "", value, flags=re.UNICODE).casefold()


def contains_han(value: str) -> bool:
    return bool(HAN_RE.search(str(value)))


def clean_ocr_text(value: str) -> str:
    text = str(value)
    for pattern in (
        r"\u539f\u521b@?",
        r"\u7167\u6708\u541b",
        r"(?i)(?<![A-Za-z])(?:b|l|esl)[il1]{1,5}b?[il1]{0,5}b?(?![A-Za-z])",
        r"(?i)\bbil\b",
    ):
        text = re.sub(pattern, "", text)
    text = re.sub(r"[\u7167\u6708\u541b]{2,}$", "", text)
    text = re.sub(r"\u7167$", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if normalize_text(text) in {"", "\u541b"}:
        return ""
    return text


def text_similarity(left: str, right: str) -> float:
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


@dataclass
class Observation:
    frame: int
    text: str
    box: tuple[int, int, int, int]


@dataclass
class ActiveCue:
    start_frame: int
    last_frame: int
    observations: list[Observation] = field(default_factory=list)

    @property
    def representative_text(self) -> str:
        if not self.observations:
            return ""
        counts = Counter(item.text for item in self.observations)
        return max(counts, key=lambda value: (counts[value], len(value)))

    def add(self, observation: Observation) -> None:
        self.last_frame = observation.frame
        self.observations.append(observation)

    def as_cue(
        self,
        cue_index: int,
        *,
        lead_frames: int = 0,
        tail_frames: int = 1,
    ) -> dict[str, Any]:
        boxes = [item.box for item in self.observations]
        box = [int(round(median(values))) for values in zip(*boxes)]
        text = self.representative_text
        return {
            "cue_index": cue_index,
            "start_frame": max(0, self.start_frame - max(0, lead_frames)),
            "end_frame": self.last_frame + max(1, tail_frames),
            "box": box,
            "source_text": text,
            "source_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        }


def _frame_groups(rows: Iterable[dict[str, Any]]) -> Iterator[tuple[int, list[dict[str, Any]]]]:
    current_frame: int | None = None
    current: list[dict[str, Any]] = []
    for row in rows:
        frame = int(row["frame_index"])
        if current_frame is not None and frame != current_frame:
            yield current_frame, current
            current = []
        current_frame = frame
        current.append(row)
    if current_frame is not None:
        yield current_frame, current


def _observation(
    frame: int,
    rows: list[dict[str, Any]],
    *,
    width: int,
    height: int,
    confidence: float,
    min_y_ratio: float,
    max_y_ratio: float,
    center_min_x_ratio: float = 0.08,
    center_max_x_ratio: float = 0.92,
    center_min_y_ratio: float | None = None,
    line_cluster_y_ratio: float = 0.055,
    minimum_text_chars: int = 2,
) -> Observation | None:
    candidates = []
    min_y = height * min_y_ratio
    max_y = height * max_y_ratio
    center_min_x = width * center_min_x_ratio
    center_max_x = width * center_max_x_ratio
    center_min_y = height * center_min_y_ratio if center_min_y_ratio is not None else min_y
    for row in rows:
        y_center = (int(row["ymin"]) + int(row["ymax"])) / 2
        x_center = (int(row["xmin"]) + int(row["xmax"])) / 2
        text = clean_ocr_text(str(row["text"]))
        if float(row.get("confidence") or 0.0) < confidence:
            continue
        if not (min_y <= y_center <= max_y):
            continue
        if not (center_min_x <= x_center <= center_max_x):
            continue
        normalized = normalize_text(text)
        if len(normalized) < minimum_text_chars:
            continue
        item = dict(row)
        item["text"] = text
        candidates.append(item)
    if not candidates:
        return None

    candidates.sort(
        key=lambda item: (
            (int(item["ymin"]) + int(item["ymax"])) / 2,
            int(item["xmin"]),
        )
    )
    threshold = max(8.0, height * line_cluster_y_ratio)
    clusters: list[list[dict[str, Any]]] = []
    for candidate in candidates:
        center = (int(candidate["ymin"]) + int(candidate["ymax"])) / 2
        if not clusters:
            clusters.append([candidate])
            continue
        last = clusters[-1]
        last_center = median(
            (int(item["ymin"]) + int(item["ymax"])) / 2 for item in last
        )
        if abs(center - last_center) <= threshold:
            last.append(candidate)
        else:
            clusters.append([candidate])

    def score(cluster: list[dict[str, Any]]) -> tuple[float, float, int]:
        text_length = sum(len(normalize_text(str(item["text"]))) for item in cluster)
        average_confidence = sum(float(item.get("confidence") or 0.0) for item in cluster) / len(cluster)
        x1 = min(int(item["xmin"]) for item in cluster)
        x2 = max(int(item["xmax"]) for item in cluster)
        y2 = max(int(item["ymax"]) for item in cluster)
        center_bonus = 1.0 - min(1.0, abs(((x1 + x2) / 2) - (width / 2)) / (width / 2))
        bottom_bonus = y2 / height
        return (
            average_confidence * 4.0 + min(text_length, 28) / 28.0 + center_bonus + bottom_bonus,
            bottom_bonus,
            text_length,
        )

    bottom_clusters = [
        cluster
        for cluster in clusters
        if max(int(item["ymax"]) for item in cluster) >= center_min_y
    ]
    if not bottom_clusters:
        return None
    candidates = sorted(
        max(bottom_clusters, key=score),
        key=lambda item: (int(item["ymin"]), int(item["xmin"])),
    )
    text = "".join(str(item["text"]).strip() for item in candidates)
    return Observation(
        frame=frame,
        text=text,
        box=(
            min(int(item["xmin"]) for item in candidates),
            min(int(item["ymin"]) for item in candidates),
            max(int(item["xmax"]) for item in candidates),
            max(int(item["ymax"]) for item in candidates),
        ),
    )


def build_cues(
    store: JobStore,
    job_id: str,
    *,
    media: dict[str, Any],
    ocr_config: dict[str, Any],
    tracking_config: dict[str, Any],
) -> list[dict[str, Any]]:
    target_fps = max(1, int(round(float(media.get("fps") or 30))))
    sample_fps = float(ocr_config.get("sample_fps", target_fps))
    sample_step = max(1, int(round(target_fps / sample_fps)))
    max_gap = max(int(tracking_config["max_gap_frames"]), sample_step)
    minimum_duration = int(tracking_config["minimum_duration_frames"])
    threshold = float(tracking_config["text_similarity"])
    lead_frames = int(tracking_config.get("cue_lead_frames", 0))
    tail_frames = int(tracking_config.get("cue_tail_frames", sample_step))
    min_gap_frames = max(0, int(tracking_config.get("cue_min_gap_frames", 0)))
    prevent_overlap = bool(tracking_config.get("cue_prevent_overlap", True))
    active: ActiveCue | None = None
    cues: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal active
        if active and active.last_frame - active.start_frame + sample_step >= minimum_duration:
            cues.append(
                active.as_cue(
                    len(cues) + 1,
                    lead_frames=lead_frames,
                    tail_frames=tail_frames,
                )
            )
        active = None

    for frame, rows in _frame_groups(store.iter_detections(job_id)):
        observed = _observation(
            frame,
            rows,
            width=int(media["width"]),
            height=int(media["height"]),
            confidence=float(ocr_config["minimum_confidence"]),
            min_y_ratio=float(ocr_config["subtitle_min_y_ratio"]),
            max_y_ratio=float(ocr_config["subtitle_max_y_ratio"]),
            center_min_x_ratio=float(ocr_config.get("subtitle_center_min_x_ratio", 0.08)),
            center_max_x_ratio=float(ocr_config.get("subtitle_center_max_x_ratio", 0.92)),
            center_min_y_ratio=float(ocr_config.get("subtitle_center_min_y_ratio", ocr_config["subtitle_min_y_ratio"])),
            line_cluster_y_ratio=float(tracking_config.get("line_cluster_y_ratio", 0.055)),
            minimum_text_chars=int(tracking_config.get("minimum_text_chars", 2)),
        )
        if observed is None:
            if active and frame - active.last_frame > max_gap:
                flush()
            continue
        if active is None:
            active = ActiveCue(frame, frame, [observed])
            continue
        gap = observed.frame - active.last_frame
        if gap <= max_gap + 1 and text_similarity(
            active.representative_text, observed.text
        ) >= threshold:
            active.add(observed)
        else:
            flush()
            active = ActiveCue(frame, frame, [observed])
    flush()
    if not cues:
        raise RuntimeError("OCR produced no stable subtitle cues")
    if prevent_overlap and len(cues) > 1:
        cues.sort(key=lambda item: (int(item["start_frame"]), int(item["end_frame"])))
        for index, cue in enumerate(cues[:-1]):
            next_cue = cues[index + 1]
            limit = max(int(cue["start_frame"]) + 1, int(next_cue["start_frame"]) - min_gap_frames)
            if int(cue["end_frame"]) > limit:
                cue["end_frame"] = limit
    store.replace_cues(job_id, cues)
    return cues


def build_blur_regions(
    store: JobStore,
    job_id: str,
    *,
    media: dict[str, Any],
    ocr_config: dict[str, Any],
    tracking_config: dict[str, Any],
) -> list[dict[str, Any]]:
    target_fps = max(1, int(round(float(media.get("fps") or 30))))
    sample_fps = float(ocr_config.get("sample_fps", target_fps))
    sample_step = max(1, int(round(target_fps / sample_fps)))
    confidence = float(ocr_config["minimum_confidence"])
    minimum_text_chars = int(tracking_config.get("minimum_text_chars", 2))
    width = int(media["width"])
    height = int(media["height"])
    duration_frames = int(round(float(media["duration_seconds"]) * target_fps))
    regions: list[dict[str, Any]] = []

    for index, row in enumerate(store.iter_detections(job_id), start=1):
        raw_text = str(row["text"])
        if float(row.get("confidence") or 0.0) < confidence:
            continue
        if not contains_han(raw_text):
            continue
        if len(normalize_text(raw_text)) < minimum_text_chars:
            continue
        x1 = max(0, min(width, int(row["xmin"])))
        y1 = max(0, min(height, int(row["ymin"])))
        x2 = max(0, min(width, int(row["xmax"])))
        y2 = max(0, min(height, int(row["ymax"])))
        if x2 <= x1 or y2 <= y1:
            continue
        frame = int(row["frame_index"])
        regions.append(
            {
                "cue_index": index,
                "start_frame": max(0, frame - sample_step // 2),
                "end_frame": min(duration_frames, frame + sample_step + sample_step // 2),
                "xmin": x1,
                "ymin": y1,
                "xmax": x2,
                "ymax": y2,
                "source_text": raw_text,
            }
        )
    return regions


def build_static_blur_regions(
    store: JobStore,
    job_id: str,
    *,
    media: dict[str, Any],
    ocr_config: dict[str, Any],
    tracking_config: dict[str, Any],
) -> list[dict[str, Any]]:
    if not bool(tracking_config.get("static_blur_enabled", True)):
        return []
    target_fps = max(1, int(round(float(media.get("fps") or 30))))
    duration_frames = max(1, int(round(float(media["duration_seconds"]) * target_fps)))
    width = int(media["width"])
    height = int(media["height"])
    confidence = float(
        tracking_config.get("static_blur_min_confidence", ocr_config["minimum_confidence"])
    )
    minimum_text_chars = int(tracking_config.get("minimum_text_chars", 2))
    sample_frames = max(1, int(tracking_config.get("static_blur_sample_frames", 10)))
    ocr_sample_fps = float(ocr_config.get("sample_fps", target_fps))
    sample_step = max(1, int(round(target_fps / ocr_sample_fps)))
    targets = (
        [duration_frames // 2]
        if sample_frames == 1
        else [
            int(round(index * (duration_frames - 1) / (sample_frames - 1)))
            for index in range(sample_frames)
        ]
    )
    sampled_frame_indexes = {
        min(duration_frames - 1, (target // sample_step) * sample_step): sample_index
        for sample_index, target in enumerate(targets)
    }
    minimum_samples = min(
        len(sampled_frame_indexes),
        max(
            1,
            int(
                tracking_config.get(
                    "static_blur_min_samples",
                    tracking_config.get("static_blur_min_observations", 5),
                )
            ),
        ),
    )
    tolerance = max(1, int(tracking_config.get("static_blur_position_tolerance_px", 12)))
    min_y_ratio = float(tracking_config.get("static_blur_min_y_ratio", 0.0))
    max_y_ratio = float(tracking_config.get("static_blur_max_y_ratio", 1.0))
    min_y = height * min_y_ratio
    max_y = height * max_y_ratio
    subtitle_cues = store.cues(job_id)
    subtitle_padding = max(0, int(tracking_config.get("static_blur_subtitle_padding", 6)))
    subtitle_ymin = min((int(cue["ymin"]) for cue in subtitle_cues), default=height)
    subtitle_ymax = max((int(cue["ymax"]) for cue in subtitle_cues), default=-1)
    subtitle_ymin = max(0, subtitle_ymin - subtitle_padding)
    subtitle_ymax = min(height, subtitle_ymax + subtitle_padding)
    clusters: list[list[dict[str, Any]]] = []

    for row in store.iter_detections(job_id):
        raw_text = str(row["text"])
        if float(row.get("confidence") or 0.0) < confidence:
            continue
        if len(normalize_text(raw_text)) < minimum_text_chars:
            continue
        x1 = max(0, min(width, int(row["xmin"])))
        y1 = max(0, min(height, int(row["ymin"])))
        x2 = max(0, min(width, int(row["xmax"])))
        y2 = max(0, min(height, int(row["ymax"])))
        if x2 <= x1 or y2 <= y1:
            continue
        center_y = (y1 + y2) / 2
        if not (min_y <= center_y <= max_y):
            continue
        if subtitle_ymin <= center_y <= subtitle_ymax:
            continue
        frame = max(0, min(duration_frames - 1, int(row["frame_index"])))
        sample_index = sampled_frame_indexes.get(frame)
        if sample_index is None:
            continue
        observation = {
            "frame": frame,
            "sample_index": sample_index,
            "text": raw_text,
            "box": (x1, y1, x2, y2),
        }
        center_x = (x1 + x2) / 2
        matched: list[dict[str, Any]] | None = None
        for cluster in clusters:
            centers_x = [(item["box"][0] + item["box"][2]) / 2 for item in cluster]
            centers_y = [(item["box"][1] + item["box"][3]) / 2 for item in cluster]
            if (
                abs(center_x - median(centers_x)) <= tolerance
                and abs(center_y - median(centers_y)) <= tolerance
            ):
                matched = cluster
                break
        if matched is None:
            clusters.append([observation])
        else:
            matched.append(observation)

    regions: list[dict[str, Any]] = []
    for cluster in clusters:
        selected: dict[int, dict[str, Any]] = {}
        for observation in cluster:
            sample_index = int(observation["sample_index"])
            current = selected.get(sample_index)
            if current is None or int(observation["frame"]) < int(current["frame"]):
                selected[sample_index] = observation
        if len(selected) < minimum_samples:
            continue
        observations = list(selected.values())
        boxes = [item["box"] for item in observations]
        x1, y1, x2, y2 = [int(round(median(values))) for values in zip(*boxes)]
        if x2 <= x1 or y2 <= y1:
            continue
        frames = sorted(int(item["frame"]) for item in observations)
        text_counts = Counter(str(item["text"]) for item in observations)
        source_text = max(text_counts, key=lambda value: (text_counts[value], len(value)))
        regions.append(
            {
                "cue_index": 1_000_000 + len(regions) + 1,
                "kind": "static_blur",
                "start_frame": 0,
                "end_frame": duration_frames,
                "xmin": x1,
                "ymin": y1,
                "xmax": x2,
                "ymax": y2,
                "source_text": source_text,
                "normalized_text": normalize_text(source_text),
                "observations": len(observations),
                "sample_frames": sample_frames,
                "sample_indexes": sorted(selected),
                "first_frame": frames[0],
                "last_frame": frames[-1],
            }
        )
    return regions


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def wrap_two_lines(text: str, max_chars: int = 38) -> str:
    compact = " ".join(text.split())
    if len(compact) <= max_chars:
        return compact
    words = compact.split()
    if len(words) == 1:
        midpoint = len(compact) // 2
        return compact[:midpoint].rstrip() + "\n" + compact[midpoint:].lstrip()
    best = min(
        range(1, len(words)),
        key=lambda index: abs(
            len(" ".join(words[:index])) - len(" ".join(words[index:]))
        ),
    )
    return " ".join(words[:best]) + "\n" + " ".join(words[best:])


def write_srt(
    path: Path,
    cues: Iterable[dict[str, Any]],
    *,
    fps: int,
    target: bool = False,
) -> None:
    blocks = []
    for cue in cues:
        text = cue.get("target_text") if target else cue.get("source_text")
        if not text:
            raise RuntimeError(f"Cue {cue['cue_index']} has no {'target' if target else 'source'} text")
        if target:
            text = wrap_two_lines(str(text))
        blocks.append(
            "\n".join(
                (
                    str(cue["cue_index"]),
                    f"{srt_timestamp(int(cue['start_frame']) / fps)} --> "
                    f"{srt_timestamp(int(cue['end_frame']) / fps)}",
                    str(text),
                )
            )
        )
    atomic_write_text(path, "\n\n".join(blocks) + "\n")


def parse_srt(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    results = []
    pattern = re.compile(
        r"(?ms)^\s*(\d+)\s*\n"
        r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+"
        r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n"
        r"(.*?)(?=\n\s*\n|\Z)"
    )
    for match in pattern.finditer(text):
        numbers = [int(value) for value in match.groups()[1:9]]
        start = numbers[0] * 3600 + numbers[1] * 60 + numbers[2] + numbers[3] / 1000
        end = numbers[4] * 3600 + numbers[5] * 60 + numbers[6] + numbers[7] / 1000
        results.append(
            {
                "index": int(match.group(1)),
                "start": start,
                "end": end,
                "text": " ".join(match.group(10).split()),
            }
        )
    return results


