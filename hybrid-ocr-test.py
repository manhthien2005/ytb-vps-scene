from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from statistics import median
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from rapidocr import RapidOCR

HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def run_json(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return json.loads(completed.stdout)


def probe_video(path: Path) -> dict[str, Any]:
    payload = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    video = next(item for item in payload["streams"] if item.get("codec_type") == "video")
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"
    if "/" in rate:
        left, right = rate.split("/", 1)
        fps = float(left) / max(1.0, float(right))
    else:
        fps = float(rate)
    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": fps,
        "duration": float(payload["format"]["duration"]),
    }


def build_engine() -> RapidOCR:
    engine = RapidOCR(
        params={
            "Global.use_cls": False,
            "EngineConfig.onnxruntime.use_cuda": True,
            "EngineConfig.onnxruntime.cuda_ep_cfg.device_id": 0,
            "EngineConfig.onnxruntime.intra_op_num_threads": 1,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    for name, session in {
        "det": engine.text_det.session.session,
        "rec": engine.text_rec.session.session,
    }.items():
        providers = session.get_providers()
        log(f"OCR {name} providers: {providers}")
    return engine


def contains_han(text: str) -> bool:
    return bool(HAN_RE.search(text))


def normalize_text(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE).casefold()


def text_similarity(left: str, right: str) -> float:
    import difflib

    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def srt_time(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(milliseconds, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(path: Path, cues: list[dict[str, Any]]) -> None:
    blocks = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            "\n".join(
                (
                    str(index),
                    f"{srt_time(cue['start'])} --> {srt_time(cue['end'])}",
                    cue["text"],
                )
            )
        )
    path.write_text("\n\n".join(blocks) + ("\n" if blocks else ""), encoding="utf-8")


def read_frame_at(path: Path, second: float) -> np.ndarray | None:
    with tempfile.TemporaryDirectory(prefix="ytb-hybrid-frame-") as temp_dir:
        frame = Path(temp_dir) / "frame.jpg"
        command = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{second:.3f}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(frame),
        ]
        if subprocess.run(command).returncode != 0:
            return None
        return cv2.imread(str(frame))


def parse_ocr_lines(
    result: Any,
    *,
    x_scale: float,
    y_scale: float,
    x_offset: float,
    y_offset: float,
) -> list[dict[str, Any]]:
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if boxes is None or texts is None:
        return []
    if scores is None:
        scores = [0.0] * len(texts)
    lines = []
    for points, text, confidence in zip(boxes, texts, scores):
        value = str(text or "").strip()
        if not value or not contains_han(value):
            continue
        array = np.asarray(points, dtype=np.float32)
        xs = array[:, 0] * x_scale + x_offset
        ys = array[:, 1] * y_scale + y_offset
        box = [
            int(max(0, xs.min())),
            int(max(0, ys.min())),
            int(xs.max()),
            int(ys.max()),
        ]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        lines.append({"text": value, "confidence": float(confidence), "box": box})
    return lines


def choose_subtitle_text(
    lines: list[dict[str, Any]], *, width: int, height: int, min_confidence: float
) -> dict[str, Any] | None:
    candidates = []
    for line in lines:
        box = line["box"]
        center_x = (box[0] + box[2]) / 2 / width
        center_y = (box[1] + box[3]) / 2 / height
        if line["confidence"] < min_confidence:
            continue
        if not 0.08 <= center_x <= 0.92:
            continue
        if center_y < 0.50:
            continue
        if len(normalize_text(line["text"])) < 2:
            continue
        candidates.append(line)
    if not candidates:
        return None
    candidates.sort(key=lambda item: ((item["box"][1] + item["box"][3]) / 2, item["box"][0]))
    clusters: list[list[dict[str, Any]]] = []
    for item in candidates:
        cy = (item["box"][1] + item["box"][3]) / 2
        if not clusters:
            clusters.append([item])
            continue
        last = clusters[-1]
        last_cy = np.median([(row["box"][1] + row["box"][3]) / 2 for row in last])
        if abs(cy - last_cy) <= max(10, height * 0.055):
            last.append(item)
        else:
            clusters.append([item])

    def score(cluster: list[dict[str, Any]]) -> tuple[float, float, int]:
        x1 = min(item["box"][0] for item in cluster)
        x2 = max(item["box"][2] for item in cluster)
        y2 = max(item["box"][3] for item in cluster)
        chars = sum(len(normalize_text(item["text"])) for item in cluster)
        conf = sum(item["confidence"] for item in cluster) / len(cluster)
        center_bonus = 1.0 - min(1.0, abs(((x1 + x2) / 2) - width / 2) / (width / 2))
        return (conf * 4 + min(chars, 30) / 30 + center_bonus + y2 / height, y2 / height, chars)

    best = sorted(max(clusters, key=score), key=lambda item: (item["box"][1], item["box"][0]))
    text = "".join(item["text"].strip() for item in best)
    return {
        "text": text,
        "confidence": sum(item["confidence"] for item in best) / len(best),
        "box": [
            min(item["box"][0] for item in best),
            min(item["box"][1] for item in best),
            max(item["box"][2] for item in best),
            max(item["box"][3] for item in best),
        ],
        "lines": best,
    }


def calibrate_band(
    input_path: Path,
    engine: RapidOCR,
    media: dict[str, Any],
    *,
    scan_width: int,
    padding: int,
    min_confidence: float,
) -> dict[str, Any]:
    width = int(media["width"])
    height = int(media["height"])
    duration = float(media["duration"])
    sample_times = []
    for second in [min(max(5.0, duration * 0.02), 60.0), duration * 0.15, duration * 0.35, duration * 0.60, duration * 0.85]:
        second = max(0.0, min(duration - 0.2, second))
        if second not in sample_times:
            sample_times.append(second)
    selected = []
    detections = []
    for second in sample_times:
        frame = read_frame_at(input_path, second)
        if frame is None:
            continue
        crop_y = int(height * 0.45)
        crop = frame[crop_y:height, :, :]
        scan_height = max(64, int(round(crop.shape[0] * scan_width / width)))
        scan_height -= scan_height % 2
        scan = cv2.resize(crop, (scan_width, scan_height), interpolation=cv2.INTER_AREA)
        result = engine(scan)
        lines = parse_ocr_lines(
            result,
            x_scale=width / scan_width,
            y_scale=crop.shape[0] / scan_height,
            x_offset=0,
            y_offset=crop_y,
        )
        chosen = choose_subtitle_text(lines, width=width, height=height, min_confidence=min_confidence)
        detections.extend([{**line, "sample_second": second} for line in lines])
        if chosen:
            chosen["sample_second"] = second
            selected.append(chosen)
    if selected:
        # Use median instead of extremes so one noisy OCR box does not make the
        # change detector watch animated background below/above the subtitles.
        y0 = max(0, int(round(median(item["box"][1] for item in selected))) - padding)
        y1 = min(height, int(round(median(item["box"][3] for item in selected))) + padding)
        mode = "detected"
    else:
        y0 = int(height * 0.78)
        y1 = int(height * 0.96)
        mode = "fallback"
    min_height = max(72, int(height * 0.11))
    if y1 - y0 < min_height:
        extra = min_height - (y1 - y0)
        y0 = max(0, y0 - extra // 2)
        y1 = min(height, y1 + extra - extra // 2)
    return {
        "mode": mode,
        "y0": int(y0),
        "y1": int(y1),
        "sample_times": sample_times,
        "selected": selected,
        "detections": detections[:100],
    }


def text_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Most source subtitles are white with a dark outline. HSV avoids treating
    # saturated highlights as subtitle glyphs.
    bright = cv2.inRange(hsv, np.array([0, 0, 168]), np.array([179, 105, 255]))
    width = bright.shape[1]
    margin = max(1, int(width * 0.05))
    bright[:, :margin] = 0
    bright[:, width - margin :] = 0
    kernel = np.ones((2, 2), np.uint8)
    mask = cv2.morphologyEx(bright, cv2.MORPH_OPEN, kernel)
    components, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    filtered = np.zeros_like(mask)
    frame_area = mask.shape[0] * mask.shape[1]
    for index in range(1, components):
        x, y, w, h, area = stats[index]
        if area < 4:
            continue
        if area > frame_area * 0.08:
            continue
        if w > width * 0.45:
            continue
        if h > mask.shape[0] * 0.85:
            continue
        filtered[labels == index] = 255
    return cv2.dilate(filtered, kernel, iterations=1)


def mask_signature(mask: np.ndarray) -> tuple[np.ndarray, float]:
    small = cv2.resize(mask, (96, 24), interpolation=cv2.INTER_AREA)
    binary = small > 32
    area = float(binary.mean())
    return binary, area


def signature_diff(left: np.ndarray | None, right: np.ndarray) -> float:
    if left is None:
        return 1.0
    return float(np.logical_xor(left, right).mean())


@dataclass
class CueBuilder:
    cues: list[dict[str, Any]] = field(default_factory=list)
    active_start: float | None = None
    active_end: float | None = None
    active_text: str = ""
    active_box: list[int] | None = None
    active_confidence: float = 0.0
    last_ocr_second: float = -9999.0

    def close(self, end: float) -> None:
        if self.active_start is None or not self.active_text:
            self.reset()
            return
        if end - self.active_start >= 0.35:
            self.cues.append(
                {
                    "start": max(0.0, self.active_start),
                    "end": max(self.active_start + 0.35, end),
                    "text": self.active_text,
                    "box": self.active_box,
                    "confidence": self.active_confidence,
                }
            )
        self.reset()

    def reset(self) -> None:
        self.active_start = None
        self.active_end = None
        self.active_text = ""
        self.active_box = None
        self.active_confidence = 0.0
        self.last_ocr_second = -9999.0

    def update(self, start: float, end: float, observation: dict[str, Any]) -> None:
        text = observation["text"]
        if self.active_start is None:
            self.active_start = start
            self.active_end = end
            self.active_text = text
            self.active_box = observation["box"]
            self.active_confidence = observation["confidence"]
            self.last_ocr_second = start
            return
        if text_similarity(self.active_text, text) >= 0.88:
            self.active_end = end
            if observation["confidence"] >= self.active_confidence:
                self.active_text = text
                self.active_box = observation["box"]
                self.active_confidence = observation["confidence"]
            self.last_ocr_second = start
        else:
            self.close(start)
            self.update(start, end, observation)


def ocr_crop(
    engine: RapidOCR,
    crop: np.ndarray,
    *,
    original_width: int,
    original_height: int,
    band_y0: int,
    scan_width: int,
    min_confidence: float,
) -> dict[str, Any] | None:
    scan_height = max(64, int(round(crop.shape[0] * scan_width / original_width)))
    scan_height -= scan_height % 2
    scan = cv2.resize(crop, (scan_width, scan_height), interpolation=cv2.INTER_AREA)
    result = engine(scan)
    lines = parse_ocr_lines(
        result,
        x_scale=original_width / scan_width,
        y_scale=crop.shape[0] / scan_height,
        x_offset=0,
        y_offset=band_y0,
    )
    return choose_subtitle_text(
        lines,
        width=original_width,
        height=original_height,
        min_confidence=min_confidence,
    )


def run_hybrid(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    media = probe_video(input_path)
    log(f"Input: {input_path.name} | {media['duration']:.2f}s | {media['width']}x{media['height']}")
    engine = build_engine()
    band = calibrate_band(
        input_path,
        engine,
        media,
        scan_width=args.scan_width,
        padding=args.band_padding,
        min_confidence=args.minimum_confidence,
    )
    log(f"Band: y={band['y0']}..{band['y1']} ({band['mode']})")

    width = int(media["width"])
    height = int(media["height"])
    band_h = int(band["y1"] - band["y0"])
    detect_width = int(args.detect_width)
    detect_height = max(32, int(round(band_h * detect_width / width)))
    detect_height -= detect_height % 2
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vf",
        (
            f"fps={args.detect_fps:.8f},"
            f"crop={width}:{band_h}:0:{band['y0']},"
            f"scale={detect_width}:{detect_height}"
        ),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    frame_size = detect_width * detect_height * 3
    cue_builder = CueBuilder()
    previous_signature: np.ndarray | None = None
    stable_signature: np.ndarray | None = None
    pending_start: float | None = None
    pending_seen = 0
    absent_frames = 0
    detect_frames = 0
    ocr_calls = 0
    low_confidence_retries = 0
    change_events = 0
    start_time = time.time()
    last_crop: np.ndarray | None = None

    while True:
        raw = process.stdout.read(frame_size)
        if not raw:
            break
        if len(raw) != frame_size:
            raise RuntimeError(f"Truncated frame: {len(raw)} of {frame_size}")
        second = detect_frames / args.detect_fps
        frame = np.frombuffer(raw, dtype=np.uint8).reshape((detect_height, detect_width, 3))
        mask = text_mask(frame)
        signature, area = mask_signature(mask)
        has_text = area >= args.min_mask_area
        diff = signature_diff(stable_signature, signature)
        if has_text:
            absent_frames = 0
            last_crop = cv2.resize(frame, (width, band_h), interpolation=cv2.INTER_CUBIC)
            if stable_signature is None or diff >= args.change_threshold:
                pending_start = second
                pending_seen = 0
                stable_signature = signature.copy()
                change_events += 1
            elif pending_start is not None:
                pending_seen += 1
            safety_due = (
                cue_builder.active_start is not None
                and second - cue_builder.last_ocr_second >= args.safety_interval
            )
            stable_due = (
                pending_start is not None
                and second - pending_start >= args.stable_delay
                and pending_seen >= args.min_stable_frames
            )
            if stable_due or safety_due:
                observation = ocr_crop(
                    engine,
                    last_crop,
                    original_width=width,
                    original_height=height,
                    band_y0=int(band["y0"]),
                    scan_width=args.scan_width,
                    min_confidence=args.minimum_confidence,
                )
                ocr_calls += 1
                if observation is None or observation["confidence"] < args.minimum_confidence:
                    low_confidence_retries += 1
                    observation = ocr_crop(
                        engine,
                        last_crop,
                        original_width=width,
                        original_height=height,
                        band_y0=int(band["y0"]),
                        scan_width=args.scan_width,
                        min_confidence=max(0.35, args.minimum_confidence - 0.15),
                    )
                    ocr_calls += 1
                if observation is not None:
                    start = pending_start if pending_start is not None else second
                    cue_builder.update(start, second + 1 / args.detect_fps, observation)
                pending_start = None
                pending_seen = 0
        else:
            absent_frames += 1
            pending_start = None
            pending_seen = 0
            if cue_builder.active_start is not None and absent_frames >= args.absent_frames_to_close:
                cue_builder.close(max(0.0, second - absent_frames / args.detect_fps))
            stable_signature = None
        previous_signature = signature
        detect_frames += 1
        if detect_frames == 1 or detect_frames % int(max(1, args.detect_fps * 30)) == 0:
            log(
                f"detect={detect_frames} time={second:.1f}s "
                f"events={change_events} ocr={ocr_calls} cues={len(cue_builder.cues)}"
            )

    if cue_builder.active_start is not None:
        cue_builder.close(float(media["duration"]))
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"FFmpeg failed: {stderr[-2000:]}")

    base = output_dir / input_path.stem
    srt_path = base.with_suffix(".hybrid.zh.srt")
    json_path = base.with_suffix(".hybrid.summary.json")
    write_srt(srt_path, cue_builder.cues)
    summary = {
        "input": str(input_path),
        "duration_seconds": media["duration"],
        "detect_fps": args.detect_fps,
        "detect_frames": detect_frames,
        "band": band,
        "ocr_calls": ocr_calls,
        "change_events": change_events,
        "low_confidence_retries": low_confidence_retries,
        "cues": cue_builder.cues,
        "srt": str(srt_path),
        "elapsed_seconds": time.time() - start_time,
        "fixed_0_5fps_ocr_calls": math.ceil(media["duration"] * 0.5),
    }
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"Wrote {srt_path}")
    log(f"Wrote {json_path}")
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--output-dir", default="/srv/ytb-vps/work/hybrid-ocr-test")
    parser.add_argument("--detect-fps", type=float, default=3.0)
    parser.add_argument("--detect-width", type=int, default=640)
    parser.add_argument("--scan-width", type=int, default=640)
    parser.add_argument("--minimum-confidence", type=float, default=0.62)
    parser.add_argument("--band-padding", type=int, default=22)
    parser.add_argument("--stable-delay", type=float, default=0.25)
    parser.add_argument("--safety-interval", type=float, default=10.0)
    parser.add_argument("--change-threshold", type=float, default=0.105)
    parser.add_argument("--min-mask-area", type=float, default=0.006)
    parser.add_argument("--min-stable-frames", type=int, default=1)
    parser.add_argument("--absent-frames-to-close", type=int, default=2)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    summary = run_hybrid(args)
    print(
        json.dumps(
            {
                "duration_seconds": summary["duration_seconds"],
                "detect_frames": summary["detect_frames"],
                "change_events": summary["change_events"],
                "ocr_calls": summary["ocr_calls"],
                "fixed_0_5fps_ocr_calls": summary["fixed_0_5fps_ocr_calls"],
                "cues": len(summary["cues"]),
                "elapsed_seconds": summary["elapsed_seconds"],
                "srt": summary["srt"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
