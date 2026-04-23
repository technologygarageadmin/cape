from datetime import datetime, timedelta, timezone
from collections import deque
import threading
import time
from zoneinfo import ZoneInfo
import pandas as pd

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.live.stock import StockDataStream
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame

from config import (
	API_KEY,
	EMA_FAST_PERIOD,
	EMA_SLOW_PERIOD,
	EMA_THIRD_PERIOD,
	PRICE_POLL_SEC,
	RSI_MA_PERIOD,
	RSI_PERIOD,
	SECRET_KEY,
	STOCK_DATA_FEED,
	SYMBOL,
)


LOOKBACK_BARS = 500
MIN_STRONG_STREAK = 3
POLL_INTERVAL_SEC = PRICE_POLL_SEC
FIRST_BAR_TIMEOUT_SEC = 75
WS_RETRY_SEC = 30
POLLING_CYCLES_BEFORE_WS_RETRY = 8
MAX_BAR_AGE_MINUTES = 3
DISPLAY_TZ = ZoneInfo("America/Chicago")


def get_stream_feed():
	"""Return websocket feed in SDK-expected type across versions."""
	try:
		from alpaca.data.enums import DataFeed

		if isinstance(STOCK_DATA_FEED, str):
			name = STOCK_DATA_FEED.strip().lower()
			if name == "iex":
				return DataFeed.IEX
			if name == "sip":
				return DataFeed.SIP
			if name == "otc":
				return DataFeed.OTC
		return STOCK_DATA_FEED
	except Exception:
		# Older/newer SDK variants may accept plain string feed.
		return STOCK_DATA_FEED


def extract_bar_timestamp(bar) -> datetime | None:
	ts = getattr(bar, "timestamp", None)
	if ts is None:
		ts = getattr(bar, "t", None)
	if ts is None:
		return None
	if ts.tzinfo is None:
		return ts.replace(tzinfo=timezone.utc)
	return ts.astimezone(timezone.utc)


def fetch_recent_ohlc(symbol: str, lookback_bars: int) -> tuple[pd.DataFrame, datetime | None, datetime | None]:
	client = StockHistoricalDataClient(API_KEY, SECRET_KEY)
	now_utc = datetime.now(timezone.utc)
	start_utc = now_utc - timedelta(days=10)

	try:
		from alpaca.data.enums import Sort
		sort_desc = Sort.DESC
	except Exception:
		sort_desc = "desc"

	try:
		request = StockBarsRequest(
			symbol_or_symbols=[symbol],
			timeframe=TimeFrame.Minute,
			start=start_utc,
			end=now_utc,
			limit=lookback_bars,
			sort=sort_desc,
			feed=STOCK_DATA_FEED,
		)
	except TypeError:
		try:
			request = StockBarsRequest(
				symbol_or_symbols=[symbol],
				timeframe=TimeFrame.Minute,
				start=start_utc,
				end=now_utc,
				limit=lookback_bars,
				sort=sort_desc,
			)
		except TypeError:
			request = StockBarsRequest(
				symbol_or_symbols=[symbol],
				timeframe=TimeFrame.Minute,
				start=start_utc,
				end=now_utc,
				limit=lookback_bars,
			)

	response = client.get_stock_bars(request)

	bars = []
	try:
		bars = response[symbol]
	except Exception:
		if hasattr(response, "get"):
			bars = response.get(symbol) or []
		elif hasattr(response, "data") and isinstance(response.data, dict):
			bars = response.data.get(symbol) or []

	if len(bars) >= 2:
		first_ts = extract_bar_timestamp(bars[0])
		last_ts = extract_bar_timestamp(bars[-1])
		if first_ts and last_ts and first_ts > last_ts:
			bars = list(reversed(bars))

	if len(bars) < RSI_PERIOD + 2:
		raise RuntimeError(
			f"Not enough bars for RSI. Need at least {RSI_PERIOD + 2}, got {len(bars)}."
		)

	df = pd.DataFrame(
		{
			"open": [float(bar.open) for bar in bars],
			"high": [float(bar.high) for bar in bars],
			"low": [float(bar.low) for bar in bars],
			"close": [float(bar.close) for bar in bars],
			"volume": [int(getattr(bar, "volume", 0) or 0) for bar in bars],
			"timestamp": [extract_bar_timestamp(bar) for bar in bars],
		}
	)
	last_bar_time = extract_bar_timestamp(bars[-1]) if bars else None
	prev_bar_time = extract_bar_timestamp(bars[-2]) if len(bars) >= 2 else None
	return df, last_bar_time, prev_bar_time


