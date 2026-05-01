# SYSTEM OVERVIEW

Cape is a dual-lane FastAPI options trading system with one shared trading core:

- Trading lane: `backend/api_server_trading.py` runs `api_server.app` on port 8001.
- Display lane: `backend/api_server_display.py` proxies selected UI endpoints to the trading lane on port 8002.
- Launcher: `app.py` starts both lane processes and waits for readiness.

Core execution domains:

- Signal generation: `rsi_analyer.py` computes RSI/EMA/MACD/Bollinger/volume/price-structure features; `strategy_helpers.py` applies the 3-tier regime/setup/confluence gate.
- Contract selection: `market_data.py` finds ATM/1-step-ITM option contracts with volume-based filtering.
- Order lifecycle + state: `order_execution.py` places broker orders and stores in-memory position registries (`_positions`, `_live_exit_states`).
- Exit engine: `monitoring.py` drives TP/SL bracket tracking, SL ratchet replacement, and market-fallback exits.
- Orchestration: `api_server.py` owns AIT loops, manual-trade monitors, recovery monitors, startup tasks, and all APIs.

Persistent stores and logs:

- MongoDB collections are used for options trade history, manual trades, and straddle tracking (`logger.py`, `api_server.py`, `position_monitor_loop.py`).
- CSV + text logs are maintained by `logger.py`.
- Strategy and symbol mode state are persisted to JSON files in `backend/logs` (`strategy_mode.py`, `symbol_mode.py`).

Important architectural reality:

- There are two trading-loop implementations: one in `backend/api_server.py` (`_ait_trade_loop`) and one in `backend/main.py` (`main`).
- `app.py` starts lane servers, and `api_server.py` startup already launches AIT + recovery + generic position monitor threads. `main.py` is a parallel standalone runner, not imported by lane startup.

# FILE-BY-FILE ANALYSIS

## 1) app.py

- Role: local bootstrap script that starts two backend processes (`api_server_trading.py` and `api_server_display.py`) in separate consoles.
- Key behavior: waits on `/api/config` health checks for ports 8001 and 8002 before declaring startup complete.
- Imported by: none.
- Notes: process supervision is minimal; it waits on the trading backend process and only terminates both on Ctrl+C.

## 2) backend/api_server.py

- Role: main application core; defines FastAPI app, startup orchestration, AIT loops, recovery monitors, manual trade monitor threads, straddle background loops, and API endpoints.
- Key functions include: `_ait_trade_loop`, `_ait_run_straddle`, `_recover_open_positions`, `_recovery_monitor_thread`, `_manual_trade_monitor_thread`, `get_signal_readiness`, and all `/api/*` routes.
- Imported by: `backend/api_server_trading.py`.
- Notes:
  - Contains two duplicate definitions of `_poll_straddle_call_call_day` (later definition overwrites earlier one).
  - Startup event launches multiple long-running services (`_straddle_runner_loop`, `_straddle_monitor_loop`, `_recover_open_positions`, `_start_ait_threads`, `start_position_monitor_service`).

## 3) backend/api_server_trading.py

- Role: thin trading-lane entrypoint that imports `app` from `api_server` and runs uvicorn on port 8001.
- Imported by: none.
- Notes: runtime behavior is entirely determined by `api_server.py`.

## 4) backend/api_server_display.py

- Role: read-mostly proxy lane that forwards selected display/UI endpoints to trading backend (`TRADING_BASE = 127.0.0.1:8001`).
- Key behavior: shared persistent `httpx.AsyncClient`, endpoint-by-endpoint forward wrappers, CORS middleware.
- Imported by: none.
- Notes:
  - `DISPLAY_ALLOWLIST` is declared but not actually enforced in request path handling.
  - Includes a forwarded close-position endpoint for UI liquidate support.

## 5) backend/alpaca_helpers.py

- Role: Alpaca SDK compatibility wrappers across version/schema differences.
- Key behavior: builds requests, extracts bars/snapshots/mid/volume safely, handles API errors with user-facing diagnostics.
- Imported by: `backend/api_server.py`, `backend/market_data.py`, `backend/monitoring.py`.
- Notes: central adapter layer that reduces SDK drift risk.

## 6) backend/config.py

- Role: master config module for credentials, trading gates, entry filters, exit logic, logging/Mongo settings, and helper functions (`compute_tp_price`, `compute_sl_price`).
- Imported by: most backend runtime modules and some tools.
- Notes:
  - Contains duplicated constant assignments (for example `EXIT_QUICK_PROFIT_ENABLED`, `QP_GAP_PCT`, `EXIT_TRAILING_STOP_ENABLED`, `SL_STOP_LIMIT_BUFFER_PCT`), where later definitions silently override earlier values.
  - Includes hardcoded secrets (`API_KEY`, `SECRET_KEY`, `MONGO_URI`).

## 7) backend/logger.py

- Role: unified logging + trade archival layer (text log, CSV, Mongo per-trade-type collections).
- Key behavior: `log_trade` writes rich trade blocks, per-type CSV rows, Mongo inserts; `write_log` supports legacy event-style logs and BUY->SELL stitching.
- Imported by: runtime modules including `api_server.py`, `main.py`, `monitoring.py`, `order_execution.py`, `position_monitor_loop.py`.
- Notes: bridges both legacy and newer logging patterns.

## 8) backend/main.py

- Role: standalone bot runner with its own startup straddle + regular AIT loop implementation.
- Key behavior: instance lock handling, startup straddle execution, RSI signal loop, order placement, monitor-based exits, shutdown summary.
- Imported by: none.
- Notes: overlaps functionally with `api_server.py` trading engine, creating potential behavior drift if both evolve differently.

## 9) backend/market_data.py

- Role: market-data and contract-selection utilities.
- Key behavior: fetches OBR/current bars, option mid-prices, and selects best contract using strike windows + volume logic + ATM/1-step-ITM narrowing.
- Imported by: `backend/api_server.py`, `backend/main.py`.
- Notes: includes fallback to later expiries up to +7 days.

