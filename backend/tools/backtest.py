"""Simple backtester for Cape entry + exit logic (minute bars).

- Loads minute OHLC bars from a JSON file (default: `tools/spy_1min.json`).
- Recomputes RSI/EMA indicators and calls the enabled strategy detectors
  (reads `backend/logs/strategy_modes.json`).
- Simulates entry fills (next-bar open) and exits using Cape exit rules:
  TP (absolute), SL (absolute), QP ratchet (CAPE_QP_OFFSET, CAPE_TRAILING_SL_OFFSET).

Extra simulation flags for exception-path validation:
  --window N          : cap each trade at N bars (default: unlimited)
  --fail-after N      : broker SL replacement succeeds for the first N
                        profit ticks, then permanently fails.  This leaves
                        sl_last_placed_pct stale while sl_dynamic_pct keeps
                        ratcheting -- reproducing the Condition 5 (QP guard)
                        scenario from monitoring.py.
  --grace-bars N      : consecutive bars price must stay at/below the QP
                        trigger before QP_SL_REPLACE_FAILED_MARKET_EXIT fires
                        (default: 1; mirrors the 2-second wall-clock grace).
  --verbose           : print a per-tick ratchet table for every trade.

This backtester is intentionally self-contained and avoids importing the
large Alpaca SDK at runtime so it can be run in a minimal environment.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Dict, Optional

import pandas as pd

# Ensure `backend` is on sys.path so `import config` and other backend modules work
import sys
_THIS_DIR = os.path.dirname(__file__)
_BACKEND_DIR = os.path.abspath(os.path.join(_THIS_DIR, ".."))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Import configuration knobs from the project
from config import (
    EMA_FAST_PERIOD,
    EMA_SLOW_PERIOD,
    RSI_PERIOD,
    RSI_MA_PERIOD,
    MIN_TRADE_DURATION_SEC,
    POST_TRADE_COOLDOWN_BARS,
    CAPE_QP_OFFSET,
    CAPE_TRAILING_SL_OFFSET,
    compute_tp_price,
    compute_sl_price,
)

# Import lightweight strategy detectors (they don't require Alpaca SDK)
from strategy_rsi_crossover import detect as detect_rsi_crossover
from strategy_ema_crossover import detect as detect_ema_crossover
from strategy_rsi_mean_reversion import detect as detect_rsi_mr
from strategy_macd_crossover import detect as detect_macd
from strategy_bollinger_bands import detect as detect_bb
from strategy_mode import get_enabled_strategies


@dataclass
class TradeRecord:
    entry_idx: int
    entry_time: str
    signal: str
    fill_price: float
    tp_price: float
    sl_price: float
    exit_idx: Optional[int] = None
    exit_time: Optional[str] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    # QP guard diagnostics (only populated when --fail-after is used)
    qp_guard_fired: bool = False
    sl_dynamic_pct_at_exit: Optional[float] = None
    sl_last_placed_pct_at_exit: Optional[float] = None
    replace_fail_ticks: int = 0


def compute_rsi(series: pd.Series, period: int) -> pd.Series:
    """Compute RSI using same EWMA method as the main code.

    Returns a pd.Series aligned with `series` (NaNs for initial values).
    """
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _safe_float(x, default=0.0):
    """Convert value to float safely treating pandas NA as missing."""
    if x is None:
        return default
    try:
        if pd.isna(x):
            return default
    except Exception:
        pass
    try:
        return float(x)
    except Exception:
        return default


def load_bars(path: str) -> pd.DataFrame:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    df = pd.DataFrame(data)
    # Ensure timestamp is datetime and sorted
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"])  # ISO format
        df = df.sort_values("timestamp").reset_index(drop=True)
    else:
        df = df.reset_index(drop=True)
    # Ensure numeric columns exist
    for col in ("open", "high", "low", "close", "volume"):
        if col not in df.columns:
            df[col] = pd.NA
    return df


def build_indicators(df: pd.DataFrame) -> pd.DataFrame:
    closes = df["close"].astype("float64")
    df = df.copy()
    df["ema_fast"] = closes.ewm(span=EMA_FAST_PERIOD, adjust=False).mean()
    df["ema_slow"] = closes.ewm(span=EMA_SLOW_PERIOD, adjust=False).mean()
    df["ema_fast_prev"] = df["ema_fast"].shift(1)
    df["ema_slow_prev"] = df["ema_slow"].shift(1)

    rsi = compute_rsi(closes, RSI_PERIOD)
    df["rsi"] = rsi
    df["rsi_prev"] = rsi.shift(1)
    df["rsi_ma"] = rsi.rolling(window=RSI_MA_PERIOD).mean()
    df["rsi_ma_prev"] = df["rsi_ma"].shift(1)

    # Candle/structure helpers
    df["body_ratio"] = (df["close"] - df["open"]).abs() / (df["high"] - df["low"]).replace(0, pd.NA)
    df["is_bullish"] = df["close"] > df["open"]
    df["is_bearish"] = df["close"] < df["open"]
    df["prev_high"] = df["high"].shift(1)
    df["prev_low"] = df["low"].shift(1)
    df["breaks_prev_high"] = df["close"] > df["prev_high"]
    df["breaks_prev_low"] = df["close"] < df["prev_low"]

    # VWAP if available
    if "vw" in df.columns:
        df["vwap"] = df["vw"].astype("float64")
        df["price_above_vwap"] = df["close"] > df["vwap"]
    else:
        df["vwap"] = pd.NA
        df["price_above_vwap"] = pd.NA

    # Simple volume ratio (relative to 30-bar rolling mean)
    if "volume" in df.columns:
        df["vol_mean_30"] = df["volume"].rolling(30, min_periods=1).mean()
        df["vol_ratio"] = df["volume"] / df["vol_mean_30"].replace(0, pd.NA)
    else:
        df["vol_ratio"] = pd.NA

    return df


def run_backtest(
    bars_path: str,
    save_csv: Optional[str] = None,
    max_hold_bars: Optional[int] = None,
    fail_after: Optional[int] = None,
    grace_bars: int = 1,
    verbose: bool = False,
) -> List[TradeRecord]:
    df = load_bars(bars_path)
    if df.empty:
        raise RuntimeError("No bars loaded")

    df = build_indicators(df)

    enabled = get_enabled_strategies()
    detectors = {
        "RSI_CROSSOVER": detect_rsi_crossover,
        "EMA_CROSSOVER": detect_ema_crossover,
        "RSI_MEAN_REVERSION": detect_rsi_mr,
        "MACD_CROSSOVER": detect_macd,
        "BOLLINGER_BANDS": detect_bb,
    }

    trades: List[TradeRecord] = []
    cooldown = 0
    i = 0
    n = len(df)

    # Minimum bars to hold (approximate by minutes)
    min_hold_bars = max(1, math.ceil(MIN_TRADE_DURATION_SEC / 60.0))

    while i < n:
        row = df.iloc[i]
        # Skip if indicators not ready
        if pd.isna(row["rsi"]) or pd.isna(row["ema_fast"]):
            i += 1
            continue

        if cooldown > 0:
            cooldown -= 1
            i += 1
            continue

        # Build rsi_result dict similar to the runtime monitor so detectors can use it
        latest_rsi = _safe_float(row.get("rsi"), 0.0)
        previous_rsi = _safe_float(row.get("rsi_prev"), latest_rsi)
        latest_rsi_ma = _safe_float(row.get("rsi_ma"), latest_rsi)
        previous_rsi_ma = _safe_float(row.get("rsi_ma_prev"), latest_rsi_ma)

        rsi_ma_cross_up = (previous_rsi <= previous_rsi_ma) and (latest_rsi > latest_rsi_ma)
        rsi_ma_cross_down = (previous_rsi >= previous_rsi_ma) and (latest_rsi < latest_rsi_ma)

        ema_fast = _safe_float(row.get("ema_fast"), 0.0)
        ema_slow = _safe_float(row.get("ema_slow"), 0.0)
        prev_ema_fast = _safe_float(row.get("ema_fast_prev"), ema_fast)
        prev_ema_slow = _safe_float(row.get("ema_slow_prev"), ema_slow)

        pullback_pct = 999.0
        if ema_fast:
            try:
                pullback_pct = float(abs(row["close"] - ema_fast) / ema_fast * 100.0)
            except Exception:
                pullback_pct = 999.0

        rsi_result = {
            "latest_rsi": latest_rsi,
            "previous_rsi": previous_rsi,
            "latest_rsi_ma": latest_rsi_ma,
            "previous_rsi_ma": previous_rsi_ma,
            "rsi_ma_cross_up": bool(rsi_ma_cross_up),
            "rsi_ma_cross_down": bool(rsi_ma_cross_down),
            "prev_rsi_ma_cross_up": False,
            "prev_rsi_ma_cross_down": False,
            "ema_fast": ema_fast,
            "ema_slow": ema_slow,
            "prev_ema_fast": prev_ema_fast,
            "prev_ema_slow": prev_ema_slow,
            "pullback_to_ema_pct": pullback_pct,
            "candle_body_ratio": _safe_float(row.get("body_ratio"), 0.0),
            "candle_is_bullish": bool(not pd.isna(row.get("is_bullish")) and row.get("is_bullish")),
            "candle_is_bearish": bool(not pd.isna(row.get("is_bearish")) and row.get("is_bearish")),
            "candle_breaks_prev_high": bool(not pd.isna(row.get("breaks_prev_high")) and row.get("breaks_prev_high")),
            "candle_breaks_prev_low": bool(not pd.isna(row.get("breaks_prev_low")) and row.get("breaks_prev_low")),
            "vwap": (None if pd.isna(row.get("vwap")) else _safe_float(row.get("vwap"), None)),
            "price_above_vwap": bool(not pd.isna(row.get("price_above_vwap")) and row.get("price_above_vwap")),
            "volume_ratio": _safe_float(row.get("vol_ratio"), 0.0),
            "previous_close": _safe_float(df.iloc[i - 1]["close"]) if i >= 1 else _safe_float(row.get("close"), 0.0),
        }

        # Propagate prev-rsi-ma-cross from previous bar for compatibility
        if i >= 1:
            prev_row = df.iloc[i - 1]
            prev_rsi = prev_row["rsi"] if not pd.isna(prev_row["rsi"]) else rsi_result["latest_rsi"]
            prev_rsi_ma = prev_row.get("rsi_ma") if not pd.isna(prev_row.get("rsi_ma")) else prev_rsi
            rsi_result["prev_rsi_ma_cross_up"] = bool((prev_row.get("rsi_prev") or prev_rsi) <= prev_rsi_ma and (prev_rsi > prev_rsi_ma))
            rsi_result["prev_rsi_ma_cross_down"] = bool((prev_row.get("rsi_prev") or prev_rsi) >= prev_rsi_ma and (prev_rsi < prev_rsi_ma))

        # Run enabled detectors
        call_triggers: List[str] = []
        put_triggers: List[str] = []
        for sid in enabled:
            det = detectors.get(sid)
            if not det:
                continue
            # Strategy detect functions return (calls, puts)
            try:
                if sid == "RSI_CROSSOVER":
                    calls, puts = det(rsi_result, row["close"], rsi_result.get("rsi_ma_cross_up"), rsi_result.get("rsi_ma_cross_down"))
                else:
                    calls, puts = det(rsi_result, row["close"])
            except Exception:
                calls, puts = [], []
            call_triggers.extend(calls or [])
            put_triggers.extend(puts or [])

        call_candidate = len(call_triggers) > 0
        put_candidate = len(put_triggers) > 0

        # Skip conflicting signals
        if call_candidate and put_candidate:
            i += 1
            continue

        if not (call_candidate or put_candidate):
            i += 1
            continue

        signal = "CALL" if call_candidate else "PUT"

        # Simulate entry fill at next bar open (or current close if no next bar)
        fill_idx = i + 1 if (i + 1) < n else i
        fill_row = df.iloc[fill_idx]
        fill_price = float(fill_row.get("open") if not pd.isna(fill_row.get("open")) else fill_row["close"])

        # Compute TP/SL (long by default). For PUT simulate symmetric prices about entry.
        tp_long = compute_tp_price(fill_price)
        sl_long = compute_sl_price(fill_price)
        if signal == "CALL":
            tp_price = float(tp_long)
            sl_price = float(sl_long)
            direction = "long"
        else:
            # Mirror TP/SL around entry for short-underlying approximation
            tp_price = float(2 * fill_price - tp_long)
            sl_price = float(2 * fill_price - sl_long)
            direction = "short"

        rec = TradeRecord(entry_idx=i, entry_time=str(row.get("timestamp")), signal=signal, fill_price=fill_price, tp_price=tp_price, sl_price=sl_price)

        # Start monitoring from the fill bar
        existing_sl_price = sl_price
        sl_static_pct = ((existing_sl_price / fill_price) - 1.0) * 100.0
        sl_dynamic_pct = sl_static_pct
        sl_last_placed_pct = sl_static_pct
        qp_armed = False
        max_pnl_pct = 0.0

        # Failure-simulation state
        successful_replacements = 0
        replace_fail_ticks = 0

        # Condition 5 QP guard state
        qp_guard_trigger_seen_bar: Optional[int] = None

        # Window cap: max bar index to stay in trade
        max_exit_idx = (fill_idx + max_hold_bars - 1) if max_hold_bars else None

        exited = False
        min_exit_idx = fill_idx + min_hold_bars

        if verbose:
            print(f"\n{'='*80}")
            print(f"TRADE: {signal} @ fill={fill_price:.4f}  TP={tp_price:.4f}  SL={sl_price:.4f}")
            print(f"{'='*80}")
            hdr = f"{'Bar':>4} {'Time':>22} {'Close':>8} {'High':>8} {'Low':>8} "
            hdr += f"{'sl_dyn%':>9} {'sl_placed%':>11} {'QP_trig':>9} {'Replace':>10} {'Guard':>6}"
            print(hdr)
            print("-" * len(hdr))

        for j in range(fill_idx, n):
            tick = df.iloc[j]
            cur_close = float(tick["close"])
            cur_high = float(tick["high"])
            cur_low = float(tick["low"])
            tick_time = str(tick.get("timestamp", ""))

            if direction == "long":
                peak = max(max_pnl_pct, ((cur_high / fill_price) - 1.0) * 100.0)
            else:
                peak = max(max_pnl_pct, ((fill_price / cur_low) - 1.0) * 100.0) if cur_low > 0 else max_pnl_pct
            max_pnl_pct = float(peak)

            # QP ratchet calculation (direction-aware)
            if direction == "long":
                if cur_close > fill_price:
                    qp_price = round(cur_close - CAPE_QP_OFFSET, 4)
                    trailing_sl_price = round(cur_close - CAPE_TRAILING_SL_OFFSET, 4)
                    sl_candidate_price = max(existing_sl_price, qp_price, trailing_sl_price)
                    if not qp_armed and ((qp_price / fill_price) - 1.0) * 100.0 > 0:
                        qp_armed = True
                else:
                    drawdown = max(0.0, fill_price - cur_close)
                    sl_candidate_price = max(existing_sl_price, round(existing_sl_price + drawdown, 4))
            else:
                if cur_close < fill_price:
                    qp_price = round(cur_close + CAPE_QP_OFFSET, 4)
                    trailing_sl_price = round(cur_close + CAPE_TRAILING_SL_OFFSET, 4)
                    sl_candidate_price = min(existing_sl_price, qp_price, trailing_sl_price)
                    if not qp_armed and ((qp_price / fill_price) - 1.0) * 100.0 < 0:
                        qp_armed = True
                else:
                    drawup = max(0.0, cur_close - fill_price)
                    sl_candidate_price = min(existing_sl_price, round(existing_sl_price + drawup, 4))

            # Convert candidate to pct and ratchet sl_dynamic_pct (only ever moves in profit direction)
            sl_candidate_pct = ((sl_candidate_price / fill_price) - 1.0) * 100.0 if fill_price > 0 else sl_dynamic_pct
            if direction == "long":
                sl_dynamic_pct = max(sl_dynamic_pct, sl_candidate_pct)
            else:
                sl_dynamic_pct = min(sl_dynamic_pct, sl_candidate_pct)

            # Broker SL replacement simulation
            replace_event = "-"
            sl_moved = sl_dynamic_pct != sl_last_placed_pct
            if sl_moved:
                # Decide whether this replacement succeeds or fails
                if fail_after is not None and successful_replacements >= fail_after:
                    # Simulate broker rejection -- sl_last_placed_pct stays stale
                    replace_fail_ticks += 1
                    replace_event = "FAIL"
                else:
                    sl_last_placed_pct = sl_dynamic_pct
                    successful_replacements += 1
                    replace_event = f"OK#{successful_replacements}"
                    # Successful replacement resets any active QP guard timer
                    qp_guard_trigger_seen_bar = None

            dynamic_sl_price = fill_price * (1.0 + sl_dynamic_pct / 100.0)
            qp_trigger_price = fill_price * (1.0 + sl_dynamic_pct / 100.0)

            # -- Condition 5: QP replacement failure guard ----------------------
            # Mirrors monitoring.py _detect_market_fallback_reason Condition 5.
            # Fires a market-sell when:
            #   sl_dynamic_pct is in the profit zone (> 0)
            #   sl_last_placed_pct is stale (behind sl_dynamic_pct)
            #   price has slid back to the QP trigger level
            #   that condition holds for `grace_bars` consecutive bars
            qp_guard_label = ""
            if (
                fail_after is not None
                and sl_dynamic_pct > 0.0
                and sl_last_placed_pct < sl_dynamic_pct
                and cur_close <= qp_trigger_price
                and j >= min_exit_idx
            ):
                if qp_guard_trigger_seen_bar is None:
                    qp_guard_trigger_seen_bar = j
                    qp_guard_label = "ARMED"
                elif (j - qp_guard_trigger_seen_bar) >= grace_bars - 1:
                    # Grace period elapsed -- fire market exit
                    rec.exit_idx = j
                    rec.exit_time = tick_time
                    rec.exit_price = cur_close  # market sell at current close
                    rec.exit_reason = "QP_SL_REPLACE_FAILED_MARKET_EXIT"
                    rec.qp_guard_fired = True
                    rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                    rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                    rec.replace_fail_ticks = replace_fail_ticks
                    qp_guard_label = "FIRED"
                    if verbose:
                        placed_price = fill_price * (1.0 + sl_last_placed_pct / 100.0)
                        print(
                            f"{j:>4} {tick_time:>22} {cur_close:>8.4f} {cur_high:>8.4f} {cur_low:>8.4f} "
                            f"{sl_dynamic_pct:>9.4f} {sl_last_placed_pct:>11.4f} {qp_trigger_price:>9.4f} "
                            f"{replace_event:>10} {qp_guard_label:>6}"
                        )
                        print(f"\n>>> QP_SL_REPLACE_FAILED_MARKET_EXIT fired at bar {j}")
                        print(f"    sl_dynamic_pct={sl_dynamic_pct:.4f}%  sl_last_placed_pct={sl_last_placed_pct:.4f}%")
                        print(f"    Broker SL stuck at {placed_price:.4f}; internal ratchet at {dynamic_sl_price:.4f}")
                        print(f"    Price {cur_close:.4f} <= QP trigger {qp_trigger_price:.4f} -> market sell")
                    exited = True
                    break
                else:
                    qp_guard_label = "WAIT"
            else:
                # Price recovered above QP trigger -- reset grace timer
                if qp_guard_trigger_seen_bar is not None and cur_close > qp_trigger_price:
                    qp_guard_trigger_seen_bar = None
                    qp_guard_label = "RESET"

            if verbose:
                print(
                    f"{j:>4} {tick_time:>22} {cur_close:>8.4f} {cur_high:>8.4f} {cur_low:>8.4f} "
                    f"{sl_dynamic_pct:>9.4f} {sl_last_placed_pct:>11.4f} {qp_trigger_price:>9.4f} "
                    f"{replace_event:>10} {qp_guard_label:>6}"
                )

            # TP / SL exit checks (only after minimum hold).
            # The BROKER SL fires at sl_last_placed_pct — that is what's on the
            # exchange. sl_dynamic_pct is the desired target; when replacements
            # fail it is higher than sl_last_placed_pct, so the QP guard (above)
            # fires first.  SL_RATCHETED fires only when the broker-side level is
            # actually hit.
            if j >= min_exit_idx:
                broker_sl_price = fill_price * (1.0 + sl_last_placed_pct / 100.0)
                if direction == "long":
                    if cur_high >= rec.tp_price:
                        rec.exit_idx = j
                        rec.exit_time = tick_time
                        rec.exit_price = float(rec.tp_price)
                        rec.exit_reason = "TP"
                        rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                        rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                        rec.replace_fail_ticks = replace_fail_ticks
                        exited = True
                        break
                    if cur_low <= broker_sl_price:
                        rec.exit_idx = j
                        rec.exit_time = tick_time
                        rec.exit_price = float(broker_sl_price)
                        rec.exit_reason = "SL_RATCHETED" if sl_last_placed_pct > sl_static_pct else "SL_INITIAL"
                        rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                        rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                        rec.replace_fail_ticks = replace_fail_ticks
                        exited = True
                        break
                else:
                    if cur_low <= rec.tp_price:
                        rec.exit_idx = j
                        rec.exit_time = tick_time
                        rec.exit_price = float(rec.tp_price)
                        rec.exit_reason = "TP"
                        rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                        rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                        rec.replace_fail_ticks = replace_fail_ticks
                        exited = True
                        break
                    if cur_high >= broker_sl_price:
                        rec.exit_idx = j
                        rec.exit_time = tick_time
                        rec.exit_price = float(broker_sl_price)
                        rec.exit_reason = "SL_RATCHETED" if sl_last_placed_pct < sl_static_pct else "SL_INITIAL"
                        rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                        rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                        rec.replace_fail_ticks = replace_fail_ticks
                        exited = True
                        break

            # Window cap: force exit after TP/SL checks so TP takes priority on the same bar
            if max_exit_idx is not None and j >= max_exit_idx and j >= min_exit_idx and not exited:
                rec.exit_idx = j
                rec.exit_time = tick_time
                rec.exit_price = cur_close
                rec.exit_reason = "WINDOW"
                rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
                rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
                rec.replace_fail_ticks = replace_fail_ticks
                exited = True
                break

        # If trade didn't exit by end of data (or window), close at last close
        if not exited:
            last = df.iloc[-1]
            rec.exit_idx = len(df) - 1
            rec.exit_time = str(last.get("timestamp"))
            rec.exit_price = float(last["close"])
            rec.exit_reason = "END"
            rec.sl_dynamic_pct_at_exit = sl_dynamic_pct
            rec.sl_last_placed_pct_at_exit = sl_last_placed_pct
            rec.replace_fail_ticks = replace_fail_ticks

        trades.append(rec)

        # cooldown after exit
        cooldown = POST_TRADE_COOLDOWN_BARS

        # Move index forward beyond the entry bar to avoid re-detecting same candle
        i = fill_idx + 1
    return trades


def summarize(trades: List[TradeRecord]) -> Dict:
    results = {"total": len(trades), "wins": 0, "losses": 0, "total_pnl_pct": 0.0}
    for t in trades:
        if t.exit_price is None:
            continue
        if t.signal == "CALL":
            pnl_pct = (t.exit_price - t.fill_price) / t.fill_price * 100.0
        else:
            pnl_pct = (t.fill_price - t.exit_price) / t.fill_price * 100.0
        results["total_pnl_pct"] += pnl_pct
        if pnl_pct >= 0:
            results["wins"] += 1
        else:
            results["losses"] += 1
    results["win_rate"] = (results["wins"] / results["total"] * 100.0) if results["total"] else 0.0
    results["avg_pnl_pct"] = (results["total_pnl_pct"] / results["total"]) if results["total"] else 0.0
    return results


def _print_trade_table(trades: List[TradeRecord]) -> None:
    print(f"\n{'-'*110}")
    hdr = f"{'#':>3}  {'Signal':>6}  {'Entry Time':>22}  {'Fill':>8}  {'TP':>8}  {'SL':>8}  "
    hdr += f"{'Exit Time':>22}  {'ExitPx':>8}  {'Reason':>35}  {'PnL%':>7}  {'Fails':>5}"
    print(hdr)
    print(f"{'-'*110}")
    for idx, t in enumerate(trades, 1):
        if t.exit_price is None:
            continue
        pnl_pct = (t.exit_price - t.fill_price) / t.fill_price * 100.0 if t.signal == "CALL" else (t.fill_price - t.exit_price) / t.fill_price * 100.0
        fails = t.replace_fail_ticks if t.replace_fail_ticks else 0
        print(
            f"{idx:>3}  {t.signal:>6}  {t.entry_time:>22}  {t.fill_price:>8.4f}  {t.tp_price:>8.4f}  {t.sl_price:>8.4f}  "
            f"{str(t.exit_time):>22}  {t.exit_price:>8.4f}  {str(t.exit_reason):>35}  {pnl_pct:>+7.4f}  {fails:>5}"
        )
    print(f"{'-'*110}")


def main():
    parser = argparse.ArgumentParser(description="Backtest Cape entry+exit on minute bars")
    parser.add_argument("--bars", "-b", default=os.path.join(os.path.dirname(__file__), "spy_1min.json"), help="Path to minute bars JSON file")
    parser.add_argument("--window", "-w", type=int, default=None, help="Max bars to hold a trade (5 = 5-minute cap)")
    parser.add_argument("--fail-after", "-f", type=int, default=None, dest="fail_after", help="Simulate broker SL replacement failure after N successes")
    parser.add_argument("--grace-bars", "-g", type=int, default=1, dest="grace_bars", help="Bars price must stay at QP trigger before Condition 5 fires (default 1)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print per-tick ratchet table for every trade")
    parser.add_argument("--out", "-o", default=None, help="CSV or JSON file to write trade list")
    parser.add_argument("--json", "-j", action="store_true", help="Write results to backend/tools/backtest_result.json")
    args = parser.parse_args()

    trades = run_backtest(
        args.bars,
        max_hold_bars=args.window,
        fail_after=args.fail_after,
        grace_bars=args.grace_bars,
        verbose=args.verbose,
    )
    summary = summarize(trades)

    print(f"\n{'='*60}")
    print("BACKTEST SUMMARY")
    print(f"{'='*60}")
    print(f"  Data file   : {args.bars}")
    print(f"  Window cap  : {args.window} bars" if args.window else "  Window cap  : unlimited")
    print(f"  Fail-after  : {args.fail_after} replacements" if args.fail_after is not None else "  Fail-after  : disabled (always succeeds)")
    print(f"  Grace bars  : {args.grace_bars}")
    print(f"{'-'*60}")
    print(f"  Total trades: {summary['total']}")
    print(f"  Wins        : {summary['wins']}")
    print(f"  Losses      : {summary['losses']}")
    print(f"  Win rate    : {summary['win_rate']:.1f}%")
    print(f"  Total PnL%  : {summary['total_pnl_pct']:+.4f}")
    print(f"  Avg PnL%    : {summary['avg_pnl_pct']:+.4f}")

    # Exit reason breakdown
    by_reason: Dict[str, int] = {}
    for t in trades:
        k = str(t.exit_reason)
        by_reason[k] = by_reason.get(k, 0) + 1
    print(f"{'-'*60}")
    print("  Exit reasons:")
    for reason, count in sorted(by_reason.items(), key=lambda x: -x[1]):
        guard_note = "  <-- Condition 5 QP guard" if reason == "QP_SL_REPLACE_FAILED_MARKET_EXIT" else ""
        print(f"    {reason:<38}: {count}{guard_note}")
    print(f"{'='*60}")

    _print_trade_table(trades)

    # QP guard detail block
    guard_trades = [t for t in trades if t.qp_guard_fired]
    if guard_trades:
        print(f"\n{'='*60}")
        print("QP GUARD (Condition 5) DETAIL")
        print(f"{'='*60}")
        for t in guard_trades:
            placed_price = t.fill_price * (1.0 + (t.sl_last_placed_pct_at_exit or 0) / 100.0)
            dynamic_price = t.fill_price * (1.0 + (t.sl_dynamic_pct_at_exit or 0) / 100.0)
            print(f"  Trade @ fill={t.fill_price:.4f}  exit_time={t.exit_time}")
            print(f"    sl_dynamic_pct   = {t.sl_dynamic_pct_at_exit:+.4f}%  -> broker SL should be at {dynamic_price:.4f}")
            print(f"    sl_last_placed   = {t.sl_last_placed_pct_at_exit:+.4f}%  -> broker SL actually at {placed_price:.4f}")
            print(f"    Gap (ratchet lag): {(t.sl_dynamic_pct_at_exit or 0) - (t.sl_last_placed_pct_at_exit or 0):+.4f}%")
            print(f"    Replacement fails before guard fired: {t.replace_fail_ticks}")
            print(f"    Market sell @ {t.exit_price:.4f}  (vs broker SL floor {placed_price:.4f})")
        print(f"{'='*60}")

    # Always write JSON result
    out_path_default = os.path.join(os.path.dirname(__file__), "backtest_result.json")
    result_default = {"summary": summary, "trades": [asdict(t) for t in trades]}
    try:
        with open(out_path_default, "w", encoding="utf-8") as jf:
            json.dump(result_default, jf, indent=2, default=str)
        print(f"\nWrote JSON results to {out_path_default}")
    except Exception as ex:
        print(f"Failed to write default JSON results: {ex}")

    if args.json:
        out_path = os.path.join(os.path.dirname(__file__), "backtest_result.json")
        result = {"summary": summary, "trades": [asdict(t) for t in trades]}
        with open(out_path, "w", encoding="utf-8") as jf:
            json.dump(result, jf, indent=2, default=str)
        print(f"Wrote JSON results to {out_path}")
    elif args.out:
        if str(args.out).lower().endswith(".json"):
            out_path = os.path.abspath(args.out)
            result = {"summary": summary, "trades": [asdict(t) for t in trades]}
            with open(out_path, "w", encoding="utf-8") as jf:
                json.dump(result, jf, indent=2, default=str)
            print(f"Wrote JSON results to {out_path}")
        else:
            rows = [asdict(t) for t in trades]
            pd.DataFrame(rows).to_csv(args.out, index=False)
            print(f"Wrote {len(rows)} trades to {args.out}")


if __name__ == "__main__":
    main()
