"""Continuous monitor for already-open positions using live exit criteria."""

from datetime import datetime
import re
import threading
import time
from zoneinfo import ZoneInfo

from alpaca.data.historical import OptionHistoricalDataClient
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, OrderStatus
from pymongo import MongoClient

from config import (
    API_KEY,
    FILL_WAIT_SEC,
    MONGO_DB_NAME,
    MONGO_ENABLED,
    MONGO_REQUIRED,
    MONGO_URI,
    PAPER_TRADING,
    PRICE_POLL_SEC,
    SECRET_KEY,
    STOP_LOSS_PCT,
    TAKE_PROFIT_PCT,
)
from logger import debug, info
from monitoring import (
    _append_sell_tick,
    _append_timeline_tick,
    _evaluate_priority_exit,
    _init_exit_state,
    _iso_now_utc,
    _update_dynamic_thresholds,
    monitor_with_polling,
    monitor_with_websocket,
)
from order_execution import get_open_positions, place_market_order, wait_for_fill
from order_execution import get_externally_managed_symbols


_OPTION_RE = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
_monitor_thread: threading.Thread | None = None
_monitor_lock = threading.Lock()
_options_log_col = None
CST = ZoneInfo("America/Chicago")


def _init_mongo_collection() -> None:
    global _options_log_col
    if not MONGO_ENABLED:
        _options_log_col = None
        return
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        _options_log_col = client[MONGO_DB_NAME]["options_log"]
        info("[MONITOR] MongoDB logging enabled for monitor exits")
    except Exception as ex:
        _options_log_col = None
        debug(f"[MONITOR] Mongo init failed: {ex}")
        if MONGO_REQUIRED:
            raise


def _parse_contract_fields(symbol: str) -> tuple[str, str, str]:
    m = _OPTION_RE.match(symbol or "")
    if not m:
        return "unknown", "-", "-"
    yymmdd = m.group(2)
    option_type = "CALL" if m.group(3) == "C" else "PUT"
    strike_price = f"{int(m.group(4)) / 1000:.2f}"
    expiry = f"20{yymmdd[:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}"
    return option_type, strike_price, expiry


def _log_monitor_exit(
    symbol: str,
    qty: int,
    entry_price: float,
    sell_price: float,
    exit_reason: str,
    exit_state: dict,
    exit_signal_price: float | None = None,
    exit_signal_time: str | None = None,
) -> None:
    if _options_log_col is None:
        return
    try:
        option_type, strike_price, expiry = _parse_contract_fields(symbol)
        pnl_dollar = round((sell_price - entry_price) * qty * 100, 2)
        result = "WIN" if pnl_dollar > 0 else "LOSS" if pnl_dollar < 0 else "BREAKEVEN"
        now_cdt = datetime.now(CST)
        signal_time_iso = exit_signal_time or now_cdt.isoformat(timespec="seconds")
        signal_price = float(exit_signal_price) if exit_signal_price is not None else float(sell_price)
        _options_log_col.insert_one({
            "symbol": symbol,
            "contract_name": symbol,
            "direction": option_type,
            "option_type": option_type,
            "strike_price": strike_price,
            "expiry": expiry,
            "qty": qty,
            "buy_price": round(float(entry_price), 4),
            "sell_price": round(float(sell_price), 4),
            "pnl": pnl_dollar,
            "result": result,
            "exit_reason": exit_reason,
            "trade_type": "MONITOR_EXIT",
            "entry_signal_time": now_cdt.isoformat(timespec="seconds"),
            "entry_signal_price": round(float(entry_price), 4),
            "buy_filled_time": now_cdt.isoformat(timespec="seconds"),
            "buy_filled_price": round(float(entry_price), 4),
            "exit_signal_time": signal_time_iso,
            "exit_signal_price": round(float(signal_price), 4),
            "sell_filled_time": now_cdt.isoformat(timespec="seconds"),
            "sell_filled_price": round(float(sell_price), 4),
            "entry_time": now_cdt.isoformat(timespec="seconds"),
            "exit_time": now_cdt.isoformat(timespec="seconds"),
            "created_at": now_cdt,
            "peak_pnl_pct": round(float(exit_state.get("max_pnl_pct", 0.0)), 4),
            "exit_sl_pct": round(float(exit_state.get("sl_dynamic_pct", 0.0)), 4),
            "exit_qp_pct": round(float(exit_state.get("qp_dynamic_pct", 0.0)), 4),
            "exit_tp_pct": round(float(exit_state.get("tp_pct", 0.0)), 4),
            "timeline": exit_state.get("timeline") or [],
            "log_source": "position_monitor_loop",
        })
    except Exception as ex:
        debug(f"[MONITOR] Mongo exit write failed for {symbol}: {ex}")


