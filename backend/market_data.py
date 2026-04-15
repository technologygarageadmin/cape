from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from alpaca.data.timeframe import TimeFrame
from alpaca.common.exceptions import APIError
from alpaca.trading.requests import GetOptionContractsRequest

from alpaca_helpers import (
    build_option_snapshot_request,
    build_stock_bars_request,
    extract_bars_for_symbol,
    extract_snapshot_for_symbol,
    extract_snapshot_mid_price,
    extract_snapshot_volume,
    get_five_min_timeframe,
    handle_api_error,
)
from strategy_helpers import market_open_today_utc, timestamp_belongs_to_today_ny
from logger import info
from config import (
    ALLOW_LOW_VOLUME_FALLBACK,
    MIN_OPTION_VOLUME,
    STRIKE_RANGE_PCT,
)


CST = ZoneInfo("America/Chicago")

def fetch_obr(stock_client, symbol):
    market_open = market_open_today_utc()
    five_min_end = market_open + timedelta(minutes=5)
    timeframe = get_five_min_timeframe()

    try:
        response = stock_client.get_stock_bars(
            build_stock_bars_request(
                symbol_or_symbols=[symbol],
                timeframe=timeframe,
                start=market_open,
                end=five_min_end,
                limit=1,
            )
        )

        bars = extract_bars_for_symbol(response, symbol)

    except APIError as ex:
        handle_api_error(ex, "fetching OBR bars")

    if not bars:
        raise RuntimeError("No 5-minute opening bar found yet.")

    opening = bars[0]
    if (
        hasattr(opening, "timestamp")
        and opening.timestamp
        and not timestamp_belongs_to_today_ny(opening.timestamp)
    ):
        raise RuntimeError("Opening bar is stale (not from today's NY session).")

    bartime = (
        opening.timestamp.astimezone(CST).strftime("%H:%M:%S %Z")
        if hasattr(opening, "timestamp") and opening.timestamp
        else "N/A"
    )
    return float(opening.high), float(opening.low), bartime

def fetch_current_price_1m(stock_client, symbol):
    now_utc = datetime.now(timezone.utc)

    try:
        response = stock_client.get_stock_bars(
            build_stock_bars_request(
                symbol_or_symbols=[symbol],
                timeframe=TimeFrame.Minute,
                start=now_utc - timedelta(minutes=5),
                end=now_utc,
                limit=5,
            )
        )

        bars = extract_bars_for_symbol(response, symbol)

    except APIError as ex:
        handle_api_error(ex, "fetching 1-minute bars")

    if not bars:
        raise RuntimeError("No 1-minute bars available yet.")

    bar = bars[-1]
    if hasattr(bar, "timestamp") and bar.timestamp and not timestamp_belongs_to_today_ny(bar.timestamp):
        raise RuntimeError("Latest 1-minute bar is stale (not from today's NY session).")

    bartime = (
        bar.timestamp.astimezone(CST).strftime("%H:%M:%S %Z")
        if hasattr(bar, "timestamp") and bar.timestamp
        else "N/A"
    )
    return float(bar.close), bartime


def get_option_price(option_data_client, contract_symbol):
    snapshots = option_data_client.get_option_snapshot(
        build_option_snapshot_request([contract_symbol])
    )

    snap = extract_snapshot_for_symbol(snapshots, contract_symbol)

    return extract_snapshot_mid_price(snap)


def _fetch_contracts_for_expiry(trading_client, symbol, expiry, contract_type, strike_low, strike_high):
    contracts_resp = trading_client.get_option_contracts(
        GetOptionContractsRequest(
            underlying_symbols=[symbol],
            expiration_date=expiry,
            type=contract_type,
            strike_price_gte=str(strike_low),
            strike_price_lte=str(strike_high),
            status="active",
        )
    )
    return (
        contracts_resp.option_contracts
        if hasattr(contracts_resp, "option_contracts")
        else list(contracts_resp)
    )


def _is_call_contract(contract_type) -> bool:
    raw = str(contract_type or "").upper()
    return raw.endswith("CALL")


def _preferred_strikes(current_price: float, strikes: list[float], is_call: bool) -> set[float]:
    if not strikes:
        return set()

    unique = sorted(set(strikes))
    atm = min(unique, key=lambda s: abs(s - current_price))

    if is_call:
        itm_candidates = [s for s in unique if s < atm]
        itm_one_step = itm_candidates[-1] if itm_candidates else atm
    else:
        itm_candidates = [s for s in unique if s > atm]
        itm_one_step = itm_candidates[0] if itm_candidates else atm

    return {atm, itm_one_step}


