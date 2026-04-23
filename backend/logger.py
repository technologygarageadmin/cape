import csv
import os
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from config import (
    AIT_CSV,
    API_KEY,
    CSV_FILE,
    DEBUG,
    LOG_DIR,
    LOG_FIELDS,
    LOG_FILE,
    MANUAL_CSV,
    MONGO_COLLECTION_NAME,
    MONGO_DB_NAME,
    MONGO_ENABLED,
    MONGO_REQUIRED,
    MONGO_URI,
    SECRET_KEY,
    STRADDLE_CSV,
)


CDT = ZoneInfo("America/Chicago")
CST = CDT  # backward compat alias

# Legacy MongoDB collection (options_log) — used by write_log / main.py
_mongo_collection = None
_mongo_ready      = False

# Per-type MongoDB collections (used by log_trade)
_ait_col      = None
_straddle_col = None
_manual_col   = None

# Legacy open-trade context: BUY_FILLED → SELL stitching for main.py
_open_trade_context: dict = {}


# ─────────────────────────────────────────────────────────────────────────────
# Formatting helpers
# ─────────────────────────────────────────────────────────────────────────────

def _fmt_ts(ts) -> str:
    """ISO timestamp → 'MM/DD HH:MM:SS AM/PM' for log readability."""
    if not ts:
        return "—"
    try:
        d = datetime.fromisoformat(str(ts))
        if d.tzinfo is None:
            d = d.replace(tzinfo=CDT)
        return d.astimezone(CDT).strftime("%m/%d %I:%M:%S %p")
    except Exception:
        return str(ts)


def _fmt_price(v) -> str:
    try:
        return f"${float(v):.4f}"
    except Exception:
        return str(v or "—")


def _fmt_pct(v) -> str:
    try:
        return f"{float(v):+.2f}%"
    except Exception:
        return "—"


def _fmt_dur(sec) -> str:
    try:
        s = int(sec)
        m, s = divmod(s, 60)
        return f"{m}m {s:02d}s" if m else f"{s}s"
    except Exception:
        return "—"


def _fmt_order_audit_line(tick: dict) -> str:
    order_type = str(tick.get("order_type") or "ORDER")
    order_id = str(tick.get("order_id") or "—")
    prev_id = str(tick.get("prev_order_id") or "")
    status = str(tick.get("status") or "live").upper()
    status_at = _fmt_ts(tick.get("status_at") or tick.get("filled_at") or tick.get("canceled_at") or tick.get("updated_at") or tick.get("ts"))
    submitted_at = _fmt_ts(tick.get("submitted_at") or tick.get("ts"))
    filled_at = _fmt_ts(tick.get("filled_at"))
    canceled_at = _fmt_ts(tick.get("canceled_at"))
    fill_price = _fmt_price(tick.get("fill_price")) if tick.get("fill_price") is not None else "—"
    price_bits = []
    if tick.get("stop_price") is not None:
        price_bits.append(f"stop {_fmt_price(tick.get('stop_price'))}")
    if tick.get("limit_price") is not None:
        price_bits.append(f"lmt {_fmt_price(tick.get('limit_price'))}")
    prices = " | ".join(price_bits) if price_bits else "—"
    base = f"{order_type} id={order_id}"
    if prev_id:
        base += f" (prev={prev_id})"
    return (
        f"{base} | st={status} @ {status_at} | submitted {submitted_at} | "
        f"filled {filled_at} ({fill_price}) | cancelled {canceled_at} | {prices}"
    )


def _fmt_list(v) -> str:
    if isinstance(v, (list, tuple, set)):
        return ", ".join(str(x) for x in v if x is not None) or "—"
    if v is None:
        return "—"
    return str(v)


def _safe_float(v, decimals: int = 4):
    try:
        return round(float(v), decimals)
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Per-trade-type CSV field lists
# ─────────────────────────────────────────────────────────────────────────────

