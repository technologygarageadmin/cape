import React, { useState, useEffect, useRef } from 'react'
import CandleChart from '../components/CandleChart'

// --- EMA calculation ---
const toChartTime = (time) => {
  if (typeof time === 'number') return time
  const parsed = new Date(time).getTime()
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : time
}

function calcEMA(data, period) {
  if (!Array.isArray(data) || data.length < period) return [];
  const k = 2 / (period + 1);
  let emaPrev = data.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  const result = [{ time: toChartTime(data[period - 1].time), value: emaPrev }];
  for (let i = period; i < data.length; i++) {
    const price = data[i].close;
    emaPrev = price * k + emaPrev * (1 - k);
    result.push({ time: toChartTime(data[i].time), value: emaPrev });
  }
  return result;
}

function calcRSI(data, period = 3) {
  if (!Array.isArray(data) || data.length <= period) return [];
  const closes = data.map(d => Number(d.close));
  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const result = [{
    time: toChartTime(data[period].time),
    value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  }];

  for (let i = period + 1; i < data.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result.push({
      time: toChartTime(data[i].time),
      value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
    });
  }

  return result;
}

// --- EMA crossover detection ---
function getEMACrossMarkers(emaFast, emaSlow, trendEma = [], bars = []) {
  const markers = [];
  const slowByTime = new Map((emaSlow || []).map(point => [point.time, point.value]));
  const trendByTime = new Map((trendEma || []).map(point => [point.time, point.value]));
  const closeByTime = new Map((bars || []).map(bar => [toChartTime(bar.time), Number(bar.close)]));
  const aligned = (emaFast || [])
    .filter(point => slowByTime.has(point.time))
    .map(point => ({
      time: point.time,
      fast: point.value,
      slow: slowByTime.get(point.time),
      trend: trendByTime.get(point.time),
      close: closeByTime.get(point.time),
    }));

  for (let i = 1; i < aligned.length; i++) {
    const prevFast = aligned[i - 1].fast, prevSlow = aligned[i - 1].slow;
    const currFast = aligned[i].fast, currSlow = aligned[i].slow;
    const priceAboveTrend = Number.isFinite(aligned[i].close) &&
      Number.isFinite(aligned[i].trend) &&
      aligned[i].close > aligned[i].trend;

    if (prevFast <= prevSlow && currFast > currSlow && priceAboveTrend) {
      markers.push({ time: aligned[i].time, type: 'buy' });
    } else if (prevFast >= prevSlow && currFast < currSlow) {
      markers.push({ time: aligned[i].time, type: 'sell' });
    }
  }
  return markers;
}

function getRSIMeanReversionMarkers(rsiPoints, oversold = 40, overbought = 70) {
  const markers = [];
  for (let i = 1; i < (rsiPoints || []).length; i++) {
    const prev = rsiPoints[i - 1].value;
    const curr = rsiPoints[i].value;
    if (prev <= oversold && curr > oversold) {
      markers.push({ time: rsiPoints[i].time, type: 'buy', strategy: 'rsi-mr' });
    } else if (prev >= overbought && curr < overbought) {
      markers.push({ time: rsiPoints[i].time, type: 'sell', strategy: 'rsi-mr' });
    }
  }
  return markers;
}
import {
  Play, Square, TrendingUp, TrendingDown, Target,
  ShieldAlert, Activity, DollarSign, CheckCircle2, Layers, Zap, User
} from 'lucide-react'
import Loader from '../components/loader'

const GOLD = '#C9A227'
const GOLD_LIGHT = '#F5C518'
const GOLD_DEEP = '#A07C10'

const STOCK_SYMBOLS = [
  { symbol: 'SPY',   name: 'S&P 500 ETF',       basePrice: 524.75,  sector: 'ETF'    },
  { symbol: 'QQQ',   name: 'Nasdaq ETF',        basePrice: 464.20,  sector: 'ETF'    },
  { symbol: 'AAPL',  name: 'Apple Inc.',       basePrice: 182.40,  sector: 'Tech'   },
  { symbol: 'TSLA',  name: 'Tesla Inc.',        basePrice: 248.60,  sector: 'EV'     },
  { symbol: 'MSFT',  name: 'Microsoft',         basePrice: 415.20,  sector: 'Tech'   },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',      basePrice: 892.40,  sector: 'Chips'  },
  { symbol: 'AMZN',  name: 'Amazon',            basePrice: 195.80,  sector: 'Tech'   },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',     basePrice: 175.30,  sector: 'Tech'   },
  { symbol: 'META',  name: 'Meta Platforms',    basePrice: 524.10,  sector: 'Social' },
  { symbol: 'AMD',   name: 'AMD',               basePrice: 168.90,  sector: 'Chips'  },
  { symbol: 'NFLX',  name: 'Netflix',           basePrice: 985.40,  sector: 'Media'  },
  { symbol: 'BAC',   name: 'Bank of America',   basePrice: 38.70,   sector: 'Finance'},
]

const INTERVALS = ['1m', '5m', '15m', '1H', '4H', '1D']
const STRATEGIES = ['ATR Momentum', 'RSI Mean Reversion', 'Breakout Strategy', 'EMA Crossover', 'MACD Signal']

const API_TRADING = 'http://localhost:8001'
const API_DISPLAY = 'http://localhost:8002'
const INTERVAL_MAP = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1H': '1Hour', '4H': '4Hour', '1D': '1Day' }
// Enough history to render EMA(50) and detect EMA(9/21) crosses.
const BARS_LIMIT = { '1m': 800, '5m': 500, '15m': 300, '1H': 240, '4H': 220, '1D': 220 }
// Polling interval per chart interval (ms) — no faster than 30s
const POLL_MS = { '1m': 5_000, '5m': 5_000, '15m': 5_000, '1H': 5_000, '4H': 5_000, '1D': 5_000 }
// Normalize API bar: map `timestamp` field → `time` that CandleChart expects
const normalizeBar = (b) => ({ ...b, time: b.time ?? b.timestamp })

// Fallback candle generator used when API is unavailable
function generateCandles(basePrice, count = 80) {
  const now = Math.floor(Date.now() / 1000)
  const step = 5 * 60
  let price = basePrice
  const candles = []
  for (let i = count; i >= 0; i--) {
    const open = price
    const change = (Math.random() - 0.48) * (basePrice * 0.008)
    const close = +(open + change).toFixed(2)
    const high = +(Math.max(open, close) + Math.random() * basePrice * 0.003).toFixed(2)
    const low  = +(Math.min(open, close) - Math.random() * basePrice * 0.003).toFixed(2)
    const volume = Math.floor(50000 + Math.random() * 450000)
    candles.push({ time: now - i * step, open: +open.toFixed(2), high, low, close, volume })
    price = close
  }
  return candles
}

// CDT helper – returns a locale time string in America/Chicago
const cdtTime = (d = new Date()) =>
  d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const fmtEntryTime = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const isMarketOpen = () => {
  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const day = ct.getDay()
  if (day === 0 || day === 6) return false // weekend
  const mins = ct.getHours() * 60 + ct.getMinutes()
  // Market: 9:30 AM ET = 8:30 AM CDT  |  4:00 PM ET = 3:00 PM CDT
  return mins >= 8 * 60 + 30 && mins < 15 * 60
}

const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtVol = (v) => v >= 1_000_000 ? (v / 1_000_000).toFixed(2) + 'M' : v >= 1_000 ? (v / 1_000).toFixed(1) + 'K' : v
const fmtPctSigned = (v) => `${v >= 0 ? '+' : ''}${Number(v || 0).toFixed(2)}%`
const toNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const fmtMoneyMaybe = (v) => {
  const n = toNum(v)
  return n == null ? '—' : `$${fmt(n)}`
}
const fmtPctMaybe = (v) => {
  const n = toNum(v)
  return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}
const fmtTickTime = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const asList = (value) => {
  if (Array.isArray(value)) return value.filter(v => v != null && String(v).trim())
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  }
  return []
}

const strategyLabelFromId = (id) => String(id || '')
  .toLowerCase()
  .split('_')
  .filter(Boolean)
  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ')

const resolveEntryStrategyNames = (trade) => {
  const explicit = asList(trade?.entryStrategyNames ?? trade?.entry_strategy_names)
  if (explicit.length > 0) return explicit
  const ids = asList(trade?.entryStrategies ?? trade?.entry_strategies)
  if (ids.length > 0) return ids.map(strategyLabelFromId)
  if (trade?.strategy) return [trade.strategy]
  return []
}

const formatEntryStrategies = (trade) => {
  const names = resolveEntryStrategyNames(trade)
  return names.length > 0 ? names.join(', ') : '—'
}

