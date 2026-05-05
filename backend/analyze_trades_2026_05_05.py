"""
Diagnostic: Why No Trades Were Taken — May 5, 2026, 12:30–1:30 PM Chicago
==========================================================================
Runs the REAL Cape entry pipeline (Regime → Setup → Confluence) bar-by-bar
against Alpaca IEX data and explains every block.

Also shows the simplified 4-condition gate from the prompt for cross-reference.

Run: python backend/analyze_trades_2026_05_05.py
"""

from __future__ import annotations

import datetime
import os
import sys
import traceback
import zoneinfo
from pathlib import Path

import pandas as pd

# ── Ensure backend/ is on path when run from project root ────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# ── Config (use same keys / feed as production) ───────────────────────────────
from config import (
    API_KEY,
    SECRET_KEY,
    STOCK_DATA_FEED,
    EMA_FAST_PERIOD,
    EMA_SLOW_PERIOD,
    EMA_THIRD_PERIOD,
    RSI_PERIOD,
    RSI_MA_PERIOD,
    ENTRY_ATR_PCT_MIN,
    ENTRY_SR_PROXIMITY_PCT,
    ENTRY_TREND_PERSISTENCE_BARS,
    ENTRY_OPENING_ZONE_VETO_ENABLED,
    ENTRY_RSI_VETO_CALL_MAX,
    ENTRY_RSI_VETO_PUT_MIN,
    ENTRY_SETUP_A_ENABLED,
    ENTRY_SETUP_A_PULLBACK_MAX_PCT,
    ENTRY_SETUP_B_ENABLED,
    ENTRY_SETUP_B_BODY_MIN_RATIO,
    ENTRY_SETUP_C_ENABLED,
    ENTRY_SETUP_C_RSI_GAP_MIN,
    ENTRY_SETUP_C_RSI_DELTA_MIN,
    ENTRY_CONFLUENCE_MIN_SCORE,
    ENTRY_CONFLUENCE_CANDLE_BODY_MIN,
    ENTRY_CONFLUENCE_VOLUME_RATIO_MIN,
)

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame

try:
    from tabulate import tabulate
    HAS_TABULATE = True
except ImportError:
    HAS_TABULATE = False

# ── Timezone setup ─────────────────────────────────────────────────────────────
CT  = zoneinfo.ZoneInfo("America/Chicago")
ET  = zoneinfo.ZoneInfo("America/New_York")
UTC = datetime.timezone.utc

now_utc = datetime.datetime.now(UTC)
now_ct  = now_utc.astimezone(CT)
is_dst  = bool(now_ct.dst())

TZ_LABEL = "CDT (UTC-5)" if is_dst else "CT standard time (UTC-6)"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 0 — Resolve timezone
# ══════════════════════════════════════════════════════════════════════════════

window_start_ct = datetime.datetime(2026, 5, 5, 12, 30, tzinfo=CT)
window_end_ct   = datetime.datetime(2026, 5, 5, 13, 30, tzinfo=CT)
warmup_start_ct = window_start_ct - datetime.timedelta(hours=1)

ws_utc = window_start_ct.astimezone(UTC)
we_utc = window_end_ct.astimezone(UTC)
ws_et  = window_start_ct.astimezone(ET)
we_et  = window_end_ct.astimezone(ET)

print("=" * 72)
print("STEP 0 — TIMEZONE RESOLUTION")
print("=" * 72)
print(f"Chicago is currently on {TZ_LABEL}")
print(f"Analysis window  : 12:30–1:30 PM CDT (Chicago)")
print(f"Equivalent ET    : {ws_et.strftime('%I:%M %p')}–{we_et.strftime('%I:%M %p')} ET")
print(f"UTC window       : {ws_utc.strftime('%H:%M')}–{we_utc.strftime('%H:%M')} UTC")
print(f"Warmup start     : {warmup_start_ct.strftime('%H:%M')} CDT (1 hr before window)")
print()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — Fetch Alpaca 1-min bars
# ══════════════════════════════════════════════════════════════════════════════

SYMBOLS = ["SPY", "TSLA"]
client = StockHistoricalDataClient(api_key=API_KEY, secret_key=SECRET_KEY)

