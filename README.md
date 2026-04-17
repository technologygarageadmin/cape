# Cape Trading Platform

Full-stack options scalping platform with an automated RSI-based entry engine, dynamic exit management, and a real-time React dashboard.

- **Frontend** - React 19 + Vite 8: Signal Radar, Live Positions, Trade History, ATR View, Dashboard
- **Backend** - FastAPI (Python 3.11+): market data, order execution, AIT engine, REST + WebSocket APIs
- **Broker** - Alpaca (paper + live): stock/option data, order placement, position management
- **Database** - MongoDB Atlas: full trade lifecycle logging, straddle history, manual trade log

> **Risk Notice** - This software can place real orders. Use paper trading until you fully validate behavior. You are solely responsible for all trading risk and API usage.

## Recent Updates (Apr 2026)

- **Exit path hardening**
   - Safety SL is now placed immediately at entry and then replaced as the dynamic stop ratchets up
   - Alpaca stop orders are updated in place instead of stacking new orders, which avoids held-qty failures
   - Manual trades reserve symbol ownership during handoff so the generic orphan monitor does not double-log the same exit
- **Broker fallback for options**
   - Alpaca options complex/bracket orders can be rejected, so entry now falls back cleanly to a plain market order when needed
- **Trading View: Open Positions now includes Exit Watch**
   - Per-open-position live tiles for `SL`, `QP`, `TP`
   - Human-readable status lines: **Hit SL / Will hit SL**, **Hit TP / Will hit TP**, **Hit QP / Will hit QP**
   - QP arming visibility when peak is not high enough yet
- **Trading View: Symbol History restyled to match Overall Summary history**
   - Card-style rows with source badge (`MT`/`AIT`), side (`CALL`/`PUT`), strike, entry/exit price, PnL $, PnL %, result, and exit reason
   - Deduplication and robust symbol matching for contract-format symbols (e.g. `TSLA260424C00387500`)
- **Exit engine safety tweak**
   - Quick Profit (QP) is now armed only after peak PnL reaches a minimum threshold (`QP_MIN_PEAK_PCT`), preventing QP exits at small/negative pullback levels

---

## Repository Layout

```
.
|-- backend/
|   |-- api_server.py            # FastAPI app + startup background services
|   |-- config.py                # All trading settings (git-ignored)
|   |-- strategy_helpers.py      # determine_signal() -- 13-filter entry engine
|   |-- monitoring.py            # Dynamic exit engine (WS + polling fallback)
|   |-- rsi_analyer.py           # analyze_rsi() -- RSI, EMA, VWAP, streaks, patterns
|   |-- market_data.py           # OBR / current price / contract selection
|   |-- order_execution.py       # Order helpers + in-memory position registry
|   |-- position_monitor_loop.py # Orphan position monitor
|   |-- symbol_mode.py           # Per-symbol mode persistence
|   |-- alpaca_helpers.py        # Snapshot + quote helpers
|   |-- main.py                  # Standalone bot runner (separate from api_server)
|   |-- requirements.txt
|   `-- logs/
|       `-- symbol_modes.json
|-- src/
|   |-- pages/
|   |   |-- SignalRadar.jsx      # Live per-symbol signal + filter checklist
|   |   |-- Dashboard.jsx
|   |   |-- LivePositions.jsx
|   |   |-- OverallSummary.jsx   # Trade history + exit snapshot analysis
|   |   |-- TradingView.jsx
|   |   `-- ATRView.jsx
|   |-- components/
|   `-- App.jsx
|-- package.json
|-- vite.config.js
`-- firebase.json
```

---

## Entry Strategy

Signal trigger: **RSI(14) crosses above/below its 9-period MA** on a 1-minute bar.

Every filter below must pass for a trade to fire.

### Pre-filters (kill signal immediately)

| Filter | Requirement |
|--------|-------------|
| Time window *(optional)* | 9:45-10:45 AM or 1:15-2:15 PM ET -- toggle with `ENTRY_TIME_WINDOW_ENABLED` |
| RSI-MA gap | `|RSI - RSI_MA| >= 3.0 pts` -- rejects weak/noisy touches |

### CALL filters (all must pass)

| # | Filter | Threshold |
|---|--------|-----------|
| 1 | EMA regime | EMA9 > EMA21 |
| 2 | Pullback to EMA9 | Price within 0.35% of EMA9 |
| 3 | RSI minimum | RSI >= 55 |
| 4 | Candle breakout | *(disabled)* |
| 5 | Strong candle | Body >= 60% of bar range AND bullish candle |
| 6 | RSI momentum | RSI delta >= +4.0 (actively rising) |
| 7 | Volume | Volume >= 2.0x recent average *(skipped if feed unavailable)* |
| 8 | Not overbought | RSI <= 58 |
| 9 | RSI streak | Up-streak = **exactly 2** bars (streak 3+ = exhaustion, rejected) |
| 10 | VWAP | Price above VWAP |
| 11 | Price structure | Bullish candle pattern (hammer, engulfing, pin bar, etc.) |
| 12 | EMA triple stack | EMA9 > EMA21 > EMA55 (fully fanned bullish) |

PUT filters are the exact mirror of the above.

**Post-trade cooldown:** 5 bars blocked after any completed trade.

---

## Exit Strategy

Dynamic exits -- evaluated every price tick (WebSocket-first, polling fallback).

At entry, the system also places a broker-side safety SL so there is always a hard stop in place while the monitor manages the real exit logic.

| Priority | Exit | Trigger |
|----------|------|---------|
| 1 | Take Profit | PnL >= +8.0% |
| 2 | Stop Loss | PnL <= -3.5% |
| 3 | **Dynamic QP** | Arms only after peak >= `QP_MIN_PEAK_PCT`; then exits on pullback below `peak - 0.25%` |
| 4 | Trailing Stop | Arms when peak >= 2.0%; trail ratio tightens as profit grows |
| 5 | Breakeven Stop | Once peak >= 1.5%, SL floor moves to 0% |
| 6 | Bad Entry | PnL < -1.5% AND peak never exceeded 0.3% within 45s |
| 7 | Momentum Stall | RSI delta flips against trade after >= 2 min AND PnL < 0.5% |
| 8 | Max Hold | Still open after 7 min AND PnL < 0.5% |

**Dynamic QP:** Once peak PnL reaches `QP_MIN_PEAK_PCT` (default 1.0%), QP ratchet tracks running peak and locks at `peak - QP_GAP_PCT`.

---

## Configuration (`backend/config.py`)

This file is **git-ignored** -- keep all credentials and thresholds here.

### Required

```python
API_KEY    = "..."
SECRET_KEY = "..."
MONGO_URI  = "mongodb+srv://..."
```

### Key trading knobs

```python
# Symbols
WATCHLIST_SYMBOLS = { "SPY": True, "TSLA": True, ... }  # True = AIT enabled

