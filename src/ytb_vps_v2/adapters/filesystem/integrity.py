from __future__ import annotations

import hashlib
import os
import stat
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


def _publication_identity(root: Path, destination: Path) -> tuple[int, int, str]:
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
        status = parent.stat(follow_symlinks=False)
        return (
            status.st_dev,
            status.st_ino,
            os.path.normcase(str(resolved_parent)),
        )
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Publication parent identity cannot be verified") from exc


def publish_additively(
    temporary: Path,
    destination: Path,
    expected: FileDigest,
    root: Path,
) -> None:
    created_by_call = False
    before = _publication_identity(root, destination)
    try:
        try:
            os.link(temporary, destination)
            created_by_call = True
        except FileExistsError:
            if digest_file(destination) != expected:
                raise BackupStoreError(
                    "Existing durable object conflicts with expected bytes"
                )
        except OSError as exc:
            raise BackupStoreError("Durable object could not be published") from exc
        after = _publication_identity(root, destination)
        if after != before:
            raise BackupStoreError("Publication parent changed during commit")
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
