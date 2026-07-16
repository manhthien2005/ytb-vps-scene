from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable


class UnsafeDeletionTargetError(RuntimeError):
    """Raised when cleanup path confinement cannot be proven."""


@runtime_checkable
class DeletionTargetPolicy(Protocol):
    def preflight(
        self,
        targets: tuple[Path, ...],
        allowed_roots: tuple[Path, ...],
    ) -> tuple[PurePosixPath, ...]: ...
