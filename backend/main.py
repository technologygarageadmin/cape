"""
How this bot works (high level):
1. Startup and readiness:
    - Validates credentials and initializes log files.
    - Verifies MongoDB connectivity at startup; exits if MongoDB is unavailable (MONGO_REQUIRED=True).
    - If market is closed, waits for today's open.
    - Arms startup straddle in the final 5 minutes before open.

2. Startup straddle (once per day):
    - At open, buys one CALL leg and one PUT leg simultaneously.
    - CALL leg exit monitor: websocket first, then polling fallback if websocket is unavailable.
    - PUT leg exit monitor: polling only.
        - Each leg exits independently using the same priority exit engine.

3. Regular strategy loop — Entry conditions:
        - Monitors 1-minute RSI + RSI MA + price action context.
    - BUY signal fires only when ALL of the following align:

            Shared filters (both directions):
                * Avoid sideways RSI zone (45-55)
                * Volatility required: ATR increasing OR current candle range larger than recent average
                * Optional IST active-session filter exists in config (disabled by default for US market)

            CALL (bullish):
                * Previous bar confirms RSI MA crossover UP
                * Cross originates from weak RSI zone (around/below 40), then RSI pushes above 50 quickly
                * Price is above EMA 200
                * Entry bar breaks previous candle high (breakout confirmation)
                * RSI is at least MIN_RSI_MA_GAP above RSI_MA

            PUT (bearish):
                * Previous bar confirms RSI MA crossover DOWN
                * Cross originates from strong RSI zone (around/above 60), then RSI drops below 50 quickly
                * Price is below EMA 200
                * Entry bar breaks previous candle low (breakdown confirmation)
                * RSI is at least MIN_RSI_MA_GAP below RSI_MA

    - Duplicate bar protection: same 1-minute bar never trades twice.
        - Post-trade cooldown: blocks new signals for POST_TRADE_COOLDOWN_BARS bars
      after any trade completes, preventing immediate chop re-entry.
        - Selects option contract from ATM or one-step ITM strikes
            (with expiry fallback up to +7 days and liquidity checks).
        - Places BUY immediately when signal validates, then monitors exit conditions and places SELL.

4. Exit conditions (priority order):
        1) Full TP / Full SL
        2) Dynamic Quick Profit (ratchet only upward)
        3) Dynamic Trailing SL (ratchet only upward)
        4) RSI opposite crossover
             - CALL exits when RSI crosses below RSI_MA.
             - PUT exits when RSI crosses above RSI_MA.

5. Reliability and fallback behavior:
    - Duplicate bar protection avoids re-trading same signal bar.
    - Websocket monitor gracefully falls back to polling when unavailable.
    - Logs every key step to text + CSV + MongoDB for full audit trail.
    - Writes one normalized MongoDB trade document per completed trade,
      including symbol, contract, direction, entry/exit prices, PnL, result, and exit_reason.
"""

from datetime import datetime, timedelta, timezone
import atexit
import csv
import os
import threading
import time
from zoneinfo import ZoneInfo

from alpaca.data.historical import OptionHistoricalDataClient, StockHistoricalDataClient
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import ContractType, OrderSide, OrderStatus

from config import (
    API_KEY,
    BRACKET_QP_PLACEHOLDER_PCT,
    CHECK_INTERVAL_SEC,
    CSV_FILE,
    EXIT_BRACKET_QP_ENABLED,
    FILL_WAIT_SEC,
    PAPER_TRADING,
    POST_TRADE_COOLDOWN_BARS,
    QTY,
    MIN_TRADE_DURATION_SEC,
    MIN_TRADE_DURATION_ENABLED,
    SECRET_KEY,
    STOCK_DATA_FEED,
    STOP_LOSS_PCT,
    SYMBOL,
    TAKE_PROFIT_PCT,
    compute_tp_price,
    compute_sl_price,
)
from logger import info, init_log, log_shutdown_summary, validate_credentials, write_log
from market_data import (
    fetch_current_price_1m,
    get_option_price,
    select_best_contract,
)
from monitoring import monitor_with_polling, monitor_with_websocket
from order_execution import place_market_order, wait_for_fill
from rsi_analyer import analyze_rsi
from strategy_helpers import determine_signal, get_expiry_date
from strategy_mode import STRATEGY_LABELS
from symbol_mode import ensure_defaults, get_mode, set_mode


CST = ZoneInfo("America/Chicago")
STARTUP_STRADDLE_ARM_WINDOW_SEC = 5 * 60
INSTANCE_LOCK_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "logs",
    "bot_instance.lock",
)

_instance_lock_fd = None


