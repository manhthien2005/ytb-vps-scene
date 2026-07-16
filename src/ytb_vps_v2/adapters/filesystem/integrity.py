from __future__ import annotations

import hashlib
import os
import stat
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.ports.backup import BackupStoreError


_CHUNK_SIZE = 1024 * 1024


def _path(name: str, value: object) -> Path:
    if not isinstance(value, Path):
        raise BackupStoreError(f"{name} must be a Path")
    return value


def _is_reparse(path: Path) -> bool:
    try:
        status = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise BackupStoreError("Path metadata cannot be inspected") from exc
    if stat.S_ISLNK(status.st_mode):
        return True
    junction_check = getattr(path, "is_junction", None)
    if junction_check is not None:
        try:
            if junction_check():
                return True
        except OSError as exc:
            raise BackupStoreError("Junction metadata cannot be inspected") from exc
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(status, "st_file_attributes", 0)
    return bool(reparse_flag and attributes & reparse_flag)


def _reject_reparse_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    for candidate in reversed((absolute, *absolute.parents)):
        if _is_reparse(candidate):
            raise BackupStoreError("Path contains a symbolic link or reparse point")


def secure_root(root: Path) -> Path:
    value = _path("Storage root", root)
    try:
        _reject_reparse_components(value)
        if not value.is_dir():
            raise BackupStoreError("Storage root must be an existing real directory")
        return value.resolve(strict=True)
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Storage root cannot be resolved") from exc


def regular_file(path: Path) -> Path:
    value = _path("File", path)
    try:
        _reject_reparse_components(value.parent)
        if _is_reparse(value):
            raise BackupStoreError("File must not be a symbolic link")
        status = value.stat()
        if not stat.S_ISREG(status.st_mode):
            raise BackupStoreError("File must be a regular file")
        return value
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("File is missing or unreadable") from exc


def digest_file(path: Path) -> FileDigest:
    value = regular_file(path)
    hasher = hashlib.sha256()
    size = 0
    try:
        with value.open("rb") as handle:
            status = os.fstat(handle.fileno())
            if not stat.S_ISREG(status.st_mode):
                raise BackupStoreError("File must remain a regular file")
            while True:
                chunk = handle.read(_CHUNK_SIZE)
                if not chunk:
                    break
                hasher.update(chunk)
                size += len(chunk)
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("File could not be hashed") from exc
    return FileDigest(size, hasher.hexdigest())


def destination_for(
    root: Path, key: PurePosixPath, expected: FileDigest
) -> Path:
    try:
        entry = ManifestEntry(key, expected)
    except DomainInvariantError as exc:
        raise BackupStoreError("Object key is unsafe") from exc
    resolved_root = secure_root(root)
    destination = resolved_root.joinpath(*entry.key.parts)
    current = resolved_root
    try:
        for part in entry.key.parts[:-1]:
            current = current / part
            if _is_reparse(current):
                raise BackupStoreError("Object parent path is unsafe")
            if current.exists():
                if not current.is_dir():
                    raise BackupStoreError("Object parent path is unsafe")
            else:
                current.mkdir()
        resolved_destination = destination.resolve(strict=False)
        if os.path.commonpath((str(resolved_root), str(resolved_destination))) != str(
            resolved_root
        ):
            raise BackupStoreError("Object path escapes its storage root")
        if _is_reparse(destination):
            raise BackupStoreError("Object destination must not be a symbolic link")
        return destination
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Object destination cannot be prepared") from exc


def existing_path(root: Path, key: PurePosixPath) -> Path:
    try:
        entry = ManifestEntry(key, FileDigest(0, "0" * 64))
    except DomainInvariantError as exc:
        raise BackupStoreError("Object key is unsafe") from exc
    resolved_root = secure_root(root)
    candidate = resolved_root.joinpath(*entry.key.parts)
    current = resolved_root
    try:
        for part in entry.key.parts:
            current = current / part
            if _is_reparse(current):
                raise BackupStoreError("Object path contains a symbolic link")
            if not current.exists():
                raise BackupStoreError("Object does not exist")
        resolved = candidate.resolve(strict=True)
        if os.path.commonpath((str(resolved_root), str(resolved))) != str(
            resolved_root
        ):
            raise BackupStoreError("Object path escapes its storage root")
        return regular_file(candidate)
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Object path cannot be verified") from exc


