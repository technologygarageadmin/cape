import time
import threading
import logging

from alpaca.data.historical import OptionHistoricalDataClient

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
    EXIT_QUICK_PROFIT_ENABLED,
    EXIT_RSI_OPPOSITE_CROSS_ENABLED,
    EXIT_TAKE_PROFIT_ENABLED,
    EXIT_TRAILING_STOP_ENABLED,
    EXIT_STOP_LOSS_ENABLED,
    PRICE_POLL_SEC,
    QP_GAP_PCT,
    QP_MIN_PEAK_PCT,
    RSI_EXIT_CHECK_SEC,
    SECRET_KEY,
    SYMBOL,
    TRAILING_MIN_PEAK_PCT,
    WS_MAX_WAIT_SEC,
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
        "tp_pct": tp_pct,
        "sl_static_pct": sl_pct,
        "sl_dynamic_pct": sl_pct,
        "qp_floor_pct": 0.0,        # dynamic QP starts at 0%
        "qp_dynamic_pct": 0.0,      # will build up as price moves
        "qp_gap_pct": qp_gap_pct,
        "max_pnl_pct": 0.0,
    }


def _update_dynamic_thresholds(exit_state: dict, pnl_pct: float) -> None:
    if pnl_pct > float(exit_state.get("max_pnl_pct", 0.0)):
        exit_state["max_pnl_pct"] = pnl_pct

    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    qp_floor_pct = float(exit_state.get("qp_floor_pct", 0.0))
    qp_gap_pct = float(exit_state.get("qp_gap_pct", 0.0))

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
    # Only arms once peak reaches QP_MIN_PEAK_PCT to avoid firing on tiny noise blips
    # that lock in a negative level and cause an immediate loss exit.
    if max_pnl_pct >= QP_MIN_PEAK_PCT:
        candidate_qp = max_pnl_pct - qp_gap_pct
        # Only ratchet up, never down. Ignore negative candidates (too early).
        if candidate_qp > float(exit_state.get("qp_dynamic_pct", 0.0)):
            exit_state["qp_dynamic_pct"] = candidate_qp


def _evaluate_priority_exit(
    pnl_pct: float,
    exit_state: dict,
    use_extended_exit_criteria: bool = True,
) -> str | None:
    tp_pct = float(exit_state.get("tp_pct", 0.0))
    sl_static_pct = float(exit_state.get("sl_static_pct", 0.0))
    sl_dynamic_pct = float(exit_state.get("sl_dynamic_pct", sl_static_pct))
    qp_floor_pct = float(exit_state.get("qp_floor_pct", 0.0))
    qp_dynamic_pct = float(exit_state.get("qp_dynamic_pct", qp_floor_pct))
    max_pnl_pct = float(exit_state.get("max_pnl_pct", 0.0))

    # Priority 1: full TP / full SL.
    if EXIT_TAKE_PROFIT_ENABLED and pnl_pct >= tp_pct:
        return "TAKE_PROFIT_EXIT"
    if EXIT_STOP_LOSS_ENABLED and pnl_pct <= sl_static_pct:
        return "STOP_LOSS_EXIT"

    if not use_extended_exit_criteria:
        return None

    # Priority 2: quick-profit protection (one-way ratchet, no downward reset).
    # QP only arms once peak >= QP_MIN_PEAK_PCT — prevents locking in a negative
    # level from a tiny positive blip and immediately exiting at a loss.
    if (
        EXIT_QUICK_PROFIT_ENABLED
        and max_pnl_pct >= QP_MIN_PEAK_PCT
        and qp_dynamic_pct > 0.0
        and pnl_pct < max_pnl_pct
        and pnl_pct <= qp_dynamic_pct
    ):
        return "QUICK_PROFIT_EXIT"

    # Priority 3: trailing stop after position moved positive.
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
):
    label = f"[{context_label}] " if context_label else ""
    info(f"{label}Fallback polling every {PRICE_POLL_SEC}s for {contract_symbol}")
    rsi_state = {}
    exit_state = _init_exit_state(fill_price, tp_price, sl_price)
    hold_notice_emitted = False
    entry_ts = time.time()
    bad_entry_fired = False

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
        _update_dynamic_thresholds(exit_state, pnl_pct)

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
            "rsi_state": {},
            "exit_state": _init_exit_state(fill_price, tp_price, sl_price),
            "hold_notice_emitted": False,
            "entry_ts": time.time(),
            "bad_entry_fired": False,
        }
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
            _update_dynamic_thresholds(state["exit_state"], pnl_pct)

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
                    state["last_price"] = same_candle_price
                    state["exit_reason"] = "SAME_CANDLE_POSITIVE_EXIT"
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
                    state["last_price"] = sellable_price
                    state["exit_reason"] = reason
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
                state["last_price"] = sellable_price
                state["exit_reason"] = exit_reason
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
                    state["last_price"] = sellable_price
                    state["exit_reason"] = exit_reason
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
                return None, state["last_price"], {}

            if done.wait(timeout=1):
                break

            if not thread.is_alive():
                _ws_cooldown_until = time.time() + _WS_COOLDOWN_AFTER_FAIL_SEC
                stop_stream(stream)
                return None, state["last_price"], {}

        if state["exit_reason"] is None:
            _ws_cooldown_until = time.time() + _WS_COOLDOWN_AFTER_FAIL_SEC
            stop_stream(stream)
            return None, state["last_price"], {}

        thread.join(timeout=3)
        return state["exit_reason"], state["last_price"], state["exit_state"]
    finally:
        _WS_MONITOR_LOCK.release()