## 10) backend/monitoring.py

- Role: core exit state machine for active trades.
- Key behavior:
  - Initializes and tracks `exit_state` (`tp_order_ids`, `sl_order_ids`, `sl_dynamic_pct`, `sl_last_placed_pct`, `confirmed_sl_price`, timeline).
  - Seeds/adopts broker child orders (`_seed_bracket_exit_orders`, `_adopt_existing_broker_sl`).
  - Ratchets SL on profit ticks (`_update_dynamic_thresholds` -> `_place_sl_stop_order`).
  - Detects TP/SL fills and fallback reasons (`_check_tp_order_filled`, `_check_sl_order_filled`, `_detect_market_fallback_reason`).
  - Runs websocket/polling monitors with bracket-mode guards.
- Imported by: `backend/api_server.py`, `backend/main.py`, `backend/position_monitor_loop.py`, `backend/tools/test_qp_guard.py`.
- Notes: this is the highest-complexity runtime module and primary exit correctness surface.

## 11) backend/order_execution.py

- Role: broker order wrapper + in-memory position/live-exit registry owner.
- Key behavior:
  - Registry lifecycle: `register_position`, `mark_selling`, `close_position`, `get_open_positions`, `get_live_positions`.
  - Live-state updates: `update_live_exit_state`, `set_live_exit_reason`.
  - Order placement: `place_market_order` (market/limit/bracket handling), `wait_for_fill`, safety-SL upsert helper.
- Imported by: `backend/api_server.py`, `backend/main.py`, `backend/monitoring.py`, `backend/position_monitor_loop.py`, and self-import inside function.
- Notes: contains a limit-order branch bug for BUY path (details in risk section).

## 12) backend/position_monitor_loop.py

- Role: background generic monitor service for broker-open positions not already owned by dedicated monitors.
- Key behavior:
  - Discovers open positions periodically.
  - Skips symbols already managed by registry/dedicated monitors.
  - Uses `monitor_with_websocket` then `monitor_with_polling` for option contracts.
  - Closes via broker `close_position` with fallback sell path and logs MONITOR_EXIT docs.
- Imported by: `backend/api_server.py`.
- Notes: acts as catch-all safety net for orphaned open positions.

## 13) backend/rsi_analyer.py

- Role: technical-indicator engine and optional standalone analyzer runner.
- Key behavior:
  - Fetches recent bars from Alpaca.
  - Computes RSI, RSI MA, EMA cross/regime, MACD cross, Bollinger bands, candle/price-structure, volume ratio/unavailability, VWAP alignment.
  - Returns rich `dict` consumed by signal logic and UI readiness.
- Imported by: `backend/api_server.py`, `backend/main.py`, `backend/monitoring.py`.
- Notes: also includes standalone websocket/polling analyzer modes (`main`) for diagnostics.

## 14) backend/strategy_helpers.py

- Role: entry decision arbiter.
- Key behavior: three-tier entry pipeline (`classify_regime` -> setup A/B/C detectors -> confluence scoring) and `determine_signal` output including `entry_info` metadata.
- Imported by: `backend/api_server.py`, `backend/main.py`, `backend/market_data.py`.
- Notes: this is the active gate used by runtime entry loops.

## 15) backend/strategy_mode.py

- Role: persisted enable/disable control for entry strategy IDs in `backend/logs/strategy_modes.json`.
- Key behavior: default provisioning, normalization, read/update with lock.
- Imported by: `backend/api_server.py`, `backend/main.py`, `backend/tools/backtest.py`.
- Notes: defaults to `RSI_CROSSOVER` only unless changed.

## 16) backend/symbol_mode.py

- Role: persisted per-symbol mode source of truth (`auto`, `manual`, `off`) in `backend/logs/symbol_modes.json`.
- Key behavior: default filling based on config watchlist + AIT/MT gates, atomic writes, fresh-read mode resolution.
- Imported by: `backend/api_server.py`, `backend/main.py`.
- Notes: critical gate that prevents AIT execution when symbol is `manual`/`off`.

## 17) backend/strategy_rsi_crossover.py

- Role: simple detector module returning CALL/PUT triggers on RSI MA cross with minimum gap.
- Imported by: `backend/api_server.py`, `backend/tools/backtest.py`.
- Notes: currently a lightweight strategy plugin.

## 18) backend/strategy_ema_crossover.py

- Role: detector for fresh EMA9/EMA21 cross events with fallback to boolean flags.
- Imported by: `backend/api_server.py`, `backend/tools/backtest.py`.
- Notes: no direct order logic; detection only.

## 19) backend/strategy_rsi_mean_reversion.py

- Role: detector for RSI mean-reversion crossings around oversold/overbought thresholds.
- Imported by: `backend/api_server.py`, `backend/tools/backtest.py`.
- Notes: independent plugin detector.

## 20) backend/strategy_macd_crossover.py

- Role: detector for MACD cross up/down flags.
- Imported by: `backend/api_server.py`, `backend/tools/backtest.py`.
- Notes: independent plugin detector.

## 21) backend/strategy_bollinger_bands.py

- Role: detector for Bollinger-based re-entry conditions.
- Imported by: `backend/api_server.py`, `backend/tools/backtest.py`.
- Notes: independent plugin detector.

## 22) backend/cape_order_manager.py

- Role: alternative order-management subsystem with `CapeOrderState` and profit/loss mode calculations.
- Imported by: `backend/cape_order_monitor.py` only.
- Notes: not wired into active lane runtime path.

## 23) backend/cape_order_executor.py

- Role: alternative execution adapter for `CapeOrderManager` decisions.
- Imported by: `backend/cape_order_monitor.py` only.
- Notes: not wired into active lane runtime path.

## 24) backend/cape_order_monitor.py

- Role: integration layer for the alternative Cape order subsystem.
- Imported by: none.
- Notes: effectively dormant in current server execution path.

