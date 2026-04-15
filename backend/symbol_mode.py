"""
symbol_mode.py — shared in-process + file-backed store for per-symbol trading modes.

Modes:
  "auto"   → AIT (AI Trade) — bot trades automatically  [DEFAULT]
  "off"    → Trading paused for this symbol
  "manual" → Manual mode — bot waits; user places Buy/Sell from frontend

Both main.py and api_server.py import this module.
Within a single process (e.g. api_server.py) reads/writes are in-memory.
main.py reads the file on every loop iteration so it picks up changes immediately.
"""

import json
import os
import threading

from config import WATCHLIST_SYMBOLS

_MODES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "symbol_modes.json")
_lock = threading.Lock()

VALID_MODES = {"auto", "off", "manual"}
DEFAULT_MODE = "auto"


def _default_mode(symbol: str) -> str:
    """Return the config-driven default mode for a symbol.
    Symbols enabled in WATCHLIST_SYMBOLS default to 'auto'; disabled ones to 'off'."""
    return "auto" if WATCHLIST_SYMBOLS.get(symbol.upper(), False) else "off"


def _load_file() -> dict:
    try:
        with open(_MODES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {k.upper(): v for k, v in data.items() if v in VALID_MODES}
    except Exception:
        return {}


def _save_file(data: dict) -> None:
    os.makedirs(os.path.dirname(_MODES_FILE), exist_ok=True)
    with open(_MODES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_mode(symbol: str) -> str:
    """Return current mode for *symbol*. Defaults based on WATCHLIST_SYMBOLS config."""
    with _lock:
        data = _load_file()
    return data.get(symbol.upper(), _default_mode(symbol))


def set_mode(symbol: str, mode: str) -> None:
    """Persist *mode* for *symbol* to the shared JSON file."""
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid mode '{mode}'. Must be one of {VALID_MODES}")
    with _lock:
        data = _load_file()
        data[symbol.upper()] = mode
        _save_file(data)


def get_all_modes() -> dict:
    """Return a dict of {symbol: mode} for all watchlist symbols, applying config defaults."""
    with _lock:
        persisted = _load_file()
    result = {}
    for sym in WATCHLIST_SYMBOLS:
        result[sym] = persisted.get(sym, _default_mode(sym))
    # also include any symbols persisted outside the watchlist
    for sym, mode in persisted.items():
        if sym not in result:
            result[sym] = mode
    return result
