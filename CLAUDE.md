# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Detailed Reference Docs

- [backend/BACKEND.md](backend/BACKEND.md) — Full backend reference: file map, all API endpoints, config table, exit state machine, QP ratchet mechanics, replacement chain, fallback conditions, invariants, log diagnostics
- [Frontend/FRONTEND.md](Frontend/FRONTEND.md) — Full frontend reference: routing, every page + component, API calls, chart props, dev setup

## What This Project Is

Cape is a production-grade automated options scalper for US markets (SPY, TSLA) using Alpaca as broker and MongoDB for trade lifecycle logging. It supports both Automated Intelligence Trading (AIT) and Manual Trading (MT) modes, with a React frontend for monitoring.

## How to Run

### Backend

```bash
cd cape/backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cd ..         # back to cape/
python app.py  # starts trading API :8001 and display API :8002
```

### Frontend (manual, separate terminal)

```bash
cd cape/Frontend
npm install
npm run dev   # http://localhost:5173
```

`app.py` only launches the two backend processes — the frontend is always started separately.

## Architecture That Spans Multiple Files

### Two-Lane Backend Design

The backend exposes two FastAPI servers from a single codebase:
- **Port 8001** (`api_server_trading.py`) — order-critical operations, AIT engine, position management
- **Port 8002** (`api_server_display.py`) — read-only proxy for UI traffic

Both import and re-expose `api_server.py`; the split is about traffic isolation, not separate implementations.

### AIT Trading Loop (`main.py`)

The main loop in `main.py:main()` runs every 5 seconds. The full data-to-order pipeline is:

```
analyze_rsi(symbol)          # rsi_analyer.py  — 30+ indicators on 1-min bars
  → determine_signal()       # strategy_helpers.py — arbitrates across enabled strategies
  → select_best_contract()   # market_data.py — ATM/1-step-ITM by volume
  → place_market_order()     # order_execution.py — bracket order with TP+SL child orders
  → register_position()      # order_execution.py — writes to in-memory position registry
  → monitor_with_websocket() # monitoring.py — runs exit logic per-tick until close
```

Signals come from independently-gated strategy modules (`strategy_rsi_crossover.py`, etc.). Only `RSI_CROSSOVER` is enabled by default; strategy enable/disable state is persisted to `logs/strategy_modes.json` by `strategy_mode.py`.

### Exit State Machine (`monitoring.py`)

This is the most complex module. After a fill, a monitoring loop runs on every price tick:

1. `_init_exit_state()` — builds the exit state dict (TP price, SL price, QP tracking, timeline)
2. `_update_dynamic_thresholds()` — ratchets `sl_dynamic_pct` upward when price is in profit; **always called regardless of bracket mode**
3. `_place_sl_stop_order()` — called inside `_update_dynamic_thresholds` on every profit tick to replace the broker-side SL order at the new QP level
4. `_check_tp_order_filled()` / `_check_sl_order_filled()` — poll Alpaca to detect when a broker order filled
5. `_detect_market_fallback_reason()` — safety net; forces a market sell when the SL stop-limit failed to fill **or** when the QP replacement failed and price has slid back to the QP trigger level (see QP Guard below)
6. `_evaluate_priority_exit()` — only reached when `use_bracket_exit = False`

### Bracket Mode vs. Internal Exit Mode

When `EXIT_BRACKET_QP_ENABLED = True` (current default), `use_bracket_exit = True` is set in exit state. This activates **bracket-only mode** in both monitors, which **skips `_evaluate_priority_exit` entirely**. This is intentional — exits happen via broker-side stop-limit orders, not internal market sells.

**Do not remove the bracket-only `continue`/`return` guards** in `monitor_with_polling` and `monitor_with_websocket`. The internal `_evaluate_priority_exit` fires market sells, which execute at unknown prices. The broker SL is a stop-limit with a defined floor price — that is the intended exit mechanism for profit-locking.

### QP Ratchet — How It Actually Works

The QP (Quick Profit) mechanism repurposes the bracket's SL child order as a profit-locking ratchet:

1. **Entry**: bracket order places TP limit + SL stop-limit at initial levels
2. **Each profit tick** (`current_price > fill_price`):
   - `qp_price = current_price - CAPE_QP_OFFSET` ($0.01)
   - `trailing_sl = current_price - CAPE_TRAILING_SL_OFFSET` ($0.25)
   - `sl_candidate = max(existing_sl, qp_price, trailing_sl)` — **only ever increases**
   - `_place_sl_stop_order()` replaces the broker SL at the new level via `replace_order_by_id`
