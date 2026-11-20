"""Config loading with defaults (config.toml)."""

from __future__ import annotations

import copy
import tomllib
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    "me": {
        "name": "",
        "school": "",
        "major": "",
        "year": None,
        "interests": "",
        "penn_email": "",
    },
    "smtp": {"host": "smtp.gmail.com", "port": 587, "use_ssl": False, "username": ""},
    "targeting": {
        "grad_years": [],
        "require_incoming": True,
        "target_firms": [],
        "aliases": {},
    },
    "limits": {"max_per_day": 15, "min_delay_seconds": 90, "max_delay_seconds": 240},
    "mode": {"auto": False},
    "template": {"subject": "Penn freshman — coffee chat?", "body": ""},
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"No config at {path}. Run `pennreach init` and fill in config.toml."
        )
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    cfg = _merge(DEFAULTS, data)
    cfg["template"]["body"] = cfg["template"]["body"].strip("\n") + "\n"
    return cfg
