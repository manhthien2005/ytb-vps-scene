from __future__ import annotations

import ctypes
import hashlib
import os
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator

from ytb_vps_v2.adapters.filesystem.integrity import (
    _windows_directory_information,
    digest_file,
    regular_file,
    secure_root,
    verified_existing_file,
)
from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.ports.backup import BackupStoreError
from ytb_vps_v2.ports.pipeline import ArtifactWriteError


_CHUNK_SIZE = 1024 * 1024
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)


def _flush_windows_directory_handle(kernel: object, handle: object) -> None:
    from ctypes import wintypes

    flush = kernel.FlushFileBuffers
    flush.argtypes = (wintypes.HANDLE,)
    flush.restype = wintypes.BOOL
    if not flush(handle):
        error_number = ctypes.get_last_error()
        raise BackupStoreError(
            "Artifact directory could not be synchronized"
        ) from OSError(error_number, ctypes.FormatError(error_number))


def _digest_reader(reader: BinaryIO) -> FileDigest:
    hasher = hashlib.sha256()
    size = 0
    while True:
        chunk = reader.read(_CHUNK_SIZE)
        if not chunk:
            break
        hasher.update(chunk)
        size += len(chunk)
    return FileDigest(size, hasher.hexdigest())


def _validated_destination(
    root: Path,
    key: PurePosixPath,
    expected: FileDigest,
) -> Path:
    try:
        entry = ManifestEntry(key, expected)
    except DomainInvariantError as exc:
        raise BackupStoreError("Artifact key is unsafe") from exc
    return secure_root(root).joinpath(*entry.key.parts)


class _OwnedTemporary:
    def __init__(
        self,
        parent: _AnchoredArtifactParent,
        name: str,
        handle: BinaryIO,
        identity: tuple[int, int],
    ) -> None:
        self.parent = parent
        self.name = name
        self.handle = handle
        self.identity = identity
        self.published = False

    def close(self) -> None:
        self.handle.close()

    def cleanup(self) -> None:
        self.parent.cleanup_temporary(self)