3. **When price reverses**: the ratcheted SL stop-limit triggers on Alpaca → fills at or better than the limit price → `_check_sl_order_filled()` detects the fill → exit recorded
4. **Market sell** fires only via `_detect_market_fallback_reason()` — three cases: (a) gap-down miss where the stop-limit cannot fill, (b) SL triggered but unfilled after 2 seconds, or (c) QP replacement failed and price slides back to the QP trigger level (QP guard, `QP_SL_REPLACE_FAILED_MARKET_EXIT`)

**Why broker SL and not internal market sell**: a stop-limit has a defined `limit_price` floor, so the exit fills at or better than QP. A market sell at QP trigger time may fill materially lower if the option spread is wide or price is moving fast.

### `_place_sl_stop_order` Replacement Chain

When replacing the broker SL fails, the function works through a priority chain:

1. `replace_order_by_id(existing_id, stop+limit)` — modify in place
2. `replace_order_by_id(existing_id, stop only)` — if limit change rejected
3. Error-specific handlers: `40310000`/options-ineligible → disable broker SL; `order is not open` → fresh placement; `held_for_orders` → cancel all sells + retry; `qty or notional` → notional fallback → market fallback
4. **Catch-all** (unrecognized error): cancel the old order + place fresh standalone stop-limit — handles broker-specific rejections for bracket child modification that don't match known patterns
5. If all else fails: `sl_broker_disabled = True` → internal monitor and `_detect_market_fallback_reason` become the sole safety net

When `sl_last_placed_pct` is **not updated** (replacement failed), `profit_sl_replace` remains True on the next tick and the replacement is retried automatically. Check `logs/trade.log` for `[TRAIL SL STOP] Failed to upsert` or `(cancel-then-fresh)` lines to diagnose replacement behavior.

### `_detect_market_fallback_reason` — All Trigger Conditions

Called on every monitoring tick (polling: every `PRICE_POLL_SEC`; websocket: every `WS_ORDER_CHECK_SEC`). Returns `(reason_string, detail_string)` or `(None, None)`. When non-None, the caller cancels all TP/SL orders and places a market sell.

**Condition 1 — SL order in terminal state** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
The broker SL order is in `rejected`, `expired`, `canceled`, or `cancelled` status. The order cannot fill; a market sell is the only exit.

**Condition 2 — Gap-down miss** (`SL_MISSED_GAPDOWN_MARKET_EXIT`)
The SL stop-limit is active but `sellable_price <= stop_price` AND `sellable_price < limit_price`. The stop triggered but the market gapped below the limit floor, so the stop-limit cannot fill. Forced market exit immediately.

**Condition 3 — Triggered but unfilled** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
`sellable_price <= stop_price` (stop triggered) but the order has not filled after a 2-second grace period. The broker acknowledged the trigger but did not fill — treated as an order-system failure.

**Condition 4 — SL orders unconfirmable at trigger price** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
`sl_order_ids` is non-empty but every `get_order_by_id` call raised an exception (broker unreachable) AND `sellable_price` is at or below the `sl_dynamic_pct` trigger price. Fires only when price is in the triggered zone so normal above-SL ticks do not false-trigger.

**Condition 5 — QP replacement failure guard** (`QP_SL_REPLACE_FAILED_MARKET_EXIT`)
Fires when the QP ratchet has moved the internal `sl_dynamic_pct` to a profit level but the broker SL has not been successfully moved there — meaning some or all replacement attempts failed. This covers the full spectrum:
- *No replacement ever succeeded*: `sl_last_placed_pct` is still at the initial loss level (e.g., −50%) while `sl_dynamic_pct` is at +49%.
- *Partial ratchet success*: earlier replacements succeeded (e.g., to +10%, +30%) but the latest attempt (to +49%) failed, leaving `sl_last_placed_pct = +30%` while `sl_dynamic_pct = +49%`.

**Trigger condition** (all must be true simultaneously):
- `sl_dynamic_pct > 0.0` — internal SL has ratcheted into the profit zone
- `sl_last_placed_pct is not None` and `sl_last_placed_pct < sl_dynamic_pct` — broker SL is behind the current QP level
- `fill_price > 0` and `sl_broker_disabled = False`
- `sellable_price <= fill_price × (1 + sl_dynamic_pct / 100)` — price has slid back to the QP trigger price
- After a **2-second grace period** — the condition must hold continuously for 2 seconds before firing, filtering out transient bid/ask spread dips

