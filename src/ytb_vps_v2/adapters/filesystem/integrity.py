from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import shutil
import stat
import uuid
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


def reject_reparse_components(path: Path) -> None:
    value = _path("Path", path)
    _reject_reparse_components(value)


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
def _windows_publication_guard(parent: Path) -> Iterator[object]:
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
        0x0080 | 0x0004,
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
        yield handle
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


def _rename_directory_no_replace(
    source: Path,
    destination: Path,
    parent: Path,
    expected_identity: tuple[int, int],
) -> None:
    if os.name == "nt":
        with _windows_publication_guard(parent):
            _windows_rename_directory_handle(
                source,
                destination,
                expected_identity,
            )
        return
    with _posix_publication_directory(parent, parent) as directory_fd:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        source_fd = os.open(source.name, flags, dir_fd=directory_fd)
        try:
            status = os.fstat(source_fd)
            if (status.st_dev, status.st_ino) != expected_identity:
                raise BackupStoreError("Restore staging identity changed")
            library = ctypes.CDLL(None, use_errno=True)
            renameat2 = getattr(library, "renameat2", None)
            if renameat2 is None:
                raise BackupStoreError(
                    "Platform lacks atomic no-replace directory publication"
                )
            renameat2.argtypes = (
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_uint,
            )
            renameat2.restype = ctypes.c_int

            def rename_no_replace(first: str, second: str) -> None:
                result = renameat2(
                    directory_fd,
                    os.fsencode(first),
                    directory_fd,
                    os.fsencode(second),
                    1,
                )
                if result != 0:
                    error_number = ctypes.get_errno()
                    raise OSError(
                        error_number or errno.EIO,
                        os.strerror(error_number or errno.EIO),
                    )

            rename_no_replace(source.name, destination.name)
            published = os.stat(
                destination.name,
                dir_fd=directory_fd,
                follow_symlinks=False,
            )
            if (published.st_dev, published.st_ino) != expected_identity:
                evacuated = False
                for _ in range(16):
                    quarantine = (
                        f".{destination.name}.rollback-{uuid.uuid4().hex}"
                    )
                    try:
                        rename_no_replace(destination.name, quarantine)
                    except FileExistsError:
                        continue
                    evacuated = True
                    break
                if not evacuated:
                    raise BackupStoreError(
                        "Published restore identity changed and evacuation failed"
                    )
                raise BackupStoreError("Published restore identity changed")
        finally:
            os.close(source_fd)


def _rollback_published_directory(
    published: Path,
    original: Path,
    parent: Path,
    expected_identity: tuple[int, int],
) -> Path:
    try:
        _rename_directory_no_replace(
            published,
            original,
            parent,
            expected_identity,
        )
        return original
    except (BackupStoreError, OSError) as preferred_error:
        for _ in range(16):
            quarantine = parent / (
                f".{published.name}.rollback-{uuid.uuid4().hex}"
            )
            try:
                _rename_directory_no_replace(
                    published,
                    quarantine,
                    parent,
                    expected_identity,
                )
                return quarantine
            except (FileExistsError, BackupStoreError, OSError):
                continue
        raise BackupStoreError(
            "Restore publication could not be evacuated after rollback conflict"
        ) from preferred_error


def _windows_directory_information(
    path: Path,
    desired_access: int,
    share_mode: int,
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
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
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
        0x02000000 | 0x00200000,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        raise BackupStoreError("Restore directory handle could not be opened")
    information = _HandleInformation()
    get_information = kernel32.GetFileInformationByHandle
    get_information.argtypes = (wintypes.HANDLE, ctypes.POINTER(_HandleInformation))
    get_information.restype = wintypes.BOOL
    if not get_information(handle, ctypes.byref(information)):
        close_handle(handle)
        raise BackupStoreError("Restore directory handle is invalid")
    identity = (
        information.dwVolumeSerialNumber,
        (information.nFileIndexHigh << 32) | information.nFileIndexLow,
    )
    return handle, identity, information.dwFileAttributes, kernel32


def _windows_rename_directory_handle(
    source: Path,
    destination: Path,
    expected_identity: tuple[int, int],
) -> None:
    import ctypes
    from ctypes import wintypes

    handle, identity, attributes, kernel32 = _windows_directory_information(
        source,
        0x00010000 | 0x00000080,
        0x00000001 | 0x00000002,
    )
    try:
        if attributes & 0x00000400 or identity != expected_identity:
            raise BackupStoreError("Restore staging identity changed")
        resolved_destination = str(destination.resolve(strict=False))
        if resolved_destination.startswith("\\\\"):
            destination_text = "\\??\\UNC\\" + resolved_destination.lstrip("\\")
        else:
            destination_text = "\\??\\" + resolved_destination

        class _RenameInformation(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD),
                ("RootDirectory", wintypes.HANDLE),
                ("FileNameLength", wintypes.DWORD),
                ("FileName", wintypes.WCHAR * 1),
            ]

        encoded_destination = destination_text.encode("utf-16-le")
        buffer_size = (
            _RenameInformation.FileName.offset
            + len(encoded_destination)
            + ctypes.sizeof(wintypes.WCHAR)
        )
        buffer = ctypes.create_string_buffer(buffer_size)
        information = ctypes.cast(
            buffer,
            ctypes.POINTER(_RenameInformation),
        ).contents
        information.Flags = 0
        information.RootDirectory = None
        information.FileNameLength = len(encoded_destination)
        ctypes.memmove(
            ctypes.addressof(buffer) + _RenameInformation.FileName.offset,
            encoded_destination,
            len(encoded_destination),
        )
        setter = kernel32.SetFileInformationByHandle
        setter.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        setter.restype = wintypes.BOOL
        if not setter(
            handle,
            3,
            ctypes.byref(buffer),
            buffer_size,
        ):
            error_number = ctypes.get_last_error()
            raise OSError(error_number, ctypes.FormatError(error_number))
        if source.exists() or not destination.is_dir():
            raise BackupStoreError(
                "Windows restore publication did not reach the exact target"
            )
        if directory_identity(destination) != expected_identity:
            raise BackupStoreError("Windows restore publication identity changed")
    finally:
        kernel32.CloseHandle(handle)


