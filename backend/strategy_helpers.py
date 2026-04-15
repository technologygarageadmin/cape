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

    # ── RSI-MA gap filter: reject weak/noisy crosses ──
    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    latest_rsi_ma = float(rsi_result.get("latest_rsi_ma", 50))
    rsi_gap = abs(latest_rsi - latest_rsi_ma)
    if rsi_gap < MIN_RSI_MA_GAP:
        if cross_up_signal or cross_down_signal:
            info(f"  RSI cross rejected: gap {rsi_gap:.2f} < {MIN_RSI_MA_GAP} (RSI={latest_rsi:.1f}, MA={latest_rsi_ma:.1f})")
        return None, None, None, None

    # ── CALL candidate ──
    call_candidate = cross_up_signal
    # ── PUT candidate ──
    put_candidate = cross_down_signal

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

    # ── CALL filters ──
    if call_candidate:
        reject_reasons = []

        # Filter 1: EMA regime — 9 EMA must be above 21 EMA (bullish)
        if ENTRY_EMA_CROSS_ENABLED and not ema_fast_above:
            reject_reasons.append(f"EMA9 below EMA21 (bearish regime)")

        # Filter 2: Pullback to 9 EMA — don't chase extended breakouts
        if ENTRY_PULLBACK_ENABLED and pullback_pct > ENTRY_PULLBACK_EMA_TOLERANCE_PCT:
            reject_reasons.append(f"price too far from 9EMA ({pullback_pct:.2f}% > {ENTRY_PULLBACK_EMA_TOLERANCE_PCT}%)")

        # Filter 3: RSI must be above threshold (bullish momentum)
        if ENTRY_RSI_THRESHOLD_ENABLED and latest_rsi < ENTRY_RSI_CALL_MIN:
            reject_reasons.append(f"RSI {latest_rsi:.1f} < {ENTRY_RSI_CALL_MIN}")

        # Filter 4: Candle must break previous high (breakout confirmation)
        if ENTRY_CANDLE_BREAKOUT_ENABLED and not breaks_prev_high:
            reject_reasons.append("no break of prev candle high")

        # Filter 5: Strong bullish candle (no doji/small body)
        if ENTRY_STRONG_CANDLE_ENABLED and (body_ratio < ENTRY_MIN_BODY_RANGE_RATIO or not is_bullish_candle):
            if not is_bullish_candle:
                reject_reasons.append("candle is not bullish")
            elif body_ratio < ENTRY_MIN_BODY_RANGE_RATIO:
                reject_reasons.append(f"weak candle (body {body_ratio:.0%} < {ENTRY_MIN_BODY_RANGE_RATIO:.0%})")

        # Filter 6: RSI momentum — RSI must be actively rising for CALL
        if ENTRY_RSI_MOMENTUM_ENABLED and rsi_delta < ENTRY_RSI_MIN_DELTA:
            reject_reasons.append(f"RSI not rising (delta {rsi_delta:+.2f} < +{ENTRY_RSI_MIN_DELTA})")

        # Filter 7: Volume confirmation — current bar volume above average
        # Skip if Alpaca returned no volume data (IEX feed limitation) — don't
        # block a valid signal just because the data feed is missing volume.
        if ENTRY_VOLUME_CONFIRMATION_ENABLED and not volume_unavailable and volume_ratio < ENTRY_VOLUME_MIN_RATIO:
            reject_reasons.append(f"low volume (ratio {volume_ratio:.2f} < {ENTRY_VOLUME_MIN_RATIO})")

        # Filter 8: RSI extreme avoidance — don't enter CALL when overbought
        if ENTRY_RSI_EXTREME_FILTER_ENABLED and latest_rsi > ENTRY_RSI_CALL_MAX:
            reject_reasons.append(f"RSI overbought {latest_rsi:.1f} > {ENTRY_RSI_CALL_MAX}")

        # Filter 9: RSI streak exhaustion — streak=2 is ideal fresh momentum.
        # Streak 3+ = marginal/exhausted: already climbed N bars, next bar is reversal candidate.
        # Streak 5+ = near-certain reversal (entering someone else's exit).
        if ENTRY_RSI_STREAK_ENABLED:
            if up_streak < ENTRY_RSI_MIN_STREAK:
                reject_reasons.append(f"RSI up streak {up_streak} < {ENTRY_RSI_MIN_STREAK} (not enough momentum)")
            elif up_streak > ENTRY_RSI_MAX_STREAK:
                reject_reasons.append(f"RSI exhaustion (up streak {up_streak} > max {ENTRY_RSI_MAX_STREAK}) — wait for reset")

        # Filter 10: VWAP — price must be above VWAP for CALL (bullish flow)
        if ENTRY_VWAP_FILTER_ENABLED and vwap is not None and not price_above_vwap:
            reject_reasons.append(f"price below VWAP {vwap:.2f} (bearish flow)")

        # Filter 11: Price structure — candle pattern must confirm bullish direction
        if ENTRY_PRICE_STRUCTURE_ENABLED:
            if price_structure_bearish:
                reject_reasons.append(f"bearish candle pattern ({price_structure})")
            elif price_structure_neutral:
                reject_reasons.append(f"consolidation pattern ({price_structure}) — no directional edge")

        # Filter 12: EMA triple stack — EMA9 > EMA21 > EMA55 fully fanned (Tier 2)
        if ENTRY_EMA_TRIPLE_STACK_ENABLED and not ema_triple_bull:
            reject_reasons.append("EMA triple stack not aligned (EMA9 > EMA21 > EMA55 required)")

        if reject_reasons:
            info(f" CALL signal rejected: {'; '.join(reject_reasons)}")
        else:
            entry_info = {
                "signal": "CALL",
                "filters_passed": [],
                "reasons": [f"RSI MA cross UP detected"],
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
                },
            }
            if ENTRY_EMA_CROSS_ENABLED:
                entry_info["filters_passed"].append("EMA9 > EMA21 (bullish)")
            if ENTRY_PULLBACK_ENABLED:
                entry_info["filters_passed"].append(f"pullback {pullback_pct:.2f}% within range")
            if ENTRY_RSI_THRESHOLD_ENABLED:
                entry_info["filters_passed"].append(f"RSI {latest_rsi:.1f} >= {ENTRY_RSI_CALL_MIN}")
            if ENTRY_CANDLE_BREAKOUT_ENABLED:
                entry_info["filters_passed"].append("broke prev candle high")
            if ENTRY_STRONG_CANDLE_ENABLED:
                entry_info["filters_passed"].append(f"strong bullish candle ({body_ratio:.0%})")
            if ENTRY_RSI_MOMENTUM_ENABLED:
                entry_info["filters_passed"].append(f"RSI momentum delta={rsi_delta:+.2f}")
            if ENTRY_VOLUME_CONFIRMATION_ENABLED:
                if volume_unavailable:
                    entry_info["filters_passed"].append("volume unavailable (skipped)")
                else:
                    entry_info["filters_passed"].append(f"volume {volume_ratio:.1f}x avg")
            if ENTRY_RSI_EXTREME_FILTER_ENABLED:
                entry_info["filters_passed"].append(f"RSI {latest_rsi:.1f} < {ENTRY_RSI_CALL_MAX} (not overbought)")
            if ENTRY_RSI_STREAK_ENABLED:
                entry_info["filters_passed"].append(f"RSI up streak {up_streak} (\u2264 max {ENTRY_RSI_MAX_STREAK})")
            if ENTRY_VWAP_FILTER_ENABLED and vwap is not None:
                entry_info["filters_passed"].append(f"price above VWAP {vwap:.2f}")
            if ENTRY_PRICE_STRUCTURE_ENABLED:
                ps_label = price_structure if price_structure != "NONE" else "no pattern (neutrally OK)"
                entry_info["filters_passed"].append(f"price structure: {ps_label}")
            if ENTRY_EMA_TRIPLE_STACK_ENABLED:
                entry_info["filters_passed"].append("EMA9 > EMA21 > EMA55 (triple stack bullish)")
            return "CALL", ContractType.CALL, OrderSide.BUY, entry_info

    # ── PUT filters ──
    if put_candidate:
        reject_reasons = []

        # Filter 1: EMA regime — 9 EMA must be below 21 EMA (bearish)
        if ENTRY_EMA_CROSS_ENABLED and ema_fast_above:
            reject_reasons.append(f"EMA9 above EMA21 (bullish regime)")

        # Filter 2: Pullback to 9 EMA — don't chase extended breakdowns
        if ENTRY_PULLBACK_ENABLED and pullback_pct > ENTRY_PULLBACK_EMA_TOLERANCE_PCT:
            reject_reasons.append(f"price too far from 9EMA ({pullback_pct:.2f}% > {ENTRY_PULLBACK_EMA_TOLERANCE_PCT}%)")

        # Filter 3: RSI must be below threshold (bearish momentum)
        if ENTRY_RSI_THRESHOLD_ENABLED and latest_rsi > ENTRY_RSI_PUT_MAX:
            reject_reasons.append(f"RSI {latest_rsi:.1f} > {ENTRY_RSI_PUT_MAX}")

        # Filter 4: Candle must break previous low (breakdown confirmation)
        if ENTRY_CANDLE_BREAKOUT_ENABLED and not breaks_prev_low:
            reject_reasons.append("no break of prev candle low")

        # Filter 5: Strong bearish candle (no doji/small body)
        if ENTRY_STRONG_CANDLE_ENABLED and (body_ratio < ENTRY_MIN_BODY_RANGE_RATIO or not is_bearish_candle):
            if not is_bearish_candle:
                reject_reasons.append("candle is not bearish")
            elif body_ratio < ENTRY_MIN_BODY_RANGE_RATIO:
                reject_reasons.append(f"weak candle (body {body_ratio:.0%} < {ENTRY_MIN_BODY_RANGE_RATIO:.0%})")

        # Filter 6: RSI momentum — RSI must be actively falling for PUT
        if ENTRY_RSI_MOMENTUM_ENABLED and rsi_delta > -ENTRY_RSI_MIN_DELTA:
            reject_reasons.append(f"RSI not falling (delta {rsi_delta:+.2f} > -{ENTRY_RSI_MIN_DELTA})")

        # Filter 7: Volume confirmation — current bar volume above average
        # Skip if Alpaca returned no volume data (IEX feed limitation).
        if ENTRY_VOLUME_CONFIRMATION_ENABLED and not volume_unavailable and volume_ratio < ENTRY_VOLUME_MIN_RATIO:
            reject_reasons.append(f"low volume (ratio {volume_ratio:.2f} < {ENTRY_VOLUME_MIN_RATIO})")

        # Filter 8: RSI extreme avoidance — don't enter PUT when oversold
        if ENTRY_RSI_EXTREME_FILTER_ENABLED and latest_rsi < ENTRY_RSI_PUT_MIN:
            reject_reasons.append(f"RSI oversold {latest_rsi:.1f} < {ENTRY_RSI_PUT_MIN}")

        # Filter 9: RSI streak exhaustion — streak=2 is ideal fresh momentum.
        # Streak 3+ = marginal/exhausted: already dropped N bars, next bar is bounce candidate.
        # Streak 5+ = near-certain reversal.
        if ENTRY_RSI_STREAK_ENABLED:
            if down_streak < ENTRY_RSI_MIN_STREAK:
                reject_reasons.append(f"RSI down streak {down_streak} < {ENTRY_RSI_MIN_STREAK} (not enough momentum)")
            elif down_streak > ENTRY_RSI_MAX_STREAK:
                reject_reasons.append(f"RSI exhaustion (down streak {down_streak} > max {ENTRY_RSI_MAX_STREAK}) — wait for reset")

        # Filter 10: VWAP — price must be below VWAP for PUT (bearish flow)
        if ENTRY_VWAP_FILTER_ENABLED and vwap is not None and price_above_vwap:
            reject_reasons.append(f"price above VWAP {vwap:.2f} (bullish flow)")

        # Filter 11: Price structure — candle pattern must confirm bearish direction
        if ENTRY_PRICE_STRUCTURE_ENABLED:
            if price_structure_bullish:
                reject_reasons.append(f"bullish candle pattern ({price_structure})")
            elif price_structure_neutral:
                reject_reasons.append(f"consolidation pattern ({price_structure}) — no directional edge")

        # Filter 12: EMA triple stack — EMA9 < EMA21 < EMA55 fully fanned down (Tier 2)
        if ENTRY_EMA_TRIPLE_STACK_ENABLED and not ema_triple_bear:
            reject_reasons.append("EMA triple stack not aligned (EMA9 < EMA21 < EMA55 required)")

        if reject_reasons:
            info(f" PUT signal rejected: {'; '.join(reject_reasons)}")
        else:
            entry_info = {
                "signal": "PUT",
                "filters_passed": [],
                "reasons": [f"RSI MA cross DOWN detected"],
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
                },
            }
            if ENTRY_EMA_CROSS_ENABLED:
                entry_info["filters_passed"].append("EMA9 < EMA21 (bearish)")
            if ENTRY_PULLBACK_ENABLED:
                entry_info["filters_passed"].append(f"pullback {pullback_pct:.2f}% within range")
            if ENTRY_RSI_THRESHOLD_ENABLED:
                entry_info["filters_passed"].append(f"RSI {latest_rsi:.1f} <= {ENTRY_RSI_PUT_MAX}")
            if ENTRY_CANDLE_BREAKOUT_ENABLED:
                entry_info["filters_passed"].append("broke prev candle low")
            if ENTRY_STRONG_CANDLE_ENABLED:
                entry_info["filters_passed"].append(f"strong bearish candle ({body_ratio:.0%})")
            if ENTRY_RSI_MOMENTUM_ENABLED:
                entry_info["filters_passed"].append(f"RSI momentum delta={rsi_delta:+.2f}")
            if ENTRY_VOLUME_CONFIRMATION_ENABLED:
                if volume_unavailable:
                    entry_info["filters_passed"].append("volume unavailable (skipped)")
                else:
                    entry_info["filters_passed"].append(f"volume {volume_ratio:.1f}x avg")
            if ENTRY_RSI_EXTREME_FILTER_ENABLED:
                entry_info["filters_passed"].append(f"RSI {latest_rsi:.1f} > {ENTRY_RSI_PUT_MIN} (not oversold)")
            if ENTRY_RSI_STREAK_ENABLED:
                entry_info["filters_passed"].append(f"RSI down streak {down_streak} (\u2264 max {ENTRY_RSI_MAX_STREAK})")
            if ENTRY_VWAP_FILTER_ENABLED and vwap is not None:
                entry_info["filters_passed"].append(f"price below VWAP {vwap:.2f}")
            if ENTRY_PRICE_STRUCTURE_ENABLED:
                ps_label = price_structure if price_structure != "NONE" else "no pattern (neutrally OK)"
                entry_info["filters_passed"].append(f"price structure: {ps_label}")
            if ENTRY_EMA_TRIPLE_STACK_ENABLED:
                entry_info["filters_passed"].append("EMA9 < EMA21 < EMA55 (triple stack bearish)")
            return "PUT", ContractType.PUT, OrderSide.BUY, entry_info

    return None, None, None, None