_AIT_FIELDS = [
    "trade_id", "trade_type", "symbol", "contract_name",
    "option_type", "direction", "strike_price", "expiry", "qty",
    "buy_price", "sell_price", "pnl", "pnl_pct", "result",
    "exit_reason", "trade_duration_sec",
    "peak_pnl_pct", "exit_sl_pct", "exit_qp_pct", "exit_tp_pct",
    "buy_order_id", "sell_order_id",
    "entry_signal_time", "entry_cross_time", "buy_filled_time",
    "exit_signal_time", "sell_filled_time",
    "entry_rsi", "entry_rsi_ma", "entry_rsi_delta", "entry_rsi_ma_gap",
    "entry_ema_fast", "entry_ema_slow", "entry_ema_bullish",
    "entry_volume_ratio", "entry_body_ratio", "entry_pullback_pct",
    "entry_up_streak", "entry_down_streak",
    "entry_underlying_price", "entry_vwap", "entry_price_above_vwap",
    "entry_trend", "entry_strategies", "entry_strategy_names", "entry_filters_passed",
    "created_at",
]

_STRADDLE_FIELDS = [
    "trade_id", "trade_type", "symbol", "contract_name",
    "option_type", "direction", "strike_price", "expiry", "qty",
    "buy_price", "sell_price", "pnl", "pnl_pct", "result",
    "exit_reason", "trade_duration_sec",
    "peak_pnl_pct", "exit_sl_pct", "exit_qp_pct", "exit_tp_pct",
    "buy_order_id", "sell_order_id",
    "entry_signal_time", "buy_filled_time",
    "exit_signal_time", "sell_filled_time",
    "created_at",
]

_MANUAL_FIELDS = [
    "trade_id", "trade_type", "symbol", "contract_name",
    "option_type", "direction", "strike_price", "expiry", "qty",
    "buy_price", "sell_price", "pnl", "pnl_pct", "result",
    "exit_reason", "trade_duration_sec",
    "peak_pnl_pct", "exit_sl_pct", "exit_qp_pct", "exit_tp_pct",
    "buy_order_id", "sell_order_id",
    "entry_time", "exit_time",
    "exit_signal_time", "sell_filled_time",
    "created_at",
]

_CSV_MAP: dict[str, tuple[str, list]] = {
    "AIT":      (AIT_CSV,      _AIT_FIELDS),
    "STRADDLE": (STRADDLE_CSV, _STRADDLE_FIELDS),
    "MANUAL":   (MANUAL_CSV,   _MANUAL_FIELDS),
}


# ─────────────────────────────────────────────────────────────────────────────
# CSV helpers
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_csv(path: str, fields: list) -> None:
    """Create CSV with header if not present; add missing columns without losing data."""
    if not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=fields).writeheader()
        return
    with open(path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        existing = list(reader.fieldnames or [])
        rows = list(reader)
    if any(col not in existing for col in fields):
        merged = existing + [c for c in fields if c not in existing]
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=merged, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)


