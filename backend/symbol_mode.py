"""
symbol_mode.py — SINGLE SOURCE OF TRUTH for per-symbol trading modes.

  This is the ONLY place that reads/writes symbol_modes.json.
  All backend modules (main.py, api_server.py) and the UI (via /api/* endpoints)
  must go through the functions here.  Never read symbol_modes.json directly.

File: backend/logs/symbol_modes.json
  { "SPY": "auto", "TSLA": "manual", "AMD": "off", ... }

Modes:
  "auto"   → AIT — bot trades automatically          [default for watchlist-enabled symbols]
  "manual" → MT  — bot waits; user places trades     [default for watchlist-disabled symbols: "off"]
  "off"    → bot completely paused for this symbol

Rules:
  • get_mode()          reads file on every call — always fresh, never cached
  • set_mode()          writes file atomically under lock
  • ensure_defaults()   called once at boot — only fills in MISSING symbols,
                        never overwrites a mode the user already set
  • get_all_modes()     returns merged view: persisted + config defaults for all watchlist symbols
"""

import json
import os
import threading

from config import AIT_ENABLED, MT_ENABLED, WATCHLIST_SYMBOLS

_MODES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "symbol_modes.json")
_lock = threading.Lock()

VALID_MODES = {"auto", "off", "manual"}
DEFAULT_MODE = "auto"


def _default_mode(symbol: str) -> str:
    """Config-driven default: watchlist-enabled → 'auto', disabled → 'off'.
    Respects AIT_ENABLED/MT_ENABLED gates."""
    wants_auto = WATCHLIST_SYMBOLS.get(symbol.upper(), False)
    if wants_auto:
        return "auto" if AIT_ENABLED else ("manual" if MT_ENABLED else "off")
    return "off"


def _load_file() -> dict:
    """Read symbol_modes.json. Returns empty dict on any error (first run)."""
    try:
        with open(_MODES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {k.upper(): v for k, v in data.items() if v in VALID_MODES}
    except Exception:
        return {}


def _save_file(data: dict) -> None:
    """Write symbol_modes.json atomically (write to .tmp then rename)."""
    os.makedirs(os.path.dirname(_MODES_FILE), exist_ok=True)
    tmp = _MODES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _MODES_FILE)


# ── Public API ────────────────────────────────────────────────────────────────

def get_mode(symbol: str) -> str:
    """Return current mode for *symbol*. Always reads from disk — no caching."""
    with _lock:
        data = _load_file()
    return data.get(symbol.upper(), _default_mode(symbol))


def set_mode(symbol: str, mode: str) -> None:
    """Persist *mode* for *symbol*. Raises ValueError for unknown modes."""
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid mode '{mode}'. Must be one of {VALID_MODES}")
    with _lock:
        data = _load_file()
        data[symbol.upper()] = mode
        _save_file(data)


def ensure_defaults() -> None:
    """
    Called ONCE at process startup (main.py, api_server.py).
    Writes config defaults ONLY for symbols not already in the file.
    Never overwrites a mode the user set — preserves all existing entries.
    """
    with _lock:
        existing = _load_file()
        changed = False
        for sym in WATCHLIST_SYMBOLS:
            sym_upper = sym.upper()
            if sym_upper not in existing:
                existing[sym_upper] = _default_mode(sym_upper)
                changed = True
        if changed:
            _save_file(existing)


def get_all_modes() -> dict:
    """Return {symbol: mode} for all watchlist symbols + any extras persisted in file.
    Config defaults fill in any symbol missing from the file."""
    with _lock:
        persisted = _load_file()
    result = {}
    for sym in WATCHLIST_SYMBOLS:
        result[sym] = persisted.get(sym.upper(), _default_mode(sym))
    for sym, mode in persisted.items():
        if sym not in result:
            result[sym] = mode
    return result
