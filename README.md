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

## Exit Engine (Priority-Driven)

After entry fill, monitoring uses websocket first and polling fallback.

Typical priority order:

1. Take Profit (TP)
2. Stop Loss (SL)
3. Quick Profit (QP) lock
4. Trailing stop management
5. Breakeven protection
6. Bad entry fail-fast rule
7. Momentum stall rule
8. Max-hold timeout rule

Important behaviors:

- Safety SL is placed early and replaced upward as dynamic thresholds improve.
- QP arms only after minimum peak PnL threshold.
- Exit checks use sellable pricing logic (not optimistic mid-only assumptions).

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

## End-to-End Sample Trade

Example: AIT CALL on TSLA

1. Radar phase
- TSLA in auto mode.
- RSI cross-up appears with required RSI-MA gap.
- EMA, VWAP, momentum, volume, candle, structure filters pass.

2. Entry phase
- Backend selects contract (for example TSLA260424C00387500).
- Buy order submitted and filled.
- Position is registered with entry metadata.

3. Monitor phase
- Live ticks update current PnL, max PnL, dynamic SL/QP/TP state.
- Safety SL remains active and is replaced as needed.

4. Exit phase
- Suppose peak reaches +2.4%, QP arms and tracks at peak-gap.
- Price pulls back below QP dynamic threshold.
- Exit executes; reason logged as QUICK_PROFIT style reason.

5. Logging phase
- Trade stored in Mongo options_log/manual-trades with:
  - symbol, contract, qty
  - buy/sell prices
  - pnl and pnlPct
  - entry/exit timestamps
  - exit reason and thresholds snapshot

6. UI phase
- Trade appears in TradingView history and OverallSummary.
- LivePositions reflects closure and exit rationale.

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
