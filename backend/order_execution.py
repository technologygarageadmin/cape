import time
import threading
from datetime import datetime, timezone
from alpaca.trading.enums import OrderStatus, TimeInForce
from alpaca.trading.requests import LimitOrderRequest, MarketOrderRequest
from config import (
    ENTRY_LIMIT_OFFSET_PCT,
    ENTRY_ORDER_TYPE,
    ENTRY_TIME_IN_FORCE,
    FILL_CHECK_INTERVAL_SEC,
)
from logger import debug, info

# ---------------------------------------------------------------------------
# Position registry — tracks every open lot by its Alpaca buy_order_id.
# This lets us isolate each lot even if the same contract symbol is held
# in multiple concurrent trades.
# ---------------------------------------------------------------------------
_positions: dict[str, dict] = {}   # buy_order_id → metadata
_positions_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Live exit state — updated on every monitoring poll tick.
# Shared between monitoring loops and the API so frontend can see real-time
# QP / SL / TSL thresholds and current PnL.
# keyed by buy_order_id.
# ---------------------------------------------------------------------------
_live_exit_states: dict[str, dict] = {}
_live_exit_lock = threading.Lock()


def register_position(
    buy_order_id: str,
    symbol: str,
    contract_symbol: str,
    qty: int,
    fill_price: float,
    tp_price: float,
    sl_price: float,
    leg_name: str,
    trade_type: str = "",
    signal_time: str | None = None,
    entry_time: str | None = None,
    entry_reasons: list[str] | None = None,
    entry_filters_passed: list[str] | None = None,
) -> None:
    """Record a newly filled buy lot in the registry."""
    with _positions_lock:
        _positions[buy_order_id] = {
            "buy_order_id": buy_order_id,
            "symbol": symbol,
            "contract_symbol": contract_symbol,
            "qty": qty,
            "fill_price": fill_price,
            "tp_price": tp_price,
            "sl_price": sl_price,
            "leg_name": leg_name,
            "trade_type": trade_type,
            "status": "OPEN",   # OPEN | SELLING | CLOSED
            "sell_order_id": None,
            "registered_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "cross_time": signal_time,
            "entry_time": entry_time,
            "entry_reasons": entry_reasons or [],
            "entry_filters_passed": entry_filters_passed or [],
        }
    # Init live state with starting values
    with _live_exit_lock:
        _live_exit_states[buy_order_id] = {
            "pnl_pct": 0.0,
            "current_price": fill_price,
            "fill_price": fill_price,
            "tp_pct": ((tp_price / fill_price) - 1.0) * 100.0 if fill_price > 0 else 0.0,
            "sl_static_pct": ((sl_price / fill_price) - 1.0) * 100.0 if fill_price > 0 else 0.0,
            "sl_dynamic_pct": ((sl_price / fill_price) - 1.0) * 100.0 if fill_price > 0 else 0.0,
            "qp_floor_pct": 0.0,
            "qp_dynamic_pct": 0.0,
            "max_pnl_pct": 0.0,
            "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "exit_reason": None,
            "monitoring_active": True,
        }
    info(f"[REGISTRY] Registered {buy_order_id} → {contract_symbol} qty={qty} status=OPEN")


def mark_selling(buy_order_id: str, sell_order_id: str) -> None:
    """Transition a lot from OPEN to SELLING once the sell order is submitted."""
    with _positions_lock:
        pos = _positions.get(buy_order_id)
        if pos:
            pos["status"] = "SELLING"
            pos["sell_order_id"] = sell_order_id
    info(f"[REGISTRY] {buy_order_id} → SELLING (sell_order_id={sell_order_id})")


def close_position(buy_order_id: str) -> dict | None:
    """Mark a lot CLOSED after the sell fill is confirmed. Returns the closed record."""
    with _positions_lock:
        pos = _positions.get(buy_order_id)
        if pos:
            pos["status"] = "CLOSED"
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["monitoring_active"] = False
    info(f"[REGISTRY] {buy_order_id} → CLOSED")
    return pos


def get_open_positions() -> list[dict]:
    """Return all lots currently in OPEN or SELLING state."""
    with _positions_lock:
        return [v for v in _positions.values() if v["status"] != "CLOSED"]


