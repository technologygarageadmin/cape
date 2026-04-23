import time
import threading
import logging
import re
from datetime import datetime, timezone

from alpaca.data.historical import OptionHistoricalDataClient
from alpaca.trading.requests import ReplaceOrderRequest, StopLimitOrderRequest, StopLossRequest
from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus

from alpaca_helpers import (
    build_option_snapshot_request,
    extract_snapshot_for_symbol,
    extract_snapshot_mid_price,
)
from config import (
    API_KEY,
    CAPE_MAX_TIGHTEN_PCT,
    CAPE_QP_OFFSET,
    CAPE_TRAILING_SL_OFFSET,
    EXIT_BRACKET_QP_ENABLED,
    EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE,
    EXIT_BAD_ENTRY_ENABLED,
    EXIT_BAD_ENTRY_EXIT_THRESHOLD_PCT,
    EXIT_BAD_ENTRY_MAX_PEAK_PCT,
    EXIT_BAD_ENTRY_WINDOW_SEC,
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
    EXIT_TAKE_PROFIT_MODE,
    EXIT_STOP_LOSS_MODE,
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
from order_execution import set_live_exit_reason, update_live_exit_state, place_market_order, wait_for_fill
from rsi_analyer import analyze_rsi


_WS_MONITOR_LOCK = threading.Lock()
_WS_FIRST_QUOTE_TIMEOUT_SEC = 12
_WS_COOLDOWN_AFTER_FAIL_SEC = 15 * 60
_ws_cooldown_until = 0.0

# Prevent repeated Alpaca websocket auth tracebacks from flooding console/logs.
logging.getLogger("alpaca.data.live.websocket").setLevel(logging.CRITICAL)

try:
    # Alpaca options orders need position_intent=CLOSE when selling long contracts.
    from alpaca.trading.enums import PositionIntent
except Exception:  # pragma: no cover
    PositionIntent = None  # type: ignore

_OPTION_CONTRACT_RE = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")


def _is_option_contract_symbol(sym: str | None) -> bool:
    s = str(sym or "").strip().upper()
    return bool(s and _OPTION_CONTRACT_RE.match(s))


def _init_exit_state(fill_price: float, tp_price: float, sl_price: float) -> dict:
    tp_pct = ((tp_price / fill_price) - 1.0) * 100.0
    sl_pct = ((sl_price / fill_price) - 1.0) * 100.0
    # QP starts at 0% and ratchets up with the trade — never reduced.
    # Gap shrinks as profit grows so we lock in more of larger moves.
    qp_gap_pct = QP_GAP_PCT   # lock in peak minus QP_GAP_PCT (tight lock from the start)
    return {
        "use_bracket_exit": bool(EXIT_BRACKET_QP_ENABLED),
        "fill_price": fill_price,
        "tp_price": round(tp_price, 4),
        "sl_price": round(sl_price, 4),
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
        # If broker rejects protective SL orders (common on accounts without stop support),
        # we keep monitoring internally and will exit via market fallback on trigger.
        "sl_broker_disabled": False,
        "timeline": [],
    }


def _seed_bracket_exit_orders(tc, exit_state: dict, buy_order_id: str | None) -> None:
    """Seed TP/SL child order IDs from a bracket parent so monitor can track them."""
    if tc is None or not buy_order_id or not bool(exit_state.get("use_bracket_exit", False)):
        return
    if (exit_state.get("tp_order_ids") or exit_state.get("sl_order_ids")):
        return

    parent = None
    legs = []
    for _ in range(3):
        try:
            parent = tc.get_order_by_id(buy_order_id)
        except Exception as ex:
            debug(f"[BRACKET] Could not fetch parent order {buy_order_id}: {ex}")
            return
        legs = list(getattr(parent, "legs", None) or [])
        if legs:
            break
        time.sleep(0.4)

    if not legs:
        debug(f"[BRACKET] Parent {buy_order_id} has no child legs yet")
        return

    tp_ids: list[str] = []
    sl_ids: list[str] = []
    for leg in legs:
        oid = str(getattr(leg, "id", "") or "")
        if not oid:
            continue
        limit_price = float(getattr(leg, "limit_price", 0) or 0)
        stop_price = float(getattr(leg, "stop_price", 0) or 0)
        if stop_price > 0:
            sl_ids.append(oid)
        elif limit_price > 0:
            tp_ids.append(oid)

    if tp_ids:
        exit_state["tp_order_ids"] = tp_ids
    if sl_ids:
        # Keep exactly one active SL id in state; replacements will rotate this id.
        exit_state["sl_order_ids"] = [sl_ids[0]]
        exit_state["sl_order_exit_reason"] = "STOP_LOSS_EXIT"
        exit_state["sl_last_placed_pct"] = float(exit_state.get("sl_dynamic_pct", exit_state.get("sl_static_pct", 0.0)))

    if tp_ids or sl_ids:
        timeline = exit_state.setdefault("timeline", [])
        timeline.append({
            "ts": _iso_now_utc(),
            "source": "order_seeded",
            "order_type": "BRACKET_CHILDREN",
            "parent_order_id": buy_order_id,
            "tp_order_ids": tp_ids,
            "sl_order_ids": sl_ids,
            "status": "live",
        })
        info(
            f"[BRACKET] Seeded parent={buy_order_id} tp={len(tp_ids)} sl={len(sl_ids)}"
        )


def _iso_now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _to_iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    except Exception:
        return str(value)


def _order_status_value(order) -> str:
    status = getattr(order, "status", "")
    raw = getattr(status, "value", status)
    return str(raw or "").strip().lower()


def _status_for_ui(status: str) -> str:
    if status == "replaced":
        return "cancelled"
    if status == "canceled":
        return "cancelled"
    return status or "live"


def _fetch_order_snapshot(tc, order_id: str) -> dict | None:
    if tc is None or not order_id:
        return None
    try:
        order = tc.get_order_by_id(order_id)
        status = _order_status_value(order)
        submitted_at = _to_iso(getattr(order, "submitted_at", None) or getattr(order, "created_at", None))
        updated_at = _to_iso(getattr(order, "updated_at", None))
        canceled_at = _to_iso(getattr(order, "canceled_at", None))
        filled_at = _to_iso(getattr(order, "filled_at", None))
        status_at = filled_at or canceled_at or updated_at or submitted_at or _iso_now_utc()
        filled_price = float(getattr(order, "filled_avg_price", 0) or 0)
        return {
            "status": _status_for_ui(status),
            "raw_status": status,
            "status_at": status_at,
            "submitted_at": submitted_at,
            "updated_at": updated_at,
            "canceled_at": canceled_at,
            "filled_at": filled_at,
            "fill_price": filled_price if filled_price > 0 else None,
        }
    except Exception:
        return None


def _mark_timeline_order_status(timeline: list, order_id: str, snapshot: dict | None, fallback_status: str | None = None) -> None:
    if not timeline or not order_id:
        return
    for tick in reversed(timeline):
        if tick.get("order_id") == order_id and tick.get("source") in ("order_placed", "order_replaced"):
            if snapshot:
                tick["status"] = snapshot.get("status") or tick.get("status") or "live"
                tick["raw_status"] = snapshot.get("raw_status") or tick.get("raw_status")
                tick["status_at"] = snapshot.get("status_at") or tick.get("status_at") or tick.get("ts")
                if snapshot.get("submitted_at"):
                    tick["submitted_at"] = snapshot.get("submitted_at")
                if snapshot.get("updated_at"):
                    tick["updated_at"] = snapshot.get("updated_at")
                if snapshot.get("canceled_at"):
                    tick["canceled_at"] = snapshot.get("canceled_at")
                if snapshot.get("filled_at"):
                    tick["filled_at"] = snapshot.get("filled_at")
                if snapshot.get("fill_price") is not None:
                    tick["fill_price"] = snapshot.get("fill_price")
            elif fallback_status:
                tick["status"] = fallback_status
                tick["status_at"] = tick.get("status_at") or _iso_now_utc()
            if tick.get("status") == "canceled":
                tick["status"] = "cancelled"
            break


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
        "tp_price": tick_actions.get("tp_price", exit_state.get("tp_price")),
        "sl_action": tick_actions.get("sl_action", "NO_CHANGE"),
        "sl_prev_pct": tick_actions.get("sl_prev_pct"),
        "sl_new_pct": tick_actions.get("sl_new_pct"),
        "sl_prev_price": tick_actions.get("sl_prev_price", exit_state.get("sl_price")),
        "sl_new_price": tick_actions.get("sl_new_price", exit_state.get("sl_price")),
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
    filled_snapshot = None
    for oid in order_ids:
        try:
            order = tc.get_order_by_id(oid)
            status = str(getattr(order, "status", "")).lower()
            if "filled" in status:
                filled_id = oid
                fp = float(getattr(order, "filled_avg_price", 0) or 0)
                filled_price = fp if fp > 0 else None
                filled_snapshot = _fetch_order_snapshot(tc, oid)
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
                cancel_snapshot = _fetch_order_snapshot(tc, oid)
                _mark_timeline_order_status(timeline, oid, cancel_snapshot, fallback_status="cancelled")
            except Exception:
                pass

    if filled_snapshot is None:
        filled_snapshot = {
            "status": "filled",
            "raw_status": "filled",
            "status_at": _iso_now_utc(),
            "filled_at": _iso_now_utc(),
            "fill_price": filled_price,
        }
    _mark_timeline_order_status(timeline, filled_id, filled_snapshot, fallback_status="filled")

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
    timeline = exit_state.setdefault("timeline", [])
    for oid in order_ids:
        try:
            tc.cancel_order_by_id(oid)
            info(f"[TP] Cancelled {oid}")
            cancel_snapshot = _fetch_order_snapshot(tc, oid)
            _mark_timeline_order_status(timeline, oid, cancel_snapshot, fallback_status="cancelled")
        except Exception:
            pass
    exit_state["tp_order_ids"] = []


def _place_sl_stop_order(tc, exit_state: dict, contract_symbol: str | None, qty: int, buy_order_id: str | None = None) -> dict | None:
    """Place or replace SL stop-limit sell at the current sl_dynamic_pct level."""
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", 0))
    is_trailing = sl_dynamic_pct > float(exit_state.get("sl_static_pct", 0))
    if tc is None or not contract_symbol:
        return None
    if bool(exit_state.get("sl_broker_disabled", False)):
        return {"operation": "disabled"}
    fill_price = float(exit_state.get("fill_price", 0))
    if fill_price <= 0:
        return None
    stop_price = round(round(fill_price * (1.0 + sl_dynamic_pct / 100.0), 4), 2)
    # Compute stop-limit limit offset using configured buffer
    # Broker expects limit prices with 2-decimal precision for options — round accordingly.
    limit_price = round(stop_price * (1.0 - SL_STOP_LIMIT_BUFFER_PCT / 100.0), 2)
    label = "TRAIL SL" if is_trailing else "SL"
    timeline = exit_state.setdefault("timeline", [])
    existing_ids = list(exit_state.get("sl_order_ids") or [])
    existing_id = existing_ids[0] if existing_ids else None
    try:
        if existing_id:
            # Try to replace both stop and limit prices when possible
            try:
                replaced = tc.replace_order_by_id(
                    existing_id,
                    ReplaceOrderRequest(stop_price=stop_price, limit_price=limit_price),
                )
            except Exception:
                # Fall back to replacing only the stop price if API rejects limit replacement
                try:
                    replaced = tc.replace_order_by_id(
                        existing_id,
                        ReplaceOrderRequest(stop_price=stop_price),
                    )
                except Exception as ex_replace_only:
                    # If replace fails entirely, we'll allow the outer exception handler
                    # to execute fallback logic (fresh placement / notional / market).
                    raise
            new_id = str(getattr(replaced, "id", existing_id) or existing_id)
            exit_state["sl_order_ids"] = [new_id]
            exit_state["sl_last_placed_pct"] = sl_dynamic_pct
            new_submitted_at = _to_iso(
                getattr(replaced, "submitted_at", None)
                or getattr(replaced, "created_at", None)
                or getattr(replaced, "updated_at", None)
            )
            new_updated_at = _to_iso(getattr(replaced, "updated_at", None))
            new_raw_status = _order_status_value(replaced)
            new_status = _status_for_ui(new_raw_status)
            event_ts = new_submitted_at or new_updated_at or _iso_now_utc()
            timeline.append({
                "ts": event_ts,
                "source": "order_replaced",
                "order_type": "TRAIL_SL_STOP_MARKET" if is_trailing else "SL_STOP_MARKET",
                "order_id": new_id,
                "prev_order_id": existing_id,
                "stop_price": stop_price,
                "pct": round(sl_dynamic_pct, 4),
                "status": new_status or "live",
                "raw_status": new_raw_status,
                "status_at": event_ts,
                "submitted_at": new_submitted_at,
                "updated_at": new_updated_at,
            })
            prev_snapshot = _fetch_order_snapshot(tc, existing_id)
            _mark_timeline_order_status(timeline, existing_id, prev_snapshot, fallback_status="cancelled")
            info(
                f"[{label} STOP] {contract_symbol} replaced id={existing_id} -> {new_id} "
                f"stop={stop_price:.4f} (sl={sl_dynamic_pct:+.2f}%)"
            )
            return {
                "operation": "replaced",
                "prev_order_id": existing_id,
                "new_order_id": new_id,
                "stop_price": stop_price,
                "limit_price": None,
                "sl_dynamic_pct": sl_dynamic_pct,
            }
        # Use stop-limit (StopLimitOrderRequest) so SL has explicit limit attached
        # Ensure qty is valid; attempt to derive a fallback from registry if needed.
        try:
            qty_int = int(qty or 0)
        except Exception:
            qty_int = 0

        if qty_int <= 0:
            try:
                # avoid top-level import cycles by importing at call site
                from order_execution import get_open_positions

                pos_qty = 0
                for p in get_open_positions():
                    if str(p.get("contract_symbol") or "") == str(contract_symbol):
                        try:
                            pos_qty = int(p.get("qty", 0) or 0)
                            break
                        except Exception:
                            continue
                if pos_qty > 0:
                    qty_int = pos_qty
            except Exception:
                pass

        if qty_int <= 0:
            qty_int = 1
            info(f"[{label} STOP] qty invalid ({qty}) — falling back to qty=1 for {contract_symbol}")

        extra_intent = {}
        if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
            # Without this, Alpaca may treat SELL as opening a short (uncovered) option.
            extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

        req = StopLimitOrderRequest(
            symbol=contract_symbol,
            qty=qty_int,
            side=OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
            stop_price=stop_price,
            limit_price=limit_price,
            **extra_intent,
        )
        try:
            info(f"[{label} STOP] submitting StopLimitOrderRequest payload: {req.__dict__}")
        except Exception:
            pass

        order = tc.submit_order(req)
        exit_state["sl_order_ids"] = [str(order.id)]
        exit_state["sl_last_placed_pct"] = sl_dynamic_pct
        submitted_at = _to_iso(
            getattr(order, "submitted_at", None)
            or getattr(order, "created_at", None)
            or getattr(order, "updated_at", None)
        )
        updated_at = _to_iso(getattr(order, "updated_at", None))
        raw_status = _order_status_value(order)
        status = _status_for_ui(raw_status)
        event_ts = submitted_at or updated_at or _iso_now_utc()
        timeline.append({
            "ts": event_ts,
            "source": "order_placed",
            "order_type": "TRAIL_SL_STOP_LIMIT" if is_trailing else "SL_STOP_LIMIT",
            "order_id": str(order.id),
            "stop_price": stop_price,
            "limit_price": limit_price,
            "pct": round(sl_dynamic_pct, 4),
            "order_count": 1,
            "status": status or "live",
            "raw_status": raw_status,
            "status_at": event_ts,
            "submitted_at": submitted_at,
            "updated_at": updated_at,
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
        err_str = str(ex or "")
        low = err_str.lower()
        timeline.append({
            "ts": _iso_now_utc(),
            "source": "order_placed" if not existing_id else "order_replaced",
            "order_type": "TRAIL_SL_STOP_MARKET" if is_trailing else "SL_STOP_MARKET",
            "order_id": None,
            "prev_order_id": existing_id,
            "stop_price": stop_price,
            "pct": round(sl_dynamic_pct, 4),
            "order_count": len(exit_state.get("sl_order_ids") or []),
            "status": "error",
            "error": err_str,
        })

        # If the broker consistently rejects protective stop(-limit) orders for options,
        # disable further broker SL placements and rely on internal trigger + market fallback.
        if (
            "40310000" in low
            or "account not eligible to trade uncovered option contracts" in low
            or "position intent mismatch" in low
        ):
            exit_state["sl_broker_disabled"] = True
            info(f"[{label} STOP] Broker SL disabled for {contract_symbol} (will use internal fallback exits)")
            return {"operation": "disabled", "error": err_str}

        # If replace failed because the existing order is no longer open,
        # attempt to place a fresh stop-limit order before other fallbacks.
        if existing_id and ("order is not open" in low or "42210000" in low or "order not open" in low):
            try:
                # Try placing a fresh StopLimitOrderRequest using the normal path
                try:
                    qty_int = int(qty or 0)
                except Exception:
                    qty_int = 0
                if qty_int <= 0:
                    try:
                        from order_execution import get_open_positions
                        pos_qty = 0
                        for p in get_open_positions():
                            if str(p.get("contract_symbol") or "") == str(contract_symbol):
                                try:
                                    pos_qty = int(p.get("qty", 0) or 0)
                                    break
                                except Exception:
                                    continue
                        if pos_qty > 0:
                            qty_int = pos_qty
                    except Exception:
                        pass
                if qty_int <= 0:
                    qty_int = 1
                extra_intent = {}
                if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
                    extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

                req_fresh = StopLimitOrderRequest(
                    symbol=contract_symbol,
                    qty=qty_int,
                    side=OrderSide.SELL,
                    time_in_force=TimeInForce.DAY,
                    stop_price=stop_price,
                    limit_price=limit_price,
                    **extra_intent,
                )
                try:
                    info(f"[{label} STOP] replace failed (not open) — submitting fresh stop-limit: {req_fresh.__dict__}")
                except Exception:
                    pass
                order = tc.submit_order(req_fresh)
                exit_state["sl_order_ids"] = [str(order.id)]
                exit_state["sl_last_placed_pct"] = sl_dynamic_pct
                submitted_at = _to_iso(
                    getattr(order, "submitted_at", None)
                    or getattr(order, "created_at", None)
                    or getattr(order, "updated_at", None)
                )
                updated_at = _to_iso(getattr(order, "updated_at", None))
                raw_status = _order_status_value(order)
                status = _status_for_ui(raw_status)
                event_ts = submitted_at or updated_at or _iso_now_utc()
                timeline.append({
                    "ts": event_ts,
                    "source": "order_placed",
                    "order_type": "TRAIL_SL_STOP_LIMIT" if is_trailing else "SL_STOP_LIMIT",
                    "order_id": str(order.id),
                    "stop_price": stop_price,
                    "limit_price": limit_price,
                    "pct": round(sl_dynamic_pct, 4),
                    "order_count": 1,
                    "status": status or "live",
                    "raw_status": raw_status,
                    "status_at": event_ts,
                    "submitted_at": submitted_at,
                    "updated_at": updated_at,
                })
                info(
                    f"[{label} STOP] (replace->fresh) {contract_symbol} stop={stop_price:.4f} limit={limit_price:.4f} "
                    f"(sl={sl_dynamic_pct:+.2f}%) id={order.id}"
                )
                return {
                    "operation": "placed",
                    "prev_order_id": existing_id,
                    "new_order_id": str(order.id),
                    "stop_price": stop_price,
                    "limit_price": limit_price,
                    "sl_dynamic_pct": sl_dynamic_pct,
                }
            except Exception as ex_fresh:
                info(f"[{label} STOP] Fresh stop-limit after replace failed: {ex_fresh}")
                timeline.append({
                    "ts": _iso_now_utc(),
                    "source": "order_placed",
                    "order_type": "TRAIL_SL_STOP_LIMIT" if is_trailing else "SL_STOP_LIMIT",
                    "order_id": None,
                    "prev_order_id": existing_id,
                    "stop_price": stop_price,
                    "limit_price": limit_price,
                    "pct": round(sl_dynamic_pct, 4),
                    "order_count": len(exit_state.get("sl_order_ids") or []),
                    "status": "error",
                    "error": str(ex_fresh),
                })
                # fall through to other fallbacks

        # Common after restarts: an old open SELL order is holding the entire position qty,
        # so a new protective SL cannot be submitted.
        if ("held_for_orders" in low) or ("insufficient qty available" in low):
            try:
                from alpaca.trading.requests import GetOrdersRequest
                from alpaca.trading.enums import QueryOrderStatus

                open_orders = tc.get_orders(
                    filter=GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[contract_symbol])
                )
                cancelled_any = False
                for oo in open_orders or []:
                    try:
                        if str(getattr(oo, "side", "") or "").lower().endswith("sell"):
                            tc.cancel_order_by_id(str(getattr(oo, "id", "") or ""))
                            cancelled_any = True
                    except Exception:
                        pass
                if cancelled_any:
                    time.sleep(0.8)

                extra_intent = {}
                if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
                    extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

                try:
                    qty_retry = int(qty or 0)
                except Exception:
                    qty_retry = 0
                if qty_retry <= 0:
                    qty_retry = 1

                req_retry = StopLimitOrderRequest(
                    symbol=contract_symbol,
                    qty=qty_retry,
                    side=OrderSide.SELL,
                    time_in_force=TimeInForce.DAY,
                    stop_price=stop_price,
                    limit_price=limit_price,
                    **extra_intent,
                )
                order = tc.submit_order(req_retry)
                exit_state["sl_order_ids"] = [str(order.id)]
                exit_state["sl_last_placed_pct"] = sl_dynamic_pct
                submitted_at = _to_iso(
                    getattr(order, "submitted_at", None)
                    or getattr(order, "created_at", None)
                    or getattr(order, "updated_at", None)
                )
                updated_at = _to_iso(getattr(order, "updated_at", None))
                raw_status = _order_status_value(order)
                status = _status_for_ui(raw_status)
                event_ts = submitted_at or updated_at or _iso_now_utc()
                timeline.append({
                    "ts": event_ts,
                    "source": "order_placed",
                    "order_type": "TRAIL_SL_STOP_LIMIT" if is_trailing else "SL_STOP_LIMIT",
                    "order_id": str(order.id),
                    "stop_price": stop_price,
                    "limit_price": limit_price,
                    "pct": round(sl_dynamic_pct, 4),
                    "order_count": 1,
                    "status": status or "live",
                    "raw_status": raw_status,
                    "status_at": event_ts,
                    "submitted_at": submitted_at,
                    "updated_at": updated_at,
                })
                info(
                    f"[{label} STOP] (cancel-open->retry) {contract_symbol} stop={stop_price:.4f} limit={limit_price:.4f} "
                    f"(sl={sl_dynamic_pct:+.2f}%) id={order.id}"
                )
                return {
                    "operation": "placed",
                    "prev_order_id": existing_id,
                    "new_order_id": str(order.id),
                    "stop_price": stop_price,
                    "limit_price": limit_price,
                    "sl_dynamic_pct": sl_dynamic_pct,
                }
            except Exception as ex_retry:
                info(f"[{label} STOP] Retry after held qty failed for {contract_symbol}: {ex_retry}")
                # fall through to other fallbacks
        # If broker complains about missing qty, try submitting using notional.
        
        if "qty or notional" in low or "qty or notional is required" in low:
            try:
                notional = round(float(stop_price) * 100.0 * float(qty), 2)
                extra_intent = {}
                if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
                    extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

                req2 = StopLossRequest(
                    symbol=contract_symbol,
                    notional=notional,
                    side=OrderSide.SELL,
                    time_in_force=TimeInForce.DAY,
                    stop_price=stop_price,
                    **extra_intent,
                )
                order = tc.submit_order(req2)
                exit_state["sl_order_ids"] = [str(order.id)]
                exit_state["sl_last_placed_pct"] = sl_dynamic_pct
                submitted_at = _to_iso(
                    getattr(order, "submitted_at", None)
                    or getattr(order, "created_at", None)
                    or getattr(order, "updated_at", None)
                )
                updated_at = _to_iso(getattr(order, "updated_at", None))
                raw_status = _order_status_value(order)
                status = _status_for_ui(raw_status)
                event_ts = submitted_at or updated_at or _iso_now_utc()
                timeline.append({
                    "ts": event_ts,
                    "source": "order_placed",
                    "order_type": "TRAIL_SL_STOP_MARKET" if is_trailing else "SL_STOP_MARKET",
                    "order_id": str(order.id),
                    "stop_price": stop_price,
                    "pct": round(sl_dynamic_pct, 4),
                    "order_count": 1,
                    "status": status or "live",
                    "raw_status": raw_status,
                    "status_at": event_ts,
                    "submitted_at": submitted_at,
                    "updated_at": updated_at,
                })
                info(
                    f"[{label} STOP] (notional fallback) {contract_symbol} stop={stop_price:.4f} "
                    f"(sl={sl_dynamic_pct:+.2f}%) id={order.id}"
                )
                return {
                    "operation": "placed",
                    "prev_order_id": None,
                    "new_order_id": str(order.id),
                    "stop_price": stop_price,
                    "limit_price": None,
                    "sl_dynamic_pct": sl_dynamic_pct,
                }
            except Exception as ex2:
                info(f"[{label} STOP] Notional fallback failed for {contract_symbol}: {ex2}")
                timeline.append({
                    "ts": _iso_now_utc(),
                    "source": "order_placed",
                    "order_type": "TRAIL_SL_STOP_MARKET" if is_trailing else "SL_STOP_MARKET",
                    "order_id": None,
                    "prev_order_id": existing_id,
                    "stop_price": stop_price,
                    "pct": round(sl_dynamic_pct, 4),
                    "order_count": len(exit_state.get("sl_order_ids") or []),
                    "status": "error",
                    "error": str(ex2),
                })
                # Final fallback: if both qty and notional submissions failed,
                # submit a direct market sell to ensure the position is closed.
                try:
                    market_order = place_market_order(tc, contract_symbol, qty, OrderSide.SELL, allow_limit=False)
                    mo_id = str(getattr(market_order, "id", "") or "")
                    exit_state["sl_order_ids"] = [mo_id]
                    exit_state["sl_last_placed_pct"] = sl_dynamic_pct
                    submitted_at = _to_iso(
                        getattr(market_order, "submitted_at", None)
                        or getattr(market_order, "created_at", None)
                        or getattr(market_order, "updated_at", None)
                    )
                    updated_at = _to_iso(getattr(market_order, "updated_at", None))
                    raw_status = _order_status_value(market_order)
                    status = _status_for_ui(raw_status)
                    event_ts = submitted_at or updated_at or _iso_now_utc()
                    timeline.append({
                        "ts": event_ts,
                        "source": "order_placed",
                        "order_type": "MARKET_SELL_FALLBACK",
                        "order_id": mo_id,
                        "prev_order_id": existing_id,
                        "stop_price": stop_price,
                        "pct": round(sl_dynamic_pct, 4),
                        "order_count": 1,
                        "status": status or "submitted",
                        "raw_status": raw_status,
                        "status_at": event_ts,
                        "submitted_at": submitted_at,
                        "updated_at": updated_at,
                    })
                    info(f"[{label} STOP] (market fallback) {contract_symbol} forced market sell id={mo_id}")
                    return {
                        "operation": "market_sold",
                        "prev_order_id": existing_id,
                        "new_order_id": mo_id,
                        "stop_price": stop_price,
                        "limit_price": None,
                        "sl_dynamic_pct": sl_dynamic_pct,
                    }
                except Exception as ex3:
                    info(f"[{label} STOP] Market fallback failed for {contract_symbol}: {ex3}")
                    timeline.append({
                        "ts": _iso_now_utc(),
                        "source": "order_placed",
                        "order_type": "MARKET_SELL_FALLBACK",
                        "order_id": None,
                        "prev_order_id": existing_id,
                        "stop_price": stop_price,
                        "pct": round(sl_dynamic_pct, 4),
                        "order_count": len(exit_state.get("sl_order_ids") or []),
                        "status": "error",
                        "error": str(ex3),
                    })
                    return {
                        "operation": "error",
                        "prev_order_id": existing_id,
                        "new_order_id": None,
                        "stop_price": stop_price,
                        "limit_price": None,
                        "sl_dynamic_pct": sl_dynamic_pct,
                        "error": str(ex3),
                    }

                try:
                    # As a last-resort protective measure, attempt to create a broker-side
                    # safety stop order (StopLossRequest) that may succeed where other
                    # stop-limit flows failed. This ensures the trade has at least one
                    # broker-protected order recorded if possible.
                    from order_execution import upsert_broker_safety_sl
                    try:
                        safe_qty = int(qty or 0)
                    except Exception:
                        safe_qty = 0
                    if safe_qty <= 0:
                        safe_qty = 1
                    fill_price = float(exit_state.get("fill_price", 0) or 0)
                    safety_id = None
                    if buy_order_id and fill_price > 0:
                        try:
                            safety_id = upsert_broker_safety_sl(tc, buy_order_id, contract_symbol, safe_qty, fill_price, sl_dynamic_pct)
                        except Exception:
                            safety_id = None
                    if safety_id:
                        # Mirror safety info into the monitor's exit_state for visibility
                        exit_state["broker_safety_sl_order_id"] = str(safety_id)
                        exit_state["broker_safety_sl_stop_price"] = stop_price
                        exit_state["broker_safety_sl_limit_price"] = None
                        exit_state["broker_safety_sl_last_placed_pct"] = float(sl_dynamic_pct)
                        timeline.append({
                            "ts": _iso_now_utc(),
                            "source": "order_placed",
                            "order_type": "SAFETY_SL_STOP_MARKET",
                            "order_id": str(safety_id),
                            "prev_order_id": existing_id,
                            "stop_price": stop_price,
                            "pct": round(sl_dynamic_pct, 4),
                            "order_count": len(exit_state.get("sl_order_ids") or []),
                            "status": "live",
                        })
                        info(f"[{label} STOP] Safety SL placed id={safety_id} for {contract_symbol}")
                        return {
                            "operation": "safety_placed",
                            "prev_order_id": existing_id,
                            "new_order_id": str(safety_id),
                            "stop_price": stop_price,
                            "limit_price": None,
                            "sl_dynamic_pct": sl_dynamic_pct,
                        }
                except Exception:
                    pass

                return {
                    "operation": "error",
                    "prev_order_id": existing_id,
                    "new_order_id": None,
                    "stop_price": stop_price,
                    "limit_price": None,
                    "sl_dynamic_pct": sl_dynamic_pct,
                    "error": err_str,
                }


def _cancel_sl_orders(tc, exit_state: dict) -> None:
    """Cancel ALL outstanding SL stop-limit orders."""
    if tc is None:
        return
    order_ids = exit_state.get("sl_order_ids") or []
    timeline = exit_state.setdefault("timeline", [])
    for oid in order_ids:
        try:
            tc.cancel_order_by_id(oid)
            info(f"[SL STOP] Cancelled {oid}")
            cancel_snapshot = _fetch_order_snapshot(tc, oid)
            _mark_timeline_order_status(timeline, oid, cancel_snapshot, fallback_status="cancelled")
        except Exception:
            pass
    exit_state["sl_order_ids"] = []


def _check_sl_order_filled(tc, exit_state: dict) -> bool:
    """Check if any SL stop-limit order filled. On fill: cancel remaining SL + TP."""
    if tc is None:
        return False
    order_ids = list(exit_state.get("sl_order_ids") or [])
    if not order_ids:
        return False
    filled_id = None
    filled_price = None
    filled_snapshot = None
    for oid in order_ids:
        try:
            order = tc.get_order_by_id(oid)
            status = str(getattr(order, "status", "")).lower()
            if "filled" in status:
                filled_id = oid
                fp = float(getattr(order, "filled_avg_price", 0) or 0)
                filled_price = fp if fp > 0 else None
                filled_snapshot = _fetch_order_snapshot(tc, oid)
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
                    cancel_snapshot = _fetch_order_snapshot(tc, oid)
                    _mark_timeline_order_status(timeline, oid, cancel_snapshot, fallback_status="cancelled")
                except Exception:
                    pass
        if filled_snapshot is None:
            filled_snapshot = {
                "status": "filled",
                "raw_status": "filled",
                "status_at": _iso_now_utc(),
                "filled_at": _iso_now_utc(),
                "fill_price": filled_price,
            }
        _mark_timeline_order_status(timeline, filled_id, filled_snapshot, fallback_status="filled")
        exit_state["sl_order_ids"] = []
        exit_state["sl_order_filled"] = True
        exit_state["sl_order_id_filled"] = filled_id
        exit_state["sl_order_fill_price"] = filled_price
        exit_state["sl_order_exit_reason"] = "STOP_LOSS_EXIT"
        _cancel_tp_orders(tc, exit_state)
        info(
            f"[SL STOP] Order {filled_id} filled at {filled_price:.4f} — "
            f"{len(order_ids)-1} other SL orders cancelled → {exit_state['sl_order_exit_reason']}"
        )
        return True
    return False


def _detect_market_fallback_reason(tc, exit_state: dict, sellable_price: float) -> tuple[str | None, str | None]:
    """Return fallback reason when market sell must be forced.

    Case 1: SL missed in a gap-down (price below SL limit after trigger).
    Case 2: Order-system failure ONLY when SL should have triggered but still does not fill.
    """
    if tc is None or bool(exit_state.get("is_closing", False)):
        return None, None

    tp_ids = list(exit_state.get("tp_order_ids") or [])
    sl_ids = list(exit_state.get("sl_order_ids") or [])

    fetched_any = False
    failure_tokens = ("rejected", "expired", "canceled", "cancelled")

    # Only SL governs market fallback. TP status alone must not trigger fallback.
    _ = tp_ids

    trigger_grace_sec = 2.0
    triggered_but_unfilled = False

    for oid in sl_ids:
        try:
            order = tc.get_order_by_id(oid)
            fetched_any = True
        except Exception:
            continue
        status = str(getattr(order, "status", "") or "").lower()
        if any(tok in status for tok in failure_tokens):
            return "ORDER_SYSTEM_FAILURE_MARKET_EXIT", f"sl_order_status={status}:{oid}"

        if "filled" in status:
            continue

        stop_price = float(getattr(order, "stop_price", 0) or 0)
        limit_price = float(getattr(order, "limit_price", 0) or 0)

        # Gap-down miss: stop triggered but market below limit, so stop-limit cannot fill.
        if stop_price > 0 and limit_price > 0 and sellable_price <= stop_price and sellable_price < limit_price:
            detail = (
                f"sl_gap_down_miss:oid={oid}:sellable={sellable_price:.4f}:"
                f"stop={stop_price:.4f}:limit={limit_price:.4f}:status={status}"
            )
            return "SL_MISSED_GAPDOWN_MARKET_EXIT", detail

        # SL should be active now (price reached/under stop) but did not fill.
        if stop_price > 0 and sellable_price <= stop_price:
            triggered_but_unfilled = True
            key = f"sl_trigger_seen_ts:{oid}"
            first_seen = float(exit_state.get(key, 0.0) or 0.0)
            now_ts = time.time()
            if first_seen <= 0.0:
                exit_state[key] = now_ts
                continue
            if (now_ts - first_seen) >= trigger_grace_sec:
                # If SL is triggered but order remains non-filled after grace,
                # treat as order-system failure and force market exit.
                if any(tok in status for tok in failure_tokens):
                    return "ORDER_SYSTEM_FAILURE_MARKET_EXIT", f"sl_order_status={status}:{oid}"
                if "filled" not in status:
                    detail = (
                        f"sl_triggered_not_filled:oid={oid}:sellable={sellable_price:.4f}:"
                        f"stop={stop_price:.4f}:limit={limit_price:.4f}:status={status}:"
                        f"waited={now_ts-first_seen:.2f}s"
                    )
                    return "ORDER_SYSTEM_FAILURE_MARKET_EXIT", detail

    # Clear stale trigger timers once price is above all tracked SL stops.
    if not triggered_but_unfilled:
        for k in [k for k in list(exit_state.keys()) if str(k).startswith("sl_trigger_seen_ts:")]:
            exit_state.pop(k, None)

    # If SL ids exist but broker cannot confirm any of them while in triggered zone,
    # then and only then mark as order-system failure.
    if sl_ids and not fetched_any:
        sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", exit_state.get("sl_static_pct", 0.0)) or 0.0)
        fill_price = float(exit_state.get("fill_price", 0.0) or 0.0)
        sl_trigger_price = fill_price * (1.0 + sl_dynamic_pct / 100.0) if fill_price > 0 else 0.0
        if sl_trigger_price > 0 and sellable_price <= sl_trigger_price:
            return "ORDER_SYSTEM_FAILURE_MARKET_EXIT", "sl_orders_not_confirmed_by_broker_after_trigger"

    return None, None


def _cancel_exit_orders(tc, exit_state: dict) -> None:
    """Cancel all outstanding exit protection orders (TP + SL stop-limit)."""
    exit_state["is_closing"] = True
    _cancel_tp_orders(tc, exit_state)
    _cancel_sl_orders(tc, exit_state)


def _attempt_place_tp_limit(tc, exit_state: dict, contract_symbol: str | None, qty: int) -> dict | None:
    """When TP is configured in 'price' mode and no TP child exists, place a limit
    sell at the configured absolute `tp_price`. Returns placement info or None.
    """
    if tc is None or not contract_symbol or qty <= 0:
        return None
    # Don't place if TP already filled or TP child exists
    if bool(exit_state.get("tp_order_filled", False)):
        return None
    if exit_state.get("tp_order_ids"):
        return None
    tp_price = float(exit_state.get("tp_price") or 0.0)
    if tp_price <= 0:
        return None

    try:
        # To avoid "held_for_orders" qty errors (can only have one exit order on some accounts),
        # cancel any existing broker SL child before placing the TP limit.
        _cancel_sl_orders(tc, exit_state)
        order = place_market_order(
            tc,
            contract_symbol,
            qty,
            OrderSide.SELL,
            reference_price=tp_price,
            allow_limit=True,
            force_limit=True,
        )
        order_id = str(getattr(order, "id", "") or "")
        if not order_id:
            return None

        # record TP child id and timeline event
        exit_state["tp_order_ids"] = [order_id]
        timeline = exit_state.setdefault("timeline", [])
        submitted_at = _to_iso(getattr(order, "submitted_at", None) or getattr(order, "created_at", None) or getattr(order, "updated_at", None))
        updated_at = _to_iso(getattr(order, "updated_at", None))
        raw_status = _order_status_value(order)
        status = _status_for_ui(raw_status)
        event_ts = submitted_at or updated_at or _iso_now_utc()
        timeline.append({
            "ts": event_ts,
            "source": "order_placed",
            "order_type": "TP_LIMIT",
            "order_id": order_id,
            "limit_price": round(float(tp_price), 2),
            "status": status or "live",
            "raw_status": raw_status,
            "status_at": event_ts,
            "submitted_at": submitted_at,
            "updated_at": updated_at,
        })
        info(f"[TP LIMIT] Placed TP limit {contract_symbol} @{tp_price:.4f} id={order_id}")
        return {"operation": "placed", "order_id": order_id, "limit_price": tp_price}
    except Exception as ex:
        info(f"[TP LIMIT] Failed to place TP limit for {contract_symbol}: {ex}")
        return None


def _update_dynamic_thresholds(
    exit_state: dict,
    pnl_pct: float,
    current_price: float | None = None,
    tick_ts: str | None = None,
    tc=None,
    contract_symbol: str | None = None,
    qty: int = 1,
    buy_order_id: str | None = None,
) -> None:
    fill_price = float(exit_state.get("fill_price", 0.0) or 0.0)

    if pnl_pct > float(exit_state.get("max_pnl_pct", 0.0)):
        exit_state["max_pnl_pct"] = pnl_pct

    if bool(exit_state.get("is_closing", False)):
        return

    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    tp_pct = float(exit_state.get("tp_pct", 0.0))
    prev_sl_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))

    def _pct_to_price(pct: float) -> float | None:
        if fill_price <= 0:
            return None
        return round(fill_price * (1.0 + pct / 100.0), 4)

    # Prefer absolute TP price when configured in 'price' mode, otherwise derive from pct
    if str(EXIT_TAKE_PROFIT_MODE).lower() == "price":
        tp_price_val = exit_state.get("tp_price")
    else:
        tp_price_val = _pct_to_price(tp_pct)

    # Prefer absolute SL price when configured in 'price' mode for initial values
    if str(EXIT_STOP_LOSS_MODE).lower() == "price":
        sl_prev_price_val = exit_state.get("sl_price")
    else:
        sl_prev_price_val = _pct_to_price(prev_sl_pct)

    tick_actions = {
        "tp_action": "NO_CHANGE",
        "tp_price": tp_price_val,
        "sl_action": "NO_CHANGE",
        "sl_prev_pct": round(prev_sl_pct, 4),
        "sl_new_pct": round(prev_sl_pct, 4),
        "sl_prev_price": sl_prev_price_val,
        "sl_new_price": sl_prev_price_val,
        "sl_order_action": "NO_CHANGE",
        "sl_update_reason": None,
    }

    def _price_to_pct(price: float | None) -> float | None:
        if fill_price <= 0 or price is None:
            return None
        return ((float(price) / fill_price) - 1.0) * 100.0

    existing_sl_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    existing_sl_price = _pct_to_price(existing_sl_pct)

    mode = "LOSS"
    qp_price = None
    sl_candidate_price = existing_sl_price

    if fill_price > 0 and current_price is not None:
        live_price = float(current_price)
        if live_price > fill_price:
            # PROFIT MODE:
            # QP = current - 0.01
            # trailing_SL = current - 0.25
            # SL = max(existing_SL, QP, trailing_SL)
            mode = "PROFIT"
            qp_price = round(live_price - CAPE_QP_OFFSET, 2)
            trailing_sl_price = round(live_price - CAPE_TRAILING_SL_OFFSET, 2)
            sl_candidate_price = max(existing_sl_price, qp_price, trailing_sl_price)

            qp_candidate_pct = _price_to_pct(qp_price)
            if qp_candidate_pct is not None:
                exit_state["qp_dynamic_pct"] = qp_candidate_pct
                if qp_candidate_pct > 0.0 and not bool(exit_state.get("qp_armed", False)):
                    exit_state["qp_armed"] = True
                    exit_state["qp_arm_time"] = tick_ts or _iso_now_utc()
                    exit_state["qp_arm_price"] = round(live_price, 4)
                    exit_state["qp_arm_pnl_pct"] = round(float(pnl_pct), 4)
                    exit_state["qp_arm_peak_pct"] = round(float(max_pnl_pct), 4)
        else:
            # LOSS MODE:
            # Disable QP. Tighten SL based on drawdown so SL ratchets upward as loss grows.
            exit_state["qp_dynamic_pct"] = 0.0
            exit_state["qp_armed"] = False

            # Match required example behavior:
            # initial_SL = entry - 0.25 (stored as sl_static_pct / sl_price)
            # trailing_SL_loss = initial_SL + (entry - current)
            # SL = max(existing_SL, trailing_SL_loss)
            sl_static_price = _pct_to_price(sl_static_pct)
            if sl_static_price is None:
                sl_static_price = max(0.0, fill_price - CAPE_TRAILING_SL_OFFSET)

            drawdown = max(0.0, fill_price - live_price)
            trailing_sl_price = round(sl_static_price + drawdown, 2)
            sl_candidate_price = max(existing_sl_price, trailing_sl_price)

    if sl_candidate_price is not None:
        sl_candidate_pct = _price_to_pct(sl_candidate_price)
        if sl_candidate_pct is not None:
            exit_state["sl_dynamic_pct"] = max(existing_sl_pct, sl_candidate_pct)

    current_sl_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    profit_sl_moved = (
        mode == "PROFIT"
        and qp_price is not None
        and existing_sl_price is not None
        and qp_price > existing_sl_price
    )
    loss_sl_moved = mode != "PROFIT" and current_sl_pct > prev_sl_pct
    if profit_sl_moved or loss_sl_moved:
        tick_actions["sl_action"] = "UPDATED"
        tick_actions["sl_new_pct"] = round(current_sl_pct, 4)
        tick_actions["sl_new_price"] = _pct_to_price(current_sl_pct)
        if mode == "PROFIT":
            tick_actions["sl_update_reason"] = "QP_PRIMARY_PUSH"
        else:
            tick_actions["sl_update_reason"] = "LOSS_TIGHTEN_PUSH"

    # ── SL stop-limit order: keep exactly one live order at current dynamic SL ──
    sl_last_placed = exit_state.get("sl_last_placed_pct")
    sl_last_placed_price = (
        _pct_to_price(float(sl_last_placed))
        if sl_last_placed is not None
        else None
    )
    profit_sl_replace = (
        mode == "PROFIT"
        and qp_price is not None
        and sl_last_placed_price is not None
        and qp_price > sl_last_placed_price
    )
    sl_order_result = None
    if SL_STOP_ORDERS_ENABLED and not bool(exit_state.get("sl_broker_disabled", False)):
        if sl_last_placed is None or profit_sl_replace or (mode != "PROFIT" and current_sl_pct > float(sl_last_placed)):
            sl_order_result = _place_sl_stop_order(tc, exit_state, contract_symbol, qty, buy_order_id)

    if tick_actions["sl_action"] == "UPDATED":
        if sl_order_result and sl_order_result.get("operation") == "replaced":
            tick_actions["sl_order_action"] = "CANCEL_OLD_SL_AND_PLACE_NEW_SL"
            tick_actions["sl_order_prev_id"] = sl_order_result.get("prev_order_id")
            tick_actions["sl_order_new_id"] = sl_order_result.get("new_order_id")
        elif sl_order_result and (sl_order_result.get("operation") == "placed" or sl_order_result.get("operation") == "safety_placed"):
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
    sellable_price: float | None = None,
    use_extended_exit_criteria: bool = True,
) -> str | None:
    tp_pct = float(exit_state.get("tp_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))

    # Priority 1: full TP / full SL.
    # If configured in absolute-price mode and we have a sellable price, prefer
    # direct price comparisons rather than percent math so small dollar TPs are
    # captured exactly at the configured price.
    if EXIT_TAKE_PROFIT_ENABLED:
        if str(EXIT_TAKE_PROFIT_MODE).lower() == "price" and sellable_price is not None:
            tp_price_abs = float(exit_state.get("tp_price") or 0.0)
            if tp_price_abs > 0 and sellable_price >= tp_price_abs:
                return "TAKE_PROFIT_EXIT"
        elif pnl_pct >= tp_pct:
            return "TAKE_PROFIT_EXIT"

    if EXIT_STOP_LOSS_ENABLED:
        # In CAPE strategy, the active SL is sl_dynamic_pct (QP/trailing-driven),
        # even if EXIT_STOP_LOSS_MODE == "price" (sl_price is only the initial SL).
        if sellable_price is not None and float(exit_state.get("fill_price", 0) or 0) > 0:
            fill_price = float(exit_state.get("fill_price", 0) or 0)
            sl_trigger_price = fill_price * (1.0 + sl_dynamic_pct / 100.0)
            if sl_trigger_price > 0 and sellable_price <= sl_trigger_price:
                return "STOP_LOSS_EXIT"
        elif pnl_pct <= sl_static_pct:
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
    _seed_bracket_exit_orders(tc, exit_state, buy_entry_order_id or buy_order_id)
    if not bool(exit_state.get("sl_broker_disabled", False)):
        if not (exit_state.get("sl_order_ids") or []):
            _place_sl_stop_order(tc, exit_state, contract_symbol, qty, buy_order_id)
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
                        tc=tc, contract_symbol=contract_symbol, qty=qty, buy_order_id=buy_order_id)
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

        fallback_reason, fallback_detail = _detect_market_fallback_reason(tc, exit_state, sellable_price)
        if fallback_reason:
            if buy_order_id:
                set_live_exit_reason(buy_order_id, fallback_reason)
            info(
                f"{label}{fallback_reason} - {fallback_detail} - "
                f"forcing market-exit fallback at {sellable_price:.4f}"
            )
            _cancel_exit_orders(tc, exit_state)
            _append_sell_tick(
                exit_state,
                fallback_reason,
                sellable_price,
                fill_price,
                bid_price=bid_price if bid_price > 0 else None,
                mid_price=price,
            )
            return fallback_reason, sellable_price, exit_state

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

        # Bracket-only mode: TP/SL child fills are the only exits.
        if bool(exit_state.get("use_bracket_exit", False)):
            continue

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
            sellable_price=sellable_price,
            use_extended_exit_criteria=use_extended_exit_criteria,
        )
        if exit_reason:
            # If TP triggered in absolute-price mode but no TP order exists yet,
            # attempt to place an explicit TP limit and continue monitoring so
            # small-dollar price targets can be captured by a limit fill.
            if (
                exit_reason == "TAKE_PROFIT_EXIT"
                and str(EXIT_TAKE_PROFIT_MODE).lower() == "price"
                and not exit_state.get("tp_order_filled")
                and not (exit_state.get("tp_order_ids") or [])
            ):
                placed = _attempt_place_tp_limit(tc, exit_state, contract_symbol, qty)
                if placed:
                    # don't return yet — wait for the TP limit to fill on subsequent ticks
                    info(f"{label}TAKE_PROFIT_EXIT detected — placed TP limit, awaiting fill")
                    # broadcast live state and continue loop
                    if buy_order_id:
                        update_live_exit_state(buy_order_id, exit_state, pnl_pct, sellable_price)
                    time.sleep(0.2)
                    continue

            # Immediate STOP_LOSS handling: if SL threshold reached but SL not filled,
            # force the market-fallback path immediately (caller will execute market sell).
            if exit_reason == "STOP_LOSS_EXIT":
                # compute absolute SL price
                sl_abs = 0.0
                try:
                    sl_dyn_pct = float(exit_state.get("sl_dynamic_pct", exit_state.get("sl_static_pct", 0.0)) or 0.0)
                    if float(fill_price) > 0:
                        sl_abs = round(float(fill_price) * (1.0 + sl_dyn_pct / 100.0), 4)
                except Exception:
                    sl_abs = 0.0

                # Immediate CAPE fallback: if price is UNDER the active SL and
                # the broker order still isn't filled, force a market exit.
                if sl_abs > 0 and sellable_price <= sl_abs and not bool(exit_state.get("sl_order_filled", False)):
                    # mark fallback reason and return so caller can immediately place market sell
                    fallback_reason = "ORDER_SYSTEM_FAILURE_MARKET_EXIT"
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, fallback_reason)
                    info(
                        f"{label}{fallback_reason} - SL triggered ({sellable_price:.4f} <= {sl_abs:.4f}) but not filled; forcing market-exit"
                    )
                    _cancel_exit_orders(tc, exit_state)
                    _append_sell_tick(
                        exit_state,
                        fallback_reason,
                        sellable_price,
                        fill_price,
                        bid_price=bid_price if bid_price > 0 else None,
                        mid_price=price,
                    )
                    return fallback_reason, sellable_price, exit_state

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
        _seed_bracket_exit_orders(tc, state["exit_state"], buy_entry_order_id or buy_order_id)
        if not bool(state["exit_state"].get("sl_broker_disabled", False)):
            if not (state["exit_state"].get("sl_order_ids") or []):
                _place_sl_stop_order(tc, state["exit_state"], contract_symbol, qty, buy_order_id)
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
                buy_order_id=buy_order_id,
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

                fallback_reason, fallback_detail = _detect_market_fallback_reason(
                    tc,
                    state["exit_state"],
                    sellable_price,
                )
                if fallback_reason:
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, fallback_reason)
                    info(
                        f"{label}{fallback_reason} - {fallback_detail} - "
                        f"forcing market-exit fallback at {sellable_price:.4f}"
                    )
                    _cancel_exit_orders(tc, state["exit_state"])
                    state["last_price"] = sellable_price
                    state["exit_reason"] = fallback_reason
                    _append_sell_tick(
                        state["exit_state"],
                        fallback_reason,
                        sellable_price,
                        fill_price,
                        bid_price=bid if bid > 0 else None,
                        mid_price=price,
                    )
                    done.set()
                    stop_stream(stream)
                    return
            # Evaluate absolute-price TP/SL preference here as well. If TP triggered
            # in price mode but no TP order exists, attempt to place one and wait.
            pnl_pct = (sellable_price - fill_price) / fill_price * 100
            exit_reason = _evaluate_priority_exit(
                pnl_pct,
                state["exit_state"],
                sellable_price=sellable_price,
                use_extended_exit_criteria=use_extended_exit_criteria,
            )
            if exit_reason == "STOP_LOSS_EXIT":
                # Immediate CAPE fallback: if price is under active SL and broker
                # stop-limit isn't filled, force market exit.
                sl_abs = 0.0
                try:
                    sl_dyn_pct = float(state["exit_state"].get("sl_dynamic_pct", state["exit_state"].get("sl_static_pct", 0.0)) or 0.0)
                    if float(fill_price) > 0:
                        sl_abs = round(float(fill_price) * (1.0 + sl_dyn_pct / 100.0), 4)
                except Exception:
                    sl_abs = 0.0

                if sl_abs > 0 and sellable_price <= sl_abs and not bool(state["exit_state"].get("sl_order_filled", False)):
                    fallback_reason = "ORDER_SYSTEM_FAILURE_MARKET_EXIT"
                    if buy_order_id:
                        set_live_exit_reason(buy_order_id, fallback_reason)
                    info(
                        f"{label}{fallback_reason} - SL triggered ({sellable_price:.4f} <= {sl_abs:.4f}) but not filled; forcing market-exit"
                    )
                    _cancel_exit_orders(tc, state["exit_state"])
                    state["last_price"] = sellable_price
                    state["exit_reason"] = fallback_reason
                    _append_sell_tick(
                        state["exit_state"],
                        fallback_reason,
                        sellable_price,
                        fill_price,
                        bid_price=bid if bid > 0 else None,
                        mid_price=price,
                    )
                    done.set()
                    stop_stream(stream)
                    return
            if (
                exit_reason == "TAKE_PROFIT_EXIT"
                and str(EXIT_TAKE_PROFIT_MODE).lower() == "price"
                and not state["exit_state"].get("tp_order_filled")
                and not (state["exit_state"].get("tp_order_ids") or [])
            ):
                placed = _attempt_place_tp_limit(tc, state["exit_state"], contract_symbol, qty)
                if placed:
                    info(f"{label}WS TAKE_PROFIT_EXIT detected — placed TP limit, awaiting fill")
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

            # Bracket-only mode: TP/SL child fills are the only exits.
            if bool(state["exit_state"].get("use_bracket_exit", False)):
                return

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
                sellable_price=sellable_price,
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
