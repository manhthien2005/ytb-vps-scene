from __future__ import annotations

import hashlib
import inspect
import os
import sys
import tempfile
import unittest
from io import BytesIO
from fractions import Fraction
from pathlib import Path, PurePosixPath
from subprocess import TimeoutExpired
from unittest import mock

import ytb_vps_v2.adapters.ffmpeg as ffmpeg_adapters
from ytb_vps_v2.adapters.ffmpeg import media as media_module
from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaAdapter
from ytb_vps_v2.adapters.ffmpeg.media import FfmpegMediaError
from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.offline.providers import (
    DeterministicOcrProvider,
    DeterministicTranslationProvider,
    DeterministicWaveTtsProvider,
)
from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.models import JobId, Part
from ytb_vps_v2.domain.pipeline import (
    OCR_ARTIFACT_PATH,
    TTS_ARTIFACT_PATH,
    MediaDocument,
    RenderRequest,
    TrackDocument,
    canonical_document_bytes,
)
from ytb_vps_v2.domain.timeline import FrameInterval, Timeline


def digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


@unittest.skipIf(os.name == "nt", "POSIX anonymous publication regression")
class PosixAnonymousPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.container = Path(self.temporary.name)
        self.root = self.container / "render-parent"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def anonymous_type(self) -> type:
        value = getattr(media_module, "_AnonymousPosixRender", None)
        self.assertIsNotNone(value, "POSIX render target must use an anonymous inode")
        return value

    def make_anonymous(
        self,
        stem: str,
    ) -> tuple[object, Path, bytes]:
        destination = self.root / f"{stem}.mp4"
        staging = self.anonymous_type().create(destination)
        raw = b"validated render bytes"
        os.write(staging.render_fd, raw)
        staging.verify(digest(raw))
        return staging, destination, raw

    def test_anonymous_failure_close_leaves_no_staging_entry_or_orphan(self) -> None:
        staging, destination, _ = self.make_anonymous("failed")
        descriptor_path = staging.fd_path
        self.assertEqual(tuple(self.root.iterdir()), ())
        self.assertTrue(descriptor_path.exists())

        staging.close()

        self.assertFalse(descriptor_path.exists())
        self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.root.iterdir()), ())

    def test_post_commit_failure_never_attempts_pathname_rollback(self) -> None:
        staging, destination, _ = self.make_anonymous("post-commit")
        try:
            with mock.patch.object(
                self.anonymous_type(),
                "_verify_published",
                side_effect=FfmpegMediaError("post-commit verification failure"),
            ):
                with mock.patch.object(media_module.os, "unlink") as unlink:
                    with self.assertRaisesRegex(FfmpegMediaError, "post-commit"):
                        staging.publish()
        finally:
            staging.cleanup()

        unlink.assert_not_called()
        self.assertTrue(destination.exists())

    def test_parent_path_replacement_cannot_redirect_anonymous_publication(self) -> None:
        staging, destination, raw = self.make_anonymous("parent-race")
        moved_parent = self.container / "moved-owned-parent"
        self.root.rename(moved_parent)
        self.root.mkdir()
        (self.root / "unowned.txt").write_bytes(b"racer")

        try:
            staging.publish()
        finally:
            staging.cleanup()

        self.assertEqual((moved_parent / destination.name).read_bytes(), raw)
        self.assertFalse((self.root / destination.name).exists())
        self.assertEqual((self.root / "unowned.txt").read_bytes(), b"racer")

    def test_destination_race_is_preserved_without_unowned_deletion(self) -> None:
        staging, destination, _ = self.make_anonymous("destination-race")
        destination.write_bytes(b"racer")

        try:
            with self.assertRaisesRegex(FfmpegMediaError, "already exists"):
                staging.publish()
        finally:
            staging.cleanup()

        self.assertEqual(destination.read_bytes(), b"racer")

    def test_linkat_unavailable_fails_before_render_process_or_destination(self) -> None:
        anonymous_type = self.anonymous_type()
        destination = self.root / "unsupported.mp4"
        source = self.root / "missing-source.mp4"
        tts_wav = self.root / "tts.wav"
        tts_wav.write_bytes(b"tts")
        value = digest(b"tts")
        plan = RenderRequest(
            1,
            JobId("anonymous-test"),
            value,
            900,
            320,
            180,
            TTS_ARTIFACT_PATH,
            value,
            (),
            (),
            PurePosixPath("artifacts/tts/audio.wav"),
            value,
            (Part(1, 1, FrameInterval(0, 900), (0,)),),
            False,
        )
        adapter = FfmpegMediaAdapter()

        with mock.patch.object(
            anonymous_type,
            "_preflight_linkat",
            side_effect=FfmpegMediaError("anonymous publication unavailable"),
        ), mock.patch.object(adapter, "_run") as run:
            with self.assertRaisesRegex(FfmpegMediaError, "unavailable"):
                adapter.render(source, tts_wav, plan, destination)

        run.assert_not_called()
        self.assertFalse(destination.exists())
        self.assertEqual(tuple(path.name for path in self.root.iterdir()), ("tts.wav",))

    def test_probe_inherits_anonymous_fd_and_hashes_exact_inode(self) -> None:
        staging, destination, raw = self.make_anonymous("probe")
        render_fd = staging.render_fd
        payload = (
            b'{"format":{"duration":"30.000000"},"streams":['
            b'{"avg_frame_rate":"30/1","codec_type":"video",'
            b'"height":180,"nb_read_frames":"900","width":320}]}'
        )
        adapter = FfmpegMediaAdapter()

        try:
            with mock.patch.object(adapter, "require_tools"), mock.patch.object(
                adapter,
                "_run",
                return_value=payload,
            ) as run:
                media = adapter.probe(
                    staging.fd_path,
                    pass_fds=(render_fd,),
                    logical_name=destination.name,
                )
        finally:
            staging.cleanup()

        self.assertEqual(media.source_digest, digest(raw))
        self.assertEqual(media.source_path.name, destination.name)
        self.assertEqual(run.call_args.kwargs["pass_fds"], (render_fd,))


class FfmpegFixtureProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.adapter = FfmpegMediaAdapter()
        self.adapter.require_tools()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def assert_canonical_media(
        self,
        media: MediaDocument,
        *,
        source_name: str,
        has_audio: bool,
    ) -> None:
        self.assertIs(type(media), MediaDocument)
        self.assertIs(type(media.job_id), JobId)
        self.assertEqual(media.source_path, PurePosixPath("inputs") / source_name)
        self.assertIs(type(media.source_digest), FileDigest)
        self.assertGreater(media.source_digest.size_bytes, 0)
        self.assertEqual(media.duration_seconds, Fraction(30))
        self.assertEqual(media.source_fps, Fraction(30))
        self.assertEqual(media.timeline, Timeline(30))
        self.assertEqual(media.frame_count, 900)
        self.assertEqual((media.width, media.height), (320, 180))
        self.assertIs(media.has_audio, has_audio)

    @staticmethod
    def semantic_identity(media: MediaDocument) -> tuple[object, ...]:
        return (
            media.duration_seconds,
            media.source_fps,
            media.timeline,
            media.frame_count,
            media.width,
            media.height,
            media.has_audio,
        )

    def test_adapter_is_exported(self) -> None:
        self.assertIs(ffmpeg_adapters.FfmpegMediaAdapter, FfmpegMediaAdapter)
        self.assertIn("FfmpegMediaAdapter", ffmpeg_adapters.__all__)

    def test_generates_and_probes_exact_audio_fixture(self) -> None:
        destination = self.root / "fixture-audio.mp4"

        self.adapter.create_fixture(destination, with_audio=True)
        media = self.adapter.probe(destination)

        self.assert_canonical_media(
            media,
            source_name=destination.name,
            has_audio=True,
        )

    def test_generates_and_probes_exact_no_audio_fixture(self) -> None:
        destination = self.root / "fixture-silent.mp4"

        self.adapter.create_fixture(destination, with_audio=False)
        media = self.adapter.probe(destination)

        self.assert_canonical_media(
            media,
            source_name=destination.name,
            has_audio=False,
        )

    def test_repeated_generation_has_the_same_semantic_identity(self) -> None:
        first_path = self.root / "first" / "fixture.mp4"
        second_path = self.root / "second" / "fixture.mp4"
        first_path.parent.mkdir()
        second_path.parent.mkdir()

        self.adapter.create_fixture(first_path, with_audio=True)
        self.adapter.create_fixture(second_path, with_audio=True)
        first = self.adapter.probe(first_path)
        second = self.adapter.probe(second_path)

        self.assertEqual(self.semantic_identity(first), self.semantic_identity(second))
        self.assertEqual(first.source_path, second.source_path)
        self.assertEqual(first.job_id, second.job_id)


