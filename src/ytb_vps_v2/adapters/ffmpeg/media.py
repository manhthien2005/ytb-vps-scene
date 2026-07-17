from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import threading
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId
from ytb_vps_v2.domain.pipeline import MediaDocument, RenderPlanDocument
from ytb_vps_v2.domain.timeline import Timeline


class FfmpegMediaError(RuntimeError):
    """Raised when FFmpeg media work cannot be completed or verified."""


@dataclass(slots=True)
class _Capture:
    limit: int
    raw: bytearray
    truncated: bool = False

    def consume(self, pipe: object) -> None:
        while True:
            chunk = pipe.read(8192)  # type: ignore[attr-defined]
            if not chunk:
                return
            available = self.limit - len(self.raw)
            if available > 0:
                self.raw.extend(chunk[:available])
            if len(chunk) > available:
                self.truncated = True

    def text(self) -> str:
        value = bytes(self.raw).decode("utf-8", errors="replace").strip()
        if self.truncated:
            suffix = "[output truncated]"
            return f"{value}\n{suffix}" if value else suffix
        return value


class FfmpegMediaAdapter:
    def __init__(
        self,
        *,
        ffmpeg: str = "ffmpeg",
        ffprobe: str = "ffprobe",
        fixture_timeout_seconds: float = 120.0,
        probe_timeout_seconds: float = 30.0,
        render_timeout_seconds: float = 120.0,
        decode_timeout_seconds: float = 120.0,
        diagnostic_limit: int = 4096,
        probe_output_limit: int = 65536,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.fixture_timeout_seconds = fixture_timeout_seconds
        self.probe_timeout_seconds = probe_timeout_seconds
        self.render_timeout_seconds = render_timeout_seconds
        self.decode_timeout_seconds = decode_timeout_seconds
        self.diagnostic_limit = diagnostic_limit
        self.probe_output_limit = probe_output_limit

    def require_tools(self) -> None:
        missing = tuple(
            executable
            for executable in (self.ffmpeg, self.ffprobe)
            if shutil.which(executable) is None
        )
        if missing:
            raise FfmpegMediaError(
                "Required media executable is unavailable: " + ", ".join(missing)
            )

    def _run(
        self,
        arguments: list[str],
        *,
        timeout: float,
        stdout_limit: int,
    ) -> bytes:
        stdout_capture = _Capture(stdout_limit, bytearray())
        stderr_capture = _Capture(self.diagnostic_limit, bytearray())
        try:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
            )
        except (OSError, ValueError) as exc:
            raise FfmpegMediaError("Media executable could not be started") from exc
        if process.stdout is None or process.stderr is None:
            process.kill()
            process.wait(timeout=timeout)
            raise FfmpegMediaError("Media executable pipes were unavailable")
        readers = (
            threading.Thread(
                target=stdout_capture.consume,
                args=(process.stdout,),
                daemon=True,
            ),
            threading.Thread(
                target=stderr_capture.consume,
                args=(process.stderr,),
                daemon=True,
            ),
        )
        for reader in readers:
            reader.start()
        try:
            return_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                pass
            if self._join_readers(readers, timeout):
                process.stdout.close()
                process.stderr.close()
            detail = stderr_capture.text()
            message = "Media executable timed out"
            if detail:
                message = f"{message}: {detail}"
            raise FfmpegMediaError(message) from exc
        if not self._join_readers(readers, timeout):
            raise FfmpegMediaError("Media executable output pipes timed out")
        process.stdout.close()
        process.stderr.close()
        if return_code != 0:
            detail = stderr_capture.text()
            message = f"Media executable exited with status {return_code}"
            if detail:
                message = f"{message}: {detail}"
            raise FfmpegMediaError(message)
        if stdout_capture.truncated:
            raise FfmpegMediaError("Media executable stdout exceeded the allowed limit")
        return bytes(stdout_capture.raw)

    @staticmethod
    def _join_readers(
        readers: tuple[threading.Thread, threading.Thread],
        timeout: float,
    ) -> bool:
        join_timeout = max(0.0, min(timeout, 1.0))
        for reader in readers:
            reader.join(timeout=join_timeout)
        return not any(reader.is_alive() for reader in readers)

    @staticmethod
    def _destination(destination: Path) -> Path:
        if not isinstance(destination, Path):
            raise FfmpegMediaError("Media destination must be a Path")
        if destination.exists() or destination.is_symlink():
            raise FfmpegMediaError("Media destination already exists")
        if not destination.parent.is_dir():
            raise FfmpegMediaError("Media destination parent must exist")
        return destination

    def create_fixture(self, destination: Path, with_audio: bool) -> None:
        if type(with_audio) is not bool:
            raise FfmpegMediaError("Fixture audio policy must be boolean")
        self.require_tools()
        output = self._destination(destination)
        arguments = [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-n",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=30",
        ]
        if with_audio:
            arguments.extend(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=30",
                ]
            )
        arguments.extend(
            [
                "-map",
                "0:v:0",
                "-frames:v",
                "900",
                "-fps_mode",
                "cfr",
                "-r",
                "30",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-threads:v",
                "1",
                "-g",
                "60",
                "-keyint_min",
                "60",
                "-sc_threshold",
                "0",
                "-x264-params",
                "threads=1:lookahead_threads=1:sliced_threads=0",
                "-map_metadata",
                "-1",
                "-metadata",
                "creation_time=2000-01-01T00:00:00Z",
            ]
        )
        if with_audio:
            arguments.extend(
                [
                    "-map",
                    "1:a:0",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "-threads:a",
                    "1",
                ]
            )
        else:
            arguments.append("-an")
        arguments.extend(["-t", "30", "-movflags", "+faststart", str(output)])
        self._run(
            arguments,
            timeout=self.fixture_timeout_seconds,
            stdout_limit=self.diagnostic_limit,
        )

    @staticmethod
    def _digest(path: Path) -> FileDigest:
        hasher = hashlib.sha256()
        size = 0
        try:
            with path.open("rb") as reader:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    hasher.update(chunk)
        except OSError as exc:
            raise FfmpegMediaError("Media source could not be read") from exc
        return FileDigest(size, hasher.hexdigest())

    @staticmethod
    def _fraction(value: object, name: str) -> Fraction:
        if type(value) is not str or not value or value in {"0/0", "N/A"}:
            raise FfmpegMediaError(f"ffprobe {name} is invalid")
        try:
            result = Fraction(value)
        except (ValueError, ZeroDivisionError) as exc:
            raise FfmpegMediaError(f"ffprobe {name} is invalid") from exc
        if result <= 0:
            raise FfmpegMediaError(f"ffprobe {name} must be positive")
        return result

    @staticmethod
    def _positive_int(value: object, name: str) -> int:
        if type(value) is not str or not value.isascii() or not value.isdigit():
            raise FfmpegMediaError(f"ffprobe {name} is invalid")
        result = int(value)
        if result <= 0:
            raise FfmpegMediaError(f"ffprobe {name} must be positive")
        return result

    def probe(self, source: Path) -> MediaDocument:
        self.require_tools()
        if not isinstance(source, Path) or not source.is_file() or source.is_symlink():
            raise FfmpegMediaError("Media source must be a regular file")
        arguments = [
            self.ffprobe,
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            (
                "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,"
                "nb_read_frames,nb_frames,duration:format=duration"
            ),
            "-of",
            "json",
            str(source),
        ]
        raw = self._run(
            arguments,
            timeout=self.probe_timeout_seconds,
            stdout_limit=self.probe_output_limit,
        )
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FfmpegMediaError("ffprobe returned invalid JSON") from exc
        if type(payload) is not dict or type(payload.get("streams")) is not list:
            raise FfmpegMediaError("ffprobe JSON has an invalid shape")
        streams = payload["streams"]
        if any(type(item) is not dict for item in streams):
            raise FfmpegMediaError("ffprobe stream JSON has an invalid shape")
        videos = [item for item in streams if item.get("codec_type") == "video"]
        if len(videos) != 1:
            raise FfmpegMediaError("Media must contain exactly one video stream")
        video = videos[0]
        width = video.get("width")
        height = video.get("height")
        if type(width) is not int or width <= 0 or type(height) is not int or height <= 0:
            raise FfmpegMediaError("ffprobe video dimensions are invalid")
        rate_value = video.get("avg_frame_rate")
        if rate_value in (None, "0/0", "N/A"):
            rate_value = video.get("r_frame_rate")
        fps = self._fraction(rate_value, "frame rate")
        frames_value = video.get("nb_read_frames")
        if frames_value in (None, "N/A"):
            frames_value = video.get("nb_frames")
        frame_count = self._positive_int(frames_value, "frame count")
        duration = Fraction(frame_count, 1) / fps
        format_value = payload.get("format")
        declared_value = None
        if type(format_value) is dict:
            declared_value = format_value.get("duration")
        if declared_value in (None, "N/A"):
            declared_value = video.get("duration")
        if declared_value not in (None, "N/A"):
            declared_duration = self._fraction(declared_value, "duration")
            if abs(declared_duration - duration) > Fraction(1, 1) / fps:
                raise FfmpegMediaError(
                    "ffprobe duration differs from frame evidence by more than one frame"
                )
        digest = self._digest(source)
        try:
            return MediaDocument(
                1,
                JobId("offline-job"),
                PurePosixPath("inputs") / source.name,
                digest,
                duration,
                fps,
                Timeline(30),
                frame_count,
                width,
                height,
                any(item.get("codec_type") == "audio" for item in streams),
            )
        except DomainInvariantError as exc:
            raise FfmpegMediaError("Media is not the canonical offline format") from exc

    @staticmethod
    def _matches_plan(media: MediaDocument, plan: RenderPlanDocument) -> bool:
        return (
            media.source_digest == plan.media_digest
            and media.frame_count == plan.frame_count
            and media.width == plan.width
            and media.height == plan.height
        )

    def render(
        self,
        source: Path,
        tts_wav: Path,
        plan: RenderPlanDocument,
        destination: Path,
    ) -> MediaDocument:
        if type(plan) is not RenderPlanDocument:
            raise FfmpegMediaError("Render plan must be a RenderPlanDocument")
        source_media = self.probe(source)
        if not self._matches_plan(source_media, plan):
            raise FfmpegMediaError("Render source does not match the typed render plan")
        if not isinstance(tts_wav, Path) or not tts_wav.is_file() or tts_wav.is_symlink():
            raise FfmpegMediaError("Render TTS input must be a regular file")
        if self._digest(tts_wav) != plan.tts_audio_digest:
            raise FfmpegMediaError("Render TTS input does not match the typed render plan")
        output = self._destination(destination)
        arguments = [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-n",
            "-i",
            str(source),
        ]
        if plan.output_has_audio:
            arguments.extend(["-i", str(tts_wav)])
        arguments.extend(
            [
                "-map",
                "0:v:0",
                "-vf",
                "fps=30,scale=320:180:flags=bicubic,format=yuv420p",
                "-frames:v",
                "900",
                "-fps_mode",
                "cfr",
                "-r",
                "30",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-threads:v",
                "1",
                "-g",
                "60",
                "-keyint_min",
                "60",
                "-sc_threshold",
                "0",
                "-x264-params",
                "threads=1:lookahead_threads=1:sliced_threads=0",
            ]
        )
        if plan.output_has_audio:
            arguments.extend(
                [
                    "-map",
                    "1:a:0",
                    "-af",
                    "apad=whole_dur=30",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "-threads:a",
                    "1",
                ]
            )
        else:
            arguments.append("-an")
        arguments.extend(
            [
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-metadata",
                "creation_time=2000-01-01T00:00:00Z",
                "-metadata",
                "encoder=ytb-vps-v2",
                "-t",
                "30",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )
        encoded = False
        try:
            self._run(
                arguments,
                timeout=self.render_timeout_seconds,
                stdout_limit=self.diagnostic_limit,
            )
            encoded = True
            return self.validate_render(output, plan)
        except BaseException:
            if encoded:
                try:
                    output.unlink(missing_ok=True)
                except OSError:
                    pass
            raise

    def validate_render(
        self,
        path: Path,
        expected: RenderPlanDocument,
    ) -> MediaDocument:
        if type(expected) is not RenderPlanDocument:
            raise FfmpegMediaError("Expected render identity must be a RenderPlanDocument")
        if not isinstance(path, Path) or not path.is_file() or path.is_symlink():
            raise FfmpegMediaError("Rendered media must be a regular file")
        decode_arguments = [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-xerror",
            "-nostdin",
            "-i",
            str(path),
            "-map",
            "0",
        ]
        decode_arguments.extend(["-f", "null", "-"])
        self._run(
            decode_arguments,
            timeout=self.decode_timeout_seconds,
            stdout_limit=self.diagnostic_limit,
        )
        actual = self.probe(path)
        expected_duration = Fraction(expected.frame_count, 30)
        if actual.width != expected.width or actual.height != expected.height:
            raise FfmpegMediaError("Rendered media dimensions do not match the plan")
        if actual.source_fps != Fraction(30):
            raise FfmpegMediaError("Rendered media frame rate is not canonical")
        if abs(actual.duration_seconds - expected_duration) > Fraction(1, 30):
            raise FfmpegMediaError("Rendered media duration differs by more than one frame")
        if actual.frame_count != expected.frame_count:
            raise FfmpegMediaError("Rendered media frame count does not match the plan")
        if actual.has_audio is not expected.output_has_audio:
            raise FfmpegMediaError("Rendered media audio policy does not match the plan")
        return actual