class _AnchoredArtifactParent:
    def __init__(self, root: Path, destination: Path) -> None:
        self.root = root
        self.destination = destination
        self.parent = destination.parent
        self._posix_fds: list[int] = []
        self._windows_handles: list[object] = []
        self._windows_identities: list[tuple[int, int]] = []
        self._windows_kernel: object | None = None

    def __enter__(self) -> _AnchoredArtifactParent:
        try:
            if os.name == "nt":
                self._open_windows_chain()
            else:
                self._open_posix_chain()
            return self
        except BaseException:
            self.__exit__()
            raise

    def __exit__(self, *ignored: object) -> None:
        if os.name == "nt":
            if self._windows_kernel is not None:
                for handle in reversed(self._windows_handles):
                    self._windows_kernel.CloseHandle(handle)
        else:
            for descriptor in reversed(self._posix_fds):
                os.close(descriptor)

    @property
    def _parent_fd(self) -> int:
        if not self._posix_fds:
            raise BackupStoreError("Artifact parent is not anchored")
        return self._posix_fds[-1]

    @property
    def _parent_handle(self) -> object:
        if not self._windows_handles:
            raise BackupStoreError("Artifact parent is not anchored")
        return self._windows_handles[-1]

    def _relative_parent_parts(self) -> tuple[str, ...]:
        try:
            return self.parent.relative_to(self.root).parts
        except ValueError as exc:
            raise BackupStoreError("Artifact parent escapes workspace root") from exc

    def _open_posix_chain(self) -> None:
        if os.open not in os.supports_dir_fd:
            raise BackupStoreError("Platform lacks anchored artifact operations")
        current_fd = os.open(self.root, _DIRECTORY_FLAGS)
        self._posix_fds.append(current_fd)
        try:
            for part in self._relative_parent_parts():
                try:
                    next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current_fd)
                except FileNotFoundError:
                    os.mkdir(part, mode=0o700, dir_fd=current_fd)
                    try:
                        os.fsync(current_fd)
                    except OSError as exc:
                        raise BackupStoreError(
                            "Artifact directory could not be synchronized"
                        ) from exc
                    next_fd = os.open(
                        part,
                        _DIRECTORY_FLAGS,
                        dir_fd=current_fd,
                    )
                current_fd = next_fd
                self._posix_fds.append(current_fd)
        except OSError as exc:
            raise BackupStoreError("Artifact parent identity could not be anchored") from exc

    def _open_windows_chain(self) -> None:
        current = self.root
        try:
            self._pin_windows_directory(current)
            for part in self._relative_parent_parts():
                current = current / part
                try:
                    self._pin_windows_directory(current)
                except BackupStoreError as open_error:
                    try:
                        current.mkdir()
                    except FileExistsError:
                        pass
                    except OSError:
                        raise open_error
                    if self._windows_kernel is None:
                        raise BackupStoreError("Artifact parent is not anchored")
                    _flush_windows_directory_handle(
                        self._windows_kernel,
                        self._windows_handles[-1],
                    )
                    self._pin_windows_directory(current)
            self._recheck_windows_chain()
        except BaseException:
            if self._windows_kernel is not None:
                for handle in reversed(self._windows_handles):
                    self._windows_kernel.CloseHandle(handle)
            self._windows_handles.clear()
            self._windows_identities.clear()
            raise

    def _pin_windows_directory(self, path: Path) -> None:
        handle, identity, attributes, kernel = _windows_directory_information(
            path,
            0x40000000 | 0x00000080,
            0x00000001 | 0x00000002,
        )
        self._windows_kernel = kernel
        self._windows_handles.append(handle)
        self._windows_identities.append(identity)
        if not attributes & 0x00000010 or attributes & 0x00000400:
            raise BackupStoreError("Artifact parent chain is unsafe")

    def _recheck_windows_chain(self) -> None:
        current = self.root
        paths = [current]
        for part in self._relative_parent_parts():
            current = current / part
            paths.append(current)
        for path, expected in zip(paths, self._windows_identities, strict=True):
            handle, identity, attributes, kernel = _windows_directory_information(
                path,
                0x00000080,
                0x00000001 | 0x00000002 | 0x00000004,
            )
            try:
                if attributes & 0x00000400 or identity != expected:
                    raise BackupStoreError("Artifact parent chain identity changed")
            finally:
                kernel.CloseHandle(handle)

    def create_temporary(self, name: str) -> _OwnedTemporary:
        if os.name == "nt":
            return self._create_windows_temporary(name)
        flags = (
            os.O_RDWR
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(name, flags, 0o600, dir_fd=self._parent_fd)
        try:
            status = os.fstat(descriptor)
            if not stat.S_ISREG(status.st_mode):
                raise BackupStoreError("Artifact temporary is not a regular file")
            handle = os.fdopen(descriptor, "w+b")
        except BaseException:
            os.close(descriptor)
            raise
        return _OwnedTemporary(
            self,
            name,
            handle,
            (status.st_dev, status.st_ino),
        )

    def _create_windows_temporary(self, name: str) -> _OwnedTemporary:
        import msvcrt
        from ctypes import wintypes

        if self._windows_kernel is None:
            raise BackupStoreError("Artifact parent is not anchored")
        create_file = self._windows_kernel.CreateFileW
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
        path = self.parent / name
        raw_handle = create_file(
            str(path),
            0x80000000 | 0x40000000 | 0x00010000 | 0x00000080,
            0x00000001 | 0x00000002,
            None,
            1,
            0x00000080 | 0x00200000,
            None,
        )
        invalid_handle = ctypes.c_void_p(-1).value
        if raw_handle == invalid_handle:
            error_number = ctypes.get_last_error()
            raise OSError(error_number, ctypes.FormatError(error_number), path)
        try:
            descriptor = msvcrt.open_osfhandle(
                int(raw_handle),
                os.O_RDWR | getattr(os, "O_BINARY", 0),
            )
            handle = os.fdopen(descriptor, "w+b")
        except BaseException:
            self._windows_kernel.CloseHandle(raw_handle)
            raise
        status = os.fstat(handle.fileno())
        return _OwnedTemporary(
            self,
            name,
            handle,
            (status.st_dev, status.st_ino),
        )

    def digest_destination(self, *, share_delete: bool = False) -> FileDigest | None:
        try:
            if os.name == "nt":
                handle = self._open_windows_destination(share_delete=share_delete)
            else:
                descriptor = os.open(
                    self.destination.name,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=self._parent_fd,
                )
                handle = os.fdopen(descriptor, "rb")
        except FileNotFoundError:
            return None
        with handle:
            status = os.fstat(handle.fileno())
            if not stat.S_ISREG(status.st_mode):
                raise BackupStoreError("Artifact destination is not a regular file")
            digest = _digest_reader(handle)
            if os.name == "nt":
                current = os.stat(self.destination, follow_symlinks=False)
            else:
                current = os.stat(
                    self.destination.name,
                    dir_fd=self._parent_fd,
                    follow_symlinks=False,
                )
            if (current.st_dev, current.st_ino) != (status.st_dev, status.st_ino):
                raise BackupStoreError("Artifact destination identity changed")
            return digest

    def _open_windows_destination(self, *, share_delete: bool) -> BinaryIO:
        import msvcrt
        from ctypes import wintypes

        if self._windows_kernel is None:
            raise BackupStoreError("Artifact parent is not anchored")
        create_file = self._windows_kernel.CreateFileW
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
        raw_handle = create_file(
            str(self.destination),
            0x80000000 | 0x00000080,
            0x00000001 | 0x00000002 | (0x00000004 if share_delete else 0),
            None,
            3,
            0x00200000,
            None,
        )
        invalid_handle = ctypes.c_void_p(-1).value
        if raw_handle == invalid_handle:
            error_number = ctypes.get_last_error()
            if error_number in (2, 3):
                raise FileNotFoundError(error_number, ctypes.FormatError(error_number))
            raise OSError(error_number, ctypes.FormatError(error_number))
        try:
            descriptor = msvcrt.open_osfhandle(
                int(raw_handle),
                os.O_RDONLY | getattr(os, "O_BINARY", 0),
            )
            return os.fdopen(descriptor, "rb")
        except BaseException:
            self._windows_kernel.CloseHandle(raw_handle)
            raise

    def publish(self, temporary: _OwnedTemporary, expected: FileDigest) -> None:
        created_by_call = False
        try:
            try:
                if os.name == "nt":
                    self._rename_windows_temporary(temporary)
                else:
                    os.link(
                        temporary.name,
                        self.destination.name,
                        src_dir_fd=self._parent_fd,
                        dst_dir_fd=self._parent_fd,
                        follow_symlinks=False,
                    )
                temporary.published = True
                created_by_call = True
            except OSError as exc:
                existing = self.digest_destination()
                if existing is None:
                    raise BackupStoreError("Artifact could not be published") from exc
                if existing != expected:
                    raise BackupStoreError(
                        "Existing artifact conflicts with expected bytes"
                    ) from exc
            self.sync_parent()
            if self.digest_destination(share_delete=created_by_call) != expected:
                raise BackupStoreError("Published artifact failed verification")
        except BaseException:
            if created_by_call:
                self._remove_published_identity(temporary)
                try:
                    self.sync_parent()
                except BackupStoreError:
                    pass
            raise

    def _rename_windows_temporary(self, temporary: _OwnedTemporary) -> None:
        import msvcrt
        from ctypes import wintypes

        if self._windows_kernel is None:
            raise BackupStoreError("Artifact parent is not anchored")

        class _RenameInformation(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD),
                ("RootDirectory", wintypes.HANDLE),
                ("FileNameLength", wintypes.DWORD),
                ("FileName", wintypes.WCHAR * 1),
            ]

        resolved_destination = str(self.destination.resolve(strict=False))
        if resolved_destination.startswith("\\\\"):
            destination_text = "\\??\\UNC\\" + resolved_destination.lstrip("\\")
        else:
            destination_text = "\\??\\" + resolved_destination
        encoded = destination_text.encode("utf-16-le")
        buffer_size = (
            _RenameInformation.FileName.offset
            + len(encoded)
            + ctypes.sizeof(wintypes.WCHAR)
        )
        buffer = ctypes.create_string_buffer(buffer_size)
        information = ctypes.cast(
            buffer,
            ctypes.POINTER(_RenameInformation),
        ).contents
        information.Flags = 0
        information.RootDirectory = None
        information.FileNameLength = len(encoded)
        ctypes.memmove(
            ctypes.addressof(buffer) + _RenameInformation.FileName.offset,
            encoded,
            len(encoded),
        )
        setter = self._windows_kernel.SetFileInformationByHandle
        setter.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        setter.restype = wintypes.BOOL
        raw_handle = msvcrt.get_osfhandle(temporary.handle.fileno())
        if not setter(raw_handle, 3, ctypes.byref(buffer), buffer_size):
            error_number = ctypes.get_last_error()
            raise OSError(error_number, ctypes.FormatError(error_number))

    def _remove_published_identity(self, temporary: _OwnedTemporary) -> None:
        if os.name == "nt":
            self._dispose_windows_handle(temporary)
            return
        try:
            status = os.stat(
                self.destination.name,
                dir_fd=self._parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return
        if (status.st_dev, status.st_ino) == temporary.identity:
            os.unlink(self.destination.name, dir_fd=self._parent_fd)

    def cleanup_temporary(self, temporary: _OwnedTemporary) -> None:
        try:
            if os.name == "nt":
                if not temporary.published:
                    self._dispose_windows_handle(temporary)
                return
            try:
                status = os.stat(
                    temporary.name,
                    dir_fd=self._parent_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                return
            if (status.st_dev, status.st_ino) == temporary.identity:
                os.unlink(temporary.name, dir_fd=self._parent_fd)
                self.sync_parent()
        finally:
            temporary.close()

    def _dispose_windows_handle(self, temporary: _OwnedTemporary) -> None:
        import msvcrt
        from ctypes import wintypes

        if self._windows_kernel is None:
            raise BackupStoreError("Artifact parent is not anchored")

        class _DispositionInformation(ctypes.Structure):
            _fields_ = [("DeleteFile", ctypes.c_ubyte)]

        disposition = _DispositionInformation(1)
        setter = self._windows_kernel.SetFileInformationByHandle
        setter.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        setter.restype = wintypes.BOOL
        raw_handle = msvcrt.get_osfhandle(temporary.handle.fileno())
        if not setter(
            raw_handle,
            4,
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            error_number = ctypes.get_last_error()
            if error_number not in (2, 3):
                raise OSError(error_number, ctypes.FormatError(error_number))

    def sync_parent(self) -> None:
        if os.name == "nt":
            if self._windows_kernel is None:
                raise BackupStoreError("Artifact parent is not anchored")
            _flush_windows_directory_handle(
                self._windows_kernel,
                self._parent_handle,
            )
        else:
            try:
                os.fsync(self._parent_fd)
            except OSError as exc:
                raise BackupStoreError(
                    "Artifact directory could not be synchronized"
                ) from exc


@contextmanager
def _anchored_artifact_parent(
    root: Path,
    destination: Path,
) -> Iterator[_AnchoredArtifactParent]:
    with _AnchoredArtifactParent(root, destination) as anchored:
        yield anchored


def _write_bytes_to_temp(temporary: _OwnedTemporary, raw: bytes) -> FileDigest:
    hasher = hashlib.sha256()
    temporary.handle.write(raw)
    hasher.update(raw)
    temporary.handle.flush()
    os.fsync(temporary.handle.fileno())
    return FileDigest(len(raw), hasher.hexdigest())


def _copy_to_temp(source: Path, temporary: _OwnedTemporary) -> FileDigest:
    source_file = regular_file(source)
    hasher = hashlib.sha256()
    size = 0
    with source_file.open("rb") as reader:
        while True:
            chunk = reader.read(_CHUNK_SIZE)
            if not chunk:
                break
            temporary.handle.write(chunk)
            hasher.update(chunk)
            size += len(chunk)
    temporary.handle.flush()
    os.fsync(temporary.handle.fileno())
    return FileDigest(size, hasher.hexdigest())


class LocalArtifactWriter:
    def __init__(self, root: Path) -> None:
        try:
            self.root = secure_root(root)
        except BackupStoreError as exc:
            raise ArtifactWriteError("Workspace root is invalid") from exc

    @staticmethod
    def _temporary_name(destination: Path) -> str:
        return f".{destination.name}.{uuid.uuid4().hex}.part"

    def _matching_existing(
        self,
        key: PurePosixPath,
        expected: FileDigest,
        anchored: _AnchoredArtifactParent,
    ) -> ManifestEntry | None:
        existing = anchored.digest_destination()
        if existing is None:
            return None
        if existing != expected:
            raise BackupStoreError("Existing artifact conflicts with expected bytes")
        anchored.sync_parent()
        return ManifestEntry(key, expected)

    def write_bytes(self, key: PurePosixPath, raw: bytes) -> ManifestEntry:
        if type(raw) is not bytes:
            raise ArtifactWriteError("Artifact content must be bytes")
        expected = FileDigest(len(raw), hashlib.sha256(raw).hexdigest())
        try:
            destination = _validated_destination(self.root, key, expected)
            with _anchored_artifact_parent(self.root, destination) as anchored:
                existing = self._matching_existing(key, expected, anchored)
                if existing is not None:
                    return existing
                temporary = anchored.create_temporary(
                    self._temporary_name(destination)
                )
                try:
                    written = _write_bytes_to_temp(temporary, raw)
                    if written != expected:
                        raise ArtifactWriteError(
                            "Temporary artifact bytes changed while writing"
                        )
                    anchored.publish(temporary, expected)
                    return ManifestEntry(key, expected)
                finally:
                    temporary.cleanup()
        except ArtifactWriteError:
            raise
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Artifact bytes could not be committed") from exc

    def write_file(self, key: PurePosixPath, source: Path) -> ManifestEntry:
        try:
            expected = digest_file(source)
            destination = _validated_destination(self.root, key, expected)
            with _anchored_artifact_parent(self.root, destination) as anchored:
                existing = self._matching_existing(key, expected, anchored)
                if existing is not None:
                    if digest_file(source) != expected:
                        raise ArtifactWriteError(
                            "Artifact source changed during destination verification"
                        )
                    return existing
                temporary = anchored.create_temporary(
                    self._temporary_name(destination)
                )
                try:
                    copied = _copy_to_temp(source, temporary)
                    latest = digest_file(source)
                    if copied != expected or latest != expected:
                        raise ArtifactWriteError(
                            "Artifact source changed while being copied"
                        )
                    anchored.publish(temporary, expected)
                    return ManifestEntry(key, expected)
                finally:
                    temporary.cleanup()
        except ArtifactWriteError:
            raise
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Artifact file could not be committed") from exc

    def verify(self, key: PurePosixPath, expected: FileDigest) -> ManifestEntry:
        if type(expected) is not FileDigest:
            raise ArtifactWriteError("Expected artifact digest must be FileDigest")
        try:
            verified_existing_file(self.root, key, expected)
            return ManifestEntry(key, expected)
        except (BackupStoreError, DomainInvariantError, OSError) as exc:
            raise ArtifactWriteError("Workspace artifact failed verification") from exc


DurableArtifactWriter = LocalArtifactWriter
