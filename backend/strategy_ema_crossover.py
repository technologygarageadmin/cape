def detect(rsi_result, current_price=None):
    """Return (call_triggers, put_triggers) for EMA_CROSSOVER.

    Uses previous and current EMA values so only fresh crossovers produce signals:
      - CALL: previous EMA9 <= EMA21 AND current EMA9 > EMA21
      - PUT : previous EMA9 >= EMA21 AND current EMA9 < EMA21

    Falls back to `ema_cross_up`/`ema_cross_down` flags if numeric values are
    not available in `rsi_result`.
    """
    call = []
    put = []

    try:
        prev_fast = float(rsi_result.get("prev_ema_fast"))
        prev_slow = float(rsi_result.get("prev_ema_slow"))
        curr_fast = float(rsi_result.get("ema_fast"))
        curr_slow = float(rsi_result.get("ema_slow"))
    except Exception:
        # Fallback to existing boolean flags if numeric EMAs aren't present
        if bool(rsi_result.get("ema_cross_up", False)):
            call.append("EMA_CROSSOVER")
        if bool(rsi_result.get("ema_cross_down", False)):
            put.append("EMA_CROSSOVER")
        return call, put

    # CALL: fresh cross up (was <=, now >)
    if prev_fast <= prev_slow and curr_fast > curr_slow:
        call.append("EMA_CROSSOVER")

    # PUT: fresh cross down (was >=, now <)
    if prev_fast >= prev_slow and curr_fast < curr_slow:
        put.append("EMA_CROSSOVER")

    return call, put
