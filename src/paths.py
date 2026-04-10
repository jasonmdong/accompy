import os
import sys
from pathlib import Path


def _resolve_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


REPO_ROOT = _resolve_base_dir()
DEFAULT_SCORES_DIR = REPO_ROOT / "scores"
DEFAULT_STATIC_DIR = REPO_ROOT / "static"


def get_scores_dir() -> Path:
    raw = os.getenv("ACCOMPY_SCORES_DIR", "").strip()
    target = Path(raw).expanduser() if raw else DEFAULT_SCORES_DIR
    target.mkdir(parents=True, exist_ok=True)
    return target


def get_static_dir() -> Path:
    raw = os.getenv("ACCOMPY_STATIC_DIR", "").strip()
    target = Path(raw).expanduser() if raw else DEFAULT_STATIC_DIR
    return target