def update_live_exit_state(buy_order_id: str, exit_state: dict, pnl_pct: float, current_price: float) -> None:
    """Called from monitoring loops on each tick to update live exit thresholds."""
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live is None:
            live = {}
            _live_exit_states[buy_order_id] = live
        live["pnl_pct"] = round(pnl_pct, 4)
        live["current_price"] = round(current_price, 4)
        live["tp_pct"] = round(float(exit_state.get("tp_pct", 0)), 4)
        live["sl_static_pct"] = round(float(exit_state.get("sl_static_pct", 0)), 4)
        live["sl_dynamic_pct"] = round(float(exit_state.get("sl_dynamic_pct", 0)), 4)
        live["qp_floor_pct"] = round(float(exit_state.get("qp_floor_pct", 0)), 4)
        live["qp_dynamic_pct"] = round(float(exit_state.get("qp_dynamic_pct", 0)), 4)
        live["max_pnl_pct"] = round(float(exit_state.get("max_pnl_pct", 0)), 4)
        live["last_updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        live["monitoring_active"] = True


def set_live_exit_reason(buy_order_id: str, exit_reason: str) -> None:
    """Called when exit triggers to record the reason."""
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["exit_reason"] = exit_reason
            live["monitoring_active"] = False


def get_live_positions() -> list[dict]:
    """Return full live position data for the frontend — position + live exit state merged."""
    with _positions_lock:
        open_positions = [dict(v) for v in _positions.values() if v["status"] != "CLOSED"]
    with _live_exit_lock:
        for pos in open_positions:
            live = _live_exit_states.get(pos["buy_order_id"], {})
            pos["live"] = dict(live)
    return open_positions

def _resolve_time_in_force() -> TimeInForce:
    tif_map = {
        "day": TimeInForce.DAY,
        "gtc": TimeInForce.GTC,
        "ioc": TimeInForce.IOC,
        "fok": TimeInForce.FOK,
    }
    return tif_map.get(ENTRY_TIME_IN_FORCE, TimeInForce.DAY)


def place_market_order(
    trading_client,
    contract_symbol,
    qty,
    side,
    reference_price: float | None = None,
    allow_limit: bool = True,
    force_limit: bool = False,
    force_limit_offset_pct: float = 0.0,
):
    tif = _resolve_time_in_force()

    if force_limit:
        if reference_price and reference_price > 0:
            offset = max(0.0, float(force_limit_offset_pct or 0.0))
            if str(side).upper().endswith("BUY"):
                limit_price = round(reference_price * (1 + offset), 4)
            else:
                limit_price = round(reference_price * (1 - offset), 4)

            return trading_client.submit_order(
                LimitOrderRequest(
                    symbol=contract_symbol,
                    qty=qty,
                    side=side,
                    time_in_force=tif,
                    limit_price=limit_price,
                )
            )

        info(
            "force_limit=True but no valid reference_price provided; "
            "falling back to market order"
        )

    if allow_limit and ENTRY_ORDER_TYPE == "limit" and reference_price and reference_price > 0:
        if str(side).upper().endswith("BUY"):
            limit_price = round(reference_price * (1 + ENTRY_LIMIT_OFFSET_PCT), 4)
        else:
            limit_price = round(reference_price * (1 - ENTRY_LIMIT_OFFSET_PCT), 4)

        return trading_client.submit_order(
            LimitOrderRequest(
                symbol=contract_symbol,
                qty=qty,
                side=side,
                time_in_force=tif,
                limit_price=limit_price,
            )
        )

    if allow_limit and ENTRY_ORDER_TYPE == "limit":
        info(
            "ENTRY_ORDER_TYPE=limit but no valid reference_price provided; "
            "falling back to market order"
        )

    return trading_client.submit_order(
        MarketOrderRequest(
            symbol=contract_symbol,
            qty=qty,
            side=side,
            time_in_force=tif,
        )
    )

def wait_for_fill(trading_client, order_id, timeout_sec):

    deadline = time.time() + timeout_sec

    while time.time() < deadline:

        order = trading_client.get_order_by_id(order_id)

        if order.status == OrderStatus.FILLED:
            return order

        if order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED):
            return order

        debug(f"Waiting for fill: order_id={order_id} status={order.status}")

        time.sleep(max(0.2, FILL_CHECK_INTERVAL_SEC))

    info(f"WARNING: order {order_id} not filled within {timeout_sec}s")
    return trading_client.get_order_by_id(order_id)