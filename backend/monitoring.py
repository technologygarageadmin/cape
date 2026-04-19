import time
import threading
import logging
from datetime import datetime, timezone

from alpaca.data.historical import OptionHistoricalDataClient
from alpaca.trading.requests import ReplaceOrderRequest, StopLimitOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus

from alpaca_helpers import (
    build_option_snapshot_request,
    extract_snapshot_for_symbol,
    extract_snapshot_mid_price,
)
from config import (
    API_KEY,
    EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE,
    EXIT_BAD_ENTRY_ENABLED,
    EXIT_BAD_ENTRY_EXIT_THRESHOLD_PCT,
    EXIT_BAD_ENTRY_MAX_PEAK_PCT,
    EXIT_BAD_ENTRY_WINDOW_SEC,
    EXIT_BREAKEVEN_ENABLED,
    EXIT_BREAKEVEN_TRIGGER_PCT,
    EXIT_MAX_HOLD_ENABLED,
    EXIT_MAX_HOLD_SEC,
    EXIT_MAX_HOLD_PNL_THRESHOLD_PCT,
    EXIT_MOMENTUM_STALL_ENABLED,
    EXIT_MOMENTUM_STALL_MIN_AGE_SEC,
    EXIT_MOMENTUM_STALL_PNL_THRESHOLD_PCT,
    EXIT_SAME_CANDLE_MIN_PNL_PCT,
    EXIT_SAME_CANDLE_USE_BID_PRICE,
    EXIT_RSI_OPPOSITE_CROSS_ENABLED,
    EXIT_TAKE_PROFIT_ENABLED,
    EXIT_TRAILING_STOP_ENABLED,
    EXIT_STOP_LOSS_ENABLED,
    PRICE_POLL_SEC,
    QP_GAP_PCT,
    RSI_EXIT_CHECK_SEC,
    SECRET_KEY,
    SL_STOP_LIMIT_BUFFER_PCT,
    SL_STOP_ORDERS_ENABLED,
    SYMBOL,
    TRAILING_MIN_PEAK_PCT,
    TRAILING_SL_STOP_ORDERS_ENABLED,
    WS_MAX_WAIT_SEC,
    WS_ORDER_CHECK_SEC,
)
from logger import debug, info
from order_execution import set_live_exit_reason, update_live_exit_state
from rsi_analyer import analyze_rsi


_WS_MONITOR_LOCK = threading.Lock()
_WS_FIRST_QUOTE_TIMEOUT_SEC = 12
_WS_COOLDOWN_AFTER_FAIL_SEC = 15 * 60
_ws_cooldown_until = 0.0

# Prevent repeated Alpaca websocket auth tracebacks from flooding console/logs.
logging.getLogger("alpaca.data.live.websocket").setLevel(logging.CRITICAL)


def _init_exit_state(fill_price: float, tp_price: float, sl_price: float) -> dict:
    tp_pct = ((tp_price / fill_price) - 1.0) * 100.0
    sl_pct = ((sl_price / fill_price) - 1.0) * 100.0
    # QP starts at 0% and ratchets up with the trade — never reduced.
    # Gap shrinks as profit grows so we lock in more of larger moves.
    qp_gap_pct = QP_GAP_PCT   # lock in peak minus QP_GAP_PCT (tight lock from the start)
    return {
        "fill_price": fill_price,
        "tp_pct": tp_pct,
        "sl_static_pct": sl_pct,
        "sl_dynamic_pct": sl_pct,
        "qp_floor_pct": 0.0,        # dynamic QP starts at 0%
        "qp_dynamic_pct": 0.0,      # will build up as price moves
        "qp_gap_pct": qp_gap_pct,
        "max_pnl_pct": 0.0,
        "qp_armed": False,
        "qp_arm_time": None,
        "qp_arm_price": None,
        "qp_arm_pnl_pct": None,
        "qp_arm_peak_pct": None,
        "is_closing": False,
        "tp_order_ids": [],
        "tp_order_filled": False,
        "tp_order_id_filled": None,
        "tp_order_fill_price": None,
        "sl_order_ids": [],          # all live SL stop-limit orders (accumulate, never cancel until one fills)
        "sl_order_filled": False,
        "sl_order_id_filled": None,
        "sl_order_fill_price": None,
        "sl_order_exit_reason": None,
        "sl_last_placed_pct": None,    # sl_dynamic_pct value at which the last SL order was placed
        "timeline": [],
    }


def _iso_now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _append_timeline_tick(
    exit_state: dict,
    *,
    source: str,
    tick_ts: str,
    fill_price: float,
    mid_price: float | None,
    bid_price: float | None,
    sellable_price: float,
    pnl_pct: float,
) -> None:
    timeline = exit_state.setdefault("timeline", [])
    tick_actions = dict(exit_state.get("last_tick_actions") or {})

    tp_pct = float(exit_state.get("tp_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    qp_dynamic_pct = float(exit_state.get("qp_dynamic_pct", 0.0))
    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))

    qp_limit_price = None
    if fill_price > 0 and qp_dynamic_pct > 0:
        qp_limit_price = round(fill_price * (1.0 + qp_dynamic_pct / 100.0), 4)

    live_qp = len(exit_state.get("tp_order_ids") or []) > 0
    sl_order_ids = exit_state.get("sl_order_ids") or []
    sl_exit_reason = exit_state.get("sl_order_exit_reason") or ""
    live_sl = len(sl_order_ids) > 0 and sl_exit_reason != "TRAILING_STOP_EXIT"
    live_tsl = len(sl_order_ids) > 0 and sl_exit_reason == "TRAILING_STOP_EXIT"

    tick = {
        "ts": tick_ts,
        "source": source,
        "mid_price": round(float(mid_price), 4) if mid_price is not None else None,
        "bid_price": round(float(bid_price), 4) if bid_price is not None else None,
        "sellable_price": round(float(sellable_price), 4),
        "pnl_pct": round(float(pnl_pct), 4),
        "pnl_dollar_per_contract": round((float(sellable_price) - float(fill_price)) * 100.0, 4),
        "tp_pct": round(tp_pct, 4),
        "sl_static_pct": round(sl_static_pct, 4),
        "sl_dynamic_pct": round(sl_dynamic_pct, 4),
        "qp_dynamic_pct": round(qp_dynamic_pct, 4),
        "qp_limit_price": qp_limit_price,
        "max_pnl_pct": round(max_pnl_pct, 4),
        "qp_armed": bool(exit_state.get("qp_armed", False)),
        "live_qp": live_qp,
        "live_sl": live_sl,
        "live_tsl": live_tsl,
        "tp_action": tick_actions.get("tp_action", "NO_CHANGE"),
        "tp_price": tick_actions.get("tp_price"),
        "sl_action": tick_actions.get("sl_action", "NO_CHANGE"),
        "sl_prev_pct": tick_actions.get("sl_prev_pct"),
        "sl_new_pct": tick_actions.get("sl_new_pct"),
        "sl_prev_price": tick_actions.get("sl_prev_price"),
        "sl_new_price": tick_actions.get("sl_new_price"),
        "sl_order_action": tick_actions.get("sl_order_action", "NO_CHANGE"),
        "sl_order_prev_id": tick_actions.get("sl_order_prev_id"),
        "sl_order_new_id": tick_actions.get("sl_order_new_id"),
        "sl_update_reason": tick_actions.get("sl_update_reason"),
    }
    timeline.append(tick)
    if "last_tick_actions" in exit_state:
        exit_state.pop("last_tick_actions", None)


