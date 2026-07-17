from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path, PurePosixPath
from typing import BinaryIO

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
        try:
            while True:
                chunk = pipe.read(8192)  # type: ignore[attr-defined]
                if not chunk:
                    return
                available = self.limit - len(self.raw)
                if available > 0:
                    self.raw.extend(chunk[:available])
                if len(chunk) > available:
                    self.truncated = True
        except (OSError, ValueError):
            return

    def text(self) -> str:
        value = bytes(self.raw).decode("utf-8", errors="replace").strip()
        if self.truncated:
            suffix = "[output truncated]"
            return f"{value}\n{suffix}" if value else suffix
        return value


@dataclass(slots=True)
class _OwnedRenderStaging:
    directory: Path
    directory_identity: tuple[int, int]
    output: Path
    output_identity: tuple[int, int] | None = None
    parent_fd: int | None = None
    directory_fd: int | None = None
    quarantine_reason: str | None = None

    @classmethod
    def create(cls, destination: Path) -> _OwnedRenderStaging:
        try:
            directory = Path(
                tempfile.mkdtemp(
                    prefix=f".{destination.name}.",
                    suffix=".render",
                    dir=destination.parent,
                )
            )
            status = os.stat(directory, follow_symlinks=False)
        except OSError as exc:
            raise FfmpegMediaError("Private render staging could not be created") from exc
        if not stat.S_ISDIR(status.st_mode):
            raise FfmpegMediaError("Private render staging is not a directory")
        staging = cls(
            directory,
            (status.st_dev, status.st_ino),
            directory / "output.mp4",
        )
        if os.name != "nt":
            staging._anchor_posix_parent(destination.parent)
        return staging

    def _anchor_posix_parent(self, parent: Path) -> None:
        parent_fd = -1
        directory_fd = -1
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            parent_fd = os.open(parent, flags)
            directory_fd = os.open(
                self.directory.name,
                flags,
                dir_fd=parent_fd,
            )
            status = os.fstat(directory_fd)
            if not stat.S_ISDIR(status.st_mode) or (
                status.st_dev,
                status.st_ino,
            ) != self.directory_identity:
                raise FfmpegMediaError("Private render staging identity changed")
            self.parent_fd = parent_fd
            self.directory_fd = directory_fd
        except BaseException:
            if directory_fd >= 0:
                os.close(directory_fd)
            if parent_fd >= 0:
                os.close(parent_fd)
            self.cleanup()
            raise

    def _owns_directory(self) -> bool:
        try:
            status = os.stat(self.directory, follow_symlinks=False)
        except OSError:
            return False
        return (
            stat.S_ISDIR(status.st_mode)
            and (status.st_dev, status.st_ino) == self.directory_identity
        )

    def claim_output(self) -> tuple[int, int]:
        if not self._owns_directory():
            raise FfmpegMediaError("Private render staging identity changed")
        try:
            status = os.stat(self.output, follow_symlinks=False)
        except OSError as exc:
            raise FfmpegMediaError("FFmpeg did not create a render output") from exc
        if not stat.S_ISREG(status.st_mode):
            raise FfmpegMediaError("FFmpeg render output is not a regular file")
        self.output_identity = (status.st_dev, status.st_ino)
        return self.output_identity

    def pin(self, destination: Path) -> _PinnedRenderSource:
        identity = self.output_identity or self.claim_output()
        if os.name == "nt":
            return _WindowsPinnedRenderSource.create(self, destination, identity)
        return _PosixPinnedRenderSource.create(self, destination, identity)

    def cleanup(self) -> None:
        if os.name != "nt" and self.parent_fd is not None:
            self._cleanup_posix_anchored()
            return
        if not self._owns_directory():
            return
        try:
            status = os.stat(self.output, follow_symlinks=False)
        except FileNotFoundError:
            pass
        except OSError:
            return
        else:
            identity = (status.st_dev, status.st_ino)
            if stat.S_ISREG(status.st_mode) and (
                self.output_identity is None or identity == self.output_identity
            ):
                try:
                    self.output.unlink()
                except OSError:
                    return
            else:
                return
        try:
            self.directory.rmdir()
        except OSError:
            pass

    def _cleanup_posix_anchored(self) -> None:
        parent_fd = self.parent_fd
        directory_fd = self.directory_fd
        self.parent_fd = None
        self.directory_fd = None
        if parent_fd is None or directory_fd is None:
            self.quarantine_reason = "POSIX render cleanup anchors are incomplete"
            return
        try:
            directory_status = os.fstat(directory_fd)
            if not stat.S_ISDIR(directory_status.st_mode) or (
                directory_status.st_dev,
                directory_status.st_ino,
            ) != self.directory_identity:
                self.quarantine_reason = "Pinned render staging identity changed"
                return
            try:
                os.fchmod(directory_fd, 0o700)
            except OSError:
                self.quarantine_reason = "Pinned render staging is not writable"
                return
            if not self._unlink_owned_output_at(directory_fd):
                return
            self._remove_owned_directory_entry(parent_fd, directory_fd)
        finally:
            os.close(directory_fd)
            os.close(parent_fd)

    def _unlink_owned_output_at(self, directory_fd: int) -> bool:
        try:
            status = os.stat(
                self.output.name,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return True
        except OSError:
            self.quarantine_reason = "Pinned render output could not be inspected"
            return False
        identity = (status.st_dev, status.st_ino)
        if (
            not stat.S_ISREG(status.st_mode)
            or self.output_identity is not None
            and identity != self.output_identity
        ):
            self.quarantine_reason = "Pinned render output identity changed"
            return False
        output_fd = -1
        try:
            output_fd = os.open(
                self.output.name,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=directory_fd,
            )
            opened_status = os.fstat(output_fd)
            current_status = os.stat(
                self.output.name,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
            if (
                not stat.S_ISREG(opened_status.st_mode)
                or (opened_status.st_dev, opened_status.st_ino) != identity
                or (current_status.st_dev, current_status.st_ino) != identity
            ):
                self.quarantine_reason = "Pinned render output recheck failed"
                return False
            os.chmod(
                self.output.name,
                0o600,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
            os.unlink(self.output.name, dir_fd=directory_fd)
            return True
        except OSError:
            self.quarantine_reason = "Pinned render output cleanup failed"
            return False
        finally:
            if output_fd >= 0:
                os.close(output_fd)

    def _remove_owned_directory_entry(
        self,
        parent_fd: int,
        directory_fd: int,
    ) -> None:
        names = [self.directory.name]
        try:
            discovered = os.listdir(parent_fd)
        except OSError:
            self.quarantine_reason = "Render parent could not be rescanned"
            return
        if len(discovered) > 4096:
            self.quarantine_reason = "Render parent rescan exceeded its bound"
            return
        names.extend(sorted(name for name in discovered if name not in names))
        expected = self.directory_identity
        for name in names:
            candidate_fd = -1
            try:
                status = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if not stat.S_ISDIR(status.st_mode) or (
                    status.st_dev,
                    status.st_ino,
                ) != expected:
                    continue
                candidate_fd = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=parent_fd,
                )
                opened_status = os.fstat(candidate_fd)
                pinned_status = os.fstat(directory_fd)
                current_status = os.stat(
                    name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
                identities = {
                    (opened_status.st_dev, opened_status.st_ino),
                    (pinned_status.st_dev, pinned_status.st_ino),
                    (current_status.st_dev, current_status.st_ino),
                }
                if identities != {expected} or os.listdir(candidate_fd):
                    self.quarantine_reason = (
                        "Owned render staging could not be removed safely"
                    )
                    return
                os.rmdir(name, dir_fd=parent_fd)
                self.quarantine_reason = None
                return
            except (FileNotFoundError, NotADirectoryError):
                continue
            except OSError:
                self.quarantine_reason = "Owned render staging cleanup failed"
                return
            finally:
                if candidate_fd >= 0:
                    os.close(candidate_fd)
        self.quarantine_reason = "Owned render staging entry was not found"


class _PinnedRenderSource:
    def verify(self, expected: FileDigest) -> None:
        raise NotImplementedError

    def publish(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


def _digest_reader(reader: BinaryIO) -> FileDigest:
    hasher = hashlib.sha256()
    size = 0
    reader.seek(0)
    while True:
        chunk = reader.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        hasher.update(chunk)
    reader.seek(0)
    return FileDigest(size, hasher.hexdigest())


@dataclass(slots=True)
class _PosixPinnedRenderSource(_PinnedRenderSource):
    staging: _OwnedRenderStaging
    destination: Path
    source_fd: int
    parent_fd: int
    staging_fd: int
    identity: tuple[int, int]
    expected_digest: FileDigest | None = None

    @classmethod
    def create(
        cls,
        staging: _OwnedRenderStaging,
        destination: Path,
        identity: tuple[int, int],
    ) -> _PosixPinnedRenderSource:
        source_fd = -1
        parent_fd = staging.parent_fd
        staging_fd = staging.directory_fd
        if parent_fd is None or staging_fd is None:
            raise FfmpegMediaError("Private render staging is not anchored")
        try:
            os.chmod(
                staging.output.name,
                0o400,
                dir_fd=staging_fd,
                follow_symlinks=False,
            )
            os.fchmod(staging_fd, 0o500)
            source_fd = os.open(
                staging.output.name,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=staging_fd,
            )
            source_status = os.fstat(source_fd)
            parent_status = os.fstat(parent_fd)
            staging_status = os.fstat(staging_fd)
            if (
                not stat.S_ISREG(source_status.st_mode)
                or (source_status.st_dev, source_status.st_ino) != identity
                or not stat.S_ISDIR(parent_status.st_mode)
                or not stat.S_ISDIR(staging_status.st_mode)
                or (staging_status.st_dev, staging_status.st_ino)
                != staging.directory_identity
            ):
                raise FfmpegMediaError("Pinned render source identity changed")
            return cls(
                staging,
                destination,
                source_fd,
                parent_fd,
                staging_fd,
                identity,
            )
        except BaseException:
            if source_fd >= 0:
                os.close(source_fd)
            raise

    def _path_still_names_source(self) -> bool:
        try:
            status = os.stat(
                self.staging.output.name,
                dir_fd=self.staging_fd,
                follow_symlinks=False,
            )
        except OSError:
            return False
        return stat.S_ISREG(status.st_mode) and (
            status.st_dev,
            status.st_ino,
        ) == self.identity

    def verify(self, expected: FileDigest) -> None:
        if not self._path_still_names_source():
            raise FfmpegMediaError("Pinned render source path identity changed")
        with os.fdopen(os.dup(self.source_fd), "rb") as reader:
            actual = _digest_reader(reader)
        if actual != expected:
            raise FfmpegMediaError("Pinned render source bytes changed")
        self.expected_digest = expected

    def publish(self) -> None:
        if self.expected_digest is None:
            raise FfmpegMediaError("Pinned render source was not verified")
        if not self._path_still_names_source():
            raise FfmpegMediaError("Pinned render source path identity changed")
        try:
            import ctypes

            libc = ctypes.CDLL(None, use_errno=True)
            linkat = libc.linkat
            linkat.argtypes = (
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
            )
            linkat.restype = ctypes.c_int
            result = linkat(
                self.source_fd,
                b"",
                self.parent_fd,
                os.fsencode(self.destination.name),
                0x1000,
            )
            if result != 0:
                error_number = ctypes.get_errno()
                if error_number in (17,):
                    raise FfmpegMediaError("Media destination already exists")
                raise FfmpegMediaError(
                    "Safe pinned render publication is unavailable"
                )
        except AttributeError as exc:
            raise FfmpegMediaError(
                "Safe pinned render publication is unavailable"
            ) from exc
        status = os.stat(
            self.destination.name,
            dir_fd=self.parent_fd,
            follow_symlinks=False,
        )
        if not stat.S_ISREG(status.st_mode) or (
            status.st_dev,
            status.st_ino,
        ) != self.identity:
            raise FfmpegMediaError("Published render identity changed")
        self.verify(self.expected_digest)

    def close(self) -> None:
        os.close(self.source_fd)


def _windows_handle_information(
    path: Path,
    *,
    desired_access: int,
    share_mode: int,
    flags: int,
) -> tuple[object, tuple[int, int], int, object]:
    import ctypes
    from ctypes import wintypes

    class _HandleInformation(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wintypes.DWORD),
            ("ftCreationTime", wintypes.FILETIME),
            ("ftLastAccessTime", wintypes.FILETIME),
            ("ftLastWriteTime", wintypes.FILETIME),
            ("dwVolumeSerialNumber", wintypes.DWORD),
            ("nFileSizeHigh", wintypes.DWORD),
            ("nFileSizeLow", wintypes.DWORD),
            ("nNumberOfLinks", wintypes.DWORD),
            ("nFileIndexHigh", wintypes.DWORD),
            ("nFileIndexLow", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    handle = create_file(
        str(path),
        desired_access,
        share_mode,
        None,
        3,
        flags,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        error_number = ctypes.get_last_error()
        raise OSError(error_number, ctypes.FormatError(error_number))
    information = _HandleInformation()
    get_information = kernel32.GetFileInformationByHandle
    get_information.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(_HandleInformation),
    )
    get_information.restype = wintypes.BOOL
    if not get_information(handle, ctypes.byref(information)):
        error_number = ctypes.get_last_error()
        kernel32.CloseHandle(handle)
        raise OSError(error_number, ctypes.FormatError(error_number))
    identity = (
        information.dwVolumeSerialNumber,
        (information.nFileIndexHigh << 32) | information.nFileIndexLow,
    )
    return handle, identity, information.dwFileAttributes, kernel32


@dataclass(slots=True)
class _WindowsPinnedRenderSource(_PinnedRenderSource):
    staging: _OwnedRenderStaging
    destination: Path
    reader: BinaryIO
    staging_handle: object
    parent_handle: object
    kernel32: object
    identity: tuple[int, int]
    expected_digest: FileDigest | None = None

    @classmethod
    def create(
        cls,
        staging: _OwnedRenderStaging,
        destination: Path,
        identity: tuple[int, int],
    ) -> _WindowsPinnedRenderSource:
        import msvcrt

        source_handle: object | None = None
        staging_handle: object | None = None
        parent_handle: object | None = None
        reader: BinaryIO | None = None
        kernel32: object | None = None
        succeeded = False
        try:
            source_handle, source_identity, attributes, kernel32 = (
                _windows_handle_information(
                    staging.output,
                    desired_access=0x80000000 | 0x00000080,
                    share_mode=0x00000001,
                    flags=0x00200000,
                )
            )
            if (
                attributes & (0x00000010 | 0x00000400)
                or source_identity[1] != identity[1]
            ):
                raise FfmpegMediaError("Pinned render source identity changed")
            staging_handle, staging_identity, staging_attributes, _ = (
                _windows_handle_information(
                    staging.directory,
                    desired_access=0x00000080,
                    share_mode=0x00000001 | 0x00000002,
                    flags=0x02000000 | 0x00200000,
                )
            )
            if (
                not staging_attributes & 0x00000010
                or staging_attributes & 0x00000400
                or staging_identity[1] != staging.directory_identity[1]
                or not staging._owns_directory()
            ):
                raise FfmpegMediaError("Private render staging identity changed")
            parent_handle, _, parent_attributes, parent_kernel = (
                _windows_handle_information(
                    destination.parent,
                    desired_access=0x00000080,
                    share_mode=0x00000001 | 0x00000002,
                    flags=0x02000000 | 0x00200000,
                )
            )
            if (
                not parent_attributes & 0x00000010
                or parent_attributes & 0x00000400
            ):
                raise FfmpegMediaError("Render destination parent is unsafe")
            file_descriptor = msvcrt.open_osfhandle(
                int(source_handle),
                os.O_RDONLY | getattr(os, "O_BINARY", 0),
            )
            source_handle = None
            reader = os.fdopen(file_descriptor, "rb")
            status = os.fstat(reader.fileno())
            if (status.st_dev, status.st_ino) != identity:
                raise FfmpegMediaError("Pinned render source identity changed")
            pinned = cls(
                staging,
                destination,
                reader,
                staging_handle,
                parent_handle,
                parent_kernel,
                identity,
            )
            succeeded = True
            return pinned
        except OSError as exc:
            raise FfmpegMediaError("Pinned render source could not be opened") from exc
        finally:
            if not succeeded:
                if reader is not None:
                    reader.close()
                elif source_handle is not None and kernel32 is not None:
                    kernel32.CloseHandle(source_handle)  # type: ignore[attr-defined]
                if staging_handle is not None and kernel32 is not None:
                    kernel32.CloseHandle(staging_handle)  # type: ignore[attr-defined]
                if parent_handle is not None:
                    parent_kernel.CloseHandle(parent_handle)  # type: ignore[attr-defined]

    def _path_still_names_source(self) -> bool:
        try:
            status = os.stat(self.staging.output, follow_symlinks=False)
        except OSError:
            return False
        return stat.S_ISREG(status.st_mode) and (
            status.st_dev,
            status.st_ino,
        ) == self.identity

    def verify(self, expected: FileDigest) -> None:
        if not self._path_still_names_source():
            raise FfmpegMediaError("Pinned render source path identity changed")
        actual = _digest_reader(self.reader)
        if actual != expected:
            raise FfmpegMediaError("Pinned render source bytes changed")
        self.expected_digest = expected

    def publish(self) -> None:
        import ctypes
        from ctypes import wintypes

        if self.expected_digest is None:
            raise FfmpegMediaError("Pinned render source was not verified")
        if not self._path_still_names_source():
            raise FfmpegMediaError("Pinned render source path identity changed")
        create_link = self.kernel32.CreateHardLinkW  # type: ignore[attr-defined]
        create_link.argtypes = (
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.LPVOID,
        )
        create_link.restype = wintypes.BOOL
        if not create_link(
            str(self.destination),
            str(self.staging.output),
            None,
        ):
            error_number = ctypes.get_last_error()
            if error_number in (80, 183):
                raise FfmpegMediaError("Media destination already exists")
            raise FfmpegMediaError(
                f"Safe pinned render publication failed ({error_number})"
            )
        status = os.stat(self.destination, follow_symlinks=False)
        if not stat.S_ISREG(status.st_mode) or (
            status.st_dev,
            status.st_ino,
        ) != self.identity:
            raise FfmpegMediaError("Published render identity changed")
        self.verify(self.expected_digest)

    def close(self) -> None:
        try:
            self.reader.close()
        finally:
            try:
                self.kernel32.CloseHandle(  # type: ignore[attr-defined]
                    self.staging_handle
                )
            finally:
                self.kernel32.CloseHandle(  # type: ignore[attr-defined]
                    self.parent_handle
                )


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
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
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
            self._finish_readers(
                readers,
                process.stdout,
                process.stderr,
                timeout,
            )
            detail = stderr_capture.text()
            message = "Media executable timed out"
            if detail:
                message = f"{message}: {detail}"
            raise FfmpegMediaError(message) from exc
        if not self._finish_readers(
            readers,
            process.stdout,
            process.stderr,
            timeout,
        ):
            raise FfmpegMediaError("Media executable output pipes timed out")
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

    @classmethod
    def _finish_readers(
        cls,
        readers: tuple[threading.Thread, threading.Thread],
        stdout: object,
        stderr: object,
        timeout: float,
    ) -> bool:
        completed_without_force = cls._join_readers(readers, timeout)
        for pipe in (stdout, stderr):
            try:
                pipe.close()  # type: ignore[attr-defined]
            except (OSError, ValueError):
                pass
        if not completed_without_force:
            cls._join_readers(readers, timeout)
        return completed_without_force

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
        if (
            type(value) is not str
            or len(value) > 20
            or not value.isascii()
            or not value.isdigit()
        ):
            raise FfmpegMediaError(f"ffprobe {name} is invalid")
        try:
            result = int(value)
        except ValueError as exc:
            raise FfmpegMediaError(f"ffprobe {name} is invalid") from exc
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
        final_output = self._destination(destination)
        staging = _OwnedRenderStaging.create(final_output)
        output = staging.output
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
        try:
            self._run(
                arguments,
                timeout=self.render_timeout_seconds,
                stdout_limit=self.diagnostic_limit,
            )
            staging.claim_output()
            pinned = staging.pin(final_output)
            try:
                validated = self.validate_render(output, plan)
                pinned.verify(validated.source_digest)
                pinned.publish()
            finally:
                pinned.close()
            return replace(
                validated,
                source_path=PurePosixPath("inputs") / final_output.name,
            )
        finally:
            staging.cleanup()

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