def verified_existing_file(
    root: Path, key: PurePosixPath, expected: FileDigest
) -> Path:
    if type(expected) is not FileDigest:
        raise BackupStoreError("Expected file digest must be FileDigest")
    candidate = existing_path(root, key)
    if digest_file(candidate) != expected:
        raise BackupStoreError("Existing file does not match expected digest")
    return candidate


class LocalFileIntegrity:
    def secure_root(self, root: Path) -> Path:
        return secure_root(root)

    def existing(
        self, root: Path, key: PurePosixPath, expected: FileDigest
    ) -> Path:
        return verified_existing_file(root, key, expected)


def copy_to_temp(source: Path, temporary: Path) -> FileDigest:
    source_file = regular_file(source)
    temporary_path = _path("Temporary file", temporary)
    hasher = hashlib.sha256()
    size = 0
    with source_file.open("rb") as reader, temporary_path.open("xb") as writer:
        while True:
            chunk = reader.read(_CHUNK_SIZE)
            if not chunk:
                break
            writer.write(chunk)
            hasher.update(chunk)
            size += len(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    return FileDigest(size, hasher.hexdigest())


def sync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        if os.name != "nt":
            raise BackupStoreError("Storage directory could not be synchronized") from exc


def _validated_publication_parent(root: Path, destination: Path) -> Path:
    resolved_root = secure_root(root)
    parent = destination.parent
    _reject_reparse_components(parent)
    try:
        if not parent.is_dir():
            raise BackupStoreError("Publication parent is not a directory")
        resolved_parent = parent.resolve(strict=True)
        if os.path.commonpath((str(resolved_root), str(resolved_parent))) != str(
            resolved_root
        ):
            raise BackupStoreError("Publication parent escapes its storage root")
        return resolved_parent
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Publication parent identity cannot be verified") from exc


@contextmanager
def _windows_publication_guard(parent: Path) -> Iterator[None]:
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
    get_information = kernel32.GetFileInformationByHandle
    get_information.argtypes = (wintypes.HANDLE, ctypes.POINTER(_HandleInformation))
    get_information.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    handle = create_file(
        str(parent),
        0x0080,
        0x00000001 | 0x00000002,
        None,
        3,
        0x02000000 | 0x00200000,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        raise BackupStoreError("Publication directory could not be locked")
    try:
        information = _HandleInformation()
        if not get_information(handle, ctypes.byref(information)):
            raise BackupStoreError("Publication directory handle is invalid")
        if information.dwFileAttributes & 0x00000400:
            raise BackupStoreError("Publication directory is a reparse point")
        yield
    finally:
        close_handle(handle)


@contextmanager
def _posix_publication_directory(root: Path, parent: Path) -> Iterator[int]:
    if os.open not in os.supports_dir_fd or os.link not in os.supports_dir_fd:
        raise BackupStoreError("Platform lacks directory-anchored publication")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, flags)
    opened = [root_fd]
    try:
        relative = parent.relative_to(root)
        current_fd = root_fd
        for part in relative.parts:
            next_fd = os.open(part, flags, dir_fd=current_fd)
            opened.append(next_fd)
            current_fd = next_fd
        yield current_fd
    except (OSError, ValueError) as exc:
        raise BackupStoreError("Publication directory could not be anchored") from exc
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def _publish_no_replace(
    temporary: Path,
    destination: Path,
    root: Path,
) -> None:
    parent = _validated_publication_parent(root, destination)
    if temporary.parent.resolve(strict=True) != parent:
        raise BackupStoreError("Publication temporary file must share its final directory")
    if os.name == "nt":
        with _windows_publication_guard(parent):
            _validated_publication_parent(root, destination)
            os.rename(temporary, destination)
        return
    with _posix_publication_directory(secure_root(root), parent) as directory_fd:
        os.link(
            temporary.name,
            destination.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )


def publish_additively(
    temporary: Path,
    destination: Path,
    expected: FileDigest,
    root: Path,
) -> None:
    created_by_call = False
    try:
        try:
            _publish_no_replace(temporary, destination, root)
            created_by_call = True
        except OSError as exc:
            if not destination.exists():
                raise BackupStoreError(
                    "Durable object could not be published"
                ) from exc
            if digest_file(destination) != expected:
                raise BackupStoreError(
                    "Existing durable object conflicts with expected bytes"
                )
        sync_directory(destination.parent)
        if digest_file(destination) != expected:
            raise BackupStoreError("Published durable object failed verification")
    except BaseException:
        if created_by_call:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
            try:
                sync_directory(destination.parent)
            except BackupStoreError:
                pass
        raise