def _append_sell_tick(
    exit_state: dict,
    exit_reason: str,
    sell_price: float,
    fill_price: float,
    *,
    bid_price: float | None = None,
    mid_price: float | None = None,
) -> None:
    """Append a 'sell' source tick marking the actual exit event on the timeline."""
    pnl_pct = (sell_price - fill_price) / fill_price * 100 if fill_price > 0 else 0.0
    _append_timeline_tick(
        exit_state,
        source="sell",
        tick_ts=_iso_now_utc(),
        fill_price=fill_price,
        mid_price=mid_price,
        bid_price=bid_price,
        sellable_price=sell_price,
        pnl_pct=pnl_pct,
    )
    # Tag the exit reason onto the last (just-appended) tick
    timeline = exit_state.get("timeline")
    if timeline:
        timeline[-1]["exit_reason"] = exit_reason


def _check_tp_order_filled(tc, exit_state: dict) -> bool:
    """Check if any TP order filled. On fill: cancel remaining TP and all SL/QP orders."""
    if tc is None:
        return False
    order_ids = list(exit_state.get("tp_order_ids") or [])
    if not order_ids:
        return False

    filled_id = None
    filled_price = None
    for oid in order_ids:
        try:
            order = tc.get_order_by_id(oid)
            status = str(getattr(order, "status", "")).lower()
            if "filled" in status:
                filled_id = oid
                fp = float(getattr(order, "filled_avg_price", 0) or 0)
                filled_price = fp if fp > 0 else None
                break
        except Exception:
            pass

    if not filled_id:
        return False

    timeline = exit_state.setdefault("timeline", [])
    for oid in order_ids:
        if oid != filled_id:
            try:
                tc.cancel_order_by_id(oid)
                for t in timeline:
                    if t.get("source") == "order_placed" and t.get("order_id") == oid:
                        t["status"] = "cancelled"
                        break
            except Exception:
                pass

    for t in timeline:
        if t.get("source") == "order_placed" and t.get("order_id") == filled_id:
            t["status"] = "filled"
            if filled_price:
                t["fill_price"] = filled_price
            break

    exit_state["tp_order_ids"] = []
    exit_state["tp_order_filled"] = True
    exit_state["tp_order_id_filled"] = filled_id
    exit_state["tp_order_fill_price"] = filled_price
    _cancel_sl_orders(tc, exit_state)
    info(f"[TP] Order {filled_id} filled at {filled_price:.4f}")
    return True


def _cancel_tp_orders(tc, exit_state: dict) -> None:
    """Cancel ALL outstanding TP child orders."""
    if tc is None:
        return
    order_ids = exit_state.get("tp_order_ids") or []
    for oid in order_ids:
        try:
            tc.cancel_order_by_id(oid)
            info(f"[TP] Cancelled {oid}")
        except Exception:
            pass
    exit_state["tp_order_ids"] = []


