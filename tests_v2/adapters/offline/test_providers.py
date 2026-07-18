from __future__ import annotations

import io
import unittest
import wave
from fractions import Fraction
from pathlib import PurePosixPath

import ytb_vps_v2.adapters.filesystem as filesystem_adapters
import ytb_vps_v2.adapters.offline as offline_adapters
import ytb_vps_v2.ports as ports
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicOcrProvider,
    DeterministicTranslationProvider,
    DeterministicWaveTtsProvider,
)
from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import BlurRegion, JobId, RegionKind
from ytb_vps_v2.domain.pipeline import (
    MediaDocument,
    TrackDocument,
    canonical_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


def digest(byte: bytes) -> FileDigest:
    import hashlib

    return FileDigest(len(byte), hashlib.sha256(byte).hexdigest())


def media() -> MediaDocument:
    return MediaDocument(
        1,
        JobId("offline-job"),
        PurePosixPath("inputs/fixture.mp4"),
        FileDigest(12, "a" * 64),
        Fraction(30),
        Fraction(30),
        Timeline(30),
        900,
        320,
        180,
        True,
    )


def track() -> TrackDocument:
    source = media()
    ocr = DeterministicOcrProvider().detect(source)
    return TrackDocument(
        1,
        ocr.job_id,
        ocr.media_digest,
        ocr.frame_count,
        ocr.width,
        ocr.height,
        PurePosixPath("artifacts/ocr/ocr.json"),
        digest(canonical_document_bytes(ocr)),
        ocr.cues,
        (
            BlurRegion(
                RegionKind.STATIC,
                FrameInterval(ocr.cues[0].interval.start_frame, ocr.cues[0].interval.end_frame),
                ocr.cues[0].box,
            ),
        ),
    )


class DeterministicProviderTests(unittest.TestCase):
    def test_pipeline_ports_and_adapters_are_exported(self) -> None:
        for name in (
            "AdditiveObjectStore",
            "ArtifactWriter",
            "ArtifactWriterFactory",
            "ArtifactWriteError",
            "FileDigestVerifier",
            "MediaPipeline",
            "OcrProvider",
            "PartPublisher",
            "PartPublisherFactory",
            "ProviderError",
            "StateRepository",
            "StagedRestoreWorkspace",
            "TranslationProvider",
            "TtsProvider",
            "TtsSynthesis",
        ):
            self.assertTrue(hasattr(ports, name), name)
            self.assertIn(name, ports.__all__)
        self.assertIs(filesystem_adapters.LocalArtifactWriter, LocalArtifactWriter)
        for name in (
            "LocalArtifactWriterFactory",
            "LocalFileDigestVerifier",
            "LocalPartPublisherFactory",
        ):
            self.assertTrue(hasattr(filesystem_adapters, name), name)
        self.assertIs(
            offline_adapters.DeterministicOcrProvider,
            DeterministicOcrProvider,
        )

    def test_ocr_is_byte_identical_across_instances_and_frame_bounded(self) -> None:
        first = DeterministicOcrProvider().detect(media())
        second = DeterministicOcrProvider().detect(media())

        self.assertEqual(
            canonical_document_bytes(first),
            canonical_document_bytes(second),
        )
        self.assertEqual(tuple(cue.cue_index for cue in first.cues), (1, 2))
        self.assertTrue(
            all(
                0 <= cue.interval.start_frame < cue.interval.end_frame <= 900
                for cue in first.cues
            )
        )
        self.assertTrue(
            all(cue.box.xmax <= 320 and cue.box.ymax <= 180 for cue in first.cues)
        )

    def test_translation_preserves_cue_identity_order_and_is_config_deterministic(self) -> None:
        upstream = track()
        first = DeterministicTranslationProvider(target_language="vi").translate(upstream)
        second = DeterministicTranslationProvider(target_language="vi").translate(upstream)

        self.assertEqual(
            canonical_document_bytes(first),
            canonical_document_bytes(second),
        )
        self.assertEqual(
            tuple(
                (cue.cue_index, cue.interval, cue.box, cue.source_text)
                for cue in first.cues
            ),
            tuple(
                (cue.cue_index, cue.interval, cue.box, cue.source_text)
                for cue in upstream.cues
            ),
        )
        self.assertTrue(
            all(
                cue.target_text and cue.target_text.startswith("vi:")
                for cue in first.cues
            )
        )

    def test_tts_is_valid_byte_identical_pcm_wave_with_exact_cue_metadata(self) -> None:
        translation = DeterministicTranslationProvider(
            target_language="vi"
        ).translate(track())
        first = DeterministicWaveTtsProvider(sample_rate=8_000).synthesize(translation)
        second = DeterministicWaveTtsProvider(sample_rate=8_000).synthesize(translation)

        self.assertEqual(first.audio_bytes, second.audio_bytes)
        self.assertEqual(
            canonical_document_bytes(first.document),
            canonical_document_bytes(second.document),
        )
        self.assertEqual(first.document.cues, translation.cues)
        self.assertEqual(first.document.audio_digest, digest(first.audio_bytes))
        with wave.open(io.BytesIO(first.audio_bytes), "rb") as reader:
            self.assertEqual(reader.getnchannels(), 1)
            self.assertEqual(reader.getsampwidth(), 2)
            self.assertEqual(reader.getframerate(), 8_000)
            self.assertEqual(reader.getnframes(), 30 * 8_000)
            self.assertEqual(reader.getcomptype(), "NONE")


if __name__ == "__main__":
    unittest.main()
