# Output legend:
# - "Market Reversal Analyzer for SPY": symbol currently analyzed.
# - "Alpaca bar time: UTC ... | CST ...": exact bar timestamp from Alpaca data
#   shown in both UTC and Chicago time for verification.
# - "Signal: ...": reversal classification from EMA crossover + context checks.
#   Values can be BULLISH_REVERSAL, BEARISH_REVERSAL,
#   POSSIBLE_BULLISH_REVERSAL, POSSIBLE_BEARISH_REVERSAL, or NO_REVERSAL.
# - "Confidence: ...": strength of the signal.
#   HIGH = crossover with breakout confirmation,
#   MEDIUM = crossover with weaker confirmation,
#   LOW = early momentum shift only.
# - "Reason: ...": short human-readable explanation for why signal was selected.
# - "Close: X (prev Y)": latest close versus previous close.
# - "Trend before: ...": trend context just before the current bar.
# - "EMA 9 / EMA 21 / Spread": fast and slow EMA values.
#   Positive spread means fast EMA above slow EMA; negative means below.
# - "Extra: Price broke above recent swing high": bullish breakout confirmation.
# - "Extra: Price broke below recent swing low": bearish breakout confirmation.

from collections import deque
from datetime import datetime, timedelta, timezone
import threading
import time
from zoneinfo import ZoneInfo

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.live.stock import StockDataStream
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame

from config import API_KEY, PRICE_POLL_SEC, SECRET_KEY, STOCK_DATA_FEED, SYMBOL


LOOKBACK_BARS = 180
TREND_WINDOW = 8
FAST_EMA_PERIOD = 9
SLOW_EMA_PERIOD = 21
POLL_INTERVAL_SEC = PRICE_POLL_SEC
FIRST_BAR_TIMEOUT_SEC = 8
WS_RETRY_SEC = 30
DISPLAY_TZ = ZoneInfo("America/Chicago")


def extract_bar_timestamp(bar) -> datetime | None:
	ts = getattr(bar, "timestamp", None)
	if ts is None:
		ts = getattr(bar, "t", None)
	if ts is None:
		return None
	if ts.tzinfo is None:
		return ts.replace(tzinfo=timezone.utc)
	return ts.astimezone(timezone.utc)


def extract_bars_for_symbol(response, symbol: str):
	try:
		bars = response[symbol]
		if bars is not None:
			return bars
	except Exception:
		pass

	if hasattr(response, "get"):
		try:
			bars = response.get(symbol)
			if bars is not None:
				return bars
		except Exception:
			pass

	data = getattr(response, "data", None)
	if isinstance(data, dict):
		return data.get(symbol) or []

	return []


def fetch_recent_ohlc(symbol: str, lookback_bars: int):
	client = StockHistoricalDataClient(API_KEY, SECRET_KEY)

	end = datetime.now(timezone.utc)
	start = end - timedelta(minutes=lookback_bars * 2)

	try:
		request = StockBarsRequest(
			symbol_or_symbols=[symbol],
			timeframe=TimeFrame.Minute,
			start=start,
			end=end,
			limit=lookback_bars,
			feed=STOCK_DATA_FEED,
		)
	except TypeError:
		request = StockBarsRequest(
			symbol_or_symbols=[symbol],
			timeframe=TimeFrame.Minute,
			start=start,
			end=end,
			limit=lookback_bars,
		)

	response = client.get_stock_bars(request)
	bars = extract_bars_for_symbol(response, symbol)

	closes = [float(b.close) for b in bars]
	highs = [float(b.high) for b in bars]
	lows = [float(b.low) for b in bars]
	timestamps = [extract_bar_timestamp(b) for b in bars]

	if len(closes) < max(SLOW_EMA_PERIOD + 2, TREND_WINDOW + 2):
		raise RuntimeError(
			"Not enough bars for reversal detection. "
			f"Need at least {max(SLOW_EMA_PERIOD + 2, TREND_WINDOW + 2)}, got {len(closes)}."
		)

	return closes, highs, lows, timestamps


def ema(values: list[float], period: int) -> list[float]:
	if not values:
		return []

	alpha = 2.0 / (period + 1)
	result = [values[0]]
	for value in values[1:]:
		result.append((value * alpha) + (result[-1] * (1 - alpha)))
	return result