def _parse_option(symbol: str) -> tuple[str | None, str | None]:
    m = _OPTION_RE.match(symbol or "")
    if not m:
        return None, None
    underlying = m.group(1)
    signal = "CALL" if m.group(3) == "C" else "PUT"
    return underlying, signal


def _cancel_pending_orders_for_symbol(tc: TradingClient, symbol: str) -> int:
    """Cancel all open/pending orders for a given symbol. Returns count cancelled."""
    cancelled = 0
    try:
        from alpaca.trading.requests import GetOrdersRequest
        from alpaca.trading.enums import QueryOrderStatus
        open_orders = tc.get_orders(
            filter=GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[symbol])
        )
        for order in open_orders:
            try:
                tc.cancel_order_by_id(str(order.id))
                cancelled += 1
                info(f"[MONITOR] Cancelled pending order {order.id} for {symbol}")
            except Exception:
                pass
    except Exception as ex:
        info(f"[MONITOR] Error fetching open orders for {symbol}: {ex}")
    if cancelled:
        time.sleep(1)  # brief pause for Alpaca to release held qty
    return cancelled


def close_position(
    tc: TradingClient,
    position_symbol: str,
    qty: int,
    reference_price: float | None = None,
) -> tuple[bool, float | None]:
    """Close a position via Alpaca close_position API and return (success, fill_price)."""
    # First cancel any pending orders that may be holding the qty
    _cancel_pending_orders_for_symbol(tc, position_symbol)

    try:
        # Use Alpaca's direct close_position — most reliable method
        response = tc.close_position(position_symbol)
        order_id = str(getattr(response, "id", ""))
        if order_id:
            filled_order = wait_for_fill(tc, order_id, FILL_WAIT_SEC)
            fill_price = float(filled_order.filled_avg_price or 0.0)
            if filled_order.status == OrderStatus.FILLED:
                info(f"[MONITOR] {position_symbol} closed via close_position at {fill_price:.4f}")
                return True, fill_price if fill_price > 0 else None
            info(f"[MONITOR] close_position order status: {filled_order.status}")
        else:
            info(f"[MONITOR] close_position returned no order ID for {position_symbol}")
    except Exception as ex:
        ex_str = str(ex).lower()
        if "position does not exist" in ex_str or "404" in ex_str:
            info(f"[MONITOR] {position_symbol} already closed externally")
            return True, None
        info(f"[MONITOR] close_position failed for {position_symbol}: {ex}")

    # Fallback: manual market sell
    try:
        position_obj = None
        for pos in tc.get_all_positions():
            if pos.symbol == position_symbol:
                position_obj = pos
                break
        if position_obj is None:
            info(f"[MONITOR] Position {position_symbol} no longer open")
            return True, None

        side = OrderSide.SELL if float(position_obj.qty or 0) > 0 else OrderSide.BUY
        order = place_market_order(
            tc, position_symbol, qty, side,
            reference_price=reference_price,
            allow_limit=False,
        )
        filled_order = wait_for_fill(tc, str(order.id), FILL_WAIT_SEC)
        fill_price = float(filled_order.filled_avg_price or 0.0)
        if filled_order.status == OrderStatus.FILLED:
            info(f"[MONITOR] {position_symbol} closed via market sell at {fill_price:.4f}")
            return True, fill_price if fill_price > 0 else None
        info(f"[MONITOR] Market sell failed for {position_symbol}: {filled_order.status}")
        try:
            tc.cancel_order_by_id(str(order.id))
        except Exception:
            pass
        return False, None
    except Exception as ex:
        info(f"[MONITOR] Error closing {position_symbol}: {ex}")
        return False, None


