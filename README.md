# Cape Trading Platform

Full-stack options trading workspace with:

- React + Vite frontend for market views, manual controls, and trade summaries
- FastAPI backend for market data, account/order APIs, and options workflows
- Alpaca integration for stock/option data and order execution
- MongoDB logging for lifecycle analytics (signal time, fill time, exit reason, PnL)
- Automated AIT engine (RSI-based) + startup straddle cycle

## Risk Notice

This software can place real orders. Use paper trading until you fully validate behavior in your environment. You are responsible for all trading risk and broker/API usage.

## What This Project Does

1. Runs a backend that exposes REST + websocket APIs.
2. Starts background trading services on backend startup:
	 - Daily straddle runner and straddle status monitor
	 - AIT per-symbol trading threads
	 - Position monitor service for unmanaged open positions
3. Serves a frontend dashboard/trading UI that consumes backend APIs.
4. Persists trade history to MongoDB collections for analysis.

## Repository Layout

```text
.
|- backend/
|  |- api_server.py            # FastAPI app + startup background services
|  |- main.py                  # Standalone bot runner (separate flow)
|  |- config.py                # Trading and infra settings (git-ignored)
|  |- market_data.py           # OBR/current price/contract selection
|  |- monitoring.py            # Exit engine (WS + polling fallback)
|  |- position_monitor_loop.py # Monitor for already-open positions
|  |- order_execution.py       # Order helpers + in-memory position registry
|  |- strategy_helpers.py      # Signal helpers and market/session utilities
|  |- symbol_mode.py           # Per-symbol mode persistence
|  |- requirements.txt
|  \- logs/
|- src/
|  |- pages/
|  |  |- TradingView.jsx
|  |  |- OverallSummary.jsx
|  |  |- TransactionHistory.jsx
|  |  |- ATRView.jsx
|  |  |- Dashboard.jsx
|  |  \- Test.jsx
|  |- components/
|  \- App.jsx
|- package.json
|- vite.config.js
\- firebase.json
```

## Prerequisites

- Node.js 20+
- Python 3.11+ (3.12 works)
- Alpaca account and API keys (paper first)
- MongoDB Atlas/local instance

## Configuration

### Important: `backend/config.py` is git-ignored

The project expects local configuration in `backend/config.py`. This file is excluded by `.gitignore`, so keep credentials there (or via environment variables where supported).

Minimum required values:

- `API_KEY`
- `SECRET_KEY`
- `MONGO_URI` (when Mongo is enabled/required)

Core controls currently used by the strategy include:

- `WATCHLIST_SYMBOLS` (per-symbol enable flag)
- `MIN_OPTION_VOLUME`, `ALLOW_LOW_VOLUME_FALLBACK`
- `TAKE_PROFIT_PCT`, `STOP_LOSS_PCT`, `QUICK_PROFIT_PCT`
- `EXIT_RSI_OPPOSITE_CROSS_ENABLED`
- `EXIT_AFTER_NEXT_CANDLE_ENABLED`
- `EXIT_ALLOW_POSITIVE_PNL_IN_ENTRY_CANDLE`
- `EXIT_SAME_CANDLE_USE_BID_PRICE`
- `EXIT_SAME_CANDLE_MIN_PNL_PCT`

### Environment variable overrides

The backend reads these optional overrides:

- `PAPER_TRADING`
- `STOCK_DATA_FEED`
- `ENTRY_ORDER_TYPE`
- `ENTRY_TIME_IN_FORCE`
- `ENTRY_LIMIT_OFFSET_PCT`
- `FILL_CHECK_INTERVAL_SEC`
- `MONGO_ENABLED`
- `MONGO_REQUIRED`
- `MONGO_URI`
- `MONGO_DB_NAME`
- `MONGO_COLLECTION_NAME`
- `ALLOWED_ORIGINS`

## Local Development

### 1) Install frontend dependencies

```bash
npm install
```

### 2) Install backend dependencies

```bash
cd backend
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
# source .venv/bin/activate
pip install -r requirements.txt
```

### 3) Start backend API

```bash
cd backend
uvicorn api_server:app --host 0.0.0.0 --port 8000 --reload
```

### 4) Start frontend

```bash
npm run dev
```

Open:

- Frontend: `http://localhost:5173`
- FastAPI docs: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Runtime Notes

- `api_server.py` already starts AIT/straddle/monitor background services on app startup.
- `main.py` is a standalone runner path. Do not run both `api_server.py` and `main.py` for the same account/session unless you intentionally want separate engines.
- Frontend pages currently call backend using hardcoded `http://localhost:8000` constants.

## End-to-End System Flow (Current)

This is the current live flow when running `uvicorn api_server:app ...`.

### 1) Backend startup and long-running services

On FastAPI startup (`api_server.py`):

1. MongoDB collections are initialized (if enabled).
2. Straddle runner loop starts.
3. Straddle monitor loop starts.
4. AIT symbol threads start for all `WATCHLIST_SYMBOLS` entries set to `True`.
5. Position monitor service starts for already-open positions not managed by the in-memory lot registry.

Current enabled AIT symbols in config are `SPY` and `TSLA`.

### 2) Frontend request flow

Frontend pages (mainly `TradingView.jsx`) continuously call backend APIs:

1. `GET /api/bars` for chart candles + RSI + markers.
2. `GET /api/quotes` for live bid/ask/trade snapshots.
3. `GET /api/options-log` and related history endpoints for summary/history pages.
4. `POST /api/symbol/mode` to switch per-symbol mode (`auto`, `manual`, `off`).

### 3) AIT per-symbol daily cycle

For each enabled symbol thread:

1. Wait for market open from Alpaca clock.
2. Run straddle once per day (CALL + PUT legs), monitor exits, and log results.
3. Preselect CALL/PUT contracts for the day (cache).
4. Enter RSI strategy loop until market close.

### 4) RSI scan and entry logic

Inside the AIT trade loop:

1. Every `CHECK_INTERVAL_SEC` (currently 5s), it runs `analyze_rsi(symbol)`.
2. RSI analyzer fetches recent 1-minute bars, computes RSI(14) and RSI MA(9), and classifies trend/crosses.
3. Strategy validates signal conditions (trend, crossover, EMA context, breakout checks, gap filters).
4. On valid signal:
	- Uses preselected contract for the direction.
	- Places BUY order.
	- Waits for fill and computes TP/SL anchors.

### 5) Exit engine and sell execution

After BUY fill, monitor starts:

1. Websocket-first option quote monitor (`monitor_with_websocket`).
2. If websocket is unavailable, polling fallback (`monitor_with_polling`) every `PRICE_POLL_SEC` (currently 5s).
3. Exit priority:
	- Take Profit / Stop Loss
	- Quick Profit lock
	- Trailing Stop (if enabled)
	- Opposite RSI cross (if enabled)

Important current behavior:

1. Exit PnL is evaluated using sellable bid-side price when bid is present (not optimistic mid-only).
2. Opposite RSI cross exit is blocked unless sellable bid-side PnL is positive.
3. SELL order receives `reference_price` from monitor price so order intent matches evaluated exit price.

### 6) Logging and persistence

Each trade writes normalized lifecycle records:

1. Signal timestamps/prices.
2. Buy fill timestamps/prices.
3. Exit signal timestamps/prices.
4. Sell fill timestamps/prices.
5. Exit reason and PnL fields.

Primary collection is `options_log`; straddle and manual histories use separate collections.

### 7) Safety and fallback layers

1. Symbol mode gate:
	- `auto` = full AIT
	- `manual` = automated thread paused for that symbol
	- `off` = no automated trading
2. Websocket fallback to polling for robustness.
3. Dedicated monitor for orphan/open positions (`position_monitor_loop.py`).
4. Registry-based skip in monitor service avoids duplicate exits for lots already managed by strategy threads.

### 8) Timing and rate profile (current)

Current timing knobs:

1. `CHECK_INTERVAL_SEC = 5`
2. `PRICE_POLL_SEC = 5`
3. `RSI_EXIT_CHECK_SEC = 10`

Operational implication:

1. One active AIT symbol consumes roughly one RSI REST pull every 5 seconds.
2. Additional exit polling load is added only when websocket monitor falls back.
3. On Basic market-data plans (200 calls/min), keep enabled symbol count conservative and monitor for 429 responses.

## Trading Logic Overview