def fetch_recent_closes(symbol: str, lookback_bars: int) -> tuple[list[float], datetime | None, datetime | None]:
	df, last_bar_time, prev_bar_time = fetch_recent_ohlc(symbol, lookback_bars)
	closes = df["close"].astype("float64").tolist()
	return closes, last_bar_time, prev_bar_time


# def calculate_rsi_series(closes: list[float], period: int = RSI_PERIOD) -> list[float]:
# 	deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
# 	gains = [max(delta, 0.0) for delta in deltas]
# 	losses = [max(-delta, 0.0) for delta in deltas]

# 	avg_gain = sum(gains[:period]) / period
# 	avg_loss = sum(losses[:period]) / period

# 	rsi_values = []
# 	first_rsi = 100.0 if avg_loss == 0 else 100 - (100 / (1 + (avg_gain / avg_loss)))
# 	rsi_values.append(first_rsi)

# 	for i in range(period, len(deltas)):
# 		avg_gain = ((avg_gain * (period - 1)) + gains[i]) / period
# 		avg_loss = ((avg_loss * (period - 1)) + losses[i]) / period
# 		rsi = 100.0 if avg_loss == 0 else 100 - (100 / (1 + (avg_gain / avg_loss)))
# 		rsi_values.append(rsi)

# 	return rsi_values

def calculate_rsi(close_prices, period: int = 14):
	delta = close_prices.diff()
	gain = delta.where(delta > 0, 0.0)
	loss = (-delta).where(delta < 0, 0.0)
	avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
	avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
	rs = avg_gain / avg_loss
	return 100 - (100 / (1 + rs))


def calculate_rsi_ma(rsi, period: int = 9):
	return rsi.rolling(window=period).mean()


def calculate_rsi_series(closes: list[float], period: int = 14) -> list[float]:
	if len(closes) <= period:
		return []

	close_series = pd.Series(closes, dtype="float64")
	rsi_series = calculate_rsi(close_series, period=period)
	return rsi_series.dropna().tolist()


def calculate_sma_series(values: list[float], period: int) -> list[float]:
	if period <= 0 or len(values) < period:
		return []

	running_sum = sum(values[:period])
	sma_values = [running_sum / period]

	for i in range(period, len(values)):
		running_sum += values[i] - values[i - period]
		sma_values.append(running_sum / period)

	return sma_values



def streak_length(values: list[float], direction: str) -> int:
	if len(values) < 2:
		return 0

	streak = 0
	for i in range(len(values) - 1, 0, -1):
		if direction == "up" and values[i] > values[i - 1]:
			streak += 1
		elif direction == "down" and values[i] < values[i - 1]:
			streak += 1
		else:
			break
	return streak


