from __future__ import annotations

import io
import subprocess
import tempfile
import unittest
import wave
from fractions import Fraction
from pathlib import Path, PurePosixPath
from unittest.mock import patch

import ytb_vps_v2.adapters.filesystem as filesystem_adapters
import ytb_vps_v2.adapters.offline as offline_adapters
import ytb_vps_v2.ports as ports
from ytb_vps_v2.adapters.offline.capcut_tts import CapCutTtsProvider, _download_audio, _safe_audio_url
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


class CapCutProviderTests(unittest.TestCase):
    def _device_file(self, directory: Path) -> Path:
        path = directory / "device-001.json"
        path.write_text('{"device_id":"device","iid":"install","tdid":"trace"}', encoding="utf-8")
        return path

    def _wave_bytes(self) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(24_000)
            writer.writeframes(b"\x00\x00" * 240)
        return output.getvalue()

    def test_capcut_provider_uses_bv074_protocol_and_returns_canonical_tts_document(self) -> None:
        translation = DeterministicTranslationProvider(target_language="vi").translate(track())
        responses = iter([
            {"ret": "0", "data": {"tasks": [{"id": "task", "token": "token"}]}},
            {"ret": "0", "data": {"tasks": [{"status": "succeed", "payload": '{"audio":"https://v16m-default.tiktokcdn.com/audio.mp3"}'}]}},
        ])
        calls: list[tuple[str, object]] = []

        def request_json(url: str, body: object, device: object, timeout: float) -> dict[str, object]:
            calls.append((url, body))
            return next(responses)

        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            device = self._device_file(directory)
            wave_bytes = self._wave_bytes()

            def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
                self.assertIn("-ac", command)
                self.assertIn("1", command)
                self.assertIn("-ar", command)
                self.assertIn("24000", command)
                Path(command[-1]).write_bytes(wave_bytes)
                return subprocess.CompletedProcess(command, 0, b"", b"")

            with patch("ytb_vps_v2.adapters.offline.capcut_tts.subprocess.run", side_effect=fake_run):
                result = CapCutTtsProvider(
                    device_path=device,
                    device_pool_dir=directory / "missing",
                    request_json=request_json,
                    download_audio=lambda url: b"mp3" * 80,
                    resolve_audio_host=lambda host: ("93.184.216.34",),
                    query_interval_seconds=0,
                ).synthesize(translation)

        self.assertEqual(result.audio_bytes, wave_bytes)
        self.assertEqual(result.document.cues, translation.cues)
        self.assertEqual(result.document.audio_path, PurePosixPath("artifacts/tts/voice.wav"))
        self.assertEqual(result.document.audio_digest, digest(wave_bytes))
        self.assertIn("/lv/v1/common_task/new?", calls[0][0])
        self.assertIn("/lv/v1/common_task/query?", calls[1][0])
        self.assertIn("BV074_streaming", str(calls[0][1]))
        self.assertIn("7102355709945188865", str(calls[0][1]))

    def test_capcut_provider_rejects_missing_or_invalid_device_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as raw_directory:
            directory = Path(raw_directory)
            invalid = directory / "device.json"
            invalid.write_text('{"device_id":"device"}', encoding="utf-8")
            provider = CapCutTtsProvider(device_path=invalid, device_pool_dir=directory / "missing")
            with self.assertRaisesRegex(Exception, "credential is invalid"):
                provider.synthesize(DeterministicTranslationProvider(target_language="vi").translate(track()))

    def test_capcut_audio_url_safety_rejects_private_or_non_https_hosts(self) -> None:
        resolver = lambda host: ("93.184.216.34",)
        self.assertEqual(_safe_audio_url("https://v16m-default.tiktokcdn.com/audio.mp3", resolver), "https://v16m-default.tiktokcdn.com/audio.mp3")
        with self.assertRaisesRegex(Exception, "unsafe"):
            _safe_audio_url("http://v16m-default.tiktokcdn.com/audio.mp3", resolver)
        with self.assertRaisesRegex(Exception, "not allowed"):
            _safe_audio_url("https://example.com/audio.mp3", resolver)
        with self.assertRaisesRegex(Exception, "private"):
            _safe_audio_url("https://v16m-default.tiktokcdn.com/audio.mp3", lambda host: ("127.0.0.1",))

    def test_capcut_audio_download_pins_the_validated_dns_address(self) -> None:
        connections: list[tuple[str, str]] = []

        class Response:
            status = 200

            def read(self, _size: int) -> bytes:
                if hasattr(self, "done"):
                    return b""
                self.done = True
                return b"mp3" * 80

        class Connection:
            def request(self, method: str, path: str, headers: object) -> None:
                self.request_value = (method, path, headers)

            def getresponse(self) -> Response:
                return Response()

            def close(self) -> None:
                pass

        def connection_factory(hostname: str, address: str, timeout: float) -> Connection:
            connections.append((hostname, address))
            self.assertEqual(timeout, 10)
            return Connection()

        audio = _download_audio(
            "https://v16m-default.tiktokcdn.com/audio.mp3",
            timeout=10,
            max_bytes=1024,
            resolver=lambda _host: ("93.184.216.34",),
            connection_factory=connection_factory,
        )

        self.assertEqual(audio, b"mp3" * 80)
        self.assertEqual(connections, [("v16m-default.tiktokcdn.com", "93.184.216.34")])


if __name__ == "__main__":
    unittest.main()