def _place_sl_stop_order(tc, exit_state: dict, contract_symbol: str | None, qty: int) -> dict | None:
    """Place or replace SL stop-limit sell at the current sl_dynamic_pct level."""
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", 0))
    is_trailing = sl_dynamic_pct > float(exit_state.get("sl_static_pct", 0))
    if tc is None or not contract_symbol:
        return None
    fill_price = float(exit_state.get("fill_price", 0))
    if fill_price <= 0:
        return None
    stop_price = round(round(fill_price * (1.0 + sl_dynamic_pct / 100.0), 4), 2)
    limit_price = round(round(stop_price * (1.0 - SL_STOP_LIMIT_BUFFER_PCT / 100.0), 4), 2)
    label = "TRAIL SL" if is_trailing else "SL"
    timeline = exit_state.setdefault("timeline", [])
    existing_ids = list(exit_state.get("sl_order_ids") or [])
    existing_id = existing_ids[0] if existing_ids else None
    try:
        if existing_id:
            replaced = tc.replace_order_by_id(
                existing_id,
                ReplaceOrderRequest(stop_price=stop_price, limit_price=limit_price),
            )
            new_id = str(getattr(replaced, "id", existing_id) or existing_id)
            exit_state["sl_order_ids"] = [new_id]
            exit_state["sl_last_placed_pct"] = sl_dynamic_pct
            timeline.append({
                "ts": _iso_now_utc(),
                "source": "order_replaced",
                "order_type": "TRAIL_SL_STOP" if is_trailing else "SL_STOP",
                "order_id": new_id,
                "prev_order_id": existing_id,
                "limit_price": limit_price,
                "stop_price": stop_price,
                "pct": round(sl_dynamic_pct, 4),
                "status": "live",
            })
            info(
                f"[{label} STOP] {contract_symbol} replaced id={existing_id} -> {new_id} "
                f"stop={stop_price:.4f} limit={limit_price:.4f} (sl={sl_dynamic_pct:+.2f}%)"
            )
            return {
                "operation": "replaced",
                "prev_order_id": existing_id,
                "new_order_id": new_id,
                "stop_price": stop_price,
                "limit_price": limit_price,
                "sl_dynamic_pct": sl_dynamic_pct,
            }

        req = StopLimitOrderRequest(
            symbol=contract_symbol,
            qty=qty,
            side=OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
            stop_price=stop_price,
            limit_price=limit_price,
        )
        order = tc.submit_order(req)
        exit_state["sl_order_ids"] = [str(order.id)]
        exit_state["sl_last_placed_pct"] = sl_dynamic_pct
        timeline.append({
            "ts": _iso_now_utc(),
            "source": "order_placed",
            "order_type": "TRAIL_SL_STOP" if is_trailing else "SL_STOP",
            "order_id": str(order.id),
            "limit_price": limit_price,
            "stop_price": stop_price,
            "pct": round(sl_dynamic_pct, 4),
            "order_count": 1,
            "status": "live",
        })
        info(
            f"[{label} STOP] {contract_symbol} stop={stop_price:.4f} limit={limit_price:.4f} "
            f"(sl={sl_dynamic_pct:+.2f}%) id={order.id}"
        )
        return {
            "operation": "placed",
            "prev_order_id": None,
            "new_order_id": str(order.id),
            "stop_price": stop_price,
            "limit_price": limit_price,
            "sl_dynamic_pct": sl_dynamic_pct,
        }
    except Exception as ex:
        info(f"[{label} STOP] Failed to upsert for {contract_symbol}: {ex}")
        timeline.append({
            "ts": _iso_now_utc(),
            "source": "order_placed" if not existing_id else "order_replaced",
            "order_type": "TRAIL_SL_STOP" if is_trailing else "SL_STOP",
            "order_id": None,
            "prev_order_id": existing_id,
            "limit_price": limit_price,
            "stop_price": stop_price,
            "pct": round(sl_dynamic_pct, 4),
            "order_count": len(exit_state.get("sl_order_ids") or []),
            "status": "error",
            "error": str(ex),
        })
        return {
            "operation": "error",
            "prev_order_id": existing_id,
            "new_order_id": None,
            "stop_price": stop_price,
            "limit_price": limit_price,
            "sl_dynamic_pct": sl_dynamic_pct,
            "error": str(ex),
        }


def _cancel_sl_orders(tc, exit_state: dict) -> None:
    """Cancel ALL outstanding SL stop-limit orders."""
    if tc is None:
        return
    order_ids = exit_state.get("sl_order_ids") or []
    for oid in order_ids:
        try:
            tc.cancel_order_by_id(oid)
            info(f"[SL STOP] Cancelled {oid}")
        except Exception:
            pass
    exit_state["sl_order_ids"] = []


def _check_sl_order_filled(tc, exit_state: dict) -> bool:
    """Check if any SL stop-limit order filled. On fill: cancel remaining SL + all QP orders."""
    if tc is None:
        return False
    order_ids = list(exit_state.get("sl_order_ids") or [])
    if not order_ids:
        return False
    filled_id = None
    filled_price = None
    for oid in order_ids:
        try:
            order = tc.get_order_by_id(oid)
            status = str(getattr(order, "status", "")).lower()
            if "filled" in status:
                filled_id = oid
                fp = float(getattr(order, "filled_avg_price", 0) or 0)
                filled_price = fp if fp > 0 else None
                break
        except Exception:
            pass
    if filled_id:
        timeline = exit_state.setdefault("timeline", [])
        for oid in order_ids:
            if oid != filled_id:
                try:
                    tc.cancel_order_by_id(oid)
                    info(f"[SL STOP] Cancelled remaining SL order {oid} after fill")
                    for t in timeline:
                        if t.get("source") == "order_placed" and t.get("order_id") == oid:
                            t["status"] = "cancelled"
                            break
                except Exception:
                    pass
        # Mark the filled order row
        for t in timeline:
            if t.get("source") == "order_placed" and t.get("order_id") == filled_id:
                t["status"] = "filled"
                if filled_price:
                    t["fill_price"] = filled_price
                break
        exit_state["sl_order_ids"] = []
        exit_state["sl_order_filled"] = True
        exit_state["sl_order_id_filled"] = filled_id
        exit_state["sl_order_fill_price"] = filled_price
        exit_state["sl_order_exit_reason"] = "STOP_LOSS_EXIT"
        info(
            f"[SL STOP] Order {filled_id} filled at {filled_price:.4f} — "
            f"{len(order_ids)-1} other SL orders cancelled → {exit_state['sl_order_exit_reason']}"
        )
        return True
    return False


def _cancel_exit_orders(tc, exit_state: dict) -> None:
    """Cancel all outstanding exit protection orders (TP + SL stop-limit)."""
    exit_state["is_closing"] = True
    _cancel_tp_orders(tc, exit_state)
    _cancel_sl_orders(tc, exit_state)