export default function TradingView() {
  const [selected, setSelected]       = useState(() => STOCK_SYMBOLS.find(s => s.symbol === 'TSLA') ?? STOCK_SYMBOLS[0])
  const [interval, setInterval_]      = useState('1m')
  const [strategy, setStrategy]       = useState('ATR Momentum')
  const [candles, setCandles]         = useState(() => { const spy = STOCK_SYMBOLS.find(s => s.symbol === 'SPY') ?? STOCK_SYMBOLS[0]; return generateCandles(spy.basePrice) })
  const [rsi, setRsi]                 = useState(null)
  const [rsiPoints, setRsiPoints]     = useState([])
  const [rsiMaPoints, setRsiMaPoints] = useState([])
  const [rsiMarkers, setRsiMarkers]   = useState([])
  const [obrLevels, setObrLevels]     = useState([])
  const [showEmaOverlay, setShowEmaOverlay] = useState(true)
  const [barsLoading, setBarsLoading] = useState(false)
  const [tpPct, setTpPct]             = useState('2.0')
  const [slPct, setSlPct]             = useState('1.0')
  const [tradeActive, setTradeActive]     = useState(false)
  const [autoTrade, setAutoTrade]           = useState(false)
  const [lastTrade, setLastTrade]           = useState(null)
  const [hoveredSymbol, setHoveredSymbol]   = useState(null)
  const [liquidating, setLiquidating]       = useState(null)
  const autoTimerRef       = useRef(null)
  const lastBarTimeRef     = useRef(null)  // tracks latest bar timestamp for incremental polling
  const suggestContractRef = useRef(null)  // stores latest contract_name from /api/options/suggest
  const optionTypeRef      = useRef('call')  // always holds latest optionType for stale-closure-safe intervals

  // Manual trade mode state
  // Initialized as 'ai' — overwritten by symbolMode sync once /api/config/trading-modes responds
  const [tradeMode, setTradeMode]           = useState('ai')  // 'ai' | 'manual'
  const [strikePrice, setStrikePrice]       = useState('')
  const [direction, setDirection]           = useState('uptrend')  // 'uptrend' | 'downtrend'
  const [optionType, setOptionType]         = useState('call')     // 'call' | 'put'
  const [expiry, setExpiry]                 = useState('')
  const [qty, setQty]                       = useState('1')
  const [manualPosition, setManualPosition] = useState(null)
  const [contractPrice, setContractPrice]   = useState(0)
  const [orderStatus, setOrderStatus]       = useState(null)  // null | 'waiting' | 'filled' | 'error'
  const [tradeHistory, setTradeHistory]     = useState([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [autoSuggestEnabled, setAutoSuggestEnabled] = useState(true)
  const [contractQuote, setContractQuote]     = useState(null)  // { bid, ask, mid, spread_pct }
  const [quoteBook, setQuoteBook]             = useState({ call: null, put: null })
  const [mktCountdown, setMktCountdown]       = useState('')
  const [toasts, setToasts]                   = useState([])
  const toastIdRef = useRef(0)
  const [livePositions, setLivePositions]     = useState([])
  const [histTimeFilter, setHistTimeFilter]   = useState('Today')
  const [histTypeFilter, setHistTypeFilter]   = useState('All')  // 'All' | 'MT' | 'AIT'
  // Global AIT/MT config gate from backend config.py
  const [tradingConfig, setTradingConfig]     = useState({ ait_enabled: true, mt_enabled: true, config_healthy: true, config_warning: null, symbols: [] })
  const [entryStrategies, setEntryStrategies] = useState({ maxEnabled: 2, enabled: [], available: [] })
  const [strategyBusy, setStrategyBusy]       = useState(false)

  // symbolMode: 'off' | 'auto' | 'manual' per symbol
  // Default to 'off' for all until backend sync resolves the correct per-symbol mode
  const [symbolMode, setSymbolMode] = useState(() =>
    Object.fromEntries(STOCK_SYMBOLS.map(s => [s.symbol, 'off']))
  )

  // On mount: sync all symbol modes + global config gates from backend
  useEffect(() => {
    const fetchConfig = () =>
      fetch(`${API_DISPLAY}/api/config/trading-modes`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
        .then(cfg => {
          if (!cfg) return
          setTradingConfig(cfg)
          if (cfg.strategies) {
            setEntryStrategies({
              maxEnabled: Number(cfg.strategies.maxEnabled) || 2,
              enabled: Array.isArray(cfg.strategies.enabled) ? cfg.strategies.enabled : [],
              available: Array.isArray(cfg.strategies.available) ? cfg.strategies.available : [],
            })
          }
          const merged = {}
          ;(cfg.symbols || []).forEach(s => { if (s.symbol && s.mode) merged[s.symbol] = s.mode })
          if (Object.keys(merged).length > 0)
            setSymbolMode(prev => ({ ...prev, ...merged }))
          // Show warning toast if config misconfigured
          if (!cfg.config_healthy)
            pushToast(cfg.config_warning || 'Trading config error', 'error')
          else if (cfg.config_warning)
            pushToast(cfg.config_warning, 'info')
        })
    fetchConfig()
    // Re-verify every 30s so UI stays in sync if config.py is edited and server restarted
    const id = setInterval(fetchConfig, 30_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep strategy status live even if another session changes it.
  useEffect(() => {
    const pollStrategies = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/strategies`)
        if (!res.ok) return
        const data = await res.json()
        setEntryStrategies({
          maxEnabled: Number(data.maxEnabled) || 2,
          enabled: Array.isArray(data.enabled) ? data.enabled : [],
          available: Array.isArray(data.available) ? data.available : [],
        })
      } catch (_) {}
    }
    pollStrategies()
    const id = setInterval(pollStrategies, 2_000)
    return () => clearInterval(id)
  }, [])

  // Keep right-panel tradeMode in sync with the selected symbol's symbolMode
  // (This is the ONLY place tradeMode is derived from — always backend-driven)
  useEffect(() => {
    const mode = symbolMode[selected.symbol]
    if (mode === 'auto') setTradeMode('ai')
    else if (mode === 'manual') setTradeMode('manual')
    // 'off' — leave tradeMode as-is (no active bot; user can still pick manual)
  }, [selected.symbol, symbolMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Market-open countdown — updates every minute
  useEffect(() => {
    const calcCountdown = () => {
      const now = new Date()
      // Current time in ET
      const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' })
      const et = new Date(etStr)
      const open = new Date(etStr)
      open.setHours(9, 30, 0, 0)
      const close = new Date(etStr)
      close.setHours(16, 0, 0, 0)
      const day = et.getDay() // 0=Sun,6=Sat
      if (day === 0 || day === 6) {
        setMktCountdown('closed (weekend)')
        return
      }
      if (et >= open && et < close) {
        setMktCountdown('open')
        return
      }
      if (et < open) {
        const mins = Math.round((open - et) / 60000)
        setMktCountdown(`opens in ${mins} min${mins !== 1 ? 's' : ''}`)
      } else {
        setMktCountdown('closed')
      }
    }
    calcCountdown()
    const id = setInterval(calcCountdown, 60_000)
    return () => clearInterval(id)
  }, [])

  const setSymbolModeFor = async (sym, mode, e) => {
    e.stopPropagation()
    const currentMode = symbolMode[sym]
    const newMode = currentMode === mode ? 'off' : mode

    // ── Config gate enforcement ──────────────────────────────────────
    if (newMode === 'auto' && !tradingConfig.ait_enabled) {
      pushToast('AIT is disabled in config — cannot switch to AIT mode', 'error')
      return
    }
    if (newMode === 'manual' && !tradingConfig.mt_enabled) {
      pushToast('Manual Trading is disabled in config — cannot switch to MT mode', 'error')
      return
    }

    // Confirm before switching to OFF
    if (newMode === 'off') {
      const hasOpenPos = sym === selected.symbol && (tradeActive || manualPosition)
      const ok = window.confirm(
        hasOpenPos
          ? `Turn OFF trading for ${sym}?\n\nAll open positions will be automatically closed.`
          : `Turn OFF trading for ${sym}?\n\nThe bot will stop monitoring this symbol.`
      )
      if (!ok) return
      // Close positions before switching off
      if (sym === selected.symbol) {
        if (tradeActive) await stopTrade()
        if (manualPosition) await handleSell()
      }
    }

    // Confirm before switching to Manual
    if (newMode === 'manual' && currentMode === 'auto') {
      const ok = window.confirm(
        `Switch ${sym} to Manual Trade mode?\n\nThe AI bot will pause and you will place trades manually.`
      )
      if (!ok) return
    }

    setSymbolMode(prev => ({ ...prev, [sym]: newMode }))

    // Notify backend so main.py respects the new mode immediately
    try {
      await fetch(`${API_DISPLAY}/api/symbol/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, mode: newMode }),
      })
    } catch (_) {}

    // Sync right-panel tradeMode when acting on the currently selected symbol
    if (sym === selected.symbol) {
      if (newMode === 'auto') {
        setTradeMode('ai')
      } else if (newMode === 'manual') {
        // Stop any active AI trade before switching to manual
        if (tradeActive) {
          try {
            await fetch(`${API_TRADING}/api/ai-trade/stop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ symbol: sym }),
            })
          } catch (_) {}
          setTradeActive(false)
          setLastTrade(t => t ? { ...t, status: 'CLOSED' } : t)
        }
        setTradeMode('manual')
      }
    }

    // Toast: AIT ↔ MT mode change only (not OFF)
    if (newMode === 'auto') {
      pushToast(`AIT Enabled · ${sym}`, 'success')
    } else if (newMode === 'manual') {
      pushToast(`Manual Trade Mode · ${sym}`, 'info')
    }
  }

  const [livePrices, setLivePrices] = useState(() => {
    const m = {}
    STOCK_SYMBOLS.forEach(s => { m[s.symbol] = s.basePrice })
    return m
  })
  const prevPricesRef = useRef({})

  // ── Poll /api/quotes every 1.5 s for live prices ──
  useEffect(() => {
    const symbols = STOCK_SYMBOLS.map(s => s.symbol).join(',')
    const poll = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/quotes?symbols=${symbols}`)
        if (!res.ok) return
        const data = await res.json()
        const priceMap = {}
        for (const q of data.quotes ?? []) {
          if (q.symbol && q.price) priceMap[q.symbol] = q.price
        }
        if (Object.keys(priceMap).length === 0) return
        setLivePrices(prev => {
          prevPricesRef.current = { ...prev }
          return { ...prev, ...priceMap }
        })
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 15000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!tradeActive || !lastTrade) return
    const price = livePrices[lastTrade.symbol]
    if (price >= lastTrade.tp) {
      const pnl = +(lastTrade.tp - lastTrade.entry).toFixed(2)
      setTradeHistory(prev => [{
        id: Date.now(),
        type: 'ai',
        symbol: lastTrade.symbol,
        name: lastTrade.name,
        contractName: `${lastTrade.symbol} AI — ${lastTrade.strategy}`,
        strikePrice: lastTrade.entry,
        optionType: '—',
        direction: '—',
        expiry: '—',
        qty: 1,
        buyPrice: lastTrade.entry,
        sellPrice: lastTrade.tp,
        pnl,
        result: 'WIN',
        entryTime: lastTrade.startTime,
        exitTime: cdtTime(),
        strategy: lastTrade.strategy,
        _entryIso: new Date().toISOString(),
      }, ...prev])
      setLastTrade(t => ({ ...t, status: 'TP_HIT', exitPrice: price }))
      setTradeActive(false)
      pushToast(`Take Profit Hit! · ${lastTrade.symbol} · +$${fmt(Math.abs(lastTrade.tp - lastTrade.entry))}`, 'success')
    } else if (price <= lastTrade.sl) {
      const pnl = +(lastTrade.sl - lastTrade.entry).toFixed(2)
      setTradeHistory(prev => [{
        id: Date.now(),
        type: 'ai',
        symbol: lastTrade.symbol,
        name: lastTrade.name,
        contractName: `${lastTrade.symbol} AI — ${lastTrade.strategy}`,
        strikePrice: lastTrade.entry,
        optionType: '—',
        direction: '—',
        expiry: '—',
        qty: 1,
        buyPrice: lastTrade.entry,
        sellPrice: lastTrade.sl,
        pnl,
        result: 'LOSS',
        entryTime: lastTrade.startTime,
        exitTime: cdtTime(),
        strategy: lastTrade.strategy,
        _entryIso: new Date().toISOString(),
      }, ...prev])
      setLastTrade(t => ({ ...t, status: 'SL_HIT', exitPrice: price }))
      setTradeActive(false)
      pushToast(`Stop Loss Hit · ${lastTrade.symbol} · -$${fmt(Math.abs(lastTrade.sl - lastTrade.entry))}`, 'error')
    }
  }, [livePrices, tradeActive, lastTrade])

  const livePrice = livePrices[selected.symbol]
  const prevPrice = prevPricesRef.current[selected.symbol] || livePrice
  const priceUp   = livePrice >= prevPrice

  const tpPrice = +(livePrice * (1 + parseFloat(tpPct || 0) / 100)).toFixed(2)
  const slPrice = +(livePrice * (1 - parseFloat(slPct || 0) / 100)).toFixed(2)

  const tradeTpPrice = lastTrade?.tp ?? tpPrice
  const tradeSlPrice = lastTrade?.sl ?? slPrice

  const livePnL    = tradeActive && lastTrade ? +(livePrice - lastTrade.entry).toFixed(2) : 0
  const livePnLPct = tradeActive && lastTrade
    ? (((livePrice - lastTrade.entry) / lastTrade.entry) * 100).toFixed(2)
    : '0.00'

  const pushToast = (message, type = 'info') => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }

  const toggleEntryStrategy = async (strategyId, nextEnabled) => {
    const enabledNow = Array.isArray(entryStrategies.enabled) ? entryStrategies.enabled : []
    if (nextEnabled && !enabledNow.includes(strategyId) && enabledNow.length >= (entryStrategies.maxEnabled || 2)) {
      pushToast(`Only ${entryStrategies.maxEnabled || 2} entry strategies can be active`, 'error')
      return
    }

    setStrategyBusy(true)
    try {
      const res = await fetch(`${API_DISPLAY}/api/strategies/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: strategyId, enabled: nextEnabled }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || `Unable to update strategy (${res.status})`)
      }
      const data = await res.json()
      setEntryStrategies({
        maxEnabled: Number(data.maxEnabled) || 2,
        enabled: Array.isArray(data.enabled) ? data.enabled : [],
        available: Array.isArray(data.available) ? data.available : [],
      })
      pushToast(nextEnabled ? 'Strategy enabled' : 'Strategy disabled', 'success')
    } catch (err) {
      pushToast(err.message || 'Failed to toggle strategy', 'error')
    } finally {
      setStrategyBusy(false)
    }
  }

  const handleSymbolSelect = (stock) => {
    if (tradeActive) return
    setSelected(stock)
    setCandles(generateCandles(stock.basePrice)) // show immediately; API fetch will replace
    setRsi(null)
    setRsiPoints([])
    setRsiMaPoints([])
    setRsiMarkers([])
    setObrLevels([])
  }

  const startTrade = async () => {
    const entry = livePrice
    const tp    = +(entry * (1 + parseFloat(tpPct) / 100)).toFixed(2)
    const sl    = +(entry * (1 - parseFloat(slPct) / 100)).toFixed(2)
    try {
      await fetch(`${API_TRADING}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selected.symbol,
          side: 'buy',
          qty: 1,
          type: 'market',
          time_in_force: 'day',
        }),
      })
    } catch (_) {}
    setLastTrade({
      symbol: selected.symbol,
      name: selected.name,
      entry, tp, sl, strategy,
      startTime: cdtTime(),
      status: 'ACTIVE',
    })
    setTradeActive(true)
    pushToast(`Position Opened · ${selected.symbol}`, 'success')
  }

  const stopTrade = async () => {
    let exitPrice = livePrice
    try {
      const res = await fetch(`${API_TRADING}/api/positions/${selected.symbol}/close`, { method: 'POST' })
      if (res.ok) {
        const closed = await res.json()
        exitPrice = closed.exit_price ?? livePrice
      }
    } catch (_) {}
    setLastTrade(t => {
      if (t) {
        const pnl = +(exitPrice - t.entry).toFixed(2)
        setTradeHistory(prev => [{
          id: Date.now(),
          type: 'ai',
          symbol: t.symbol,
          name: t.name,
          contractName: `${t.symbol} AI — ${t.strategy}`,
          strikePrice: t.entry,
          optionType: '—',
          direction: '—',
          expiry: '—',
          qty: 1,
          buyPrice: t.entry,
          sellPrice: exitPrice,
          pnl,
          result: pnl >= 0 ? 'WIN' : 'LOSS',
          entryTime: t.startTime,
          exitTime: cdtTime(),
          strategy: t.strategy,
          _entryIso: new Date().toISOString(),
        }, ...prev])
        return { ...t, status: 'CLOSED', exitPrice }
      }
      return t
    })
    const closePnl = lastTrade ? +(exitPrice - lastTrade.entry).toFixed(2) : 0
    pushToast(
      `Position Closed · ${selected.symbol} · ${closePnl >= 0 ? '+' : ''}$${Math.abs(closePnl).toFixed(2)}`,
      closePnl >= 0 ? 'success' : 'error'
    )
    setTradeActive(false)
  }

  const handleLiquidatePosition = async (symbol) => {
    if (!symbol) return
    const ok = window.confirm(`Liquidate open position for ${symbol}?`)
    if (!ok) return
    setLiquidating(symbol)
    try {
      // 1. Stop the AI monitoring thread for this symbol's underlying
      const underlying = symbol.replace(/\d{6}[CP]\d+$/i, '')
      if (underlying) {
        try {
          await fetch(`${API_TRADING}/api/ai-trade/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: underlying }),
          })
        } catch (_) { /* best effort */ }
      }

      // 2. Close the position via Alpaca
      // Try trading API first; if it fails (network error or non-OK),
      // fall back to the display proxy which may forward the request.
      let data = null
      try {
        const res = await fetch(`${API_TRADING}/api/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' })
        if (res.ok) {
          data = await res.json()
        } else {
          const errData = await res.json().catch(() => ({}))
          throw new Error(errData?.detail || `Liquidation failed (${res.status})`)
        }
      } catch (errPrimary) {
        // Primary failed — attempt display server proxy as a best-effort fallback
        try {
          const res2 = await fetch(`${API_DISPLAY}/api/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' })
          if (res2.ok) {
            data = await res2.json()
            pushToast('Liquidate: used display proxy fallback', 'info')
          } else {
            const errData2 = await res2.json().catch(() => ({}))
            throw new Error(errData2?.detail || `Liquidation failed (${res2.status})`)
          }
        } catch (errFallback) {
          // Re-throw the primary error if no fallback succeeded so the outer catch shows it
          throw errFallback || errPrimary
        }
      }

      if (data?.logged_trade) {
        setTradeHistory(prev => [{ ...data.logged_trade, _entryIso: data.logged_trade.entryTime || new Date().toISOString() }, ...prev])
      }

      setLivePositions(prev => prev.filter(p => p.symbol !== symbol))
      pushToast(`Liquidated ${symbol}`, 'success')
    } catch (err) {
      pushToast(`Failed to liquidate: ${err.message}`, 'error')
    } finally {
      setLiquidating(null)
    }
  }

  // ── Full fetch: 2-day history whenever symbol or interval changes ────────
  useEffect(() => {
    const fetchBars = async () => {
      setBarsLoading(true)
      try {
        const tf    = INTERVAL_MAP[interval] || '5Min'
        const limit = BARS_LIMIT[interval]   || 200
        const res = await fetch(`${API_DISPLAY}/api/bars?symbol=${selected.symbol}&timeframe=${tf}&limit=${limit}`)
        if (!res.ok) throw new Error('bad response')
        const data = await res.json()
        if (data.bars?.length) {
          const normalized = data.bars.map(normalizeBar)
          setCandles(normalized)
          // seed the latest bar timestamp so polling can detect new bars
          lastBarTimeRef.current = data.bars[data.bars.length - 1]?.timestamp ?? null
          setRsi(data.rsi ?? null)
          setRsiPoints(Array.isArray(data.rsi_points) ? data.rsi_points : [])
          setRsiMaPoints(Array.isArray(data.rsi_ma_points) ? data.rsi_ma_points : [])
          setRsiMarkers(Array.isArray(data.rsi_markers) ? data.rsi_markers : [])
        }
        // else: API returned no bars — keep generated fallback
      } catch (_) {
        // API unreachable — keep whatever candles are in state (generated fallback)
      } finally {
        setBarsLoading(false)
      }
    }
    lastBarTimeRef.current = null  // reset on symbol/interval change
    fetchBars()
  }, [selected.symbol, interval])

  // ── OBR: always computed from the first 5-min bar of the latest day ────────
  useEffect(() => {
    const fetchObr = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/bars?symbol=${selected.symbol}&timeframe=5Min&limit=5`)
        if (!res.ok) return
        const data = await res.json()
        if (data.obr?.high != null && data.obr?.low != null) {
          setObrLevels([
            { label: 'OBR High', price: data.obr.high, color: '#8b5cf6' },
            { label: 'OBR Low',  price: data.obr.low,  color: '#f59e0b' },
          ])
        } else {
          setObrLevels([])
        }
      } catch (_) {}
    }
    fetchObr()
  }, [selected.symbol])

  // ── Live open positions: poll Alpaca every 5 s ────────────────────────────
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/positions`)
        if (!res.ok) return
        const data = await res.json()
        const rows = Array.isArray(data)
          ? data
          : Array.isArray(data?.positions)
            ? data.positions
            : []
        setLivePositions(rows)
      } catch (_) {}
    }
    fetchPositions()
    const id = setInterval(fetchPositions, 5_000)
    return () => clearInterval(id)
  }, [])

  // ── Backend registry positions: poll /api/live-positions for activity panel ──
  const [registryPositions, setRegistryPositions] = useState([])
  useEffect(() => {
    const fetchRegistry = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/live-positions`)
        if (!res.ok) return
        const data = await res.json()
        setRegistryPositions(Array.isArray(data?.positions) ? data.positions : [])
      } catch (_) {}
    }
    fetchRegistry()
    const id = setInterval(fetchRegistry, 2_000)
    return () => clearInterval(id)
  }, [])

  // Resolve one canonical live price per contract so all widgets show the same number.
  const resolveContractLivePrice = (contractSymbol, fallbackPrice = 0) => {
    const contract = String(contractSymbol || '')
    if (!contract) return Number(fallbackPrice) || 0

    const registryPos = registryPositions.find(lp =>
      String(lp.contract_symbol || lp.symbol || '') === contract
    )
    const registryPrice = toNum(registryPos?.live?.current_price)
    if (registryPrice != null && registryPrice > 0) return registryPrice

    if (manualPosition?.contractSymbol && String(manualPosition.contractSymbol) === contract) {
      const manualLivePrice = toNum(contractPrice)
      if (manualLivePrice != null && manualLivePrice > 0) return manualLivePrice
    }

    const alpacaPos = livePositions.find(p => String(p.symbol || '') === contract)
    const alpacaPrice = toNum(alpacaPos?.current_price)
    if (alpacaPrice != null && alpacaPrice > 0) return alpacaPrice

    return Number(fallbackPrice) || 0
  }

  useEffect(() => {
    if (!manualPosition?.contractSymbol) return
    const syncedPrice = resolveContractLivePrice(manualPosition.contractSymbol, contractPrice)
    if (syncedPrice > 0 && Math.abs(syncedPrice - Number(contractPrice || 0)) > 0.0001) {
      setContractPrice(syncedPrice)
    }
  }, [manualPosition?.contractSymbol, registryPositions, livePositions, contractPrice]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Polling: append new bars as they arrive (no full re-fetch) ────────────
  useEffect(() => {
    const pollNewBars = async () => {
      try {
        const tf  = INTERVAL_MAP[interval] || '5Min'
        const limit = BARS_LIMIT[interval] || 200
        const res = await fetch(`${API_DISPLAY}/api/bars?symbol=${selected.symbol}&timeframe=${tf}&limit=${limit}`)
        if (!res.ok) return
        const data = await res.json()
        if (!data.bars?.length) return

        const lastKnown = lastBarTimeRef.current
        const incoming  = lastKnown
          ? data.bars.filter(b => (b.timestamp ?? b.time) > lastKnown)
          : []

        if (incoming.length > 0) {
          lastBarTimeRef.current = data.bars[data.bars.length - 1].timestamp ?? lastKnown
          setCandles(prev => {
            const existingTimes = new Set(prev.map(b => b.time ?? b.timestamp))
            const toAdd = incoming.map(normalizeBar).filter(b => !existingTimes.has(b.time))
            return toAdd.length ? [...prev, ...toAdd] : prev
          })
          if (data.rsi != null) setRsi(data.rsi)
          setRsiPoints(Array.isArray(data.rsi_points) ? data.rsi_points : [])
          setRsiMaPoints(Array.isArray(data.rsi_ma_points) ? data.rsi_ma_points : [])
          setRsiMarkers(Array.isArray(data.rsi_markers) ? data.rsi_markers : [])
        } else {
          // Update last bar in-place (price may have changed within the same candle)
          const latest = data.bars[data.bars.length - 1]
          if (latest && lastKnown && (latest.timestamp ?? latest.time) === lastKnown) {
            const updatedBar = normalizeBar(latest)
            setCandles(prev => {
              if (!prev.length) return prev
              const copy = [...prev]
              copy[copy.length - 1] = { ...copy[copy.length - 1], ...updatedBar }
              return copy
            })
          }
          if (data.rsi != null) setRsi(data.rsi)
          setRsiPoints(Array.isArray(data.rsi_points) ? data.rsi_points : [])
          setRsiMaPoints(Array.isArray(data.rsi_ma_points) ? data.rsi_ma_points : [])
          setRsiMarkers(Array.isArray(data.rsi_markers) ? data.rsi_markers : [])
        }
      } catch (_) {}
    }

    const id = setInterval(pollNewBars, POLL_MS[interval] ?? 60_000)
    return () => clearInterval(id)
  }, [selected.symbol, interval])

  // ── On mount: restore active positions + load closed order history ──
  useEffect(() => {
    const restore = async () => {
      try {
        const posRes = await fetch(`${API_DISPLAY}/api/positions`)
        if (posRes.ok) {
          const positions = await posRes.json()
          const active = positions.find(p => p.symbol === selected.symbol)
          if (active && !tradeActive) {
            setLastTrade({
              symbol: active.symbol,
              name: STOCK_SYMBOLS.find(s => s.symbol === active.symbol)?.name || active.symbol,
              entry: active.avg_entry_price,
              tp: +(active.avg_entry_price * 1.02).toFixed(2),
              sl: +(active.avg_entry_price * 0.99).toFixed(2),
              strategy: 'Restored',
              startTime: '—',
              status: 'ACTIVE',
            })
            setTradeActive(true)
          }
        }
      } catch (_) {}
      try {
        // Fetch real trade history from MongoDB: options-log (AIT/Straddle) + manual-trades
        const [optRes, manRes] = await Promise.allSettled([
          fetch(`${API_DISPLAY}/api/options-log?limit=500`),
          fetch(`${API_DISPLAY}/api/manual-trades?limit=500`),
        ])
        const normalize = (t, type) => {
          const tradeTypeRaw = String(t.tradeType || t.trade_type || '').toUpperCase()
          const normalizedType = type === 'manual'
            ? 'manual'
            : tradeTypeRaw === 'STRADDLE'
              ? 'straddle'
              : tradeTypeRaw === 'RECOVERY'
                ? 'recovery'
                : tradeTypeRaw === 'MONITOR_EXIT'
                  ? 'monitor'
                  : 'ai'

          return {
            ...t,
            id: t.id || String(Date.now() + Math.random()),
            type: normalizedType,
            tradeTypeRaw,
            name: STOCK_SYMBOLS.find(s => s.symbol === t.symbol)?.name || t.symbol,
            contractName: t.contractName || t.symbol,
            strikePrice: t.strikePrice ?? '—',
            optionType: String(t.optionType || t.option_type || t.direction || '—').toLowerCase(),
            buyPrice: Number(t.buyPrice) || 0,
            sellPrice: Number(t.sellPrice) || 0,
            pnl: Number(t.pnl) || 0,
            entryStrategies: asList(t.entryStrategies ?? t.entry_strategies),
            entryStrategyNames: resolveEntryStrategyNames(t),
            entryTime: fmtEntryTime(t.entryTime),
            exitTime: fmtEntryTime(t.exitTime),
            _entryIso: t.entryTime || t.createdAt,
          }
        }
        let combined = []
        if (optRes.status === 'fulfilled' && optRes.value.ok) {
          const d = await optRes.value.json()
          combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'ai'))]
        }
        if (manRes.status === 'fulfilled' && manRes.value.ok) {
          const d = await manRes.value.json()
          combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'manual'))]
        }
        if (combined.length > 0) setTradeHistory(combined)
      } catch (_) {}
    }
    restore()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-refresh trade history every 15s so today's trades appear live ──
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const normalize = (t, type) => {
          const tradeTypeRaw = String(t.tradeType || t.trade_type || '').toUpperCase()
          const normalizedType = type === 'manual'
            ? 'manual'
            : tradeTypeRaw === 'STRADDLE'
              ? 'straddle'
              : tradeTypeRaw === 'RECOVERY'
                ? 'recovery'
                : tradeTypeRaw === 'MONITOR_EXIT'
                  ? 'monitor'
                  : 'ai'

          return {
            ...t,
            id: t.id || String(Date.now() + Math.random()),
            type: normalizedType,
            tradeTypeRaw,
            name: STOCK_SYMBOLS.find(s => s.symbol === t.symbol)?.name || t.symbol,
            contractName: t.contractName || t.symbol,
            strikePrice: t.strikePrice ?? '—',
            optionType: String(t.optionType || t.option_type || t.direction || '—').toLowerCase(),
            buyPrice: Number(t.buyPrice) || 0,
            sellPrice: Number(t.sellPrice) || 0,
            pnl: Number(t.pnl) || 0,
            entryStrategies: asList(t.entryStrategies ?? t.entry_strategies),
            entryStrategyNames: resolveEntryStrategyNames(t),
            entryTime: fmtEntryTime(t.entryTime),
            exitTime: fmtEntryTime(t.exitTime),
            _entryIso: t.entryTime || t.createdAt,
          }
        }
        const [optRes, manRes] = await Promise.allSettled([
          fetch(`${API_DISPLAY}/api/options-log?limit=500`),
          fetch(`${API_DISPLAY}/api/manual-trades?limit=500`),
        ])
        let combined = []
        if (optRes.status === 'fulfilled' && optRes.value.ok) {
          const d = await optRes.value.json()
          combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'ai'))]
        }
        if (manRes.status === 'fulfilled' && manRes.value.ok) {
          const d = await manRes.value.json()
          combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'manual'))]
        }
        if (combined.length > 0) setTradeHistory(combined)
      } catch (_) {}
    }
    const id = setInterval(fetchHistory, 15_000)
    return () => clearInterval(id)
  }, [])

  // Auto Trade: fire startTrade automatically when market is open and no trade is running
  useEffect(() => {
    if (autoTimerRef.current) { clearTimeout(autoTimerRef.current); autoTimerRef.current = null }
    if (!autoTrade || tradeActive) return
    if (!isMarketOpen()) return
    autoTimerRef.current = setTimeout(() => { startTrade() }, 2500)
    return () => { if (autoTimerRef.current) clearTimeout(autoTimerRef.current) }
  }, [autoTrade, tradeActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-detect backend exit: poll /api/live-positions every 5s ──────────
  // When the backend monitor thread closes the position, monitoring_active flips
  // to false. Detect this and auto-clear manualPosition so the UI reflects it.
  useEffect(() => {
    if (!manualPosition?.backendMonitored || !manualPosition?.orderId) return
    const orderId = manualPosition.orderId
    const checkBackendExit = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/live-positions`)
        if (!res.ok) return
        const data = await res.json()
        const positions = Array.isArray(data?.positions) ? data.positions : []
        const myPos = positions.find(p => p.buy_order_id === orderId)
        // If not found at all OR monitoring_active is false → backend exited
        if (!myPos || myPos.live?.monitoring_active === false) {
          // Re-fetch history so the backend-logged trade appears
          try {
            const normalize = (t, type) => {
              const tradeTypeRaw = String(t.tradeType || t.trade_type || '').toUpperCase()
              const normalizedType = type === 'manual'
                ? 'manual'
                : tradeTypeRaw === 'STRADDLE'
                  ? 'straddle'
                  : tradeTypeRaw === 'RECOVERY'
                    ? 'recovery'
                    : tradeTypeRaw === 'MONITOR_EXIT'
                      ? 'monitor'
                      : 'ai'

              return {
                ...t,
                id: t.id || String(Date.now() + Math.random()),
                type: normalizedType,
                tradeTypeRaw,
                name: STOCK_SYMBOLS.find(s => s.symbol === t.symbol)?.name || t.symbol,
                contractName: t.contractName || t.symbol,
                strikePrice: t.strikePrice ?? '—',
                optionType: String(t.optionType || t.option_type || t.direction || '—').toLowerCase(),
                buyPrice: Number(t.buyPrice) || 0,
                sellPrice: Number(t.sellPrice) || 0,
                pnl: Number(t.pnl) || 0,
                entryStrategies: asList(t.entryStrategies ?? t.entry_strategies),
                entryStrategyNames: resolveEntryStrategyNames(t),
                entryTime: fmtEntryTime(t.entryTime),
                exitTime: fmtEntryTime(t.exitTime),
                _entryIso: t.entryTime || t.createdAt,
              }
            }
            const [optRes, manRes] = await Promise.allSettled([
              fetch(`${API_DISPLAY}/api/options-log?limit=500`),
              fetch(`${API_DISPLAY}/api/manual-trades?limit=500`),
            ])
            let combined = []
            if (optRes.status === 'fulfilled' && optRes.value.ok) {
              const d = await optRes.value.json()
              combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'ai'))]
            }
            if (manRes.status === 'fulfilled' && manRes.value.ok) {
              const d = await manRes.value.json()
              combined = [...combined, ...(d.trades || []).map(t => normalize(t, 'manual'))]
            }
            if (combined.length > 0) setTradeHistory(combined)
          } catch (_) {}
          // Read exit reason from the most recent trade log for this contract,
          // falling back to the live state (if position still briefly visible) or generic label.
          let exitReason = myPos?.live?.exit_reason || null
          if (!exitReason) {
            try {
              const r = await fetch(`${API_DISPLAY}/api/manual-trades?limit=10`)
              if (r.ok) {
                const d = await r.json()
                const match = (d.trades || []).find(t =>
                  t.contractName === manualPosition.contractSymbol ||
                  t.buyOrderId === orderId
                )
                if (match?.exitReason) exitReason = match.exitReason
              }
            } catch (_) {}
          }
          exitReason = exitReason || 'MONITOR EXIT'
          pushToast(`Bot exited · ${manualPosition.contractSymbol?.slice(0, 18)} · ${exitReason.replace(/_/g, ' ')}`, 'success')
          setLivePositions(prev => prev.filter(p => String(p.symbol || '') !== String(manualPosition.contractSymbol || '')))
          setManualPosition(null)
          setContractPrice(0)
          setOrderStatus(null)
        }
      } catch (_) {}
    }
    const id = setInterval(checkBackendExit, 5_000)
    return () => clearInterval(id)
  }, [manualPosition?.orderId, manualPosition?.backendMonitored]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll live contract price while a manual position is open
  useEffect(() => {
    if (!manualPosition?.contractSymbol) return
    const poll = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/options/price?contract=${encodeURIComponent(manualPosition.contractSymbol)}`)
        if (res.ok) {
          const data = await res.json()
          if (data.price != null) setContractPrice(data.price)
        }
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [manualPosition?.contractSymbol])

  // Keep Open Positions and Contract Tracker in sync from the same live contract feed.
  useEffect(() => {
    if (!manualPosition?.contractSymbol || !(contractPrice > 0)) return
    const contract = String(manualPosition.contractSymbol)
    const qtyNum = Number(manualPosition.qty) || 1
    const fillPrice = Number(manualPosition.fillPrice) || 0
    const pnlDollar = (contractPrice - fillPrice) * qtyNum * 100
    const pnlPc = fillPrice > 0 ? (contractPrice - fillPrice) / fillPrice : 0
    setLivePositions(prev => prev.map(p =>
      String(p.symbol || '') === contract
        ? {
            ...p,
            qty: qtyNum,
            avg_entry_price: fillPrice,
            current_price: contractPrice,
            unrealized_pl: pnlDollar,
            unrealized_plpc: pnlPc,
          }
        : p
    ))
  }, [manualPosition?.contractSymbol, manualPosition?.fillPrice, manualPosition?.qty, contractPrice])

  // Poll order fill status after placing buy, until filled or timeout
  useEffect(() => {
    if (!manualPosition?.orderId || orderStatus === 'filled') return
    const poll = async () => {
      try {
        const res = await fetch(`${API_DISPLAY}/api/orders/${manualPosition.orderId}/status`)
        if (res.ok) {
          const data = await res.json()
          const stRaw = String(data.status ?? '')
          const st = stRaw.toLowerCase().includes('.') ? stRaw.toLowerCase().split('.').pop() : stRaw.toLowerCase()
          if (st === 'filled') {
            setOrderStatus('filled')
            if (data.fill_price != null) {
              setManualPosition(prev => prev ? { ...prev, fillPrice: data.fill_price } : prev)
              setContractPrice(data.fill_price)
            }
          } else if (['canceled', 'expired', 'rejected'].includes(st)) {
            setOrderStatus('error')
          }
        }
      } catch (_) {}
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => clearInterval(id)
  }, [manualPosition?.orderId, orderStatus])

  const handleBuy = async () => {
    setOrderStatus('waiting')
    try {
      // Get a fresh Alpaca-listed contract if not already cached
      let contractSymbol = suggestContractRef.current
      let resolvedStrike = strikePrice
      let resolvedDirection = direction
      let resolvedOptionType = optionType
      let resolvedExpiry = expiry

      // Use quoteBook suggestion first (this is populated even when autoSuggest is off)
      if (!contractSymbol) {
        const q = optionType === 'put' ? quoteBook.put : quoteBook.call
        if (q?.contract_name) {
          contractSymbol = q.contract_name
          resolvedStrike = String(q.strike_price ?? strikePrice ?? '')
          resolvedExpiry = q.expiry ?? expiry
        }
      }

      // Fallback: call backend suggest with an explicit strike (entered -> quoteBook -> livePrice +/- 1)
      if (!contractSymbol) {
        const params = new URLSearchParams({ symbol: selected.symbol })
        if (optionType) params.set('option_type', optionType)
        const quoteStrike = optionType === 'put' ? quoteBook.put?.strike_price : quoteBook.call?.strike_price
        let strikeParam = strikePrice || quoteStrike || null
        if (!strikeParam) {
          const lp = Number(livePrices[selected.symbol] || contractQuote?.mid || 0)
          if (lp > 0) strikeParam = String(Math.max(0, Math.round(optionType === 'call' ? lp + 1 : lp - 1)))
        }
        if (strikeParam) params.set('strike_price', String(Math.round(Number(strikeParam))))
        const sRes = await fetch(`${API_TRADING}/api/options/suggest?${params}`)
        if (!sRes.ok) throw new Error('Could not fetch contract — try clicking Refresh first')
        const sData = await sRes.json()
        if (!sData.contract_name && !(optionType === 'put' ? quoteBook.put?.contract_name : quoteBook.call?.contract_name)) throw new Error('No listed contract available right now (market may be closed or contract unavailable)')
        contractSymbol = sData.contract_name ?? (optionType === 'put' ? quoteBook.put?.contract_name : quoteBook.call?.contract_name)
        resolvedStrike = String(sData.strike_price ?? strikeParam ?? strikePrice ?? '')
        resolvedDirection = sData.direction ?? direction
        resolvedOptionType = sData.option_type ?? optionType
        resolvedExpiry = sData.expiry ?? expiry
        setStrikePrice(resolvedStrike)
        setDirection(resolvedDirection)
        setOptionType(resolvedOptionType)
        setExpiry(resolvedExpiry)
        suggestContractRef.current = contractSymbol
      }

      // Call the new endpoint: buy + wait for fill + start backend exit monitor
      const res = await fetch(`${API_TRADING}/api/manual-trade/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_symbol: contractSymbol,
          underlying: selected.symbol,
          qty: parseInt(qty) || 1,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const order = await res.json()
      // Backend waited for fill — fill_price is guaranteed
      const fillPrice = order.fill_price
      const qtyNum = parseInt(qty) || 1
      setOrderStatus('filled')
      setManualPosition({
        orderId: order.order_id,
        contractSymbol,
        strikePrice: resolvedStrike,
        direction: resolvedDirection,
        optionType: resolvedOptionType,
        expiry: resolvedExpiry,
        qty: qtyNum,
        fillPrice,
        entryTime: cdtTime(),
        backendMonitored: true,  // backend exit strategy is running
      })
      setContractPrice(fillPrice)
      // Optimistic insert so Open Positions shows immediately after fill (no poll delay).
      setLivePositions(prev => {
        const sym = String(contractSymbol || '')
        const optimistic = {
          symbol: sym,
          qty: qtyNum,
          side: 'long',
          entry_time: new Date().toISOString(),
          avg_entry_price: fillPrice,
          current_price: fillPrice,
          unrealized_pl: 0,
          unrealized_plpc: 0,
        }
        const exists = prev.some(p => String(p.symbol || '') === sym)
        if (exists) {
          return prev.map(p => String(p.symbol || '') === sym ? { ...p, ...optimistic } : p)
        }
        return [optimistic, ...prev]
      })
      pushToast(`Bought · ${contractSymbol.slice(0, 22)} @ $${fillPrice.toFixed(2)} · Bot monitoring exit`, 'success')
    } catch (err) {
      setOrderStatus('error')
      pushToast(`Order Failed: ${err.message.slice(0, 60)}`, 'error')
      alert(`Order failed: ${err.message}`)
    }
  }

  const handleSell = async () => {
    if (manualPosition) {
      setOrderStatus('selling')
      let exitPrice = contractPrice
      const closeSymbol = manualPosition.contractSymbol || selected.symbol
      try {
        // Close option position by contract symbol
        const res = await fetch(`${API_TRADING}/api/positions/${encodeURIComponent(closeSymbol)}/close`, { method: 'POST' })
        if (res.ok) {
          const closed = await res.json()
          exitPrice = closed.exit_price ?? contractPrice
        }
      } catch (_) {}
      const pnl = +((exitPrice - manualPosition.fillPrice) * manualPosition.qty * 100).toFixed(2)
      const closedTrade = {
        id: Date.now(),
        type: 'manual',
        symbol: selected.symbol,
        name: selected.name,
        contractName: manualPosition.contractSymbol ?? `${selected.symbol} $${manualPosition.strikePrice} ${manualPosition.optionType.toUpperCase()} ${manualPosition.expiry}`,
        strikePrice: manualPosition.strikePrice,
        optionType: manualPosition.optionType,
        direction: manualPosition.direction,
        expiry: manualPosition.expiry,
        qty: manualPosition.qty,
        buyPrice: manualPosition.fillPrice,
        sellPrice: exitPrice,
        pnl,
        result: pnl >= 0 ? 'WIN' : 'LOSS',
        entryTime: manualPosition.entryTime,
        exitTime: cdtTime(),
        _entryIso: new Date().toISOString(),
      }
      setTradeHistory(prev => [closedTrade, ...prev])
      pushToast(
        `Position Sold · ${closedTrade.pnl >= 0 ? '+' : '-'}$${fmt(Math.abs(closedTrade.pnl))}`,
        closedTrade.pnl >= 0 ? 'success' : 'error'
      )

      // Only log to MongoDB when NOT backendMonitored — if backendMonitored,
      // the backend monitor thread already logged the trade to avoid duplicates.
      if (!manualPosition.backendMonitored) {
        try {
          await fetch(`${API_DISPLAY}/api/manual-trades`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: closedTrade.symbol,
              name: closedTrade.name,
              contract_name: closedTrade.contractName,
              strike_price: String(closedTrade.strikePrice ?? '—'),
              option_type: closedTrade.optionType,
              direction: closedTrade.direction,
              expiry: closedTrade.expiry,
              qty: closedTrade.qty,
              buy_price: closedTrade.buyPrice,
              sell_price: closedTrade.sellPrice,
              pnl: closedTrade.pnl,
              result: closedTrade.result,
              entry_time: closedTrade.entryTime,
              exit_time: closedTrade.exitTime,
            }),
          })
        } catch (_) {}
      }
      setLivePositions(prev => prev.filter(p => String(p.symbol || '') !== String(closeSymbol || '')))
    }
    setManualPosition(null)
    setContractPrice(0)
    setOrderStatus(null)
  }

  // ── Fetch backend-suggested contract for manual trade ──
  // keep ref in sync with state so interval closure always reads latest value
  useEffect(() => { optionTypeRef.current = optionType }, [optionType])

  const _quoteFromSuggest = (data) => ({
    bid: data?.bid ?? 0,
    ask: data?.ask ?? 0,
    mid: data?.mid ?? 0,
    spread_pct: data?.spread_pct ?? 0,
    contract_name: data?.contract_name ?? null,
    expiry: data?.expiry ?? null,
    strike_price: data?.strike_price ?? null,
    option_type: data?.option_type ?? null,
  })

  const fetchSuggestForType = async (sym, optType = 'call', opts = {}) => {
    const { applyForm = false, updateType = false, strikeOverride = null } = opts
    const type = String(optType || 'call').toLowerCase() === 'put' ? 'put' : 'call'
    const params = new URLSearchParams({ symbol: sym || selected.symbol, option_type: type })
    if (strikeOverride) params.set('strike_price', String(strikeOverride))
    try {
      const res = await fetch(`${API_TRADING}/api/options/suggest?${params}`)
      let data = null
      if (res.ok) {
        data = await res.json()
      }

      // If backend returned a valid suggestion, use it. Otherwise compute a
      // simple fallback strike based on current underlying price so the UI
      // shows a sensible contract (CALL = price + 1, PUT = price - 1).
      const currentPrice = Number(livePrices[sym || selected.symbol] || 0)
      const fallbackStrike = currentPrice > 0 ?
        (type === 'call' ? (currentPrice + 1) : (currentPrice - 1)) : null

      // Prefer integer strikes (no decimals)
      const strikeVal = data?.strike_price ?? (fallbackStrike != null ? Math.max(0, Math.round(fallbackStrike)) : null)

      const q = _quoteFromSuggest(data || {
        bid: 0,
        ask: 0,
        mid: 0,
        spread_pct: 0,
        contract_name: strikeVal != null ? `${(sym || selected.symbol)} ${type.toUpperCase()} $${strikeVal}` : null,
        expiry: data?.expiry ?? null,
        strike_price: strikeVal,
        option_type: type,
      })

      setQuoteBook(prev => ({ ...prev, [type]: q }))
      if (!manualPosition && optionTypeRef.current === type) setContractQuote(q)

      if (applyForm) {
        setStrikePrice(String(strikeVal ?? ''))
        setDirection(data?.direction ?? 'uptrend')
        if (updateType) setOptionType(data?.option_type ?? type)
        setExpiry(data?.expiry ?? '')
        setQty(String(data?.qty ?? 1))
        suggestContractRef.current = data?.contract_name ?? (strikeVal != null ? `${(sym || selected.symbol)} ${type.toUpperCase()} $${strikeVal}` : null)
      }
      return data
    } catch (_) {
      // On network error, still set a UI-friendly fallback strike if possible
      const currentPrice = Number(livePrices[sym || selected.symbol] || 0)
      const fallbackStrike = currentPrice > 0 ? (optType === 'put' ? (currentPrice - 1) : (currentPrice + 1)) : null
      const strikeVal = fallbackStrike != null ? Math.max(0, Math.round(fallbackStrike)) : null
      if (strikeVal != null) {
        const q = _quoteFromSuggest({ contract_name: `${(sym || selected.symbol)} ${type.toUpperCase()} $${strikeVal}`, strike_price: strikeVal, option_type: type })
        setQuoteBook(prev => ({ ...prev, [type]: q }))
        if (!manualPosition && optionTypeRef.current === type) setContractQuote(q)
        if (applyForm) {
          setStrikePrice(String(strikeVal))
          suggestContractRef.current = `${(sym || selected.symbol)} ${type.toUpperCase()} $${strikeVal}`
        }
      }
      return null
    }
  }

  // updateType=true  → also update CALL/PUT selector (used on symbol change / first load)
  // updateType=false → preserve user's current selection (used on 10s interval refresh)
  const fetchSuggest = async (sym, optType = null, updateType = true, showLoading = true) => {
    if (showLoading) setSuggestLoading(true)
    try {
      const type = String(optType || optionTypeRef.current || 'call').toLowerCase() === 'put' ? 'put' : 'call'
      await fetchSuggestForType(sym, type, { applyForm: true, updateType })
      // Keep both sides warm so switching CALL/PUT has immediate quote readiness.
      const otherType = type === 'call' ? 'put' : 'call'
      await fetchSuggestForType(sym, otherType, { applyForm: false })
    } catch (_) {}
    if (showLoading) setSuggestLoading(false)
  }

  // ── Switch trade mode; stop AI trade if one is active ──
  const handleSetTradeMode = async (mode) => {
    if (mode === tradeMode) return
    // Config gate
    if (mode === 'ai' && !tradingConfig.ait_enabled) {
      pushToast('AIT is disabled in config.py — cannot switch to AI Trade mode', 'error')
      return
    }
    if (mode === 'manual' && !tradingConfig.mt_enabled) {
      pushToast('Manual Trading is disabled in config.py — cannot switch to Manual mode', 'error')
      return
    }
    if (mode === 'manual' && tradeActive) {
      try {
        await fetch(`${API_TRADING}/api/ai-trade/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: selected.symbol }),
        })
      } catch (_) {}
      setTradeActive(false)
      setLastTrade(t => t ? { ...t, status: 'CLOSED' } : t)
    }
    setTradeMode(mode)
    // Sync left watchlist symbolMode for the selected symbol
    const backendMode = mode === 'ai' ? 'auto' : 'manual'
    setSymbolMode(prev => ({
      ...prev,
      [selected.symbol]: backendMode,
    }))
    // Persist to backend — without this, config polling resets tradeMode back to 'ai'
    // every 30s, causing the Buy button to disappear after sell
    try {
      await fetch(`${API_DISPLAY}/api/symbol/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: selected.symbol, mode: backendMode }),
      })
    } catch (_) {}
  }

  // Auto-suggest ON: refresh form + quotes every minute.
  // Auto-suggest OFF: keep quote refresh every minute for BOTH call/put without mutating form fields.
  useEffect(() => {
    if (manualPosition) return

    const poll = async () => {
      if (manualPosition) return
      if (autoSuggestEnabled) {
        await fetchSuggest(selected.symbol, optionTypeRef.current, false, false)
      } else {
        await Promise.allSettled([
          fetchSuggestForType(selected.symbol, 'call', { applyForm: false }),
          fetchSuggestForType(selected.symbol, 'put', { applyForm: false }),
        ])
      }
    }

    if (autoSuggestEnabled) {
      fetchSuggest(selected.symbol, optionTypeRef.current, true, true)
    } else {
      poll()
    }

    const id = setInterval(poll, 60_000)
    return () => clearInterval(id)
  }, [tradeMode, selected.symbol, autoSuggestEnabled, manualPosition]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep selected quote card synced when user switches CALL/PUT.
  useEffect(() => {
    if (manualPosition) return
    const selectedQuote = optionType === 'put' ? quoteBook.put : quoteBook.call
    if (selectedQuote) setContractQuote(selectedQuote)
  }, [optionType, quoteBook, manualPosition])

  // When user manually changes option type or strike, invalidate the cached contract
  // so handleBuy will re-fetch a contract matching the new values.
  useEffect(() => {
    if (!manualPosition) {
      suggestContractRef.current = null
    }
  }, [optionType, strikePrice]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalVolume = candles.reduce((s, c) => s + (c.volume || 0), 0)

  const lastCandle = candles[candles.length - 1]
  const prevCandle = candles[candles.length - 2]
  const chartChange    = lastCandle && prevCandle ? lastCandle.close - prevCandle.close : 0
  const chartChangePct = prevCandle ? ((chartChange / prevCandle.close) * 100).toFixed(2) : '0.00'


  // --- EMA lines and crossover markers for chart (memoized) ---
  const { emaLines, emaCrossMarkers, rsiMeanReversionMarkers } = React.useMemo(() => {
    const enabledStrategies = Array.isArray(entryStrategies.enabled) ? entryStrategies.enabled : [];
    const showEma = showEmaOverlay || enabledStrategies.includes('EMA_CROSSOVER');
    const showRsiMr = enabledStrategies.includes('RSI_MEAN_REVERSION');
    const rsiMr = showRsiMr ? getRSIMeanReversionMarkers(calcRSI(candles, 3), 40, 70) : [];

    if (showEma) {
      const ema9 = calcEMA(candles, 9);
      const ema21 = calcEMA(candles, 21);
      const ema50 = calcEMA(candles, 50);
      const crosses = getEMACrossMarkers(ema9, ema21, ema50, candles);
      return {
        emaLines: [
          { period: 9, color: GOLD_LIGHT, data: ema9 },
          { period: 21, color: '#7c3aed', data: ema21 },
          { period: 50, color: '#2563eb', data: ema50 },
        ],
        emaCrossMarkers: crosses,
        rsiMeanReversionMarkers: rsiMr,
      };
    }
    return { emaLines: [], emaCrossMarkers: [], rsiMeanReversionMarkers: rsiMr };
  }, [candles, entryStrategies.enabled, showEmaOverlay]);

  return (
    <div style={{ width: '100%', display: 'flex', gap: '1.25rem', alignItems: 'flex-start', minHeight: 'calc(100vh - 160px)' }}>

      {/* LEFT: Symbol Watchlist */}
      <div style={{
        width: '210px', flexShrink: 0,
        background: '#fff',
        border: '1px solid rgba(201,162,39,0.15)',
        borderRadius: '14px',
        overflow: 'hidden',
        boxShadow: '0 2px 12px rgba(201,162,39,0.06)',
        position: 'sticky', top: '90px',
      }}>
        <div style={{
          padding: '1rem 1.25rem 0.75rem',
          borderBottom: '1px solid rgba(201,162,39,0.12)',
          background: 'rgba(201,162,39,0.04)',
        }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: GOLD_DEEP, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <TrendingUp size={12} color={GOLD_DEEP} /> Ready to Trade
          </div>
          <div style={{ fontSize: '0.65rem', color: '#999', marginTop: '0.15rem' }}>
            {STOCK_SYMBOLS.length} stocks available
          </div>
        </div>

        <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
          {[...STOCK_SYMBOLS].sort((a, b) => {
            const order = { auto: 0, manual: 1, off: 2 }
            return (order[symbolMode[a.symbol]] ?? 2) - (order[symbolMode[b.symbol]] ?? 2)
          }).map(stock => {
            const price = livePrices[stock.symbol]
            const pctChange = (((price - stock.basePrice) / stock.basePrice) * 100).toFixed(2)
            const isActive  = selected.symbol === stock.symbol
            const locked    = tradeActive && !isActive
            return (
              <div
                key={stock.symbol}
                onClick={() => !locked && handleSymbolSelect(stock)}
                onMouseEnter={() => setHoveredSymbol(stock.symbol)}
                onMouseLeave={() => setHoveredSymbol(null)}
                style={{
                  padding: '0.75rem 1.1rem 0.6rem',
                  borderBottom: '1px solid rgba(0,0,0,0.04)',
                  cursor: locked ? 'not-allowed' : 'pointer',
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(201,162,39,0.1) 0%, rgba(245,197,24,0.06) 100%)'
                    : hoveredSymbol === stock.symbol && !locked ? 'rgba(201,162,39,0.05)' : '#fff',
                  borderLeft: isActive ? `3px solid ${GOLD}` : '3px solid transparent',
                  transition: 'all 0.2s',
                  opacity: locked ? 0.45 : 1,
                }}
              >
                {/* Symbol + price row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.55rem' }}>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 800, color: isActive ? GOLD_DEEP : '#111' }}>{stock.symbol}</div>
                    <div style={{ fontSize: '0.65rem', color: '#bbb', marginTop: '0.1rem' }}>{stock.sector}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: parseFloat(pctChange) >= 0 ? '#16a34a' : '#ef4444' }}>
                      ${fmt(price)}
                    </div>
                    <div style={{ fontSize: '0.63rem', fontWeight: 600, color: parseFloat(pctChange) >= 0 ? '#16a34a' : '#ef4444' }}>
                      {parseFloat(pctChange) >= 0 ? '+' : ''}{pctChange}%
                    </div>
                  </div>
                </div>

                {/* AUTO | OFF | MANUAL 3-position switch */}
                <div
                  onClick={e => e.stopPropagation()}
                  style={{
                    marginTop: '0.45rem',
                    display: 'flex', alignItems: 'center',
                    background: 'rgba(201,162,39,0.08)',
                    borderRadius: '999px',
                    padding: '3px',
                    border: '1px solid rgba(201,162,39,0.2)',
                    gap: '2px',
                  }}
                >
                  {[
                    { val: 'auto',   label: 'AIT', activeBg: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`, activeShadow: 'rgba(201,162,39,0.4)'  },
                    { val: 'off',    label: 'OFF', activeBg: 'rgba(100,100,100,0.25)',                              activeShadow: 'none'                  },
                    { val: 'manual', label: 'MT',  activeBg: 'linear-gradient(135deg, #1a1a1a 0%, #333 100%)', activeShadow: 'rgba(0,0,0,0.35)' },
                  ].map(opt => {
                    const active = symbolMode[stock.symbol] === opt.val
                    // Disabled by global config gate
                    const gateDisabled =
                      (opt.val === 'auto'   && !tradingConfig.ait_enabled) ||
                      (opt.val === 'manual' && !tradingConfig.mt_enabled)
                    return (
                      <button
                        key={opt.val}
                        onClick={e => !gateDisabled && setSymbolModeFor(stock.symbol, opt.val, e)}
                        title={gateDisabled
                          ? opt.val === 'auto' ? 'AIT disabled in config.py' : 'MT disabled in config.py'
                          : undefined}
                        style={{
                          flex: 1, padding: '0.28rem 0.18rem',
                          borderRadius: '999px', border: 'none',
                          cursor: gateDisabled ? 'not-allowed' : 'pointer',
                          fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.04em',
                          transition: 'all 0.2s',
                          opacity: gateDisabled ? 0.35 : 1,
                          background: active ? opt.activeBg : 'transparent',
                          color: active
                            ? opt.val === 'off' ? '#777' : '#fff'
                            : 'rgba(160,124,16,0.6)',
                          boxShadow: active && opt.val !== 'off' ? `0 0 5px ${opt.activeShadow}` : 'none',
                          position: 'relative',
                        }}
                      >
                        {opt.label}
                        {gateDisabled && <span style={{ position: 'absolute', top: 0, right: 2, fontSize: '0.45rem', lineHeight: 1 }}>🔒</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* CENTER: Chart + Last Trade */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: 0 }}>
        <div style={{
          background: '#fff',
          border: '1px solid rgba(201,162,39,0.12)',
          borderRadius: '14px',
          overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          {/* Chart header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '1rem 1.5rem',
            borderBottom: '1px solid rgba(0,0,0,0.05)',
            flexWrap: 'wrap', gap: '0.75rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#111' }}>{selected.symbol}</span>
              <span style={{ fontSize: '0.8rem', color: '#999' }}>{selected.name}</span>
              <span style={{ fontSize: '1.5rem', fontWeight: 900, color: priceUp ? '#16a34a' : '#ef4444', transition: 'color 0.3s', letterSpacing: '-0.02em' }}>
                ${fmt(livePrice)}
              </span>
              <span style={{ fontSize: '0.82rem', fontWeight: 600, color: parseFloat(chartChangePct) >= 0 ? '#16a34a' : '#ef4444' }}>
                {chartChange >= 0 ? '+' : ''}{fmt(chartChange)} ({chartChangePct}%)
              </span>
              {/* Bot status badge */}
              {symbolMode[selected.symbol] === 'auto' ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.22rem 0.6rem', borderRadius: '20px',
                  background: 'rgba(22,163,74,0.1)', border: '1px solid rgba(22,163,74,0.3)',
                  fontSize: '0.7rem', fontWeight: 800, color: '#16a34a', letterSpacing: '0.04em',
                }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'livePulse 1.5s infinite' }} />
                  BOT ACTIVE
                </span>
              ) : symbolMode[selected.symbol] === 'manual' ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.22rem 0.6rem', borderRadius: '20px',
                  background: `rgba(201,162,39,0.1)`, border: `1px solid rgba(201,162,39,0.3)`,
                  fontSize: '0.7rem', fontWeight: 800, color: GOLD_DEEP, letterSpacing: '0.04em',
                }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: GOLD, display: 'inline-block' }} />
                  MANUAL
                </span>
              ) : (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.22rem 0.6rem', borderRadius: '20px',
                  background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)',
                  fontSize: '0.7rem', fontWeight: 700, color: '#bbb', letterSpacing: '0.04em',
                }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ccc', display: 'inline-block' }} />
                  BOT OFF
                </span>
              )}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.22rem 0.55rem', borderRadius: '20px',
                background: 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.28)',
                fontSize: '0.68rem', fontWeight: 800, color: GOLD_DEEP, letterSpacing: '0.04em',
              }}>
                STRATEGY {entryStrategies.enabled.length}/{entryStrategies.maxEnabled}
              </span>
              {/* EMA status badge (visible when EMA Crossover strategy enabled) */}
              {Array.isArray(emaLines) && emaLines.length > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.22rem 0.6rem', borderRadius: '20px',
                  background: 'rgba(201,162,39,0.04)', border: '1px solid rgba(201,162,39,0.16)',
                  fontSize: '0.66rem', fontWeight: 800, color: GOLD_DEEP, letterSpacing: '0.04em',
                }} title={`EMA lines visible (${emaLines.map(e=>e.period).join('/')})`}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 900, color: '#92710a' }}>EMA</span>
                  <span style={{ fontSize: '0.66rem', fontWeight: 800, color: '#444' }}>{emaLines.map(e=>e.period).join('/')}</span>
                  <span style={{ fontSize: '0.66rem', fontWeight: 700, color: emaCrossMarkers && emaCrossMarkers.length > 0 ? '#16a34a' : '#999' }}>{emaCrossMarkers ? `${emaCrossMarkers.length}×` : '0×'}</span>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* Market status badge */}
              {mktCountdown === 'open' ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.2rem 0.6rem', borderRadius: '20px',
                  background: 'rgba(22,163,74,0.1)', border: '1px solid rgba(22,163,74,0.3)',
                  fontSize: '0.68rem', fontWeight: 800, color: '#16a34a', letterSpacing: '0.04em',
                }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'livePulse 1.5s infinite' }} />
                  MARKET OPEN
                </span>
              ) : (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.2rem 0.6rem', borderRadius: '20px',
                  background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)',
                  fontSize: '0.68rem', fontWeight: 700, color: '#ef4444', letterSpacing: '0.04em',
                }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                  {mktCountdown || 'CLOSED'}
                </span>
              )}
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {INTERVALS.map(iv => (
                  <button key={iv} onClick={() => setInterval_(iv)} style={{
                    padding: '0.3rem 0.65rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
                    background: interval === iv ? 'rgba(201,162,39,0.15)' : 'transparent',
                    color: interval === iv ? GOLD_DEEP : '#888',
                    fontWeight: interval === iv ? 700 : 500,
                    fontSize: '0.78rem', transition: 'all 0.2s',
                  }}>{iv}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Live price / TP / SL / RSI / Volume chips */}
          <div style={{
            display: 'flex', gap: '1rem', padding: '0.6rem 1.5rem',
            borderBottom: '1px solid rgba(0,0,0,0.04)',
            background: 'rgba(201,162,39,0.02)', flexWrap: 'wrap', alignItems: 'center',
          }}>
            {[
              { icon: <Activity size={12} color={GOLD} />, label: 'Live', value: `$${fmt(livePrice)}`, color: priceUp ? '#16a34a' : '#ef4444', bg: 'rgba(201,162,39,0.07)', border: 'rgba(201,162,39,0.2)' },
              { icon: <Target size={12} color="#16a34a" />, label: 'TP', value: `$${fmt(tradeActive ? tradeTpPrice : tpPrice)}`, color: '#16a34a', bg: 'rgba(22,163,74,0.07)', border: 'rgba(22,163,74,0.2)' },
              { icon: <ShieldAlert size={12} color="#ef4444" />, label: 'SL', value: `$${fmt(tradeActive ? tradeSlPrice : slPrice)}`, color: '#ef4444', bg: 'rgba(239,68,68,0.07)', border: 'rgba(239,68,68,0.2)' },
              ...(tradeActive ? [{ icon: <DollarSign size={12} color={livePnL >= 0 ? '#16a34a' : '#ef4444'} />, label: 'P&L', value: `${livePnL >= 0 ? '+' : ''}$${fmt(livePnL)} (${livePnLPct}%)`, color: livePnL >= 0 ? '#16a34a' : '#ef4444', bg: livePnL >= 0 ? 'rgba(22,163,74,0.07)' : 'rgba(239,68,68,0.07)', border: livePnL >= 0 ? 'rgba(22,163,74,0.2)' : 'rgba(239,68,68,0.2)' }] : []),
            ].map((chip, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.6rem 0.2rem 0.45rem', borderRadius: '20px', background: chip.bg, border: `1px solid ${chip.border}` }}>
                {chip.icon}
                <span style={{ fontSize: '0.7rem', color: '#999', fontWeight: 600 }}>{chip.label}</span>
                <span style={{ fontSize: '0.78rem', color: chip.color, fontWeight: 800 }}>{chip.value}</span>
              </div>
            ))}


            {/* RSI */}
            {rsi !== null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600 }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#888' }}>RSI(14):</span>
                <span style={{
                  padding: '0.15rem 0.55rem', borderRadius: '20px', fontWeight: 800, fontSize: '0.76rem',
                  background: rsi >= 70 ? 'rgba(239,68,68,0.1)' : rsi <= 30 ? 'rgba(22,163,74,0.1)' : 'rgba(201,162,39,0.1)',
                  color: rsi >= 70 ? '#ef4444' : rsi <= 30 ? '#16a34a' : GOLD_DEEP,
                  border: `1px solid ${rsi >= 70 ? 'rgba(239,68,68,0.25)' : rsi <= 30 ? 'rgba(22,163,74,0.25)' : 'rgba(201,162,39,0.25)'}`,
                }}>
                  {(+rsi).toFixed(2)} {rsi >= 70 ? 'Over Bought' : rsi <= 30 ? 'Over Sold' : ''}
                </span>
              </div>
            )}

            {/* OBR High / Low */}
            {obrLevels.filter(l => l.label === 'OBR High' || l.label === 'OBR Low').map(lvl => (
              <div key={lvl.label} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600 }}>
                <span style={{ color: '#aaa', fontSize: '0.7rem' }}>{lvl.label}:</span>
                <span style={{ color: lvl.color, fontWeight: 800 }}>${fmt(lvl.price)}</span>
              </div>
            ))}

            {/* Volume */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', fontWeight: 600 }}>
              <span style={{ color: '#aaa', fontSize: '0.7rem' }}>Vol:</span>
              <span style={{ color: GOLD_DEEP, fontWeight: 800 }}>{fmtVol(totalVolume)}</span>
            </div>

            {/* Live strategy status strip */}
            {(entryStrategies.available || []).length > 0 && (
              <div style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                flexWrap: 'wrap',
                marginTop: '0.12rem',
                paddingTop: '0.35rem',
                borderTop: '1px dashed rgba(201,162,39,0.22)',
              }}>
                <span style={{ fontSize: '0.64rem', fontWeight: 800, color: '#b5973b', letterSpacing: '0.05em' }}>
                  LIVE STRATEGIES
                </span>
                {(entryStrategies.available || []).map((s) => (
                  <span
                    key={s.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      padding: '0.14rem 0.46rem',
                      borderRadius: '999px',
                      border: `1px solid ${s.enabled ? 'rgba(22,163,74,0.28)' : 'rgba(107,114,128,0.2)'}`,
                      background: s.enabled ? 'rgba(22,163,74,0.1)' : 'rgba(107,114,128,0.08)',
                      color: s.enabled ? '#15803d' : '#6b7280',
                      fontSize: '0.64rem',
                      fontWeight: 800,
                      letterSpacing: '0.02em',
                    }}
                  >
                    <span style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: s.enabled ? '#22c55e' : '#9ca3af',
                      display: 'inline-block',
                    }} />
                    {s.label} · {s.enabled ? 'ON' : 'OFF'}
                  </span>
                ))}
                <span
                  key="show-ema-overlay"
                  onClick={() => setShowEmaOverlay(prev => !prev)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.14rem 0.46rem',
                    borderRadius: '999px',
                    border: `1px solid ${showEmaOverlay ? 'rgba(37,99,235,0.22)' : 'rgba(107,114,128,0.2)'}`,
                    background: showEmaOverlay ? 'rgba(37,99,235,0.06)' : 'rgba(107,114,128,0.04)',
                    color: showEmaOverlay ? '#1e3a8a' : '#6b7280',
                    fontSize: '0.64rem',
                    fontWeight: 800,
                    letterSpacing: '0.02em',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: showEmaOverlay ? '#2563eb' : '#9ca3af',
                    display: 'inline-block',
                  }} />
                  EMA Overlay · {showEmaOverlay ? 'ON' : 'OFF'}
                </span>
              </div>
            )}
          </div>

          <CandleChart
            data={candles}
            obrLines={obrLevels}
            rsiPoints={rsiPoints}
            rsiMaPoints={rsiMaPoints}
            rsiMarkers={rsiMarkers}
            emaLines={emaLines}
            emaCrossMarkers={emaCrossMarkers}
            rsiMeanReversionMarkers={rsiMeanReversionMarkers}
            fitKey={selected.symbol + '_' + interval}
            livePrice={livePrice}
          />
        </div>

        {/* ── Live Tick Stream for selected symbol ── */}
        {(() => {
          const symbolLive = registryPositions.filter(lp => {
            const contract = String(lp.contract_symbol || lp.symbol || '')
            return contract.startsWith(selected.symbol)
          })
          if (symbolLive.length === 0) return null

          const activePos =
            (manualPosition?.contractSymbol
              ? symbolLive.find(lp => String(lp.contract_symbol || lp.symbol || '') === String(manualPosition.contractSymbol))
              : null) || symbolLive[0]

          const live = activePos?.live || {}
          const contract = String(activePos?.contract_symbol || activePos?.symbol || '')
          const timeline = Array.isArray(live.timeline) ? live.timeline : []
          if (timeline.length === 0) return null

          const recentTicks = timeline.slice(-180)
          const fillPx = toNum(live.fill_price ?? activePos?.fill_price)

          return (
            <div style={{
              background: '#fff',
              border: '1px solid rgba(201,162,39,0.18)',
              borderRadius: '14px',
              overflow: 'hidden',
              boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.78rem 1.1rem', borderBottom: '1px solid rgba(201,162,39,0.1)',
                background: 'rgba(201,162,39,0.03)', flexWrap: 'wrap', gap: '0.4rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <Activity size={13} color={GOLD_DEEP} />
                  <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Live Tick Stream
                  </span>
                </div>
                <span style={{ fontSize: '0.66rem', fontWeight: 700, color: '#9ca3af' }}>
                  {contract} · {recentTicks.length} ticks
                </span>
              </div>

              <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '240px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1120px', fontSize: '0.67rem' }}>
                  <thead>
                    <tr style={{ background: '#fdfaf4', position: 'sticky', top: 0, zIndex: 1 }}>
                      {['Time', 'Src', 'Sellable', 'Bid', 'Mid', 'PnL%', 'QP LMT', 'QP DYN%', 'Trailing SL Dyn', 'Peak', 'Peak Px', 'TP', 'SL Action', 'SL Update', 'Armed', 'Orders'].map((h) => (
                        <th key={h} style={{ padding: '0.3rem 0.38rem', textAlign: 'left', color: '#888', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid rgba(0,0,0,0.08)', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentTicks.map((tick, idx) => {
                      const isOrder = tick.source === 'order_placed' || tick.source === 'order_replaced'
                      const isSell = tick.source === 'sell'
                      const src = String(isSell ? (tick.exit_reason || 'sell') : (tick.source || 'tick')).toUpperCase()
                      const orderStatusAt = tick.status_at || tick.filled_at || tick.canceled_at || tick.updated_at || tick.submitted_at || tick.ts
                      const peakPct = toNum(tick.max_pnl_pct)
                      const peakPx = fillPx != null && peakPct != null ? fillPx * (1 + peakPct / 100) : null
                      const rowBg = isSell
                        ? 'rgba(239,68,68,0.08)'
                        : isOrder
                          ? 'rgba(217,119,6,0.06)'
                          : idx % 2 === 0
                            ? '#fff'
                            : '#fcfcfc'
                      const orderBadges = [tick.live_qp ? 'QP' : '', tick.live_sl ? 'SL' : '', tick.live_tsl ? 'TSL' : '']
                        .filter(Boolean)
                        .join(', ')

                      return (
                        <tr key={`${tick.ts || idx}-${idx}`} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)', background: rowBg }}>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#555', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: isSell ? '#ef4444' : '#6b7280', fontWeight: 700, whiteSpace: 'nowrap' }}>{src}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#111', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {!isOrder ? fmtMoneyMaybe(tick.sellable_price) : (tick.fill_price != null ? fmtMoneyMaybe(tick.fill_price) : fmtMoneyMaybe(tick.limit_price))}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#666', whiteSpace: 'nowrap' }}>
                            {!isOrder ? fmtMoneyMaybe(tick.bid_price) : (tick.stop_price != null ? `stop ${fmtMoneyMaybe(tick.stop_price)}` : '—')}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#666', whiteSpace: 'nowrap' }}>
                            {!isOrder ? fmtMoneyMaybe(tick.mid_price) : (tick.limit_price != null ? `lmt ${fmtMoneyMaybe(tick.limit_price)}` : '—')}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: Number(tick.pnl_pct ?? tick.pct ?? 0) >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {fmtPctMaybe(tick.pnl_pct ?? tick.pct)}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#d97706', whiteSpace: 'nowrap' }}>{fmtMoneyMaybe(tick.qp_limit_price)}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#d97706', whiteSpace: 'nowrap' }}>{fmtPctMaybe(tick.qp_dynamic_pct)}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#ef4444', whiteSpace: 'nowrap' }}>{fmtPctMaybe(tick.sl_dynamic_pct)}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#6366f1', whiteSpace: 'nowrap' }}>{fmtPctMaybe(tick.max_pnl_pct)}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#6366f1', whiteSpace: 'nowrap' }}>{peakPx != null ? fmtMoneyMaybe(peakPx) : '—'}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#666', whiteSpace: 'nowrap' }}>{tick.tp_action || 'NO_CHANGE'}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: tick.sl_action === 'UPDATED' ? '#dc2626' : '#666', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {isOrder ? String(tick.order_type || 'ORDER').toUpperCase() : (tick.sl_action || 'NO_CHANGE')}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#555', whiteSpace: 'nowrap' }}>
                            {isOrder
                              ? `${String(tick.status || 'live').toUpperCase()}${tick.order_id ? ` · ${String(tick.order_id).slice(0, 8)}…` : ''} @ ${fmtTickTime(orderStatusAt)}`
                              : tick.sl_action === 'UPDATED'
                                ? `${fmtMoneyMaybe(tick.sl_prev_price)} -> ${fmtMoneyMaybe(tick.sl_new_price)}`
                                : 'No change'}
                          </td>
                          <td style={{ padding: '0.26rem 0.38rem', textAlign: 'center', color: '#d97706', fontWeight: 800 }}>{tick.qp_armed ? '✓' : '—'}</td>
                          <td style={{ padding: '0.26rem 0.38rem', fontFamily: 'monospace', color: '#666', whiteSpace: 'nowrap' }}>
                            {isOrder ? (String(tick.order_count || '').trim() ? `#${tick.order_count}` : '—') : (orderBadges || '—')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })()}

        {/* ── Live Open Positions for selected symbol ── */}
        {(() => {
          const basePositions = livePositions.filter(p =>
            p.symbol && p.symbol.startsWith(selected.symbol)
          )
          const manualLivePrice = manualPosition?.contractSymbol
            ? resolveContractLivePrice(manualPosition.contractSymbol, manualPosition.fillPrice)
            : 0
          const optimisticManual =
            manualPosition?.contractSymbol &&
            String(manualPosition.contractSymbol).startsWith(selected.symbol) &&
            !basePositions.some(p => String(p.symbol || '') === String(manualPosition.contractSymbol || ''))
              ? [{
                  symbol: manualPosition.contractSymbol,
                  qty: Number(manualPosition.qty) || 1,
                  side: 'long',
                  entry_time: new Date().toISOString(),
                  avg_entry_price: Number(manualPosition.fillPrice) || 0,
                  current_price: Number(manualLivePrice) || Number(manualPosition.fillPrice) || 0,
                  unrealized_pl: ((Number(manualLivePrice) || Number(manualPosition.fillPrice) || 0) - (Number(manualPosition.fillPrice) || 0)) * ((Number(manualPosition.qty) || 1) * 100),
                  unrealized_plpc: (Number(manualPosition.fillPrice) || 0) > 0
                    ? (((Number(manualLivePrice) || Number(manualPosition.fillPrice) || 0) - (Number(manualPosition.fillPrice) || 0)) / (Number(manualPosition.fillPrice) || 1))
                    : 0,
                }]
              : []
          const symPositions = [...optimisticManual, ...basePositions]
          if (symPositions.length === 0) return null
          return (
            <div style={{
              background: '#fff',
              border: '1px solid rgba(22,163,74,0.25)',
              borderRadius: '14px',
              overflow: 'hidden',
              boxShadow: '0 2px 16px rgba(22,163,74,0.07)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.9rem 1.5rem',
                borderBottom: '1px solid rgba(22,163,74,0.12)',
                background: 'rgba(22,163,74,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'livePulse 1.5s infinite' }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Open Positions
                  </span>
                  <span style={{ padding: '0.1rem 0.5rem', borderRadius: '20px', fontSize: '0.65rem', fontWeight: 700, background: 'rgba(22,163,74,0.12)', color: '#16a34a' }}>
                    {symPositions.length}
                  </span>
                </div>
                <span style={{ fontSize: '0.7rem', color: '#bbb', fontWeight: 600 }}>Live · sync every 2 s</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.85rem', padding: '1rem 1.5rem' }}>
                {symPositions.map((p, i) => {
                  const livePos = registryPositions.find(lp =>
                    String(lp.contract_symbol || lp.symbol || '') === String(p.symbol || '')
                  )
                  const live = livePos?.live || null
                  const qtyNum = Number(live?.qty ?? p.qty) || 0
                  const entryPrice = Number(live?.fill_price ?? p.avg_entry_price) || 0
                  const currentPrice = resolveContractLivePrice(
                    p.symbol,
                    Number(live?.current_price ?? p.current_price) || 0
                  )
                  const livePnlPct = Number(live?.pnl_pct)
                  const livePnlDollar = Number(live?.pnl_dollar)
                  const uPlPct = Number.isFinite(livePnlPct)
                    ? (livePnlPct / 100)
                    : Number(p.unrealized_plpc) || (entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0)
                  const uPl = Number.isFinite(livePnlDollar)
                    ? livePnlDollar
                    : Number(p.unrealized_pl) || ((currentPrice - entryPrice) * (qtyNum || 1) * 100)
                  const curPct = uPlPct * 100
                  const isPos = uPl >= 0
                  const side = String(p.side || live?.side || 'long').toLowerCase()

                  const slPctRaw = Number(live?.sl_dynamic_pct ?? live?.sl_static_pct)
                  const tpPctRaw = Number(live?.tp_pct)
                  const qpPctRaw = Number(live?.qp_dynamic_pct ?? live?.qp_floor_pct)
                  const peakPctRaw = Number(live?.max_pnl_pct ?? curPct)

                  const hasSl = Number.isFinite(slPctRaw)
                  const hasTp = Number.isFinite(tpPctRaw)
                  const hasQp = Number.isFinite(qpPctRaw)
                  const slPct = hasSl ? slPctRaw : null
                  const tpPct = hasTp ? tpPctRaw : null
                  const qpPct = hasQp ? qpPctRaw : null
                  const peakPct = Number.isFinite(peakPctRaw) ? peakPctRaw : curPct

                  const slHit = hasSl ? curPct <= slPct : false
                  const tpHit = hasTp ? curPct >= tpPct : false
                  const qpArmed = hasQp ? qpPct > 0 : false
                  const qpHit = qpArmed ? curPct <= qpPct : false
                  const qpLimitSell = qpPct != null && entryPrice > 0 ? (entryPrice * (1 + qpPct / 100)) : null

                  const slDelta = hasSl ? Math.max(0, curPct - slPct) : null
                  const tpDelta = hasTp ? Math.max(0, tpPct - curPct) : null
                  const qpDelta = qpArmed ? Math.max(0, curPct - qpPct) : null

                  return (
                    <div key={i} style={{
                      borderRadius: '10px', padding: '0.9rem 1rem',
                      border: `1px solid ${isPos ? 'rgba(22,163,74,0.2)' : 'rgba(239,68,68,0.18)'}`,
                      background: isPos ? 'rgba(22,163,74,0.03)' : 'rgba(239,68,68,0.03)',
                    }}>
                      <div style={{ fontSize: '0.72rem', color: GOLD_DEEP, fontWeight: 700, marginBottom: '0.5rem', wordBreak: 'break-all' }}>
                        {p.symbol}
                      </div>
                      {[
                        { k: 'Side',         v: <span style={{ fontWeight: 800, color: side === 'long' ? '#16a34a' : '#ef4444', textTransform: 'uppercase' }}>{side || '—'}</span> },
                        { k: 'Qty',          v: qtyNum || p.qty || '—' },
                        { k: 'Entry Time',   v: fmtEntryTime(p.entry_time) },
                        { k: 'Entry Price',  v: entryPrice > 0 ? `$${fmt(entryPrice)}` : '—' },
                        { k: 'Current',      v: <span style={{ fontWeight: 800 }}>{currentPrice > 0 ? `$${fmt(currentPrice)}` : '—'}</span> },
                        { k: 'Unrealized P&L', v: <span style={{ fontWeight: 900, color: isPos ? '#16a34a' : '#ef4444' }}>{isPos ? '+' : ''}${fmt(uPl)} ({curPct.toFixed(2)}%)</span> },
                      ].map(({k, v}) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.25rem 0', borderBottom: '1px solid rgba(0,0,0,0.04)', fontSize: '0.78rem' }}>
                          <span style={{ color: '#aaa', fontWeight: 600 }}>{k}</span>
                          <span style={{ color: '#111', fontWeight: 700 }}>{v}</span>
                        </div>
                      ))}

                      <div style={{
                        marginTop: '0.55rem',
                        borderTop: '1px dashed rgba(201,162,39,0.22)',
                        paddingTop: '0.5rem',
                      }}>
                        <div style={{
                          fontSize: '0.62rem',
                          color: '#b2a27d',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          marginBottom: '0.35rem',
                        }}>
                          Exit Watch
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem', marginBottom: '0.45rem' }}>
                          {[
                            { k: 'SL', v: slPct != null ? fmtPctSigned(slPct) : '—', c: '#ef4444', bg: 'rgba(239,68,68,0.07)' },
                            { k: 'QP LMT', v: qpPct != null ? fmtPctSigned(qpPct) : '—', c: '#d97706', bg: 'rgba(245,158,11,0.08)' },
                            { k: 'TP', v: tpPct != null ? fmtPctSigned(tpPct) : '—', c: '#16a34a', bg: 'rgba(22,163,74,0.07)' },
                          ].map(tile => (
                            <div key={tile.k} style={{ textAlign: 'center', borderRadius: '6px', background: tile.bg, padding: '0.25rem 0.15rem' }}>
                              <div style={{ fontSize: '0.56rem', fontWeight: 800, color: '#bbb', letterSpacing: '0.05em' }}>{tile.k}</div>
                              <div style={{ fontSize: '0.72rem', fontWeight: 900, color: tile.c }}>{tile.v}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          fontSize: '0.64rem', color: '#a16207', fontWeight: 700, marginBottom: '0.35rem',
                        }}>
                          <span>QP = dynamic limit sell floor</span>
                          <span style={{ color: '#92400e' }}>{qpLimitSell != null ? `$${fmt(qpLimitSell)}` : '—'}</span>
                        </div>

                        <div style={{ display: 'grid', gap: '0.2rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.67rem' }}>
                            <span style={{ color: '#ef4444', fontWeight: 700 }}>{slHit ? 'Hit SL' : 'Will hit SL'}</span>
                            <span style={{ color: '#777', fontWeight: 700 }}>
                              {slPct == null ? '—' : slHit ? fmtPctSigned(slPct) : `${slDelta.toFixed(2)}% away`}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.67rem' }}>
                            <span style={{ color: '#16a34a', fontWeight: 700 }}>{tpHit ? 'Hit TP' : 'Will hit TP'}</span>
                            <span style={{ color: '#777', fontWeight: 700 }}>
                              {tpPct == null ? '—' : tpHit ? fmtPctSigned(tpPct) : `${tpDelta.toFixed(2)}% away`}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.67rem' }}>
                            <span style={{ color: '#d97706', fontWeight: 700 }}>
                              {!qpArmed ? 'QP limit not armed' : qpHit ? 'Hit QP limit' : 'Will hit QP limit'}
                            </span>
                            <span style={{ color: '#777', fontWeight: 700 }}>
                              {qpPct == null
                                ? '—'
                                : !qpArmed
                                  ? `Peak ${fmtPctSigned(peakPct)} · LMT ${qpLimitSell != null ? `$${fmt(qpLimitSell)}` : '—'}`
                                  : qpHit
                                    ? `${fmtPctSigned(qpPct)} · LMT ${qpLimitSell != null ? `$${fmt(qpLimitSell)}` : '—'}`
                                    : `${qpDelta.toFixed(2)}% above · LMT ${qpLimitSell != null ? `$${fmt(qpLimitSell)}` : '—'}`}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div style={{ marginTop: '0.65rem', display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => handleLiquidatePosition(p.symbol)}
                          disabled={liquidating === p.symbol}
                          style={{
                            padding: '0.35rem 0.7rem',
                            borderRadius: '8px',
                            border: '1px solid rgba(239,68,68,0.35)',
                            background: 'rgba(239,68,68,0.08)',
                            color: '#ef4444',
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            cursor: liquidating === p.symbol ? 'not-allowed' : 'pointer',
                            opacity: liquidating === p.symbol ? 0.6 : 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.45rem',
                          }}
                        >
                          {liquidating === p.symbol ? (
                            <>
                              <Loader size="small" variant="classic" text="" />
                              <span style={{ fontSize: '0.72rem', fontWeight: 800 }}>Liquidating...</span>
                            </>
                          ) : (
                            'Liquidate'
                          )}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* ── Symbol Trade History ── */}
        {(() => {
          // Dedup by id first (same trade can arrive from both endpoints)
          const seen = new Set()
          const deduped = tradeHistory.filter(t => {
            if (seen.has(t.id)) return false
            seen.add(t.id)
            return true
          })
          // Match by underlying symbol OR by contractName prefix
          // (MONITOR_EXIT trades store the full contract as symbol, e.g. "TSLA260424C00387500")
          const symbolHistory = deduped.filter(t => {
            if (t.symbol === selected.symbol) return true
            const cn = String(t.contractName || t.symbol || '')
            return cn.startsWith(selected.symbol)
          })

          // Time filter helper
          const histCutoff = () => {
            const now = new Date()
            if (histTimeFilter === 'Today') {
              // Start of today in Chicago/Central time
              const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) // YYYY-MM-DD
              return new Date(todayStr + 'T00:00:00-05:00') // approx CDT start
            }
            if (histTimeFilter === '1H')  { const d = new Date(now); d.setHours(d.getHours()   - 1);  return d }
            if (histTimeFilter === '3H')  { const d = new Date(now); d.setHours(d.getHours()   - 3);  return d }
            if (histTimeFilter === '5H')  { const d = new Date(now); d.setHours(d.getHours()   - 5);  return d }
            if (histTimeFilter === '1D')  { const d = new Date(now); d.setDate(d.getDate()      - 1);  return d }
            if (histTimeFilter === '3D')  { const d = new Date(now); d.setDate(d.getDate()      - 3);  return d }
            if (histTimeFilter === '1W')  { const d = new Date(now); d.setDate(d.getDate()      - 7);  return d }
            return null
          }
          const cutoff = histCutoff()
          const timeFiltered = cutoff
            ? symbolHistory.filter(t => {
                const d = new Date(t._entryIso || t.entryTime || t.exitTime || 0)
                return !isNaN(d) && d >= cutoff
              })
            : symbolHistory
          const typeFiltered = histTypeFilter === 'All'
            ? timeFiltered
            : histTypeFilter === 'MT'
              ? timeFiltered.filter(t => t.type === 'manual')
              : timeFiltered.filter(t => t.type !== 'manual')
          // Sort by entry time descending (most recent first)
          const filteredHistory = [...typeFiltered].sort((a, b) => {
            const ta = new Date(a._entryIso || a.entryTime || 0).getTime()
            const tb = new Date(b._entryIso || b.entryTime || 0).getTime()
            return tb - ta
          })

          const hWins   = filteredHistory.filter(t => t.result === 'WIN').length
          const hLosses = filteredHistory.filter(t => t.result === 'LOSS').length
          const hNetPnl = filteredHistory.reduce((s, t) => s + (Number(t.pnl) || 0), 0)

          return (
        <div style={{
          background: '#fff',
          border: '1px solid rgba(201,162,39,0.15)',
          borderRadius: '14px',
          overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0.9rem 1.5rem',
            borderBottom: '1px solid rgba(201,162,39,0.1)',
            background: 'rgba(201,162,39,0.03)',
            flexWrap: 'wrap', gap: '0.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Layers size={14} color={GOLD_DEEP} />
              <span style={{ fontSize: '0.82rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {selected.symbol} · Today's Trades
              </span>
              {filteredHistory.length > 0 && (
                <span style={{
                  padding: '0.1rem 0.5rem', borderRadius: '20px', fontSize: '0.65rem', fontWeight: 700,
                  background: 'rgba(201,162,39,0.12)', color: GOLD_DEEP,
                }}>{filteredHistory.length}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Trade type filter */}
              <div style={{ display: 'flex', gap: '0.2rem', background: 'rgba(0,0,0,0.04)', borderRadius: '20px', padding: '0.15rem' }}>
                {[{ val: 'All', label: 'All' }, { val: 'MT', label: 'MT' }, { val: 'AIT', label: 'AIT' }].map(f => (
                  <button key={f.val} onClick={() => setHistTypeFilter(f.val)} style={{
                    padding: '0.18rem 0.6rem', borderRadius: '20px', border: 'none', cursor: 'pointer',
                    fontWeight: 800, fontSize: '0.68rem',
                    background: histTypeFilter === f.val
                      ? f.val === 'MT' ? '#2563eb' : f.val === 'AIT' ? GOLD_DEEP : '#333'
                      : 'transparent',
                    color: histTypeFilter === f.val ? '#fff' : '#aaa',
                    transition: 'all 0.15s',
                  }}>{f.label}</button>
                ))}
              </div>
              {/* Time filter tabs */}
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {['Today','1H','3H','5H','1D','3D','1W'].map(f => (
                  <button key={f} onClick={() => setHistTimeFilter(f)} style={{
                    padding: '0.22rem 0.65rem', borderRadius: '20px', border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: '0.72rem',
                    background: histTimeFilter === f ? `linear-gradient(135deg,${GOLD} 0%,${GOLD_LIGHT} 100%)` : 'rgba(201,162,39,0.07)',
                    color: histTimeFilter === f ? '#111' : '#999',
                    boxShadow: histTimeFilter === f ? '0 2px 6px rgba(201,162,39,0.25)' : 'none',
                    transition: 'all 0.15s',
                  }}>{f}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Stats chips */}
          {filteredHistory.length > 0 && (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', padding: '0.65rem 1.5rem', background: 'rgba(201,162,39,0.02)', borderBottom: '1px solid rgba(201,162,39,0.07)', flexWrap: 'wrap' }}>
              {[
                { label: 'Trades', value: filteredHistory.length,                     color: '#555'                              },
                { label: 'Wins',   value: hWins,                                       color: '#16a34a'                           },
                { label: 'Losses', value: hLosses,                                     color: '#ef4444'                           },
                { label: 'Win %',  value: `${filteredHistory.length > 0 ? ((hWins / filteredHistory.length) * 100).toFixed(0) : 0}%`, color: '#555' },
                { label: 'Net P&L',value: `${hNetPnl >= 0 ? '+' : ''}$${fmt(hNetPnl)}`,color: hNetPnl >= 0 ? '#16a34a' : '#ef4444'},
              ].map(chip => (
                <div key={chip.label} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.68rem', color: '#bbb', fontWeight: 600 }}>{chip.label}</span>
                  <span style={{ fontSize: '0.8rem', fontWeight: 800, color: chip.color }}>{chip.value}</span>
                </div>
              ))}
            </div>
          )}

          {filteredHistory.length === 0 ? (
            <div style={{ padding: '2.5rem 1.5rem', textAlign: 'center', color: '#ccc', fontSize: '0.8rem', fontWeight: 600 }}>
              No trades for {selected.symbol} in the selected period.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.72rem', padding: '0.9rem 1.15rem 1.25rem', maxHeight: '520px', overflowY: 'auto' }}>
              {filteredHistory.map((t, i) => {
                const pnlPct = t.buyPrice > 0 ? ((t.sellPrice - t.buyPrice) / t.buyPrice * 100) : 0
                const underlying = t.symbol && t.symbol.length <= 6 ? t.symbol : selected.symbol
                const isWin = t.result === 'WIN'
                const isBreakeven = t.result === 'BREAKEVEN'
                const accent = isBreakeven ? '#d97706' : isWin ? '#16a34a' : '#ef4444'
                const accentBg = isBreakeven ? 'rgba(217,119,6,0.08)' : isWin ? 'rgba(22,163,74,0.06)' : 'rgba(239,68,68,0.06)'
                const sourceMeta = t.type === 'manual'
                  ? { label: 'MT', bg: 'rgba(37,99,235,0.12)', color: '#2563eb' }
                  : t.type === 'straddle'
                    ? { label: 'STRADDLE', bg: 'rgba(201,162,39,0.15)', color: GOLD_DEEP }
                    : t.type === 'recovery'
                      ? { label: 'RECOVERY', bg: 'rgba(148,163,184,0.16)', color: '#475569' }
                      : t.type === 'monitor'
                        ? { label: 'MONITOR', bg: 'rgba(99,102,241,0.14)', color: '#4338ca' }
                        : { label: 'AIT', bg: 'rgba(201,162,39,0.12)', color: GOLD_DEEP }
                const sideLabel = t.optionType !== '—' ? t.optionType.toUpperCase() : '—'
                const exitReason = String(t.exitReason || t.exit_reason || '—').replace(/_/g, ' ')
                const entryStrategyText = formatEntryStrategies(t)

                return (
                  <div
                    key={t.id || i}
                    style={{
                      borderRadius: '11px',
                      border: `1px solid ${accent}44`,
                      borderLeft: `4px solid ${accent}`,
                      background: '#fff',
                      boxShadow: '0 1px 8px rgba(0,0,0,0.03)',
                      padding: '0.72rem 0.9rem 0.8rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.7rem', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                          <span style={{ color: '#bbb', fontSize: '0.67rem', fontWeight: 700 }}>#{i + 1}</span>
                          <span style={{ color: '#111', fontSize: '0.88rem', fontWeight: 900 }}>{underlying}</span>
                          <span style={{
                            padding: '0.13rem 0.42rem', borderRadius: '4px',
                            fontWeight: 800, fontSize: '0.63rem', letterSpacing: '0.03em',
                            background: sourceMeta.bg, color: sourceMeta.color,
                          }}>{sourceMeta.label}</span>
                          <span style={{
                            padding: '0.13rem 0.42rem', borderRadius: '20px',
                            fontWeight: 800, fontSize: '0.62rem',
                            background: sideLabel === 'CALL' ? 'rgba(22,163,74,0.11)' : sideLabel === 'PUT' ? 'rgba(239,68,68,0.1)' : 'rgba(0,0,0,0.05)',
                            color: sideLabel === 'CALL' ? '#16a34a' : sideLabel === 'PUT' ? '#ef4444' : '#777',
                          }}>{sideLabel}</span>
                        </div>
                        <div style={{
                          fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600,
                          marginTop: '0.16rem', maxWidth: '700px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }} title={t.contractName}>{t.contractName}</div>
                      </div>

                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: '1.02rem', fontWeight: 900, color: accent, lineHeight: 1 }}>
                          {t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}
                        </div>
                        <div style={{ fontSize: '0.68rem', fontWeight: 800, color: accent, marginTop: '0.16rem' }}>
                          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                        </div>
                      </div>
                    </div>

                    {t.type !== 'manual' && entryStrategyText !== '—' && (
                      <div style={{
                        marginTop: '0.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        flexWrap: 'wrap',
                      }}>
                        <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#b5973b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Entry Strategy
                        </span>
                        {resolveEntryStrategyNames(t).map(name => (
                          <span key={name} style={{
                            padding: '0.14rem 0.46rem',
                            borderRadius: '999px',
                            border: '1px solid rgba(201,162,39,0.22)',
                            background: 'rgba(201,162,39,0.07)',
                            color: GOLD_DEEP,
                            fontSize: '0.64rem',
                            fontWeight: 800,
                          }}>
                            {name}
                          </span>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '0.3rem', marginTop: '0.52rem' }}>
                      {[
                        { k: 'Strike', v: t.strikePrice !== '—' ? `$${fmt(+t.strikePrice)}` : '—' },
                        { k: 'Entry $', v: `$${fmt(t.buyPrice)}` },
                        { k: 'Exit $', v: `$${fmt(t.sellPrice)}` },
                        { k: 'Entry Time', v: t.entryTime },
                        { k: 'Exit Time', v: t.exitTime },
                      ].map(row => (
                        <div key={row.k} style={{ background: 'rgba(201,162,39,0.04)', borderRadius: '6px', padding: '0.32rem 0.42rem' }}>
                          <div style={{ fontSize: '0.58rem', color: '#b2b2b2', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{row.k}</div>
                          <div style={{ fontSize: '0.72rem', color: '#333', fontWeight: 800, marginTop: '0.08rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(row.v)}>{row.v || '—'}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{
                      marginTop: '0.52rem',
                      borderRadius: '7px',
                      background: accentBg,
                      border: `1px solid ${accent}33`,
                      padding: '0.36rem 0.5rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}>
                      <span style={{
                        padding: '0.14rem 0.5rem', borderRadius: '20px',
                        background: isBreakeven ? 'rgba(217,119,6,0.18)' : isWin ? 'rgba(22,163,74,0.14)' : 'rgba(239,68,68,0.14)',
                        color: accent,
                        fontSize: '0.65rem',
                        fontWeight: 900,
                        letterSpacing: '0.03em',
                      }}>{isBreakeven ? 'BREAKEVEN' : isWin ? 'WIN' : 'LOSS'}</span>
                      <span style={{
                        fontSize: '0.69rem',
                        color: '#555',
                        fontWeight: 700,
                        maxWidth: '72%',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }} title={exitReason}>{exitReason}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
          )
        })()}
      </div>

      {/* RIGHT: Config Panel */}
      <div className="no-scroll-panel" style={{ width: '254px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1rem', position: 'sticky', top: '90px', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', paddingRight: '2px', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <style>{`.no-scroll-panel::-webkit-scrollbar { display: none; }`}</style>

        {/* Config warning banner */}
        {tradingConfig.config_warning && (
          <div style={{
            background: tradingConfig.config_healthy ? 'rgba(37,99,235,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${tradingConfig.config_healthy ? 'rgba(37,99,235,0.25)' : 'rgba(239,68,68,0.3)'}`,
            borderRadius: '10px', padding: '0.6rem 0.85rem',
            fontSize: '0.7rem', fontWeight: 600,
            color: tradingConfig.config_healthy ? '#1d4ed8' : '#ef4444',
            lineHeight: 1.4, flexShrink: 0,
          }}>
            ⚠️ {tradingConfig.config_warning}
          </div>
        )}

        {/* AI Trade / Manual Trade Toggle */}
        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: '12px', padding: '4px', border: '1px solid rgba(201,162,39,0.15)', flexShrink: 0 }}>
          <button
            onClick={() => handleSetTradeMode('ai')}
            disabled={!tradingConfig.ait_enabled}
            title={!tradingConfig.ait_enabled ? 'AIT disabled in config.py' : undefined}
            style={{
              flex: 1, padding: '0.55rem 0.5rem', borderRadius: '9px', border: 'none',
              cursor: tradingConfig.ait_enabled ? 'pointer' : 'not-allowed',
              fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
              transition: 'all 0.2s', opacity: tradingConfig.ait_enabled ? 1 : 0.4,
              background: tradeMode === 'ai' ? `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)` : 'transparent',
              color: tradeMode === 'ai' ? '#111' : '#999',
              boxShadow: tradeMode === 'ai' ? '0 2px 8px rgba(201,162,39,0.3)' : 'none',
            }}
          >
            <Zap size={13} fill={tradeMode === 'ai' ? '#111' : 'none'} />
            AI Trade {!tradingConfig.ait_enabled && '🔒'}
          </button>
          <button
            onClick={() => handleSetTradeMode('manual')}
            disabled={!tradingConfig.mt_enabled}
            title={!tradingConfig.mt_enabled ? 'MT disabled in config.py' : undefined}
            style={{
              flex: 1, padding: '0.55rem 0.5rem', borderRadius: '9px', border: 'none',
              cursor: tradingConfig.mt_enabled ? 'pointer' : 'not-allowed',
              fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
              transition: 'all 0.2s', opacity: tradingConfig.mt_enabled ? 1 : 0.4,
              background: tradeMode === 'manual' ? '#fff' : 'transparent',
              color: tradeMode === 'manual' ? '#111' : '#999',
              boxShadow: tradeMode === 'manual' ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            <User size={13} />
            Manual {!tradingConfig.mt_enabled && '🔒'}
          </button>
        </div>

        {/* Entry Strategy Toggles */}
        <div style={{
          background: '#fff', border: '1px solid rgba(201,162,39,0.18)', borderRadius: '14px',
          padding: '0.95rem 0.9rem', boxShadow: '0 2px 10px rgba(0,0,0,0.04)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
            <div style={{ fontSize: '0.74rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Entry Strategies
            </div>
            <div style={{ fontSize: '0.66rem', fontWeight: 700, color: GOLD_DEEP }}>
              {entryStrategies.enabled.length}/{entryStrategies.maxEnabled}
            </div>
          </div>
          <div style={{ fontSize: '0.67rem', color: '#777', marginBottom: '0.6rem', lineHeight: 1.35 }}>
            Enable up to {entryStrategies.maxEnabled} for entry. Exit logic stays unchanged.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.42rem' }}>
            {(entryStrategies.available || []).map((item) => {
              const isEnabled = !!item.enabled
              const maxReached = !isEnabled && entryStrategies.enabled.length >= (entryStrategies.maxEnabled || 2)
              return (
                <button
                  key={item.id}
                  onClick={() => toggleEntryStrategy(item.id, !isEnabled)}
                  disabled={strategyBusy || maxReached}
                  title={maxReached ? `Maximum ${entryStrategies.maxEnabled} strategies can be active` : ''}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.5rem 0.62rem',
                    borderRadius: '9px',
                    border: `1px solid ${isEnabled ? 'rgba(201,162,39,0.5)' : 'rgba(0,0,0,0.1)'}`,
                    background: isEnabled
                      ? 'linear-gradient(135deg, rgba(201,162,39,0.18) 0%, rgba(245,197,24,0.2) 100%)'
                      : '#fff',
                    color: isEnabled ? '#111' : '#555',
                    fontSize: '0.72rem',
                    fontWeight: isEnabled ? 700 : 600,
                    cursor: strategyBusy || maxReached ? 'not-allowed' : 'pointer',
                    opacity: strategyBusy || maxReached ? 0.55 : 1,
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{
                    minWidth: '38px',
                    textAlign: 'center',
                    fontSize: '0.64rem',
                    fontWeight: 800,
                    borderRadius: '999px',
                    padding: '0.12rem 0.32rem',
                    background: isEnabled ? 'rgba(16,185,129,0.14)' : 'rgba(107,114,128,0.12)',
                    color: isEnabled ? '#047857' : '#6b7280',
                  }}>
                    {isEnabled ? 'ON' : 'OFF'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── MANUAL TRADE SECTION ── always visible; Buy/Sell hidden in AI mode */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Manual Trade Form */}
          <div style={{ background: '#fff', border: '1px solid rgba(201,162,39,0.15)', borderRadius: '14px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#111', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <User size={13} color={GOLD_DEEP} /> Trade Setup
              {suggestLoading && autoSuggestEnabled && (
                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: GOLD_DEEP, fontWeight: 600 }}>loading...</span>
              )}
              {!manualPosition && (
                <button
                  onClick={() => setAutoSuggestEnabled(v => !v)}
                  style={{
                    marginLeft: suggestLoading && autoSuggestEnabled ? '0' : 'auto',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '6px',
                    border: `1px solid ${autoSuggestEnabled ? 'rgba(22,163,74,0.35)' : 'rgba(100,100,100,0.25)'}`,
                    background: autoSuggestEnabled ? 'rgba(22,163,74,0.08)' : 'rgba(100,100,100,0.08)',
                    color: autoSuggestEnabled ? '#16a34a' : '#666',
                    fontSize: '0.65rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                  title="Toggle auto-suggest form updates"
                >
                  SUGGEST {autoSuggestEnabled ? 'ON' : 'OFF'}
                </button>
              )}
              {!suggestLoading && !manualPosition && (
                <button onClick={() => fetchSuggest(selected.symbol)} style={{
                  marginLeft: '0.3rem', padding: '0.2rem 0.5rem', borderRadius: '6px', border: `1px solid rgba(201,162,39,0.3)`,
                  background: 'rgba(201,162,39,0.07)', color: GOLD_DEEP, fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer',
                }}>Refresh</button>
              )}
            </div>

            {/* Strike Price */}
            <div style={{ marginBottom: '0.8rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.35rem' }}>Strike Price</label>
              <div style={{ display: 'flex', alignItems: 'center', border: `1.5px solid ${manualPosition ? 'rgba(0,0,0,0.08)' : 'rgba(201,162,39,0.3)'}`, borderRadius: '8px', padding: '0.48rem 0.75rem', background: manualPosition ? '#f9f9f9' : '#fff' }}>
                <span style={{ fontSize: '0.82rem', color: '#aaa', marginRight: '3px', fontWeight: 600 }}>$</span>
                        <input
                          type="number" step="1" inputMode="numeric" placeholder="e.g. 185"
                          value={strikePrice}
                          disabled={!!manualPosition}
                          onChange={e => setStrikePrice(e.target.value)}
                          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: '0.88rem', fontWeight: 700, color: '#111', minWidth: 0 }}
                        />
            </div>

            {/* Direction */}
            <div style={{ marginBottom: '0.8rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.35rem' }}>Direction</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {[
                  { val: 'uptrend',   label: 'Uptrend',   icon: <TrendingUp size={12} />,   activeColor: '#16a34a', activeBg: 'rgba(22,163,74,0.1)',  activeBorder: 'rgba(22,163,74,0.3)'  },
                  { val: 'downtrend', label: 'Downtrend', icon: <TrendingDown size={12} />, activeColor: '#ef4444', activeBg: 'rgba(239,68,68,0.08)', activeBorder: 'rgba(239,68,68,0.25)' },
                ].map(opt => (
                  <button key={opt.val} onClick={() => setDirection(opt.val)} disabled={!!manualPosition} style={{
                    flex: 1, padding: '0.45rem 0.3rem', borderRadius: '8px', border: 'none', cursor: manualPosition ? 'not-allowed' : 'pointer',
                    fontWeight: 700, fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.25rem',
                    background: direction === opt.val ? opt.activeBg : '#f3f4f6',
                    color: direction === opt.val ? opt.activeColor : '#aaa',
                    outline: direction === opt.val ? `1.5px solid ${opt.activeBorder}` : '1.5px solid transparent',
                    opacity: manualPosition ? 0.6 : 1, transition: 'all 0.15s',
                  }}>{opt.icon}{opt.label}</button>
                ))}
              </div>
            </div>

            {/* Call / Put */}
            <div style={{ marginBottom: '0.8rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.35rem' }}>Option Type</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {[
                  { val: 'call', activeColor: '#16a34a', activeBg: 'rgba(22,163,74,0.1)',  activeBorder: 'rgba(22,163,74,0.3)'  },
                  { val: 'put',  activeColor: '#ef4444', activeBg: 'rgba(239,68,68,0.08)', activeBorder: 'rgba(239,68,68,0.25)' },
                ].map(opt => (
                  <button key={opt.val} onClick={() => {
                    setOptionType(opt.val)
                    if (!manualPosition) {
                      suggestContractRef.current = null
                      // Always sync once on type switch so strike/expiry follow selected contract.
                      fetchSuggestForType(selected.symbol, opt.val, { applyForm: true, updateType: false })
                    }
                  }} disabled={!!manualPosition} style={{
                    flex: 1, padding: '0.45rem', borderRadius: '8px', border: 'none', cursor: manualPosition ? 'not-allowed' : 'pointer',
                    fontWeight: 800, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                    background: optionType === opt.val ? opt.activeBg : '#f3f4f6',
                    color: optionType === opt.val ? opt.activeColor : '#aaa',
                    outline: optionType === opt.val ? `1.5px solid ${opt.activeBorder}` : '1.5px solid transparent',
                    opacity: manualPosition ? 0.6 : 1, transition: 'all 0.15s',
                  }}>{opt.val}</button>
                ))}
              </div>
            </div>

            {/* Expiry & Qty */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.9rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.35rem' }}>Expiry</label>
                <input
                  type="date" value={expiry} disabled={!!manualPosition}
                  onChange={e => setExpiry(e.target.value)}
                  style={{ width: '100%', padding: '0.48rem 0.4rem', border: `1.5px solid ${manualPosition ? 'rgba(0,0,0,0.08)' : 'rgba(201,162,39,0.3)'}`, borderRadius: '8px', background: manualPosition ? '#f9f9f9' : '#fff', color: '#111', fontSize: '0.72rem', fontWeight: 600, outline: 'none', opacity: manualPosition ? 0.6 : 1, boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ width: '60px' }}>
                <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.35rem' }}>Qty</label>
                <input
                  type="number" min="1" max="100" value={qty} disabled={!!manualPosition}
                  onChange={e => setQty(e.target.value)}
                  style={{ width: '100%', padding: '0.48rem 0.3rem', border: `1.5px solid ${manualPosition ? 'rgba(0,0,0,0.08)' : 'rgba(201,162,39,0.3)'}`, borderRadius: '8px', background: manualPosition ? '#f9f9f9' : '#fff', color: '#111', fontSize: '0.88rem', fontWeight: 700, outline: 'none', textAlign: 'center', opacity: manualPosition ? 0.6 : 1, boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {/* Order Summary */}
            <div style={{ marginBottom: '0.9rem', padding: '0.55rem 0.75rem', background: 'rgba(201,162,39,0.05)', borderRadius: '8px', border: '1px solid rgba(201,162,39,0.15)', fontSize: '0.75rem', color: '#999', fontWeight: 600, display: 'flex', flexWrap: 'wrap', gap: '0.3rem', lineHeight: 1.6 }}>
              <span style={{ color: optionType === 'call' ? '#16a34a' : '#ef4444', fontWeight: 800, textTransform: 'uppercase' }}>{optionType}</span>
              {strikePrice && <><span>·</span><span style={{ color: '#111' }}>${strikePrice}</span></>}
              {expiry && <><span>·</span><span>{expiry}</span></>}
              <span>·</span>
              <span style={{ color: GOLD_DEEP }}>×{qty || 1} lot{parseInt(qty) !== 1 ? 's' : ''}</span>
              <span style={{ color: direction === 'uptrend' ? '#16a34a' : '#ef4444' }}>· {direction === 'uptrend' ? 'Up' : 'Down'}</span>
            </div>

            {!manualPosition && (
              <div style={{
                marginBottom: '0.75rem',
                padding: '0.45rem 0.65rem',
                borderRadius: '8px',
                border: '1px solid rgba(0,0,0,0.08)',
                background: '#fafafa',
                fontSize: '0.66rem',
                lineHeight: 1.4,
                display: 'grid',
                gap: '0.2rem',
              }}>
                <div style={{ color: '#666', fontWeight: 700 }}>
                  SELECTED {optionType.toUpperCase()} CONTRACT: <span style={{ color: '#111', fontFamily: 'monospace' }}>{(optionType === 'put' ? quoteBook.put?.contract_name : quoteBook.call?.contract_name) || '—'}</span>
                </div>
                <div style={{ color: '#888', fontWeight: 700 }}>
                  Expiry: <span style={{ color: '#111' }}>{(optionType === 'put' ? quoteBook.put?.expiry : quoteBook.call?.expiry) || expiry || '—'}</span>
                  {' · '}
                  Strike: <span style={{ color: '#111' }}>${(optionType === 'put' ? quoteBook.put?.strike_price : quoteBook.call?.strike_price) ?? strikePrice ?? '—'}</span>
                </div>
              </div>
            )}

            {!manualPosition && !autoSuggestEnabled && (
              <div style={{
                marginBottom: '0.7rem',
                padding: '0.4rem 0.6rem',
                borderRadius: '8px',
                border: '1px solid rgba(201,162,39,0.18)',
                background: 'rgba(201,162,39,0.04)',
                fontSize: '0.68rem',
                fontWeight: 700,
                display: 'grid',
                gap: '0.3rem',
              }}>
                <span style={{ color: '#16a34a' }}>
                  CALL ready: {quoteBook.call?.ask > 0 ? `$${quoteBook.call.ask.toFixed(2)}` : '—'}
                  {' · '}
                  {quoteBook.call?.contract_name || '—'}
                  {' · Exp '}
                  {quoteBook.call?.expiry || '—'}
                </span>
                <span style={{ color: '#ef4444' }}>
                  PUT ready: {quoteBook.put?.ask > 0 ? `$${quoteBook.put.ask.toFixed(2)}` : '—'}
                  {' · '}
                  {quoteBook.put?.contract_name || '—'}
                  {' · Exp '}
                  {quoteBook.put?.expiry || '—'}
                </span>
              </div>
            )}

            {/* Bid / Ask price row + spread warning */}
            {!manualPosition && contractQuote && contractQuote.ask > 0 && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.35rem' }}>
                  <div style={{ flex: 1, padding: '0.42rem 0.6rem', borderRadius: '7px', background: 'rgba(22,163,74,0.07)', border: '1px solid rgba(22,163,74,0.2)', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Bid</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#16a34a' }}>${contractQuote.bid.toFixed(2)}</div>
                  </div>
                  <div style={{ flex: 1, padding: '0.42rem 0.6rem', borderRadius: '7px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ask</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#ef4444' }}>${contractQuote.ask.toFixed(2)}</div>
                  </div>
                  <div style={{ flex: 1, padding: '0.42rem 0.6rem', borderRadius: '7px', background: 'rgba(100,100,100,0.06)', border: '1px solid rgba(100,100,100,0.13)', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mid</div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color: '#555' }}>${contractQuote.mid.toFixed(2)}</div>
                  </div>
                </div>
                {/* Spread warning: >10% spread = wide, you'll immediately be down */}
                {contractQuote.spread_pct > 10 && (
                  <div style={{ padding: '0.38rem 0.6rem', borderRadius: '7px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.69rem', fontWeight: 700, color: '#dc2626', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    ⚠️ Wide spread {contractQuote.spread_pct.toFixed(1)}% — you buy at ask ${contractQuote.ask.toFixed(2)}, instantly worth bid ${contractQuote.bid.toFixed(2)}. High risk of immediate loss.
                  </div>
                )}
                {contractQuote.spread_pct > 0 && contractQuote.spread_pct <= 10 && (
                  <div style={{ padding: '0.35rem 0.6rem', borderRadius: '7px', background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.2)', fontSize: '0.68rem', fontWeight: 600, color: '#92710a', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    Spread {contractQuote.spread_pct.toFixed(1)}% · entry at ask, exit near bid
                  </div>
                )}
              </div>
            )}

            {/* Buy / Sell Button — hidden in AI mode, but always visible when a position is open */}
            {(tradeMode !== 'ai' || manualPosition) && <button
              onClick={manualPosition ? handleSell : handleBuy}
              disabled={orderStatus === 'waiting' || orderStatus === 'selling' || (!manualPosition && !expiry)}
              style={{
                width: '100%', padding: '0.9rem', borderRadius: '10px', border: 'none',
                cursor: (orderStatus === 'waiting' || orderStatus === 'selling' || (!manualPosition && (!strikePrice || !expiry))) ? 'not-allowed' : 'pointer',
                fontWeight: 800, fontSize: '0.9rem', letterSpacing: '0.03em',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                transition: 'all 0.2s ease',
                opacity: (orderStatus === 'waiting' || orderStatus === 'selling' || (!manualPosition && (!strikePrice || !expiry))) ? 0.55 : 1,
                ...(manualPosition
                  ? { background: '#fff0f0', color: '#ef4444', boxShadow: '0 4px 14px rgba(239,68,68,0.18)', outline: '1.5px solid rgba(239,68,68,0.3)' }
                  : { background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)', color: '#fff', boxShadow: '0 4px 16px rgba(22,163,74,0.32)' }
                ),
              }}
              onMouseEnter={e => { if (!(['waiting','selling'].includes(orderStatus))) e.currentTarget.style.transform = 'translateY(-1px)' }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none' }}
            >
              {manualPosition
                ? orderStatus === 'selling'
                  ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(239,68,68,0.4)', borderTopColor: '#ef4444', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> Selling…</>
                  : <><Square size={14} fill="#ef4444" /> Sell · Close Position</>
                : orderStatus === 'waiting'
                  ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> Waiting for Fill…</>
                  : <><Play size={14} fill="#fff" /> Buy {optionType === 'call' ? 'Call' : 'Put'}</>
              }
            </button>}

            {/* Order fill status badge */}
            {orderStatus === 'waiting' && !manualPosition && (
              <div style={{ marginTop: '0.6rem', padding: '0.4rem 0.75rem', borderRadius: '8px', fontSize: '0.72rem', fontWeight: 700, textAlign: 'center',
                background: 'rgba(201,162,39,0.1)', color: GOLD_DEEP, border: `1px solid rgba(201,162,39,0.25)`,
              }}>⏳ Waiting for Fill…</div>
            )}
            {orderStatus === 'error' && (
              <div style={{ marginTop: '0.6rem', padding: '0.4rem 0.75rem', borderRadius: '8px', fontSize: '0.72rem', fontWeight: 700, textAlign: 'center',
                background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)',
              }}>✗ Order Failed</div>
            )}
            {manualPosition?.backendMonitored && orderStatus === 'filled' && (
              <div style={{ marginTop: '0.6rem', padding: '0.45rem 0.75rem', borderRadius: '8px', fontSize: '0.72rem', fontWeight: 700, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                background: 'rgba(22,163,74,0.07)', color: '#16a34a', border: '1px solid rgba(22,163,74,0.2)',
              }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'livePulse 1.5s infinite' }} />
                Bot monitoring exit strategy
              </div>
            )}
          </div>

          {/* Contract Tracker */}
          {(() => {
            const registryPos = registryPositions.find(lp =>
              String(lp.contract_symbol || lp.symbol || '').startsWith(selected.symbol)
            )
            const livePos = livePositions.find(p => p.symbol?.startsWith(selected.symbol))
            const fallbackPos = registryPos || livePos

            const trackedPos = manualPosition || (fallbackPos ? {
              contractSymbol: fallbackPos.contract_symbol || fallbackPos.symbol,
              fillPrice: Number(fallbackPos.fill_price ?? fallbackPos.avg_entry_price) || 0,
              qty: Number(fallbackPos.qty) || 1,
            } : null)

            const trackedPrice = trackedPos
              ? resolveContractLivePrice(
                  trackedPos.contractSymbol,
                  Number(registryPos?.live?.current_price ?? livePos?.current_price) || Number(trackedPos.fillPrice) || 0
                )
              : 0
            const trackedPnl = trackedPos
              ? (trackedPrice - Number(trackedPos.fillPrice || 0)) * (Number(trackedPos.qty || 1) * 100)
              : 0

            return (
          <div style={{ background: '#fff', border: '1px solid rgba(201,162,39,0.15)', borderRadius: '14px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#111', marginBottom: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Activity size={13} color={GOLD} />
              Contract Tracker
              {trackedPos && (
                <div style={{ marginLeft: 'auto', width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.7)' }} />
              )}
            </div>
            <style>{`@keyframes livePulse { 0%,100%{opacity:1} 50%{opacity:0.4} } @keyframes spin { to { transform: rotate(360deg) } } @keyframes slideInToast { from { opacity:0; transform:translateX(60px) } to { opacity:1; transform:translateX(0) } }`}</style>
            {trackedPos?.contractSymbol && (
              <div style={{ fontSize: '0.65rem', color: '#aaa', fontWeight: 600, marginBottom: '0.6rem', wordBreak: 'break-all' }}>
                {trackedPos.contractSymbol}
              </div>
            )}
            {[
              {
                label: 'Live Contract Price',
                value: trackedPos ? `$${fmt(trackedPrice)}` : '—',
                color: trackedPos ? (trackedPrice >= trackedPos.fillPrice ? '#16a34a' : '#ef4444') : '#ccc',
                live: true,
              },
              {
                label: 'Fill Price',
                value: trackedPos ? `$${fmt(trackedPos.fillPrice)}` : '—',
                color: trackedPos ? '#111' : '#ccc',
                live: false,
              },
              {
                label: 'P&L',
                value: trackedPos
                  ? `${trackedPnl >= 0 ? '+' : ''}$${fmt(trackedPnl)}`
                  : '—',
                color: trackedPos ? (trackedPnl >= 0 ? '#16a34a' : '#ef4444') : '#ccc',
                live: true,
              },
            ].map((row, i, arr) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: i < arr.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: '#888', fontWeight: 500 }}>
                  {row.label}
                  {row.live && trackedPos && (
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'livePulse 1.5s infinite' }} />
                  )}
                </div>
                <span style={{ fontSize: '0.9rem', fontWeight: 800, color: row.color, transition: 'color 0.3s' }}>{row.value}</span>
              </div>
            ))}
          </div>
            )
          })()}

          {/* Right panel compact tick log */}
          {(() => {
            const symbolLive = registryPositions.filter(lp => {
              const contract = String(lp.contract_symbol || lp.symbol || '')
              return contract.startsWith(selected.symbol)
            })
            if (symbolLive.length === 0) return null

            const activePos =
              (manualPosition?.contractSymbol
                ? symbolLive.find(lp => String(lp.contract_symbol || lp.symbol || '') === String(manualPosition.contractSymbol))
                : null) || symbolLive[0]

            const live = activePos?.live || {}
            const contract = String(activePos?.contract_symbol || activePos?.symbol || '')
            const timeline = Array.isArray(live.timeline) ? live.timeline : []
            if (timeline.length === 0) return null

            const fillPx = toNum(live.fill_price ?? activePos?.fill_price)
            const ticks = [...timeline].slice(-90).reverse()

            return (
              <div style={{
                background: '#fff',
                border: '1px solid rgba(201,162,39,0.15)',
                borderRadius: '14px',
                overflow: 'hidden',
                boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.72rem 0.9rem', borderBottom: '1px solid rgba(201,162,39,0.1)',
                  background: 'rgba(201,162,39,0.03)', gap: '0.45rem',
                }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Tick Log
                  </span>
                  <span style={{ fontSize: '0.6rem', color: '#9ca3af', fontWeight: 700, maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={contract}>
                    {contract}
                  </span>
                </div>

                <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '255px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px', fontSize: '0.62rem' }}>
                    <thead>
                      <tr style={{ background: '#fdfaf4', position: 'sticky', top: 0, zIndex: 1 }}>
                        {['Time', 'Src', 'Price', 'PnL%', 'Peak%', 'Peak Px'].map(h => (
                          <th key={h} style={{ padding: '0.24rem 0.35rem', textAlign: 'left', fontWeight: 800, color: '#888', borderBottom: '1px solid rgba(0,0,0,0.08)', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ticks.map((tick, idx) => {
                        const isOrder = tick.source === 'order_placed' || tick.source === 'order_replaced'
                        const isSell = tick.source === 'sell'
                        const srcBase = String(isSell ? (tick.exit_reason || 'sell') : (tick.source || 'tick')).toUpperCase()
                        const statusAt = tick.status_at || tick.filled_at || tick.canceled_at || tick.updated_at || tick.submitted_at || tick.ts
                        const src = isOrder
                          ? `${srcBase}:${String(tick.status || 'live').toUpperCase()} @ ${fmtTickTime(statusAt)}`
                          : srcBase
                        const price = !isOrder
                          ? (tick.sellable_price ?? tick.mid_price ?? tick.bid_price)
                          : (tick.fill_price ?? tick.limit_price)
                        const pnlRaw = tick.pnl_pct ?? tick.pct
                        const peakPct = toNum(tick.max_pnl_pct)
                        const peakPx = fillPx != null && peakPct != null ? fillPx * (1 + peakPct / 100) : null
                        const rowBg = isSell
                          ? 'rgba(239,68,68,0.08)'
                          : isOrder
                            ? 'rgba(217,119,6,0.06)'
                            : idx % 2 === 0
                              ? '#fff'
                              : '#fcfcfc'

                        return (
                          <tr key={`${tick.ts || idx}-${idx}`} style={{ background: rowBg, borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: '#555', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: isSell ? '#ef4444' : '#6b7280', fontWeight: 700, whiteSpace: 'nowrap' }}>{src}</td>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: '#111', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtMoneyMaybe(price)}</td>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: Number(pnlRaw ?? 0) >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtPctMaybe(pnlRaw)}</td>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: '#6366f1', whiteSpace: 'nowrap' }}>{fmtPctMaybe(tick.max_pnl_pct)}</td>
                            <td style={{ padding: '0.22rem 0.35rem', fontFamily: 'monospace', color: '#6366f1', whiteSpace: 'nowrap' }}>{peakPx != null ? fmtMoneyMaybe(peakPx) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ── Backend Activity Panel ──────────────────────────────────────── */}
        {/* Shows which symbols are running, what mode, and live position state */}
        <div style={{
          background: '#fff',
          border: '1px solid rgba(201,162,39,0.15)',
          borderRadius: '14px',
          overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid rgba(201,162,39,0.1)',
            background: 'rgba(201,162,39,0.03)',
            display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <Activity size={13} color={GOLD_DEEP} />
            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Backend Activity
            </span>
            {/* Global config flags */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.3rem' }}>
              <span style={{
                padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.58rem', fontWeight: 800,
                background: tradingConfig.ait_enabled ? 'rgba(201,162,39,0.15)' : 'rgba(239,68,68,0.1)',
                color: tradingConfig.ait_enabled ? GOLD_DEEP : '#ef4444',
              }}>AIT {tradingConfig.ait_enabled ? 'ON' : 'OFF'}</span>
              <span style={{
                padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.58rem', fontWeight: 800,
                background: tradingConfig.mt_enabled ? 'rgba(37,99,235,0.12)' : 'rgba(239,68,68,0.1)',
                color: tradingConfig.mt_enabled ? '#2563eb' : '#ef4444',
              }}>MT {tradingConfig.mt_enabled ? 'ON' : 'OFF'}</span>
            </div>
          </div>
          <div style={{ padding: '0.5rem 0', maxHeight: '260px', overflowY: 'auto' }}>
            {(tradingConfig.symbols || []).length === 0 ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#ccc', fontSize: '0.72rem' }}>
                Loading…
              </div>
            ) : (tradingConfig.symbols || []).map(s => {
              const modeColor = s.mode === 'auto' ? GOLD_DEEP : s.mode === 'manual' ? '#2563eb' : '#bbb'
              const modeLabel = s.mode_label || s.mode.toUpperCase()
              // Find any live position for this symbol in internal registry
              const livePos = registryPositions.find(p =>
                p.symbol === s.symbol ||
                (typeof p.contract_symbol === 'string' && p.contract_symbol.startsWith(s.symbol))
              )
              const pnl = livePos ? Number(livePos.live?.pnl_pct ?? 0) : null
              const monActive = livePos?.live?.monitoring_active
              return (
                <div key={s.symbol} style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.38rem 1rem',
                  borderBottom: '1px solid rgba(0,0,0,0.03)',
                  background: s.symbol === selected.symbol ? 'rgba(201,162,39,0.04)' : 'transparent',
                }}>
                  {/* Mode indicator dot */}
                  <span style={{
                    width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                    background: s.mode === 'auto' && s.watchlist_ait_on ? GOLD
                              : s.mode === 'manual' ? '#2563eb'
                              : '#ddd',
                    boxShadow: s.mode !== 'off' && (s.watchlist_ait_on || s.mode === 'manual')
                      ? `0 0 5px ${modeColor}88` : 'none',
                    animation: (s.mode !== 'off' && (livePos || s.watchlist_ait_on)) ? 'livePulse 2s infinite' : 'none',
                  }} />
                  {/* Symbol */}
                  <span style={{ fontSize: '0.72rem', fontWeight: 800, color: s.symbol === selected.symbol ? '#111' : '#555', minWidth: '38px' }}>
                    {s.symbol}
                  </span>
                  {/* Mode badge */}
                  <span style={{
                    padding: '0.08rem 0.35rem', borderRadius: '4px',
                    fontSize: '0.6rem', fontWeight: 800,
                    background: s.mode === 'auto' && s.watchlist_ait_on ? 'rgba(201,162,39,0.12)'
                              : s.mode === 'manual' ? 'rgba(37,99,235,0.1)'
                              : 'rgba(0,0,0,0.04)',
                    color: modeColor,
                  }}>{modeLabel}</span>
                  {/* Watchlist AIT flag if auto */}
                  {s.mode === 'auto' && !s.watchlist_ait_on && (
                    <span style={{ fontSize: '0.58rem', color: '#f59e0b', fontWeight: 700 }} title="AIT enabled but watchlist flag is OFF in config">⚠ watchlist off</span>
                  )}
                  {/* Live position indicator */}
                  {livePos && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.68rem', fontWeight: 800,
                      color: pnl != null ? (pnl >= 0 ? '#16a34a' : '#ef4444') : '#888' }}>
                      {monActive !== false ? (
                        <>{pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : 'LIVE'}</>
                      ) : (
                        <span style={{ color: '#94a3b8', fontSize: '0.6rem' }}>CLOSED</span>
                      )}
                    </span>
                  )}
                  {!livePos && s.mode !== 'off' && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#d1d5db', fontWeight: 600 }}>idle</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Toast Notifications ───────────────────────────────────────────── */}
      {toasts.length > 0 && (
        <div style={{
          position: 'fixed', bottom: '1.5rem', right: '1.5rem',
          zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '0.55rem',
          alignItems: 'flex-end', pointerEvents: 'none',
        }}>
          {toasts.map(toast => {
            const cfg = {
              success: { accent: '#16a34a', bg: 'rgba(22,163,74,0.08)',  border: 'rgba(22,163,74,0.25)',   icon: '✓' },
              error:   { accent: '#ef4444', bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.25)',   icon: '✕' },
              info:    { accent: GOLD_DEEP, bg: 'rgba(201,162,39,0.08)', border: 'rgba(201,162,39,0.28)', icon: '★' },
            }[toast.type] ?? { accent: GOLD_DEEP, bg: 'rgba(201,162,39,0.08)', border: 'rgba(201,162,39,0.28)', icon: '●' }
            return (
              <div key={toast.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.65rem',
                padding: '0.6rem 1rem', borderRadius: '10px',
                background: '#fff', border: `1px solid ${cfg.border}`,
                boxShadow: `0 4px 20px rgba(0,0,0,0.1), 0 0 0 1px ${cfg.border}`,
                minWidth: '240px', maxWidth: '340px',
                animation: 'slideInToast 0.22s ease',
                backdropFilter: 'blur(8px)',
              }}>
                <span style={{
                  width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0,
                  background: cfg.accent, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.72rem', fontWeight: 900,
                }}>
                  {cfg.icon}
                </span>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#111', lineHeight: 1.35 }}>
                  {toast.message}
                </span>
              </div>
            )
          })}
        </div>
      )}

    </div>
    </div>
  )
}