class _FakeProcess:
    def __init__(
        self,
        *,
        stdout: bytes = b"",
        stderr: bytes = b"",
        return_code: int = 0,
        timeout: bool = False,
    ) -> None:
        self.stdout = BytesIO(stdout)
        self.stderr = BytesIO(stderr)
        self.return_code = return_code
        self.timeout = timeout
        self.killed = False
        self.wait_timeouts: list[float | None] = []

    def wait(self, timeout: float | None = None) -> int:
        self.wait_timeouts.append(timeout)
        if self.timeout and not self.killed:
            raise TimeoutExpired("fake-tool", timeout)
        return self.return_code

    def kill(self) -> None:
        self.killed = True


class _RecordingThread:
    instances: list[_RecordingThread] = []

    def __init__(self, *args: object, **kwargs: object) -> None:
        self.join_timeouts: list[float | None] = []
        self.__class__.instances.append(self)

    def start(self) -> None:
        return None

    def join(self, timeout: float | None = None) -> None:
        self.join_timeouts.append(timeout)

    def is_alive(self) -> bool:
        return False


class _StuckUntilPipeClosedThread(_RecordingThread):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.pipe = kwargs["args"][0]  # type: ignore[index]

    def is_alive(self) -> bool:
        return not self.pipe.closed


class FfmpegFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_render_consumes_pre_render_request_not_persisted_plan(self) -> None:
        self.assertEqual(
            FfmpegMediaAdapter.render.__annotations__["plan"],
            "RenderRequest",
        )
        self.assertEqual(
            FfmpegMediaAdapter.validate_render.__annotations__["expected"],
            "RenderRequest",
        )

    def test_require_tools_reports_all_missing_executables(self) -> None:
        adapter = FfmpegMediaAdapter(
            ffmpeg="missing-ffmpeg-for-v2-test",
            ffprobe="missing-ffprobe-for-v2-test",
        )

        with self.assertRaises(FfmpegMediaError) as raised:
            adapter.require_tools()

        self.assertIn("missing-ffmpeg-for-v2-test", str(raised.exception))
        self.assertIn("missing-ffprobe-for-v2-test", str(raised.exception))

    def test_process_uses_argument_array_no_shell_and_reports_nonzero(self) -> None:
        process = _FakeProcess(stderr=b"fatal diagnostic", return_code=7)
        adapter = FfmpegMediaAdapter()

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ) as popen:
            with self.assertRaises(FfmpegMediaError) as raised:
                adapter._run(
                    ["ffmpeg", "-version"],
                    timeout=3.0,
                    stdout_limit=128,
                )

        arguments, options = popen.call_args
        self.assertEqual(arguments[0], ["ffmpeg", "-version"])
        self.assertIs(options["shell"], False)
        self.assertEqual(process.wait_timeouts, [3.0])
        self.assertIn("status 7", str(raised.exception))
        self.assertIn("fatal diagnostic", str(raised.exception))

    @unittest.skipIf(os.name == "nt", "pass_fds is POSIX-only")
    def test_process_passes_only_explicit_anonymous_render_fd(self) -> None:
        adapter = FfmpegMediaAdapter()
        self.assertIn("pass_fds", inspect.signature(adapter._run).parameters)
        process = _FakeProcess()

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ) as popen:
            adapter._run(
                ["ffmpeg", "-version"],
                timeout=1.0,
                stdout_limit=32,
                pass_fds=(17,),
            )

        self.assertEqual(popen.call_args.kwargs["pass_fds"], (17,))

    @unittest.skipIf(os.name == "nt", "pass_fds is POSIX-only")
    def test_process_child_can_write_only_through_inherited_fd(self) -> None:
        adapter = FfmpegMediaAdapter()
        read_fd, write_fd = os.pipe()
        try:
            adapter._run(
                [
                    sys.executable,
                    "-c",
                    f"import os; os.write({write_fd}, b'inherited')",
                ],
                timeout=2.0,
                stdout_limit=32,
                pass_fds=(write_fd,),
            )
            os.close(write_fd)
            write_fd = -1
            self.assertEqual(os.read(read_fd, 32), b"inherited")
        finally:
            if write_fd >= 0:
                os.close(write_fd)
            os.close(read_fd)

    def test_process_timeout_kills_child_and_uses_bounded_diagnostics(self) -> None:
        adapter = FfmpegMediaAdapter(diagnostic_limit=64)
        process = _FakeProcess(stderr=b"x" * 10_000, timeout=True)

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ):
            with self.assertRaises(FfmpegMediaError) as raised:
                adapter._run(
                    ["ffmpeg", "-version"],
                    timeout=2.5,
                    stdout_limit=128,
                )

        message = str(raised.exception)
        self.assertTrue(process.killed)
        self.assertEqual(process.wait_timeouts, [2.5, 2.5])
        self.assertIn("timed out", message)
        self.assertIn("[output truncated]", message)
        self.assertLessEqual(len(message), 160)

    def test_process_rejects_stdout_beyond_explicit_bound(self) -> None:
        adapter = FfmpegMediaAdapter()
        process = _FakeProcess(stdout=b"j" * 1_000)

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "stdout"):
                adapter._run(
                    ["ffprobe", "input.mp4"],
                    timeout=1.0,
                    stdout_limit=32,
                )

    def test_process_pipe_failure_still_uses_bounded_wait(self) -> None:
        adapter = FfmpegMediaAdapter()
        process = _FakeProcess()
        process.stdout = None  # type: ignore[assignment]

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "pipes"):
                adapter._run(
                    ["ffprobe", "input.mp4"],
                    timeout=1.5,
                    stdout_limit=32,
                )

        self.assertTrue(process.killed)
        self.assertEqual(process.wait_timeouts, [1.5])

    def test_process_reader_joins_are_bounded(self) -> None:
        adapter = FfmpegMediaAdapter()
        process = _FakeProcess()
        _RecordingThread.instances.clear()

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            media_module.threading,
            "Thread",
            _RecordingThread,
        ):
            adapter._run(
                ["ffprobe", "input.mp4"],
                timeout=8.0,
                stdout_limit=32,
            )

        self.assertEqual(len(_RecordingThread.instances), 2)
        self.assertTrue(
            all(thread.join_timeouts == [1.0] for thread in _RecordingThread.instances)
        )

    def test_live_readers_force_pipe_close_and_receive_a_second_bounded_join(self) -> None:
        adapter = FfmpegMediaAdapter()
        process = _FakeProcess()
        _StuckUntilPipeClosedThread.instances.clear()

        with mock.patch.object(
            media_module.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            media_module.threading,
            "Thread",
            _StuckUntilPipeClosedThread,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "pipes"):
                adapter._run(
                    ["ffprobe", "input.mp4"],
                    timeout=8.0,
                    stdout_limit=32,
                )

        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)
        self.assertEqual(len(_StuckUntilPipeClosedThread.instances), 2)
        self.assertTrue(
            all(
                thread.join_timeouts == [1.0, 1.0]
                and not thread.is_alive()
                for thread in _StuckUntilPipeClosedThread.instances
            )
        )

    def test_probe_rejects_oversized_integer_without_leaking_value_error(self) -> None:
        with self.assertRaisesRegex(FfmpegMediaError, "frame count"):
            FfmpegMediaAdapter._positive_int("9" * 5_000, "frame count")

    def test_probe_wraps_invalid_ffprobe_json(self) -> None:
        source = self.root / "source.mp4"
        source.write_bytes(b"not inspected because output is injected")
        adapter = FfmpegMediaAdapter()

        with mock.patch.object(adapter, "require_tools"), mock.patch.object(
            adapter,
            "_run",
            return_value=b"{not-json",
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "invalid JSON"):
                adapter.probe(source)

    def test_probe_rejects_declared_duration_beyond_one_frame(self) -> None:
        source = self.root / "duration-mismatch.mp4"
        source.write_bytes(b"probe fixture")
        payload = (
            b'{"format":{"duration":"29.000000"},"streams":['
            b'{"avg_frame_rate":"30/1","codec_type":"video",'
            b'"height":180,"nb_read_frames":"900","width":320}]}'
        )
        adapter = FfmpegMediaAdapter()

        with mock.patch.object(adapter, "require_tools"), mock.patch.object(
            adapter,
            "_run",
            return_value=payload,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "duration"):
                adapter.probe(source)

    def test_semantic_job_identity_does_not_require_byte_identical_encoding(self) -> None:
        first = self.root / "first.mp4"
        second = self.root / "second.mp4"
        first.write_bytes(b"encoding from ffmpeg build one")
        second.write_bytes(b"encoding from ffmpeg build two")
        payload = (
            b'{"format":{"duration":"30.000000"},"streams":['
            b'{"avg_frame_rate":"30/1","codec_type":"video",'
            b'"height":180,"nb_read_frames":"900","width":320}]}'
        )
        adapter = FfmpegMediaAdapter()

        with mock.patch.object(adapter, "require_tools"), mock.patch.object(
            adapter,
            "_run",
            return_value=payload,
        ):
            first_media = adapter.probe(first)
            second_media = adapter.probe(second)

        self.assertNotEqual(first_media.source_digest, second_media.source_digest)
        self.assertEqual(first_media.job_id, second_media.job_id)
        self.assertEqual(
            FfmpegFixtureProbeTests.semantic_identity(first_media),
            FfmpegFixtureProbeTests.semantic_identity(second_media),
        )

    def test_fixture_command_fixes_no_overwrite_codec_metadata_and_threads(self) -> None:
        destination = self.root / "command.mp4"
        adapter = FfmpegMediaAdapter(fixture_timeout_seconds=44.0)

        with mock.patch.object(adapter, "require_tools"), mock.patch.object(
            adapter,
            "_run",
            return_value=b"",
        ) as run:
            adapter.create_fixture(destination, with_audio=False)

        arguments = run.call_args.args[0]
        self.assertIs(type(arguments), list)
        self.assertIn("-n", arguments)
        self.assertIn("libx264", arguments)
        self.assertIn("-map_metadata", arguments)
        self.assertIn("-threads:v", arguments)
        self.assertIn("-x264-params", arguments)
        self.assertEqual(run.call_args.kwargs["timeout"], 44.0)

    def test_existing_destination_is_rejected_without_overwrite(self) -> None:
        destination = self.root / "existing.mp4"
        destination.write_bytes(b"caller-owned")
        adapter = FfmpegMediaAdapter()

        with self.assertRaisesRegex(FfmpegMediaError, "already exists"):
            adapter.create_fixture(destination, with_audio=False)

        self.assertEqual(destination.read_bytes(), b"caller-owned")

    def test_failed_encode_does_not_delete_unproven_racing_destination(self) -> None:
        destination = self.root / "failed.mp4"
        adapter = FfmpegMediaAdapter()

        def fail_after_create(*args: object, **kwargs: object) -> bytes:
            destination.write_bytes(b"race winner")
            raise FfmpegMediaError("injected destination race")

        with mock.patch.object(adapter, "require_tools"), mock.patch.object(
            adapter,
            "_run",
            side_effect=fail_after_create,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "destination race"):
                adapter.create_fixture(destination, with_audio=False)

        self.assertEqual(destination.read_bytes(), b"race winner")


class FfmpegRenderValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.adapter = FfmpegMediaAdapter()
        cls.adapter.require_tools()
        cls.audio_source = cls.root / "source-audio.mp4"
        cls.silent_source = cls.root / "source-silent.mp4"
        cls.adapter.create_fixture(cls.audio_source, with_audio=True)
        cls.adapter.create_fixture(cls.silent_source, with_audio=False)
        cls.audio_media = cls.adapter.probe(cls.audio_source)
        cls.silent_media = cls.adapter.probe(cls.silent_source)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def make_plan(
        self,
        media: MediaDocument,
        *,
        output_has_audio: bool,
        stem: str,
    ) -> tuple[Path, RenderRequest]:
        ocr = DeterministicOcrProvider().detect(media)
        track = TrackDocument(
            ocr.schema_version,
            ocr.job_id,
            ocr.media_digest,
            ocr.frame_count,
            ocr.width,
            ocr.height,
            OCR_ARTIFACT_PATH,
            digest(canonical_document_bytes(ocr)),
            ocr.cues,
            (),
        )
        translation = DeterministicTranslationProvider().translate(track)
        synthesis = DeterministicWaveTtsProvider().synthesize(translation)
        tts_wav = self.root / f"{stem}.wav"
        tts_wav.write_bytes(synthesis.audio_bytes)
        plan = RenderRequest(
            synthesis.document.schema_version,
            synthesis.document.job_id,
            synthesis.document.media_digest,
            synthesis.document.frame_count,
            synthesis.document.width,
            synthesis.document.height,
            TTS_ARTIFACT_PATH,
            digest(canonical_document_bytes(synthesis.document)),
            synthesis.document.cues,
            track.blur_regions,
            synthesis.document.audio_path,
            synthesis.document.audio_digest,
            (Part(1, 1, FrameInterval(0, 900), (0,)),),
            output_has_audio,
        )
        return tts_wav, plan

    def assert_render_identity(
        self,
        media: MediaDocument,
        *,
        has_audio: bool,
    ) -> None:
        self.assertEqual(media.duration_seconds, Fraction(30))
        self.assertEqual(media.source_fps, Fraction(30))
        self.assertEqual(media.frame_count, 900)
        self.assertEqual((media.width, media.height), (320, 180))
        self.assertIs(media.has_audio, has_audio)

    def test_renders_audio_source_with_deterministic_tts_audio(self) -> None:
        tts_wav, plan = self.make_plan(
            self.audio_media,
            output_has_audio=True,
            stem="audio-source-tts",
        )
        destination = self.root / "render-audio-source.mp4"

        rendered = self.adapter.render(
            self.audio_source,
            tts_wav,
            plan,
            destination,
        )

        self.assertTrue(destination.is_file())
        self.assert_render_identity(rendered, has_audio=True)
        self.assertEqual(
            rendered,
            self.adapter.validate_render(destination, plan),
        )

    def test_renders_no_audio_source_with_deterministic_tts_audio(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=True,
            stem="silent-source-tts",
        )
        destination = self.root / "render-silent-source.mp4"
        filter_graphs: list[str] = []
        subtitle_documents: list[str] = []
        run = self.adapter._run

        def capture_render_assets(
            arguments: list[str],
            **kwargs: object,
        ) -> bytes:
            if "-filter_complex_script" in arguments:
                script = Path(
                    arguments[arguments.index("-filter_complex_script") + 1]
                )
                filter_graphs.append(script.read_text(encoding="utf-8"))
                subtitle_documents.extend(
                    path.read_text(encoding="utf-8")
                    for path in script.parent.glob("*.ass")
                )
            return run(arguments, **kwargs)  # type: ignore[arg-type]

        with mock.patch.object(
            self.adapter,
            "_run",
            side_effect=capture_render_assets,
        ):
            rendered = self.adapter.render(
                self.silent_source,
                tts_wav,
                plan,
                destination,
            )

        self.assert_render_identity(rendered, has_audio=True)
        self.assertEqual(len(filter_graphs), 1)
        self.assertIn("subtitles=", filter_graphs[0])
        self.assertNotIn("[0:a]", filter_graphs[0])
        self.assertTrue(
            any("vi:OFFLINE CUE ONE" in document for document in subtitle_documents)
        )

    def test_output_audio_policy_can_explicitly_disable_audio(self) -> None:
        tts_wav, plan = self.make_plan(
            self.audio_media,
            output_has_audio=False,
            stem="disabled-tts",
        )
        destination = self.root / "render-without-audio.mp4"

        rendered = self.adapter.render(
            self.audio_source,
            tts_wav,
            plan,
            destination,
        )

        self.assert_render_identity(rendered, has_audio=False)

    def test_render_stays_caller_owned_until_artifact_writer_publishes(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="publication-tts",
        )
        staging = self.root / "caller-owned-render.mp4"
        workspace = self.root / "workspace"
        workspace.mkdir()

        self.adapter.render(self.silent_source, tts_wav, plan, staging)
        entry = LocalArtifactWriter(workspace).write_file(
            PurePosixPath("artifacts/render/output.mp4"),
            staging,
        )

        published = workspace / "artifacts" / "render" / "output.mp4"
        self.assertTrue(staging.is_file())
        self.assertTrue(published.is_file())
        self.assertEqual(entry.digest, self.adapter._digest(staging))
        staging.unlink()
        self.assertTrue(published.is_file())

    def make_video(
        self,
        destination: Path,
        *,
        size: str = "320x180",
        rate: int = 30,
        duration: int = 30,
    ) -> None:
        self.adapter._run(
            [
                self.adapter.ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-n",
                "-f",
                "lavfi",
                "-i",
                f"color=size={size}:rate={rate}:duration={duration}",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-threads:v",
                "1",
                "-an",
                str(destination),
            ],
            timeout=60.0,
            stdout_limit=4096,
        )

    def test_validation_rejects_truncated_and_malformed_outputs(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="corrupt-tts",
        )
        valid = self.root / "render-before-corruption.mp4"
        self.adapter.render(self.silent_source, tts_wav, plan, valid)
        raw = valid.read_bytes()
        truncated = self.root / "truncated.mp4"
        truncated.write_bytes(raw[: len(raw) // 2])
        malformed = self.root / "malformed.mp4"
        malformed.write_bytes(b"not an mp4")

        for path in (truncated, malformed):
            with self.subTest(path=path.name):
                with self.assertRaises(FfmpegMediaError):
                    self.adapter.validate_render(path, plan)

    def test_validation_rejects_wrong_duration_size_rate_and_non_video(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="invalid-shape-tts",
        )
        wrong_duration = self.root / "wrong-duration.mp4"
        wrong_size = self.root / "wrong-size.mp4"
        wrong_rate = self.root / "wrong-rate.mp4"
        self.make_video(wrong_duration, duration=29)
        self.make_video(wrong_size, size="640x360")
        self.make_video(wrong_rate, rate=25)

        for path in (wrong_duration, wrong_size, wrong_rate, tts_wav):
            with self.subTest(path=path.name):
                with self.assertRaises(FfmpegMediaError):
                    self.adapter.validate_render(path, plan)

    def test_full_decode_maps_every_output_stream(self) -> None:
        _, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="all-streams-tts",
        )

        with mock.patch.object(
            self.adapter,
            "_run",
            return_value=b"",
        ) as run, mock.patch.object(
            self.adapter,
            "probe",
            return_value=self.silent_media,
        ):
            self.adapter.validate_render(self.silent_source, plan)

        decode_arguments = run.call_args.args[0]
        map_index = decode_arguments.index("-map")
        self.assertEqual(decode_arguments[map_index + 1], "0")

    def test_render_rejects_conflict_and_cleans_failed_temporary_output(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="failure-tts",
        )
        conflict = self.root / "render-conflict.mp4"
        conflict.write_bytes(b"caller-owned")
        with self.assertRaisesRegex(FfmpegMediaError, "already exists"):
            self.adapter.render(self.silent_source, tts_wav, plan, conflict)
        self.assertEqual(conflict.read_bytes(), b"caller-owned")

        failed = self.root / "render-validation-failed.mp4"
        with mock.patch.object(
            self.adapter,
            "validate_render",
            side_effect=FfmpegMediaError("injected validation failure"),
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "injected validation"):
                self.adapter.render(self.silent_source, tts_wav, plan, failed)
        self.assertFalse(failed.exists())

    def test_nonzero_encode_cleans_owned_partial_private_output(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="partial-encode-tts",
        )
        destination = self.root / "partial-encode.mp4"

        def leave_partial(arguments: list[str], **kwargs: object) -> bytes:
            Path(arguments[-1]).write_bytes(b"partial ffmpeg output")
            raise FfmpegMediaError("injected nonzero encode")

        with mock.patch.object(
            self.adapter,
            "probe",
            return_value=self.silent_media,
        ), mock.patch.object(
            self.adapter,
            "_run",
            side_effect=leave_partial,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "nonzero encode"):
                self.adapter.render(self.silent_source, tts_wav, plan, destination)

        self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.root.glob(f".{destination.name}.*.render")), ())

    def test_validation_failure_never_deletes_racing_destination(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="validation-race-tts",
        )
        destination = self.root / "validation-race.mp4"

        def race_then_fail(path: Path, expected: RenderRequest) -> MediaDocument:
            destination.write_bytes(b"racing caller bytes")
            raise FfmpegMediaError("injected validation failure after race")

        with mock.patch.object(
            self.adapter,
            "validate_render",
            side_effect=race_then_fail,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "after race"):
                self.adapter.render(self.silent_source, tts_wav, plan, destination)

        self.assertEqual(destination.read_bytes(), b"racing caller bytes")
        self.assertEqual(tuple(self.root.glob(f".{destination.name}.*.render")), ())

    def test_publish_race_fails_no_replace_and_preserves_conflict(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="publish-race-tts",
        )
        destination = self.root / "publish-race.mp4"
        real_validate = self.adapter.validate_render

        def race_after_validation(
            path: Path,
            expected: RenderRequest,
        ) -> MediaDocument:
            validated = real_validate(path, expected)
            destination.write_bytes(b"published by racer")
            return validated

        with mock.patch.object(
            self.adapter,
            "validate_render",
            side_effect=race_after_validation,
        ):
            with self.assertRaisesRegex(FfmpegMediaError, "already exists"):
                self.adapter.render(self.silent_source, tts_wav, plan, destination)

        self.assertEqual(destination.read_bytes(), b"published by racer")
        self.assertEqual(tuple(self.root.glob(f".{destination.name}.*.render")), ())

    def test_private_source_replacement_cannot_publish_unvalidated_inode(self) -> None:
        tts_wav, plan = self.make_plan(
            self.silent_media,
            output_has_audio=False,
            stem="private-source-race-tts",
        )
        destination = self.root / "private-source-race.mp4"
        real_validate = self.adapter.validate_render

        def replace_after_validation(
            path: Path,
            expected: RenderRequest,
        ) -> MediaDocument:
            validated = real_validate(path, expected)
            displaced = path.with_name("validated-owned.mp4")
            try:
                path.replace(displaced)
                path.write_bytes(b"racer")
            except OSError as exc:
                raise FfmpegMediaError("private source replacement blocked") from exc
            return validated

        with mock.patch.object(
            self.adapter,
            "validate_render",
            side_effect=replace_after_validation,
        ):
            with self.assertRaises(FfmpegMediaError):
                self.adapter.render(self.silent_source, tts_wav, plan, destination)

        self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.root.glob(f".{destination.name}.*.render")), ())


if __name__ == "__main__":
    unittest.main()