## 25) backend/tools/analyze_proof.py

- Role: ad-hoc Mongo analysis script for deep trade pattern reporting.
- Imported by: none.
- Notes: uses hardcoded local Mongo URI (`mongodb://localhost:27017/`) instead of shared config URI.

## 26) backend/tools/analyze_trades.py

- Role: quick Mongo trade diagnostics for recent loss/win pattern analysis.
- Imported by: none.
- Notes: executes on import (script style), not structured as reusable functions.

## 27) backend/tools/backtest.py

- Role: self-contained backtester for entry + exit logic using minute JSON bars.
- Key behavior: simulates TP/SL/QP ratchet and explicitly models QP guard failure scenario (`--fail-after`, `--grace-bars`).
- Imported by: none.
- Notes: useful for deterministic regression checks of exit-engine behavior without live Alpaca calls.

## 28) backend/tools/read_recent.py

- Role: quick script to print last 30 trades with summary and groupings.
- Imported by: none.
- Notes: script-style diagnostics; not test-harnessed.

## 29) backend/tools/test_config_check.py

- Role: quick config print/validation script.
- Imported by: none.
- Notes: uses absolute `sys.path.insert(...)` tied to one machine path.

## 30) backend/tools/test_qp_guard.py

- Role: unit tests for `_detect_market_fallback_reason` Condition 5 (QP replacement-failure guard).
- Imported by: none.
- Notes: stubs heavy dependencies and validates timer/fire/reset behaviors for QP guard.

Note: filesystem scan shows 30 Python files (including `backend/config.py`). This section covers all 30 discovered Python files end-to-end.

# ENTRY FLOW

There are three entry channels in active runtime, all converging into the same monitor/order stack.

1) AIT entry (`api_server.py` -> `_ait_trade_loop`)

- Reads symbol mode (`get_mode(symbol)`) and exits early unless mode is `auto`.
- Calls `analyze_rsi(symbol)` and then `determine_signal(rsi_result, current_price)`.
- Enforces duplicate-bar and cooldown gates (`last_traded_bartime`, `cooldown_bars_remaining`).
- Uses cached preselected contract metadata (`_ait_contract_cache`) or refreshes selection with `_refresh_ait_contract_cache` and `select_best_contract`.
- Places BUY via `place_market_order(... use_bracket=EXIT_BRACKET_QP_ENABLED ...)`.
- Waits for fill (`wait_for_fill`), computes TP/SL (`compute_tp_price`, `compute_sl_price`), and registers lot (`register_position`).
- Hands off to `monitor_with_websocket` and fallback `monitor_with_polling`.

2) Manual entry (`api_server.py` -> `/api/manual-trade/buy`)

- Places immediate BUY (`place_market_order`) for supplied option contract.
- Waits for fill and resolves price fallback via `get_option_price` if needed.
- Registers lot in registry for UI visibility.
- Starts `_manual_trade_monitor_thread` that uses same monitor functions and lifecycle handling.

3) Startup recovery entry (`api_server.py` -> `_recover_open_positions`)

- On startup, enumerates Alpaca open positions.
- Parses option symbols and reconstructs context (underlying/signal/entry references).
- Registers each recovered lot and starts `_recovery_monitor_thread`.

Shared entry metadata flow:

- `entry_info` from `determine_signal` carries `filters_passed`, `reasons`, `entry_strategies`, and indicator snapshots.
- This data is persisted into Mongo/CSV logs by AIT and manual/recovery logging branches.

# STOP LOSS LIFECYCLE

SL lifecycle is centered in `monitoring.py` and tracked in `exit_state` fields.

1) Initialization

- `_init_exit_state(fill_price, tp_price, sl_price)` computes:
  - `sl_static_pct` from initial SL.
  - `sl_dynamic_pct` initialized to static value.
  - `confirmed_sl_price` initialized to entry SL price.
  - broker-order tracking fields (`sl_order_ids`, `sl_last_placed_pct`, `sl_order_filled`).

2) Broker order seeding/adoption

- `_seed_bracket_exit_orders` attempts to discover child TP/SL IDs from bracket parent.
- `_adopt_existing_broker_sl` scans open broker sell-stop orders and adopts best candidate when local state is missing IDs.

3) Placement and replacement

- `_place_sl_stop_order` places or replaces broker-side stop/stop-limit sell.
- Replacement chain includes:
  - replace by id
  - fallback stop-only
  - error-specific handlers (`held_for_orders`, option eligibility errors, stale order state)
  - cancel-then-fresh fallback
- `sl_last_placed_pct` updates only on verified placement success.

4) Dynamic ratchet updates

- `_update_dynamic_thresholds` runs each tick.
- Profit ticks compute new candidate from:
  - `qp_price = current_price - CAPE_QP_OFFSET`
  - `trailing_sl = current_price - CAPE_TRAILING_SL_OFFSET`
  - SL ratchet via max(existing, qp, trailing) in long flow
- Calls `_place_sl_stop_order` to synchronize broker SL to ratcheted level.

5) Fill detection and closure

- `_check_sl_order_filled` polls broker order status for tracked SL IDs.
- On fill, monitor returns `STOP_LOSS_EXIT` (or stored SL reason), and caller marks registry state and logs trade.

6) Fallback when SL path is unsafe

- `_detect_market_fallback_reason` covers multiple failure modes including:
  - terminal/rejected SL order state
  - SL gap-down miss below limit
  - triggered-but-unfilled timeout
  - broker status unconfirmable at trigger zone
  - QP replacement-failure guard (`QP_SL_REPLACE_FAILED_MARKET_EXIT`) with grace timer
- On fallback reason, monitor cancels outstanding exits and caller submits market close.

# TAKE PROFIT FLOW

TP lifecycle combines bracket child fills and explicit TP-limit placement logic.

1) TP target source

- `compute_tp_price(entry_price)` in `config.py` derives absolute TP based on mode (`price` or `pct`).
- Runtime generally uses configured `EXIT_TAKE_PROFIT_MODE = "price"` in current config.