# Entry thresholds
MIN_RSI_MA_GAP              = 3.0
ENTRY_RSI_CALL_MIN          = 55
ENTRY_RSI_CALL_MAX          = 58     # valid CALL band: 55-58
ENTRY_RSI_PUT_MIN           = 42
ENTRY_RSI_PUT_MAX           = 45
ENTRY_RSI_MIN_DELTA         = 4.0
ENTRY_VOLUME_MIN_RATIO      = 2.0
ENTRY_MIN_BODY_RANGE_RATIO  = 0.60
ENTRY_RSI_MIN_STREAK        = 2
ENTRY_RSI_MAX_STREAK        = 2      # streak must be exactly 2
ENTRY_PULLBACK_EMA_TOLERANCE_PCT = 0.35

# EMA
EMA_FAST_PERIOD  = 9
EMA_SLOW_PERIOD  = 21
EMA_THIRD_PERIOD = 55

# Exits
TAKE_PROFIT_PCT            = 0.08   # 8%
STOP_LOSS_PCT              = 0.035  # 3.5%
QP_GAP_PCT                 = 0.25   # dynamic QP: lock in peak - 0.25%
QP_MIN_PEAK_PCT            = 1.0    # arm QP only after peak reaches +1.0%
TRAILING_MIN_PEAK_PCT      = 2.0
EXIT_BREAKEVEN_TRIGGER_PCT = 1.5
EXIT_BAD_ENTRY_WINDOW_SEC  = 45
EXIT_MAX_HOLD_SEC          = 420    # 7 min

# Feature toggles
STRADDLE_ENABLED               = True
ENTRY_TIME_WINDOW_ENABLED      = False  # True to restrict to AM/PM windows
ENTRY_EMA_TRIPLE_STACK_ENABLED = True
ENTRY_VWAP_FILTER_ENABLED      = True
ENTRY_PRICE_STRUCTURE_ENABLED  = True
```

### Environment variable overrides

| Variable | Default |
|----------|---------|
| `PAPER_TRADING` | `true` |
| `STOCK_DATA_FEED` | `iex` |
| `MONGO_ENABLED` | `true` |
| `MONGO_REQUIRED` | `true` |
| `ENTRY_ORDER_TYPE` | `market` |
| `ENTRY_TIME_IN_FORCE` | `day` |

---

## Local Development

### 1. Frontend

```bash
npm install
npm run dev
# http://localhost:5173
```

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
uvicorn api_server:app --host 0.0.0.0 --port 8000 --reload
# FastAPI docs: http://localhost:8000/docs
```

### 3. Quick start (Windows)

```bash
start.bat
```

---

## System Flow

### Backend startup

1. MongoDB collections initialized
2. Straddle runner loop started
3. Straddle monitor loop started
4. AIT threads started per enabled symbol
5. Orphan position monitor started

### Per-symbol AIT thread

1. Wait for market open (Alpaca clock)
2. Run startup straddle once (CALL + PUT legs)
3. Pre-select daily CALL/PUT contracts and cache
4. Enter RSI scan loop until market close:
   - Every 5s: `analyze_rsi()` -> `determine_signal()` -> 13 filters
   - On signal: place BUY -> wait for fill -> start exit monitor
   - On exit condition: place SELL -> log lifecycle to MongoDB
   - 5-bar cooldown before next scan

### Exit monitor

- WebSocket-first option quote feed
- Polling fallback (`PRICE_POLL_SEC = 3s`) when WS unavailable
- Dynamic thresholds updated on every tick
- Broker safety SL is created at entry and replaced as the trailing stop moves
- Sellable bid-side price used for exit evaluation (not optimistic mid)

---

## Frontend Pages

| Page | Description |
|------|-------------|
| **Signal Radar** | Live per-symbol signal status, 13-filter checklist, RSI bar, EMA/VWAP chips |
| **Dashboard** | Account overview and market summary |
| **Live Positions** | Open option positions with live PnL |
| **Overall Summary** | Trade history with exit snapshot analysis, win/loss/time filters |
| **Trading View** | Candle chart + per-position Exit Watch (SL/TP/QP hit/will-hit) + symbol history cards |
| **ATR View** | ATR-based volatility view |

---

## Safety

- `config.py` is git-ignored -- credentials never committed
- Symbol mode gate: `auto` / `manual` / `off` per symbol (persisted in `logs/symbol_modes.json`)
- Registry-based ownership prevents double-exits and duplicate monitor attachments
- Manual-trade logging writes one Mongo record per completed trade
- WebSocket -> polling fallback for robustness
- Orphan position monitor handles positions opened outside the AIT thread
- `PAPER_TRADING = True` by default -- set `False` only when ready for live