def classify_rsi_trend(rsi_values: list[float]) -> dict:
	if len(rsi_values) < 2:
		raise RuntimeError("Not enough RSI values to classify trend.")

	rsi_ma_values = calculate_sma_series(rsi_values, RSI_MA_PERIOD)
	rsi_ma_ready = len(rsi_ma_values) >= 2

	latest = rsi_values[-1]
	prev = rsi_values[-2]
	delta = latest - prev
	if rsi_ma_ready:
		latest_rsi_ma = rsi_ma_values[-1]
		prev_rsi_ma = rsi_ma_values[-2]
		prev_rsi_above = bool(prev > prev_rsi_ma)
		current_rsi_above = bool(latest > latest_rsi_ma)
		rsi_ma_cross_up = (not prev_rsi_above) and current_rsi_above
		rsi_ma_cross_down = prev_rsi_above and (not current_rsi_above)
		# Also check the bar before (T-2 vs T-1) — catches cases where cross fires
		# one bar before trend confirms (e.g. CrossDown on UPTREND bar).
		if len(rsi_values) >= 3 and len(rsi_ma_values) >= 3:
			rsi_t2 = rsi_values[-3]
			rsi_ma_t2 = rsi_ma_values[-3]
			prev_bar_rsi_above = bool(rsi_t2 > rsi_ma_t2)
			prev_cross_up = (not prev_bar_rsi_above) and prev_rsi_above
			prev_cross_down = prev_bar_rsi_above and (not prev_rsi_above)
		else:
			prev_cross_up = False
			prev_cross_down = False
	else:
		latest_rsi_ma = latest
		prev_rsi_ma = prev
		rsi_ma_cross_up = False
		rsi_ma_cross_down = False
		prev_cross_up = False
		prev_cross_down = False

	if latest > 50:
		base_trend = "UPTREND"
		move_direction = "up"
	elif latest < 50:
		base_trend = "DOWNTREND"
		move_direction = "down"
	else:
		base_trend = "NEUTRAL"
		move_direction = "flat"

	up_streak = streak_length(rsi_values[-10:], "up")
	down_streak = streak_length(rsi_values[-10:], "down")

	strong = False
	strength_reason = ""

	if base_trend == "DOWNTREND":
		strong = (latest <= 40 and down_streak >= MIN_STRONG_STREAK) or (down_streak >= 5)
		if strong:
			strength_reason = "RSI below 50 and continuing to fall"
	elif base_trend == "UPTREND":
		strong = (latest >= 60 and up_streak >= MIN_STRONG_STREAK) or (up_streak >= 5)
		if strong:
			strength_reason = "RSI above 50 and continuing to rise"

	extras = []
	if latest >= 70:
		extras.append("OVERBOUGHT zone (>=70)")
	elif latest <= 30:
		extras.append("OVERSOLD zone (<=30)")

	if delta > 1.5:
		extras.append("Rising momentum (RSI accelerating up)")
	elif delta < -1.5:
		extras.append("Falling momentum (RSI accelerating down)")

	if not rsi_ma_ready:
		needed = max(0, (RSI_MA_PERIOD + 1) - len(rsi_values))
		extras.append(
			f"RSI MA crossover warming up ({needed} RSI values needed for crossover checks)"
		)

	return {
		"latest_rsi": latest,
		"previous_rsi": prev,
		"delta": delta,
		"latest_rsi_ma": latest_rsi_ma,
		"previous_rsi_ma": prev_rsi_ma,
		"rsi_ma_period": RSI_MA_PERIOD,
		"rsi_ma_ready": rsi_ma_ready,
		"rsi_ma_cross_up": rsi_ma_cross_up,
		"rsi_ma_cross_down": rsi_ma_cross_down,
		"prev_rsi_ma_cross_up": prev_cross_up,
		"prev_rsi_ma_cross_down": prev_cross_down,
		"base_trend": base_trend,
		"is_strong": strong,
		"strength_reason": strength_reason,
		"up_streak": up_streak,
		"down_streak": down_streak,
		"extras": extras,
		"move_direction": move_direction,
	}


