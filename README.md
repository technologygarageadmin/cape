# Cape Trading Platform

Full-stack options trading platform with:
- Automated Intelligence Trading (AIT)
- Manual Trading (MT)
- Real-time signal/risk dashboards
- Dynamic, multi-layer exit engine

This repository is designed for active intraday options workflows with Alpaca as broker/data provider and MongoDB for lifecycle logging.

Risk Notice: This software can place real orders. Keep PAPER_TRADING enabled until you validate every behavior in your own environment.

## What This Project Does

1. Scans watchlist symbols for RSI/EMA/VWAP-based entry setups.
2. Executes option orders (AIT or MT).
3. Starts continuous live monitoring after fill.
4. Applies prioritized exits (TP, SL, QP, trailing, time/risk rules).
5. Logs full trade lifecycle to MongoDB.
6. Serves a React UI for radar, positions, history, and diagnostics.

## Architecture (Current)

The backend is split into two API lanes:

1. Trading API (port 8001)
- File: backend/api_server_trading.py
- Runs the full trading app from backend/api_server.py
- Handles order-critical operations and engine internals

2. Display API (port 8002)
- File: backend/api_server_display.py
- Proxy layer for UI/read-heavy traffic
- Preserves request/response contracts while isolating display load

3. Frontend (port 5173)
- React + Vite app in Frontend/

4. Launcher
- app.py starts only backend services (8001 and 8002)
- Frontend is started manually by user

## Project Layout

```
.
|-- app.py
|-- backend/
|   |-- api_server.py
|   |-- api_server_trading.py
|   |-- api_server_display.py
|   |-- config.py
|   |-- strategy_helpers.py
|   |-- rsi_analyer.py
|   |-- monitoring.py
|   |-- market_data.py
|   |-- order_execution.py
|   |-- position_monitor_loop.py
|   |-- symbol_mode.py
|   |-- alpaca_helpers.py
|   |-- main.py
|   |-- requirements.txt
|   `-- logs/
`-- Frontend/
    |-- src/pages/
    |-- src/components/
    |-- package.json
    `-- vite.config.js
