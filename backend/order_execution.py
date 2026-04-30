import time
import threading
import re
from datetime import datetime, timezone
from alpaca.trading.enums import OrderClass, OrderSide, OrderStatus, TimeInForce
from alpaca.trading.requests import LimitOrderRequest, MarketOrderRequest, ReplaceOrderRequest, StopLimitOrderRequest, StopLossRequest, TakeProfitRequest
from config import (
    ENTRY_LIMIT_OFFSET_PCT,
    ENTRY_ORDER_TYPE,
    ENTRY_TIME_IN_FORCE,
    FILL_CHECK_INTERVAL_SEC,
    SL_STOP_LIMIT_BUFFER_PCT,
    SL_STOP_ORDERS_ENABLED,
)
from logger import debug, info

try:
    from alpaca.trading.enums import PositionIntent
except Exception:  # pragma: no cover
    PositionIntent = None  # type: ignore

_OPTION_CONTRACT_RE = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")


def _is_option_contract_symbol(sym: str | None) -> bool:
    s = str(sym or "").strip().upper()
    return bool(s and _OPTION_CONTRACT_RE.match(s))

# Cache whether bracket/complex orders are supported for options in this environment.
# None = unknown, True = supported, False = not supported (avoid retrying)
_bracket_options_supported: bool | None = None

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
    entry_strategies: list[str] | None = None,
    entry_strategy_names: list[str] | None = None,
    entry_filters_passed: list[str] | None = None,
) -> None:
    """Record a newly filled buy lot in the registry."""
    with _positions_lock:
        _positions[buy_order_id] = {
            "buy_order_id": buy_order_id,
            "symbol": symbol,
            "contract_symbol": contract_symbol,
            "qty": int(qty),
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
            "entry_strategies": entry_strategies or [],
            "entry_strategy_names": entry_strategy_names or [],
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
            "is_closing": False,
            "broker_safety_sl_order_id": None,
            "broker_safety_sl_stop_price": None,
            "broker_safety_sl_limit_price": None,
            "broker_safety_sl_last_placed_pct": None,
        }
    info(f"[REGISTRY] Registered {buy_order_id} → {contract_symbol} qty={qty} status=OPEN")


def mark_selling(buy_order_id: str, sell_order_id: str) -> None:
    """Transition a lot from OPEN to SELLING once the sell order is submitted."""
    with _positions_lock:
        pos = _positions.get(buy_order_id)
        if pos:
            pos["status"] = "SELLING"
            pos["sell_order_id"] = sell_order_id
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["is_closing"] = True
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
            live["is_closing"] = False
    info(f"[REGISTRY] {buy_order_id} → CLOSED")
    return pos


def get_open_positions() -> list[dict]:
    """Return all lots currently in OPEN or SELLING state."""
    with _positions_lock:
        return [v for v in _positions.values() if v["status"] != "CLOSED"]

def get_externally_managed_symbols() -> set[str]:
    """Return contract symbols already managed by the bot's dedicated trade monitors."""
    with _positions_lock:
        return {
            str(v.get("contract_symbol") or "")
            for v in _positions.values()
            if v["status"] != "CLOSED" and v.get("contract_symbol")
        }

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
        live["tp_order_ids"] = list(exit_state.get("tp_order_ids") or [])
        live["tp_order_filled"] = bool(exit_state.get("tp_order_filled", False))
        live["tp_order_id_filled"] = exit_state.get("tp_order_id_filled")
        live["tp_order_fill_price"] = exit_state.get("tp_order_fill_price")
        live["sl_order_ids"] = list(exit_state.get("sl_order_ids") or [])
        live["sl_order_filled"] = bool(exit_state.get("sl_order_filled", False))
        live["sl_order_id_filled"] = exit_state.get("sl_order_id_filled")
        live["sl_order_fill_price"] = exit_state.get("sl_order_fill_price")
        live["sl_order_exit_reason"] = exit_state.get("sl_order_exit_reason")
        live["timeline"] = list(exit_state.get("timeline") or [])[-300:]
        live["broker_safety_sl_order_id"] = exit_state.get("broker_safety_sl_order_id")
        live["broker_safety_sl_stop_price"] = exit_state.get("broker_safety_sl_stop_price")
        live["broker_safety_sl_limit_price"] = exit_state.get("broker_safety_sl_limit_price")
        live["broker_safety_sl_last_placed_pct"] = exit_state.get("broker_safety_sl_last_placed_pct")
        live["is_closing"] = bool(exit_state.get("is_closing", False))
        live["last_updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        live["monitoring_active"] = True


def set_live_exit_reason(buy_order_id: str, exit_reason: str) -> None:
    """Called when exit triggers to record the reason."""
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["exit_reason"] = exit_reason
            live["monitoring_active"] = False
            live["is_closing"] = True


def begin_trade_closing(buy_order_id: str) -> None:
    """Mark a trade as closing so no further broker-side stop updates are applied."""
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["is_closing"] = True


def cancel_broker_safety_sl(trading_client, buy_order_id: str) -> None:
    """Cancel the broker safety stop-loss order if one is live."""
    if trading_client is None:
        return
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id) or {}
        order_id = str(live.get("broker_safety_sl_order_id") or "")
    if not order_id:
        return
    try:
        trading_client.cancel_order_by_id(order_id)
        info(f"[REGISTRY] Cancelled safety SL {order_id} for {buy_order_id}")
    except Exception:
        pass
    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["broker_safety_sl_order_id"] = None
            live["broker_safety_sl_stop_price"] = None
            live["broker_safety_sl_limit_price"] = None
            live["broker_safety_sl_last_placed_pct"] = None