2) Bracket TP path

- Entry BUY may be submitted with bracket legs when enabled.
- `_seed_bracket_exit_orders` tracks TP child IDs into `tp_order_ids`.
- `_check_tp_order_filled` polls broker and marks:
  - `tp_order_filled = True`
  - `tp_order_id_filled`
  - `tp_order_fill_price`

3) Explicit TP limit placement path

- `_attempt_place_tp_limit` is used when TP is triggered in price mode but no TP child exists.
- First attempt keeps SL active (preferred safety).
- If broker blocks due to held quantity, function does single-shot retry after canceling SL (`tp_retry_done` guard avoids loop).

4) Bracket TP-miss safety guard

- In bracket-only mode (where internal `_evaluate_priority_exit` is skipped), monitor checks:
  - price >= `tp_price`
  - no `tp_order_ids`
  - no TP fill recorded
- If true, triggers market exit as `TAKE_PROFIT_EXIT` to avoid missing realized profit due to missing TP child.

# EXIT LOGIC

Exit priority and behavior differ by mode.

1) Shared primitives

- `_evaluate_priority_exit` evaluates:
  - TP condition
  - SL condition (using dynamic trigger level)
  - optional trailing stop condition
- `monitor_with_websocket` is primary; `monitor_with_polling` is fallback.

2) Bracket-only mode (`use_bracket_exit = True`)

- Internal discretionary exits are intentionally bypassed after protective checks.
- Main exit sources are:
  - broker TP child fill
  - broker SL child fill
  - explicit fallback reasons from `_detect_market_fallback_reason`
  - TP miss guard market exit
- `_ensure_exit_coverage` runs per tick to restore at least one active exit order if both TP and SL IDs disappear.

3) Non-bracket mode

- Internal `_evaluate_priority_exit` can return direct reasons like `TAKE_PROFIT_EXIT`, `STOP_LOSS_EXIT`, `TRAILING_STOP_EXIT`.
- Additional policy exits can fire:
  - `BAD_ENTRY_EXIT`
  - `MAX_HOLD_TIME_EXIT`
  - `MOMENTUM_STALL_EXIT`
  - optional RSI opposite cross via `log_rsi_snapshot`.

4) Caller-level execution and registry transition

- `api_server.py` monitor loops enforce idempotent close handling:
  - if TP/SL broker fill already happened, do not place new sell
  - otherwise, market fallback sell and wait for fill
- Registry transitions should follow `mark_selling` then `close_position`.

# ERROR HANDLING MATRIX

| Failure scenario | Where handled | Current behavior | Residual risk |
|---|---|---|---|
| Websocket quote stream unavailable/no first quote | `monitor_with_websocket` | switches to polling fallback and sets cooldown window | transient blind spot between stream failure and polling tick |
| Broker SL replace rejected (`held_for_orders`) | `_place_sl_stop_order` | adopt/cancel/retry chain, including cancel-then-fresh fallback | repeated broker rejects can still degrade to `sl_broker_disabled` |
| TP placement conflicts with SL-held qty | `_attempt_place_tp_limit` | first keep SL, then single-shot SL-cancel retry (`tp_retry_done`) | if retry fails, TP may remain absent; relies on fallback guards |
| Missing/invalid TP/SL order state near trigger | `_detect_market_fallback_reason` | returns `ORDER_SYSTEM_FAILURE_MARKET_EXIT` -> market close | market fill slippage possible in fast tape |
| Gap below SL limit | `_detect_market_fallback_reason` | returns `SL_MISSED_GAPDOWN_MARKET_EXIT` -> market close | guaranteed floor is lost in gap scenario |
| QP ratchet ahead of broker SL due replace failure | `_detect_market_fallback_reason` | grace-timed `QP_SL_REPLACE_FAILED_MARKET_EXIT` | still dependent on market sell execution quality |
| Mongo unavailable at startup (required mode) | `logger.init_mongo`, config gates | raises `SystemExit` when `MONGO_REQUIRED=True` | system hard-stops even for read-only use cases |
| Stale/insufficient bar data | `rsi_analyer.analyze_rsi` | raises runtime error; callers catch and continue/mark error | repeated stale data blocks entries and readiness scoring |
| close_position fallback failures | `position_monitor_loop.close_position` and caller retry loops | retries market close paths | prolonged broker/API outage leaves positions exposed |
| Invalid mode/strategy writes | `symbol_mode.py`, `strategy_mode.py` | validates against allowed sets and raises `ValueError` | no API-level transactional rollback across combined mode changes |

# STATE MANAGEMENT

Primary state stores and ownership:

1) Trade lot registry (`order_execution.py`)

- `_positions`: keyed by `buy_order_id`, tracks static trade metadata and status (`OPEN`, `SELLING`, `CLOSED`).
- `_live_exit_states`: keyed by `buy_order_id`, tracks tick-updated live values (PnL, dynamic thresholds, TP/SL order IDs, timeline tail, flags).
- Locks: `_positions_lock`, `_live_exit_lock`.

2) Exit-state per monitor instance (`monitoring.py`)

- `exit_state` dict is local to each monitor thread/flow and includes:
  - thresholds (`tp_pct`, `sl_static_pct`, `sl_dynamic_pct`, `qp_dynamic_pct`)
  - broker linkage (`tp_order_ids`, `sl_order_ids`, fill markers)
  - sync markers (`sl_last_placed_pct`, `confirmed_sl_price`, `sl_broker_disabled`)
  - timeline list of structured ticks/events.

3) AIT runtime globals (`api_server.py`)

- `_ait_threads`: per-symbol background thread registry.
- `_ait_contract_cache` with lock: preselected contracts per symbol and signal.
- `_ait_straddle_done` with file-backed persistence: ensures once-per-day straddle execution.
- `_startup_recovery_status` with lock: startup recovery status exposed via `/api/live-positions`.

4) Mode persistence