all_data: dict[str, pd.DataFrame] = {}
error_count = 0

print("=" * 72)
print("STEP 1 — FETCHING ALPACA 1-MIN BARS (IEX feed)")
print("=" * 72)

ERR_LOG = SCRIPT_DIR / "logs" / "errors.log"
ERR_LOG.parent.mkdir(exist_ok=True)

for sym in SYMBOLS:
    try:
        req = StockBarsRequest(
            symbol_or_symbols=[sym],
            timeframe=TimeFrame.Minute,
            start=warmup_start_ct.astimezone(UTC),
            end=window_end_ct.astimezone(UTC),
            feed=STOCK_DATA_FEED,
        )
        resp = client.get_stock_bars(req)

        bars = []
        try:
            bars = resp[sym]
        except Exception:
            if hasattr(resp, "get"):
                bars = resp.get(sym) or []
            elif hasattr(resp, "data") and isinstance(resp.data, dict):
                bars = resp.data.get(sym) or []

        if not bars:
            print(f"  NO DATA for {sym} — skipping")
            continue

        def _ts(b):
            t = getattr(b, "timestamp", None)
            if t is None:
                t = getattr(b, "t", None)
            if t is None:
                return datetime.datetime.now(UTC)
            return t if t.tzinfo else t.replace(tzinfo=UTC)

        df = pd.DataFrame({
            "timestamp": [_ts(b) for b in bars],
            "open":      [float(b.open)   for b in bars],
            "high":      [float(b.high)   for b in bars],
            "low":       [float(b.low)    for b in bars],
            "close":     [float(b.close)  for b in bars],
            "volume":    [int(getattr(b, "volume", 0) or 0) for b in bars],
        })
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df = df.sort_values("timestamp").reset_index(drop=True)

        all_data[sym] = df
        first_ct = df["timestamp"].iloc[0].astimezone(CT).strftime("%H:%M")
        last_ct  = df["timestamp"].iloc[-1].astimezone(CT).strftime("%H:%M")
        print(f"  {sym}: {len(df)} bars ({first_ct}–{last_ct} CDT)")
    except Exception as exc:
        print(f"  ERROR fetching {sym}: {exc}")
        error_count += 1
        with open(ERR_LOG, "a") as f:
            f.write(f"[{datetime.datetime.now()}] {sym}: {traceback.format_exc()}\n")