def _restrict_to_atm_or_one_step_itm(contracts, current_price: float, contract_type):
    if not contracts:
        return []

    is_call = _is_call_contract(contract_type)
    strikes = [float(c.strike_price) for c in contracts]
    targets = _preferred_strikes(current_price, strikes, is_call)
    if not targets:
        return contracts

    narrowed = [c for c in contracts if float(c.strike_price) in targets]
    return narrowed or contracts


def select_best_contract(
    trading_client,
    option_data_client,
    symbol,
    expiry,
    contract_type,
    current_price,
    min_option_volume: int | None = None,
    allow_low_volume_fallback: bool | None = None,
    fallback_windows: list[float] | None = None,
):
    min_volume = int(MIN_OPTION_VOLUME if min_option_volume is None else min_option_volume)
    allow_fallback = ALLOW_LOW_VOLUME_FALLBACK if allow_low_volume_fallback is None else bool(allow_low_volume_fallback)
    windows = fallback_windows or [1.0]

    strike_low = round(current_price * (1 - STRIKE_RANGE_PCT), 2)
    strike_high = round(current_price * (1 + STRIKE_RANGE_PCT), 2)

    info(f"Strike range: {strike_low} to {strike_high}")
    info(f"Expiry: {expiry}")

    # Try the requested expiry first, then fall forward day-by-day up to 7 days.
    contracts = []
    selected_expiry = expiry
    if isinstance(selected_expiry, str):
        selected_expiry = date.fromisoformat(selected_expiry)

    for offset in range(8):
        candidate = selected_expiry + timedelta(days=offset)
        contracts = _fetch_contracts_for_expiry(
            trading_client, symbol, candidate, contract_type, strike_low, strike_high
        )
        if contracts:
            if offset > 0:
                info(
                    f" No contracts on {selected_expiry}, "
                    f"falling back to expiry {candidate} (+{offset}d)"
                )
            selected_expiry = candidate
            break

    if not contracts:
        raise RuntimeError(
            f"No option contracts found in strike range {strike_low}-{strike_high} "
            f"for expiry {expiry} or the next 7 days."
        )

    snapshots = option_data_client.get_option_snapshot(
        build_option_snapshot_request([c.symbol for c in contracts])
    )

    def get_volume(contract):
        snap = extract_snapshot_for_symbol(snapshots, contract.symbol)
        return extract_snapshot_volume(snap)

    eligible_contracts = [c for c in contracts if get_volume(c) > min_volume]

    if not eligible_contracts:
        if not allow_fallback:
            raise RuntimeError(
                f"No option contracts found with volume > {min_volume}. "
                "Low-volume fallback is disabled."
            )

        chosen_window = None
        fallback_narrowed = []
        for width in windows:
            fallback_low = round(current_price - float(width), 2)
            fallback_high = round(current_price + float(width), 2)
            fallback_contracts = [
                c for c in contracts if fallback_low <= float(c.strike_price) <= fallback_high
            ]
            if not fallback_contracts:
                continue
            fallback_narrowed = _restrict_to_atm_or_one_step_itm(
                fallback_contracts, current_price, contract_type
            )
            chosen_window = (fallback_low, fallback_high)
            break

        if not fallback_narrowed:
            info(
                f"No contracts with volume > {min_volume} and no fallback strikes in "
                f"{round(current_price - 1.0, 2)} to {round(current_price + 1.0, 2)}. "
                "Using nearest ATM/1-step ITM contract from available strikes."
            )
            fallback_narrowed = _restrict_to_atm_or_one_step_itm(
                contracts, current_price, contract_type
            )
            chosen_window = (round(current_price - 1.0, 2), round(current_price + 1.0, 2))

        info(
            f"No contracts with volume > {min_volume}. "
            f"Using ATM/1-step ITM fallback strikes in {chosen_window[0]} to {chosen_window[1]}."
        )
        best = max(fallback_narrowed, key=get_volume)
        best_volume = get_volume(best)
        info(
            f"Fallback contract: {best.symbol} (strike={best.strike_price}, volume={best_volume})"
        )
        return best

    narrowed_eligible = _restrict_to_atm_or_one_step_itm(
        eligible_contracts, current_price, contract_type
    )
    best = max(narrowed_eligible, key=get_volume)
    best_volume = get_volume(best)
    info(
        f"Best ATM/1-step ITM contract: {best.symbol} (strike={best.strike_price}, volume={best_volume}, "
        f"min_required>{min_volume})"
    )
    return best