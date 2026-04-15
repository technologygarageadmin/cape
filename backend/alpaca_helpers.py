from alpaca.data.timeframe import TimeFrame
from alpaca.common.exceptions import APIError
from logger import debug, info

def get_five_min_timeframe():
    if hasattr(TimeFrame, "Minute5"):
        return TimeFrame.Minute5
    try:
        from alpaca.data.timeframe import TimeFrameUnit

        return TimeFrame(5, TimeFrameUnit.Minute)
    except Exception:
        debug("5-minute timeframe not available; falling back to 1-minute timeframe.")
        return TimeFrame.Minute

def handle_api_error(ex, context: str) -> None:
    """Handle Alpaca API errors with clear user guidance."""
    from requests.exceptions import ConnectionError

    if isinstance(ex, ConnectionError):
        info(f"ERROR during {context}: Network connection failed.")
        info("Check your internet connection and Alpaca endpoint availability.")
        raise SystemExit(1)

    msg = str(ex).lower()
    debug(f"API error details: {str(ex)[:200]}")

    if "401" in msg or "unauthorized" in msg or "authorization required" in msg:
        info(f"ERROR during {context}: 401 Unauthorized.")
        info("Check APCA_API_KEY_ID / APCA_API_SECRET_KEY are set correctly.")
        raise SystemExit(1)

    if "403" in msg or "forbidden" in msg or "subscription does not permit" in msg:
        info(f"ERROR during {context}: 403 Forbidden - Market Data Subscription Required.")
        info("Your Alpaca account lacks market data access for SIP/real-time quotes.")
        info("Upgrade your Alpaca subscription at alpaca.markets/docs/api-references/market-data-api")
        raise SystemExit(1)

    raise ex

def build_stock_bars_request(**kwargs):
    from alpaca.data.requests import StockBarsRequest

    try:
        from config import STOCK_DATA_FEED

        return StockBarsRequest(**kwargs, feed=STOCK_DATA_FEED)
    except TypeError:
        return StockBarsRequest(**kwargs)

def build_option_snapshot_request(symbols):
    from alpaca.data.requests import OptionSnapshotRequest

    try:
        return OptionSnapshotRequest(symbol_or_symbols=symbols)
    except TypeError:
        return OptionSnapshotRequest(symbols=symbols)

def extract_bars_for_symbol(response, symbol):
    """Return bars list from BarSet/dict-like response across SDK versions."""
    if response is None:
        return []

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
        bars = data.get(symbol)
        if bars is not None:
            return bars

    keys = []
    if isinstance(data, dict):
        keys = list(data.keys())
    elif isinstance(response, dict):
        keys = list(response.keys())
    debug(f"Bars response missing symbol={symbol}. Available keys={keys}")
    return []

def extract_snapshot_for_symbol(response, symbol):
    """Return a single option snapshot across SDK response variants."""
    if response is None:
        return None

    try:
        snap = response[symbol]
        if snap is not None:
            return snap
    except Exception:
        pass

    if hasattr(response, "get"):
        try:
            snap = response.get(symbol)
            if snap is not None:
                return snap
        except Exception:
            pass

    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data.get(symbol)

    snapshots = getattr(response, "snapshots", None)
    if isinstance(snapshots, dict):
        return snapshots.get(symbol)

    return None

def extract_snapshot_volume(snap):
    """Extract volume from option snapshot across schema versions."""
    if not snap:
        return 0

    day = getattr(snap, "day", None)
    if day:
        vol = getattr(day, "volume", None)
        if vol is not None:
            try:
                return int(vol)
            except Exception:
                return 0

    daily_bar = getattr(snap, "daily_bar", None) or getattr(snap, "dailyBar", None)
    if daily_bar is not None:
        vol = getattr(daily_bar, "volume", None)
        if vol is not None:
            try:
                return int(vol)
            except Exception:
                return 0

    return 0

def extract_snapshot_mid_price(snap):
    """Extract option mid price from snapshot across schema versions."""
    if not snap:
        return 0.0

    quote = getattr(snap, "latest_quote", None) or getattr(snap, "quote", None)
    if not quote:
        return 0.0

    bid = float(getattr(quote, "bid_price", 0) or getattr(quote, "bp", 0) or 0)
    ask = float(getattr(quote, "ask_price", 0) or getattr(quote, "ap", 0) or 0)
    if bid > 0 and ask > 0:
        return (bid + ask) / 2

    return bid or ask or 0.0