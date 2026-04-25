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
2. `_update_dynamic_thresholds()` — ratchets SL/QP upward when price is in profit; never moves them down
3. `_evaluate_priority_exit()` — checks exit conditions in priority order: TP → SL → QP → trailing SL → RSI cross → market fallback
4. If exit: cancel open bracket child orders → place market sell → log trade

**SL ratchet rule**: `dynamic_sl = max(static_sl, current_price - TRAILING_SL_OFFSET)`. SL only ever increases.

**QP ratchet rule**: `qp_floor = current_price - CAPE_QP_OFFSET` ($0.01). Tracks price $0.01 below current peak. When price ticks down past the floor, QP exit fires.

**Safety net**: `_detect_market_fallback_reason()` catches two SL failure cases — gap-down miss (price skips past SL limit) and system failure (SL triggered but unfilled after 2s) — and places a forced market sell.

### Position Registry (`order_execution.py`)

Two module-level dicts hold all live state:
- `_positions` — registered trades keyed by `buy_order_id`, with status `OPEN → SELLING → CLOSED`
- `_live_exit_states` — per-tick exit thresholds, PnL snapshots, and order IDs for each open position

`get_live_positions()` merges both dicts for API responses. Any exit path (TP, SL, QP, fallback) must call `mark_selling()` then `close_position()` in order, or the position leaks into `get_open_positions()`.

### Broker Bracket + Internal Monitor (dual-layer)

Alpaca does not allow two open exit orders on the same option contract simultaneously. The bot works around this:
- A **bracket order** places one TP child and one SL child at entry
- As price moves up, `upsert_broker_safety_sl()` cancels the old SL child and replaces it at the new ratcheted level
- QP and trailing SL are tracked **internally** only; when they fire, the monitoring loop cancels the bracket and places a market sell itself

When adding new exit logic, always go through the `_evaluate_priority_exit()` path — do not place exit orders directly from other code paths or the bracket/monitor will conflict.

## Configuration (`backend/config.py`)

All trading behavior is driven by `config.py`. Key knobs:

| Setting | Current | Effect |
|---|---|---|
| `PAPER_TRADING` | `True` | Must flip to `False` for live |
| `TAKE_PROFIT_PCT` | `0.25` | Absolute $0.25 above fill price |
| `STOP_LOSS_PCT` | `0.50` | Absolute $0.50 below fill price |
| `EXIT_QUICK_PROFIT_ENABLED` | `False` | QP ratchet (currently off) |
| `EXIT_TRAILING_STOP_ENABLED` | `False` | Trailing SL (currently off) |
| `CAPE_QP_OFFSET` | `0.01` | QP tracks $0.01 below live peak |
| `CAPE_TRAILING_SL_OFFSET` | `0.25` | Trailing SL lags $0.25 behind price |
| `POST_TRADE_COOLDOWN_BARS` | `5` | Bars blocked after any exit |
| `MIN_TRADE_DURATION_SEC` | `30` | No exit for 30s after fill |
| `MONGO_REQUIRED` | `True` | Bot exits at startup if Mongo unreachable |

`compute_tp_price()` and `compute_sl_price()` in `config.py` translate these settings into absolute prices. Always use these helpers rather than recomputing inline.

## Important Invariants

- **One bracket order at a time per contract.** Never place a second TP or SL order without cancelling the first. Use `upsert_broker_safety_sl()` for SL updates.
- **Duplicate bar protection.** The loop tracks the last-traded `bar_time`; the same 1-minute bar is never traded twice.
- **Cooldown after exit.** `cooldown_bars_remaining` is decremented each loop iteration. Entry is blocked until it reaches 0.
- **Instance lock.** `acquire_instance_lock()` in `main.py` prevents two bot processes from running against the same symbol simultaneously.
- **MongoDB is load-bearing.** With `MONGO_REQUIRED = True`, the bot won't start if Mongo is down. Disable the flag only for local dev without a DB.
- **IEX volume is often 0.** `volume_unavailable` flag in `analyze_rsi()` result signals this; volume-based entry filters should check this flag before rejecting a signal.
