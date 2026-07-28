from __future__ import annotations

from fractions import Fraction

from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import BoundingBox

# Measured with rapidocr against Chinese hardsub rendered at 24, 32, 44, 64 and 80 px:
# OCR stopped recovering the source text at 0.23-0.27 x glyph height. 0.30 is that
# ceiling plus a margin. Do not lower it without re-running the adversarial test.
MINIMUM_RADIUS_RATIO = Fraction(3, 10)


class RegionTooSmallError(DomainInvariantError):
    """The region cannot hold a radius strong enough to conceal its text.

    Raised instead of silently clamping: a blur that leaves the source readable
    is worse than a loud failure, because nobody checks the output frame by frame."""


def align_to_chroma_grid(box: BoundingBox, *, width: int, height: int) -> BoundingBox:
    """Snap a box outward onto the yuv420p 2x2 chroma grid.

    Outward, never inward: rounding in would leave a sliver of the original
    glyph outline exposed along the edge."""
    xmin = max(0, box.xmin - (box.xmin % 2))
    ymin = max(0, box.ymin - (box.ymin % 2))
    xmax = min(width, box.xmax + (box.xmax % 2))
    ymax = min(height, box.ymax + (box.ymax % 2))
    if xmax - xmin < 2 or ymax - ymin < 2:
        raise RegionTooSmallError("Blur region collapses when aligned to the chroma grid")
    return BoundingBox(xmin, ymin, xmax, ymax)


def blur_radii(region_width: int, region_height: int, glyph_height: int) -> tuple[int, int]:
    """Return (luma_radius, chroma_radius) for one boxblur pass.

    FFmpeg requires radius < min(plane_width, plane_height) / 2 on every plane, and
    rejects the WHOLE filter graph on violation, so the clamp is not a nicety."""
    if (
        not isinstance(region_width, int)
        or not isinstance(region_height, int)
        or region_width < 2
        or region_height < 2
    ):
        raise RegionTooSmallError("Blur region must be at least 2x2 pixels")
    if not isinstance(glyph_height, int) or glyph_height <= 0:
        raise DomainInvariantError("Glyph height must be a positive integer")

    needed = MINIMUM_RADIUS_RATIO * glyph_height
    wanted = -(-needed.numerator // needed.denominator)  # ceil, exactly, no float
    # A plane of size N admits radius < N/2 strictly. (N - 1) // 2 is that bound
    # exactly for both parities: N//2 - 1 for even N, N//2 for odd N. Deriving it
    # per-parity matters because an even region still yields an odd chroma plane
    # (a 1900x90 region has a 45px chroma dimension).
    luma_max = (min(region_width, region_height) - 1) // 2
    chroma_max = (min(-(-region_width // 2), -(-region_height // 2)) - 1) // 2
    if luma_max < 1:
        raise RegionTooSmallError(
            f"Blur region {region_width}x{region_height} admits no legal radius"
        )
    luma = min(wanted, luma_max)
    if luma < wanted:
        raise RegionTooSmallError(
            f"Blur region {region_width}x{region_height} caps the radius at {luma}, "
            f"but concealing {glyph_height}px glyphs needs {wanted}; grow the region"
        )
    chroma = max(0, min(luma // 2, chroma_max))
    return luma, chroma
