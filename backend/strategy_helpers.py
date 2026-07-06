from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from alpaca.trading.enums import ContractType, OrderSide
from config import (
    ENTRY_ATR_PCT_MIN,
    ENTRY_ATR_PCT_MIN_PER_SYMBOL,
    ENTRY_CONFLUENCE_CANDLE_BODY_MIN,
    ENTRY_CONFLUENCE_MIN_SCORE,
    ENTRY_CONFLUENCE_VOLUME_RATIO_MIN,
    ENTRY_OPENING_ZONE_VETO_ENABLED,
    ENTRY_RSI_VETO_CALL_MAX,
    ENTRY_RSI_VETO_PUT_MIN,
    ENTRY_SETUP_A_BODY_ALT_MIN,
    ENTRY_SETUP_A_ENABLED,
    ENTRY_SETUP_A_PULLBACK_MAX_PCT,
    ENTRY_SETUP_B_BODY_MIN_RATIO,
    ENTRY_SETUP_B_ENABLED,
    ENTRY_SETUP_C_ENABLED,
    ENTRY_SETUP_C_RSI_DELTA_MIN,
    ENTRY_SETUP_C_RSI_GAP_MIN,
    ENTRY_TIME_WINDOW_ENABLED,
    ENTRY_TIME_WINDOWS,
)
from logger import info


# ── Utility helpers (used by market_data.py, api_server.py, main.py) ─────────

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
    if weekday in (1, 2, 3):
        return current + timedelta(days=(4 - weekday) + 7)
    if weekday == 4:
        return current + timedelta(days=7)

    days_to_friday = (4 - weekday) % 7
    return current + timedelta(days=days_to_friday)


# ── Trade time window ─────────────────────────────────────────────────────────

def _in_trade_window() -> bool:
    """Return True if current ET clock is inside any configured trade window."""
    if not ENTRY_TIME_WINDOW_ENABLED:
        return True
    now_et = datetime.now(tz=ZoneInfo("America/New_York"))
    mins = now_et.hour * 60 + now_et.minute
    return any(start <= mins < end for start, end in ENTRY_TIME_WINDOWS)


# ── Tier 1 — Regime classification ───────────────────────────────────────────

def classify_regime(rsi_result: dict) -> str:
    """Return BULL, BEAR, or CHOP.

    BULL requires: price > VWAP AND EMA9 > EMA21 > EMA55 (held N bars) AND RSI > 50.
    BEAR requires: price < VWAP AND EMA9 < EMA21 < EMA55 (held N bars) AND RSI < 50.
    Falls back to EMA-stack + RSI when VWAP is unavailable (IEX feed gaps).
    """
    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    ema_bull = bool(rsi_result.get("ema_triple_bull_persist", False))
    ema_bear = bool(rsi_result.get("ema_triple_bear_persist", False))
    price_above_vwap = rsi_result.get("price_above_vwap")
    vwap = rsi_result.get("vwap")

    if vwap is None or price_above_vwap is None:
        if ema_bull and latest_rsi > 50:
            return "BULL"
        if ema_bear and latest_rsi < 50:
            return "BEAR"
        return "CHOP"

    if bool(price_above_vwap) and ema_bull and latest_rsi > 50:
        return "BULL"
    if (not bool(price_above_vwap)) and ema_bear and latest_rsi < 50:
        return "BEAR"
    return "CHOP"


# ── Tier 2 — Setup detectors ──────────────────────────────────────────────────