def monitor_position_loop(tc: TradingClient, odc: OptionHistoricalDataClient, symbol: str, entry_price: float, qty: int) -> None:
    """Monitor one existing open position and exit using configured criteria."""
    if symbol in get_externally_managed_symbols():
        info(f"[MONITOR] {symbol} reserved by dedicated monitor — skipping generic monitor thread")
        return

    tp_price = entry_price * (1 + TAKE_PROFIT_PCT)
    sl_price = entry_price * (1 - STOP_LOSS_PCT)
    info(f"[MONITOR] {symbol} tracking started | entry={entry_price:.4f} tp={tp_price:.4f} sl={sl_price:.4f}")

    underlying, signal = _parse_option(symbol)

    exit_reason = None
    exit_price = entry_price
    exit_state: dict = {}

    if underlying and signal:
        # Option contract path: full monitor stack (TP/SL, dynamic QP, trailing SL, RSI opposite cross).
        exit_reason, exit_price, exit_state = monitor_with_websocket(
            symbol,
            entry_price,
            tp_price,
            sl_price,
            context_label=f"OPENPOS {underlying} {signal}",
            signal=signal,
            underlying_symbol=underlying,
            tc=tc,
            qty=qty,
        )
        if exit_reason is None:
            # Pass whatever exit_state WS built (may have partial ticks) as initial state
            # so polling continues on the same timeline rather than starting fresh.
            ws_partial_state = exit_state if isinstance(exit_state, dict) and exit_state else None
            exit_reason, exit_price, exit_state = monitor_with_polling(
                odc,
                symbol,
                entry_price,
                tp_price,
                sl_price,
                context_label=f"OPENPOS {underlying} {signal}",
                signal=signal,
                underlying_symbol=underlying,
                tc=tc,
                qty=qty,
                initial_exit_state=ws_partial_state,
            )
    else:
        # Non-option fallback: price-based criteria (TP/SL, dynamic QP, trailing SL).
        exit_state = _init_exit_state(entry_price, tp_price, sl_price)
        _append_timeline_tick(
            exit_state, source="entry", tick_ts=_iso_now_utc(),
            fill_price=entry_price, mid_price=entry_price,
            bid_price=None, sellable_price=entry_price, pnl_pct=0.0,
        )
        while True:
            try:
                current = None
                for pos in tc.get_all_positions():
                    if pos.symbol == symbol:
                        current = pos
                        break
                if current is None:
                    info(f"[MONITOR] {symbol} closed externally")
                    return

                price = float(getattr(current, "current_price", 0.0) or 0.0)
                if price <= 0:
                    time.sleep(PRICE_POLL_SEC)
                    continue

                pnl_pct = (price - entry_price) / entry_price * 100
                _update_dynamic_thresholds(exit_state, pnl_pct)
                _append_timeline_tick(
                    exit_state, source="poll", tick_ts=_iso_now_utc(),
                    fill_price=entry_price, mid_price=price,
                    bid_price=None, sellable_price=price, pnl_pct=pnl_pct,
                )
                maybe_exit = _evaluate_priority_exit(pnl_pct, exit_state)
                if maybe_exit:
                    exit_reason = maybe_exit
                    exit_price = price
                    _append_sell_tick(exit_state, exit_reason, price, entry_price)
                    break
                time.sleep(PRICE_POLL_SEC)
            except Exception as ex:
                debug(f"[MONITOR] {symbol} fallback monitor error: {ex}")
                time.sleep(PRICE_POLL_SEC)

    exit_reason = exit_reason or "FORCED_EXIT_NO_SIGNAL"
    exit_signal_time_iso = datetime.now(CST).isoformat(timespec="seconds")

    # Before closing: check if the position is now registered in the bot registry
    # (e.g. a manual trade that was registered after this generic monitor started).
    # If so, defer to the dedicated monitor thread to avoid double-close and duplicate logs.
    managed_now = {str(lot.get("contract_symbol") or "") for lot in get_open_positions()}
    if symbol in managed_now:
        info(f"[MONITOR] {symbol} is managed by bot registry — deferring exit to dedicated thread")
        return

    # Retry sell up to 3 times before giving up
    ok = False
    fill_price = None
    for _attempt in range(3):
        ok, fill_price = close_position(tc, symbol, qty, reference_price=exit_price)
        if ok:
            break
        info(f"[MONITOR] Sell attempt {_attempt + 1}/3 failed for {symbol}, retrying in 5s...")
        time.sleep(5)

    if not ok:
        info(f"[MONITOR] All sell attempts failed for {symbol} ({exit_reason}). Will retry on next cycle.")
        return

    # fill_price is None when the position was already closed externally (e.g. by the
    # dedicated manual-trade monitor thread). Skip logging to prevent duplicate entries.
    if fill_price is None:
        info(f"[MONITOR] {symbol} already closed externally — skipping MONITOR_EXIT log")
        return

    final_price = fill_price
    pnl_pct = (final_price - entry_price) / entry_price * 100
    _es = exit_state or {}
    info(f"[MONITOR] Saving to MongoDB — timeline ticks: {len(_es.get('timeline') or [])}")
    _log_monitor_exit(
        symbol,
        qty,
        entry_price,
        final_price,
        exit_reason,
        _es,
        exit_signal_price=exit_price,
        exit_signal_time=exit_signal_time_iso,
    )
    info(
        f"[MONITOR] {symbol} EXIT={exit_reason} at {final_price:.4f} | pnl={pnl_pct:+.2f}% "
        f"| peak={_es.get('max_pnl_pct', 0.0):+.2f}% "
        f"sl={_es.get('sl_dynamic_pct', 0.0):+.2f}% "
        f"qp={_es.get('qp_dynamic_pct', 0.0):+.2f}%"
        )