- Symbol mode file: `backend/logs/symbol_modes.json` (`symbol_mode.py`).
- Strategy mode file: `backend/logs/strategy_modes.json` (`strategy_mode.py`).

5) Straddle status persistence

- `_straddle_col` in Mongo stores per-symbol/day straddle tracking fields (`status`, `move_pct`, highs/lows/current).

State consistency design strengths:

- Atomic JSON writes (tmp then replace) in mode managers.
- Centralized live position merge for API responses (`get_live_positions`).
- Explicit startup recovery status structure for UI transparency.

State consistency weak spots:

- Multiple concurrent monitor systems exist (dedicated monitor threads + generic position monitor), requiring careful symbol ownership checks to avoid duplicate closes/logs.
- Duplicate engine implementations (`api_server.py` and `main.py`) can drift in state semantics.

# DATA FLOW TRACE

## Trace A: AIT auto trade (runtime lane)

1. `api_server.py` startup creates per-symbol AIT threads.
2. `_ait_trade_loop(symbol)` reads analyzer data (`analyze_rsi`) and entry decision (`determine_signal`).
3. Contract comes from `_ait_contract_cache` or `select_best_contract` refresh.
4. BUY submitted via `place_market_order` and filled by `wait_for_fill`.
5. TP/SL computed (`compute_tp_price`, `compute_sl_price`); lot registered (`register_position`).
6. Exit monitor starts (`monitor_with_websocket` -> fallback `monitor_with_polling`).
7. Monitor updates live state each tick (`update_live_exit_state`), manages broker orders, and decides exit reason.
8. Caller resolves final sell path (broker fill already happened or market fallback).
9. Registry closure (`mark_selling`, `close_position`) and Mongo log (`log_trade("AIT", doc)`).
10. `/api/live-positions`, `/api/options-log`, and frontend pages consume merged state/history.

## Trace B: Manual trade via API

1. UI calls `/api/manual-trade/buy`.
2. Server submits BUY and waits for fill.
3. Position registered in registry for real-time UI visibility.
4. `_manual_trade_monitor_thread` runs same monitor stack and closes when exit condition finalizes.
5. Trade logged as `MANUAL` with timeline and exit metrics.

## Trace C: Startup recovery

1. Startup calls `_recover_open_positions`.
2. Open broker positions are parsed and mapped to option metadata.
3. Positions registered into registry with `trade_type="RECOVERY"`.
4. Dedicated recovery monitor thread handles exit and logs `RECOVERY` docs.

## Trace D: Display lane

1. Frontend calls display backend on 8002.
2. `api_server_display.py` forwards request to trading lane 8001.
3. Response body/status/content-type proxied back to UI.

# EXECUTION TRACE (REAL)

## Trace 1: AIT trade, function-by-function, runtime order

1. `_ait_symbol_thread(symbol)` starts the daily loop and calls `_ait_trade_loop(symbol, sc, odc, tc)` while market is open.
2. `_ait_trade_loop` runs per check cycle:
  - `rsi_result = analyze_rsi(symbol)`
  - `current_price = float(rsi_result["close_price"])`
  - `signal, contract_type, order_side, entry_info = determine_signal(rsi_result, current_price)`
3. Contract resolution path:
  - cache read: `contract_meta = _get_ait_contract_for_signal(symbol, signal, expiry)`
  - cache miss: `_refresh_ait_contract_cache(...)` then re-read
  - selected contract symbol enters `contract_symbol`
4. Pre-entry option price probe (best effort):
  - `entry_signal_price = get_option_price(odc, contract_symbol)`
5. BUY request sent:
  - `buy_order = place_market_order(tc, contract_symbol, QTY, order_side, ...)`
6. Fill tracking loop starts:
  - `filled_buy = wait_for_fill(tc, str(buy_order.id), FILL_WAIT_SEC)`
  - loops with `get_order_by_id`, exits on `FILLED`, terminal status, or timeout snapshot
7. Post-fill normalization:
  - `fill_price = float(filled_buy.filled_avg_price or get_option_price(...))`
  - `tp_price = compute_tp_price(fill_price)`
  - `sl_price = compute_sl_price(fill_price)`
  - `rsi_buy_order_id = str(buy_order.id)`
8. Registry write:
  - `register_position(...)` writes lot to `_positions`
  - initializes live state in `_live_exit_states`
9. Exit monitor creation and handoff:
  - websocket first: `monitor_with_websocket(... buy_order_id=rsi_buy_order_id, buy_entry_order_id=rsi_buy_order_id, qty=QTY)`
  - fallback poller if websocket returns no exit: `monitor_with_polling(... initial_exit_state=exit_state, ...)`
10. Inside monitor startup:
  - `exit_state = _init_exit_state(fill_price, tp_price, sl_price)`
  - `_seed_bracket_exit_orders(tc, exit_state, buy_order_id)`
  - if no SL tracked and broker enabled: `_place_sl_stop_order(...)`
11. Inside monitor tick loop:
  - price update and `pnl_pct` update
  - `_update_dynamic_thresholds(...)` (SL ratchet candidate calculation)
  - `_ensure_exit_coverage(...)`
  - `_check_tp_order_filled(...)` and `_check_sl_order_filled(...)`
  - `_detect_market_fallback_reason(...)`
  - `update_live_exit_state(...)` for frontend state
12. Exit decision return to caller:
  - broker-child fill path OR fallback/internal reason path
13. Final close execution in `_ait_trade_loop`:
  - if TP/SL already broker-filled: use broker fill IDs/prices
  - else force SELL submit via `place_market_order(... side=SELL, allow_limit=False)` and `wait_for_fill`
14. Registry close transition:
  - `mark_selling(rsi_buy_order_id, rsi_sell_order_id)`
  - `close_position(rsi_buy_order_id)`
15. Persistence and audit:
  - insert `_ait_doc` into Mongo
  - `log_trade("AIT", _ait_doc)`

## Trace 2: Manual buy API, runtime order