def upsert_broker_safety_sl(
    trading_client,
    buy_order_id: str,
    contract_symbol: str,
    qty: int,
    fill_price: float,
    sl_dynamic_pct: float,
) -> str | None:
    """Create or replace the broker-side stop-limit safety order for an open option trade."""
    if trading_client is None or not contract_symbol or fill_price <= 0:
        return None

    # Round prices to 2 decimals for broker order payloads (Alpaca requires 2-decimal limit prices)
    stop_price = round(float(fill_price) * (1.0 + float(sl_dynamic_pct) / 100.0), 2)
    limit_price = round(stop_price * (1.0 - SL_STOP_LIMIT_BUFFER_PCT / 100.0), 2)

    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live is None:
            live = {}
            _live_exit_states[buy_order_id] = live
        if live.get("is_closing"):
            return str(live.get("broker_safety_sl_order_id") or "") or None
        existing_order_id = str(live.get("broker_safety_sl_order_id") or "")
        last_placed_pct = live.get("broker_safety_sl_last_placed_pct")

    if existing_order_id and last_placed_pct is not None and float(sl_dynamic_pct) <= float(last_placed_pct):
        return existing_order_id

    if existing_order_id:
        try:
            order = trading_client.replace_order_by_id(
                existing_order_id,
                ReplaceOrderRequest(stop_price=stop_price),
            )
            new_order_id = str(getattr(order, "id", existing_order_id) or existing_order_id)
        except Exception as ex:
            info(f"[REGISTRY] Safety SL replace failed for {buy_order_id}: {ex}")
            return existing_order_id
    else:
        try:
            # Ensure qty is valid; derive fallback quantity from open positions if possible.
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
                info(f"[REGISTRY] Safety SL qty invalid ({qty}) — falling back to qty=1 for {contract_symbol}")

            # Use stop-market (StopLossRequest) to reduce gap-down miss risk.
            extra_intent: dict = {}
            if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
                extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

            req = StopLossRequest(
                symbol=contract_symbol,
                qty=qty_int,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
                stop_price=stop_price,
                **extra_intent,
            )
            try:
                info(f"[REGISTRY] Submitting Safety StopLossRequest payload: {req.__dict__}")
            except Exception:
                pass
            order = trading_client.submit_order(req)
            new_order_id = str(getattr(order, "id", "") or "")
        except Exception as ex:
            info(f"[REGISTRY] Safety SL submit failed for {buy_order_id}: {ex}")
            # Attempt fallback using notional if broker requires it
            err = str(ex or "").lower()
            if "qty or notional" in err or "qty or notional is required" in err:
                try:
                    notional = round(float(stop_price) * 100.0 * float(qty_int), 2)
                    req2 = StopLossRequest(
                        symbol=contract_symbol,
                        notional=notional,
                        side=OrderSide.SELL,
                        time_in_force=TimeInForce.DAY,
                        stop_price=stop_price,
                        **extra_intent,
                    )
                    try:
                        info(f"[REGISTRY] Submitting Safety StopLossRequest (notional fallback): {req2.__dict__}")
                    except Exception:
                        pass
                    order = trading_client.submit_order(req2)
                    new_order_id = str(getattr(order, "id", "") or "")
                except Exception as ex2:
                    info(f"[REGISTRY] Safety SL notional fallback failed for {buy_order_id}: {ex2}")
                    return None
            else:
                return None

    with _live_exit_lock:
        live = _live_exit_states.get(buy_order_id)
        if live:
            live["broker_safety_sl_order_id"] = new_order_id
            live["broker_safety_sl_stop_price"] = stop_price
            live["broker_safety_sl_limit_price"] = None
            live["broker_safety_sl_last_placed_pct"] = float(sl_dynamic_pct)
    return new_order_id or None


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
    use_bracket: bool = False,
    take_profit_price: float | None = None,
    stop_loss_price: float | None = None,
):
    tif = _resolve_time_in_force()
    # Determine whether to attempt bracket orders. If we previously detected
    # that options do not support complex/bracket orders in this environment,
    # skip attempting bracket orders for option contracts to avoid repeated
    # rejections from the broker.
    global _bracket_options_supported
    use_bracket = bool(
        use_bracket
        and str(side).upper().endswith("BUY")
        and take_profit_price is not None
        and stop_loss_price is not None
        and take_profit_price > 0
        and stop_loss_price > 0
    )

    if _is_option_contract_symbol(contract_symbol) and _bracket_options_supported is False:
        use_bracket = False

    def _supports_complex_orders_error(ex: Exception) -> bool:
        message = str(ex).lower()
        return (
            "complex orders not supported for options trading" in message
            or "42210000" in message
            or ("bracket" in message and "options" in message)
        )

    def _submit(request):
        try:
            order = trading_client.submit_order(request)
            # If we submitted a bracket order successfully for an option contract,
            # mark that options support complex/bracket orders so future attempts
            # will skip the fallback path.
            try:
                if use_bracket and _is_option_contract_symbol(contract_symbol):
                    _bracket_options_supported = True
            except Exception:
                pass
            return order
        except Exception as ex:
            if use_bracket and _supports_complex_orders_error(ex):
                info("Bracket order rejected for options; retrying without complex legs")
                # mark options as not supporting bracket/complex orders to avoid
                # trying again for subsequent orders
                try:
                    if _is_option_contract_symbol(contract_symbol):
                        _bracket_options_supported = False
                except Exception:
                    pass
                plain_kwargs = dict(request.__dict__)
                plain_kwargs.pop("order_class", None)
                plain_kwargs.pop("take_profit", None)
                plain_kwargs.pop("stop_loss", None)
                return trading_client.submit_order(type(request)(**plain_kwargs))
            raise

    bracket_kwargs: dict = {}
    if use_bracket:
        bracket_kwargs = {
            "order_class": OrderClass.BRACKET,
            "take_profit": TakeProfitRequest(limit_price=round(float(take_profit_price), 2)),
            "stop_loss": StopLossRequest(stop_price=round(float(stop_loss_price), 2)),
        }

    extra_intent: dict = {}
    if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
        # Required so SELL is treated as "sell to close" rather than opening a short option.
        side_s = str(side).lower()
        if "sell" in side_s:
            extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE
        else:
            extra_intent["position_intent"] = PositionIntent.BUY_TO_OPEN

    if force_limit:
        if reference_price and reference_price > 0:
            offset = max(0.0, float(force_limit_offset_pct or 0.0))
            if str(side).upper().endswith("BUY"):
                limit_price = round(reference_price * (1 + offset), 2)
            else:
                limit_price = round(reference_price * (1 - offset), 2)

            return _submit(
                LimitOrderRequest(
                    symbol=contract_symbol,
                    qty=qty,
                    side=side,
                    time_in_force=tif,
                    limit_price=limit_price,
                    **extra_intent,
                    **bracket_kwargs,
                )
            )

        info(
            "force_limit=True but no valid reference_price provided; "
            "falling back to market order"
        )

    if allow_limit and ENTRY_ORDER_TYPE == "limit" and reference_price and reference_price > 0:
        if str(side).upper().endswith("BUY"):
            limit_price = round(reference_price * (1 + ENTRY_LIMIT_OFFSET_PCT), 2)
        else:
            limit_price = round(reference_price * (1 - ENTRY_LIMIT_OFFSET_PCT), 2)

            return _submit(
                LimitOrderRequest(
                    symbol=contract_symbol,
                    qty=qty,
                    side=side,
                    time_in_force=tif,
                    limit_price=limit_price,
                    **extra_intent,
                    **bracket_kwargs,
                )
            )

    if allow_limit and ENTRY_ORDER_TYPE == "limit":
        info(
            "ENTRY_ORDER_TYPE=limit but no valid reference_price provided; "
            "falling back to market order"
        )

    return _submit(
        MarketOrderRequest(
            symbol=contract_symbol,
            qty=qty,
            side=side,
            time_in_force=tif,
            **extra_intent,
            **bracket_kwargs,
        )
    )


def force_market_sell_and_wait(trading_client, contract_symbol, qty):
    """Immediate market sell fallback used when SL cannot be placed/filled."""
    try:
        extra_intent: dict = {}
        if PositionIntent is not None and _is_option_contract_symbol(contract_symbol):
            extra_intent["position_intent"] = PositionIntent.SELL_TO_CLOSE

        order = trading_client.submit_order(
            MarketOrderRequest(
                symbol=contract_symbol,
                qty=qty,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY,
                **extra_intent,
            )
        )
        filled = wait_for_fill(trading_client, str(order.id), 10)
        return filled
    except Exception as ex:
        info(f"[REGISTRY] force_market_sell failed for {contract_symbol}: {ex}")
        return None

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