print()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — Compute indicators on full DataFrame
# ══════════════════════════════════════════════════════════════════════════════

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    close  = df["close"].astype("float64")
    high   = df["high"].astype("float64")
    low    = df["low"].astype("float64")
    volume = df["volume"].astype("float64")
    opens  = df["open"].astype("float64")

    # EMAs
    ema9  = close.ewm(span=EMA_FAST_PERIOD, adjust=False).mean()
    ema21 = close.ewm(span=EMA_SLOW_PERIOD, adjust=False).mean()
    ema55 = close.ewm(span=EMA_THIRD_PERIOD, adjust=False).mean()

    # RSI (Wilder via EWM, same as production code)
    delta    = close.diff()
    gain     = delta.where(delta > 0, 0.0)
    loss     = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    rs       = avg_gain / avg_loss
    rsi      = 100 - (100 / (1 + rs))
    rsi_ma   = rsi.rolling(window=RSI_MA_PERIOD).mean()

    # MACD (12, 26, 9)
    ema12       = close.ewm(span=12, adjust=False).mean()
    ema26       = close.ewm(span=26, adjust=False).mean()
    macd_line   = ema12 - ema26
    macd_signal = macd_line.ewm(span=9, adjust=False).mean()

    # Bollinger Bands (20, 2)
    bb_basis      = close.rolling(20).mean()
    bb_std        = close.rolling(20).std(ddof=0)
    bb_upper      = bb_basis + 2.0 * bb_std
    bb_lower      = bb_basis - 2.0 * bb_std
    bb_width      = bb_upper - bb_lower
    bb_width_avg  = bb_width.rolling(20).mean()

    # ATR(14) Wilder
    prev_c = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_c).abs(),
        (low  - prev_c).abs(),
    ], axis=1).max(axis=1)
    atr14   = tr.ewm(alpha=1.0/14.0, adjust=False, min_periods=14).mean()
    atr_pct = atr14 / close * 100

    # Volume
    vol_avg20 = volume.rolling(20).mean()
    vol_ratio = volume / vol_avg20

    # EMA triple-stack persistence (ENTRY_TREND_PERSISTENCE_BARS consecutive bars)
    persist_n = int(ENTRY_TREND_PERSISTENCE_BARS)
    bull_each = (ema9 > ema21) & (ema21 > ema55)
    bear_each = (ema9 < ema21) & (ema21 < ema55)
    ema_bull_persist = bull_each.rolling(persist_n).min().astype(bool)
    ema_bear_persist = bear_each.rolling(persist_n).min().astype(bool)

    # VWAP — intraday, cumulative from NY 09:30 each day
    ts_et = df["timestamp"].apply(lambda t: t.astimezone(ET))
    tp = (high + low + close) / 3.0
    vwap_vals: list[float] = []
    cum_tpv = 0.0
    cum_vol = 0.0
    prev_date = None
    for i in range(len(df)):
        bar_date = ts_et.iloc[i].date()
        if bar_date != prev_date:
            cum_tpv = 0.0
            cum_vol = 0.0
            prev_date = bar_date
        cum_tpv += tp.iloc[i] * volume.iloc[i]
        cum_vol  += volume.iloc[i]
        vwap_vals.append(cum_tpv / cum_vol if cum_vol > 0 else float("nan"))
    vwap_s = pd.Series(vwap_vals, index=df.index, dtype="float64")

    # Prior-session (May 4) High/Low from warmup bars
    target_date_et = datetime.date(2026, 5, 5)
    prev_mask = ts_et.apply(lambda t: t.date() < target_date_et)
    pdh = float(high[prev_mask].max()) if prev_mask.any() else float("nan")
    pdl = float(low[prev_mask].min())  if prev_mask.any() else float("nan")

    # Candle geometry
    candle_range = high - low
    candle_body  = (close - opens).abs()
    body_ratio   = candle_body / candle_range.replace(0, float("nan"))

    out = df.copy()
    out["ema9"]             = ema9
    out["ema21"]            = ema21
    out["ema55"]            = ema55
    out["rsi"]              = rsi
    out["rsi_ma"]           = rsi_ma
    out["rsi_delta"]        = rsi - rsi.shift(1)
    out["prev_rsi"]         = rsi.shift(1)
    out["prev_rsi_ma"]      = rsi_ma.shift(1)
    out["macd_line"]        = macd_line
    out["macd_signal"]      = macd_signal
    out["prev_macd_line"]   = macd_line.shift(1)
    out["prev_macd_signal"] = macd_signal.shift(1)
    out["bb_upper"]         = bb_upper
    out["bb_lower"]         = bb_lower
    out["bb_width"]         = bb_width
    out["bb_width_avg"]     = bb_width_avg
    out["atr14"]            = atr14
    out["atr_pct"]          = atr_pct
    out["vol_avg20"]        = vol_avg20
    out["vol_ratio"]        = vol_ratio
    out["ema_bull_persist"] = ema_bull_persist
    out["ema_bear_persist"] = ema_bear_persist
    out["vwap"]             = vwap_s
    out["pdh"]              = pdh
    out["pdl"]              = pdl
    out["body_ratio"]       = body_ratio
    out["is_bullish"]       = close > opens
    out["is_bearish"]       = close < opens
    out["prev_close"]       = close.shift(1)
    out["prev_open"]        = opens.shift(1)
    out["prev_ema9"]        = ema9.shift(1)
    out["prev_bb_upper"]    = bb_upper.shift(1)
    out["prev_bb_lower"]    = bb_lower.shift(1)
    out["prev_high"]        = high.shift(1)
    out["prev_low"]         = low.shift(1)

    # ── Prompt 4-condition flags ──
    out["cond_vol_spike"]    = volume > (vol_avg20 * 2.0)
    out["cond_not_choppy"]   = atr_pct >= 0.30
    out["cond_bb_expanding"] = bb_width > (bb_width_avg * 2.0)
    out["cond_trend_5bar"]   = (ema9 > ema21).rolling(5).min().astype(bool)

    return out


# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Real Cape entry pipeline helpers
# ══════════════════════════════════════════════════════════════════════════════

def _within_pct(price: float, level, pct: float) -> bool:
    if level is None or (isinstance(level, float) and pd.isna(level)) or float(level) <= 0:
        return False
    return abs(price - float(level)) / float(level) <= pct


def classify_regime_row(row) -> str:
    rsi_val  = float(row["rsi"])
    bull_p   = bool(row["ema_bull_persist"])
    bear_p   = bool(row["ema_bear_persist"])
    vwap_val = row["vwap"]
    close_v  = float(row["close"])

    vwap_ok = pd.notna(vwap_val) and float(vwap_val) > 0
    if not vwap_ok:
        if bull_p and rsi_val > 50:
            return "BULL"
        if bear_p and rsi_val < 50:
            return "BEAR"
        return "CHOP"

    above = close_v > float(vwap_val)
    if above and bull_p and rsi_val > 50:
        return "BULL"
    if (not above) and bear_p and rsi_val < 50:
        return "BEAR"
    return "CHOP"


def check_setup_a(row, direction: str) -> bool:
    prev_c    = float(row["prev_close"])
    prev_ema9 = float(row["prev_ema9"])
    if prev_ema9 <= 0 or pd.isna(prev_ema9):
        return False
    pullback = abs(prev_c - prev_ema9) / prev_ema9 * 100
    if pullback > ENTRY_SETUP_A_PULLBACK_MAX_PCT:
        return False
    if direction == "CALL":
        return bool(row["is_bullish"]) and bool(row["high"] > row["prev_high"])
    return bool(row["is_bearish"]) and bool(row["low"] < row["prev_low"])


def check_setup_b(row, direction: str) -> bool:
    br = row["body_ratio"]
    if pd.isna(br) or float(br) < ENTRY_SETUP_B_BODY_MIN_RATIO:
        return False
    prev_c = float(row["prev_close"])
    c      = float(row["close"])
    if direction == "CALL":
        pbu = float(row["prev_bb_upper"])
        bu  = float(row["bb_upper"])
        return bool(row["is_bullish"]) and pbu > 0 and prev_c < pbu and c > bu
    pbl = float(row["prev_bb_lower"])
    bl  = float(row["bb_lower"])
    return bool(row["is_bearish"]) and pbl > 0 and prev_c > pbl and c < bl


def check_setup_c(row, direction: str) -> bool:
    rsi_val      = float(row["rsi"])
    prev_rsi_val = row.get("prev_rsi")
    if prev_rsi_val is None or pd.isna(prev_rsi_val):
        return False
    prev_rsi_val = float(prev_rsi_val)
    rsi_ma_val   = float(row["rsi_ma"])
    delta_val    = float(row["rsi_delta"])
    rsi_gap      = abs(rsi_val - rsi_ma_val)

    if rsi_gap < ENTRY_SETUP_C_RSI_GAP_MIN:
        return False

    # Detect RSI/MA cross on this bar (using prev_rsi vs rsi_ma approximation)
    prev_above = prev_rsi_val > rsi_ma_val
    curr_above = rsi_val > rsi_ma_val

    if direction == "CALL":
        return (
            (not prev_above) and curr_above
            and prev_rsi_val < 50
            and rsi_val > 50
            and delta_val >= ENTRY_SETUP_C_RSI_DELTA_MIN
        )
    return (
        prev_above and (not curr_above)
        and prev_rsi_val > 50
        and rsi_val < 50
        and delta_val <= -ENTRY_SETUP_C_RSI_DELTA_MIN
    )