def _update_dynamic_thresholds(
    exit_state: dict,
    pnl_pct: float,
    current_price: float | None = None,
    tick_ts: str | None = None,
    tc=None,
    contract_symbol: str | None = None,
    qty: int = 1,
) -> None:
    fill_price = float(exit_state.get("fill_price", 0.0) or 0.0)

    if pnl_pct > float(exit_state.get("max_pnl_pct", 0.0)):
        exit_state["max_pnl_pct"] = pnl_pct

    if bool(exit_state.get("is_closing", False)):
        return

    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    qp_gap_pct = float(exit_state.get("qp_gap_pct", 0.0))
    tp_pct = float(exit_state.get("tp_pct", 0.0))
    prev_sl_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))

    def _pct_to_price(pct: float) -> float | None:
        if fill_price <= 0:
            return None
        return round(fill_price * (1.0 + pct / 100.0), 4)

    tick_actions = {
        "tp_action": "NO_CHANGE",
        "tp_price": _pct_to_price(tp_pct),
        "sl_action": "NO_CHANGE",
        "sl_prev_pct": round(prev_sl_pct, 4),
        "sl_new_pct": round(prev_sl_pct, 4),
        "sl_prev_price": _pct_to_price(prev_sl_pct),
        "sl_new_price": _pct_to_price(prev_sl_pct),
        "sl_order_action": "NO_CHANGE",
        "sl_update_reason": None,
    }

    # ── Breakeven stop: once peak reaches trigger, floor SL at 0% ──
    # Prevents giving back all gains on trades that showed real promise.
    if EXIT_BREAKEVEN_ENABLED and max_pnl_pct >= EXIT_BREAKEVEN_TRIGGER_PCT:
        sl_floor = 0.0  # breakeven
        exit_state["sl_dynamic_pct"] = max(float(exit_state.get("sl_dynamic_pct", sl_static_pct)), sl_floor)

    # ── Scaled trailing SL ──
    # Trail tightens as profit grows: 60% at <3%, 50% at 3-5%, 40% at 5-7%, 35% at 7%+
    # Tighter low-peak trail (60%) keeps more profit on small moves that tend to reverse.
    if max_pnl_pct > 0:
        if max_pnl_pct >= 7.0:
            trail_ratio = 0.35
        elif max_pnl_pct >= 5.0:
            trail_ratio = 0.40
        elif max_pnl_pct >= 3.0:
            trail_ratio = 0.50
        else:
            trail_ratio = 0.60
        trail_pct = max(sl_static_pct, -(max_pnl_pct * trail_ratio))
        candidate_sl = max_pnl_pct + trail_pct
        exit_state["sl_dynamic_pct"] = max(float(exit_state.get("sl_dynamic_pct", sl_static_pct)), candidate_sl)

    # Ratchet quick-profit lock upward — never reduced.
    # qp_dynamic = peak - gap, so if peak = 2.35% and gap = 0.25%, QP = 2.10%.
    # QP is used only as an SL floor; it does not place its own exit order.
    candidate_qp = max_pnl_pct - qp_gap_pct
    # Only ratchet up, never down. Ignore negative candidates (too early).
    if candidate_qp > float(exit_state.get("qp_dynamic_pct", 0.0)):
        exit_state["qp_dynamic_pct"] = candidate_qp
        current_sl = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
        exit_state["sl_dynamic_pct"] = max(current_sl, candidate_qp)

    # Capture first arm event with the actual arm price and pnl.
    if candidate_qp > 0.0 and not bool(exit_state.get("qp_armed", False)):
        exit_state["qp_armed"] = True
        exit_state["qp_arm_time"] = tick_ts or _iso_now_utc()
        exit_state["qp_arm_price"] = round(float(current_price), 4) if current_price is not None else None
        exit_state["qp_arm_pnl_pct"] = round(float(pnl_pct), 4)
        exit_state["qp_arm_peak_pct"] = round(float(max_pnl_pct), 4)

    current_sl_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    if current_sl_pct > prev_sl_pct:
        tick_actions["sl_action"] = "UPDATED"
        tick_actions["sl_new_pct"] = round(current_sl_pct, 4)
        tick_actions["sl_new_price"] = _pct_to_price(current_sl_pct)
        tick_actions["sl_update_reason"] = "QP_OR_TRAILING_PUSH"

    # ── SL stop-limit order: keep exactly one live order at current dynamic SL ──
    sl_last_placed = exit_state.get("sl_last_placed_pct")
    sl_order_result = None
    if sl_last_placed is None or current_sl_pct > float(sl_last_placed):
        sl_order_result = _place_sl_stop_order(tc, exit_state, contract_symbol, qty)

    if tick_actions["sl_action"] == "UPDATED":
        if sl_order_result and sl_order_result.get("operation") == "replaced":
            tick_actions["sl_order_action"] = "CANCEL_OLD_SL_AND_PLACE_NEW_SL"
            tick_actions["sl_order_prev_id"] = sl_order_result.get("prev_order_id")
            tick_actions["sl_order_new_id"] = sl_order_result.get("new_order_id")
        elif sl_order_result and sl_order_result.get("operation") == "placed":
            tick_actions["sl_order_action"] = "PLACE_INITIAL_SL_ORDER"
            tick_actions["sl_order_new_id"] = sl_order_result.get("new_order_id")
        elif sl_order_result and sl_order_result.get("operation") == "error":
            tick_actions["sl_order_action"] = "SL_UPDATE_FAILED"
            tick_actions["sl_order_prev_id"] = sl_order_result.get("prev_order_id")
            tick_actions["sl_order_new_id"] = sl_order_result.get("new_order_id")

    exit_state["last_tick_actions"] = tick_actions


