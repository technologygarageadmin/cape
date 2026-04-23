from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from alpaca.trading.enums import ContractType, OrderSide
from config import (
    ENTRY_ALLOW_PREV_BAR_CROSS,
    ENTRY_CANDLE_BREAKOUT_ENABLED,
    ENTRY_EMA_CROSS_ENABLED,
    ENTRY_EMA_TRIPLE_STACK_ENABLED,
    ENTRY_MIN_BODY_RANGE_RATIO,
    ENTRY_PULLBACK_ENABLED,
    ENTRY_PULLBACK_EMA_TOLERANCE_PCT,
    ENTRY_RSI_CALL_MIN,
    ENTRY_RSI_PUT_MAX,
    ENTRY_RSI_THRESHOLD_ENABLED,
    ENTRY_STRONG_CANDLE_ENABLED,
    ENTRY_RSI_MOMENTUM_ENABLED,
    ENTRY_RSI_MIN_DELTA,
    ENTRY_VOLUME_CONFIRMATION_ENABLED,
    ENTRY_VOLUME_MIN_RATIO,
    ENTRY_RSI_EXTREME_FILTER_ENABLED,
    ENTRY_RSI_CALL_MAX,
    ENTRY_RSI_PUT_MIN,
    ENTRY_RSI_STREAK_ENABLED,
    ENTRY_RSI_MIN_STREAK,
    ENTRY_RSI_MAX_STREAK,
    ENTRY_VWAP_FILTER_ENABLED,
    ENTRY_PRICE_STRUCTURE_ENABLED,
    ENTRY_TIME_WINDOW_ENABLED,
    ENTRY_TIME_WINDOWS,
    MIN_RSI_MA_GAP,
)
from logger import info
from strategy_mode import get_enabled_strategies, STRATEGY_LABELS
from strategy_rsi_crossover import detect as rsi_crossover_detect
from strategy_ema_crossover import detect as ema_crossover_detect
from strategy_rsi_mean_reversion import detect as rsi_mr_detect
from strategy_macd_crossover import detect as macd_detect
from strategy_bollinger_bands import detect as bb_detect

RSI_MR_OVERSOLD = 40.0
RSI_MR_OVERBOUGHT = 70.0


def _strategy_label(strategy_id: str) -> str:
    return STRATEGY_LABELS.get(strategy_id, strategy_id)

def market_open_today_utc():
    now_et = datetime.now(tz=ZoneInfo("America/New_York"))
    open_et = now_et.replace(hour=9, minute=30, second=0, microsecond=0)
    return open_et.astimezone(timezone.utc)

def ny_trading_date():
    return datetime.now(tz=ZoneInfo("America/New_York")).date()

def timestamp_belongs_to_today_ny(ts):
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(ZoneInfo("America/New_York")).date() == ny_trading_date()

def get_expiry_date(today=None):
    current = today or date.today()
    weekday = current.weekday()

    if weekday == 0:
        return current + timedelta(days=4)
    if weekday in (1,2,3):
        return current + timedelta(days=(4-weekday)+7)
    if weekday == 4:
        return current + timedelta(days=7)

    days_to_friday = (4 - weekday) % 7
    return current + timedelta(days=days_to_friday)


def _in_trade_window() -> bool:
    """Return True if current ET clock is inside any configured trade window."""
    if not ENTRY_TIME_WINDOW_ENABLED:
        return True
    now_et = datetime.now(tz=ZoneInfo("America/New_York"))
    mins = now_et.hour * 60 + now_et.minute
    return any(start <= mins < end for start, end in ENTRY_TIME_WINDOWS)