def confluence_score(row, direction: str) -> tuple[int, list[str]]:
    rsi_val     = float(row["rsi"])
    body_r      = float(row["body_ratio"]) if pd.notna(row["body_ratio"]) else 0.0
    macd_l      = float(row["macd_line"])
    macd_s      = float(row["macd_signal"])
    prev_macd_l = float(row["prev_macd_line"])
    vol_r       = float(row["vol_ratio"]) if pd.notna(row["vol_ratio"]) else 0.0
    vol_unavail = int(row["volume"]) == 0
    close_v     = float(row["close"])
    vwap_v      = row["vwap"]
    pdh_v       = row["pdh"]
    pdl_v       = row["pdl"]
    atr_p       = row["atr_pct"]

    c_high = float(row["high"])
    c_low  = float(row["low"])
    p_high = float(row["prev_high"])
    p_low  = float(row["prev_low"])
    inside_bar = (c_high < p_high) and (c_low > p_low)

    vetoes: list[str] = []

    if inside_bar:
        vetoes.append("INSIDE_BAR")
    if direction == "CALL" and rsi_val >= ENTRY_RSI_VETO_CALL_MAX:
        vetoes.append(f"RSI_OVEREXTENDED({rsi_val:.1f}>={ENTRY_RSI_VETO_CALL_MAX})")
    if direction == "PUT" and rsi_val <= ENTRY_RSI_VETO_PUT_MIN:
        vetoes.append(f"RSI_OVEREXTENDED({rsi_val:.1f}<={ENTRY_RSI_VETO_PUT_MIN})")
    if pd.notna(atr_p) and float(atr_p) < ENTRY_ATR_PCT_MIN:
        vetoes.append(f"CHOPPY(ATR%={float(atr_p):.2f}<{ENTRY_ATR_PCT_MIN})")
    if ENTRY_OPENING_ZONE_VETO_ENABLED:
        ts_et_bar = row["timestamp"].astimezone(ET)
        bm = ts_et_bar.hour * 60 + ts_et_bar.minute
        if 9 * 60 + 30 <= bm < 9 * 60 + 45:
            vetoes.append("OPENING_ZONE")

    sr_pct  = float(ENTRY_SR_PROXIMITY_PCT)
    sr_hits = []
    if _within_pct(close_v, pdh_v, sr_pct): sr_hits.append("PDH")
    if _within_pct(close_v, pdl_v, sr_pct): sr_hits.append("PDL")
    if _within_pct(close_v, vwap_v, sr_pct): sr_hits.append("VWAP")
    if sr_hits:
        vetoes.append(f"AT_SR_WALL({','.join(sr_hits)})")

    if vetoes:
        return 0, vetoes

    score = 0

    # 1. Strong directional candle
    if direction == "CALL" and bool(row["is_bullish"]) and body_r >= ENTRY_CONFLUENCE_CANDLE_BODY_MIN:
        score += 1
    elif direction == "PUT" and bool(row["is_bearish"]) and body_r >= ENTRY_CONFLUENCE_CANDLE_BODY_MIN:
        score += 1

    # 2. MACD momentum
    if direction == "CALL" and macd_l > macd_s and macd_l > prev_macd_l:
        score += 1
    elif direction == "PUT" and macd_l < macd_s and macd_l < prev_macd_l:
        score += 1

    # 3. Volume
    if not vol_unavail and vol_r >= ENTRY_CONFLUENCE_VOLUME_RATIO_MIN:
        score += 1

    # 4. Price structure (simplified: bullish/bearish engulfing, hammer, shooting star)
    c_open  = float(row["open"])
    c_close = float(row["close"])
    p_open  = float(row["prev_open"])
    p_close = float(row["prev_close"])
    c_range = c_high - c_low
    c_body  = abs(c_close - c_open)
    lower_wick = min(c_open, c_close) - c_low
    upper_wick = c_high - max(c_open, c_close)

    ps_bull = False
    ps_bear = False
    if c_range > 0:
        if (c_close > c_open and p_close < p_open
                and c_open <= p_close and c_close >= p_open):
            ps_bull = True
        elif (c_close < c_open and p_close > p_open
                and c_open >= p_close and c_close <= p_open):
            ps_bear = True
        elif (lower_wick >= c_range * 0.55 and upper_wick <= c_range * 0.15
                and c_body / c_range <= 0.35):
            ps_bull = True
        elif (upper_wick >= c_range * 0.55 and lower_wick <= c_range * 0.15
                and c_body / c_range <= 0.35):
            ps_bear = True

    if direction == "CALL" and ps_bull:
        score += 1
    elif direction == "PUT" and ps_bear:
        score += 1

    return score, []


