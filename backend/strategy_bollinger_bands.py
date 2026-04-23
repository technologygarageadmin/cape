def detect(rsi_result, current_price=None):
    """Return (call_triggers, put_triggers) for BOLLINGER_BANDS."""
    call = []
    put = []

    prev_close = float(rsi_result.get("previous_close", current_price if current_price is not None else 0))
    bb_lower = float(rsi_result.get("bb_lower", current_price if current_price is not None else 0))
    bb_upper = float(rsi_result.get("bb_upper", current_price if current_price is not None else 0))
    prev_bb_lower = float(rsi_result.get("prev_bb_lower", bb_lower))
    prev_bb_upper = float(rsi_result.get("prev_bb_upper", bb_upper))

    if prev_close < prev_bb_lower and (current_price is None or current_price >= bb_lower):
        call.append("BOLLINGER_BANDS")
    if prev_close > prev_bb_upper and (current_price is None or current_price <= bb_upper):
        put.append("BOLLINGER_BANDS")

    return call, put
