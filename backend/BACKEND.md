# Cape Backend Reference

## Overview

FastAPI-based automated options scalping engine for US markets (SPY, TSLA, etc.) using Alpaca as broker and MongoDB for trade lifecycle logging. Supports both Automated Intelligence Trading (AIT) and Manual Trading (MT) modes.

---

## Two-Lane API Design

| Port | File | Purpose |
|------|------|---------|
| 8001 | `api_server_trading.py` | Order-critical operations — AIT engine, position management, order writes |
| 8002 | `api_server_display.py` | Read-only proxy for UI traffic — charts, history, account info |

Both import from `api_server.py`. The split is traffic isolation only — same implementation behind both.

---

## File Reference

### Entry Points

**`app.py`**
Launches both FastAPI servers (8001 + 8002) as subprocesses. Does not start the trading loop — `main.py` must be run separately.

**`main.py`**
Main AIT trading loop. Runs every 5 seconds. Key functions:
- `main()` — core loop: analyze → signal → contract → order → monitor
- `execute_startup_straddle()` — optional CALL+PUT straddle at market open
- `acquire_instance_lock()` / `release_instance_lock()` — prevents duplicate bot instances
- `wait_for_market_open_today()` — blocks until market open (arms 5 min early)

**`api_server.py`**
All FastAPI route definitions. Key endpoint groups:

| Group | Endpoints |
|-------|-----------|
| System | `GET /health` |
| Market Data | `GET /api/bars`, `GET /api/quotes` |
| Account | `GET /api/account`, `GET /api/positions` |
| Orders | `GET /api/orders/history`, `POST /api/orders`, `DELETE /api/orders/{id}` |
| Options | `GET /api/options/suggest`, `GET /api/options/price` |
| Trade Logs | `GET /api/options-log`, `GET /api/manual-trades` |
| Control | `POST /api/ai-trade/stop` |
| Symbol Modes | `GET /api/symbol/mode`, `POST /api/symbol/mode` |
| Strategies | `GET /api/strategies`, `POST /api/strategies/toggle` |
| Live Positions | `GET /api/live-positions` |
| Signal Readiness | `GET /api/signal-readiness` |
| WebSocket | `ws://localhost:8001/ws/quotes?symbols=SPY,QQQ` |

**`api_server_display.py`**
Thin proxy layer on port 8002. Uses persistent `httpx.AsyncClient` to forward reads to 8001. Only exposes non-mutating endpoints.

---

### Configuration — `config.py`

All trading behavior is controlled here. Never recompute prices inline — always use `compute_tp_price(entry_price)` and `compute_sl_price(entry_price)`.

**Core Mode Flags**

| Setting | Default | Effect |
|---------|---------|--------|
| `PAPER_TRADING` | `True` | Must flip to `False` for live money |
| `AIT_ENABLED` | `True` | Enables automated entry+exit |
| `MT_ENABLED` | `True` | Enables manual trading mode |
| `AIT_ENTRY_ENABLED` | `True` | Sub-control: bot generates entries |
| `AIT_EXIT_ENABLED` | `True` | Sub-control: bot manages exits |

**Risk / Exit Settings**

| Setting | Default | Effect |
|---------|---------|--------|
| `TAKE_PROFIT_PCT` | `0.25` | Absolute $0.25 above fill |
| `STOP_LOSS_PCT` | `0.50` | Absolute $0.50 below fill |
| `EXIT_BRACKET_QP_ENABLED` | `True` | Broker SL ratchet mode (primary) |
| `EXIT_QUICK_PROFIT_ENABLED` | `False` | Internal QP market sell (off; broker SL handles QP) |
| `EXIT_TRAILING_STOP_ENABLED` | `False` | Internal trailing SL market sell (off) |
| `CAPE_QP_OFFSET` | `0.01` | QP floor = current_price − $0.01 |
| `CAPE_TRAILING_SL_OFFSET` | `0.25` | Trailing SL = current_price − $0.25 |
| `SL_STOP_ORDERS_ENABLED` | `True` | Enables broker-side SL placement/replacement |
| `MIN_TRADE_DURATION_SEC` | `30` | No exits for 30s after fill |
| `POST_TRADE_COOLDOWN_BARS` | `5` | Bars blocked after any exit |

**Infrastructure**

| Setting | Default | Effect |
|---------|---------|--------|
| `MONGO_REQUIRED` | `True` | Bot exits at startup if Mongo unreachable |
| `PRICE_POLL_SEC` | `3` | Polling fallback interval |
| `CHECK_INTERVAL_SEC` | `5` | Main loop cadence |

