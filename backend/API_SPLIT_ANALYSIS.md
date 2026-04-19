# API Split Analysis: Trading vs Display

## Summary
Your system has **22 API endpoints** that fall into two distinct categories:
1. **TRADING APIs** - Heavy computation, order execution, position management
2. **DISPLAY APIs** - Lightweight data retrieval for dashboards/charts

---

## 🔴 TRADING API (Heavy Computation)
**Purpose:** Execute trades, manage positions, handle orders  
**Complexity:** High - requires Alpaca SDK, WebSocket, real-time data  
**Frequency:** User-triggered, background loops  
**Recommendation:** Keep on main server OR move to separate server

### Trading Endpoints

| Endpoint | Method | Purpose | Computation | Used By |
|----------|--------|---------|-------------|---------|
| `/api/orders` | POST | Place market/limit orders | **HIGH** - Alpaca API, validation, logging | TradingView (manual) |
| `/api/orders/{order_id}` | DELETE | Cancel open order | **HIGH** - Alpaca cancellation | TradingView (manual) |
| `/api/positions/{symbol}/close` | POST | Close position by ticker | **HIGH** - Market exit order, Alpaca | TradingView, OverallSummary |
| `/api/options/buy` | POST | Buy option contract | **HIGH** - Alpaca order placement | TradingView |
| `/api/manual-trade/buy` | POST | Execute manual option buy | **HIGH** - Contract validation, order exec | TradingView |
| `/api/manual-trades` | POST | Save manual trade record | **MEDIUM** - MongoDB write | TradingView |
| `/api/ai-trade/stop` | POST | Force-close AI trade | **HIGH** - Market exit order | TradingView |
| `/api/options/suggest` | GET | AI-pick best option (RSI+OBR) | **HIGH** - Alpaca bars, RSI calculation, contract search | TradingView |

**Total: 8 endpoints**

---

## 🟢 DISPLAY API (Lightweight Data Retrieval)
**Purpose:** Show charts, stats, history  
**Complexity:** Low-Medium - mostly MongoDB queries, light calculations  
**Frequency:** Polled continuously (every 1-5 seconds)  
**Recommendation:** Move to separate lightweight server

### Display Endpoints

| Endpoint | Method | Purpose | Computation | Used By |
|----------|--------|---------|-------------|---------|
| `/api/bars` | GET | OHLCV bars + RSI + OBR | **MEDIUM** - Alpaca bars, RSI calc, OBR lookup | TradingView (chart) |
| `/api/quotes` | GET | Live bid/ask for symbols | **LOW-MEDIUM** - Alpaca quotes | TradingView (multi-quote) |
| `/api/account` | GET | Account stats (cash, equity) | **LOW** - Alpaca account fetch | Not actively used in UI |
| `/api/positions` | GET | All open positions | **LOW** - Alpaca positions | TradingView, OverallSummary |
| `/api/live-positions` | GET | Positions + entry reasons + PnL | **MEDIUM** - Alpaca + calculation | TradingView, LivePositions, OverallSummary |
| `/api/orders/history` | GET | Order history (filled/canceled) | **LOW** - Alpaca history | Not actively used in UI |
| `/api/options-log` | GET | AI bot trade history | **LOW** - MongoDB query | OverallSummary, TradingView (tabs) |
| `/api/manual-trades` | GET | Manual trade history | **LOW** - MongoDB query | OverallSummary, TradingView (tabs) |
| `/api/orders/{order_id}/status` | GET | Poll order fill price/status | **LOW** - Alpaca order status | Not actively used in UI |
| `/api/config` | GET | Return active config values | **VERY LOW** - Static config return | OverallSummary |
| `/api/config/trading-modes` | GET | Trading mode gates (AIT/MT) | **VERY LOW** - Static config return | TradingView |
| `/api/straddle/trades` | GET | Straddle records by symbol | **LOW** - MongoDB query | Not actively used in UI |
| `/health` | GET | Server health check | **VERY LOW** - Status return | startup check |

**Total: 13 endpoints**

---

## Frontend API Usage Pattern

### High Frequency Polling (Every 1-3 seconds)
- `/api/bars` - Chart candlesticks + RSI
- `/api/live-positions` - Position PnL updates
- `/api/quotes` - Price tickers

### Medium Frequency (Every 5-10 seconds)
- `/api/positions` - Position list
- `/api/options-log` - Trade history
- `/api/manual-trades` - Trade history

### Low Frequency (On-demand)
- `/api/options/suggest` - When user hovers/selects
- `/api/manual-trade/buy` - When user clicks buy
- `/api/orders` - When placing order
- `/api/ai-trade/stop` - When user stops AI
- `/api/positions/{symbol}/close` - When closing position

### Startup Only
- `/api/config` - Get configuration
- `/health` - Health check

---

## Recommended Split Strategy

