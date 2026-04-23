from config import MIN_RSI_MA_GAP


def detect(rsi_result, current_price=None, cross_up_signal=False, cross_down_signal=False):
    """Return (call_triggers, put_triggers) for RSI_CROSSOVER."""
    call = []
    put = []

    latest_rsi = float(rsi_result.get("latest_rsi", 50))
    latest_rsi_ma = float(rsi_result.get("latest_rsi_ma", 50))
    rsi_gap = abs(latest_rsi - latest_rsi_ma)

    if rsi_gap >= MIN_RSI_MA_GAP:
        if cross_up_signal:
            call.append("RSI_CROSSOVER")
        if cross_down_signal:
            put.append("RSI_CROSSOVER")

    return call, put