---

### Analysis — `rsi_analyer.py`

Calculates 30+ indicators on 1-minute bars. Entry point: `analyze_rsi(symbol)`.

Returns dict with: `latest_rsi`, `previous_rsi`, `delta`, `latest_rsi_ma`, `base_trend`, `rsi_ma_cross_up`, `rsi_ma_cross_down`, `ema9`, `ema21`, `ema55`, `bar_time`, `volume_unavailable`, and full bar history.

Key notes:
- RSI: 14-period standard + 9-period signal MA
- EMAs: 9 (fast), 21 (medium), 55 (slow trend)
- `volume_unavailable` flag — IEX volume is often 0; check this flag before any volume-based filter

---

### Market Data — `market_data.py`

- `fetch_obr(symbol)` — Opening Bar Range (first 5 minutes)
- `fetch_current_price_1m(symbol)` — latest 1-minute bar close
- `get_option_price(contract)` — mid-price for a specific option
- `select_best_contract(symbol, direction, expiry)` — contract selection:
  - Searches ATM ± 2% (`STRIKE_RANGE_PCT`)
  - Requires `MIN_OPTION_VOLUME` (default 0)
  - Prefers most liquid; falls back to ATM; retries up to +7 days expiry

---

### Strategies

Each strategy module exposes `detect(rsi_result, current_price, ...)` → `(call_triggers, put_triggers)`.

| File | Strategy ID | Trigger | Default |
|------|-------------|---------|---------|
| `strategy_rsi_crossover.py` | `RSI_CROSSOVER` | RSI crosses RSI_MA + gap ≥ 3.0 | Enabled |
| `strategy_ema_crossover.py` | `EMA_CROSSOVER` | EMA9 crosses EMA21 | Disabled |
| `strategy_rsi_mean_reversion.py` | `RSI_MEAN_REVERSION` | RSI crosses 40/70 threshold | Disabled |
| `strategy_macd_crossover.py` | `MACD_CROSSOVER` | MACD signal line crossover | Disabled |
| `strategy_bollinger_bands.py` | `BOLLINGER_BANDS` | Price touches Bollinger Band | Disabled |

**`strategy_mode.py`** — persists enabled strategies to `logs/strategy_modes.json`. `ensure_defaults()` called at boot.

**`strategy_helpers.py`** — `determine_signal()` arbitrates across all enabled strategies; applies 13-layer entry filter stack; provides expiry/timezone utilities.

---

### Order Execution — `order_execution.py`

- `place_market_order()` — places BUY/SELL (market or limit); supports bracket orders (TP limit + SL stop-limit)
- `wait_for_fill(order_id)` — polls until filled or timeout
- `register_position(buy_order_id, ...)` — writes to in-memory registry
- `mark_selling()` → `close_position()` — state transitions (OPEN → SELLING → CLOSED); both must be called in order or positions leak
- `get_live_positions()` — merges `_positions` + `_live_exit_states` for API responses
- `upsert_broker_safety_sl()` — places/replaces SL stop order on Alpaca

---

### Exit Monitoring — `monitoring.py`

Most complex module. After fill, a monitoring loop runs on every price tick.

**Initialization**
- `_init_exit_state()` — builds exit state dict (TP price, SL price, QP tracking, timeline)
- `_seed_bracket_exit_orders()` — fetches bracket child IDs from Alpaca (3 retries × 0.4s)

**Per-Tick Execution Order**
1. `_update_dynamic_thresholds()` — always runs; ratchets `sl_dynamic_pct` upward on profit ticks
2. `_place_sl_stop_order()` — called inside step 1; replaces broker SL at new QP level
3. `_check_tp_order_filled()` / `_check_sl_order_filled()` — polls Alpaca for bracket fills
4. `_detect_market_fallback_reason()` — safety net; forces market exit on failure cases
5. `_evaluate_priority_exit()` — only runs when `use_bracket_exit = False`

**Bracket Mode**
When `EXIT_BRACKET_QP_ENABLED = True`, `use_bracket_exit = True` is set.
- Skips `_evaluate_priority_exit` entirely — the `continue`/`return` guards in both `monitor_with_polling` and `monitor_with_websocket` must not be removed
- Exits happen via broker stop-limit, not internal market sells

