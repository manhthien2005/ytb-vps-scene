from __future__ import annotations

import shutil
from pathlib import Path


_GIB = 1024 ** 3


class DiskSpaceError(RuntimeError):
    """Raised before an operation that the volume cannot hold."""


def ensure_free_space(path: Path, need_bytes: int) -> None:
    if not isinstance(need_bytes, int) or need_bytes < 0:
        raise ValueError(
            "required free space must be a non-negative integer"
        )
    try:
        usage = shutil.disk_usage(path)
    except OSError as error:
        raise DiskSpaceError(
            f"free space at {path} could not be measured"
        ) from error
    if usage.free < need_bytes:
        raise DiskSpaceError(
            f"need {need_bytes} bytes "
            f"({need_bytes / _GIB:.2f} GiB) at {path}, "
            f"only {usage.free} bytes "
            f"({usage.free / _GIB:.2f} GiB) free"
        )
