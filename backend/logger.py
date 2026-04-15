import csv
import os
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from config import (
    API_KEY,
    CSV_FILE,
    DEBUG,
    LOG_DIR,
    LOG_FIELDS,
    LOG_FILE,
    MONGO_COLLECTION_NAME,
    MONGO_DB_NAME,
    MONGO_ENABLED,
    MONGO_REQUIRED,
    MONGO_URI,
    SECRET_KEY,
)


CST = ZoneInfo("America/Chicago")
_mongo_collection = None
_mongo_ready = False
_open_trade_context = {}


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
    timestamp = datetime.now(tz=CST).strftime("%Y-%m-%d %H:%M:%S %Z")
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{timestamp}] SYSTEM | {message}\n")
    except Exception:
        pass

def info(message: str) -> None:
    print(message)

def debug(message: str) -> None:
    if DEBUG:
        print(f"[DEBUG] {message}")

def init_mongo() -> None:
    global _mongo_collection, _mongo_ready

    if not MONGO_ENABLED:
        message = "MongoDB disabled via MONGO_ENABLED=false."
        info(message)
        _append_system_log(message)
        _mongo_ready = False
        _mongo_collection = None
        if MONGO_REQUIRED:
            info("MongoDB is required (MONGO_REQUIRED=true). Exiting.")
            raise SystemExit(1)
        return

    try:
        from pymongo import MongoClient

        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        _mongo_collection = client[MONGO_DB_NAME][MONGO_COLLECTION_NAME]
        _mongo_ready = True
        info("MongoDB connection success")
        info(f"MongoDB logging enabled: {MONGO_DB_NAME}.{MONGO_COLLECTION_NAME}")
        _append_system_log("MongoDB connection success")
        _append_system_log(f"MongoDB logging enabled: {MONGO_DB_NAME}.{MONGO_COLLECTION_NAME}")
    except Exception as ex:
        _mongo_ready = False
        _mongo_collection = None
        info(f"MongoDB connection failed: {str(ex)[:150]}")
        info(f"MongoDB logging unavailable: {str(ex)[:150]}")
        _append_system_log(f"MongoDB connection failed: {str(ex)[:150]}")
        _append_system_log(f"MongoDB logging unavailable: {str(ex)[:150]}")
        if MONGO_REQUIRED:
            info("MongoDB is required (MONGO_REQUIRED=true). Exiting.")
            raise SystemExit(1)
        return

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

    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, "w") as f:
            f.write("=" * 80 + "\n")
            f.write("OPTION TRADING LOG\n")
            f.write(f"Started (CST): {datetime.now(tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')}\n")
            f.write("=" * 80 + "\n\n")

    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            csv.DictWriter(f, fieldnames=LOG_FIELDS).writeheader()
    else:
        with open(CSV_FILE, "r", newline="") as f:
            reader = csv.DictReader(f)
            current_fields = reader.fieldnames or []
            rows = list(reader)

        if any(field not in current_fields for field in LOG_FIELDS):
            with open(CSV_FILE, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=LOG_FIELDS, extrasaction="ignore")
                writer.writeheader()
                for row in rows:
                    writer.writerow(row)

    init_mongo()

def write_log(row: dict) -> None:
    payload = dict(row)
    timestamp = datetime.now(tz=CST).strftime("%Y-%m-%d %H:%M:%S %Z")
    payload.setdefault("timestamp", timestamp)

    with open(LOG_FILE, "a") as f:
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

    with open(CSV_FILE, "a", newline="") as f:
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