RSI_MR_OVERSOLD = 40.0
RSI_MR_OVERBOUGHT = 70.0


def detect(rsi_result, current_price=None):
    """Return (call_triggers, put_triggers) for RSI_MEAN_REVERSION."""
    call = []
    put = []

    previous_rsi = float(rsi_result.get("previous_rsi_mr", rsi_result.get("previous_rsi", rsi_result.get("latest_rsi", 50))))
    latest_rsi = float(rsi_result.get("latest_rsi_mr", rsi_result.get("latest_rsi", 50)))

    if previous_rsi <= RSI_MR_OVERSOLD and latest_rsi > RSI_MR_OVERSOLD:
        call.append("RSI_MEAN_REVERSION")
    if previous_rsi >= RSI_MR_OVERBOUGHT and latest_rsi < RSI_MR_OVERBOUGHT:
        put.append("RSI_MEAN_REVERSION")

    return call, put
