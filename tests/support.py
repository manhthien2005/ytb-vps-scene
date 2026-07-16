from __future__ import annotations

from pathlib import Path

from ytb_vps.config import DEFAULTS, Settings, _merge


def test_settings(root: Path, **overrides) -> Settings:
    base = {
        "runtime": {
            "data_root": str(root / "data"),
            "secrets_root": str(root / "secrets"),
            "lock_file": str(root / "queue.lock"),
        },
        "drive": {"enabled": False},
        "media": {"chunk_seconds": 2, "target_fps": 30},
        "resources": {"minimum_free_gib": 0, "required_swap_gib": 0},
    }
    value = _merge(DEFAULTS, base)
    value = _merge(value, overrides)
    settings = Settings(value)
    settings.ensure_layout()
    return settings

