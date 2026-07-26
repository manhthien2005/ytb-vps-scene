from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.filesystem.integrity import (
    reject_reparse_components,
    secure_root,
)
from ytb_vps_v2.ports.backup import BackupStoreError
from ytb_vps_v2.ports.cleanup import UnsafeDeletionTargetError


def _paths(name: str, value: object) -> tuple[Path, ...]:
    if (
        type(value) is not tuple
        or not value
        or any(not isinstance(item, Path) for item in value)
    ):
        raise UnsafeDeletionTargetError(f"{name} must be a non-empty tuple of Paths")
    for item in value:
        if not item.is_absolute() or ".." in item.parts:
            raise UnsafeDeletionTargetError(
                f"{name} must contain absolute paths without parent traversal"
            )
    return value


def _nested(values: tuple[Path, ...]) -> bool:
    for index, first in enumerate(values):
        for second in values[index + 1 :]:
            if first == second:
                return True
            try:
                first.relative_to(second)
                return True
            except ValueError:
                pass
            try:
                second.relative_to(first)
                return True
            except ValueError:
                pass
    return False


def _components(root: Path, target: Path) -> tuple[Path, ...]:
    relative = target.relative_to(root)
    current = root
    result = [root]
    for part in relative.parts:
        current = current / part
        result.append(current)
    return tuple(result)


def _identity(path: Path) -> tuple[int, int, int, int]:
    status = os.lstat(path)
    return (
        status.st_dev,
        status.st_ino,
        status.st_mode,
        getattr(status, "st_file_attributes", 0),
    )


class LocalDeletionTargetPolicy:
    def preflight(
        self,
        targets: tuple[Path, ...],
        allowed_roots: tuple[Path, ...],
    ) -> tuple[PurePosixPath, ...]:
        target_values = _paths("Deletion targets", targets)
        root_values = _paths("Allowed roots", allowed_roots)
        try:
            roots = tuple(sorted((secure_root(item) for item in root_values), key=str))
            if _nested(roots):
                raise UnsafeDeletionTargetError(
                    "Allowed roots must be distinct and non-overlapping"
                )

            resolved_targets: list[Path] = []
            component_sets: list[tuple[Path, ...]] = []
            before_identities: list[tuple[object, ...]] = []
            for raw_target in target_values:
                reject_reparse_components(raw_target)
                if not raw_target.exists():
                    raise UnsafeDeletionTargetError("Deletion target must exist")
                target = raw_target.resolve(strict=True)
                matching_roots: list[Path] = []
                for root in roots:
                    try:
                        relative = target.relative_to(root)
                    except ValueError:
                        continue
                    if relative.parts:
                        matching_roots.append(root)
                if len(matching_roots) != 1:
                    raise UnsafeDeletionTargetError(
                        "Deletion target must be strictly below one allowed root"
                    )
                components = _components(matching_roots[0], target)
                # Snapshot identities BEFORE the per-component validation: the final
                # re-check below must span the validation window it protects, not
                # compare two back-to-back reads taken after everything finished.
                before_identities.append(
                    tuple(_identity(component) for component in components)
                )
                for component in components:
                    reject_reparse_components(component)
                resolved_targets.append(target)
                component_sets.append(components)

            ordered_targets = tuple(sorted(resolved_targets, key=str))
            if _nested(ordered_targets):
                raise UnsafeDeletionTargetError(
                    "Deletion targets must be distinct and non-overlapping"
                )

            after = tuple(
                tuple(_identity(component) for component in components)
                for components in component_sets
            )
            if tuple(before_identities) != after:
                raise UnsafeDeletionTargetError(
                    "Deletion target identity changed during preflight"
                )
            return tuple(
                PurePosixPath(item.as_posix()) for item in ordered_targets
            )
        except UnsafeDeletionTargetError:
            raise
        except (BackupStoreError, OSError, ValueError) as exc:
            raise UnsafeDeletionTargetError(
                "Deletion target confinement could not be proven"
            ) from exc