def _write_csv_row(path: str, fields: list, row: dict) -> None:
    with open(path, "a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=fields, extrasaction="ignore").writerow(row)


# ─────────────────────────────────────────────────────────────────────────────
# log_trade — ONE call per COMPLETE trade
# ─────────────────────────────────────────────────────────────────────────────

def log_trade(trade_type: str, data: dict) -> None:
    """
    Write one completed trade to trade.log, the matching CSV, MongoDB, and console.

    Parameters
    ----------
    trade_type : "AIT" | "STRADDLE" | "MANUAL"
    data       : dict containing all available trade fields
    """
    ttype = str(trade_type).upper().strip()
    if ttype not in _CSV_MAP:
        info(f"[logger] Unknown trade_type '{ttype}' — log_trade skipped")
        return

    csv_path, fields = _CSV_MAP[ttype]

    # Ensure trade_id and defaults
    data = dict(data)
    data["trade_id"]   = str(data.get("trade_id") or uuid.uuid4())
    data["trade_type"] = ttype
    data.setdefault("created_at", datetime.now(CDT).isoformat(timespec="seconds"))

    # Normalise key numerics
    buy_price  = _safe_float(data.get("buy_price"),  4) or 0.0
    sell_price = _safe_float(data.get("sell_price"), 4) or 0.0
    pnl        = _safe_float(data.get("pnl"),        2)
    pnl_pct    = _safe_float(data.get("pnl_pct"),    4)
    qty        = int(data.get("qty") or 1)
    pnl_val    = pnl if pnl is not None else 0.0
    result     = str(data.get("result") or ("WIN" if pnl_val > 0 else "LOSS" if pnl_val < 0 else "BREAKEVEN"))

    data.update(buy_price=buy_price, sell_price=sell_price,
                pnl=pnl, pnl_pct=pnl_pct, qty=qty, result=result)

    symbol      = str(data.get("symbol") or "?")
    option_type = str(data.get("option_type") or "?").upper()
    exit_reason = str(data.get("exit_reason") or "?")
    entry_strategy = _fmt_list(data.get("entry_strategy_names") or data.get("entry_strategies"))
    dur         = _fmt_dur(data.get("trade_duration_sec"))
    peak_pct    = _safe_float(data.get("peak_pnl_pct"), 2)

    # 1. Console summary
    sign     = "+" if pnl_val >= 0 else "-"
    icon     = {"WIN": "✓ WIN", "LOSS": "✗ LOSS", "BREAKEVEN": "= BE"}.get(result, result)
    info(
        f"[{ttype}] {icon} | {symbol} {option_type} | "
        f"{sign}${abs(pnl_val):.2f} ({_fmt_pct(pnl_pct)}) | "
        f"Buy {_fmt_price(buy_price)} → Sell {_fmt_price(sell_price)} | "
        f"Entry: {entry_strategy} | Exit: {exit_reason} | Dur: {dur}"
    )

    # 2. trade.log rich block
    _append_trade_block(ttype, data, symbol, option_type, buy_price, sell_price,
                        pnl_val, pnl_pct, result, exit_reason, dur, peak_pct)

    # 3. Per-type CSV
    try:
        _write_csv_row(csv_path, fields, data)
    except Exception as ex:
        info(f"[logger] CSV write failed ({ttype}): {ex}")

    # 4. MongoDB (per-type collection)
    _mongo_insert_trade(ttype, data)


def _append_trade_block(ttype, data, symbol, option_type, buy_price, sell_price,
                        pnl, pnl_pct, result, exit_reason, dur, peak_pct) -> None:
    """Append one richly formatted trade block to trade.log."""
    now_str = datetime.now(CDT).strftime("%Y-%m-%d %H:%M:%S CDT")
    sep = "─" * 80
    sign = "+" if pnl >= 0 else "-"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"\n{sep}\n")
            f.write(f"[{now_str}]  {ttype} TRADE  |  {result}  |  {symbol}\n")
            f.write(f"{sep}\n")

            # Contract
            f.write(f"  Contract    : {data.get('contract_name','—')}\n")
            f.write(
                f"  Type        : {option_type}  |  Strike: {data.get('strike_price','—')}"
                f"  |  Expiry: {data.get('expiry','—')}  |  Qty: {data.get('qty',1)}\n"
            )

            # P&L
            f.write(
                f"  P&L         : {sign}${abs(pnl):.2f}  ({_fmt_pct(pnl_pct)})"
                f"  |  Peak: {_fmt_pct(peak_pct)}\n"
            )
            f.write(f"  Prices      : Buy {_fmt_price(buy_price)}  →  Sell {_fmt_price(sell_price)}\n")

            # Exit
            f.write(f"  Exit Reason : {exit_reason}  |  Duration: {dur}\n")
            if any(data.get(k) is not None for k in ("exit_sl_pct", "exit_qp_pct", "exit_tp_pct")):
                f.write(
                    f"  Exit Levels : SL {_fmt_pct(data.get('exit_sl_pct'))}"
                    f"  QP {_fmt_pct(data.get('exit_qp_pct'))}"
                    f"  TP {_fmt_pct(data.get('exit_tp_pct'))}\n"
                )

            # Lifecycle timestamps
            if ttype == "AIT":
                f.write(
                    f"  Entry Strategy: {_fmt_list(data.get('entry_strategy_names') or data.get('entry_strategies'))}\n"
                )
                f.write(
                    f"  Entry Signal: {_fmt_ts(data.get('entry_signal_time'))}"
                    f"  (cross: {_fmt_ts(data.get('entry_cross_time'))})\n"
                )
                f.write(f"  Buy Filled  : {_fmt_ts(data.get('buy_filled_time'))}\n")
                f.write(f"  Exit Signal : {_fmt_ts(data.get('exit_signal_time'))}\n")
                f.write(f"  Sell Filled : {_fmt_ts(data.get('sell_filled_time'))}\n")
            elif ttype == "STRADDLE":
                f.write(
                    f"  Entry       : {_fmt_ts(data.get('entry_signal_time') or data.get('buy_filled_time'))}\n"
                )
                f.write(f"  Exit Signal : {_fmt_ts(data.get('exit_signal_time'))}\n")
                f.write(f"  Sell Filled : {_fmt_ts(data.get('sell_filled_time'))}\n")
            else:  # MANUAL
                f.write(
                    f"  Entry       : {_fmt_ts(data.get('entry_time') or data.get('buy_filled_time'))}\n"
                )
                f.write(
                    f"  Exit        : {_fmt_ts(data.get('exit_time') or data.get('sell_filled_time'))}\n"
                )

            # Order IDs
            f.write(f"  Buy Order   : {data.get('buy_order_id','—')}\n")
            f.write(f"  Sell Order  : {data.get('sell_order_id','—')}\n")

            timeline = data.get("timeline") or []
            order_ticks = [
                t for t in timeline
                if isinstance(t, dict) and t.get("source") in ("order_placed", "order_replaced")
            ]
            if order_ticks:
                f.write(f"  ── Limit Order Lifecycle ─────────────────────────────────────\n")
                for tick in order_ticks:
                    f.write(f"  • {_fmt_order_audit_line(tick)}\n")

            # Last sell tick summary (store whether sell was MARKET or LIMIT and reason)
            sell_tick = None
            for t in reversed(timeline):
                if isinstance(t, dict) and t.get("source") == "sell":
                    sell_tick = t
                    break

            if sell_tick:
                sell_ts = _fmt_ts(sell_tick.get("ts"))
                sell_price = _fmt_price(sell_tick.get("sellable_price") or sell_tick.get("sell_price") or data.get("sell_price"))
                sell_reason = sell_tick.get("exit_reason") or data.get("exit_reason") or "-"

                # Infer method: prefer LIMIT if any order_placed/replaced tick exists with a limit/stop price
                method = "MARKET"
                for ot in order_ticks:
                    if ot.get("limit_price") is not None or ot.get("stop_price") is not None:
                        method = "LIMIT"
                        break

                f.write(f"  Last Tick    : {sell_ts} | Sell {sell_price} | Method: {method} | Reason: {sell_reason}\n")
                # Include sell order id/time if present
                sell_oid = data.get("sell_order_id") or sell_tick.get("order_id")
                if sell_oid:
                    f.write(f"  Sell Order ID: {sell_oid}  |  Sell Filled: {_fmt_ts(data.get('sell_filled_time') or sell_tick.get('filled_at'))}\n")

            # AIT indicators
            if ttype == "AIT":
                f.write(f"  ── Entry Indicators ──────────────────────────────────────────\n")
                f.write(
                    f"  RSI: {data.get('entry_rsi','—')}  "
                    f"RSI-MA: {data.get('entry_rsi_ma','—')}  "
                    f"Δ: {data.get('entry_rsi_delta','—')}  "
                    f"Gap: {data.get('entry_rsi_ma_gap','—')}\n"
                )
                f.write(
                    f"  EMA Fast: {data.get('entry_ema_fast','—')}  "
                    f"EMA Slow: {data.get('entry_ema_slow','—')}  "
                    f"Bullish: {data.get('entry_ema_bullish','—')}\n"
                )
                f.write(
                    f"  Vol×: {data.get('entry_volume_ratio','—')}  "
                    f"Body: {data.get('entry_body_ratio','—')}  "
                    f"Pullback: {data.get('entry_pullback_pct','—')}%\n"
                )
                f.write(
                    f"  Streak ↑{data.get('entry_up_streak','—')} ↓{data.get('entry_down_streak','—')}  "
                    f"Trend: {data.get('entry_trend','—')}  "
                    f"VWAP: {_fmt_price(data.get('entry_vwap'))}  "
                    f"Above: {data.get('entry_price_above_vwap','—')}\n"
                )
                f.write(
                    f"  Underlying  : {_fmt_price(data.get('entry_underlying_price'))}\n"
                )
                filters = data.get("entry_filters_passed") or []
                if filters:
                    f.write(f"  Filters     : {', '.join(str(x) for x in filters)}\n")

            f.write(f"{sep}\n")
    except Exception as ex:
        info(f"[logger] trade.log write failed: {ex}")