1. `/api/manual-trade/buy` receives `contract_symbol`, `underlying`, `qty`.
2. BUY submit via `place_market_order(...)`.
3. Fill loop via `wait_for_fill(...)`.
4. `register_position(...)` updates `_positions` and `_live_exit_states`.
5. `_manual_trade_monitor_thread(...)` starts.
6. Thread runs `monitor_with_websocket` then `monitor_with_polling` fallback.
7. On reason resolution, thread either accepts broker child fill or triggers market fallback close.
8. Thread writes manual trade doc and `log_trade("MANUAL", doc)`.

## Trace 3: Startup recovery, runtime order

1. `app startup` calls `_recover_open_positions()`.
2. Broker open positions enumerated via `trading_client.get_all_positions()`.
3. Each option position parsed by `_parse_option_contract`.
4. Immediate thresholds checked against `compute_tp_price` and `compute_sl_price`.
5. Non-immediate-close positions are `register_position(...)` with trade type `RECOVERY`.
6. `_recovery_monitor_thread(...)` launched per recovered lot.
7. Recovery monitor follows the same monitor stack and close semantics as AIT/manual, then logs `RECOVERY` trade docs.

# FAILURE ANALYSIS BY STEP

| Step | Function | What can break | Existing handling | Remaining gap |
|---|---|---|---|---|
| Signal compute | `analyze_rsi` | stale/no bars, feed outage | raises and caller retries/marks error | repeated stale data halts entries |
| Signal gate | `determine_signal` | regime/setup mismatch, no trigger | returns `(None, None, None, None)` | no probabilistic confidence persisted for rejected signals |
| Contract lookup | `_get_ait_contract_for_signal` + `_refresh_ait_contract_cache` | cache miss, no liquid contract | refresh + skip cycle | repeated misses increase no-trade windows |
| BUY submit | `place_market_order` | API reject, bracket unsupported, payload issues | bracket fallback path exists | limit BUY path can fall through to market in one branch |
| Fill loop | `wait_for_fill` | slow fill, partial fill, status drift | loops until terminal/timeout | partial fills are not separately modeled in trade state |
| Registry write | `register_position` | missing/invalid IDs, qty anomalies | strict map write and int conversion | synthetic recovery IDs can weaken parent-child bracket seeding |
| WS monitor start | `monitor_with_websocket` | stream unavailable, lock busy, no first quote | returns fallback to polling | global lock serializes WS monitor concurrency |
| SL lifecycle | `_place_sl_stop_order` | held qty conflicts, 403/422 errors, stale order IDs | adopt/replace/cancel-then-fresh chain | repeated rejects can force market-fallback dependence |
| TP lifecycle | `_attempt_place_tp_limit` | held qty conflict, missing TP child | single retry with `tp_retry_done` | if retry fails, TP may remain absent until other guards fire |
| Exit fallback | `_detect_market_fallback_reason` | order state missing or unfillable stop | explicit fallback reasons to market close | market exit exposes slippage and spread risk |
| Final SELL | `place_market_order` + `wait_for_fill` | not filled quickly, broker latency | retry loops in caller paths | no separate partial-fill reconciliation document path |
| Post-close logging | Mongo writes + `log_trade` | Mongo transient errors | guarded with try/except in many paths | audit gaps possible if write fails after close |

# STATE TRANSITIONS

## `_positions` lifecycle (authoritative lot state)

```text
UNREGISTERED
  -> OPEN        (register_position)
  -> SELLING     (mark_selling)
  -> CLOSED      (close_position)

OPEN
  -> CLOSED      (external broker close observed and reconciled)
```

## `exit_state` lifecycle (per-monitor runtime state)

```text
INIT
  -> SEEDED_CHILD_IDS          (_seed_bracket_exit_orders success)
  -> ADOPTED_BROKER_SL         (_adopt_existing_broker_sl path)
  -> FRESH_SL_PLACED           (_place_sl_stop_order success)

ACTIVE_LOOP
  -> SL_RATCHET_UPDATE         (_update_dynamic_thresholds)
  -> TP_FILLED                 (_check_tp_order_filled)
  -> SL_FILLED                 (_check_sl_order_filled)
  -> FALLBACK_REASON_SET       (_detect_market_fallback_reason)
  -> INTERNAL_EXIT_REASON_SET  (_evaluate_priority_exit, non-bracket path)

EXITING
  -> CANCEL_EXIT_ORDERS        (_cancel_exit_orders)
  -> RETURN(reason, price)     (monitor returns to caller)
```

## Order lifecycle (BUY + child exits)

```text
BUY_SUBMITTED
  -> FILLED
  -> CANCELED/EXPIRED/REJECTED
  -> TIMEOUT_SNAPSHOT

TP/SL_CHILD_PLACED
  -> REPLACED (SL ratchet)
  -> FILLED
  -> CANCELED/REJECTED/EXPIRED
  -> MARKET_FALLBACK_CLOSE (if child path fails)
```

# ORDER OWNERSHIP RULES

1. `api_server.py` owns trade orchestration:
  - entry decision
  - BUY submit/fill wait
  - final close submit path when monitor returns non-filled reason
2. `monitoring.py` owns exit decisioning and protective-order management:
  - builds and mutates `exit_state`
  - manages TP/SL child IDs and SL ratchet replacement
  - returns `exit_reason`, `exit_price`, `exit_state` to caller
3. `order_execution.py` owns in-memory lot registry and live state broadcast structures:
  - `_positions`
  - `_live_exit_states`
4. `position_monitor_loop.py` owns orphan-position safety closure only:
  - should skip symbols already managed by dedicated trade monitors
  - acts as backstop for broker-open positions absent from registry ownership

Single-writer expectation for a lot:

- Only one dedicated monitor path should own exit execution for a given live lot.
- Generic position monitor should not compete with a lot already present in `_positions`.

# CONCURRENT SYSTEM INTERACTIONS

## Conflict Zone 1: websocket monitor vs polling monitor