def analyze_rsi(symbol: str = SYMBOL) -> dict:
	df, last_bar_time, prev_bar_time = fetch_recent_ohlc(symbol, LOOKBACK_BARS)
	if last_bar_time and (datetime.now(timezone.utc) - last_bar_time) > timedelta(minutes=MAX_BAR_AGE_MINUTES):
		raise RuntimeError(
			f"Latest bar is stale by more than {MAX_BAR_AGE_MINUTES} minutes. "
			f"Last bar: {last_bar_time.isoformat()}"
		)
	closes = df["close"].astype("float64")

	rsi_values = calculate_rsi_series(closes, RSI_PERIOD)
	result = classify_rsi_trend(rsi_values)
	rsi_mr_values = calculate_rsi_series(closes, 3)
	if len(rsi_mr_values) >= 2:
		result["rsi_mr_period"] = 3
		result["rsi_mr_oversold"] = 40.0
		result["rsi_mr_overbought"] = 70.0
		result["latest_rsi_mr"] = float(rsi_mr_values[-1])
		result["previous_rsi_mr"] = float(rsi_mr_values[-2])
		result["rsi_mr_cross_up"] = bool(rsi_mr_values[-2] <= 40.0 and rsi_mr_values[-1] > 40.0)
		result["rsi_mr_cross_down"] = bool(rsi_mr_values[-2] >= 70.0 and rsi_mr_values[-1] < 70.0)
	result["close_price"] = float(closes.iloc[-1])
	result["alpaca_bar_time_utc"] = last_bar_time
	result["alpaca_bar_time_cst"] = last_bar_time.astimezone(DISPLAY_TZ) if last_bar_time else None
	result["alpaca_prev_bar_time_utc"] = prev_bar_time
	result["alpaca_prev_bar_time_cst"] = prev_bar_time.astimezone(DISPLAY_TZ) if prev_bar_time else None

	# ── EMA crossover data ──
	ema_fast = closes.ewm(span=EMA_FAST_PERIOD, adjust=False).mean()
	ema_slow = closes.ewm(span=EMA_SLOW_PERIOD, adjust=False).mean()
	ema_third = closes.ewm(span=EMA_THIRD_PERIOD, adjust=False).mean()

	result["ema_fast"] = float(ema_fast.iloc[-1])
	result["ema_slow"] = float(ema_slow.iloc[-1])
	result["ema_third"] = float(ema_third.iloc[-1])
	result["prev_ema_fast"] = float(ema_fast.iloc[-2]) if len(ema_fast) >= 2 else float(ema_fast.iloc[-1])
	result["prev_ema_slow"] = float(ema_slow.iloc[-2]) if len(ema_slow) >= 2 else float(ema_slow.iloc[-1])

	# EMA crossover detection
	curr_fast_above = float(ema_fast.iloc[-1]) > float(ema_slow.iloc[-1])
	prev_fast_above = float(ema_fast.iloc[-2]) > float(ema_slow.iloc[-2]) if len(ema_fast) >= 2 else curr_fast_above
	result["ema_cross_up"] = curr_fast_above and not prev_fast_above  # 9 crosses above 21
	result["ema_cross_down"] = (not curr_fast_above) and prev_fast_above  # 9 crosses below 21
	result["ema_fast_above_slow"] = curr_fast_above  # bullish regime
	# EMA triple stack: EMA9 > EMA21 > EMA55 (fully fanned)
	ema_third_val = float(ema_third.iloc[-1])
	result["ema_triple_bull"] = curr_fast_above and float(ema_slow.iloc[-1]) > ema_third_val
	result["ema_triple_bear"] = (not curr_fast_above) and float(ema_slow.iloc[-1]) < ema_third_val

	# Check recent EMA cross (within last 5 bars) — don't require it on THIS exact bar
	ema_bullish_regime = False
	ema_bearish_regime = False
	lookback_ema = min(5, len(ema_fast) - 1)
	for i in range(lookback_ema):
		idx = len(ema_fast) - 1 - i
		if idx < 1:
			break
		cur_above = float(ema_fast.iloc[idx]) > float(ema_slow.iloc[idx])
		prv_above = float(ema_fast.iloc[idx - 1]) > float(ema_slow.iloc[idx - 1])
		if cur_above and not prv_above:
			ema_bullish_regime = True
		if (not cur_above) and prv_above:
			ema_bearish_regime = True
	# Also count current state as regime if already crossed earlier
	if curr_fast_above:
		ema_bullish_regime = True
	if not curr_fast_above:
		ema_bearish_regime = True
	result["ema_bullish_regime"] = ema_bullish_regime
	result["ema_bearish_regime"] = ema_bearish_regime

	# ── Pullback to 9 EMA check ──
	# Price is near 9 EMA (within tolerance) — not chasing a breakout
	current_close = float(closes.iloc[-1])
	prev_close_val = float(closes.iloc[-2]) if len(closes) >= 2 else current_close
	ema_fast_val = float(ema_fast.iloc[-1])
	pullback_pct = abs(current_close - ema_fast_val) / ema_fast_val * 100 if ema_fast_val > 0 else 999
	result["pullback_to_ema_pct"] = pullback_pct
	result["previous_close"] = prev_close_val
	# For CALL: price pulled back DOWN toward 9 EMA (or touching it)
	# For PUT: price pulled back UP toward 9 EMA (or touching it)
	result["price_near_ema_fast"] = pullback_pct  # caller checks threshold

	# ── MACD (12, 26, 9) ──
	ema_12 = closes.ewm(span=12, adjust=False).mean()
	ema_26 = closes.ewm(span=26, adjust=False).mean()
	macd_line = ema_12 - ema_26
	macd_signal = macd_line.ewm(span=9, adjust=False).mean()
	macd_hist = macd_line - macd_signal

	macd_now = float(macd_line.iloc[-1])
	macd_prev = float(macd_line.iloc[-2]) if len(macd_line) >= 2 else macd_now
	sig_now = float(macd_signal.iloc[-1])
	sig_prev = float(macd_signal.iloc[-2]) if len(macd_signal) >= 2 else sig_now

	result["macd_line"] = round(macd_now, 6)
	result["macd_signal"] = round(sig_now, 6)
	result["macd_hist"] = round(float(macd_hist.iloc[-1]), 6)
	result["prev_macd_line"] = round(macd_prev, 6)
	result["prev_macd_signal"] = round(sig_prev, 6)
	result["macd_cross_up"] = (macd_prev <= sig_prev) and (macd_now > sig_now)
	result["macd_cross_down"] = (macd_prev >= sig_prev) and (macd_now < sig_now)

	# ── Bollinger Bands (20, 2) ──
	bb_basis = closes.rolling(window=20).mean()
	bb_std = closes.rolling(window=20).std(ddof=0)
	bb_upper = bb_basis + (2.0 * bb_std)
	bb_lower = bb_basis - (2.0 * bb_std)

	bb_upper_now = float(bb_upper.iloc[-1]) if pd.notna(bb_upper.iloc[-1]) else current_close
	bb_lower_now = float(bb_lower.iloc[-1]) if pd.notna(bb_lower.iloc[-1]) else current_close
	bb_basis_now = float(bb_basis.iloc[-1]) if pd.notna(bb_basis.iloc[-1]) else current_close

	if len(bb_upper) >= 2 and pd.notna(bb_upper.iloc[-2]) and pd.notna(bb_lower.iloc[-2]):
		bb_upper_prev = float(bb_upper.iloc[-2])
		bb_lower_prev = float(bb_lower.iloc[-2])
	else:
		bb_upper_prev = bb_upper_now
		bb_lower_prev = bb_lower_now

	result["bb_upper"] = round(bb_upper_now, 4)
	result["bb_basis"] = round(bb_basis_now, 4)
	result["bb_lower"] = round(bb_lower_now, 4)
	result["prev_bb_upper"] = round(bb_upper_prev, 4)
	result["prev_bb_lower"] = round(bb_lower_prev, 4)

	# ── Candle analysis ──
	curr_open = float(df["open"].iloc[-1])
	curr_high = float(df["high"].iloc[-1])
	curr_low = float(df["low"].iloc[-1])
	curr_close_val = float(df["close"].iloc[-1])
	prev_high = float(df["high"].iloc[-2]) if len(df) >= 2 else curr_high
	prev_low = float(df["low"].iloc[-2]) if len(df) >= 2 else curr_low

	candle_range = curr_high - curr_low
	candle_body = abs(curr_close_val - curr_open)
	body_ratio = candle_body / candle_range if candle_range > 0 else 0

	result["candle_open"] = curr_open
	result["candle_high"] = curr_high
	result["candle_low"] = curr_low
	result["candle_close"] = curr_close_val
	result["prev_candle_high"] = prev_high
	result["prev_candle_low"] = prev_low
	result["candle_body_ratio"] = body_ratio
	result["candle_is_bullish"] = curr_close_val > curr_open
	result["candle_is_bearish"] = curr_close_val < curr_open
	result["candle_breaks_prev_high"] = curr_high > prev_high
	result["candle_breaks_prev_low"] = curr_low < prev_low

	# ── Price structure / candle pattern detection ──
	# Classifies the current candle against the previous to identify high-quality entry patterns.
	# result["price_structure"]         = pattern name string or "NONE"
	# result["price_structure_bullish"] = True for patterns that confirm a CALL entry
	# result["price_structure_bearish"] = True for patterns that confirm a PUT entry
	# result["price_structure_neutral"] = True for consolidation / inside bar (blocks entry)
	prev_open  = float(df["open"].iloc[-2])  if len(df) >= 2 else curr_open
	prev_close = float(df["close"].iloc[-2]) if len(df) >= 2 else curr_close_val
	upper_wick = curr_high - max(curr_open, curr_close_val)
	lower_wick = min(curr_open, curr_close_val) - curr_low
	wick_threshold = candle_range * 0.6  # wick must be ≥ 60% of candle range

	ps_bullish = False
	ps_bearish = False
	ps_neutral = False
	ps_name    = "NONE"

	if candle_range > 0:
		# Inside bar — consolidation, no directional edge (blocks both CALL and PUT)
		if curr_high < prev_high and curr_low > prev_low:
			ps_name    = "INSIDE_BAR"
			ps_neutral = True

		# Bullish engulfing — curr green fully wraps prev red
		elif (curr_close_val > curr_open
				and prev_close < prev_open
				and curr_open  <= prev_close
				and curr_close_val >= prev_open):
			ps_name    = "BULLISH_ENGULFING"
			ps_bullish = True

		# Bearish engulfing — curr red fully wraps prev green
		elif (curr_close_val < curr_open
				and prev_close > prev_open
				and curr_open  >= prev_close
				and curr_close_val <= prev_open):
			ps_name    = "BEARISH_ENGULFING"
			ps_bearish = True

		# Hammer — long lower wick (≥55% range), tiny upper wick (≤15%), small body (≤35%)
		elif (lower_wick >= candle_range * 0.55
				and upper_wick <= candle_range * 0.15
				and candle_body / candle_range <= 0.35):
			ps_name    = "HAMMER"
			ps_bullish = True

		# Shooting star — long upper wick (≥55% range), tiny lower wick (≤15%), small body (≤35%)
		elif (upper_wick >= candle_range * 0.55
				and lower_wick <= candle_range * 0.15
				and candle_body / candle_range <= 0.35):
			ps_name    = "SHOOTING_STAR"
			ps_bearish = True

		# Bullish pin bar — lower wick ≥60% of range and dominates upper wick
		elif lower_wick >= wick_threshold and lower_wick > upper_wick * 2:
			ps_name    = "BULLISH_PIN_BAR"
			ps_bullish = True

		# Bearish pin bar — upper wick ≥60% of range and dominates lower wick
		elif upper_wick >= wick_threshold and upper_wick > lower_wick * 2:
			ps_name    = "BEARISH_PIN_BAR"
			ps_bearish = True

	result["price_structure"]         = ps_name
	result["price_structure_bullish"] = ps_bullish
	result["price_structure_bearish"] = ps_bearish
	result["price_structure_neutral"] = ps_neutral

	# ── Volume analysis ──
	# Alpaca IEX feed frequently returns 0 for in-progress or recently closed bars.
	# When the current bar volume is 0, treat as unavailable so the volume filter
	# doesn't silently block trades due to missing data.
	volumes = df["volume"].astype("int64")
	curr_volume = int(volumes.iloc[-1])
	vol_ma_period = min(20, len(volumes) - 1)
	# Detect missing volume: current bar is 0 AND avg of recent bars is also near 0
	recent_nonzero = int((volumes.iloc[-min(5, len(volumes)):] > 0).sum())
	volume_unavailable = curr_volume == 0 and recent_nonzero == 0
	if volume_unavailable:
		# Use last known non-zero volume bars for avg; ratio = unknown
		nonzero_vols = volumes[volumes > 0]
		avg_volume = float(nonzero_vols.iloc[-20:].mean()) if len(nonzero_vols) > 0 else 0.0
		volume_ratio = 0.0  # unknown — filter will be skipped
	elif vol_ma_period > 0:
		avg_volume = float(volumes.iloc[-vol_ma_period - 1:-1].mean())
		volume_ratio = curr_volume / avg_volume if avg_volume > 0 else 0.0
	else:
		avg_volume = float(curr_volume)
		volume_ratio = 1.0
	result["current_volume"] = curr_volume
	result["avg_volume"] = round(avg_volume, 0)
	result["volume_ratio"] = round(volume_ratio, 2)
	result["volume_unavailable"] = volume_unavailable

	# ── VWAP (Volume Weighted Average Price) ──
	# Computed from today's NY-session bars only
	ny_tz = ZoneInfo("America/New_York")
	today_ny = datetime.now(ny_tz).date()
	timestamps = df["timestamp"]
	today_mask = timestamps.apply(
		lambda ts: ts is not None and ts.astimezone(ny_tz).date() == today_ny
	)
	if today_mask.any():
		today_df = df.loc[today_mask]
		typical_price = (today_df["high"] + today_df["low"] + today_df["close"]) / 3.0
		cum_tp_vol = (typical_price * today_df["volume"]).cumsum()
		cum_vol = today_df["volume"].cumsum()
		vwap_series = cum_tp_vol / cum_vol.replace(0, float("nan"))
		vwap_val = float(vwap_series.iloc[-1]) if not vwap_series.empty else None
	else:
		vwap_val = None

	result["vwap"] = round(vwap_val, 4) if vwap_val is not None else None
	result["price_above_vwap"] = (current_close > vwap_val) if vwap_val is not None else None

	return result