**Grace timer lifecycle**:
- Timer (`qp_guard_trigger_seen_ts`) starts on the first tick where price is at/below the QP trigger and the broker SL gap exists.
- Timer **resets** (cleared) when either: (a) price recovers above the QP trigger, or (b) a replacement succeeds and `sl_last_placed_pct` catches up to `sl_dynamic_pct`. This prevents a stale timer from a prior failure window from causing an instant fire on the very next failure.
- After 2 seconds uninterrupted, the guard fires: `_cancel_exit_orders` clears all TP/SL orders, and the monitor returns `QP_SL_REPLACE_FAILED_MARKET_EXIT` — the caller (main AIT loop or position monitor) then places the market sell.

### Position Registry (`order_execution.py`)

Two module-level dicts hold all live state:
- `_positions` — registered trades keyed by `buy_order_id`, with status `OPEN → SELLING → CLOSED`
- `_live_exit_states` — per-tick exit thresholds, PnL snapshots, and order IDs for each open position

`get_live_positions()` merges both dicts for API responses. Any exit path (TP, SL, fallback) must call `mark_selling()` then `close_position()` in order, or the position leaks into `get_open_positions()`.

## Configuration (`backend/config.py`)

All trading behavior is driven by `config.py`. Key knobs:

| Setting | Current | Effect |
|---|---|---|
| `PAPER_TRADING` | `True` | Must flip to `False` for live |
| `TAKE_PROFIT_PCT` | `0.25` | Absolute $0.25 above fill price |
| `STOP_LOSS_PCT` | `0.50` | Absolute $0.50 below fill price |
| `EXIT_BRACKET_QP_ENABLED` | `True` | Broker SL ratchet mode (primary exit via stop-limit) |
| `EXIT_QUICK_PROFIT_ENABLED` | `False` | Internal QP exit via market sell (off; broker SL handles QP) |
| `EXIT_TRAILING_STOP_ENABLED` | `False` | Internal trailing SL exit via market sell (off) |
| `CAPE_QP_OFFSET` | `0.01` | QP floor = current_price - $0.01 |
| `CAPE_TRAILING_SL_OFFSET` | `0.25` | Trailing SL = current_price - $0.25 |
| `SL_STOP_ORDERS_ENABLED` | `True` | Enables broker-side SL stop-limit placement/replacement |
| `POST_TRADE_COOLDOWN_BARS` | `5` | Bars blocked after any exit |
| `MIN_TRADE_DURATION_SEC` | `30` | No exit for 30s after fill |
| `MONGO_REQUIRED` | `True` | Bot exits at startup if Mongo unreachable |

`compute_tp_price()` and `compute_sl_price()` in `config.py` translate these settings into absolute prices. Always use these helpers rather than recomputing inline.

## Important Invariants

- **Broker SL is the primary exit in bracket mode.** `_evaluate_priority_exit` (and its market sells) is only for non-bracket mode. Do not route bracket-mode exits through `_evaluate_priority_exit`.
- **SL only ratchets upward.** `sl_dynamic_pct = max(existing_sl_pct, candidate_pct)`. Never reduce it, even in the loss zone.
- **One active sell order per contract at a time.** Alpaca rejects a second open sell order on the same option. Always cancel the old SL before placing a new one. `_place_sl_stop_order` handles this via `replace_order_by_id`; if replace is rejected, the catch-all does cancel-then-fresh.
- **`sl_last_placed_pct` gates replacement.** The broker SL is only replaced when `qp_price > sl_last_placed_price`. It is updated only on successful placement. If a replacement fails, `sl_last_placed_pct` stays stale and the retry fires on the next profit tick automatically.
- **Bracket seeding must happen before the first profit tick.** `_seed_bracket_exit_orders` fetches the bracket's child order IDs from Alpaca (3 retries × 0.4s). If it fails, an initial standalone SL is placed immediately after; this may trigger the `held_for_orders` handler which cancels all sell orders including the bracket TP child.
- **Duplicate bar protection.** The loop tracks the last-traded `bar_time`; the same 1-minute bar is never traded twice.
- **Cooldown after exit.** `cooldown_bars_remaining` is decremented each loop iteration. Entry is blocked until it reaches 0.
- **Instance lock.** `acquire_instance_lock()` in `main.py` prevents two bot processes from running against the same symbol simultaneously.
- **MongoDB is load-bearing.** With `MONGO_REQUIRED = True`, the bot won't start if Mongo is down. Disable the flag only for local dev without a DB.
- **IEX volume is often 0.** `volume_unavailable` flag in `analyze_rsi()` result signals this; volume-based entry filters should check this flag before rejecting a signal.