def determine_signal(rsi_result, current_price: float):
    # ── Filter 0: Trade time window — Tier 1 hard requirement ──
    if not _in_trade_window():
        info("  Signal rejected: outside trade windows (9:45–10:45 AM / 1:15–2:15 PM ET)")
        return None, None, None, None

    rsi_ma_cross_up = bool(rsi_result.get("rsi_ma_cross_up"))
    rsi_ma_cross_down = bool(rsi_result.get("rsi_ma_cross_down"))
    prev_cross_up = bool(rsi_result.get("prev_rsi_ma_cross_up"))
    prev_cross_down = bool(rsi_result.get("prev_rsi_ma_cross_down"))

    # RSI MA cross (original logic)
    if ENTRY_ALLOW_PREV_BAR_CROSS:
        cross_up_signal = rsi_ma_cross_up or prev_cross_up
        cross_down_signal = rsi_ma_cross_down or prev_cross_down
    else:
        cross_up_signal = rsi_ma_cross_up
        cross_down_signal = rsi_ma_cross_down

    # ── RSI-MA gap filter for RSI_CROSSOVER strategy only ──
    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    previous_rsi = float(rsi_result.get("previous_rsi", latest_rsi))
    latest_rsi_ma = float(rsi_result.get("latest_rsi_ma", 50))
    rsi_gap = abs(latest_rsi - latest_rsi_ma)

    enabled_strategies = get_enabled_strategies()
    call_triggers: list[str] = []
    put_triggers: list[str] = []

    if "RSI_CROSSOVER" in enabled_strategies:
        calls, puts = rsi_crossover_detect(rsi_result, current_price, cross_up_signal, cross_down_signal)
        if not calls and not puts and (cross_up_signal or cross_down_signal) and rsi_gap < MIN_RSI_MA_GAP:
            info(f"  RSI_CROSSOVER rejected: gap {rsi_gap:.2f} < {MIN_RSI_MA_GAP} (RSI={latest_rsi:.1f}, MA={latest_rsi_ma:.1f})")
        call_triggers.extend(calls)
        put_triggers.extend(puts)

    if "EMA_CROSSOVER" in enabled_strategies:
        calls, puts = ema_crossover_detect(rsi_result, current_price)
        call_triggers.extend(calls)
        put_triggers.extend(puts)

    if "RSI_MEAN_REVERSION" in enabled_strategies:
        calls, puts = rsi_mr_detect(rsi_result, current_price)
        call_triggers.extend(calls)
        put_triggers.extend(puts)

    if "MACD_CROSSOVER" in enabled_strategies:
        calls, puts = macd_detect(rsi_result, current_price)
        call_triggers.extend(calls)
        put_triggers.extend(puts)

    if "BOLLINGER_BANDS" in enabled_strategies:
        calls, puts = bb_detect(rsi_result, current_price)
        call_triggers.extend(calls)
        put_triggers.extend(puts)

    call_candidate = len(call_triggers) > 0
    put_candidate = len(put_triggers) > 0

    if call_candidate and put_candidate:
        info("  Signal rejected: conflicting CALL and PUT triggers in same bar")
        return None, None, None, None

    if not (call_candidate or put_candidate):
        return None, None, None, None

    # Extract new indicators from rsi_result (latest_rsi already extracted above)
    ema_bullish = bool(rsi_result.get("ema_bullish_regime", False))
    ema_bearish = bool(rsi_result.get("ema_bearish_regime", False))
    ema_fast_above = bool(rsi_result.get("ema_fast_above_slow", False))
    pullback_pct = float(rsi_result.get("pullback_to_ema_pct", 999))
    body_ratio = float(rsi_result.get("candle_body_ratio", 0))
    is_bullish_candle = bool(rsi_result.get("candle_is_bullish", False))
    is_bearish_candle = bool(rsi_result.get("candle_is_bearish", False))
    breaks_prev_high = bool(rsi_result.get("candle_breaks_prev_high", False))
    breaks_prev_low = bool(rsi_result.get("candle_breaks_prev_low", False))
    rsi_delta = float(rsi_result.get("delta", 0))
    volume_ratio = float(rsi_result.get("volume_ratio", 0))
    volume_unavailable = bool(rsi_result.get("volume_unavailable", False))
    up_streak = int(rsi_result.get("up_streak", 0))
    down_streak = int(rsi_result.get("down_streak", 0))
    vwap = rsi_result.get("vwap")
    price_above_vwap = rsi_result.get("price_above_vwap")
    price_structure          = rsi_result.get("price_structure", "NONE")
    price_structure_bullish  = bool(rsi_result.get("price_structure_bullish", False))
    price_structure_bearish  = bool(rsi_result.get("price_structure_bearish", False))
    price_structure_neutral  = bool(rsi_result.get("price_structure_neutral", False))
    ema_triple_bull = bool(rsi_result.get("ema_triple_bull", False))
    ema_triple_bear = bool(rsi_result.get("ema_triple_bear", False))

    # ── CALL entry (filters removed) ──
    if call_candidate:
        entry_info = {
            "signal": "CALL",
            "filters_passed": [],
            "reasons": [f"Entry trigger(s): {', '.join(_strategy_label(s) for s in call_triggers)}"],
            "entry_strategies": list(call_triggers),
            "indicators": {
                "rsi": round(latest_rsi, 1),
                "rsi_delta": round(rsi_delta, 2),
                "volume_ratio": volume_ratio,
                "up_streak": up_streak,
                "ema_fast_above_slow": ema_fast_above,
                "pullback_pct": round(pullback_pct, 2),
                "body_ratio": round(body_ratio, 2),
                "is_bullish_candle": is_bullish_candle,
                "breaks_prev_high": breaks_prev_high,
                "vwap": round(vwap, 2) if vwap is not None else None,
                "price_above_vwap": price_above_vwap,
                "macd_line": rsi_result.get("macd_line"),
                "macd_signal": rsi_result.get("macd_signal"),
                "bb_upper": rsi_result.get("bb_upper"),
                "bb_lower": rsi_result.get("bb_lower"),
            },
        }
        entry_info["filters_passed"].append(f"triggered by: {', '.join(_strategy_label(s) for s in call_triggers)}")
        return "CALL", ContractType.CALL, OrderSide.BUY, entry_info

    # ── PUT entry (filters removed) ──
    if put_candidate:
        entry_info = {
            "signal": "PUT",
            "filters_passed": [],
            "reasons": [f"Entry trigger(s): {', '.join(_strategy_label(s) for s in put_triggers)}"],
            "entry_strategies": list(put_triggers),
            "indicators": {
                "rsi": round(latest_rsi, 1),
                "rsi_delta": round(rsi_delta, 2),
                "volume_ratio": volume_ratio,
                "down_streak": down_streak,
                "ema_fast_above_slow": ema_fast_above,
                "pullback_pct": round(pullback_pct, 2),
                "body_ratio": round(body_ratio, 2),
                "is_bearish_candle": is_bearish_candle,
                "breaks_prev_low": breaks_prev_low,
                "vwap": round(vwap, 2) if vwap is not None else None,
                "price_above_vwap": price_above_vwap,
                "macd_line": rsi_result.get("macd_line"),
                "macd_signal": rsi_result.get("macd_signal"),
                "bb_upper": rsi_result.get("bb_upper"),
                "bb_lower": rsi_result.get("bb_lower"),
            },
        }
        entry_info["filters_passed"].append(f"triggered by: {', '.join(_strategy_label(s) for s in put_triggers)}")
        return "PUT", ContractType.PUT, OrderSide.BUY, entry_info

    return None, None, None, None