# ══════════════════════════════════════════════════════════════════════════════
# Main analysis loop
# ══════════════════════════════════════════════════════════════════════════════

def analyze_symbol(sym: str, df: pd.DataFrame) -> list[dict]:
    df = compute_indicators(df)

    analysis_mask = (
        (df["timestamp"] >= window_start_ct.astimezone(UTC)) &
        (df["timestamp"] <  window_end_ct.astimezone(UTC))
    )
    analysis_df = df[analysis_mask].copy().reset_index(drop=True)

    results = []
    for _, row in analysis_df.iterrows():
        ts_ct    = row["timestamp"].astimezone(CT)
        time_str = ts_ct.strftime("%H:%M")

        rsi_v   = row["rsi"]
        ema9_v  = row["ema9"]
        ema21_v = row["ema21"]
        ema55_v = row["ema55"]
        atr_p   = row["atr_pct"]

        # ── Prompt 4-condition gate ──────────────────────────────────────────
        vol_spike    = bool(row["cond_vol_spike"])
        not_choppy   = bool(row["cond_not_choppy"])
        trend_5bar   = bool(row["cond_trend_5bar"])
        bb_expanding = bool(row["cond_bb_expanding"])
        prompt_ok    = vol_spike and not_choppy and trend_5bar and bb_expanding

        # ── Real system pipeline ─────────────────────────────────────────────
        real_blocks:  list[str] = []
        real_approved = False
        setup_fired: str | None = None
        conf_score: int | None  = None
        conf_vetoes: list[str]  = []
        regime = "?"

        if pd.isna(rsi_v) or pd.isna(row["rsi_ma"]):
            real_blocks.append("WARMUP")
        else:
            regime = classify_regime_row(row)

            if regime == "CHOP":
                bull_p  = bool(row["ema_bull_persist"])
                bear_p  = bool(row["ema_bear_persist"])
                above_v = row["close"] > row["vwap"] if pd.notna(row["vwap"]) else None
                chop_detail = (
                    f"9>21={'Y' if ema9_v > ema21_v else 'N'},"
                    f"21>55={'Y' if ema21_v > ema55_v else 'N'},"
                    f"PERSIST={'Y' if (bull_p or bear_p) else 'N'},"
                    f"RSI={rsi_v:.0f},'>"
                    f"50={'Y' if rsi_v > 50 else 'N'},"
                    f"VWAP={'above' if above_v else ('below' if above_v is False else 'N/A')}"
                )
                real_blocks.append(f"CHOP[{chop_detail}]")
            else:
                direction = "CALL" if regime == "BULL" else "PUT"

                if ENTRY_SETUP_A_ENABLED and check_setup_a(row, direction):
                    setup_fired = "A_PULLBACK"
                elif ENTRY_SETUP_B_ENABLED and check_setup_b(row, direction):
                    setup_fired = "B_BB_BREAK"
                elif ENTRY_SETUP_C_ENABLED and check_setup_c(row, direction):
                    setup_fired = "C_RSI_MOM"

                if setup_fired is None:
                    real_blocks.append(f"NO_SETUP({direction})")
                else:
                    conf_score, conf_vetoes = confluence_score(row, direction)
                    if conf_vetoes:
                        real_blocks.append(f"VETOED({','.join(conf_vetoes)})")
                    elif conf_score < ENTRY_CONFLUENCE_MIN_SCORE:
                        real_blocks.append(f"CONF_LOW({conf_score}/4)")
                    else:
                        real_approved = True

        results.append({
            "time_cdt":     time_str,
            "symbol":       sym,
            "close":        round(float(row["close"]), 2),
            "rsi":          f"{rsi_v:.1f}" if pd.notna(rsi_v) else "NaN",
            "atr%":         f"{float(atr_p):.3f}" if pd.notna(atr_p) else "NaN",
            "vol_ratio":    f"{float(row['vol_ratio']):.2f}" if pd.notna(row["vol_ratio"]) else "NaN",
            "regime":       regime,
            "setup":        setup_fired or "-",
            "conf":         f"{conf_score}/4" if conf_score is not None else "-",
            "vol_spk":      "Y" if vol_spike    else "N",
            "not_chop":     "Y" if not_choppy   else "N",
            "trend5":       "Y" if trend_5bar   else "N",
            "bb_exp":       "Y" if bb_expanding else "N",
            "prompt":       "SIG" if prompt_ok else "BLK",
            "real":         "SIG" if real_approved else "BLK",
            "block_reason": " | ".join(real_blocks) if real_blocks else "APPROVED",
        })

    return results


# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — Print results
# ══════════════════════════════════════════════════════════════════════════════

all_rows: list[dict] = []
analyzed_bars = 0

for sym, df in all_data.items():
    sym_rows = analyze_symbol(sym, df)
    all_rows.extend(sym_rows)
    analyzed_bars += len(sym_rows)

if not all_rows:
    print("No bars analyzed — check data fetch errors above.")
    sys.exit(1)

# ── 4b — Bar-by-bar table (real pipeline) ─────────────────────────────────────
print("=" * 72)
print("STEP 4b — BAR-BY-BAR  (Real Cape 3-tier pipeline)")
print("Cols: time | sym | close | rsi | atr% | vol_ratio | regime | setup | conf | real | block_reason")
print("=" * 72)

real_cols = [
    "time_cdt", "symbol", "close", "rsi", "atr%",
    "vol_ratio", "regime", "setup", "conf", "real", "block_reason",
]
real_rows_print = [{k: r[k] for k in real_cols} for r in all_rows]

if HAS_TABULATE:
    print(tabulate(real_rows_print, headers="keys", tablefmt="grid",
                   maxcolwidths=[None]*10 + [60]))
else:
    hdr = "  ".join(f"{k:>10}" for k in real_cols[:-1]) + "  block_reason"
    print(hdr)
    print("-" * len(hdr))
    for r in real_rows_print:
        line = "  ".join(f"{str(r[k]):>10}" for k in real_cols[:-1])
        print(f"{line}  {r['block_reason'][:55]}")

print()

# ── 4b-alt — Prompt 4-condition gate ─────────────────────────────────────────
print("=" * 72)
print("STEP 4b-alt — Prompt 4-condition gate (vol_spike / not_choppy / trend_5bar / bb_expanding)")
print("=" * 72)

prompt_cols = ["time_cdt", "symbol", "close", "vol_spk", "not_chop", "trend5", "bb_exp", "prompt"]
prompt_rows_print = [{k: r[k] for k in prompt_cols} for r in all_rows]

if HAS_TABULATE:
    print(tabulate(prompt_rows_print, headers="keys", tablefmt="grid"))
else:
    hdr = "  ".join(f"{k:>10}" for k in prompt_cols)
    print(hdr)
    print("-" * len(hdr))
    for r in prompt_rows_print:
        print("  ".join(f"{str(r[k]):>10}" for k in prompt_cols))

print()

# ── 4c — Summary diagnosis ────────────────────────────────────────────────────
print("=" * 72)
print("STEP 4c — SUMMARY DIAGNOSIS")
print("=" * 72)

total_signals = sum(1 for r in all_rows if r["real"] == "SIG")
total_bars    = len(all_rows)

print(f"Total bars analyzed: {total_bars} across {len(all_data)} symbol(s)")
print(f"Bars with SIGNAL approved by real pipeline: {total_signals}")
print()

if total_signals == 0:
    print("No trade was taken in this window because:")
else:
    print(f"WARNING: {total_signals} bars passed — investigate why no order was placed.")