def run_monitor_all_positions() -> None:
    """Continuously discover open positions and attach monitors."""
    _init_mongo_collection()
    tc = TradingClient(API_KEY, SECRET_KEY, paper=PAPER_TRADING)
    odc = OptionHistoricalDataClient(API_KEY, SECRET_KEY)
    active: dict[str, threading.Thread] = {}

    info("[MONITOR] Position loop started")
    while True:
        try:
            positions = tc.get_all_positions()

            # Positions already tracked by bot registry have dedicated per-trade
            # monitors (AIT/straddle flow). Skip attaching generic monitor threads
            # to avoid duplicate exits/log rows.
            managed_symbols = {
                str(lot.get("contract_symbol") or "")
                for lot in get_open_positions()
                if lot.get("status") != "CLOSED"
            }
            managed_symbols |= get_externally_managed_symbols()

            for pos in positions:
                symbol = str(getattr(pos, "symbol", "") or "")
                if not symbol:
                    continue

                if symbol in managed_symbols:
                    continue

                entry_price = float(getattr(pos, "avg_entry_price", 0.0) or 0.0)
                qty = int(abs(float(getattr(pos, "qty", 0) or 0)))
                if entry_price <= 0 or qty <= 0:
                    continue

                if symbol not in active or not active[symbol].is_alive():
                    t = threading.Thread(
                        target=monitor_position_loop,
                        args=(tc, odc, symbol, entry_price, qty),
                        daemon=True,
                        name=f"PosMonitor-{symbol}",
                    )
                    t.start()
                    active[symbol] = t
                    info(f"[MONITOR] Attached exit monitor for {symbol}")

            for symbol in list(active.keys()):
                if not active[symbol].is_alive():
                    del active[symbol]

            time.sleep(10)
        except Exception as ex:
            debug(f"[MONITOR] Loop error: {ex}")
            time.sleep(20)


def start_position_monitor_service() -> None:
    """Start singleton background monitor loop for already-open positions."""
    global _monitor_thread
    with _monitor_lock:
        if _monitor_thread is not None and _monitor_thread.is_alive():
            return
        _monitor_thread = threading.Thread(
            target=run_monitor_all_positions,
            daemon=True,
            name="PositionMonitorService",
        )
        _monitor_thread.start()
        info("[MONITOR] Background service started")


if __name__ == "__main__":
    run_monitor_all_positions()
