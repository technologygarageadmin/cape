# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
5. `_detect_market_fallback_reason()` — safety net; forces a market sell when the broker SL has failed to fill, the QP replacement has fallen behind, or the position never became visible at the broker (see all conditions below)
6. `_evaluate_priority_exit()` — only reached when `use_bracket_exit = False`

### Bracket Mode vs. Internal Exit Mode

When `EXIT_BRACKET_QP_ENABLED = True` (current default), `use_bracket_exit = True` is set in exit state. This activates **bracket-only mode** in both monitors, which **skips `_evaluate_priority_exit` entirely**. This is intentional — exits happen via broker-side stop orders, not internal market sells.

**Do not remove the bracket-only `continue`/`return` guards** in `monitor_with_polling` and `monitor_with_websocket`. The internal `_evaluate_priority_exit` fires market sells from inside the polling loop, with the trigger-to-submit gap exposed to slippage. The broker stop is enforced atomically at the venue — that is the intended exit mechanism for profit-locking.

### QP Ratchet — How It Actually Works

The QP (Quick Profit) mechanism repurposes the bracket's SL child order as a profit-locking ratchet. Standalone SL replacements/fresh placements use **stop-market** (`StopOrderRequest`); the bracket's original SL child is whatever Alpaca sets on bracket creation.

1. **Entry**: bracket order places TP limit + SL child at initial levels
2. **Each profit tick** (`current_price > fill_price`):
   - `qp_price = current_price - CAPE_QP_OFFSET` ($0.01)
   - `trailing_sl = current_price - CAPE_TRAILING_SL_OFFSET` ($0.25)
   - `sl_candidate = max(existing_sl, qp_price, trailing_sl)` — **only ever increases**
   - `_place_sl_stop_order()` replaces the broker SL at the new `stop_price` via `replace_order_by_id` (stop-only — `ReplaceOrderRequest(stop_price=...)`)
3. **When price reverses**: the ratcheted broker stop triggers on Alpaca → fills at market → `_check_sl_order_filled()` detects the fill → exit recorded
4. **Market sell** fires only via `_detect_market_fallback_reason()` — see Conditions 1–9 below.

**Why broker stop and not internal market sell at QP trigger**: the broker enforces the trigger atomically at the venue. An internal market sell adds polling-loop latency plus a fresh order submission between trigger and fill — that gap is when an option spread widens or price slides further.

### `_place_sl_stop_order` Replacement Chain

When replacing the broker SL fails, the function works through a priority chain. The replace itself sends only `stop_price`; on failure, dispatch is by error pattern:

1. `replace_order_by_id(existing_id, ReplaceOrderRequest(stop_price=...))` — modify in place
2. **Hard verification** via `_verify_sl_order` — refetch the order and confirm the broker-stored `stop_price` matches within $0.005 (tighter than `CAPE_QP_OFFSET = $0.01` so a 1¢-stale stop cannot be acknowledged). On mismatch the new ID is kept but `sl_last_placed_pct` is **not** advanced — next tick retries.
3. Error-specific handlers (in dispatch order):
   - `42210000` / "position intent mismatch" → return `retry`; the AIT loop will call again on the next tick. Tracked by `position_not_ready_first_ts`; after `POSITION_NOT_READY_DEADLINE_SEC` (30s) the function sets `position_not_ready_escalated = True` and Condition 9 fires a market exit.
   - `40310000` / "uncovered option" with existing_id → `sl_broker_disabled = True`; rely on the original bracket child as backstop and Conditions 7/8 in the fallback detector.
   - `40310000` without existing_id → try (a) parse `related_orders` from error JSON and adopt; (b) `_adopt_existing_broker_sl` open-order scan; (c) advance `sl_last_placed_pct` to suppress retry and rely on Condition 8.
   - `order is not open` → clear `sl_order_ids` and `sl_last_placed_pct = None`; fresh placement queued for next tick.
   - `held_for_orders` / "insufficient qty available" → adopt-first; if adoption fails, cancel only **stop-side** sells (preserves bracket TP), poll-confirm each cancel via `_wait_for_cancel`, then submit fresh.
