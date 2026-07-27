from __future__ import annotations

import hashlib
import unittest
from fractions import Fraction
from pathlib import PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.domain.pipeline import (
    MediaDocument, canonical_document_bytes, parse_media_document_bytes,
)
from ytb_vps_v2.domain.timeline import Timeline

DIGEST = FileDigest(1024, hashlib.sha256(b"source").hexdigest())


def media(frame_count: int, *, target_fps: int = 30, duration: Fraction | None = None) -> MediaDocument:
    return MediaDocument(
        1, JobId("job-1"), PurePosixPath("inputs/source.mp4"), DIGEST,
        Fraction(frame_count, target_fps) if duration is None else duration,
        Fraction(target_fps), Timeline(target_fps), frame_count, 1920, 1080, True,
    )


class LongMediaTests(unittest.TestCase):
    def test_sixty_minutes_at_thirty_fps_is_accepted(self) -> None:
        document = media(108_000)
        self.assertEqual(document.frame_count, 108_000)
        self.assertEqual(document.duration_seconds, Fraction(3600))

    def test_a_single_frame_is_accepted(self) -> None:
        self.assertEqual(media(1).frame_count, 1)

    def test_zero_frames_is_rejected(self) -> None:
        with self.assertRaises(DomainInvariantError):
            media(0)

    def test_duration_must_equal_frames_over_target_fps(self) -> None:
        with self.assertRaises(DomainInvariantError):
            media(108_000, duration=Fraction(3599))

    def test_non_thirty_target_fps_is_accepted(self) -> None:
        document = media(6_000, target_fps=25)
        self.assertEqual(document.duration_seconds, Fraction(240))

    def test_long_document_round_trips_through_canonical_json(self) -> None:
        document = media(108_000)
        restored = parse_media_document_bytes(canonical_document_bytes(document))
        self.assertEqual(restored, document)


class RemovedConstantsTests(unittest.TestCase):
    def test_offline_constants_are_gone(self) -> None:
        import ytb_vps_v2.domain.pipeline as pipeline

        self.assertFalse(hasattr(pipeline, "OFFLINE_FRAME_COUNT"))
        self.assertFalse(hasattr(pipeline, "OFFLINE_DURATION_SECONDS"))
