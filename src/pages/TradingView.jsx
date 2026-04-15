import React, { useState, useEffect, useRef } from 'react'
import CandleChart from '../components/CandleChart'
import {
  Play, Square, TrendingUp, TrendingDown, Target,
  ShieldAlert, Activity, DollarSign, CheckCircle2, Layers, Zap, User
} from 'lucide-react'

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

const API = 'http://localhost:8000'
const INTERVAL_MAP = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1H': '1Hour', '4H': '4Hour', '1D': '1Day' }
// Bars to fetch per interval to cover ~2 trading days
const BARS_LIMIT = { '1m': 800, '5m': 200, '15m': 70, '1H': 20, '4H': 8, '1D': 5 }
// Polling interval per chart interval (ms) — no faster than 30s
const POLL_MS = { '1m': 30_000, '5m': 60_000, '15m': 120_000, '1H': 300_000, '4H': 300_000, '1D': 300_000 }
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
  const [barsLoading, setBarsLoading] = useState(false)
  const [tpPct, setTpPct]             = useState('2.0')
  const [slPct, setSlPct]             = useState('1.0')
  const [tradeActive, setTradeActive]     = useState(false)
  const [autoTrade, setAutoTrade]           = useState(false)
  const [lastTrade, setLastTrade]           = useState(null)
  const [hoveredSymbol, setHoveredSymbol]   = useState(null)
  const autoTimerRef       = useRef(null)
  const lastBarTimeRef     = useRef(null)  // tracks latest bar timestamp for incremental polling
  const suggestContractRef = useRef(null)  // stores latest contract_name from /api/options/suggest

  // Manual trade mode state
  const [tradeMode, setTradeMode]           = useState(() => localStorage.getItem('cape_tradeMode') || 'ai')  // 'ai' | 'manual'
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
  const [mktCountdown, setMktCountdown]       = useState('')
  const [toasts, setToasts]                   = useState([])
  const toastIdRef = useRef(0)
  const [livePositions, setLivePositions]     = useState([])
  const [histTimeFilter, setHistTimeFilter]   = useState('Today')

  // symbolMode: 'off' | 'auto' | 'manual' per symbol
  // Default to 'off' for all until backend sync resolves the correct per-symbol mode
  const [symbolMode, setSymbolMode] = useState(() =>
    Object.fromEntries(STOCK_SYMBOLS.map(s => [s.symbol, 'off']))
  )

  // On mount: sync all symbol modes from backend (backend always boots in 'auto')
  useEffect(() => {
    Promise.all(
      STOCK_SYMBOLS.map(s =>
        fetch(`${API}/api/symbol/mode?symbol=${s.symbol}`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    ).then(results => {
      const merged = {}
      results.forEach(r => { if (r?.symbol && r?.mode) merged[r.symbol] = r.mode })
      if (Object.keys(merged).length > 0)
        setSymbolMode(prev => ({ ...prev, ...merged }))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist tradeMode to localStorage
  useEffect(() => { localStorage.setItem('cape_tradeMode', tradeMode) }, [tradeMode])

  // Keep right-panel tradeMode in sync with the selected symbol's symbolMode
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
      await fetch(`${API}/api/symbol/mode`, {
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
            await fetch(`${API}/api/ai-trade/stop`, {
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
        const res = await fetch(`${API}/api/quotes?symbols=${symbols}`)
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
      await fetch(`${API}/api/orders`, {
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
      const res = await fetch(`${API}/api/positions/${selected.symbol}/close`, { method: 'POST' })
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

    try {
      // 1. Stop the AI monitoring thread for this symbol's underlying
      const underlying = symbol.replace(/\d{6}[CP]\d+$/i, '')
      if (underlying) {
        try {
          await fetch(`${API}/api/ai-trade/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: underlying }),
          })
        } catch (_) { /* best effort */ }
      }

      // 2. Close the position via Alpaca
      const res = await fetch(`${API}/api/positions/${encodeURIComponent(symbol)}/close`, {
        method: 'POST',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData?.detail || `Liquidation failed (${res.status})`)
      }
      const data = await res.json()

      if (data?.logged_trade) {
        setTradeHistory(prev => [{ ...data.logged_trade, _entryIso: data.logged_trade.entryTime || new Date().toISOString() }, ...prev])
      }

      setLivePositions(prev => prev.filter(p => p.symbol !== symbol))
      pushToast(`Liquidated ${symbol}`, 'success')
    } catch (err) {
      pushToast(`Failed to liquidate: ${err.message}`, 'error')
    }
  }

  // ── Full fetch: 2-day history whenever symbol or interval changes ────────
  useEffect(() => {
    const fetchBars = async () => {
      setBarsLoading(true)
      try {
        const tf    = INTERVAL_MAP[interval] || '5Min'
        const limit = BARS_LIMIT[interval]   || 200
        const res = await fetch(`${API}/api/bars?symbol=${selected.symbol}&timeframe=${tf}&limit=${limit}`)
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
        const res = await fetch(`${API}/api/bars?symbol=${selected.symbol}&timeframe=5Min&limit=5`)
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

  // ── Live open positions: poll Alpaca every 15 s ───────────────────────────
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res = await fetch(`${API}/api/positions`)
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
    const id = setInterval(fetchPositions, 15_000)
    return () => clearInterval(id)
  }, [])

  // ── Polling: append new bars as they arrive (no full re-fetch) ────────────
  useEffect(() => {
    const pollNewBars = async () => {
      try {
        const tf  = INTERVAL_MAP[interval] || '5Min'
        const limit = BARS_LIMIT[interval] || 200
        const res = await fetch(`${API}/api/bars?symbol=${selected.symbol}&timeframe=${tf}&limit=${limit}`)
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
        const posRes = await fetch(`${API}/api/positions`)
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
          fetch(`${API}/api/options-log?limit=500`),
          fetch(`${API}/api/manual-trades?limit=500`),
        ])
        const normalize = (t, type) => ({
          ...t,
          id: t.id || String(Date.now() + Math.random()),
          type,
          name: STOCK_SYMBOLS.find(s => s.symbol === t.symbol)?.name || t.symbol,
          contractName: t.contractName || t.symbol,
          strikePrice: t.strikePrice ?? '—',
          optionType: String(t.optionType || t.direction || '—').toLowerCase(),
          buyPrice: Number(t.buyPrice) || 0,
          sellPrice: Number(t.sellPrice) || 0,
          pnl: Number(t.pnl) || 0,
          entryTime: fmtEntryTime(t.entryTime),
          exitTime: fmtEntryTime(t.exitTime),
          _entryIso: t.entryTime || t.createdAt,
        })
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
        const normalize = (t, type) => ({
          ...t,
          id: t.id || String(Date.now() + Math.random()),
          type,
          name: STOCK_SYMBOLS.find(s => s.symbol === t.symbol)?.name || t.symbol,
          contractName: t.contractName || t.symbol,
          strikePrice: t.strikePrice ?? '—',
          optionType: String(t.optionType || t.direction || '—').toLowerCase(),
          buyPrice: Number(t.buyPrice) || 0,
          sellPrice: Number(t.sellPrice) || 0,
          pnl: Number(t.pnl) || 0,
          entryTime: fmtEntryTime(t.entryTime),
          exitTime: fmtEntryTime(t.exitTime),
          _entryIso: t.entryTime || t.createdAt,
        })
        const [optRes, manRes] = await Promise.allSettled([
          fetch(`${API}/api/options-log?limit=500`),
          fetch(`${API}/api/manual-trades?limit=500`),
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

  // Poll live contract price while a manual position is open
  useEffect(() => {
    if (!manualPosition?.contractSymbol) return
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/options/price?contract=${encodeURIComponent(manualPosition.contractSymbol)}`)
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

  // Poll order fill status after placing buy, until filled or timeout
  useEffect(() => {
    if (!manualPosition?.orderId || orderStatus === 'filled') return
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/orders/${manualPosition.orderId}/status`)
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
    if (!strikePrice || !expiry) return
    setOrderStatus('waiting')
    try {
      // Always fetch a fresh Alpaca-listed contract before placing a manual order.
      const sRes = await fetch(`${API}/api/options/suggest?symbol=${selected.symbol}`)
      if (!sRes.ok) throw new Error('Could not fetch contract — try clicking Refresh first')
      const sData = await sRes.json()
      if (!sData.contract_name) throw new Error('No listed contract available right now (market may be closed or contract unavailable)')

      const contractSymbol = sData.contract_name
      const resolvedStrike = String(sData.strike_price ?? strikePrice)
      const resolvedDirection = sData.direction ?? direction
      const resolvedOptionType = sData.option_type ?? optionType
      const resolvedExpiry = sData.expiry ?? expiry

      // Keep form + cache aligned to the exact contract we are about to trade.
      setStrikePrice(resolvedStrike)
      setDirection(resolvedDirection)
      setOptionType(resolvedOptionType)
      setExpiry(resolvedExpiry)
      suggestContractRef.current = contractSymbol

      const res = await fetch(`${API}/api/options/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_symbol: contractSymbol, qty: parseInt(qty) || 1 }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      const order = await res.json()
      const fillPrice = order.fill_price ?? null
      setOrderStatus(fillPrice != null ? 'filled' : 'waiting')
      setManualPosition({
        orderId: order.order_id,
        contractSymbol,
        strikePrice: resolvedStrike,
        direction: resolvedDirection,
        optionType: resolvedOptionType,
        expiry: resolvedExpiry,
        qty: parseInt(qty) || 1,
        fillPrice: fillPrice ?? 0,
        entryTime: cdtTime(),
      })
      if (fillPrice != null) setContractPrice(fillPrice)
      pushToast(`Manual Buy · ${contractSymbol.slice(0, 22)}`, 'success')
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
      try {
        // Close option position by contract symbol
        const sym = manualPosition.contractSymbol || selected.symbol
        const res = await fetch(`${API}/api/positions/${encodeURIComponent(sym)}/close`, { method: 'POST' })
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

      // Persist manual trade history row to backend MongoDB.
      try {
        await fetch(`${API}/api/manual-trades`, {
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
    setManualPosition(null)
    setContractPrice(0)
    setOrderStatus(null)
  }

  // ── Fetch backend-suggested contract for manual trade ──
  const fetchSuggest = async (sym) => {
    setSuggestLoading(true)
    try {
      const res = await fetch(`${API}/api/options/suggest?symbol=${sym || selected.symbol}`)
      if (res.ok) {
        const data = await res.json()
        setStrikePrice(String(data.strike_price ?? ''))
        setDirection(data.direction ?? 'uptrend')
        setOptionType(data.option_type ?? 'call')
        setExpiry(data.expiry ?? '')
        setQty(String(data.qty ?? 1))
        // Store contract symbol so Buy button can place real option order
        suggestContractRef.current = data.contract_name ?? null
      }
    } catch (_) {}
    setSuggestLoading(false)
  }

  // ── Switch trade mode; stop AI trade if one is active ──
  const handleSetTradeMode = async (mode) => {
    if (mode === tradeMode) return
    if (mode === 'manual' && tradeActive) {
      try {
        await fetch(`${API}/api/ai-trade/stop`, {
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
    setSymbolMode(prev => ({
      ...prev,
      [selected.symbol]: mode === 'ai' ? 'auto' : 'manual',
    }))
  }

  // Auto-fetch suggest on symbol/mode change, then refresh every 30 s while no open position
  useEffect(() => {
    if (manualPosition) return            // don't overwrite fields while a trade is open
    fetchSuggest(selected.symbol)
    const id = setInterval(() => {
      if (!manualPosition) fetchSuggest(selected.symbol)
    }, 30_000)
    return () => clearInterval(id)
  }, [tradeMode, selected.symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalVolume = candles.reduce((s, c) => s + (c.volume || 0), 0)

  const lastCandle = candles[candles.length - 1]
  const prevCandle = candles[candles.length - 2]
  const chartChange    = lastCandle && prevCandle ? lastCandle.close - prevCandle.close : 0
  const chartChangePct = prevCandle ? ((chartChange / prevCandle.close) * 100).toFixed(2) : '0.00'

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
                    return (
                      <button
                        key={opt.val}
                        onClick={e => setSymbolModeFor(stock.symbol, opt.val, e)}
                        style={{
                          flex: 1, padding: '0.28rem 0.18rem',
                          borderRadius: '999px', border: 'none', cursor: 'pointer',
                          fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.04em',
                          transition: 'all 0.2s',
                          background: active ? opt.activeBg : 'transparent',
                          color: active
                            ? opt.val === 'off' ? '#777' : '#fff'
                            : 'rgba(160,124,16,0.6)',
                          boxShadow: active && opt.val !== 'off' ? `0 0 5px ${opt.activeShadow}` : 'none',
                        }}
                      >
                        {opt.label}
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
            </div>
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
          </div>

          <CandleChart
            data={candles}
            obrLines={obrLevels}
            rsiPoints={rsiPoints}
            rsiMaPoints={rsiMaPoints}
            rsiMarkers={rsiMarkers}
            fitKey={selected.symbol + '_' + interval}
          />
        </div>

        {/* ── Live Open Positions for selected symbol ── */}
        {(() => {
          const symPositions = livePositions.filter(p =>
            p.symbol && p.symbol.startsWith(selected.symbol)
          )
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
                <span style={{ fontSize: '0.7rem', color: '#bbb', fontWeight: 600 }}>Live · updates every 15 s</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.85rem', padding: '1rem 1.5rem' }}>
                {symPositions.map((p, i) => {
                  const uPl    = Number(p.unrealized_pl)    || 0
                  const uPlPct = Number(p.unrealized_plpc)  || 0
                  const isPos  = uPl >= 0
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
                        { k: 'Side',         v: <span style={{ fontWeight: 800, color: p.side === 'long' ? '#16a34a' : '#ef4444', textTransform: 'uppercase' }}>{p.side}</span> },
                        { k: 'Qty',          v: p.qty },
                        { k: 'Entry Time',   v: fmtEntryTime(p.entry_time) },
                        { k: 'Entry Price',  v: `$${fmt(p.avg_entry_price)}` },
                        { k: 'Current',      v: <span style={{ fontWeight: 800 }}>${fmt(p.current_price)}</span> },
                        { k: 'Unrealized P&L', v: <span style={{ fontWeight: 900, color: isPos ? '#16a34a' : '#ef4444' }}>{isPos ? '+' : ''}${fmt(uPl)} ({(uPlPct * 100).toFixed(2)}%)</span> },
                      ].map(({k, v}) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.25rem 0', borderBottom: '1px solid rgba(0,0,0,0.04)', fontSize: '0.78rem' }}>
                          <span style={{ color: '#aaa', fontWeight: 600 }}>{k}</span>
                          <span style={{ color: '#111', fontWeight: 700 }}>{v}</span>
                        </div>
                      ))}
                      <div style={{ marginTop: '0.65rem', display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => handleLiquidatePosition(p.symbol)}
                          style={{
                            padding: '0.35rem 0.7rem',
                            borderRadius: '8px',
                            border: '1px solid rgba(239,68,68,0.35)',
                            background: 'rgba(239,68,68,0.08)',
                            color: '#ef4444',
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            cursor: 'pointer',
                          }}
                        >
                          Liquidate
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
          const symbolHistory = tradeHistory.filter(t => t.symbol === selected.symbol)

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
          const filteredHistory = cutoff
            ? symbolHistory.filter(t => {
                const d = new Date(t._entryIso || t.entryTime || t.exitTime || 0)
                return !isNaN(d) && d >= cutoff
              })
            : symbolHistory

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
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '420px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
                <thead>
                  <tr style={{ background: 'rgba(201,162,39,0.04)' }}>
                    {['#', 'Contract', 'Type', 'Strike', 'Buy Price', 'Sell Price', 'P&L', 'Result', 'Reason', 'Entry', 'Exit'].map(h => (
                      <th key={h} style={{
                        padding: '0.55rem 0.75rem', textAlign: 'left', fontWeight: 700, color: '#999',
                        fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.06em',
                        borderBottom: '1px solid rgba(0,0,0,0.05)', whiteSpace: 'nowrap',
                        position: 'sticky', top: 0, background: 'rgba(252,248,240,1)', zIndex: 1,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((t, i) => (
                    <tr key={t.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.03)', background: i % 2 === 0 ? '#fff' : 'rgba(201,162,39,0.015)' }}>
                      <td style={{ padding: '0.6rem 0.75rem', color: '#bbb', fontWeight: 600 }}>{filteredHistory.length - i}</td>
                      <td style={{ padding: '0.6rem 0.75rem', color: GOLD_DEEP, fontWeight: 700, whiteSpace: 'nowrap', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={t.contractName}>{t.contractName}</td>
                      <td style={{ padding: '0.6rem 0.75rem', whiteSpace: 'nowrap' }}>
                        <span style={{
                          padding: '0.15rem 0.45rem', borderRadius: '20px', fontWeight: 700, fontSize: '0.65rem',
                          background: t.optionType === 'call' ? 'rgba(22,163,74,0.1)' : t.optionType === 'put' ? 'rgba(239,68,68,0.08)' : 'rgba(201,162,39,0.08)',
                          color: t.optionType === 'call' ? '#16a34a' : t.optionType === 'put' ? '#ef4444' : GOLD_DEEP,
                        }}>{t.optionType !== '—' ? t.optionType.toUpperCase() : t.type.toUpperCase()}</span>
                      </td>
                      <td style={{ padding: '0.6rem 0.75rem', fontWeight: 700, color: '#111' }}>
                        {t.strikePrice !== '—' ? `$${fmt(+t.strikePrice)}` : '—'}
                      </td>
                      <td style={{ padding: '0.6rem 0.75rem', fontWeight: 700, color: '#555' }}>${fmt(t.buyPrice)}</td>
                      <td style={{ padding: '0.6rem 0.75rem', fontWeight: 700, color: '#555' }}>${fmt(t.sellPrice)}</td>
                      <td style={{ padding: '0.6rem 0.75rem', fontWeight: 800, color: t.pnl >= 0 ? '#16a34a' : '#ef4444', whiteSpace: 'nowrap' }}>
                        {t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}
                      </td>
                      <td style={{ padding: '0.6rem 0.75rem' }}>
                        <span style={{
                          padding: '0.2rem 0.55rem', borderRadius: '2px', fontWeight: 800, fontSize: '0.67rem',
                          background: t.result === 'WIN' ? 'rgba(22,163,74,0.12)' : 'rgba(239,68,68,0.1)',
                          color: t.result === 'WIN' ? '#16a34a' : '#ef4444',
                        }}>{t.result === 'WIN' ? 'WIN' : 'LOSS'}</span>
                      </td>
                      <td style={{ padding: '0.6rem 0.75rem', color: '#777', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {String(t.exitReason || t.exit_reason || '—').replace(/_/g, ' ')}
                      </td>
                      <td style={{ padding: '0.6rem 0.75rem', color: '#aaa', fontWeight: 500, whiteSpace: 'nowrap' }}>{t.entryTime}</td>
                      <td style={{ padding: '0.6rem 0.75rem', color: '#aaa', fontWeight: 500, whiteSpace: 'nowrap' }}>{t.exitTime}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
          )
        })()}
      </div>

      {/* RIGHT: Config Panel */}
      <div className="no-scroll-panel" style={{ width: '254px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1rem', position: 'sticky', top: '90px', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', paddingRight: '2px', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <style>{`.no-scroll-panel::-webkit-scrollbar { display: none; }`}</style>

        {/* AI Trade / Manual Trade Toggle */}
        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: '12px', padding: '4px', border: '1px solid rgba(201,162,39,0.15)', flexShrink: 0 }}>
          <button
            onClick={() => handleSetTradeMode('ai')}
            style={{
              flex: 1, padding: '0.55rem 0.5rem', borderRadius: '9px', border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
              transition: 'all 0.2s',
              background: tradeMode === 'ai' ? `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)` : 'transparent',
              color: tradeMode === 'ai' ? '#111' : '#999',
              boxShadow: tradeMode === 'ai' ? '0 2px 8px rgba(201,162,39,0.3)' : 'none',
            }}
          >
            <Zap size={13} fill={tradeMode === 'ai' ? '#111' : 'none'} />
            AI Trade
          </button>
          <button
            onClick={() => handleSetTradeMode('manual')}
            style={{
              flex: 1, padding: '0.55rem 0.5rem', borderRadius: '9px', border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
              transition: 'all 0.2s',
              background: tradeMode === 'manual' ? '#fff' : 'transparent',
              color: tradeMode === 'manual' ? '#111' : '#999',
              boxShadow: tradeMode === 'manual' ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            <User size={13} />
            Manual Trade
          </button>
        </div>

        {/* ── MANUAL TRADE SECTION ── always visible; Buy/Sell hidden in AI mode */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Manual Trade Form */}
          <div style={{ background: '#fff', border: '1px solid rgba(201,162,39,0.15)', borderRadius: '14px', padding: '1.25rem', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#111', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <User size={13} color={GOLD_DEEP} /> Trade Setup
              {suggestLoading && (
                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: GOLD_DEEP, fontWeight: 600 }}>loading...</span>
              )}
              {!suggestLoading && !manualPosition && (
                <button onClick={() => fetchSuggest(selected.symbol)} style={{
                  marginLeft: 'auto', padding: '0.2rem 0.5rem', borderRadius: '6px', border: `1px solid rgba(201,162,39,0.3)`,
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
                  type="number" placeholder="e.g. 185"
                  value={strikePrice}
                  disabled={!!manualPosition}
                  onChange={e => setStrikePrice(e.target.value)}
                  style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: '0.88rem', fontWeight: 700, color: '#111', minWidth: 0 }}
                />
              </div>
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
                  <button key={opt.val} onClick={() => setOptionType(opt.val)} disabled={!!manualPosition} style={{
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

            {/* Buy / Sell Button — hidden in AI mode */}
            {tradeMode !== 'ai' && <button
              onClick={manualPosition ? handleSell : handleBuy}
              disabled={orderStatus === 'waiting' || orderStatus === 'selling' || (!manualPosition && (!strikePrice || !expiry))}
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
          </div>

          {/* Contract Tracker */}
          {(() => {
            // Fall back to livePositions for the selected symbol when no manualPosition is active
            const livePos = livePositions.find(p => p.symbol?.startsWith(selected.symbol))
            const trackedPos = manualPosition || (livePos ? {
              contractSymbol: livePos.symbol,
              fillPrice: Number(livePos.avg_entry_price) || 0,
              qty: Number(livePos.qty) || 1,
            } : null)
            const trackedPrice = manualPosition ? contractPrice : (livePos ? Number(livePos.current_price) || 0 : 0)
            const trackedPnl = trackedPos ? (trackedPrice - trackedPos.fillPrice) * trackedPos.qty * 100 : 0

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
  )
}