def _mongo_insert_trade(ttype: str, data: dict) -> None:
    """Insert one completed trade into its dedicated MongoDB collection."""
    col = {"AIT": _ait_col, "STRADDLE": _straddle_col, "MANUAL": _manual_col}.get(ttype)
    if col is None:
        return
    try:
        col.insert_one(_to_mongo_safe(dict(data)))
        debug(f"[logger] MongoDB insert OK ({ttype}) trade_id={data.get('trade_id')}")
    except Exception as ex:
        info(f"[logger] MongoDB insert failed ({ttype}): {ex}")
        _append_system_log(f"MongoDB insert failed ({ttype}): {str(ex)[:150]}")


# ─────────────────────────────────────────────────────────────────────────────
# Legacy helpers kept for main.py / write_log compatibility
# ─────────────────────────────────────────────────────────────────────────────

def _trade_key(payload: dict) -> str:
    contract_no = str(payload.get("contract_no") or "").strip()
    if contract_no:
        return contract_no

    contract = str(payload.get("contract") or "").strip()
    signal = str(payload.get("signal") or payload.get("trade_side") or "").strip()
    return f"{contract}|{signal}"


def _to_time_12h(timestamp_value: str | None) -> str:
    if not timestamp_value:
        return datetime.now(tz=CST).strftime("%I:%M:%S %p")

    try:
        ts = datetime.fromisoformat(str(timestamp_value))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=CST)
        return ts.astimezone(CST).strftime("%I:%M:%S %p")
    except Exception:
        pass

    try:
        ts = datetime.strptime(str(timestamp_value), "%Y-%m-%d %H:%M:%S %Z")
        return ts.strftime("%I:%M:%S %p")
    except Exception:
        return datetime.now(tz=CST).strftime("%I:%M:%S %p")