4. **Catch-all** (unrecognized error with existing_id): cancel + `_wait_for_cancel` + fresh stop-market.
5. If all else fails for this tick: `sl_replace_failed_ts = time.time()` is set; the next call within ~1s returns `throttled` to avoid hammering the broker.

When a replacement is verified, `sl_replace_failed_ts` is cleared so transient failures don't permanently slow the ratchet. Check `logs/trade.log` for `[SL ERROR] Failed to upsert`, `[SL ERROR] Replacement unverified`, `[SL CANCEL WAIT] Timeout`, `(cancel-then-fresh)`, and `[CRITICAL] Position not ready` lines to diagnose replacement behavior.

### `_detect_market_fallback_reason` — All Trigger Conditions

Called on every monitoring tick (polling: every `PRICE_POLL_SEC`; websocket: every `WS_ORDER_CHECK_SEC`). Returns `(reason_string, detail_string)` or `(None, None)`. When non-None, the caller cancels all TP/SL orders and places a market sell.

**Condition 1 — SL order in terminal state** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
The broker SL order is in `rejected`, `expired`, `canceled`, or `cancelled` status. The order cannot fill; a market sell is the only exit.

**Condition 2 — Gap-down miss** (`SL_MISSED_GAPDOWN_MARKET_EXIT`)
The broker SL is active but `sellable_price <= stop_price` AND `sellable_price < limit_price` (only meaningful for the original bracket stop-limit child; standalone replacements are stop-market and have no `limit_price`). The stop triggered but the market gapped below the limit floor, so the stop-limit cannot fill. Forced market exit immediately.

**Condition 3 — Triggered but unfilled** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
`sellable_price <= stop_price` (stop triggered) but the order has not filled after a 2-second grace period. The broker acknowledged the trigger but did not fill — treated as an order-system failure. A 4-second hard cap (`SL_TRIGGERED_HARD_CAP_SEC`) also fires from before the `confirmed_sl_price` early-out. Both timers **reset when the bid recovers above the order's stop** (each order's stop is remembered in `sl_trigger_stop:{oid}` at arming) — a transient one-tick bid touch of the stop must not keep the countdown running, only a sustained breach fires.

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

**Condition 6 — Broker SL disabled, position profitable** (`BROKER_SL_DISABLED_MARKET_EXIT`)
`sl_broker_disabled = True` (40310000 set the flag) AND current PnL is > 0. With no broker order enforcing the stop and the position in profit, exit immediately on this tick — no grace period, no synthetic-trigger wait. Prevents an "immortal" position when the original bracket child has been cancelled or restart wiped the IDs.

**Condition 7 — Broker SL disabled, synthetic loss trigger** (`BROKER_SL_DISABLED_MARKET_EXIT`)
`sl_broker_disabled = True` AND PnL ≤ 0. Compute a synthetic trigger from `sl_dynamic_pct` × `fill_price`; when `sellable_price <= synth_trigger` for 2 seconds (`broker_disabled_sl_seen_ts`), fire a market exit. Same grace-timer reset rules as Condition 5.

**Condition 8 — No SL orders ever placed and price breached static SL** (`ORDER_SYSTEM_FAILURE_MARKET_EXIT`)
`sl_ids` is empty AND `sl_broker_disabled = False` (so we expected an SL but never got one) AND `sellable_price <= sl_static_pct × fill_price`. Uses **static** SL (entry-level) rather than `sl_dynamic_pct` because loss-ratchet may raise the dynamic threshold above the actual safe price. Skipped during the first 15s after `entry_ts` (bracket-seeding window); after that, fires on a 10-second grace via `no_sl_order_seen_ts`.

**Condition 9 — Position-not-ready timeout** (`POSITION_NOT_READY_TIMEOUT_MARKET_EXIT`)
The broker has rejected SL placement with 42210000 / "position not ready" continuously for `POSITION_NOT_READY_DEADLINE_SEC` (30s). `_place_sl_stop_order` sets `position_not_ready_escalated = True`; the fallback detector picks it up and fires immediately. The market sell may itself surface 42210000 — but staying in retry-loop indefinitely is worse than attempting an exit. `position_not_ready_first_ts` and the escalated flag are cleared the moment SL placement progresses past the position-not-ready gate.

