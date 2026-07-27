# src/ytb_vps_v2/adapters/ffmpeg/probe.py
from __future__ import annotations

from fractions import Fraction

from ytb_vps_v2.domain.media_input import ColourProfile, FrameRateMode, InputManifest

_BIT_DEPTHS = {
    "yuv420p": 8, "yuvj420p": 8, "yuv422p": 8, "yuv444p": 8, "nv12": 8, "rgb24": 8,
    "yuv420p10le": 10, "yuv422p10le": 10, "yuv444p10le": 10, "p010le": 10,
    "yuv420p12le": 12,
}


class ProbeError(RuntimeError):
    """Raised when an ffprobe payload cannot be turned into an InputManifest."""


def _fraction(value: object, fallback: Fraction | None) -> Fraction:
    if not isinstance(value, str) or not value or value in {"0/0", "N/A"}:
        if fallback is None:
            raise ProbeError("ffprobe rational value is missing")
        return fallback
    try:
        result = Fraction(value)
    except (ValueError, ZeroDivisionError) as error:
        if fallback is None:
            raise ProbeError("ffprobe rational value is invalid") from error
        return fallback
    return result


def _rotation(stream: dict) -> int:
    for item in stream.get("side_data_list") or ():
        if isinstance(item, dict) and "rotation" in item:
            try:
                value = int(round(float(item["rotation"])))
            except (TypeError, ValueError):
                continue
            # FFmpeg reports the counter-clockwise display-matrix angle; the amount of
            # clockwise rotation actually applied on decode is its negation.
            return (-value) % 360
    return 0


def _is_attached_picture(stream: dict) -> bool:
    disposition = stream.get("disposition")
    return isinstance(disposition, dict) and bool(disposition.get("attached_pic"))


def _is_default(stream: dict) -> bool:
    disposition = stream.get("disposition")
    return isinstance(disposition, dict) and bool(disposition.get("default"))


def parse_probe_payload(
    payload: dict,
    *,
    duration_evidence_seconds: Fraction | None = None,
) -> InputManifest:
    if not isinstance(payload, dict) or not isinstance(payload.get("streams"), list):
        raise ProbeError("ffprobe payload has an invalid shape")
    streams = [item for item in payload["streams"] if isinstance(item, dict)]

    videos = [
        item for item in streams
        if item.get("codec_type") == "video" and not _is_attached_picture(item)
    ]
    if not videos:
        raise ProbeError("source has no moving video stream")
    video = next((item for item in videos if _is_default(item)), videos[0])

    audios = [item for item in streams if item.get("codec_type") == "audio"]
    chosen_audio = next((item for item in audios if _is_default(item)), audios[0] if audios else None)
    audio_index = None if chosen_audio is None else int(chosen_audio["index"])
    rejected = tuple(
        int(item["index"]) for item in audios if int(item["index"]) != audio_index
    )

    width, height = video.get("width"), video.get("height")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ProbeError("ffprobe video dimensions are invalid")

    real_rate = _fraction(video.get("r_frame_rate"), None)
    average_rate = _fraction(video.get("avg_frame_rate"), real_rate)
    # A container that reports a constant nominal rate but a materially different average
    # is variable in practice; 2% absorbs ordinary trailing-frame rounding.
    variable = abs(average_rate - real_rate) > real_rate * Fraction(2, 100)
    mode = FrameRateMode.VFR if variable else FrameRateMode.CFR

    aspect = _fraction(
        (video.get("sample_aspect_ratio") or "").replace(":", "/") or None, Fraction(1)
    )
    if aspect <= 0:
        aspect = Fraction(1)

    colour = ColourProfile(
        str(video.get("color_primaries") or "unknown"),
        str(video.get("color_transfer") or "unknown"),
        str(video.get("color_space") or "unknown"),
        str(video.get("color_range") or "unknown"),
        _BIT_DEPTHS.get(str(video.get("pix_fmt") or ""), 8),
    )

    container = payload.get("format")
    declared = container.get("duration") if isinstance(container, dict) else None
    if declared in (None, "N/A"):
        declared = video.get("duration")
    duration = duration_evidence_seconds
    if duration is None:
        duration = _fraction(None if declared in (None, "N/A") else str(declared), None)
    if duration <= 0:
        raise ProbeError("source duration must be positive")

    start = video.get("start_time")
    start_seconds = Fraction(0) if start in (None, "N/A") else _fraction(str(start), Fraction(0))

    return InputManifest(
        video_stream_index=int(video["index"]),
        audio_stream_index=audio_index,
        storage_width=width,
        storage_height=height,
        rotation_degrees=_rotation(video),
        sample_aspect_ratio=aspect,
        frame_rate=average_rate if variable else real_rate,
        frame_rate_mode=mode,
        colour=colour,
        start_time_seconds=start_seconds,
        duration_seconds=duration,
        rejected_audio_indexes=rejected,
        subtitle_stream_indexes=tuple(
            int(item["index"]) for item in streams if item.get("codec_type") == "subtitle"
        ),
    )