def _format_strike(value) -> str:
    try:
        strike = float(value)
        if strike.is_integer():
            return str(int(strike))
        return f"{strike:.2f}".rstrip("0").rstrip(".")
    except Exception:
        return str(value or "")


def _symbol_name(symbol: str) -> str:
    names = {
        "SPY": "S&P 500 ETF",
    }
    return names.get(symbol.upper(), symbol)


def _direction_from_signal(signal: str) -> str:
    sig = signal.upper()
    if sig == "CALL":
        return "uptrend"
    if sig == "PUT":
        return "downtrend"
    return "unknown"


def _option_type_from_signal(signal: str) -> str:
    sig = signal.upper()
    if sig == "CALL":
        return "call"
    if sig == "PUT":
        return "put"
    return "unknown"


def _capture_buy_context(payload: dict) -> None:
    key = _trade_key(payload)
    try:
        buy_price = float(payload.get("fill_price"))
    except Exception:
        return

    buy_filled_time = str(payload.get("buy_filled_time") or payload.get("timestamp") or "")
    entry_signal_time = str(payload.get("entry_signal_time") or payload.get("bar_time") or buy_filled_time)

    _open_trade_context[key] = {
        "symbol": str(payload.get("symbol") or ""),
        "contract_name": str(payload.get("contract") or ""),
        "strike_price": _format_strike(payload.get("strike")),
        "option_type": _option_type_from_signal(str(payload.get("signal") or payload.get("trade_side") or "")),
        "direction": _direction_from_signal(str(payload.get("signal") or payload.get("trade_side") or "")),
        "expiry": str(payload.get("expiry") or ""),
        "qty": int(payload.get("qty") or 1),
        "buy_price": buy_price,
        "entry_signal_time": _to_time_12h(entry_signal_time),
        "buy_filled_time": _to_time_12h(buy_filled_time),
        "entry_time": _to_time_12h(buy_filled_time),
    }