**Condition 10 — TP limit at broker but not filling** (`TP_LIMIT_NOT_FILLING_MARKET_EXIT`)
The TP child order exists (`tp_order_ids` non-empty), TP has not filled (`tp_order_filled = False`), and `sellable_price >= tp_price` — but the limit hasn't filled. Likely causes: wide option spread, thin liquidity at the TP strike, or partial venue routing. Fires after a **2-second grace** (`tp_not_filling_seen_ts` timer) to filter transient quote spikes that revert. Placed BEFORE the `confirmed_sl_price` early-out so the guard fires even though price is well above the SL. Grace timer resets when price retreats below TP, when TP fills, or when the TP child is cancelled. Companion to the existing immediate "no TP child + price >= tp_price → market exit" backstop at the bracket-mode block (which fires for Scenario B — TP limit never placed).

### TP Placement Failure Handling

`_attempt_place_tp_limit` is the only path that places a fresh standalone TP limit (non-bracket mode and the bracket-recovery path). Its two-attempt flow:

1. **First attempt** — submit TP limit without touching SL. On `held_for_orders` / "insufficient qty available", proceed to step 2. On any other broker error, set `tp_placement_failed = True` and return None.
2. **Second attempt** — pre-check via `_check_sl_order_filled` (race guard for SL fills inside the retry window), `_cancel_sl_orders`, `_wait_for_cancel` per cancelled SL ID, then resubmit. On any failure, set `tp_placement_failed = True` and return None.

When `tp_placement_failed = True` and the function returned None, the caller (both polling and WS monitors) overrides `exit_reason` to `TP_PLACEMENT_FAILED_MARKET_EXIT` and falls through to the standard exit handler — which cancels remaining orders and returns the exit reason. The downstream loop executes the market sell. This makes "TP limit not available" route to a market exit with an explicit, auditable reason rather than a misleading `TAKE_PROFIT_EXIT` that never resulted in a TP fill.

`tp_placement_failed_reason` carries the broker error string (truncated to 200 chars); `tp_placement_failed_ts` records when the flag was set. Both are reset to safe defaults on any successful TP placement.

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
| `EXIT_TAKE_PROFIT_MODE` | `"pct"` | TP calculated as % of fill price |
| `EXIT_TAKE_PROFIT_VALUE` | `0.08` | TP = fill × 1.08 (+8%) |
| `EXIT_STOP_LOSS_MODE` | `"pct"` | SL calculated as % of fill price |
| `EXIT_STOP_LOSS_VALUE` | `0.04` | SL = fill × 0.96 (−4%) |
| `EXIT_BRACKET_QP_ENABLED` | `True` | Broker SL ratchet mode (primary exit via broker stop) |
| `EXIT_QUICK_PROFIT_ENABLED` | `True` | QP ratchet armed (tier ladder, not flat trail) |
| `EXIT_TRAILING_STOP_ENABLED` | `True` | Trailing SL enabled |
| `CAPE_QP_OFFSET` | `0.05` | Legacy; superseded by tier ladder (QP_TIER_*) |
| `CAPE_TRAILING_SL_OFFSET` | `0.10` | Legacy; superseded by tier ladder |
| `QP_TIER_1_TRIGGER_PCT` | `3.0` | Arm ratchet at +3% peak (Tier 1 locks +0.5%; must stay above the 0.20 buffer-zone guard or the lock is silently discarded) |
| `QP_TIER_2_TRIGGER_PCT` | `6.0` | Tier 2 = lock 50% of peak |
| `QP_TIER_3_TRIGGER_PCT` | `10.0` | Tier 3 = lock 70% of peak |
| `SL_REPLACE_MIN_STEP_USD` | `0.05` | Min $ stop move before broker replacement call |
| `SL_REPLACE_MIN_INTERVAL_SEC` | `5.0` | Min seconds between broker replacements |
| `SL_STOP_ORDERS_ENABLED` | `True` | Enables broker-side SL stop-market placement/replacement |
| `EXIT_MAX_HOLD_ENABLED` | `True` | Exit stale trades after max hold time |
| `EXIT_MAX_HOLD_SEC` | `300` | 5-minute max hold for any position below +1% PnL (including losers) |
| `EXIT_MAX_HOLD_PNL_THRESHOLD_PCT` | `1.0` | Max-hold only fires if PnL < +1% |
| `EXIT_LOSS_CUT_ENABLED` | `True` | Staged loss cut: exit sustained bleeders before the −4% stop |
| `EXIT_LOSS_CUT_PNL_PCT` | `-2.0` | Loss-cut timer arms when PnL ≤ −2% |
| `EXIT_LOSS_CUT_HOLD_SEC` | `120` | Exit after 2 min continuously at/below −2% (timer resets on recovery) |
| `POST_TRADE_COOLDOWN_BARS` | `5` | Bars blocked after any exit |
| `MIN_TRADE_DURATION_SEC` | `30` | Min hold before discretionary exits (NOT safety exits) |
| `ENTRY_SR_PROXIMITY_PCT` | `0.0015` | S/R wall dead-zone: ±0.15% of PDH/PDL (VWAP removed) |
| `ENTRY_SETUP_A_PULLBACK_MAX_PCT` | `0.30` | Max EMA9 kiss distance for Setup A |
| `ENTRY_TIME_WINDOW_ENABLED` | `True` | Trade only during configured windows (9:45-10:45, 13:15-14:15 ET) |
| `MONGO_REQUIRED` | `True` | Bot exits at startup if Mongo unreachable |