def print_result(symbol: str, result: dict) -> None:
	bar_time_utc = result.get("alpaca_bar_time_utc")
	bar_time_cst = result.get("alpaca_bar_time_cst")
	close_price = result.get("close_price")
	print(f"\nRSI Analyzer for {symbol}")
	if bar_time_utc:
		timestamp_unix = bar_time_utc.timestamp()
		tz_offset_utc = bar_time_utc.strftime('%z')
		tz_offset_cst = bar_time_cst.strftime('%z') if bar_time_cst else ""
		print("Alpaca bar time:")
		print(f"  UTC:       {bar_time_utc.strftime('%Y-%m-%d %H:%M:%S %Z')} (offset: {tz_offset_utc})")
		print(f"  Chicago:   {bar_time_cst.strftime('%Y-%m-%d %H:%M:%S %Z')} (offset: {tz_offset_cst})")
		print(f"  Unix:      {timestamp_unix:.0f}")
	else:
		print("Alpaca bar time: N/A")

	if close_price is not None:
		print(f"Close: {close_price:.2f}")

	print(
		f"RSI: {result['latest_rsi']:.2f} "
		f"(prev {result['previous_rsi']:.2f}, delta {result['delta']:+.2f})"
	)
	print(
		f"RSI MA({result['rsi_ma_period']}): {result['latest_rsi_ma']:.2f} "
		f"(prev {result['previous_rsi_ma']:.2f}) | "
		f"Ready={result['rsi_ma_ready']} "
		f"CrossUp={result['rsi_ma_cross_up']} CrossDown={result['rsi_ma_cross_down']}"
	)
	print(f"Trend: {result['base_trend']}")

	if result["is_strong"]:
		print(f"Strength: STRONG ({result['strength_reason']})")
	else:
		print("Strength: NORMAL")

	print(
		f"Streaks -> up: {result['up_streak']}, down: {result['down_streak']} "
		f"(recent RSI direction)"
	)

	if result["extras"]:
		print("Extra signals:")
		for line in result["extras"]:
			print(f"- {line}")