- Intended behavior: sequential fallback, not simultaneous ownership.
- Real behavior: websocket returns `None` on lock/cooldown/stream issues; caller then starts polling.
- Risk window: stream teardown timing can overlap with fallback startup in edge conditions.

## Conflict Zone 2: dedicated monitor threads vs generic `position_monitor_loop`

- Dedicated owners: AIT thread, manual monitor thread, recovery monitor thread.
- Generic owner: `position_monitor_loop` for broker-open orphan positions.
- Collision controls already present:
  - `get_externally_managed_symbols()` skip set
  - `managed_symbols` filtering in `run_monitor_all_positions`
  - pre-close recheck in `monitor_position_loop`
- Residual risk: symbol-level ownership can still be coarse when multiple lots share one contract symbol.

## Conflict Zone 3: TP and SL broker order contention

- Broker may allow only one effective open sell context for certain option states.
- `held_for_orders` handling and adoption logic in `_place_sl_stop_order` and `_attempt_place_tp_limit` reduce churn.
- Residual risk: transient cancellations can create short unprotected windows before replacement confirmation.

## Conflict Zone 4: broker state vs local state divergence

- Local maps can lose child order IDs after restarts or API inconsistency.
- Mitigations:
  - `_seed_bracket_exit_orders`
  - `_adopt_existing_broker_sl`
  - `related_orders` adoption path
  - `_ensure_exit_coverage`
- Residual risk: eventual consistency delays in broker order views can still delay reconciliation.

# ENTRY QUALITY ANALYSIS

## Why false entries still happen (code-level)

1. VWAP fallback in regime classification:
  - `classify_regime` falls back to EMA stack + RSI when VWAP is unavailable.
  - This allows entries without full volume-weighted context.
2. Volume-unavailable scoring behavior:
  - `_confluence_score` awards the volume confluence point when `volume_unavailable=True`.
  - Missing volume data is treated as non-penalizing.
3. Confluence threshold permissiveness:
  - `ENTRY_CONFLUENCE_MIN_SCORE = 2` allows approval with partial alignment.
4. Setup C momentum focus can trigger without pullback context:
  - strict RSI momentum can still enter late in fast moves when structural context is weaker.
5. Legacy and UI readiness mismatch risk:
  - `/api/signal-readiness` computes a scorecard that is informative but separate from direct `determine_signal` gate.
  - Operators can read high readiness while runtime still rejects due to hard-veto conditions.

## Existing anti-noise protections

1. Hard CHOP rejection in `determine_signal`.
2. Regime -> setup -> confluence staged gate.
3. RSI overextension vetoes in `_confluence_score`.
4. Duplicate-bar block and cooldown bars in AIT loop.

## Remaining entry-quality blind spots

1. No persisted reason taxonomy for rejected opportunities by symbol/time bucket.
2. No post-trade feedback loop that auto-adjusts setup priority or confluence thresholds.
3. No spread/liquidity gating in final entry approval after contract selection (beyond volume heuristics).

# PERFORMANCE + SCALING

## Threading and monitor fan-out

1. One AIT thread per enabled symbol (`_start_ait_threads`).
2. One monitor thread per manual trade and per recovery trade.
3. One background generic position monitor service plus per-orphan position monitor threads.

## Hard scaling constraints in current code

1. Global websocket monitor lock:
  - `_WS_MONITOR_LOCK` allows only one active `monitor_with_websocket` owner per process.
  - Additional trades fall back to polling.
2. Global SL placement lock:
  - `_SL_PLACEMENT_LOCK` serializes SL upsert/replace calls across monitors.
3. Heavy readiness endpoint path:
  - `/api/signal-readiness` loops symbols and runs `analyze_rsi` + detectors per request.

## Data and API load considerations

1. Trade logging writes to Mongo and text/CSV after closes.
2. Straddle monitor updates Mongo every minute while open.
3. Live positions payload can grow due to timeline data (trimmed to last 300 ticks in live state mirror).

## Practical scaling implications

1. Increasing enabled symbols increases analyzer CPU and API call pressure linearly.
2. Concurrent open lots increase monitor-thread count and broker polling pressure.
3. WS lock means high-concurrency exit monitoring degrades to polling behavior under load.

# MARKET + INFRA RISKS

## Market-structure risks

1. Slippage on fallback market exits:
  - fallback reasons convert controlled exits into marketable sells.
2. Spread expansion in fast tape:
  - sellable price may diverge from mid rapidly during option volatility.
3. Gap risk through stop-limit floors:
  - code already detects `SL_MISSED_GAPDOWN_MARKET_EXIT`, but fill quality then depends on market liquidity.

## Broker/API risks

1. Alpaca order-view latency and eventual consistency:
  - child orders may exist at broker before local IDs are discoverable.
2. Replace-call race against price movement:
  - SL ratchet replacement can lag sudden reversal.
3. Partial fill behavior:
  - fill loop mainly tracks terminal status and timeout snapshots, not explicit partial-fill lifecycle docs.

## Transport and timing risks

1. Websocket delay or first-quote timeout can force polling fallback.
2. Polling granularity can miss fast intrabar threshold touches compared with tick stream.
3. Clock skew and timezone conversion issues can distort time-gated logic if host time drifts.

## Infra dependency risks

1. `MONGO_REQUIRED=True` can hard-stop startup when DB unavailable.
2. Multi-process startup/reload behavior can create duplicate service behaviors if deployed with reload flags.

## Risk-controls already present

1. Fallback reason matrix and forced-market safety exits.
2. Order adoption/reconciliation (`_adopt_existing_broker_sl`, related-order paths).
3. Coverage guard (`_ensure_exit_coverage`) to restore missing TP/SL protection.

# CRITICAL BUGS/RISKS

Severity is based on potential for incorrect trade execution or hidden production drift.

## High

1) BUY limit-order path can silently fall back to market

