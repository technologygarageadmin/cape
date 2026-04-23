"""
strategy_mode.py — single source of truth for enabled ENTRY strategies.

Stores enabled strategy IDs in backend/logs/strategy_modes.json.
Only controls entry signals; exits remain unchanged.
"""

import json
import os
import threading


_STRATEGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "strategy_modes.json")
_lock = threading.Lock()

STRATEGY_LABELS: dict[str, str] = {
    "RSI_CROSSOVER": "RSI Crossover",
    "EMA_CROSSOVER": "EMA Crossover",
    "RSI_MEAN_REVERSION": "RSI Mean Reversion",
    "MACD_CROSSOVER": "MACD Crossover",
    "BOLLINGER_BANDS": "Bollinger Bands",
}
MAX_ENABLED_STRATEGIES = len(STRATEGY_LABELS)
VALID_STRATEGIES = set(STRATEGY_LABELS.keys())
DEFAULT_ENABLED = ["RSI_CROSSOVER"]


def _load_file() -> dict:
    try:
        with open(_STRATEGY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_file(data: dict) -> None:
    os.makedirs(os.path.dirname(_STRATEGY_FILE), exist_ok=True)
    tmp = _STRATEGY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _STRATEGY_FILE)


def _normalize_enabled(values) -> list[str]:
    if not isinstance(values, list):
        values = []
    result: list[str] = []
    for item in values:
        sid = str(item or "").strip().upper()
        if sid in VALID_STRATEGIES and sid not in result:
            result.append(sid)
    return result[:MAX_ENABLED_STRATEGIES]


def ensure_defaults() -> None:
    with _lock:
        data = _load_file()
        enabled = _normalize_enabled(data.get("enabled"))
        if not enabled:
            enabled = list(DEFAULT_ENABLED)
        data["enabled"] = enabled
        _save_file(data)


def get_enabled_strategies() -> list[str]:
    with _lock:
        data = _load_file()
    enabled = _normalize_enabled(data.get("enabled"))
    return enabled or list(DEFAULT_ENABLED)


def get_strategy_config() -> dict:
    enabled = get_enabled_strategies()
    available = [
        {"id": sid, "label": STRATEGY_LABELS[sid], "enabled": sid in enabled}
        for sid in STRATEGY_LABELS
    ]
    return {
        "maxEnabled": MAX_ENABLED_STRATEGIES,
        "enabled": enabled,
        "available": available,
    }


def set_strategy_enabled(strategy_id: str, enabled: bool) -> dict:
    sid = str(strategy_id or "").strip().upper()
    if sid not in VALID_STRATEGIES:
        raise ValueError(f"Invalid strategy '{strategy_id}'.")

    with _lock:
        data = _load_file()
        current = _normalize_enabled(data.get("enabled"))

        if enabled:
            if sid not in current:
                if len(current) >= MAX_ENABLED_STRATEGIES:
                    raise ValueError(f"You can enable at most {MAX_ENABLED_STRATEGIES} strategies.")
                current.append(sid)
        else:
            current = [x for x in current if x != sid]

        data["enabled"] = current
        _save_file(data)

    return get_strategy_config()