def _build_trade_document(payload: dict) -> dict | None:
    key = _trade_key(payload)
    buy_ctx = _open_trade_context.pop(key, None)
    if not buy_ctx:
        return None

    try:
        sell_price = float(payload.get("sell_price") or payload.get("fill_price"))
    except Exception:
        return None

    qty = int(buy_ctx.get("qty") or payload.get("qty") or 1)
    buy_price = float(buy_ctx.get("buy_price") or 0.0)
    pnl = (sell_price - buy_price) * qty * 100
    exit_signal_time = _to_time_12h(payload.get("exit_signal_time") or payload.get("timestamp"))
    sell_filled_time = _to_time_12h(payload.get("sell_filled_time") or payload.get("timestamp"))

    return {
        "symbol": buy_ctx.get("symbol") or str(payload.get("symbol") or ""),
        "name": _symbol_name(str(buy_ctx.get("symbol") or payload.get("symbol") or "")),
        "contract_name": buy_ctx.get("contract_name") or str(payload.get("contract") or ""),
        "strike_price": buy_ctx.get("strike_price") or _format_strike(payload.get("strike")),
        "option_type": buy_ctx.get("option_type") or _option_type_from_signal(str(payload.get("signal") or "")),
        "direction": buy_ctx.get("direction") or _direction_from_signal(str(payload.get("signal") or "")),
        "expiry": buy_ctx.get("expiry") or str(payload.get("expiry") or ""),
        "qty": qty,
        "buy_price": round(buy_price, 4),
        "sell_price": round(sell_price, 4),
        "pnl": round(pnl, 4),
        "result": "WIN" if pnl > 0 else ("LOSS" if pnl < 0 else "BREAKEVEN"),
        "exit_reason": str(payload.get("exit_reason") or ""),
        "entry_signal_time": str(buy_ctx.get("entry_signal_time") or _to_time_12h(None)),
        "buy_filled_time": str(buy_ctx.get("buy_filled_time") or _to_time_12h(None)),
        "exit_signal_time": exit_signal_time,
        "sell_filled_time": sell_filled_time,
        "entry_time": str(buy_ctx.get("buy_filled_time") or buy_ctx.get("entry_time") or _to_time_12h(None)),
        "exit_time": sell_filled_time,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _to_mongo_safe(value):
    if isinstance(value, dict):
        return {str(k): _to_mongo_safe(v) for k, v in value.items()}

    if isinstance(value, (list, tuple, set)):
        return [_to_mongo_safe(v) for v in value]

    if isinstance(value, uuid.UUID):
        return str(value)

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    # Handles enums and SDK model values that are not BSON-encodable by default.
    if hasattr(value, "value"):
        try:
            return _to_mongo_safe(value.value)
        except Exception:
            return str(value)

    return str(value)


def _append_system_log(message: str) -> None:
    timestamp = datetime.now(tz=CDT).strftime("%Y-%m-%d %H:%M:%S CDT")
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] SYSTEM | {message}\n")
    except Exception:
        pass