def run_websocket_once(symbol: str = SYMBOL) -> None:
	seed_closes, _, _ = fetch_recent_closes(symbol, LOOKBACK_BARS)
	closes = deque(seed_closes, maxlen=LOOKBACK_BARS)
	first_bar_event = threading.Event()

	print(f"Starting websocket RSI stream for {symbol}...")
	print("Will print on every new 1-minute bar. Press Ctrl+C to stop.")

	try:
		stream = StockDataStream(API_KEY, SECRET_KEY, feed=get_stream_feed())
	except TypeError:
		stream = StockDataStream(API_KEY, SECRET_KEY)

	async def on_bar(bar):
		close_price = float(getattr(bar, "close", 0.0) or 0.0)
		if close_price <= 0:
			return

		closes.append(close_price)
		first_bar_event.set()
		if len(closes) < RSI_PERIOD + 2:
			return

		rsi_values = calculate_rsi_series(list(closes), RSI_PERIOD)
		result = classify_rsi_trend(rsi_values)
		result["close_price"] = close_price
		bar_time = extract_bar_timestamp(bar)
		result["alpaca_bar_time_utc"] = bar_time
		result["alpaca_bar_time_cst"] = bar_time.astimezone(DISPLAY_TZ) if bar_time else None
		print_result(symbol, result)

	try:
		stream.subscribe_bars(on_bar, symbol)
	except AttributeError:
		stream.subscribe_minute_bars(on_bar, symbol)

	thread = threading.Thread(target=stream.run, daemon=True)
	thread.start()

	if not first_bar_event.wait(timeout=FIRST_BAR_TIMEOUT_SEC):
		try:
			stream.stop()
		except Exception:
			pass
		thread.join(timeout=3)
		raise RuntimeError("No bar received from websocket within timeout window")

	while thread.is_alive():
		time.sleep(1)

	raise RuntimeError("Websocket stream disconnected")