### Symbol modes

Each symbol can be set to:

- `auto`: AIT enabled
- `manual`: AIT paused, manual interaction allowed
- `off`: no automated trading for that symbol

Modes are persisted in `backend/logs/symbol_modes.json`.

### AIT flow (high-level)

1. Wait for market open.
2. Run startup straddle once per day (enabled symbols).
3. Preselect daily CALL/PUT contracts per symbol.
4. Scan RSI-based entry signals.
5. On signal, place market buy immediately using preselected contract.
6. Monitor exits using websocket first, polling fallback.
7. Place market sell on exit condition.
8. Write normalized trade lifecycle into Mongo (`options_log`).

### Exit behavior by mode

- Straddle legs: TP/SL only (`use_extended_exit_criteria=False`)
- AIT and generic monitor: priority engine
	1. Take profit / stop loss
	2. Quick profit lock
	3. Trailing stop (if enabled)
	4. RSI opposite crossover (if enabled)

Additional protection:

- Optional next-candle exit hold
- Optional same-candle positive exit override with bid-side profit threshold

### Contract selection

Selection uses listed Alpaca contracts with:

- strike-range filtering around current price
- minimum volume requirement
- fallback windows (including +/- 1 strike window behavior)
- nearest ATM or one-step ITM fallback when liquidity is thin

## Data Persistence (MongoDB)

Collections used:

- `straddle_trades`
- `manual_trade_history`
- `options_log`

`options_log` includes detailed lifecycle fields, such as:

- `entry_signal_time`, `entry_signal_price`
- `buy_filled_time`, `buy_filled_price`
- `exit_signal_time`, `exit_signal_price`
- `sell_filled_time`, `sell_filled_price`
- `exit_reason`, `trade_type`, `peak_pnl_pct`

## API Quick Reference

### Health and market

- `GET /health`
- `GET /api/bars`
- `GET /api/quotes`
- `GET /api/config`

### Account and execution

- `GET /api/account`
- `GET /api/positions`
- `POST /api/orders`
- `DELETE /api/orders/{order_id}`
- `POST /api/positions/{symbol}/close`
- `GET /api/orders/{order_id}/status`

### Options and strategy

- `GET /api/options/suggest`
- `POST /api/options/buy`
- `GET /api/options/price`

### Logs and history

- `GET /api/options-log`
- `GET /api/manual-trades`
- `POST /api/manual-trades`
- `GET /api/straddle/trades`

### Symbol mode control

- `GET /api/symbol/mode`
- `GET /api/symbol/modes`
- `POST /api/symbol/mode`

### AI control and websocket

- `POST /api/ai-trade/stop`
- `WS /ws/quotes`

## Option Price Endpoint Example

```bash
curl "http://localhost:8000/api/options/price?contract=SPY260410C00650000"
```

Sample response:

```json
{
	"contract": "SPY260410C00650000",
	"price": 1.23,
	"mid": 1.23,
	"bid": 1.21,
	"ask": 1.25
}
```

## Frontend Routes

- `/dashboard`
- `/trading`
- `/atr`
- `/history`
- `/test`
- `/summary`

## Build and Deploy Frontend

```bash
npm run build
npm run preview
```

Firebase hosting config is present in `firebase.json` with SPA rewrite to `index.html`.

## Troubleshooting

- `MongoDB unavailable` at startup:
	- Verify `MONGO_URI`, network/IP allowlist, credentials.
	- If `MONGO_REQUIRED=true`, startup may stop/fail on DB errors.
- `Failed to fetch bars/quotes/options`:
	- Confirm Alpaca keys, feed permissions, and market session timing.
- `No listed contracts found`:
	- Check symbol liquidity/expiry window and contract availability.
- Unexpected duplicate strategy behavior:
	- Ensure you are not running both backend engines (`api_server.py` and `main.py`) for the same session.

## Security Notes

- Never commit real broker keys or production secrets.
- Keep `backend/config.py` local only (already git-ignored).
- Restrict `ALLOWED_ORIGINS` in non-local environments.

## Tech Stack

- Frontend: React 19, Vite 8, lightweight-charts, lucide-react
- Backend: FastAPI, uvicorn, alpaca-py, pandas, pymongo
- Storage: MongoDB