def _evaluate_priority_exit(
    pnl_pct: float,
    exit_state: dict,
    use_extended_exit_criteria: bool = True,
) -> str | None:
    tp_pct = float(exit_state.get("tp_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))

    # Priority 1: full TP / full SL.
    if EXIT_TAKE_PROFIT_ENABLED and pnl_pct >= tp_pct:
        return "TAKE_PROFIT_EXIT"
    if EXIT_STOP_LOSS_ENABLED and pnl_pct <= sl_static_pct:
        return "STOP_LOSS_EXIT"

    if not use_extended_exit_criteria:
        return None

    # Priority 2: trailing stop after position moved positive.
    # Only arm trailing once peak exceeds TRAILING_MIN_PEAK_PCT to avoid
    # triggering on tiny positive moves that averaged -0.78% loss historically.
    if (
        EXIT_TRAILING_STOP_ENABLED
        and max_pnl_pct >= TRAILING_MIN_PEAK_PCT
        and sl_dynamic_pct > sl_static_pct
        and pnl_pct <= sl_dynamic_pct
    ):
        return "TRAILING_STOP_EXIT"

    return None


def log_rsi_snapshot(
    prefix: str,
    signal: str = "",
    rsi_state: dict | None = None,
    underlying_symbol: str | None = None,
    sellable_pnl_pct: float | None = None,
) -> tuple[str | None, dict]:
    """Log RSI marker state and return exit reason for opposite RSI crossover."""
    if rsi_state is None:
        rsi_state = {}
    try:
        rsi_result = analyze_rsi(underlying_symbol or SYMBOL)
        rsi = float(rsi_result.get("latest_rsi", 0.0))
        rsi_ma = float(rsi_result.get("latest_rsi_ma", 0.0))
        trend = rsi_result.get("base_trend", "UNKNOWN")
        close_price = float(rsi_result.get("close_price", 0.0))
        cross_up = bool(rsi_result.get("rsi_ma_cross_up")) or bool(rsi_result.get("prev_rsi_ma_cross_up"))
        cross_down = bool(rsi_result.get("rsi_ma_cross_down")) or bool(rsi_result.get("prev_rsi_ma_cross_down"))

        info(
            f"{prefix} RSI={rsi:.2f} RSI_MA={rsi_ma:.2f} trend={trend} "
            f"CrossUp={cross_up} CrossDown={cross_down} close={close_price:.2f}"
        )

        if signal:
            if EXIT_RSI_OPPOSITE_CROSS_ENABLED:
                adverse_cross = (signal == "CALL" and cross_down) or (signal == "PUT" and cross_up)
                if adverse_cross:
                    info(f"{prefix} Opposite RSI cross confirmed - exiting {signal}")
                    return "RSI_OPPOSITE_CROSS_EXIT", rsi_state

    except Exception as ex:
        debug(f"RSI snapshot unavailable: {ex}")
    return None, rsi_state


def _extract_snapshot_bid_ask(snap) -> tuple[float, float]:
    quote = getattr(snap, "latest_quote", None) or getattr(snap, "quote", None)
    if not quote:
        return 0.0, 0.0
    bid = float(getattr(quote, "bid_price", 0) or getattr(quote, "bp", 0) or 0)
    ask = float(getattr(quote, "ask_price", 0) or getattr(quote, "ap", 0) or 0)
    return bid, ask


def _resolve_sellable_price(quoted_price: float, bid_price: float) -> float:
    if bid_price > 0:
        return bid_price
    return quoted_price

def monitor_with_polling(
    option_data_client,
    contract_symbol,
    fill_price,
    tp_price,
    sl_price,
    context_label: str = "",
    signal: str = "",
    underlying_symbol: str | None = None,
    use_extended_exit_criteria: bool = True,
    min_exit_epoch_ts: float | None = None,
    buy_order_id: str | None = None,
    buy_entry_order_id: str | None = None,
    initial_exit_state: dict | None = None,
    tc=None,
    qty: int = 1,
):
    label = f"[{context_label}] " if context_label else ""
    info(f"{label}Fallback polling every {PRICE_POLL_SEC}s for {contract_symbol}")
    rsi_state = {}
    exit_state = initial_exit_state or _init_exit_state(fill_price, tp_price, sl_price)
    if not isinstance(exit_state.get("timeline"), list):
        exit_state["timeline"] = []
    _place_sl_stop_order(tc, exit_state, contract_symbol, qty)
    hold_notice_emitted = False
    entry_ts = time.time()
    bad_entry_fired = False

    # Entry tick anchor for full open→close lifecycle.
    if not exit_state["timeline"]:
        _append_timeline_tick(
            exit_state,
            source="entry",
            tick_ts=_iso_now_utc(),
            fill_price=fill_price,
            mid_price=fill_price,
            bid_price=None,
            sellable_price=fill_price,
            pnl_pct=0.0,
        )

    while True:
        time.sleep(PRICE_POLL_SEC)

        snapshots = option_data_client.get_option_snapshot(
            build_option_snapshot_request([contract_symbol])
        )
        snap = extract_snapshot_for_symbol(snapshots, contract_symbol)
        price = extract_snapshot_mid_price(snap)
        bid_price, _ = _extract_snapshot_bid_ask(snap)

        if price <= 0:
            debug("No option price from snapshot; retrying.")
            continue

        sellable_price = _resolve_sellable_price(price, bid_price)
        pnl_pct = (sellable_price - fill_price) / fill_price * 100
        same_candle_price = sellable_price if EXIT_SAME_CANDLE_USE_BID_PRICE else price
        same_candle_pnl_pct = (same_candle_price - fill_price) / fill_price * 100
        tick_ts = _iso_now_utc()
        _update_dynamic_thresholds(exit_state, pnl_pct, current_price=sellable_price, tick_ts=tick_ts,
                                    tc=tc, contract_symbol=contract_symbol, qty=qty)
        # Check if any exit protection order was already filled by Alpaca (auto-close)
        if _check_tp_order_filled(tc, exit_state):
            tp_fill = exit_state.get("tp_order_fill_price") or sellable_price
            if buy_order_id:
                set_live_exit_reason(buy_order_id, "TAKE_PROFIT_EXIT")
            info(f"{label}TAKE_PROFIT_EXIT - TP order filled by Alpaca at {tp_fill:.4f}")
            _append_sell_tick(exit_state, "TAKE_PROFIT_EXIT", tp_fill, fill_price)
            return "TAKE_PROFIT_EXIT", tp_fill, exit_state
        if _check_sl_order_filled(tc, exit_state):
            sl_fill = exit_state.get("sl_order_fill_price") or sellable_price
            sl_exit = exit_state.get("sl_order_exit_reason", "STOP_LOSS_EXIT")
            if buy_order_id:
                set_live_exit_reason(buy_order_id, sl_exit)
            info(f"{label}{sl_exit} - SL stop-limit order filled by Alpaca at {sl_fill:.4f}")
            _append_sell_tick(exit_state, sl_exit, sl_fill, fill_price)
            return sl_exit, sl_fill, exit_state
        _append_timeline_tick(
            exit_state,
            source="poll",
            tick_ts=tick_ts,
            fill_price=fill_price,
            mid_price=price,
            bid_price=bid_price if bid_price > 0 else None,
            sellable_price=sellable_price,
            pnl_pct=pnl_pct,
        )

        # Broadcast live state to frontend
        if buy_order_id:
            update_live_exit_state(buy_order_id, exit_state, pnl_pct, sellable_price)

        now_ts = time.time()

        if min_exit_epoch_ts is not None and now_ts < min_exit_epoch_ts:
            if (
                EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE
                and same_candle_pnl_pct >= EXIT_SAME_CANDLE_MIN_PNL_PCT
            ):
                info(
                    f"{label}SAME_CANDLE_POSITIVE_EXIT - exiting {signal} "
                    f"position at {same_candle_price:.4f} "
                    f"(pnl={same_candle_pnl_pct:+.2f}% threshold={EXIT_SAME_CANDLE_MIN_PNL_PCT:+.2f}%)"
                )
                _cancel_exit_orders(tc, exit_state)
                _append_sell_tick(exit_state, "SAME_CANDLE_POSITIVE_EXIT", same_candle_price, fill_price, bid_price=bid_price if bid_price > 0 else None, mid_price=price)
                return "SAME_CANDLE_POSITIVE_EXIT", same_candle_price, exit_state

            if not hold_notice_emitted:
                remaining = int(max(0.0, min_exit_epoch_ts - now_ts))
                info(
                    f"{label}Exit hold active ({remaining}s left); "
                    "will evaluate exits from next candle"
                )
                hold_notice_emitted = True
            continue

        if hold_notice_emitted:
            info(f"{label}Exit hold window completed; exits are now active")
            hold_notice_emitted = False

        # ── Bad entry detection: exit early if trade shows no momentum ──
        if (
            EXIT_BAD_ENTRY_ENABLED
            and not bad_entry_fired
            and use_extended_exit_criteria
            and (now_ts - entry_ts) >= EXIT_BAD_ENTRY_WINDOW_SEC
        ):
            bad_entry_fired = True  # only evaluate once
            max_pnl = float(exit_state.get("max_pnl_pct", 0.0))
            if max_pnl < EXIT_BAD_ENTRY_MAX_PEAK_PCT and pnl_pct <= EXIT_BAD_ENTRY_EXIT_THRESHOLD_PCT:
                reason = "BAD_ENTRY_EXIT"
                if buy_order_id:
                    set_live_exit_reason(buy_order_id, reason)
                info(
                    f"{label}{reason} - peak {max_pnl:+.2f}% < {EXIT_BAD_ENTRY_MAX_PEAK_PCT}% after "
                    f"{EXIT_BAD_ENTRY_WINDOW_SEC}s, pnl={pnl_pct:+.2f}% - cutting early at {sellable_price:.4f}"
                )
                _cancel_exit_orders(tc, exit_state)
                _append_sell_tick(exit_state, reason, sellable_price, fill_price, bid_price=bid_price if bid_price > 0 else None, mid_price=price)
                return reason, sellable_price, exit_state

        # ── Max hold time: scalps should not linger — exit stale trades ──
        # Only fire when PnL is below threshold (protecting small gains / flat trades,
        # never cutting winners that are still running).
        hold_age = now_ts - entry_ts
        if (
            EXIT_MAX_HOLD_ENABLED
            and use_extended_exit_criteria
            and hold_age >= EXIT_MAX_HOLD_SEC
            and pnl_pct >= 0
            and pnl_pct < EXIT_MAX_HOLD_PNL_THRESHOLD_PCT
        ):
            reason = "MAX_HOLD_TIME_EXIT"
            if buy_order_id:
                set_live_exit_reason(buy_order_id, reason)
            info(
                f"{label}{reason} - held {hold_age:.0f}s (>{EXIT_MAX_HOLD_SEC}s), "
                f"pnl={pnl_pct:+.2f}% < {EXIT_MAX_HOLD_PNL_THRESHOLD_PCT}% - "
                f"freeing capital at {sellable_price:.4f}"
            )
            _cancel_exit_orders(tc, exit_state)
            _append_sell_tick(exit_state, reason, sellable_price, fill_price, bid_price=bid_price if bid_price > 0 else None, mid_price=price)
            return reason, sellable_price, exit_state

        if use_extended_exit_criteria:
            info(
                f"{label}Poll {contract_symbol} mid={price:.4f} sellable={sellable_price:.4f} pnl={pnl_pct:+.2f}% "
                f"qp={exit_state['qp_dynamic_pct']:+.2f}% sl={exit_state['sl_dynamic_pct']:+.2f}%"
            )
        else:
            info(
                f"{label}Poll {contract_symbol} mid={price:.4f} "
                f"sellable={sellable_price:.4f} pnl={pnl_pct:+.2f}%"
            )

        exit_reason = _evaluate_priority_exit(
            pnl_pct,
            exit_state,
            use_extended_exit_criteria=use_extended_exit_criteria,
        )
        if exit_reason:
            if buy_order_id:
                set_live_exit_reason(buy_order_id, exit_reason)
            info(f"{label}{exit_reason} - exiting {signal} position at {sellable_price:.4f}")
            _cancel_exit_orders(tc, exit_state)
            _append_sell_tick(exit_state, exit_reason, sellable_price, fill_price, bid_price=bid_price if bid_price > 0 else None, mid_price=price)
            return exit_reason, sellable_price, exit_state

        if use_extended_exit_criteria:
            exit_reason, rsi_state = log_rsi_snapshot(
                f"{label}Poll".strip(), signal=signal, rsi_state=rsi_state,
                underlying_symbol=underlying_symbol,
                sellable_pnl_pct=pnl_pct,
            )

            # ── Momentum stall: RSI delta flips against signal + PnL near zero ──
            # If trade has been open long enough and momentum has died (RSI moving
            # against our direction), exit to free capital. Only fires when PnL is
            # positive but small — never cuts winners or adds to losses (SL handles that).
            if (
                EXIT_MOMENTUM_STALL_ENABLED
                and not exit_reason
                and hold_age >= EXIT_MOMENTUM_STALL_MIN_AGE_SEC
                and 0 <= pnl_pct < EXIT_MOMENTUM_STALL_PNL_THRESHOLD_PCT
            ):
                try:
                    rsi_result = analyze_rsi(underlying_symbol or SYMBOL)
                    rsi_delta = float(rsi_result.get("delta", 0.0))
                    stall_detected = (
                        (signal == "CALL" and rsi_delta < 0)
                        or (signal == "PUT" and rsi_delta > 0)
                    )
                    if stall_detected:
                        exit_reason = "MOMENTUM_STALL_EXIT"
                        info(
                            f"{label}{exit_reason} - RSI delta={rsi_delta:+.2f} against {signal}, "
                            f"pnl={pnl_pct:+.2f}% after {hold_age:.0f}s - exiting at {sellable_price:.4f}"
                        )
                except Exception as ex:
                    debug(f"Momentum stall RSI check failed: {ex}")

            if exit_reason:
                if buy_order_id:
                    set_live_exit_reason(buy_order_id, exit_reason)
                info(f"{label}{exit_reason} - exiting {signal} position at {sellable_price:.4f}")
                _cancel_exit_orders(tc, exit_state)
                _append_sell_tick(exit_state, exit_reason, sellable_price, fill_price, bid_price=bid_price if bid_price > 0 else None, mid_price=price)
                return exit_reason, sellable_price, exit_state


def monitor_with_websocket(
    contract_symbol,
    fill_price,
    tp_price,
    sl_price,
    context_label: str = "",
    signal: str = "",
    underlying_symbol: str | None = None,
    use_extended_exit_criteria: bool = True,
    min_exit_epoch_ts: float | None = None,
    buy_order_id: str | None = None,
    buy_entry_order_id: str | None = None,
    tc=None,
    qty: int = 1,
):
    global _ws_cooldown_until
    label = f"[{context_label}] " if context_label else ""

    now_ts = time.time()
    if now_ts < _ws_cooldown_until:
        remaining = int(_ws_cooldown_until - now_ts)
        info(
            f"{label}Websocket cooldown active ({remaining}s); "
            f"using polling fallback for {contract_symbol}"
        )
        return None, fill_price, {}

    if not _WS_MONITOR_LOCK.acquire(blocking=False):
        info(f"{label}Websocket busy; using polling fallback for {contract_symbol}")
        return None, fill_price, {}

    try:
        try:
            from alpaca.data.live.option import OptionDataStream
        except Exception as ex:
            debug(f"OptionDataStream unavailable: {ex}")
            return None, fill_price, {}

        state = {
            "exit_reason": None,
            "last_price": fill_price,
            "last_print_ts": 0.0,
            "last_rsi_ts": 0.0,
            "last_qp_check_ts": 0.0,
            "rsi_state": {},
            "exit_state": _init_exit_state(fill_price, tp_price, sl_price),
            "hold_notice_emitted": False,
            "entry_ts": time.time(),
            "bad_entry_fired": False,
        }
        _place_sl_stop_order(tc, state["exit_state"], contract_symbol, qty)
        _append_timeline_tick(
            state["exit_state"],
            source="entry",
            tick_ts=_iso_now_utc(),
            fill_price=fill_price,
            mid_price=fill_price,
            bid_price=None,
            sellable_price=fill_price,
            pnl_pct=0.0,
        )
        done = threading.Event()
        first_quote_event = threading.Event()

        def stop_stream(stream_obj):
            try:
                if hasattr(stream_obj, "stop"):
                    stream_obj.stop()
                elif hasattr(stream_obj, "stop_ws"):
                    stream_obj.stop_ws()
                elif hasattr(stream_obj, "close"):
                    stream_obj.close()
            except Exception:
                pass

        def extract_quote_prices(msg):
            bid = getattr(msg, "bid_price", None)
            ask = getattr(msg, "ask_price", None)
            if bid is None:
                bid = getattr(msg, "bp", 0)
            if ask is None:
                ask = getattr(msg, "ap", 0)
            bid = float(bid or 0)
            ask = float(ask or 0)
            if bid > 0 and ask > 0:
                return (bid + ask) / 2, bid, ask
            px = bid or ask or 0.0
            return px, bid, ask

        stream = OptionDataStream(API_KEY, SECRET_KEY)
        async def on_quote(msg):
            price, bid, _ = extract_quote_prices(msg)
            if price <= 0:
                return
            sellable_price = _resolve_sellable_price(price, bid)
            state["last_price"] = sellable_price
            first_quote_event.set()

            now = time.time()
            pnl_pct = (sellable_price - fill_price) / fill_price * 100
            tick_ts = _iso_now_utc()
            _update_dynamic_thresholds(
                state["exit_state"],
                pnl_pct,
                current_price=sellable_price,
                tick_ts=tick_ts,
                tc=tc,
                contract_symbol=contract_symbol,
                qty=qty,
            )
            # Throttled check: poll Alpaca every PRICE_POLL_SEC to see if any exit order filled
            if now - state["last_qp_check_ts"] >= WS_ORDER_CHECK_SEC:
                state["last_qp_check_ts"] = now
                if _check_tp_order_filled(tc, state["exit_state"]):
                    tp_fill = state["exit_state"].get("tp_order_fill_price") or sellable_price
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, "TAKE_PROFIT_EXIT")
                    info(f"{label}TAKE_PROFIT_EXIT - TP order filled by Alpaca at {tp_fill:.4f}")
                    state["last_price"] = tp_fill
                    state["exit_reason"] = "TAKE_PROFIT_EXIT"
                    _append_sell_tick(state["exit_state"], "TAKE_PROFIT_EXIT", tp_fill, fill_price)
                    done.set()
                    stop_stream(stream)
                    return
                if _check_sl_order_filled(tc, state["exit_state"]):
                    sl_fill = state["exit_state"].get("sl_order_fill_price") or sellable_price
                    sl_exit = state["exit_state"].get("sl_order_exit_reason", "STOP_LOSS_EXIT")
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, sl_exit)
                    info(f"{label}{sl_exit} - SL stop-limit order filled by Alpaca at {sl_fill:.4f}")
                    state["last_price"] = sl_fill
                    state["exit_reason"] = sl_exit
                    _append_sell_tick(state["exit_state"], sl_exit, sl_fill, fill_price)
                    done.set()
                    stop_stream(stream)
                    return
            _append_timeline_tick(
                state["exit_state"],
                source="ws",
                tick_ts=tick_ts,
                fill_price=fill_price,
                mid_price=price,
                bid_price=bid if bid > 0 else None,
                sellable_price=sellable_price,
                pnl_pct=pnl_pct,
            )

            # Broadcast live state to frontend
            if buy_order_id:
                update_live_exit_state(buy_order_id, state["exit_state"], pnl_pct, sellable_price)

            if now - state["last_print_ts"] >= 2:
                if use_extended_exit_criteria:
                    info(
                        f"{label}WS {contract_symbol} mid={price:.4f} sellable={sellable_price:.4f} pnl={pnl_pct:+.2f}% "
                        f"qp={state['exit_state']['qp_dynamic_pct']:+.2f}% "
                        f"sl={state['exit_state']['sl_dynamic_pct']:+.2f}%"
                    )
                else:
                    info(
                        f"{label}WS {contract_symbol} mid={price:.4f} "
                        f"sellable={sellable_price:.4f} pnl={pnl_pct:+.2f}%"
                    )
                state["last_print_ts"] = now

            same_candle_price = sellable_price if EXIT_SAME_CANDLE_USE_BID_PRICE else price
            same_candle_pnl_pct = (same_candle_price - fill_price) / fill_price * 100

            if min_exit_epoch_ts is not None and now < min_exit_epoch_ts:
                if (
                    EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE
                    and same_candle_pnl_pct >= EXIT_SAME_CANDLE_MIN_PNL_PCT
                ):
                    info(
                        f"{label}SAME_CANDLE_POSITIVE_EXIT - exiting {signal} "
                        f"position at {same_candle_price:.4f} "
                        f"(pnl={same_candle_pnl_pct:+.2f}% threshold={EXIT_SAME_CANDLE_MIN_PNL_PCT:+.2f}%)"
                    )
                    _cancel_exit_orders(tc, state["exit_state"])
                    state["last_price"] = same_candle_price
                    state["exit_reason"] = "SAME_CANDLE_POSITIVE_EXIT"
                    _append_sell_tick(state["exit_state"], "SAME_CANDLE_POSITIVE_EXIT", same_candle_price, fill_price, bid_price=bid if bid > 0 else None, mid_price=price)
                    done.set()
                    stop_stream(stream)
                    return

                if not state["hold_notice_emitted"]:
                    remaining = int(max(0.0, min_exit_epoch_ts - now))
                    info(
                        f"{label}Exit hold active ({remaining}s left); "
                        "will evaluate exits from next candle"
                    )
                    state["hold_notice_emitted"] = True
                return

            if state["hold_notice_emitted"]:
                info(f"{label}Exit hold window completed; exits are now active")
                state["hold_notice_emitted"] = False

            # ── Bad entry detection: exit early if trade shows no momentum ──
            if (
                EXIT_BAD_ENTRY_ENABLED
                and not state["bad_entry_fired"]
                and use_extended_exit_criteria
                and (now - state["entry_ts"]) >= EXIT_BAD_ENTRY_WINDOW_SEC
            ):
                state["bad_entry_fired"] = True
                max_pnl = float(state["exit_state"].get("max_pnl_pct", 0.0))
                if max_pnl < EXIT_BAD_ENTRY_MAX_PEAK_PCT and pnl_pct <= EXIT_BAD_ENTRY_EXIT_THRESHOLD_PCT:
                    reason = "BAD_ENTRY_EXIT"
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, reason)
                    info(
                        f"{label}{reason} - peak {max_pnl:+.2f}% < {EXIT_BAD_ENTRY_MAX_PEAK_PCT}% after "
                        f"{EXIT_BAD_ENTRY_WINDOW_SEC}s, pnl={pnl_pct:+.2f}% - cutting early at {sellable_price:.4f}"
                    )
                    _cancel_exit_orders(tc, state["exit_state"])
                    state["last_price"] = sellable_price
                    state["exit_reason"] = reason
                    _append_sell_tick(state["exit_state"], reason, sellable_price, fill_price, bid_price=bid if bid > 0 else None, mid_price=price)
                    done.set()
                    stop_stream(stream)
                    return

            exit_reason = _evaluate_priority_exit(
                pnl_pct,
                state["exit_state"],
                use_extended_exit_criteria=use_extended_exit_criteria,
            )
            if exit_reason:
                if buy_order_id:
                    set_live_exit_reason(buy_order_id, exit_reason)
                info(f"{label}{exit_reason} - exiting {signal} position at {sellable_price:.4f}")
                _cancel_exit_orders(tc, state["exit_state"])
                state["last_price"] = sellable_price
                state["exit_reason"] = exit_reason
                _append_sell_tick(state["exit_state"], exit_reason, sellable_price, fill_price, bid_price=bid if bid > 0 else None, mid_price=price)
                done.set()
                stop_stream(stream)
                return

            if use_extended_exit_criteria and now - state["last_rsi_ts"] >= RSI_EXIT_CHECK_SEC:
                exit_reason, state["rsi_state"] = log_rsi_snapshot(
                    f"{label}WS".strip(), signal=signal, rsi_state=state["rsi_state"],
                    underlying_symbol=underlying_symbol,
                    sellable_pnl_pct=pnl_pct,
                )
                state["last_rsi_ts"] = now
                if exit_reason:
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, exit_reason)
                    _cancel_exit_orders(tc, state["exit_state"])
                    state["last_price"] = sellable_price
                    state["exit_reason"] = exit_reason
                    _append_sell_tick(state["exit_state"], exit_reason, sellable_price, fill_price, bid_price=bid if bid > 0 else None, mid_price=price)
                    done.set()
                    stop_stream(stream)
                    return

        stream.subscribe_quotes(on_quote, contract_symbol)

        def run_stream():
            try:
                stream.run()
            except Exception as ex:
                debug(f"Websocket run error for {contract_symbol}: {ex}")
                done.set()

        thread = threading.Thread(target=run_stream, daemon=True)
        thread.start()
        info(f"{label}Websocket subscribed for {contract_symbol}")

        deadline = time.time() + WS_MAX_WAIT_SEC
        while time.time() < deadline:
            if not first_quote_event.is_set() and (time.time() - now_ts) > _WS_FIRST_QUOTE_TIMEOUT_SEC:
                _ws_cooldown_until = time.time() + _WS_COOLDOWN_AFTER_FAIL_SEC
                info(
                    f"{label}Websocket unavailable (no quote after subscribe); "
                    "switching to polling fallback"
                )
                stop_stream(stream)
                return None, state["last_price"], state["exit_state"]  # QP order stays (polling will manage it)

            if done.wait(timeout=1):
                break

            if not thread.is_alive():
                _ws_cooldown_until = time.time() + _WS_COOLDOWN_AFTER_FAIL_SEC
                stop_stream(stream)
                return None, state["last_price"], state["exit_state"]  # QP order stays (polling will manage it)

        if state["exit_reason"] is None:
            _ws_cooldown_until = time.time() + _WS_COOLDOWN_AFTER_FAIL_SEC
            stop_stream(stream)
            return None, state["last_price"], state["exit_state"]  # QP order stays (polling will manage it)

        thread.join(timeout=3)
        return state["exit_reason"], state["last_price"], state["exit_state"]
    finally:
        _WS_MONITOR_LOCK.release()