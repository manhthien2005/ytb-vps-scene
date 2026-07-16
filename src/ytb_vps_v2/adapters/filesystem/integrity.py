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


def secure_root(root: Path) -> Path:
    value = _path("Storage root", root)
    try:
        if value.is_symlink() or not value.is_dir():
            raise BackupStoreError("Storage root must be an existing real directory")
        return value.resolve(strict=True)
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Storage root cannot be resolved") from exc


def regular_file(path: Path) -> Path:
    value = _path("File", path)
    try:
        if value.is_symlink():
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
            if current.exists():
                if current.is_symlink() or not current.is_dir():
                    raise BackupStoreError("Object parent path is unsafe")
            else:
                current.mkdir()
        resolved_destination = destination.resolve(strict=False)
        if os.path.commonpath((str(resolved_root), str(resolved_destination))) != str(
            resolved_root
        ):
            raise BackupStoreError("Object path escapes its storage root")
        if destination.exists() and destination.is_symlink():
            raise BackupStoreError("Object destination must not be a symbolic link")
        return destination
    except BackupStoreError:
        raise
    except OSError as exc:
        raise BackupStoreError("Object destination cannot be prepared") from exc


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


def publish_additively(
    temporary: Path, destination: Path, expected: FileDigest
) -> None:
    try:
        os.link(temporary, destination)
    except FileExistsError:
        if digest_file(destination) != expected:
            raise BackupStoreError("Existing durable object conflicts with expected bytes")
        return
    except OSError as exc:
        raise BackupStoreError("Durable object could not be published") from exc
    sync_directory(destination.parent)
    if digest_file(destination) != expected:
        raise BackupStoreError("Published durable object failed verification")