### Option 1: Same Server, Separate Routes (Simpler)
```
http://localhost:8000/api/trading/*    → Trading endpoints (8)
http://localhost:8000/api/display/*    → Display endpoints (13)
```
**Pros:** No infrastructure change, easy to implement  
**Cons:** No load separation, can't scale independently

---

### Option 2: Two Separate Servers (Better for Scale)

#### Server 1: Trading API (Port 8001)
```
- /api/orders
- /api/orders/{order_id}
- /api/positions/{symbol}/close
- /api/options/buy
- /api/manual-trade/buy
- /api/manual-trades (POST only)
- /api/ai-trade/stop
- /api/options/suggest
```
**Runs:** On-demand, triggered by user  
**Needs:** Alpaca SDK, full config  
**Scaling:** Scale up for high-frequency trading

#### Server 2: Display API (Port 8002)
```
- /api/bars
- /api/quotes
- /api/account
- /api/positions (GET only)
- /api/live-positions
- /api/orders/history
- /api/options-log
- /api/manual-trades (GET only)
- /api/orders/{order_id}/status
- /api/config
- /api/config/trading-modes
- /api/straddle/trades
- /health
```
**Runs:** Continuous polling (can be cached)  
**Needs:** Alpaca SDK (read-only), MongoDB  
**Scaling:** Heavy load here → add caching, Redis

---

## Implementation Recommendation

### Phase 1: Minimal Refactor (Low Risk)
1. **Create new file:** `api_server_display.py` (copy from `api_server.py`)
2. **Remove trading endpoints** from display server
3. **Run on separate port** (8002)
4. **Update frontend** to point `/api/display/*` calls to port 8002
5. **Add caching layer** to display endpoints (Redis or in-memory)

### Phase 2: Advanced Optimization
1. Create `api_server_trading.py` (only trading endpoints)
2. Run on port 8001
3. Add request queuing for order execution
4. Add real-time WebSocket for price updates (reduce polling)

---

## Load Distribution Analysis

### Current (Single Server @ 8000)
```
Peak Load = Trading Orders + Display Polls
= ~20 requests/sec (if 4 users polling 5 endpoints every 1-2 sec)
```

### After Split (Option 2)
```
Trading Server @ 8001
- Occasional spikes from user actions
- Can handle 10+ concurrent orders easily

Display Server @ 8002
- Continuous 20+ requests/sec
- CPU: RSI calculations on /api/bars
- Network: Alpaca quotes fetching
- I/O: MongoDB queries (options-log, manual-trades)
```

---

## Specific High-Computation Endpoints

### 1. `/api/bars` (MEDIUM)
**What it does:**
- Fetches 200-1000 bars from Alpaca (7 days of data)
- Calculates RSI (14-period) + RSI MA (9-period)
- Calculates OBR (Opening Range Breakout)
- Detects RSI crossover signals
- Serializes 200+ bar objects + indicators

**Computation Time:** ~200-500ms  
**Solution:** Cache for 1-2 minutes, or move to Display server + cache

### 2. `/api/options/suggest` (HIGH)
**What it does:**
- Fetches live price (Alpaca)
- Calculates OBR range
- Gets 200 bars + RSI signals
- Searches Alpaca option chain (all contracts)
- Finds best strike + expiry
- Calculates bid/ask for final contract
- Detects RSI momentum

**Computation Time:** ~1000-2000ms  
**Solution:** Only call when user needs it (not polled)

### 3. `/api/live-positions` (MEDIUM)
**What it does:**
- Fetches all positions from Alpaca
- Calculates live PnL for each
- Maps entry reasons from CSV
- Builds complex nested response

**Computation Time:** ~300-800ms  
**Solution:** Cache for 2-5 seconds, move to Display server

### 4. `/api/options-log` (LOW)
**What it does:**
- MongoDB query with optional filters
- Sort + limit
- Serializes 100-500 trade records

**Computation Time:** ~50-200ms  
**Solution:** Move to Display server, add MongoDB index

---

## Caching Strategy for Display Server

```python
# In api_server_display.py
from functools import lru_cache
import time

CACHE_TTL = {
    '/api/bars': 60,           # 1 minute
    '/api/live-positions': 5,   # 5 seconds
    '/api/quotes': 5,           # 5 seconds
    '/api/options-log': 30,     # 30 seconds
    '/api/manual-trades': 30,   # 30 seconds
    '/api/positions': 10,       # 10 seconds
}

@app.get("/api/bars")
@cache(ttl=60)
def get_bars(...):
    # existing implementation
    pass
```

---

## Migration Checklist

- [ ] Create `api_server_display.py` with display endpoints only
- [ ] Create `api_server_trading.py` with trading endpoints only (optional)
- [ ] Add caching decorator to display endpoints
- [ ] Update frontend to use separate URLs
- [ ] Test performance with load testing
- [ ] Monitor response times before/after split
- [ ] Add health check for both servers
- [ ] Update startup scripts (app.py, start.bat)