def _entry_strategy_names(entry_info: dict | None) -> list[str]:
    strategies = (entry_info or {}).get("entry_strategies") or []
    return [STRATEGY_LABELS.get(str(s), str(s)) for s in strategies]


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False

    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_instance_lock() -> bool:
    global _instance_lock_fd

    os.makedirs(os.path.dirname(INSTANCE_LOCK_FILE), exist_ok=True)

    for _ in range(2):
        try:
            _instance_lock_fd = os.open(
                INSTANCE_LOCK_FILE,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            )
            lock_payload = (
                f"pid={os.getpid()}\n"
                f"started_utc={datetime.now(timezone.utc).isoformat(timespec='seconds')}\n"
            )
            os.write(_instance_lock_fd, lock_payload.encode("utf-8"))
            return True
        except FileExistsError:
            try:
                with open(INSTANCE_LOCK_FILE, "r", encoding="utf-8") as f:
                    first_line = (f.readline() or "").strip()
                pid_text = first_line.split("=", 1)[1] if first_line.startswith("pid=") else ""
                existing_pid = int(pid_text) if pid_text.isdigit() else 0
            except Exception:
                existing_pid = 0

            if existing_pid and _pid_is_running(existing_pid):
                info(
                    "Another bot instance is already running "
                    f"(pid {existing_pid}). Exiting this process."
                )
                return False

            try:
                os.remove(INSTANCE_LOCK_FILE)
            except FileNotFoundError:
                pass
            except Exception:
                info("Instance lock exists and could not be removed. Exiting for safety.")
                return False

    info("Could not acquire instance lock. Exiting for safety.")
    return False


def release_instance_lock() -> None:
    global _instance_lock_fd

    if _instance_lock_fd is not None:
        try:
            os.close(_instance_lock_fd)
        except Exception:
            pass
        _instance_lock_fd = None

    try:
        if os.path.exists(INSTANCE_LOCK_FILE):
            os.remove(INSTANCE_LOCK_FILE)
    except Exception:
        pass


def _iso_ts(value) -> str | None:
    if isinstance(value, datetime):
        ts = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return ts.isoformat(timespec="seconds")
    return None


