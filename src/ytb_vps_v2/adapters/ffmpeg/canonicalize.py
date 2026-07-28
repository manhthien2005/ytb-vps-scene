# src/ytb_vps_v2/adapters/ffmpeg/canonicalize.py
from __future__ import annotations

from dataclasses import dataclass

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.media_input import InputManifest


@dataclass(frozen=True, slots=True)
class CanvasSpec:
    """The one raster every stage after ingest works in.

    Even dimensions are not cosmetic: yuv420p subsamples chroma 2x2, so an odd
    canvas makes every crop rectangle ambiguous on the chroma plane."""

    width: int
    height: int
    target_fps: int

    def __post_init__(self) -> None:
        for name, value in (("Canvas width", self.width), ("Canvas height", self.height)):
            if not isinstance(value, int) or value <= 0:
                raise DomainInvariantError(f"{name} must be a positive integer")
            if value % 2:
                raise DomainInvariantError(f"{name} must be even")
        if not isinstance(self.target_fps, int) or self.target_fps <= 0:
            raise DomainInvariantError("Canvas target FPS must be a positive integer")


def _even(value: int) -> int:
    return max(2, value - (value % 2))


def plan_canvas(
    manifest: InputManifest, *, max_width: int, max_height: int, target_fps: int
) -> CanvasSpec:
    width, height = manifest.display_size
    # display_size has already applied rotation, so decide on the resulting shape,
    # never on rotation_degrees again. max_width/max_height describe a landscape
    # bounding box; a portrait canvas needs it transposed or the source is
    # pointlessly downscaled. Keying on shape means a natively-encoded 9:16 upload
    # and a rot90-tagged one get the identical canvas, which is the whole point of
    # having a single canonical space.
    if height > width and max_height < max_width:
        max_width, max_height = max_height, max_width
    scale = min(1.0, max_width / width, max_height / height)
    return CanvasSpec(_even(int(width * scale)), _even(int(height * scale)), target_fps)


def canonicalize_arguments(
    manifest: InputManifest,
    canvas: CanvasSpec,
    *,
    source: str,
    destination: str,
    ffmpeg: str = "ffmpeg",
) -> list[str]:
    filters: list[str] = []
    if manifest.colour.is_high_dynamic_range:
        # Tone-map in linear light, then land in BT.709. Without this an HDR source
        # is crushed to a dark, desaturated SDR frame by a bare format=yuv420p.
        filters.append(
            "zscale=transfer=linear:npl=100,"
            "tonemap=tonemap=hable:desat=0,"
            "zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited"
        )
    filters.append("setsar=1")
    filters.append(
        f"scale={canvas.width}:{canvas.height}:force_original_aspect_ratio=decrease:flags=bicubic"
    )
    filters.append(f"pad={canvas.width}:{canvas.height}:(ow-iw)/2:(oh-ih)/2:black")
    filters.append(f"fps={canvas.target_fps}")
    filters.append("setpts=PTS-STARTPTS")
    filters.append("format=yuv420p")

    arguments = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", source,
        "-map", f"0:{manifest.video_stream_index}",
    ]
    if manifest.audio_stream_index is None:
        arguments += ["-an"]
    else:
        arguments += ["-map", f"0:{manifest.audio_stream_index}"]
    arguments += ["-vf", ",".join(filters)]
    if manifest.audio_stream_index is not None:
        arguments += [
            "-af", "aresample=async=1:first_pts=0",
            "-c:a", "aac", "-ar", "48000", "-ac", "2",
        ]
    arguments += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-fps_mode", "cfr", "-r", str(canvas.target_fps),
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-colorspace", "bt709", "-color_range", "tv",
        # libx264 only writes VUI colour tags into the bitstream itself when told
        # via x264-params; the generic -color_* output options alone tag the
        # container but leave the encoded stream's color_transfer/primaries unset,
        # so ffprobe (and every downstream decoder) reads them back as unknown.
        "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-movflags", "+faststart",
        destination,
    ]
    return arguments
