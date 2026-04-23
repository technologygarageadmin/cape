def detect(rsi_result, current_price=None):
    """Return (call_triggers, put_triggers) for MACD_CROSSOVER."""
    call = []
    put = []

    if bool(rsi_result.get("macd_cross_up", False)):
        call.append("MACD_CROSSOVER")
    if bool(rsi_result.get("macd_cross_down", False)):
        put.append("MACD_CROSSOVER")

    return call, put