`compute_tp_price()` and `compute_sl_price()` in `config.py` translate these settings into absolute prices. Always use these helpers rather than recomputing inline.

## Important Invariants

- **Broker SL is the primary exit in bracket mode.** `_evaluate_priority_exit` (and its market sells) is only for non-bracket mode. Do not route bracket-mode exits through `_evaluate_priority_exit`.
- **SL only ratchets upward.** `sl_dynamic_pct = max(existing_sl_pct, candidate_pct)`. Never reduce it, even in the loss zone.
- **One active sell order per contract at a time.** Alpaca rejects a second open sell order on the same option. Always cancel the old SL before placing a new one. `_place_sl_stop_order` handles this via `replace_order_by_id`; on cancel-then-fresh paths, `_wait_for_cancel` polls until the prior order is no longer open before submitting (fixed sleeps don't reliably cover settle time and re-trigger 40310000).
- **`sl_last_placed_pct` gates replacement, verified placements only.** The broker SL is only replaced when `qp_price > sl_last_placed_price`. `sl_last_placed_pct` is updated only when `_verify_sl_order` confirms the broker stored the new `stop_price` within $0.005. Failed/unverified replacements set `sl_replace_failed_ts`, which throttles the next attempt for ~1 second to prevent retry storms.
- **Bracket seeding must happen before the first profit tick.** `_seed_bracket_exit_orders` fetches the bracket's child order IDs from Alpaca (3 retries × 0.4s). If it fails, an initial standalone SL is placed immediately after; this may trigger the `held_for_orders` handler which cancels only **stop-side** open sells (the bracket TP limit is preserved).
- **Duplicate bar protection.** The loop tracks the last-traded `bar_time`; the same 1-minute bar is never traded twice.
- **Cooldown after exit.** `cooldown_bars_remaining` is decremented each loop iteration. Entry is blocked until it reaches 0.
- **Instance lock.** `acquire_instance_lock()` in `main.py` prevents two bot processes from running against the same symbol simultaneously.
- **MongoDB is load-bearing.** With `MONGO_REQUIRED = True`, the bot won't start if Mongo is down. Disable the flag only for local dev without a DB.
- **IEX volume is often 0.** `volume_unavailable` flag in `analyze_rsi()` result signals this; volume-based entry filters should check this flag before rejecting a signal.