- File: `backend/order_execution.py`
- Evidence: `if allow_limit and ENTRY_ORDER_TYPE == "limit" ...` branch has `return _submit(LimitOrderRequest(...))` only in the SELL `else` path.
- Impact: for BUY with limit mode enabled, code computes `limit_price` but falls through to market submission.
- Risk: execution-price control loss when user expects limit-entry behavior.

2) Duplicate function definition in trade server

- File: `backend/api_server.py`
- Evidence: `_poll_straddle_call_call_day` appears twice.
- Impact: first implementation is dead/overwritten, increasing maintenance risk and merge-conflict ambiguity.
- Risk: future edits to the first copy have no runtime effect.

3) Hardcoded secrets in repo config

- File: `backend/config.py`
- Evidence: plaintext `API_KEY`, `SECRET_KEY`, `MONGO_URI` constants.
- Impact: credential leakage risk and environment coupling.
- Risk: unauthorized access, accidental key exposure via source control or logs.

## Medium

4) Duplicated config constants with silent override behavior

- File: `backend/config.py`
- Evidence examples: repeated assignments for `EXIT_QUICK_PROFIT_ENABLED`, `QP_GAP_PCT`, `EXIT_TRAILING_STOP_ENABLED`, `SL_STOP_LIMIT_BUFFER_PCT`.
- Impact: effective runtime values may differ from what earlier section comments claim.
- Risk: tuning mistakes and inconsistent operator expectations.

5) Parallel engine implementations can drift

- Files: `backend/api_server.py`, `backend/main.py`
- Evidence: both implement substantial AIT loops and monitoring handoff.
- Impact: fixes made in one path may not exist in the other.
- Risk: environment-dependent behavior divergence.

6) Reload mode enabled on production-facing lane entrypoints

- Files: `backend/api_server_trading.py`, `backend/api_server_display.py` (and direct run in `api_server.py`).
- Impact: uvicorn reload mode can spawn watcher/reloader behavior not intended for production deployment.
- Risk: duplicate process behavior, startup complexity, performance overhead.

## Low

7) Display allowlist is currently declarative only

- File: `backend/api_server_display.py`
- Evidence: `DISPLAY_ALLOWLIST` is defined but not checked in middleware or forwarding utility.
- Impact: no actual route-allowlist enforcement beyond explicitly coded route handlers.

8) Tools are environment-coupled and script-style

- Files: `backend/tools/analyze_proof.py`, `backend/tools/test_config_check.py`, others.
- Impact: brittle portability and limited CI integration.

# UNUSED/REDUNDANT LOGIC

1) Unused Cape order subsystem in active runtime

- Files: `backend/cape_order_manager.py`, `backend/cape_order_executor.py`, `backend/cape_order_monitor.py`.
- Evidence: only imported among themselves; not referenced by `api_server.py` or lane startup paths.
- Result: substantial duplicate order-management logic is dormant.

2) Duplicate function body in `api_server.py`

- `_poll_straddle_call_call_day` duplicated.
- First copy is redundant at runtime.

3) Unused `DISPLAY_ALLOWLIST`

- Declared in display proxy file but not enforced.

4) Self-import inside `order_execution.py`

- `from order_execution import get_open_positions` appears inside `upsert_broker_safety_sl`.
- Redundant in same module and can be simplified to direct local function call.

5) Diagnostic scripts outside structured test harness

- Most `backend/tools/*.py` scripts are standalone analytics rather than reusable library/test modules.

# IMPROVEMENT RECOMMENDATIONS

1) Fix BUY limit branch in `place_market_order`

- Ensure the limit-order return path executes for both BUY and SELL in the `allow_limit` branch.
- Add unit tests for `ENTRY_ORDER_TYPE="limit"` BUY/SELL behavior.

2) Remove duplicate `_poll_straddle_call_call_day`

- Keep one canonical implementation and add a small regression test for call-day logic.

3) Normalize and de-duplicate `config.py`

- Remove repeated constants.
- Keep one authoritative definition per setting.
- Add startup validation that prints effective values for critical exit knobs.

4) Externalize secrets and enforce env-based loading

- Move credentials/URI to environment variables or secret manager.
- Fail fast if secrets are missing in non-dev mode.

5) Decide one canonical AIT engine entrypoint

- Either:
  - keep `api_server.py` as sole runtime engine and retire `main.py`, or
  - clearly scope one as test/dev-only and prevent accidental dual maintenance.

6) Enforce display route allowlist explicitly

- Add middleware/path check against `DISPLAY_ALLOWLIST` (or remove the constant if intentionally not needed).

7) Convert critical runtime invariants into tests

- Suggested test targets:
  - TP/SL coexistence guarantees in bracket mode.
  - SL replacement/adoption transitions under `held_for_orders` and 403 cases.
  - Coverage guard behavior when both TP and SL order IDs disappear.
  - Idempotent close path when broker child already filled.

8) Harden observability around close sequencing

- Add structured event IDs linking `buy_order_id`, monitor reason, broker order IDs, and final close action.
- This reduces ambiguity when multiple monitor services are active.

9) Improve tooling portability

- Remove absolute path insertion from `test_config_check.py`.
- Use shared config URI in `analyze_proof.py` instead of localhost literal.

# FINAL SYSTEM ASSESSMENT

Overall, the system is functionally rich and production-oriented in scope: dual-lane APIs, strong entry analytics, a sophisticated bracket-aware exit engine, recovery support, and live-state UI integration.

Current strongest area:

- Exit engine resiliency in `monitoring.py` with SL ratchet synchronization, order adoption, fallback reasoning, and bracket-mode guards.

Current highest-priority correctness gap:

- Entry order execution mismatch for limit BUY path in `order_execution.py`.

Architectural debt to address soon:

- duplicated runtime engines (`api_server.py` vs `main.py`), duplicated config constants, and dormant parallel order subsystem files.

Net assessment:

- Runtime design is advanced and close to robust, but a small set of high-impact code hygiene and correctness fixes should be completed before relying on it as a single authoritative production engine.