def has_startup_straddle_run_today() -> bool:
    if not os.path.exists(CSV_FILE):
        return False

    today_cst = datetime.now(tz=CST).strftime("%Y-%m-%d")

    try:
        with open(CSV_FILE, "r", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                timestamp = (row.get("timestamp") or "").strip()
                action = (row.get("action") or "").strip()

                if not timestamp.startswith(today_cst):
                    continue

                if action in ("STARTUP_STRADDLE_STARTED", "STARTUP_BUY_FILLED", "STARTUP_SELL"):
                    return True
    except Exception as ex:
        info(f" Could not verify prior startup straddle from CSV: {str(ex)[:100]}")

    return False


def wait_for_market_open_today(trading_client: TradingClient) -> bool:
    clock = trading_client.get_clock()
    if clock.is_open:
        info(" Market is already open. Running startup straddle now.")
        return True

    now = datetime.now(tz=CST)
    next_open = clock.next_open
    next_open_cst = next_open.astimezone(CST)

    if next_open_cst.date() != now.date():
        info(
            f" Market is closed and next open is {next_open_cst.strftime('%Y-%m-%d %H:%M:%S %Z')}. "
            "No startup straddle today."
        )
        write_log(
            {
                "action": "STARTUP_STRADDLE_SKIP",
                "symbol": SYMBOL,
                "status": f"Market closed; next open {next_open_cst.strftime('%Y-%m-%d %H:%M:%S %Z')}",
            }
        )
        return False

    wait_sec = max(0, int((next_open - datetime.now(tz=next_open.tzinfo)).total_seconds()))
    info(
        f" Market closed. Waiting until open at {next_open_cst.strftime('%H:%M:%S %Z')} "
        f"({wait_sec}s)..."
    )

    if wait_sec <= STARTUP_STRADDLE_ARM_WINDOW_SEC:
        info(" Startup straddle is in READY window (last 5 minutes before open).")
        write_log(
            {
                "action": "STARTUP_STRADDLE_READY",
                "symbol": SYMBOL,
                "status": "Armed in final 5-minute pre-open window",
            }
        )
    else:
        arm_at = next_open_cst - timedelta(seconds=STARTUP_STRADDLE_ARM_WINDOW_SEC)
        info(
            f" Startup straddle will arm at {arm_at.strftime('%H:%M:%S %Z')} "
            f"({STARTUP_STRADDLE_ARM_WINDOW_SEC // 60} minutes before open)."
        )

    armed_logged = wait_sec <= STARTUP_STRADDLE_ARM_WINDOW_SEC
    while wait_sec > 0:
        if (not armed_logged) and wait_sec <= STARTUP_STRADDLE_ARM_WINDOW_SEC:
            info(" Startup straddle is in READY window (last 5 minutes before open).")
            write_log(
                {
                    "action": "STARTUP_STRADDLE_READY",
                    "symbol": SYMBOL,
                    "status": "Armed in final 5-minute pre-open window",
                }
            )
            armed_logged = True

        if wait_sec > STARTUP_STRADDLE_ARM_WINDOW_SEC:
            sleep_chunk = min(30, wait_sec)
        elif wait_sec > 60:
            sleep_chunk = min(5, wait_sec)
        else:
            sleep_chunk = 1

        time.sleep(sleep_chunk)
        wait_sec = max(0, int((next_open - datetime.now(tz=next_open.tzinfo)).total_seconds()))

    for _ in range(12):
        clock = trading_client.get_clock()
        if clock.is_open:
            info(" Market is open now. Running startup straddle.")
            return True
        time.sleep(2)

    info(" Market did not confirm open yet. Skipping startup straddle for safety.")
    write_log(
        {
            "action": "STARTUP_STRADDLE_SKIP",
            "symbol": SYMBOL,
            "status": "Could not confirm market open after wait",
        }
    )
    return False


def fetch_startup_entry_price(stock_client: StockHistoricalDataClient) -> tuple[float, str]:
    for attempt in range(1, 25):
        try:
            return fetch_current_price_1m(stock_client, SYMBOL)
        except Exception as ex:
            info(f" Waiting for opening price data (attempt {attempt}/24): {str(ex)[:90]}")
            time.sleep(5)

    raise RuntimeError("Could not fetch a fresh opening price for startup straddle.")


def execute_startup_straddle(
    stock_client: StockHistoricalDataClient,
    option_data_client: OptionHistoricalDataClient,
    trading_client: TradingClient,
    session_stats: dict,
) -> None:
    info("\nChecking startup straddle condition...")

    if has_startup_straddle_run_today():
        info(" Startup straddle already executed today. Skipping.")
        write_log(
            {
                "action": "STARTUP_STRADDLE_SKIP",
                "symbol": SYMBOL,
                "status": "Already executed today",
            }
        )
        return

    if not wait_for_market_open_today(trading_client):
        return

    write_log(
        {
            "action": "STARTUP_STRADDLE_STARTED",
            "symbol": SYMBOL,
            "status": "Starting daily startup straddle",
        }
    )

    current_price, price_bartime = fetch_startup_entry_price(stock_client)
    expiry = get_expiry_date()
    info(
        f" Startup straddle entry price[{price_bartime}]: {current_price:.2f} | "
        f"Expiry: {expiry.strftime('%Y-%m-%d')}"
    )

    leg_setups = [
        ("CALL", ContractType.CALL),
        ("PUT", ContractType.PUT),
    ]
    open_legs = []

    for leg_name, contract_type in leg_setups:
        try:
            contract = select_best_contract(
                trading_client,
                option_data_client,
                SYMBOL,
                expiry,
                contract_type,
                current_price,
            )
            startup_contract_no = str(getattr(contract, "id", "") or contract.symbol)

            write_log(
                {
                    "action": "STARTUP_TRADE_STARTED",
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "symbol": SYMBOL,
                    "price": current_price,
                    "contract": contract.symbol,
                    "contract_no": startup_contract_no,
                    "trade_side": leg_name,
                    "signal": leg_name,
                    "strike": contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "status": "ENTRY_INTENT",
                    "trade_started_at_utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "price_bartime": price_bartime,
                }
            )

            info(f" Startup {leg_name}: buying {contract.symbol}")
            buy_order = place_market_order(
                trading_client,
                contract.symbol,
                QTY,
                OrderSide.BUY,
                reference_price=current_price,
                allow_limit=False,
                use_bracket=EXIT_BRACKET_QP_ENABLED,
                take_profit_price=max(0.01, compute_tp_price(current_price)),
                stop_loss_price=max(0.01, round(current_price * (1 + BRACKET_QP_PLACEHOLDER_PCT / 100.0), 4)),
            )
            filled_buy = wait_for_fill(trading_client, str(buy_order.id), FILL_WAIT_SEC)

            if filled_buy.status != OrderStatus.FILLED:
                info(f" Startup {leg_name} BUY FAILED: {filled_buy.status}")
                write_log(
                    {
                        "action": "STARTUP_BUY_FAILED",
                        "symbol": SYMBOL,
                        "contract": contract.symbol,
                        "signal": leg_name,
                        "qty": QTY,
                        "order_id": buy_order.id,
                        "status": str(filled_buy.status),
                        "price_bartime": price_bartime,
                    }
                )
                continue

            fill_price = float(
                filled_buy.filled_avg_price or get_option_price(option_data_client, contract.symbol)
            )
            startup_buy_filled_time = (
                _iso_ts(getattr(filled_buy, "filled_at", None))
                or datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
            tp_price = compute_tp_price(fill_price)
            sl_price = compute_sl_price(fill_price)

            info(
                f" Startup {leg_name} FILLED: {fill_price:.4f} | "
                f"TP: {tp_price:.4f} | SL: {sl_price:.4f}"
            )
            write_log(
                {
                    "action": "STARTUP_BUY_FILLED",
                    "symbol": SYMBOL,
                    "contract": contract.symbol,
                    "signal": leg_name,
                    "strike": contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "order_id": buy_order.id,
                    "status": "FILLED",
                    "fill_price": fill_price,
                    "tp_price": tp_price,
                    "sl_price": sl_price,
                    "entry_signal_time": startup_buy_filled_time,
                    "buy_filled_time": startup_buy_filled_time,
                    "price_bartime": price_bartime,
                }
            )

            open_legs.append(
                {
                    "leg_name": leg_name,
                    "contract": contract,
                    "fill_price": fill_price,
                    "tp_price": tp_price,
                    "sl_price": sl_price,
                    "buy_order_id": str(buy_order.id),
                }
            )

        except Exception as ex:
            info(f" Startup {leg_name} setup failed: {str(ex)[:120]}")
            write_log(
                {
                    "action": "STARTUP_BUY_ERROR",
                    "symbol": SYMBOL,
                    "signal": leg_name,
                    "status": str(ex)[:120],
                }
            )

    if not open_legs:
        info(" Startup straddle not opened (no filled legs).")
        return

    stats_lock = threading.Lock()

    def monitor_and_exit_leg(leg: dict) -> None:
        leg_name = leg["leg_name"]
        contract = leg["contract"]
        fill_price = leg["fill_price"]
        tp_price = leg["tp_price"]
        sl_price = leg["sl_price"]
        buy_order_id = leg.get("buy_order_id")

        try:
            info(f" Startup {leg_name}: monitoring {contract.symbol} for RSI marker SELL")
            if leg_name == "CALL":
                try:
                    min_exit_epoch_ts = (
                        time.time() + float(MIN_TRADE_DURATION_SEC or 0)
                        if MIN_TRADE_DURATION_ENABLED else None
                    )
                except Exception:
                    min_exit_epoch_ts = None

                exit_reason, current_option_price, _exit_state = monitor_with_websocket(
                    contract.symbol,
                    fill_price,
                    tp_price,
                    sl_price,
                    context_label=f"STARTUP {leg_name}",
                    signal=leg_name,
                    underlying_symbol=SYMBOL,
                    use_extended_exit_criteria=False,
                    buy_entry_order_id=buy_order_id,
                    min_exit_epoch_ts=min_exit_epoch_ts,
                    tc=trading_client,
                    qty=QTY,
                )
                if exit_reason is None:
                    info(f" Startup {leg_name}: websocket unavailable, switching to polling")
                    exit_reason, current_option_price, _exit_state = monitor_with_polling(
                        option_data_client,
                        contract.symbol,
                        fill_price,
                        tp_price,
                        sl_price,
                        context_label=f"STARTUP {leg_name}",
                        signal=leg_name,
                        underlying_symbol=SYMBOL,
                        use_extended_exit_criteria=False,
                        buy_entry_order_id=buy_entry_order_id,
                        min_exit_epoch_ts=min_exit_epoch_ts,
                        tc=trading_client,
                        qty=QTY,
                    )
            else:
                info(f" Startup {leg_name}: polling-only monitor")
                exit_reason, current_option_price, _exit_state = monitor_with_polling(
                    option_data_client,
                    contract.symbol,
                    fill_price,
                    tp_price,
                    sl_price,
                    context_label=f"STARTUP {leg_name}",
                    signal=leg_name,
                    underlying_symbol=SYMBOL,
                    use_extended_exit_criteria=False,
                    buy_entry_order_id=buy_order_id,
                    tc=trading_client,
                    qty=QTY,
                )

            startup_exit_signal_time = datetime.now(timezone.utc).isoformat(timespec="seconds")

            sell_order = place_market_order(
                trading_client,
                contract.symbol,
                QTY,
                OrderSide.SELL,
                reference_price=current_option_price,
            )
            filled_sell = wait_for_fill(trading_client, str(sell_order.id), FILL_WAIT_SEC)
            sell_fill_price = float(filled_sell.filled_avg_price or current_option_price)
            startup_sell_filled_time = (
                _iso_ts(getattr(filled_sell, "filled_at", None))
                or datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
            exit_reason = exit_reason or "FORCED_EXIT_NO_SIGNAL"

            final_pnl_pct = (sell_fill_price - fill_price) / fill_price * 100

            info(
                f" Startup {leg_name} SOLD: {sell_fill_price:.4f} | "
                f"PnL: {final_pnl_pct:+.2f}% | Exit: {exit_reason}"
            )
            write_log(
                {
                    "action": "STARTUP_SELL",
                    "symbol": SYMBOL,
                    "contract": contract.symbol,
                    "signal": leg_name,
                    "strike": contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "order_id": sell_order.id,
                    "status": str(filled_sell.status),
                    "fill_price": sell_fill_price,
                    "tp_price": tp_price,
                    "sl_price": sl_price,
                    "exit_reason": exit_reason,
                    "pnl_pct": f"{final_pnl_pct:.2f}",
                    "exit_signal_time": startup_exit_signal_time,
                    "sell_filled_time": startup_sell_filled_time,
                }
            )

            with stats_lock:
                session_stats["total_trades"] += 1
                session_stats["net_pnl_pct"] += final_pnl_pct

                if final_pnl_pct > 0:
                    session_stats["wins"] += 1
                    session_stats["gross_profit_pct"] += final_pnl_pct
                elif final_pnl_pct < 0:
                    session_stats["losses"] += 1
                    session_stats["gross_loss_pct"] += abs(final_pnl_pct)
                else:
                    session_stats["breakeven"] += 1

        except Exception as ex:
            info(f" Startup {leg_name} exit handling failed: {str(ex)[:120]}")
            write_log(
                {
                    "action": "STARTUP_SELL_ERROR",
                    "symbol": SYMBOL,
                    "contract": contract.symbol,
                    "signal": leg_name,
                    "status": str(ex)[:120],
                }
            )

    threads = [threading.Thread(target=monitor_and_exit_leg, args=(leg,)) for leg in open_legs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    info(" Startup straddle cycle complete. Continuing regular strategy loop.")


def main() -> None:
    validate_credentials()

    if not acquire_instance_lock():
        return

    atexit.register(release_instance_lock)
    init_log()

    mode = "PAPER TRADING" if PAPER_TRADING else "LIVE TRADING"
    info(f"\n{'=' * 80}")
    info(f"Mode: {mode} | Stock feed: {STOCK_DATA_FEED}")
    info(
        f"Symbol: {SYMBOL}, Qty: {QTY}, TP: {TAKE_PROFIT_PCT * 100:.1f}%, "
        f"SL: {STOP_LOSS_PCT * 100:.1f}%"
    )
    info(f"Check interval: {CHECK_INTERVAL_SEC} seconds")
    info("Press Ctrl+C to stop.")
    info(f"{'=' * 80}\n")

    write_log({"action": "STARTUP", "symbol": SYMBOL, "status": "Monitoring started"})

    # Ensure symbol_modes.json has defaults for all watchlist symbols.
    # Only fills in MISSING entries — never overwrites a mode the user set via the UI.
    ensure_defaults()
    info(f" Symbol mode for {SYMBOL}: {get_mode(SYMBOL)} (from symbol_modes.json)")

    stock_client = StockHistoricalDataClient(API_KEY, SECRET_KEY)
    option_data_client = OptionHistoricalDataClient(API_KEY, SECRET_KEY)
    trading_client = TradingClient(API_KEY, SECRET_KEY, paper=PAPER_TRADING)

    session_stats = {
        "total_trades": 0,
        "wins": 0,
        "losses": 0,
        "breakeven": 0,
        "gross_profit_pct": 0.0,
        "gross_loss_pct": 0.0,
        "net_pnl_pct": 0.0,
    }

    execute_startup_straddle(stock_client, option_data_client, trading_client, session_stats)

    last_traded_price_bartime = None
    check_count = 0
    obr_bartime = "N/A"
    cooldown_bars_remaining = 0
    last_completed_bar = None

    while True:
        try:
            # ── Check trading mode (set by frontend via /api/symbol/mode) ──────────
            current_mode = get_mode(SYMBOL)
            if current_mode == "off":
                info(f"[Mode: OFF] {SYMBOL} is paused. Sleeping {CHECK_INTERVAL_SEC}s...")
                time.sleep(CHECK_INTERVAL_SEC)
                continue
            if current_mode == "manual":
                info(f"[Mode: MANUAL] {SYMBOL} — AIT paused. Waiting for frontend buy/sell.")
                time.sleep(CHECK_INTERVAL_SEC)
                continue
            # mode == "auto" → full AIT logic below

            check_count += 1
            current_time = datetime.now(tz=CST).strftime("%Y-%m-%d %H:%M:%S %Z")
            info(f"\n[Check #{check_count} at {current_time}] Fetching RSI trend & price...")

            rsi_result = analyze_rsi(SYMBOL)
            current_price = float(rsi_result["close_price"])
            latest_rsi = float(rsi_result["latest_rsi"])
            previous_rsi = float(rsi_result["previous_rsi"])
            rsi_delta = float(rsi_result["delta"])
            latest_rsi_ma = float(rsi_result["latest_rsi_ma"])
            base_trend = rsi_result["base_trend"]
            rsi_ma_ready = bool(rsi_result.get("rsi_ma_ready", True))
            rsi_ma_cross_up = bool(rsi_result["rsi_ma_cross_up"])
            rsi_ma_cross_down = bool(rsi_result["rsi_ma_cross_down"])

            bar_time_obj = rsi_result.get("alpaca_bar_time_cst")
            price_bartime = bar_time_obj.strftime("%H:%M:%S %Z") if bar_time_obj else "N/A"

            # Tick down cooldown counter when a new bar arrives.
            if price_bartime != last_completed_bar and last_completed_bar is not None:
                if cooldown_bars_remaining > 0:
                    cooldown_bars_remaining -= 1
                    info(f" Post-trade cooldown: {cooldown_bars_remaining} bar(s) remaining — skipping signals")
                    last_completed_bar = price_bartime
                    time.sleep(CHECK_INTERVAL_SEC)
                    continue
            last_completed_bar = price_bartime

            # Extract EMA and candle data for logging
            ema_fast = float(rsi_result.get("ema_fast", 0))
            ema_slow = float(rsi_result.get("ema_slow", 0))
            ema_regime = "BULL" if rsi_result.get("ema_fast_above_slow") else "BEAR"
            pullback_pct = float(rsi_result.get("pullback_to_ema_pct", 0))
            body_ratio = float(rsi_result.get("candle_body_ratio", 0))

            info(
                f" RSI[{price_bartime}]: {latest_rsi:.2f} (prev {previous_rsi:.2f}, "
                f"delta {rsi_delta:+.2f}) | RSI_MA: {latest_rsi_ma:.2f} | Trend: {base_trend} | "
                f"CrossUp: {rsi_ma_cross_up} | CrossDown: {rsi_ma_cross_down} | "
                f"EMA9: {ema_fast:.2f} EMA21: {ema_slow:.2f} [{ema_regime}] | "
                f"Pullback: {pullback_pct:.2f}% | Body: {body_ratio:.0%} | "
                f"Price: {current_price:.2f}"
            )

            write_log(
                {
                    "action": "RSI",
                    "symbol": SYMBOL,
                    "status": (
                        f"RSI {latest_rsi:.2f} (prev {previous_rsi:.2f}, delta {rsi_delta:+.2f}) "
                        f"| RSI_MA {latest_rsi_ma:.2f} | MA_Ready {rsi_ma_ready} | Trend {base_trend} "
                        f"| CrossUp {rsi_ma_cross_up} | CrossDown {rsi_ma_cross_down} "
                        f"| Price {current_price:.2f}"
                    ),
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            signal, contract_type, order_side, entry_info = determine_signal(
                rsi_result,
                current_price,
            )

            if signal and price_bartime == last_traded_price_bartime:
                info(f" Signal {signal} skipped: already traded on bar {price_bartime}")
                write_log(
                    {
                        "action": "SKIP",
                        "symbol": SYMBOL,
                        "signal": signal,
                        "status": f"Duplicate signal on same bar {price_bartime}",
                        "obr_bartime": obr_bartime,
                        "price_bartime": price_bartime,
                    }
                )
                time.sleep(CHECK_INTERVAL_SEC)
                continue

            if not signal:
                info(" Signal: WAIT - no RSI trend + RSI MA crossover setup yet")
                write_log(
                    {
                        "action": "CHECK",
                        "symbol": SYMBOL,
                        "signal": "WAIT",
                        "status": (
                            "No setup: require RSI trend + RSI MA crossover "
                            f"(Price {current_price:.2f}, "
                            f"Trend {base_trend}, MA_Ready {rsi_ma_ready}, CrossUp {rsi_ma_cross_up}, CrossDown {rsi_ma_cross_down})"
                        ),
                        "obr_bartime": obr_bartime,
                        "price_bartime": price_bartime,
                    }
                )
                time.sleep(CHECK_INTERVAL_SEC)
                continue

            entry_strategies = (entry_info or {}).get("entry_strategies") or []
            entry_strategy_names = _entry_strategy_names(entry_info)
            info(f" >>> SIGNAL: {signal} <<<")
            info(f" Entry strategy: {', '.join(entry_strategy_names) if entry_strategy_names else 'Unknown'}")
            bar_time_utc = rsi_result.get("alpaca_bar_time_utc")
            bar_time = bar_time_utc.strftime("%Y-%m-%d %H:%M:%S") if bar_time_utc else None
            entry_signal_time_iso = (
                _iso_ts(bar_time_utc)
                or datetime.now(timezone.utc).isoformat(timespec="seconds")
            )

            write_log(
                {
                    "action": "SIGNAL",
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "symbol": SYMBOL,
                    "bar_time": bar_time,
                    "price": current_price,
                    "signal": signal,
                    "entry_strategies": ",".join(str(s) for s in entry_strategies),
                    "entry_strategy_names": ", ".join(entry_strategy_names),
                    "status": (
                        f"Signal {signal} from {', '.join(entry_strategy_names) if entry_strategy_names else 'entry strategy'} "
                        f"(RSI {latest_rsi:.2f}, RSI_MA {latest_rsi_ma:.2f}, "
                        f"Trend {base_trend}, CrossUp {rsi_ma_cross_up}, CrossDown {rsi_ma_cross_down})"
                    ),
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            last_traded_price_bartime = price_bartime
            expiry = get_expiry_date()
            info(f" Expiry: {expiry.strftime('%Y-%m-%d')}")

            info(f" Selecting best {signal} contract...")
            best_contract = select_best_contract(
                trading_client,
                option_data_client,
                SYMBOL,
                expiry,
                contract_type,
                current_price,
            )
            info(f" Selected: {best_contract.symbol} (strike: {best_contract.strike_price})")
            contract_no = str(getattr(best_contract, "id", "") or best_contract.symbol)

            write_log(
                {
                    "action": "TRADE_STARTED",
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "symbol": SYMBOL,
                    "price": current_price,
                    "contract": best_contract.symbol,
                    "contract_no": contract_no,
                    "trade_side": signal,
                    "signal": signal,
                    "entry_strategies": ",".join(str(s) for s in entry_strategies),
                    "entry_strategy_names": ", ".join(entry_strategy_names),
                    "strike": best_contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "status": "ENTRY_INTENT",
                    "trade_started_at_utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            info(" Placing BUY order...")
            buy_order = place_market_order(
                trading_client,
                best_contract.symbol,
                QTY,
                order_side,
                reference_price=current_price,
                allow_limit=False,
                use_bracket=EXIT_BRACKET_QP_ENABLED,
                take_profit_price=max(0.01, compute_tp_price(current_price)),
                stop_loss_price=max(0.01, round(current_price * (1 + BRACKET_QP_PLACEHOLDER_PCT / 100.0), 4)),
            )
            write_log(
                {
                    "action": "BUY",
                    "symbol": SYMBOL,
                    "price": current_price,
                    "contract": best_contract.symbol,
                    "contract_no": contract_no,
                    "trade_side": signal,
                    "signal": signal,
                    "entry_strategies": ",".join(str(s) for s in entry_strategies),
                    "entry_strategy_names": ", ".join(entry_strategy_names),
                    "strike": best_contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "order_id": buy_order.id,
                    "status": str(buy_order.status),
                    "tp_price": None,
                    "sl_price": None,
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            filled_buy = wait_for_fill(trading_client, str(buy_order.id), FILL_WAIT_SEC)
            if filled_buy.status != OrderStatus.FILLED:
                info(f" BUY FAILED: {filled_buy.status}")
                write_log(
                    {
                        "action": "BUY_FAILED",
                        "symbol": SYMBOL,
                        "contract": best_contract.symbol,
                        "contract_no": contract_no,
                        "trade_side": signal,
                        "signal": signal,
                        "order_id": buy_order.id,
                        "status": str(filled_buy.status),
                        "obr_bartime": obr_bartime,
                        "price_bartime": price_bartime,
                    }
                )
                time.sleep(CHECK_INTERVAL_SEC)
                continue

            fill_price = float(
                filled_buy.filled_avg_price
                or get_option_price(option_data_client, best_contract.symbol)
            )
            buy_filled_time_iso = (
                _iso_ts(getattr(filled_buy, "filled_at", None))
                or datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
            tp_price = compute_tp_price(fill_price)
            sl_price = compute_sl_price(fill_price)

            info(f" BUY FILLED: {fill_price:.4f} | TP: {tp_price:.4f} | SL: {sl_price:.4f}")
            write_log(
                {
                    "action": "BUY_FILLED",
                    "symbol": SYMBOL,
                    "price": current_price,
                    "contract": best_contract.symbol,
                    "contract_no": contract_no,
                    "trade_side": signal,
                    "signal": signal,
                    "entry_strategies": ",".join(str(s) for s in entry_strategies),
                    "entry_strategy_names": ", ".join(entry_strategy_names),
                    "strike": best_contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "order_id": buy_order.id,
                    "status": "FILLED",
                    "fill_price": fill_price,
                    "tp_price": tp_price,
                    "sl_price": sl_price,
                    "entry_signal_time": entry_signal_time_iso,
                    "buy_filled_time": buy_filled_time_iso,
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            info(" Monitoring for RSI marker SELL...")
            try:
                min_exit_epoch_ts = (
                    time.time() + float(MIN_TRADE_DURATION_SEC or 0)
                    if MIN_TRADE_DURATION_ENABLED else None
                )
            except Exception:
                min_exit_epoch_ts = None

            exit_reason, current_option_price, _exit_state = monitor_with_websocket(
                best_contract.symbol,
                fill_price,
                tp_price,
                sl_price,
                context_label=f"REGULAR {signal}",
                signal=signal,
                underlying_symbol=SYMBOL,
                buy_entry_order_id=str(buy_order.id),
                min_exit_epoch_ts=min_exit_epoch_ts,
                tc=trading_client,
                qty=QTY,
            )
            if exit_reason is None:
                exit_reason, current_option_price, _exit_state = monitor_with_polling(
                    option_data_client,
                    best_contract.symbol,
                    fill_price,
                    tp_price,
                    sl_price,
                    context_label=f"REGULAR {signal}",
                    signal=signal,
                    underlying_symbol=SYMBOL,
                    buy_entry_order_id=str(buy_order.id),
                    min_exit_epoch_ts=min_exit_epoch_ts,
                    tc=trading_client,
                    qty=QTY,
                )

            exit_signal_time_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

            info(f" {exit_reason} at {current_option_price:.4f}")

            info(" Placing SELL order...")
            sell_order = place_market_order(
                trading_client,
                best_contract.symbol,
                QTY,
                OrderSide.SELL,
                reference_price=current_option_price,
            )
            filled_sell = wait_for_fill(trading_client, str(sell_order.id), FILL_WAIT_SEC)
            sell_fill_price = float(filled_sell.filled_avg_price or current_option_price)
            sell_filled_time_iso = (
                _iso_ts(getattr(filled_sell, "filled_at", None))
                or datetime.now(timezone.utc).isoformat(timespec="seconds")
            )
            exit_reason = exit_reason or "FORCED_EXIT_NO_SIGNAL"

            final_pnl_pct = (sell_fill_price - fill_price) / fill_price * 100

            info(
                f" SELL FILLED: {sell_fill_price:.4f} | PnL: {final_pnl_pct:+.2f}% "
                f"| Exit: {exit_reason}"
            )
            write_log(
                {
                    "action": "SELL",
                    "symbol": SYMBOL,
                    "price": current_price,
                    "contract": best_contract.symbol,
                    "contract_no": contract_no,
                    "trade_side": signal,
                    "signal": signal,
                    "strike": best_contract.strike_price,
                    "expiry": str(expiry),
                    "qty": QTY,
                    "order_id": sell_order.id,
                    "status": str(filled_sell.status),
                    "sell_price": sell_fill_price,
                    "fill_price": sell_fill_price,
                    "tp_price": tp_price,
                    "sl_price": sl_price,
                    "exit_reason": exit_reason,
                    "pnl_pct": f"{final_pnl_pct:.2f}",
                    "entry_signal_time": entry_signal_time_iso,
                    "buy_filled_time": buy_filled_time_iso,
                    "exit_signal_time": exit_signal_time_iso,
                    "sell_filled_time": sell_filled_time_iso,
                    "obr_bartime": obr_bartime,
                    "price_bartime": price_bartime,
                }
            )

            session_stats["total_trades"] += 1
            session_stats["net_pnl_pct"] += final_pnl_pct

            if final_pnl_pct > 0:
                session_stats["wins"] += 1
                session_stats["gross_profit_pct"] += final_pnl_pct
            elif final_pnl_pct < 0:
                session_stats["losses"] += 1
                session_stats["gross_loss_pct"] += abs(final_pnl_pct)
            else:
                session_stats["breakeven"] += 1

            cooldown_bars_remaining = POST_TRADE_COOLDOWN_BARS
            info(f" Trade complete. Cooldown: blocking next {POST_TRADE_COOLDOWN_BARS} bar(s) to avoid chop re-entry.\n")
            time.sleep(CHECK_INTERVAL_SEC)

        except KeyboardInterrupt:
            info("\n\n" + "=" * 80)
            info("User requested shutdown.")
            info("=" * 80)
            write_log({"action": "SHUTDOWN", "symbol": SYMBOL, "status": "User stopped"})
            log_shutdown_summary(SYMBOL, session_stats)
            info("\nLogs saved:")
            info(" Text: logs/trade.log")
            info(" Backup: logs/trade_log.csv\n")
            break

        except Exception as ex:
            info(f" ⚠ ERROR: {str(ex)[:150]}")
            write_log({"action": "ERROR", "symbol": SYMBOL, "status": str(ex)[:100]})
            info(f" Retrying in {CHECK_INTERVAL_SEC} seconds...\n")
            try:
                time.sleep(CHECK_INTERVAL_SEC)
            except KeyboardInterrupt:
                info("\n\n" + "=" * 80)
                info("User requested shutdown.")
                info("=" * 80)
                write_log({"action": "SHUTDOWN", "symbol": SYMBOL, "status": "User stopped"})
                log_shutdown_summary(SYMBOL, session_stats)
                info("\nLogs saved:")
                info(" Text: logs/trade.log")
                info(" Backup: logs/trade_log.csv\n")
                break


if __name__ == "__main__":
    main()