# Count primary blocks per symbol
for sym in SYMBOLS:
    sym_rows = [r for r in all_rows if r["symbol"] == sym]
    if not sym_rows:
        continue
    n = len(sym_rows)
    block_tally: dict[str, int] = {}
    for r in sym_rows:
        if r["real"] == "BLK":
            raw = r["block_reason"]
            # Extract primary key before "["
            primary = raw.split("[")[0].strip().split("(")[0].strip().split("|")[0].strip()
            block_tally[primary] = block_tally.get(primary, 0) + 1

    print(f"  {sym} ({n} bars):")
    for reason, cnt in sorted(block_tally.items(), key=lambda x: -x[1]):
        print(f"    - {reason}: {cnt}/{n} bars")

    # Prompt-gate breakdown
    conds = ["vol_spk", "not_chop", "trend5", "bb_exp"]
    cond_fail = {c: sum(1 for r in sym_rows if r[c] == "N") for c in conds}
    print(f"\n    Prompt 4-condition fail counts for {sym}:")
    for c, fc in sorted(cond_fail.items(), key=lambda x: -x[1]):
        lbl = {"vol_spk":"vol_spike(vol>2x avg)","not_chop":"not_choppy(ATR%>=0.30)",
               "trend5":"trend_5bar(EMA9>21 for 5 bars)","bb_exp":"bb_expanding(BBW>2x avg)"}[c]
        print(f"      {lbl}: {fc}/{n} bars failed")
    print()

# ── 4d — Market character ─────────────────────────────────────────────────────
print("=" * 72)
print("STEP 4d — MARKET CHARACTER (12:30–1:30 PM CDT)")
print("=" * 72)

for sym in SYMBOLS:
    sym_rows = [r for r in all_rows if r["symbol"] == sym]
    if not sym_rows:
        continue

    n         = len(sym_rows)
    regimes   = [r["regime"] for r in sym_rows]
    chop_n    = regimes.count("CHOP")
    bull_n    = regimes.count("BULL")
    bear_n    = regimes.count("BEAR")
    choppy_n  = sum(1 for r in sym_rows if r["not_chop"] == "N")
    low_vol_n = sum(1 for r in sym_rows if r["vol_spk"] == "N")
    flat_bb_n = sum(1 for r in sym_rows if r["bb_exp"] == "N")
    no_trend  = sum(1 for r in sym_rows if r["trend5"] == "N")

    # Near-signal: real pipeline failed by exactly ONE tier
    near_signals = []
    for r in sym_rows:
        if r["real"] == "SIG":
            continue
        raw = r["block_reason"]
        # If regime OK, setup OK but confluence failed → near signal
        if raw.startswith("CONF_LOW") or raw.startswith("VETOED"):
            near_signals.append((r["time_cdt"], sym, raw[:40]))
        # Also check prompt near-signals
        prompt_fails = [c for c in ["vol_spk","not_chop","trend5","bb_exp"] if r[c] == "N"]
        if len(prompt_fails) == 1:
            near_signals.append((r["time_cdt"], sym, f"prompt:only {prompt_fails[0]} failed"))

    print(f"\n  {sym} — {n} bars:")
    print(f"  - Regime: CHOP={chop_n}, BULL={bull_n}, BEAR={bear_n}")
    dom = max(["CHOP","BULL","BEAR"], key=lambda x: regimes.count(x))
    if dom == "CHOP":
        print(f"  - Market was CHOPPY — EMA9/21/55 not cleanly stacked "
              f"or VWAP/RSI misaligned for {chop_n}/{n} bars")
    elif dom == "BULL":
        print(f"  - Market trended BULL for {bull_n}/{n} bars "
              f"but trigger setups (A/B/C) did not fire or confluence too weak")
    else:
        print(f"  - Market trended BEAR for {bear_n}/{n} bars "
              f"but trigger setups (A/B/C) did not fire or confluence too weak")
    print(f"  - ATR% below 0.30 (choppy/low-volatility): {choppy_n}/{n} bars")
    print(f"  - Volume below 2× avg (no spike / lunch lull): {low_vol_n}/{n} bars")
    print(f"  - BB not expanding (range compressing): {flat_bb_n}/{n} bars")
    print(f"  - EMA9 not persistently above EMA21 for 5 bars: {no_trend}/{n} bars")

    if near_signals:
        print(f"  - Closest near-signal bars (one tier away from SIGNAL):")
        shown = set()
        for t, s, detail in near_signals[:8]:
            key = f"{t}-{detail}"
            if key not in shown:
                print(f"      {t} CDT: {detail}")
                shown.add(key)
    else:
        print(f"  - No bar came close — multiple tiers failed on every bar")

print()
print("=" * 72)
print(f"Analyzed {analyzed_bars} bars across {len(all_data)} symbols | Errors: {error_count}")
print("=" * 72)