def _setup_a_pullback(rsi_result: dict, direction: str) -> bool:
    """Setup A: Pullback-to-EMA9 — trend-following entry.

    Fires when the PREVIOUS bar kissed EMA9 (within ENTRY_SETUP_A_PULLBACK_MAX_PCT)
    and the CURRENT bar bounces in the trend direction. Accepts either:
      (a) break of prior high/low (structure break — primary), OR
      (b) strong-bodied candle >= ENTRY_SETUP_A_BODY_ALT_MIN (A2.4 — catches fast bounces
          where the structure break hasn't happened on the same bar, e.g. TSLA gaps).
    Tier 3 confluence still scores the bar independently, so the body-ratio
    alternative is only a primary-signal gate relaxation, not a free pass.
    """
    previous_close = float(rsi_result.get("previous_close", 0))
    prev_ema_fast = float(rsi_result.get("prev_ema_fast", 0))
    if prev_ema_fast <= 0:
        return False

    prev_pullback_pct = abs(previous_close - prev_ema_fast) / prev_ema_fast * 100
    if prev_pullback_pct > ENTRY_SETUP_A_PULLBACK_MAX_PCT:
        return False

    body_ratio = float(rsi_result.get("candle_body_ratio", 0))
    if direction == "CALL":
        structure_break = bool(rsi_result.get("candle_breaks_prev_high", False))
        strong_body = bool(rsi_result.get("candle_is_bullish", False)) and body_ratio >= ENTRY_SETUP_A_BODY_ALT_MIN
        return bool(rsi_result.get("candle_is_bullish", False)) and (structure_break or strong_body)
    else:
        structure_break = bool(rsi_result.get("candle_breaks_prev_low", False))
        strong_body = bool(rsi_result.get("candle_is_bearish", False)) and body_ratio >= ENTRY_SETUP_A_BODY_ALT_MIN
        return bool(rsi_result.get("candle_is_bearish", False)) and (structure_break or strong_body)


def _setup_b_bb_break(rsi_result: dict, direction: str) -> bool:
    """Setup B: Bollinger Band breakout in trend direction.

    CALL: previous close was inside the band; current close breaks above upper band.
    PUT:  previous close was inside the band; current close breaks below lower band.
    Both require a strong-bodied candle to filter wick-only breaks.
    """
    body_ratio = float(rsi_result.get("candle_body_ratio", 0))
    if body_ratio < ENTRY_SETUP_B_BODY_MIN_RATIO:
        return False

    previous_close = float(rsi_result.get("previous_close", 0))
    candle_close = float(rsi_result.get("candle_close", 0))

    if direction == "CALL":
        prev_bb_upper = float(rsi_result.get("prev_bb_upper", 0))
        bb_upper = float(rsi_result.get("bb_upper", 0))
        return (
            bool(rsi_result.get("candle_is_bullish", False))
            and prev_bb_upper > 0
            and previous_close < prev_bb_upper
            and candle_close > bb_upper
        )
    else:
        prev_bb_lower = float(rsi_result.get("prev_bb_lower", 0))
        bb_lower = float(rsi_result.get("bb_lower", 0))
        return (
            bool(rsi_result.get("candle_is_bearish", False))
            and prev_bb_lower > 0
            and previous_close > prev_bb_lower
            and candle_close < bb_lower
        )


def _setup_c_rsi_momentum(rsi_result: dict, direction: str) -> bool:
    """Setup C: RSI momentum cross — stricter replacement for the old RSI_CROSSOVER.

    The cross must fire on THIS bar (no previous-bar carryover), originate from the
    opposite side of RSI=50, have a gap >= ENTRY_SETUP_C_RSI_GAP_MIN between RSI
    and its MA, and be actively accelerating (|delta| >= ENTRY_SETUP_C_RSI_DELTA_MIN).
    """
    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    previous_rsi = float(rsi_result.get("previous_rsi", 50))
    latest_rsi_ma = float(rsi_result.get("latest_rsi_ma", 50))
    delta = float(rsi_result.get("delta", 0))
    rsi_gap = abs(latest_rsi - latest_rsi_ma)

    if rsi_gap < ENTRY_SETUP_C_RSI_GAP_MIN:
        return False

    if direction == "CALL":
        return (
            bool(rsi_result.get("rsi_ma_cross_up", False))
            and previous_rsi < 50
            and latest_rsi > 50
            and delta >= ENTRY_SETUP_C_RSI_DELTA_MIN
        )
    else:
        return (
            bool(rsi_result.get("rsi_ma_cross_down", False))
            and previous_rsi > 50
            and latest_rsi < 50
            and delta <= -ENTRY_SETUP_C_RSI_DELTA_MIN
        )


# ── Tier 3 — Confluence scoring ───────────────────────────────────────────────