def directory_identity(path: Path) -> tuple[int, int]:
    value = _path("Directory", path)
    _reject_reparse_components(value)
    if not value.is_dir() or _is_reparse(value):
        raise BackupStoreError("Directory identity requires a real directory")
    if os.name == "nt":
        handle, identity, attributes, kernel32 = _windows_directory_information(
            value,
            0x00000080,
            0x00000001 | 0x00000002 | 0x00000004,
        )
        try:
            if attributes & 0x00000400:
                raise BackupStoreError("Directory identity is a reparse point")
            return identity
        finally:
            kernel32.CloseHandle(handle)
    status = os.lstat(value)
    return status.st_dev, status.st_ino


def _windows_remove_owned_directory(
    path: Path,
    expected_identity: tuple[int, int],
) -> None:
    import ctypes
    from ctypes import wintypes

    handle, identity, attributes, kernel32 = _windows_directory_information(
        path,
        0x00010000 | 0x00000080,
        0x00000001 | 0x00000002,
    )
    try:
        if attributes & 0x00000400 or identity != expected_identity:
            raise BackupStoreError("Owned restore directory identity changed")
        for child in path.iterdir():
            if _is_reparse(child):
                if child.is_dir():
                    child.rmdir()
                else:
                    child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        if any(path.iterdir()):
            raise BackupStoreError("Owned restore directory is not empty")

        class _DispositionInformation(ctypes.Structure):
            _fields_ = [("DeleteFile", ctypes.c_ubyte)]

        disposition = _DispositionInformation(1)
        setter = kernel32.SetFileInformationByHandle
        setter.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        setter.restype = wintypes.BOOL
        if not setter(
            handle,
            4,
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            error_number = ctypes.get_last_error()
            raise OSError(error_number, ctypes.FormatError(error_number))
    finally:
        kernel32.CloseHandle(handle)


def _posix_remove_contents(directory_fd: int) -> None:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    for name in os.listdir(directory_fd):
        status = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if stat.S_ISDIR(status.st_mode):
            child_fd = os.open(name, flags, dir_fd=directory_fd)
            try:
                _posix_remove_contents(child_fd)
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)


def remove_owned_directory(
    path: Path,
    parent: Path,
    expected_identity: tuple[int, int],
) -> None:
    value = _path("Owned restore directory", path)
    resolved_parent = secure_root(parent)
    try:
        if value.parent.resolve(strict=True) != resolved_parent:
            raise BackupStoreError("Owned restore directory escapes its parent")
        if directory_identity(value) != expected_identity:
            raise BackupStoreError("Owned restore directory identity changed")
        if os.name == "nt":
            with _windows_publication_guard(resolved_parent):
                _windows_remove_owned_directory(value, expected_identity)
            return
        with _posix_publication_directory(
            resolved_parent,
            resolved_parent,
        ) as parent_fd:
            flags = (
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            directory_fd = os.open(value.name, flags, dir_fd=parent_fd)
            try:
                status = os.fstat(directory_fd)
                if (status.st_dev, status.st_ino) != expected_identity:
                    raise BackupStoreError("Owned restore directory identity changed")
                _posix_remove_contents(directory_fd)
                current = os.stat(
                    value.name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
                if (current.st_dev, current.st_ino) != expected_identity:
                    raise BackupStoreError("Owned restore directory identity changed")
                os.rmdir(value.name, dir_fd=parent_fd)
            finally:
                os.close(directory_fd)
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Owned restore directory could not be removed") from exc


def publish_directory_no_replace(
    source: Path,
    destination: Path,
    parent: Path,
    expected_identity: tuple[int, int],
) -> None:
    source_path = _path("Staging directory", source)
    destination_path = _path("Restore destination", destination)
    resolved_parent = secure_root(parent)
    if (
        type(expected_identity) is not tuple
        or len(expected_identity) != 2
        or any(type(item) is not int or item < 0 for item in expected_identity)
    ):
        raise BackupStoreError("Restore staging identity is invalid")
    try:
        if (
            source_path.parent.resolve(strict=True) != resolved_parent
            or destination_path.parent.resolve(strict=True) != resolved_parent
        ):
            raise BackupStoreError(
                "Restore publication must remain within one anchored parent"
            )
        _reject_reparse_components(source_path)
        if not source_path.is_dir() or _is_reparse(source_path):
            raise BackupStoreError("Restore staging directory is unsafe")
        if directory_identity(source_path) != expected_identity:
            raise BackupStoreError("Restore staging identity changed")
        if (
            destination_path.exists()
            or destination_path.is_symlink()
            or _is_reparse(destination_path)
        ):
            raise BackupStoreError("Restore destination already exists")
        _rename_directory_no_replace(
            source_path,
            destination_path,
            resolved_parent,
            expected_identity,
        )
        try:
            sync_directory(resolved_parent)
        except BackupStoreError as sync_error:
            try:
                _rollback_published_directory(
                    destination_path,
                    source_path,
                    resolved_parent,
                    expected_identity,
                )
                sync_directory(resolved_parent)
            except (BackupStoreError, OSError) as rollback_error:
                raise BackupStoreError(
                    "Restore publication synchronization and rollback failed"
                ) from rollback_error
            raise sync_error
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Restore directory could not be published") from exc