def info(message: str) -> None:
    print(message)

def debug(message: str) -> None:
    if DEBUG:
        print(f"[DEBUG] {message}")

def init_mongo() -> None:
    global _mongo_collection, _ait_col, _straddle_col, _manual_col, _mongo_ready

    if not MONGO_ENABLED:
        message = "MongoDB disabled via MONGO_ENABLED=false."
        info(message)
        _append_system_log(message)
        _mongo_ready = False
        _mongo_collection = _ait_col = _straddle_col = _manual_col = None
        if MONGO_REQUIRED:
            info("MongoDB is required (MONGO_REQUIRED=true). Exiting.")
            raise SystemExit(1)
        return

    try:
        from pymongo import MongoClient

        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        db = client[MONGO_DB_NAME]

        # Legacy collection — used by write_log (main.py)
        _mongo_collection = db[MONGO_COLLECTION_NAME]

        # Per-type collections
        _ait_col      = db["ait_trades"]
        _straddle_col = db["straddle_trades"]
        _manual_col   = db["manual_trades"]

        # Indexes for fast frontend queries
        for col in (_ait_col, _straddle_col, _manual_col):
            try:
                col.create_index([("symbol", 1), ("created_at", -1)])
            except Exception:
                pass

        _mongo_ready = True
        info(f"MongoDB connected — db: {MONGO_DB_NAME}  (ait_trades | straddle_trades | manual_trades | {MONGO_COLLECTION_NAME})")
        _append_system_log("MongoDB connection success — per-type collections ready")

    except Exception as ex:
        _mongo_ready = False
        _mongo_collection = _ait_col = _straddle_col = _manual_col = None
        info(f"MongoDB connection failed: {str(ex)[:150]}")
        _append_system_log(f"MongoDB connection failed: {str(ex)[:150]}")
        if MONGO_REQUIRED:
            info("MongoDB is required (MONGO_REQUIRED=true). Exiting.")
            raise SystemExit(1)

def validate_credentials() -> None:
    if (
        not API_KEY
        or not SECRET_KEY
        or API_KEY == "YOUR_API_KEY"
        or SECRET_KEY == "YOUR_SECRET_KEY"
    ):
        info("ERROR: Alpaca credentials are not set.")
        info("Set APCA_API_KEY_ID and APCA_API_SECRET_KEY environment variables.")
        raise SystemExit(1)

def init_log() -> None:
    os.makedirs(LOG_DIR, exist_ok=True)

    # trade.log
    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            f.write("=" * 80 + "\n")
            f.write("CAPE AIT — OPTION TRADING LOG\n")
            f.write(f"Started (CDT): {datetime.now(tz=CDT).strftime('%Y-%m-%d %H:%M:%S CDT')}\n")
            f.write("=" * 80 + "\n\n")

    # Legacy event CSV (trade_log.csv) — backward compat
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=LOG_FIELDS).writeheader()
    else:
        with open(CSV_FILE, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            current_fields = reader.fieldnames or []
            rows = list(reader)
        if any(field not in current_fields for field in LOG_FIELDS):
            with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=LOG_FIELDS, extrasaction="ignore")
                writer.writeheader()
                for row in rows:
                    writer.writerow(row)

    # Per-type trade CSVs
    _ensure_csv(AIT_CSV,      _AIT_FIELDS)
    _ensure_csv(STRADDLE_CSV, _STRADDLE_FIELDS)
    _ensure_csv(MANUAL_CSV,   _MANUAL_FIELDS)

    init_mongo()