def _confluence_score(rsi_result: dict, direction: str) -> tuple[int, list[str]]:
    """Score directional confluence 0–4 and collect hard veto reasons.

    Returns (score, vetoes). A non-empty vetoes list blocks the entry regardless
    of score. Items that add to score:
      1. Strong directional candle body (>= ENTRY_CONFLUENCE_CANDLE_BODY_MIN)
      2. MACD agrees with direction and is accelerating
      3. Volume confirms (>= ENTRY_CONFLUENCE_VOLUME_RATIO_MIN) or unavailable
      4. Price-structure pattern (engulfing / hammer / pin bar) agrees
    """
    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    body_ratio = float(rsi_result.get("candle_body_ratio", 0))
    macd_line = float(rsi_result.get("macd_line") or 0)
    macd_signal_val = float(rsi_result.get("macd_signal") or 0)
    prev_macd_line = float(rsi_result.get("prev_macd_line") or macd_line)
    volume_ratio = float(rsi_result.get("volume_ratio", 0))
    volume_unavailable = bool(rsi_result.get("volume_unavailable", False))
    ps_bullish = bool(rsi_result.get("price_structure_bullish", False))
    ps_bearish = bool(rsi_result.get("price_structure_bearish", False))
    ps_neutral = bool(rsi_result.get("price_structure_neutral", False))

    # Hard vetoes — block regardless of score
    vetoes: list[str] = []
    if ps_neutral:
        vetoes.append("INSIDE_BAR")
    if direction == "CALL" and latest_rsi >= ENTRY_RSI_VETO_CALL_MAX:
        vetoes.append(f"RSI_OVEREXTENDED({latest_rsi:.1f}>={ENTRY_RSI_VETO_CALL_MAX})")
    if direction == "PUT" and latest_rsi <= ENTRY_RSI_VETO_PUT_MIN:
        vetoes.append(f"RSI_OVEREXTENDED({latest_rsi:.1f}<={ENTRY_RSI_VETO_PUT_MIN})")

    atr_pct = rsi_result.get("atr_pct")
    if atr_pct is not None:
        symbol = str(rsi_result.get("symbol") or "")
        atr_floor = float(ENTRY_ATR_PCT_MIN_PER_SYMBOL.get(symbol, ENTRY_ATR_PCT_MIN))
        if float(atr_pct) < atr_floor:
            vetoes.append(f"CHOPPY(ATR%={float(atr_pct):.2f}<{atr_floor:.3f}[{symbol or 'default'}])")

    if ENTRY_OPENING_ZONE_VETO_ENABLED and bool(rsi_result.get("in_opening_zone", False)):
        vetoes.append("OPENING_ZONE(09:30-09:45)")

    if bool(rsi_result.get("at_sr_wall", False)):
        walls = rsi_result.get("sr_walls_hit") or []
        vetoes.append(f"AT_SR_WALL({','.join(walls) if walls else 'level'})")

    if vetoes:
        return 0, vetoes

    score = 0

    # 1. Strong directional candle
    if direction == "CALL":
        if bool(rsi_result.get("candle_is_bullish", False)) and body_ratio >= ENTRY_CONFLUENCE_CANDLE_BODY_MIN:
            score += 1
    else:
        if bool(rsi_result.get("candle_is_bearish", False)) and body_ratio >= ENTRY_CONFLUENCE_CANDLE_BODY_MIN:
            score += 1

    # 2. MACD momentum aligned and accelerating
    if direction == "CALL":
        if macd_line > macd_signal_val and macd_line > prev_macd_line:
            score += 1
    else:
        if macd_line < macd_signal_val and macd_line < prev_macd_line:
            score += 1

    # 3. Volume confirms — only credit when actual volume passes the ratio gate.
    # On IEX feed volume is often 0 (volume_unavailable=True); the max achievable score
    # is then 3/4. Log this so starvation analysis is honest (A2.3).
    if not volume_unavailable and volume_ratio >= ENTRY_CONFLUENCE_VOLUME_RATIO_MIN:
        score += 1
    # denominator logged below in determine_signal via entry_info

    # 4. Price-structure candle pattern agrees
    if direction == "CALL" and ps_bullish:
        score += 1
    elif direction == "PUT" and ps_bearish:
        score += 1

    return score, []


# ── Entry signal — three-tier pipeline ───────────────────────────────────────