**QP Ratchet Mechanics**
On each profit tick (`current_price > fill_price`):
```
qp_price         = current_price − CAPE_QP_OFFSET        ($0.01)
trailing_sl      = current_price − CAPE_TRAILING_SL_OFFSET ($0.25)
sl_candidate     = max(existing_sl, qp_price, trailing_sl)  # only ever increases
```
`_place_sl_stop_order()` replaces broker SL at the new level. When price reverses, broker SL triggers → fills at or better than limit price. Market exit only via `_detect_market_fallback_reason()`.

**`_place_sl_stop_order` Replacement Chain**
1. `replace_order_by_id(id, stop+limit)` — modify in place
2. `replace_order_by_id(id, stop only)` — if limit change rejected
3. Error handlers: `40310000`/ineligible → disable broker SL; `order is not open` → fresh placement; `held_for_orders` → cancel all + retry; `qty/notional` → notional → market fallback
4. Catch-all (unrecognized): cancel old + place fresh stop-limit
5. All fail: `sl_broker_disabled = True` → fallback detection becomes sole safety net

When replacement fails, `sl_last_placed_pct` stays stale → retry fires automatically on next profit tick.

**`_detect_market_fallback_reason` — All 5 Conditions**

| # | Code | Trigger |
|---|------|---------|
| 1 | `ORDER_SYSTEM_FAILURE_MARKET_EXIT` | Broker SL in terminal state (rejected/expired/canceled) |
| 2 | `SL_MISSED_GAPDOWN_MARKET_EXIT` | Stop triggered but market gapped below limit floor |
| 3 | `ORDER_SYSTEM_FAILURE_MARKET_EXIT` | Stop triggered but unfilled after 2-second grace |
| 4 | `ORDER_SYSTEM_FAILURE_MARKET_EXIT` | All `get_order_by_id` calls threw exceptions at trigger price |
| 5 | `QP_SL_REPLACE_FAILED_MARKET_EXIT` | `sl_dynamic_pct > 0` but broker SL is behind; price slides back to QP level for 2 seconds |

---

### Persistence Files

**`symbol_mode.py`** — per-symbol mode to `logs/symbol_modes.json`
Modes: `"auto"` (AIT), `"manual"` (MT), `"off"` (paused). `get_mode(symbol)` always reads from disk (no cache). Thread-safe.

**`strategy_mode.py`** — enabled strategies to `logs/strategy_modes.json`.

**`logger.py`** — multi-target logging:
- Text: `logs/trade.log`
- CSV: `logs/trade_log.csv`, `logs/ait_trades.csv`, `logs/manual_trades.csv`, `logs/straddle_trades.csv`
- MongoDB: `options_log`, `price_ticks` (if detailed logging), `order_changes`, `position_exits`

---

### Alpaca Compatibility — `alpaca_helpers.py`

Wrapper functions that normalize behavior across `alpaca-py` SDK versions:
- `build_stock_bars_request()` / `build_option_snapshot_request()`
- `extract_bars_for_symbol()` / `extract_snapshot_mid_price()`
- `handle_api_error()` — human-readable messages for 401/403/network errors
- `get_five_min_timeframe()` — SDK-safe timeframe construction

---

## Invariants — Never Break These

1. **Broker SL is the primary exit in bracket mode.** Do not route bracket-mode exits through `_evaluate_priority_exit`.
2. **SL only ratchets upward.** `sl_dynamic_pct = max(existing, candidate)`. Never reduce.
3. **One active sell order per contract at a time.** Alpaca rejects a second open sell. Always cancel old before placing new.
4. **`sl_last_placed_pct` gates replacement.** Updated only on successful placement. Stale = automatic retry next tick.
5. **`mark_selling()` then `close_position()` in order.** Skipping either leaks the position.
6. **Duplicate bar protection.** Same 1-minute bar never traded twice (`bar_time` tracked).
7. **`MONGO_REQUIRED = True` by default.** Bot will not start if Mongo is down.

---

## Log Diagnostics

| What to look for | File |
|------------------|------|
| SL replacement behavior | `logs/trade.log` — `[TRAIL SL STOP] Failed to upsert` or `(cancel-then-fresh)` |
| QP guard fires | `logs/trade.log` — `QP_SL_REPLACE_FAILED_MARKET_EXIT` |
| Trade history | `logs/ait_trades.csv` |
| Exit reasons | MongoDB `position_exits` collection |

---

## Dependencies (`requirements.txt`)

```
alpaca-py>=0.31.0
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
pydantic>=2.8.0
pymongo>=4.8.0
pandas>=2.2.0
requests>=2.31.0
httpx>=0.27.0
```