```

## Core Modes: AIT vs MT

### AIT (Automated Intelligence Trading)

- Symbol mode: auto
- Engine scans bars/signals and auto-enters when all filters pass
- Exit engine runs immediately after fill
- Straddle workflow can be enabled at market open

### MT (Manual Trading)

- Symbol mode: manual
- User selects/suggests contract and places buy from UI
- Backend still manages live monitoring and exits after fill
- Full trade recorded to Mongo with exit reason and PnL

### OFF mode

- Symbol mode: off
- No automated entries for that symbol

## Entry Engine

Primary trigger:
- RSI(14) crossover against RSI MA(9) on 1-minute context.

Key preconditions and filters (config-driven):

1. Trade window (optional)
2. Minimum RSI-MA gap
3. EMA regime alignment
4. Pullback tolerance to EMA fast
5. RSI directional threshold bands
6. Candle quality/body ratio
7. RSI momentum delta
8. Volume confirmation ratio
9. Extreme RSI avoidance
10. Streak logic (fresh momentum only)
11. VWAP side confirmation
12. Price structure confirmation
13. EMA triple stack confirmation

If any mandatory filter fails, no entry is placed.

## Clear Exit Model (After Buy Fill)

Use this as the single exit model reference.

Config terms:

1. EP = entry price
2. TP_OFFSET
3. SL_OFFSET
4. TRAILING_SL_OFFSET
5. QP_OFFSET (fast trailing)
6. Optional TP trailing after confirmation ticks

State:

1. One active TP order: SELL LIMIT
2. One active SL order: SELL SL LIMIT
3. QP is internal
4. Cape_SL is internal trailing
5. existing SL = current live SL order price

### 1) Entry

1. Place BUY LIMIT at EP.
2. On fill:
- Place SELL LIMIT TP at EP + TP_OFFSET.
- Place SELL SL LIMIT at EP - SL_OFFSET.
3. Initialize:
- QP = EP
- Cape_SL = EP - SL_OFFSET

### 2) On every tick

If price > EP (profit mode):

1. QP = price - QP_OFFSET
2. Cape_SL = price - TRAILING_SL_OFFSET
3. new_SL = max(existing SL, Cape_SL, QP)
4. If new_SL > existing SL:
- Cancel old SELL SL LIMIT at existing SL
- Place new SELL SL LIMIT at new_SL
- existing SL = new_SL
5. Optional TP trailing:
- If price > current TP and confirmation ticks pass, modify TP down to trailing TP formula.

If price <= EP (loss mode):

1. QP = None
2. drawdown = EP - price
3. tighten = min(drawdown, MAX_TIGHTEN)
4. Cape_SL = EP - (SL_OFFSET - tighten)
5. new_SL = max(existing SL, Cape_SL)
6. If new_SL > existing SL:
- Cancel old SELL SL LIMIT
- Place new SELL SL LIMIT
- existing SL = new_SL

### 3) Execution rules

1. If price >= TP:
- TP fills
- Cancel remaining SL
- Position closed
2. If price <= SL:
- SL fills
- Cancel remaining TP
- Position closed
3. If SL miss/gap:
- Cancel all open exits
- Place market sell
- Position closed

### 4) Rules

1. Only one TP and one SL live at any time
2. SL only moves up, never down
3. Always cancel old SL before placing new SL
4. QP is internal and can push final SL
5. Live orders represent only final TP and final SL

## API Guide

Base URLs:

- Trading lane: http://localhost:8001
- Display lane: http://localhost:8002

### Trading-priority endpoints (examples)

1. POST /api/orders
2. DELETE /api/orders/{order_id}
3. POST /api/positions/{symbol}/close
4. POST /api/options/buy
5. POST /api/manual-trade/buy
6. POST /api/ai-trade/stop
7. GET /api/options/suggest

### Display/read endpoints (examples)

1. GET /health
2. GET /api/bars
3. GET /api/quotes
4. GET /api/account
5. GET /api/positions
6. GET /api/live-positions
7. GET /api/orders/history
8. GET /api/orders/{order_id}/status
9. GET /api/options-log
10. GET /api/manual-trades
11. GET /api/config
12. GET /api/config/trading-modes
13. GET/POST /api/symbol/mode
14. GET /api/signal-readiness

For full schemas and live testing, open docs from a running service.

## Frontend Pages

1. TradingView
- Live chart, order actions, exit watch, symbol trade history

2. SignalRadar
- Per-symbol readiness, filter pass/fail view, mode controls

3. LivePositions
- Open/closed position diagnostics, threshold status, live PnL

4. OverallSummary
- Unified MT + AIT trade history, sorting, stats, lifecycle detail

5. Dashboard
- High-level system/account view

6. ATRView
- Volatility-oriented view

## End-to-End Sample Trade (Tick-by-Tick)

Example: MT entry at 8.00 with tick path:

8.00 -> 8.05 -> 8.12 -> 8.09 -> 7.95 -> 7.90 -> 8.00 -> 8.05 -> 8.11

Assume current defaults:

1. TP = +8.0%
2. SL = -3.5%
3. QP gap = 0.0%
4. QP min peak = 0.0%
5. QP min exit pnl = 0.0%

### Tick Timeline (what UI should show)

1. Tick 0: 8.00
- PnL = 0.00%
- Peak = 0.00%
- TP: NO_CHANGE (still initial TP)
- SL: NO_CHANGE (still initial SL)
- Order action: no cancel/replace

2. Tick 1: 8.05
- PnL = +0.625%
- Peak = +0.625%
- QP dynamic becomes +0.625% (zero gap)
- TP: NO_CHANGE
- SL: UPDATED upward by QP/Cape_SL push
- Order action: cancel old SL limit order and place new SL limit order

3. Tick 2: 8.12
- PnL = +1.50%
- Peak = +1.50%
- QP dynamic updates to +1.50% (zero gap)
- TP: NO_CHANGE
- SL: UPDATED upward again
- Order action: cancel old SL limit order and place new SL limit order

4. Tick 3: 8.09
- PnL = +1.125%
- Peak remains +1.50%
- TP: NO_CHANGE
- SL: NO_CHANGE (SL already tightened from previous tick)
- Since price falls below active SL, SL order fills
- Exit reason: STOP_LOSS_EXIT (dynamic SL capture)

5. Tick 4+: 7.95 -> 7.90 -> 8.00 -> 8.05 -> 8.11
- Trade is already closed at Tick 3
- UI should show closed state and exit reason STOP_LOSS_EXIT
- These later ticks are not part of the same open position lifecycle

### Result Summary

1. Exit tick: 8.09
2. Exit reason: STOP_LOSS_EXIT (triggered by tightened dynamic SL)
3. Approx realized pnl: around +1.1% zone (fill dependent)

### Where this appears in UI

1. TradingView
- Open position card shows Exit Watch changes tick-by-tick until close
- After close, symbol history row shows STOP_LOSS_EXIT

2. LivePositions
- Position moves from active to exited
- Exit reason and final pnl are visible in the card

3. OverallSummary
- Trade appears in history with lifecycle fields and exit reason

### Price Change -> SL Limit Change (explicit)

Example with EP = 8.00, TP_OFFSET = 0.64 (TP = 8.64), SL_OFFSET = 0.28 (SL = 7.72), QP_OFFSET = 0.00, TRAILING_SL_OFFSET = 0.03.

1. Fill at 8.00
- Place TP LIMIT at 8.64
- Place SL STOP-LIMIT at 7.72 (existing SL = 7.72)

2. Tick 8.05
- QP = 8.05
- Cape_SL = 8.02
- new_SL = max(7.72, 8.02, 8.05) = 8.05
- Cancel SL at 7.72
- Place SL at 8.05
- existing SL = 8.05
- TP remains unchanged at 8.64

3. Tick 8.12
- QP = 8.12
- Cape_SL = 8.09
- new_SL = max(8.05, 8.09, 8.12) = 8.12
- Cancel SL at 8.05
- Place SL at 8.12
- existing SL = 8.12
- TP remains unchanged at 8.64

4. Tick 8.09
- Price <= existing SL (8.12)
- SL executes, cancel TP, close position

5. Later ticks 7.95, 7.90, 8.00, 8.05, 8.11
- Ignored for this trade because position is already closed

## Configuration

Primary control file:
- backend/config.py

Key categories:

1. API and broker credentials
2. Paper/live mode
3. Symbol watchlist and per-symbol behavior
4. Entry filters and thresholds
5. Exit thresholds and toggles
6. Polling/check intervals
7. Mongo logging controls

Commonly tuned knobs:

- TAKE_PROFIT_PCT
- STOP_LOSS_PCT
- QP_GAP_PCT
- QP_MIN_PEAK_PCT
- MIN_RSI_MA_GAP
- ENTRY_RSI_MIN_DELTA
- ENTRY_VOLUME_MIN_RATIO

## How To Run

### 1. Backend dependencies

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Start backend lanes

From repository root:

```bash
python app.py
```

This starts:
- Trading API on 8001
- Display API on 8002

### 3. Start frontend manually

```bash
cd Frontend
npm install
npm run dev
```

Open:
- http://localhost:5173

## Operational Notes

1. app.py currently starts backend only by design.
2. Frontend should be started manually.
3. Keep config.py values aligned with your broker/data plan.
4. Prefer paper mode before any live rollout.

## Safety and Reliability Controls

1. Per-symbol mode gates (auto/manual/off)
2. Exit ownership guards to prevent duplicate close paths
3. Websocket-to-polling fallback for monitoring continuity
4. Mongo-backed lifecycle logging for post-trade audit
5. Orphan monitor to reconcile unmanaged open positions

## Troubleshooting Quick Checklist

1. Backend not booting
- Verify backend/config.py has required constants and credentials.

2. UI not updating
- Check display lane (8002) health and browser console network calls.

3. Order fails
- Check Alpaca permissions, market state, and contract liquidity.

4. No trade logs
- Validate Mongo URI and collection writes.

## Disclaimer

This project is an execution system, not financial advice. You are responsible for strategy risk, broker costs, slippage, and regulatory compliance.