def write_log(row: dict) -> None:
    payload = dict(row)
    timestamp = datetime.now(tz=CDT).strftime("%Y-%m-%d %H:%M:%S CDT")
    payload.setdefault("timestamp", timestamp)

    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(
            f"[{timestamp}] {payload.get('action', 'UNKNOWN')} | "
            f"Sym: {payload.get('symbol')} | Sig: {payload.get('signal')} | "
            f"OID: {payload.get('order_id')} | St: {payload.get('status')}"
        )

        if payload.get("obr_bartime") and payload.get("price_bartime"):
            f.write(
                f" | OBR_t: {payload.get('obr_bartime')} | "
                f"Px_t: {payload.get('price_bartime')}"
            )
        elif payload.get("price_bartime"):
            f.write(f" | Px_t: {payload.get('price_bartime')}")
        elif payload.get("obr_bartime"):
            f.write(f" | OBR_t: {payload.get('obr_bartime')}")

        if payload.get("bar_time"):
            f.write(f" | bar_time: \"{payload.get('bar_time')}\"")

        if payload.get("price") is not None:
            try:
                f.write(f" | price: {float(payload.get('price')):.3f}")
            except (TypeError, ValueError):
                f.write(f" | price: {payload.get('price')}")

        if payload.get("fill_price") is not None:
            try:
                fill_value = float(payload["fill_price"])
                f.write(
                    f" | Fill: {fill_value:.4f} | "
                    f"TP: {payload.get('tp_price')} | SL: {payload.get('sl_price')}"
                )
            except (TypeError, ValueError):
                f.write(
                    f" | Fill: {payload.get('fill_price')} | "
                    f"TP: {payload.get('tp_price')} | SL: {payload.get('sl_price')}"
                )

        if payload.get("exit_reason"):
            f.write(
                f" | Exit: {payload['exit_reason']} | PnL: {payload.get('pnl_pct')}%"
            )

        f.write("\n")

    with open(CSV_FILE, "a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=LOG_FIELDS, extrasaction="ignore").writerow(payload)

    action = str(payload.get("action") or "")
    if action in ("BUY_FILLED", "STARTUP_BUY_FILLED"):
        _capture_buy_context(payload)

    if _mongo_ready and _mongo_collection is not None and action in ("SELL", "STARTUP_SELL"):
        try:
            mongo_doc = _build_trade_document(payload)
            if mongo_doc is None:
                debug("MongoDB trade doc skipped: missing buy context or sell price")
            else:
                insert_result = _mongo_collection.insert_one(_to_mongo_safe(mongo_doc))
                info(
                    "MongoDB trade write success: "
                    f"id={insert_result.inserted_id} contract={mongo_doc.get('contract_name')}"
                )
        except Exception as ex:
            err = f"MongoDB insert failed: {str(ex)[:150]}"
            info(err)
            _append_system_log(err)
            debug(err)

    debug(f"Log: {payload.get('action')}")

def format_session_summary(stats: dict) -> str:
    total = int(stats.get("total_trades", 0))
    wins = int(stats.get("wins", 0))
    losses = int(stats.get("losses", 0))
    breakeven = int(stats.get("breakeven", 0))
    gross_profit_pct = float(stats.get("gross_profit_pct", 0.0))
    gross_loss_pct = float(stats.get("gross_loss_pct", 0.0))
    net_pnl_pct = float(stats.get("net_pnl_pct", 0.0))

    win_rate = (wins / total * 100.0) if total > 0 else 0.0

    return (
        f"Trades={total} | Wins={wins} | Losses={losses} | Breakeven={breakeven} | "
        f"WinRate={win_rate:.1f}% | Profit%={gross_profit_pct:.2f} | "
        f"Loss%={gross_loss_pct:.2f} | NetPnL%={net_pnl_pct:.2f}"
    )

def log_shutdown_summary(symbol: str, stats: dict) -> None:
    summary = format_session_summary(stats)
    info("Session summary:")
    info(f" {summary}")
    write_log({"action": "SUMMARY", "symbol": symbol, "status": summary})