def run_polling_loop(symbol: str = SYMBOL, cycles: int = POLLING_CYCLES_BEFORE_WS_RETRY) -> None:
	print(f"Switching to polling mode for {symbol} every {POLL_INTERVAL_SEC}s...")
	print(f"Polling for {cycles} cycles, then retrying websocket.")

	for _ in range(cycles):
		result = analyze_rsi(symbol)
		print_result(symbol, result)
		time.sleep(POLL_INTERVAL_SEC)


def main() -> None:
	in_polling_mode = False

	while True:
		try:
			if in_polling_mode:
				run_polling_loop(SYMBOL)
				in_polling_mode = False
			else:
				run_websocket_once(SYMBOL)
		except KeyboardInterrupt:
			print("\nStopped by user.")
			break
		except Exception as ex:
			message = str(ex).lower()
			if (
				"connection limit exceeded" in message
				or "no bar received from websocket" in message
				or "stale" in message
			):
				print(f"Websocket unavailable: {ex}")
				in_polling_mode = True
				print("Falling back to polling mode.")
				time.sleep(2)
			else:
				print(f"Websocket error: {ex}")
				print(f"Retrying websocket in {WS_RETRY_SEC} seconds...")
				time.sleep(WS_RETRY_SEC)


if __name__ == "__main__":
	main()
