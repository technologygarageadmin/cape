# Cape Frontend Reference

## Overview

React 19 + Vite SPA for monitoring and controlling the Cape trading system. Communicates with two backend APIs:
- **Port 8001** — order-critical writes (place/cancel orders, mode changes)
- **Port 8002** — read-only display data (charts, history, account)

---

## Stack

| Library | Version | Purpose |
|---------|---------|---------|
| React | 19.x | UI framework |
| React Router | 7.x | Client-side routing |
| Vite | 8.x | Dev server + bundler |
| lightweight-charts | 5.x | Candlestick + indicator charts |
| lucide-react | 0.577 | Icon set |

---

## Routing (`App.jsx`)

| Path | Component | Purpose |
|------|-----------|---------|
| `/lock` | `WebLock` | PIN auth gate |
| `/dashboard` | `Dashboard` | Main overview |
| `/trading` | `TradingView` | Candlestick chart + indicators |
| `/atr` | `ATRView` | Volatility view |
| `/summary` | `OverallSummary` | Trade history + analytics |
| `/live` | `LivePositions` | Real-time position monitor |
| `/radar` | `SignalRadar` | Signal readiness for all symbols |
| `*` | redirect | → `/dashboard` |

All routes except `/lock` are wrapped in `ProtectedShell` (checks PIN session in localStorage).

---

## Pages

### `Dashboard.jsx`
Main overview. Polls every 5–10 seconds.

**API calls:**
- `GET /api/account` — equity, buying power, cash
- `GET /api/positions` — open Alpaca positions
- `GET /api/options-log?limit=100` — recent trades from MongoDB

**Displays:** Equity, buying power, win rate, active trade count, AI trade table, daily/monthly PnL, strategy status.

---

### `LivePositions.jsx`
Real-time monitoring of open positions with live exit thresholds.

**API calls:**
- `GET /api/live-positions` — merges position registry + exit state
- `GET /api/orders/{order_id}/status` — per-order status
- `ws://localhost:8001/ws/quotes?symbols=...` — live bid/ask (optional, falls back to polling)

**Displays:** Contract, qty, fill price, current price, PnL %, TP/SL prices (static + dynamic), QP floor, trailing SL, hold duration, entry quality badge.

**Color coding:**
- Green → excellent (large profit buffer)
- Blue → good
- Yellow → neutral
- Orange → weak
- Red → at or near SL

---

### `TradingView.jsx`
Interactive candlestick chart with technical indicators and trade markers.

**API calls:**
- `GET /api/bars?symbol=SPY&timeframe=1min&limit=200` — OHLCV + backend RSI

**Client-side calculations:**
- EMA (9, 21, 55) — `k = 2 / (period + 1)` formula
- RSI (14-period with smoothing)
- EMA crossover detection → buy/sell markers
- RSI mean reversion markers (oversold 40, overbought 70)

**Controls:** Symbol dropdown (SPY, QQQ, TSLA, NVDA, etc.), timeframe (1min–1d), indicator toggles (RSI, EMA, volume).

**Chart library:** `lightweight-charts` v5 via the reusable `CandleChart` component.

---

### `SignalRadar.jsx`
Real-time readiness monitor for all watchlist symbols. Updates every 2–3 seconds.

**API calls:**
- `GET /api/signal-readiness` — readiness state + filter checklist per symbol
- `POST /api/symbol/mode` — toggle symbol mode (auto/manual/off)
- `GET /api/strategies`, `POST /api/strategies/toggle` — strategy enable/disable

**Displays per symbol:** Mode badge (AIT/MT/OFF), status (CALL_READY/PUT_READY/BLOCKED/SCANNING/etc.), circular readiness gauges, 13-filter checklist, confidence level (0–100%).

**Features:** Searchable symbol sidebar, audio + visual alert on signal ready, mode filter (show only AIT/MT/OFF symbols).

---

### `OverallSummary.jsx`
Trade history analytics with filters and trend charts.

**API calls:**
- `GET /api/options-log?symbol=SPY&result=WIN&limit=100`

**Filters:** Date range (1H / 3H / TODAY / WEEK / MONTH / ALL TIME), symbol, result (WIN/LOSS), trade type (AIT/MANUAL).

**Displays:** Win rate, trade count, gross P&L, avg profit/loss per trade, performance table, daily PnL bar chart, monthly cumulative chart.

---

### `ATRView.jsx`
Average True Range visualization and volatility rankings.

**API calls:** `GET /api/bars` (multiple symbols)

**Displays:** ATR by symbol, volatility rankings (high/medium/low), intraday volatility trends.

---

### `WebLock.jsx`
6-digit PIN auth gate.
- PIN compared against hardcoded SHA-256 hash
- 3 attempts max, then lockout
- Session persisted in `localStorage`

---

## Components

### `CandleChart.jsx`
Reusable `lightweight-charts` wrapper.

**Key props:**

| Prop | Type | Purpose |
|------|------|---------|
| `data` | OHLCV[] | Candlestick bars |
| `obrLines` | `{high, low}` | Opening Bar Range overlays |
| `rsiPoints` | number[] | RSI series |
| `rsiMaPoints` | number[] | RSI MA series |
| `emaLines` | `{9, 21, 55}` | EMA overlay series |
| `emaCrossMarkers` | marker[] | Buy/sell crossover markers |
| `rsiMeanReversionMarkers` | marker[] | RSI signal markers |
| `livePrice` | number | Real-time bid/ask update |
| `onPointHover` / `onPointLeave` | fn | Crosshair tooltip callbacks |

**Features:** Auto-scale, responsive, crosshair + tooltip, time x-axis, price y-axis.

---

### `Header.jsx`
Sticky navigation bar.
- Logo + brand ("CAPE")
- Nav links: Dashboard, Trading, ATR, Summary, Live, Radar
- Right: notification bell, settings dropdown (strategy toggles, symbol modes), logout

**Brand colors:** Gold `#C9A227` / `#F5C518`, white background with shadow.

---

## API Base URLs

Hardcoded in components (no `.env` abstraction currently):

```
http://localhost:8001   — trading operations (writes)
http://localhost:8002   — display/read-only
ws://localhost:8001     — WebSocket quotes
```

If backend ports change, update all component fetch calls.

---

## Dev Setup

```bash
cd Frontend
npm install
npm run dev     # http://localhost:5173
```

Build for production:
```bash
npm run build   # outputs to dist/
npm run preview # serves built output locally
```

Lint:
```bash
npm run lint
```

---

## Key State Patterns

- **Polling** — most pages use `setInterval` (5–10s) for data refresh; no global state manager
- **WebSocket** — `LivePositions` and `SignalRadar` use WebSocket where available, fall back to polling
- **localStorage** — PIN session token stored here; cleared on logout
- **No global store** — each page manages its own fetch state independently