def classify_reversal(closes: list[float], highs: list[float], lows: list[float]) -> dict:
	fast = ema(closes, FAST_EMA_PERIOD)
	slow = ema(closes, SLOW_EMA_PERIOD)

	if len(fast) < 2 or len(slow) < 2:
		raise RuntimeError("EMA series too short.")

	prev_fast, curr_fast = fast[-2], fast[-1]
	prev_slow, curr_slow = slow[-2], slow[-1]
	prev_close, curr_close = closes[-2], closes[-1]

	bullish_cross = prev_fast <= prev_slow and curr_fast > curr_slow
	bearish_cross = prev_fast >= prev_slow and curr_fast < curr_slow

	recent_high = max(highs[-TREND_WINDOW:-1])
	recent_low = min(lows[-TREND_WINDOW:-1])

	price_breakout_up = curr_close > recent_high
	price_breakout_down = curr_close < recent_low

	trend_before = "SIDEWAYS"
	if closes[-TREND_WINDOW] > closes[-2]:
		trend_before = "DOWNTREND"
	elif closes[-TREND_WINDOW] < closes[-2]:
		trend_before = "UPTREND"

	signal = "NO_REVERSAL"
	confidence = "LOW"
	reason = "No reversal conditions met"

	if bullish_cross and (price_breakout_up or trend_before == "DOWNTREND"):
		signal = "BULLISH_REVERSAL"
		confidence = "HIGH" if price_breakout_up else "MEDIUM"
		reason = "Fast EMA crossed above Slow EMA after weakness"
	elif bearish_cross and (price_breakout_down or trend_before == "UPTREND"):
		signal = "BEARISH_REVERSAL"
		confidence = "HIGH" if price_breakout_down else "MEDIUM"
		reason = "Fast EMA crossed below Slow EMA after strength"
	elif trend_before == "DOWNTREND" and curr_close > prev_close and curr_fast > prev_fast:
		signal = "POSSIBLE_BULLISH_REVERSAL"
		confidence = "LOW"
		reason = "Downtrend losing momentum"
	elif trend_before == "UPTREND" and curr_close < prev_close and curr_fast < prev_fast:
		signal = "POSSIBLE_BEARISH_REVERSAL"
		confidence = "LOW"
		reason = "Uptrend losing momentum"

	return {
		"signal": signal,
		"confidence": confidence,
		"reason": reason,
		"trend_before": trend_before,
		"close": curr_close,
		"prev_close": prev_close,
		"fast_ema": curr_fast,
		"slow_ema": curr_slow,
		"ema_spread": curr_fast - curr_slow,
		"price_breakout_up": price_breakout_up,
		"price_breakout_down": price_breakout_down,
	}


def analyze_reversal(symbol: str = SYMBOL) -> dict:
	closes, highs, lows, timestamps = fetch_recent_ohlc(symbol, LOOKBACK_BARS)
	result = classify_reversal(closes, highs, lows)
	bar_time = timestamps[-1] if timestamps else None
	result["alpaca_bar_time_utc"] = bar_time
	result["alpaca_bar_time_cst"] = bar_time.astimezone(DISPLAY_TZ) if bar_time else None
	return result


def print_result(symbol: str, result: dict) -> None:
	bar_time_utc = result.get("alpaca_bar_time_utc")
	bar_time_cst = result.get("alpaca_bar_time_cst")

	print(f"\nMarket Reversal Analyzer for {symbol}")
	if bar_time_utc:
		print(
			"Alpaca bar time: "
			f"UTC {bar_time_utc.strftime('%Y-%m-%d %H:%M:%S')} | "
			f"CST {bar_time_cst.strftime('%Y-%m-%d %H:%M:%S %Z')}"
		)
	else:
		print("Alpaca bar time: N/A")

	print(f"Signal: {result['signal']} | Confidence: {result['confidence']}")
	print(f"Reason: {result['reason']}")
	print(
		f"Close: {result['close']:.4f} (prev {result['prev_close']:.4f}) | "
		f"Trend before: {result['trend_before']}"
	)
	print(
		f"EMA {FAST_EMA_PERIOD}: {result['fast_ema']:.4f} | "
		f"EMA {SLOW_EMA_PERIOD}: {result['slow_ema']:.4f} | "
		f"Spread: {result['ema_spread']:+.4f}"
	)

	if result["price_breakout_up"]:
		print("Extra: Price broke above recent swing high")
	if result["price_breakout_down"]:
		print("Extra: Price broke below recent swing low")


def run_websocket_once(symbol: str = SYMBOL) -> None:
	seed_closes, seed_highs, seed_lows, _ = fetch_recent_ohlc(symbol, LOOKBACK_BARS)
	closes = deque(seed_closes, maxlen=LOOKBACK_BARS)
	highs = deque(seed_highs, maxlen=LOOKBACK_BARS)
	lows = deque(seed_lows, maxlen=LOOKBACK_BARS)
	first_bar_event = threading.Event()

	print(f"Starting websocket reversal stream for {symbol}...")
	print("Will print on every new 1-minute bar. Press Ctrl+C to stop.")

	stream = StockDataStream(API_KEY, SECRET_KEY)

	async def on_bar(bar):
		close_price = float(getattr(bar, "close", 0.0) or 0.0)
		high_price = float(getattr(bar, "high", 0.0) or 0.0)
		low_price = float(getattr(bar, "low", 0.0) or 0.0)
		if close_price <= 0:
			return

		closes.append(close_price)
		highs.append(high_price if high_price > 0 else close_price)
		lows.append(low_price if low_price > 0 else close_price)
		first_bar_event.set()

		if len(closes) < max(SLOW_EMA_PERIOD + 2, TREND_WINDOW + 2):
			return

		result = classify_reversal(list(closes), list(highs), list(lows))
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


def run_polling_loop(symbol: str = SYMBOL) -> None:
	print(f"Switching to polling mode for {symbol} every {POLL_INTERVAL_SEC}s...")
	print("Polling mode will continue until websocket becomes available again.")

	while True:
		result = analyze_reversal(symbol)
		print_result(symbol, result)
		time.sleep(POLL_INTERVAL_SEC)


def main() -> None:
	in_polling_mode = False

	while True:
		try:
			if in_polling_mode:
				run_polling_loop(SYMBOL)
			else:
				run_websocket_once(SYMBOL)
		except KeyboardInterrupt:
			print("\nStopped by user.")
			break
		except Exception as ex:
			message = str(ex).lower()
			if "connection limit exceeded" in message or "no bar received from websocket" in message:
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