def determine_signal(rsi_result, current_price: float):
    """Three-tier entry: Regime → Trigger → Confluence.

    Returns (signal, contract_type, order_side, entry_info) or (None, None, None, None).
    """
    # ── Filter 0: Trade time window ────────────────────────────────────────────
    if not _in_trade_window():
        info("  Signal rejected: outside configured trade windows (ET)")
        return None, None, None, None

    # ── Tier 1: Regime ─────────────────────────────────────────────────────────
    regime = classify_regime(rsi_result)

    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    latest_rsi_ma = float(rsi_result.get("latest_rsi_ma", 50))
    rsi_delta = float(rsi_result.get("delta", 0))
    vwap = rsi_result.get("vwap")
    price_above_vwap = rsi_result.get("price_above_vwap")
    ema_triple_bull = bool(rsi_result.get("ema_triple_bull", False))
    ema_triple_bear = bool(rsi_result.get("ema_triple_bear", False))

    info(
        f"  Regime: {regime} | "
        f"VWAP={round(vwap, 2) if vwap is not None else 'N/A'} "
        f"PriceAboveVWAP={price_above_vwap} | "
        f"EMA_TRIPLE_BULL={ema_triple_bull} EMA_TRIPLE_BEAR={ema_triple_bear} | "
        f"RSI={latest_rsi:.1f} RSI_MA={latest_rsi_ma:.1f} delta={rsi_delta:+.2f}"
    )

    if regime == "CHOP":
        info("  Signal rejected: REGIME=CHOP — no aligned EMA stack + VWAP + RSI")
        return None, None, None, None

    direction = "CALL" if regime == "BULL" else "PUT"

    # ── Tier 2: Setup detection — priority A > B > C ───────────────────────────
    setup_fired: str | None = None

    if ENTRY_SETUP_A_ENABLED and _setup_a_pullback(rsi_result, direction):
        setup_fired = "SETUP_A_PULLBACK"
    elif ENTRY_SETUP_B_ENABLED and _setup_b_bb_break(rsi_result, direction):
        setup_fired = "SETUP_B_BB_BREAK"
    elif ENTRY_SETUP_C_ENABLED and _setup_c_rsi_momentum(rsi_result, direction):
        setup_fired = "SETUP_C_RSI_MOMENTUM"

    if setup_fired is None:
        info(f"  Signal rejected: REGIME={regime} ({direction}) — no setup matched (A/B/C)")
        return None, None, None, None

    info(f"  Setup: {setup_fired} matched for {direction}")

    # ── Tier 3: Confluence ─────────────────────────────────────────────────────
    score, vetoes = _confluence_score(rsi_result, direction)

    # A2.3: log the real denominator so we can diagnose IEX-feed starvation.
    # Volume is permanently unavailable on the free IEX feed, capping max score at 3/4.
    _vol_unavail = bool(rsi_result.get("volume_unavailable", False))
    _denom = 3 if _vol_unavail else 4
    _vol_note = " [IEX—volume unavailable, max 3/4]" if _vol_unavail else ""

    if vetoes:
        info(f"  Signal rejected: {direction} vetoed — {', '.join(vetoes)}")
        return None, None, None, None

    if score < ENTRY_CONFLUENCE_MIN_SCORE:
        info(f"  Signal rejected: confluence {score}/{_denom} < {ENTRY_CONFLUENCE_MIN_SCORE} required{_vol_note}")
        return None, None, None, None

    info(f"  Signal approved: {direction} | {setup_fired} | confluence {score}/{_denom}{_vol_note}")

    contract_type = ContractType.CALL if direction == "CALL" else ContractType.PUT
    order_side = OrderSide.BUY

    entry_info = {
        "signal": direction,
        "filters_passed": [
            f"regime={regime}",
            f"setup={setup_fired}",
            f"confluence={score}/{_denom}",
        ],
        "reasons": [f"Regime {regime} | {setup_fired} | Confluence {score}/{_denom}{_vol_note}"],
        "entry_strategies": [setup_fired],
        "indicators": {
            "regime": regime,
            "setup": setup_fired,
            "confluence_score": score,
            "confluence_denominator": _denom,
            "volume_unavailable": _vol_unavail,
            "rsi": round(latest_rsi, 1),
            "rsi_delta": round(rsi_delta, 2),
            "rsi_ma": round(latest_rsi_ma, 1),
            "ema_triple_bull": ema_triple_bull,
            "ema_triple_bear": ema_triple_bear,
            "price_above_vwap": price_above_vwap,
            "vwap": round(vwap, 2) if vwap is not None else None,
            "macd_line": rsi_result.get("macd_line"),
            "macd_signal": rsi_result.get("macd_signal"),
            "bb_upper": rsi_result.get("bb_upper"),
            "bb_lower": rsi_result.get("bb_lower"),
            "volume_ratio": float(rsi_result.get("volume_ratio", 0)),
            "price_structure": rsi_result.get("price_structure", "NONE"),
        },
    }

    return direction, contract_type, order_side, entry_info
