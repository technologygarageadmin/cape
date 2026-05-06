import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  TrendingUp, TrendingDown, DollarSign, BarChart3,
  RefreshCw, Filter, Activity, Layers, ChevronDown,
  Circle, ArrowUpRight, ArrowDownRight, Clock, Zap,
  Target, Percent,
} from 'lucide-react'

const API_TRADING = 'http://localhost:8001'
const API_DISPLAY = 'http://localhost:8002'
const GOLD      = '#C9A227'
const GOLD_DEEP = '#A07C10'
const GOLD_LIGHT = '#F5C518'

const SYMBOLS = ['ALL','SPY','QQQ','AAPL','MSFT','NVDA','AMZN','META','TSLA','GOOGL','AMD','NFLX','AVGO']
const DATE_FILTERS  = ['1H','3H','TODAY','YESTERDAY','WEEK','MONTH','ALL TIME','CUSTOM']
const HOUR_FILTERS  = [
  { key: 'ALL',         label: 'All Hours',   range: null },
  { key: 'OPEN_HOUR',   label: '8:30–9:30',   range: '8:30 – 9:30 CT' },
  { key: 'SECOND_HOUR', label: '9:30–10:30',  range: '9:30 – 10:30 CT' },
  { key: 'THIRD_HOUR',  label: '10:30–11:30', range: '10:30 – 11:30 CT' },
  { key: 'FOURTH_HOUR', label: '11:30–12:30', range: '11:30 – 12:30 CT' },
  { key: 'FIFTH_HOUR',  label: '12:30–1:30',  range: '12:30 – 1:30 CT' },
  { key: 'LAST_SLOT',   label: '1:30–3:00',   range: '1:30 – 3:00 CT' },
  { key: 'MARKET',      label: 'Full Day',     range: '8:30 – 3:00 CT' },
]
const RESULT_FILTERS = ['ALL','WIN','LOSS']
const TYPE_FILTERS = ['ALL','AIT','MANUAL']

// ── helpers ────────────────────────────────────────────────────────────────
const fmt2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtPnl = (n) => {
  const v = Number(n) || 0
  return (v >= 0 ? '+$' : '-$') + fmt2(Math.abs(v))
}

const fmtPctSigned = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`

function playAlertDing() {
  if (typeof window === 'undefined') return
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return

    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24)
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(900, now)
    osc.frequency.linearRampToValueAtTime(1300, now + 0.12)
    osc.connect(gain)
    osc.start(now)
    osc.stop(now + 0.25)
    osc.onended = () => {
      try { ctx.close() } catch (_) {}
    }
  } catch (_) {
    // Ignore browser autoplay/audio-context restrictions.
  }
}

// cfg = { qpGapPct, stopLossPct, takeProfitPct } — from /api/config
// Dynamic QP: starts at 0%, locks in at (peak - qpGapPct), never steps down.
function calcExitSnapshot(currentPct, cfg = {}) {
  const tpPct     = cfg.takeProfitPct  ?? 10
  const baseSlPct = -(cfg.stopLossPct  ?? 5)
  const qpGap     = cfg.qpGapPct       ?? 0.25
  const slPct = Math.max(baseSlPct, currentPct + baseSlPct)
  const qpPct = currentPct > 0 ? Math.max(0, currentPct - qpGap) : 0
  return { tpPct, slPct, qpPct }
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function tradeExitSnapshotText(trade, cfg = {}) {
  const peak = toNum(trade.peakPnlPct ?? trade.peak_pnl_pct)
  if (peak == null) return '—'
  const snap = calcExitSnapshot(peak, cfg)
  return `Peak ${fmtPctSigned(peak)} -> SL ${fmtPctSigned(snap.slPct)}, QP ${fmtPctSigned(snap.qpPct)}`
}

// Parse Alpaca option contract symbol e.g. TSLA260406C00362500
function parseOptionSymbol(sym) {
  const m = String(sym).match(/^([A-Z]{1,5})(\d{2})(\d{2})(\d{2})([CP])(\d+)$/)
  if (!m) return null
  const [, underlying, yy, mm, dd, optType, strikeRaw] = m
  return {
    underlying,
    expiry: `${mm}/${dd}/20${yy}`,
    optType: optType === 'C' ? 'CALL' : 'PUT',
    strike: `$${(Number(strikeRaw) / 1000).toFixed(2)}`,
  }
}

function normalizeOptionType(rawOptionType, rawDirection, contractName, symbol) {
  const type = String(rawOptionType || '').trim().toUpperCase()
  if (type === 'CALL' || type === 'PUT') return type.toLowerCase()

  const dir = String(rawDirection || '').trim().toUpperCase()
  if (dir === 'CALL' || dir === 'PUT') return dir.toLowerCase()
  if (dir === 'UPTREND') return 'call'
  if (dir === 'DOWNTREND') return 'put'

  const fromContract = parseOptionSymbol(contractName || '') || parseOptionSymbol(symbol || '')
  if (fromContract?.optType === 'CALL') return 'call'
  if (fromContract?.optType === 'PUT') return 'put'

  return '—'
}

function cleanSide(raw) {
  if (!raw) return '—'
  return String(raw).replace(/^positionside\./i, '').toUpperCase()
}

function positionAlertKey(position) {
  const buyOrderId = String(position?.buy_order_id || '').trim()
  if (buyOrderId) return `BUY:${buyOrderId}`

  const parts = [
    String(position?.contract_symbol || '').trim(),
    String(position?.symbol || '').trim(),
    String(position?.entry_time || '').trim(),
    String(position?.qty ?? '').trim(),
    String(position?.side || '').trim(),
  ].filter(Boolean)

  return parts.length ? parts.join('|') : ''
}

function startOfDay(dStr) {
  // Returns midnight CDT for the given date string
  const d = new Date(dStr)
  const cdtMidnight = new Date(d.toLocaleDateString('en-US', { timeZone: 'America/Chicago' }))
  return cdtMidnight
}

function parseApiDate(rawValue) {
  if (!rawValue) return null

  const raw = String(rawValue).trim()
  if (!raw) return null

  let d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d

  // Legacy backend rows may send ISO-like strings without timezone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) {
    d = new Date(`${raw}Z`)
    if (!Number.isNaN(d.getTime())) return d
  }

  return null
}

function cdtDateKey(dateObj) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(dateObj)
}

// Returns minutes-since-midnight in Chicago time for a given Date.
// Accepts any Date with a correct UTC value — Intl handles CT conversion.
function ctMinutes(d) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, x) => { if (x.type !== 'literal') acc[x.type] = x.value; return acc }, {})
    return parseInt(p.hour || '0', 10) * 60 + parseInt(p.minute || '0', 10)
  } catch { return -1 }
}

// Format a Date as CT date label (e.g. "Wed, May 7, 2026") for display.
function fmtCtDate(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(d)
}

const MARKET_OPEN  = 8 * 60 + 30   // 8:30 CT
const MARKET_CLOSE = 15 * 60        // 15:00 CT

function isWithinRange(dateStr, range, customFrom, customTo) {
  if (!dateStr || range === 'ALL TIME') return true
  const d = parseApiDate(dateStr)
  if (!d) return true

  // Use Date.now() / new Date() — always correct UTC regardless of browser timezone.
  // cdtDateKey and ctMinutes both use Intl with timeZone:'America/Chicago' so they
  // convert correctly from any UTC value.
  if (range === '1H') return d >= new Date(Date.now() - 60 * 60 * 1000)
  if (range === '3H') return d >= new Date(Date.now() - 3 * 60 * 60 * 1000)

  const now = new Date()   // correct UTC — Intl does CT conversion

  if (range === 'TODAY') {
    if (cdtDateKey(d) !== cdtDateKey(now)) return false
    const m = ctMinutes(d)
    return m >= MARKET_OPEN && m <= MARKET_CLOSE
  }
  if (range === 'YESTERDAY') {
    const yesterday = new Date(Date.now() - 86400000)  // exactly 24h ago in UTC
    if (cdtDateKey(d) !== cdtDateKey(yesterday)) return false
    const m = ctMinutes(d)
    return m >= MARKET_OPEN && m <= MARKET_CLOSE
  }
  if (range === 'WEEK')  return d >= new Date(Date.now() - 7  * 86400000)
  if (range === 'MONTH') return d >= new Date(Date.now() - 30 * 86400000)
  if (range === 'CUSTOM') {
    if (customFrom && d < new Date(customFrom)) return false
    if (customTo   && d > new Date(customTo))   return false
    return true
  }
  return true
}

function isWithinHours(dateStr, hourFilter) {
  if (!hourFilter || hourFilter === 'ALL') return true
  const d = parseApiDate(dateStr)
  if (!d) return true
  const m = ctMinutes(d)
  if (m < 0) return true
  if (hourFilter === 'OPEN_HOUR')   return m >= (8*60+30)  && m <  (9*60+30)
  if (hourFilter === 'SECOND_HOUR') return m >= (9*60+30)  && m <  (10*60+30)
  if (hourFilter === 'THIRD_HOUR')  return m >= (10*60+30) && m <  (11*60+30)
  if (hourFilter === 'FOURTH_HOUR') return m >= (11*60+30) && m <  (12*60+30)
  if (hourFilter === 'FIFTH_HOUR')  return m >= (12*60+30) && m <  (13*60+30)
  if (hourFilter === 'LAST_SLOT')   return m >= (13*60+30) && m <= (15*60)
  if (hourFilter === 'MARKET')      return m >= (8*60+30)  && m <= (15*60)
  return true
}

function reasonLabel(raw) {
  if (!raw) return ''
  return String(raw).replace(/_/g, ' ').trim()
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(v => v != null && String(v).trim())
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean)
  }
  return []
}

function strategyLabelFromId(id) {
  return String(id || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function resolveEntryStrategyNames(trade) {
  const explicit = asList(trade?.entryStrategyNames ?? trade?.entry_strategy_names)
  if (explicit.length > 0) return explicit
  const ids = asList(trade?.entryStrategies ?? trade?.entry_strategies)
  if (ids.length > 0) return ids.map(strategyLabelFromId)
  return []
}

function entryReasonMeaning(raw) {
  const key = String(raw || '').toUpperCase().trim()
  const map = {
    STRADDLE: 'Entered as a paired call and put setup.',
    AIT: 'Entered from RSI crossover signal logic.',
    MANUAL: 'Entered manually by user action.',
  }
  return map[key] || 'Entered by strategy trigger.'
}

function exitReasonMeaning(raw) {
  const text = String(raw || '').toUpperCase().trim()
  if (!text) return ''
  if (text.includes('SAME_CANDLE_POSITIVE_SIGNAL_SLIPPAGE_EXIT')) return 'Positive exit signal was detected, but fast move/liquidity caused a worse fill.'
  if (text.includes('BAD_ENTRY')) return 'Exited early — bad entry detected (low peak after window).'
  if (text.includes('MAX_HOLD_TIME')) return 'Exited — max hold time reached with small PnL.'
  if (text.includes('MOMENTUM_STALL')) return 'Exited — RSI momentum flipped against signal.'
  if (text.includes('TRAILING') || text.includes('TRAIL')) return 'Closed by trailing stop protection.'
  if (text.includes('BREAKEVEN')) return 'Closed at breakeven trigger level.'
  if (text.includes('STOP') || text.includes('SL')) return 'Closed to limit downside risk.'
  if (text.includes('TAKE_PROFIT') || text.includes('TP')) return 'Closed at configured profit target.'
  if (text.includes('QUICK_PROFIT') || text.includes('QP')) return 'Closed to lock in quick gains.'
  if (text.includes('MONITOR_EXIT')) return 'Closed by dynamic monitor condition.'
  if (text.includes('MANUAL')) return 'Closed manually by user action.'
  if (text.includes('LIQUIDAT')) return 'Closed by forced liquidation handling.'
  if (text.includes('TIME')) return 'Closed due to time-based rule.'
  return 'Closed by strategy exit rule.'
}

function fmtDuration(sec) {
  if (sec == null) return null
  const s = Math.abs(Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remaining = s % 60
  if (m < 60) return remaining > 0 ? `${m}m ${remaining}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

// ── TradeTimeline component ────────────────────────────────────────────────
const CDT_LABEL = 'America/Chicago'
function fmtTickTime(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return isNaN(d) ? ts : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: CDT_LABEL })
  } catch { return ts }
}

function TradeTimeline({ timeline, fillPrice, qpArmed, qpArmTime, qpArmPrice, qpArmPnlPct, buyFilledTime, sellFilledTime }) {
  const [open, setOpen] = useState(false)
  if (!timeline || timeline.length === 0) return null

  const ticks = timeline

  // price ticks only (exclude order_placed rows which have no sellable_price)
  const priceTicks = ticks.filter(t => t.source !== 'order_placed' && t.sellable_price != null)

  // price domain for mini sparkline
  const prices = priceTicks.map(t => t.sellable_price).filter(Boolean)
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const range = maxP - minP || 0.01
  const W = 260, H = 50

  const pts = priceTicks.map((t, idx) => {
    const x = (idx / Math.max(priceTicks.length - 1, 1)) * W
    const y = H - ((t.sellable_price - minP) / range) * (H - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  // find QP arm index in price ticks only
  const qpArmIdx = qpArmTime
    ? priceTicks.findIndex(t => t.ts >= qpArmTime)
    : -1

  const peakIdx = priceTicks.reduce((best, t, idx) => t.pnl_pct > (priceTicks[best]?.pnl_pct ?? -Infinity) ? idx : best, 0)

  return (
    <div style={{ marginTop: '8px', borderTop: '1px solid rgba(201,162,39,0.12)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '5px 0', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: '11px', fontWeight: 700, color: '#bbb', width: '100%',
        }}
      >
        <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 800 }}>
          {open ? '▲' : '▼'} Tick Timeline
        </span>
        <span style={{ color: '#ccc', fontWeight: 500 }}>({priceTicks.length} ticks{ticks.length > priceTicks.length ? ` · ${ticks.length - priceTicks.length} orders` : ''})</span>
        {qpArmed && (
          <span style={{
            padding: '1px 6px', borderRadius: '4px',
            background: 'rgba(217,119,6,0.1)', color: '#d97706',
            fontSize: '9px', fontWeight: 800, textTransform: 'uppercase',
          }}>QP Armed</span>
        )}
      </button>

      {open && (
        <div style={{ paddingBottom: '10px' }}>
          {/* Sparkline */}
          <div style={{
            background: 'var(--bg)', borderRadius: '8px', padding: '8px',
            marginBottom: '8px', border: '1px solid rgba(0,0,0,0.05)',
            position: 'relative',
          }}>
            <div style={{ fontSize: '9px', fontWeight: 800, color: '#ccc', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.5px' }}>
              Price Journey — entry ${fmt2(fillPrice)}
            </div>
            <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
              {/* zero / entry line */}
              {fillPrice && minP != null && (
                <line
                  x1={0} x2={W}
                  y1={H - ((fillPrice - minP) / range) * (H - 4) - 2}
                  y2={H - ((fillPrice - minP) / range) * (H - 4) - 2}
                  stroke="rgba(0,0,0,0.1)" strokeWidth="1" strokeDasharray="3,3"
                />
              )}
              {/* price line */}
              <polyline
                points={pts}
                fill="none"
                stroke={priceTicks[priceTicks.length - 1]?.pnl_pct >= 0 ? '#16a34a' : '#ef4444'}
                strokeWidth="1.5"
              />
              {/* QP arm dot */}
              {qpArmIdx >= 0 && (() => {
                const t = priceTicks[qpArmIdx]
                const x = (qpArmIdx / Math.max(priceTicks.length - 1, 1)) * W
                const y = H - ((t.sellable_price - minP) / range) * (H - 4) - 2
                return (
                  <g>
                    <circle cx={x} cy={y} r={5} fill="#d97706" stroke="#fff" strokeWidth="1.5" />
                    <text x={x + 7} y={y + 4} fontSize="8" fill="#d97706" fontWeight="800">QP ARM</text>
                  </g>
                )
              })()}
              {/* Peak dot */}
              {(() => {
                const t = priceTicks[peakIdx]
                const x = (peakIdx / Math.max(priceTicks.length - 1, 1)) * W
                const y = H - ((t.sellable_price - minP) / range) * (H - 4) - 2
                return (
                  <g>
                    <circle cx={x} cy={y} r={4} fill="#6366f1" stroke="#fff" strokeWidth="1.5" />
                    <text x={x + 6} y={y - 3} fontSize="8" fill="#6366f1" fontWeight="800">PEAK</text>
                  </g>
                )
              })()}
            </svg>
            {/* Price range labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#bbb', marginTop: '2px' }}>
              <span>${fmt2(minP)}</span>
              <span>${fmt2(maxP)}</span>
            </div>
          </div>

          {/* QP arm detail row */}
          {qpArmed && qpArmTime && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
              padding: '5px 8px', borderRadius: '6px',
              background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.15)',
              marginBottom: '6px',
            }}>
              <span style={{ fontSize: '9px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.4px' }}>QP Armed At</span>
              <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 700, color: '#92400e' }}>{fmtTickTime(qpArmTime)}</span>
              {qpArmPrice != null && (
                <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 700, color: '#92400e' }}>${fmt2(qpArmPrice)}</span>
              )}
              {qpArmPnlPct != null && (
                <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 700, color: '#d97706' }}>{fmtPctSigned(qpArmPnlPct)}</span>
              )}
            </div>
          )}

          {/* Tick table — capped at 200 rows to avoid DOM overload */}
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '240px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px', minWidth: '480px' }}>
              <thead>
                <tr style={{ background: 'var(--card-bg)', position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Time', 'Src', 'Sellable', 'Bid', 'Mid', 'PnL%', 'QP Lmt', 'QP Dyn%', 'Trailing SL Dyn', 'Peak', 'Peak Px', 'TP', 'SL Action', 'SL Update', 'Armed', 'Orders'].map(h => (
                    <th key={h} style={{ padding: '3px 6px', textAlign: 'left', fontWeight: 800, color: '#bbb', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const ticksToShow = ticks.length > 100
                    ? [
                        ...ticks.slice(0, 50).map((t, i) => ({ ...t, __idx: i })),
                        { __separator: true, hidden: ticks.length - 100 },
                        ...ticks.slice(-50).map((t, i) => ({ ...t, __idx: ticks.length - 50 + i })),
                      ]
                    : ticks.map((t, i) => ({ ...t, __idx: i }))
                  return ticksToShow.map((tick, idx) => {
                    if (tick.__separator) {
                      return (
                        <tr key="sep">
                          <td colSpan={16} style={{
                            padding: '6px 10px', textAlign: 'center',
                            color: '#d97706', fontSize: '10px', fontWeight: 700,
                            background: 'rgba(217,119,6,0.06)',
                            border: '1px dashed rgba(217,119,6,0.25)',
                          }}>
                            ··· {tick.hidden} ticks in the middle not shown — first 50 + last 50 shown ···
                          </td>
                        </tr>
                      )
                    }
                  const isArm = qpArmIdx === tick.__idx
                  const isPeak = peakIdx === tick.__idx
                  const isEntry = tick.source === 'entry'
                  const isSell = tick.source === 'sell'
                  const isExitFilled = tick.source === 'exit_filled'
                  const isOrder = tick.source === 'order_placed' || tick.source === 'order_replaced'

                  if (isExitFilled) {
                    const isProfit = tick.order_type === 'TP_LIMIT'
                    const rowColor = isProfit ? '#16a34a' : '#ef4444'
                    const rowBg = isProfit ? 'rgba(22,163,74,0.10)' : 'rgba(239,68,68,0.10)'
                    return (
                      <tr key={idx} style={{ background: rowBg, fontWeight: 700, borderLeft: `3px solid ${rowColor}` }}>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                        <td style={{ padding: '2px 6px', color: rowColor, fontSize: '9px', fontWeight: 800, textTransform: 'uppercase' }}>EXIT_FILLED</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: rowColor, fontWeight: 700 }}>
                          {tick.fill_price != null ? `$${fmt2(tick.fill_price)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>
                          {tick.triggered_at ? `trig@${fmtTickTime(tick.triggered_at)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>{tick.order_type || '—'}</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>—</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: rowColor, fontWeight: 700 }}>EXECUTED</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap', fontSize: '9px' }}>
                          {`${String(tick.order_id || '').slice(0, 8)}… · filled@${fmtTickTime(tick.filled_at)}`}
                        </td>
                        <td style={{ padding: '2px 6px', textAlign: 'center' }}>
                          <span style={{ color: rowColor, fontSize: '10px' }}>{isProfit ? '✓' : '✕'}</span>
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: rowColor, fontSize: '9px', fontWeight: 700 }}>
                          {tick.exit_reason || '—'}
                        </td>
                      </tr>
                    )
                  }

                  if (isOrder) {
                    const isQP = tick.order_type === 'QP_LIMIT'
                    const isSL = tick.order_type === 'SL_STOP'
                    const isTrail = tick.order_type === 'TRAIL_SL_STOP'
                    const isReplace = tick.source === 'order_replaced'
                    const status = tick.status || 'live'
                    const isError = status === 'error'
                    const statusAt = tick.status_at || tick.filled_at || tick.canceled_at || tick.updated_at || tick.submitted_at || tick.ts
                    const placedAt = tick.submitted_at || tick.ts
                    const filledAt = tick.filled_at || null
                    const cancelledAt = tick.canceled_at || null
                    const statusColor = status === 'filled' ? '#16a34a' : status === 'cancelled' ? '#aaa' : isError ? '#dc2626' : '#d97706'
                    const statusIcon = status === 'filled' ? '✓ FILLED' : status === 'cancelled' ? '✕ CANCELLED' : isError ? '✕ FAILED' : '⏳ LIVE'
                    const rowBg = status === 'filled' ? 'rgba(22,163,74,0.08)' : status === 'cancelled' ? 'rgba(0,0,0,0.03)' : isError ? 'rgba(220,38,38,0.08)' : isQP ? 'rgba(217,119,6,0.05)' : 'rgba(239,68,68,0.05)'
                    const typeLabel = isReplace ? 'ORDER_REPLACED' : (isQP ? 'QP LIMIT' : isTrail ? 'TRAIL SL STOP' : 'SL STOP')
                    const typeColor = isQP ? '#d97706' : '#ef4444'
                    const orderCountText = tick.order_count != null ? `#${tick.order_count}` : '#—'
                    const statusTimeText = `status @ ${fmtTickTime(statusAt)}`
                    const placedTimeText = `placed ${fmtTickTime(placedAt)}`
                    const filledTimeText = filledAt ? `filled ${fmtTickTime(filledAt)}` : null
                    const cancelledTimeText = cancelledAt ? `cancelled ${fmtTickTime(cancelledAt)}` : null
                    const timeAuditText = [placedTimeText, statusTimeText, filledTimeText, cancelledTimeText].filter(Boolean).join(' · ')
                    return (
                      <tr key={idx} style={{ background: rowBg, borderLeft: `3px solid ${isError ? '#dc2626' : typeColor}` }}>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                        <td style={{ padding: '2px 6px', color: isError ? '#dc2626' : typeColor, fontSize: '9px', fontWeight: 800, textTransform: 'uppercase' }}>{typeLabel}</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: typeColor, fontWeight: 700 }}>
                          {tick.fill_price != null ? `$${fmt2(tick.fill_price)}` : (tick.limit_price != null ? `$${fmt2(tick.limit_price)}` : '—')}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>
                          {tick.stop_price != null ? `stop $${fmt2(tick.stop_price)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>
                          {tick.limit_price != null ? `lmt $${fmt2(tick.limit_price)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: typeColor }}>{fmtPctSigned(tick.pct)}</td>
                        <td colSpan={8} style={{ padding: '2px 6px', fontFamily: 'monospace', fontSize: '9px', color: statusColor, fontWeight: 700 }}>
                          {isError
                            ? `✕ FAILED · ${tick.error || 'unknown error'}`
                            : `${statusIcon} · ${orderCountText} · id ${(tick.order_id || '').slice(0, 8)}… · ${timeAuditText}`
                          }
                        </td>
                        <td />
                        <td />
                      </tr>
                    )
                  }

                  const rowBg = isSell ? 'rgba(239,68,68,0.10)' : isArm ? 'rgba(217,119,6,0.08)' : isPeak ? 'rgba(99,102,241,0.06)' : isEntry ? 'rgba(22,163,74,0.05)' : idx % 2 === 0 ? '#fff' : '#fafafa'
                  const pnlColor = tick.pnl_pct > 0 ? '#16a34a' : tick.pnl_pct < 0 ? '#ef4444' : '#888'
                  const srcLabel = isSell ? (tick.exit_reason || 'SELL') : tick.source
                  const srcColor = isSell ? '#ef4444' : '#aaa'
                  const fillPx = Number(tick.fill_price)
                  const peakPct = Number(tick.max_pnl_pct)
                  const peakPrice = Number.isFinite(fillPx) && Number.isFinite(peakPct)
                    ? fillPx * (1 + peakPct / 100)
                    : null
                  return (
                    <tr key={idx} style={{ background: rowBg, fontWeight: isSell ? 700 : undefined }}>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                      <td style={{ padding: '2px 6px', color: srcColor, textTransform: 'uppercase', fontSize: '9px', fontWeight: 700 }}>{srcLabel}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', fontWeight: 700, color: isSell ? '#ef4444' : 'var(--text-h)' }}>${fmt2(tick.sellable_price)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>{tick.bid_price != null ? `$${fmt2(tick.bid_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)' }}>{tick.mid_price != null ? `$${fmt2(tick.mid_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', fontWeight: 800, color: pnlColor }}>{fmtPctSigned(tick.pnl_pct)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#d97706' }}>{tick.qp_limit_price != null ? `$${fmt2(tick.qp_limit_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#d97706' }}>{tick.qp_dynamic_pct > 0 ? fmtPctSigned(tick.qp_dynamic_pct) : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#ef4444' }}>{fmtPctSigned(tick.sl_dynamic_pct)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#6366f1' }}>{fmtPctSigned(tick.max_pnl_pct)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#6366f1' }}>{peakPrice != null ? `$${fmt2(peakPrice)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', fontWeight: 700 }}>{tick.tp_action || 'NO_CHANGE'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: tick.sl_action === 'UPDATED' ? '#ef4444' : '#777', fontWeight: 700 }}>{tick.sl_action || 'NO_CHANGE'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                        {tick.sl_action === 'UPDATED'
                          ? `${tick.sl_order_action || 'UPDATED'} · ${tick.sl_prev_price != null ? `$${fmt2(tick.sl_prev_price)}` : '—'} -> ${tick.sl_new_price != null ? `$${fmt2(tick.sl_new_price)}` : '—'}`
                          : 'No change'}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'center' }}>
                        {isSell ? <span style={{ color: '#ef4444', fontSize: '10px' }}>✕</span> : tick.qp_armed ? <span style={{ color: '#d97706', fontSize: '10px' }}>✓</span> : <span style={{ color: '#ddd' }}>—</span>}
                      </td>
                      <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>
                        {tick.live_qp && <span style={{ display: 'inline-block', marginRight: '2px', padding: '0px 4px', borderRadius: '3px', fontSize: '8px', fontWeight: 800, background: 'rgba(217,119,6,0.15)', color: '#d97706', border: '1px solid rgba(217,119,6,0.35)', letterSpacing: '0.3px' }}>QP</span>}
                        {tick.live_sl && <span style={{ display: 'inline-block', marginRight: '2px', padding: '0px 4px', borderRadius: '3px', fontSize: '8px', fontWeight: 800, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)', letterSpacing: '0.3px' }}>SL</span>}
                        {tick.live_tsl && <span style={{ display: 'inline-block', padding: '0px 4px', borderRadius: '3px', fontSize: '8px', fontWeight: 800, background: 'rgba(99,102,241,0.12)', color: '#6366f1', border: '1px solid rgba(99,102,241,0.35)', letterSpacing: '0.3px' }}>TSL</span>}
                        {!tick.live_qp && !tick.live_sl && !tick.live_tsl && <span style={{ color: '#ddd' }}>—</span>}
                      </td>
                    </tr>
                  )
                  })
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────
const S = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  inner: { maxWidth: '1400px', margin: '0 auto', padding: '0 1.5rem 2rem' },

  // page header
  pageHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.5rem 0 1.25rem', flexWrap: 'wrap', gap: '1rem',
  },
  pageTitle: { fontSize: '1.7rem', fontWeight: 900, color: 'var(--text-h)', margin: 0, letterSpacing: '-0.02em' },
  pageSub: { fontSize: '0.85rem', color: 'var(--text)', marginTop: '0.25rem' },

  // filter bar
  filterBar: {
    background: 'var(--card-bg)',
    border: '1px solid rgba(201,162,39,0.13)',
    borderRadius: '14px',
    padding: '0.7rem 1rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
  },
  filterRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.3rem' },
  filterGroup: { display: 'flex', alignItems: 'center', gap: '0.25rem' },
  filterLabel: {
    fontSize: '0.67rem', fontWeight: 700, color: '#999',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    display: 'flex', alignItems: 'center', gap: '0.25rem',
    paddingRight: '0.2rem', whiteSpace: 'nowrap',
  },
  btn: (active) => ({
    padding: '0.26rem 0.65rem', borderRadius: '6px', border: 'none', cursor: 'pointer',
    fontSize: '0.74rem', fontWeight: 600, transition: 'all 0.15s',
    background: active ? `linear-gradient(135deg,${GOLD} 0%,${GOLD_LIGHT} 100%)` : 'transparent',
    color: active ? '#111' : 'var(--text)',
    boxShadow: active ? '0 1px 5px rgba(201,162,39,0.35)' : 'none',
    letterSpacing: active ? '0' : '0',
  }),
  divider: { width: '1px', height: '18px', background: 'rgba(201,162,39,0.15)', margin: '0 0.3rem', flexShrink: 0 },
  filterSep: { width: '100%', height: '1px', background: 'rgba(201,162,39,0.08)', margin: '0.45rem 0' },

  refreshBtn: {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.45rem 1rem', background: `linear-gradient(135deg,${GOLD} 0%,${GOLD_LIGHT} 100%)`,
    border: 'none', borderRadius: '8px', cursor: 'pointer',
    fontSize: '0.8rem', fontWeight: 700, color: '#111',
    boxShadow: '0 2px 8px rgba(201,162,39,0.3)', transition: 'all 0.18s',
  },

  // stats grid
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
    gap: '0.75rem', marginBottom: '1.4rem',
  },
  statCard: (accent) => ({
    background: 'var(--card-bg)', borderRadius: '12px',
    border: '1px solid rgba(201,162,39,0.1)',
    borderLeft: `3px solid ${accent || 'rgba(201,162,39,0.5)'}`,
    padding: '0.95rem 1.1rem 0.85rem',
    boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
    transition: 'box-shadow 0.15s',
  }),
  statIcon: (bg) => ({
    width: '28px', height: '28px', borderRadius: '7px',
    background: bg || 'rgba(201,162,39,0.1)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  }),
  statLabel: { fontSize: '0.67rem', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.07em' },
  statVal: (color) => ({ fontSize: '1.45rem', fontWeight: 900, color: color || 'var(--text-h)', lineHeight: 1.05, letterSpacing: '-0.02em' }),
  statSub: { fontSize: '0.68rem', color: '#aaa', marginTop: '0.3rem', fontWeight: 500 },

  // section card
  card: {
    background: 'var(--card-bg)', borderRadius: '14px',
    border: '1px solid rgba(201,162,39,0.15)',
    boxShadow: '0 2px 12px rgba(201,162,39,0.06)',
    marginBottom: '1.25rem', overflow: 'hidden',
  },
  cardHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1.1rem 1.5rem 0.9rem',
    borderBottom: '1px solid rgba(201,162,39,0.1)',
    background: 'rgba(201,162,39,0.02)',
  },
  cardTitle: { fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-h)', display: 'flex', alignItems: 'center', gap: '0.55rem' },
  cardCount: {
    display: 'inline-block', background: 'rgba(201,162,39,0.14)',
    color: GOLD_DEEP, borderRadius: '20px',
    padding: '0.15rem 0.65rem', fontSize: '0.72rem', fontWeight: 700, marginLeft: '0.4rem',
  },

  // open-positions grid
  posGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem', padding: '1.1rem 1.5rem' },
  posCard: (pnlPos) => ({
    borderRadius: '12px', overflow: 'hidden',
    border: `1px solid ${pnlPos ? 'rgba(22,163,74,0.22)' : 'rgba(239,68,68,0.2)'}`,
    background: 'var(--card-bg)',
    boxShadow: pnlPos ? '0 4px 18px rgba(22,163,74,0.07)' : '0 4px 18px rgba(239,68,68,0.07)',
  }),
  posRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.42rem' },
  posKey: { fontSize: '0.72rem', color: '#aaa', fontWeight: 600 },
  posVal: { fontSize: '0.8rem', color: 'var(--text-h)', fontWeight: 700 },

  // table
  tableWrap: { overflowX: 'auto', overflowY: 'auto', maxHeight: '620px', padding: '0 0 0.5rem' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: '1500px' },
  th: {
    textAlign: 'left', padding: '0.75rem 1.1rem',
    fontSize: '0.71rem', fontWeight: 700, color: '#aaa',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    borderBottom: '2px solid rgba(201,162,39,0.12)',
    background: 'var(--bg)', whiteSpace: 'nowrap',
    cursor: 'pointer', userSelect: 'none',
    position: 'sticky', top: 0, zIndex: 2,
  },
  td: {
    padding: '0.82rem 1.1rem', fontSize: '0.85rem', color: 'var(--text-h)',
    borderBottom: '1px solid rgba(201,162,39,0.07)', verticalAlign: 'middle',
  },

  // badges
  badge: (bg, color) => ({
    display: 'inline-block', padding: '0.25rem 0.65rem',
    borderRadius: '6px', fontSize: '0.71rem', fontWeight: 800,
    textTransform: 'uppercase', letterSpacing: '0.04em',
    background: bg, color,
  }),
  winBadge:  { background: '#dcfce7', color: '#166534' },
  lossBadge: { background: '#fee2e2', color: '#991b1b' },
  openBadge: { background: 'rgba(201,162,39,0.15)', color: GOLD_DEEP },

  empty: { textAlign: 'center', padding: '3.5rem 2rem', color: '#ccc' },
  emptyIcon: { fontSize: '2.5rem', marginBottom: '0.75rem' },
  emptyText: { fontSize: '0.92rem', fontWeight: 600 },

  // symbol dropdown
  symbolDrop: {
    position: 'relative', display: 'inline-block',
  },
  symbolBtn: {
    display: 'flex', alignItems: 'center', gap: '0.3rem',
    padding: '0.35rem 0.85rem', borderRadius: '999px',
    border: '1px solid rgba(201,162,39,0.25)', cursor: 'pointer',
    background: 'var(--card-bg)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)',
  },
  symbolMenu: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
    background: 'var(--card-bg)', borderRadius: '10px',
    border: '1px solid rgba(201,162,39,0.2)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
    zIndex: 50, minWidth: '130px', overflow: 'hidden',
  },
  symbolOption: (active) => ({
    padding: '0.55rem 1rem', fontSize: '0.81rem', fontWeight: active ? 700 : 500,
    cursor: 'pointer', color: active ? GOLD_DEEP : '#444',
    background: active ? 'rgba(201,162,39,0.08)' : 'var(--card-bg)',
    borderBottom: '1px solid rgba(201,162,39,0.06)',
    transition: 'background 0.12s',
  }),
}

// ── Symbol dropdown ────────────────────────────────────────────────────────
function SymbolDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div style={S.symbolDrop} ref={ref}>
      <button style={S.symbolBtn} onClick={() => setOpen(o => !o)}>
        {value} <ChevronDown size={12} />
      </button>
      {open && (
        <div style={S.symbolMenu}>
          {SYMBOLS.map(s => (
            <div
              key={s}
              style={S.symbolOption(value === s)}
              onClick={() => { onChange(s); setOpen(false) }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ icon, iconBg, label, value, sub, valueColor, accent }) {
  return (
    <div className="stat-card" style={S.statCard(accent || valueColor)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.55rem' }}>
        <span style={S.statLabel}>{label}</span>
        <div style={S.statIcon(iconBg)}>{icon}</div>
      </div>
      <div style={S.statVal(valueColor)}>{value}</div>
      {sub && <div style={S.statSub}>{sub}</div>}
    </div>
  )
}

// ── Sortable table header cell ─────────────────────────────────────────────
function Th({ col, label, sortCol, sortDir, onSort }) {
  const active = sortCol === col
  return (
    <th style={{ ...S.th, color: active ? GOLD_DEEP : '#aaa' }} onClick={() => onSort(col)}>
      {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function OverallSummary() {
  const [aitTrades,    setAitTrades]    = useState([])
  const [manualTrades, setManualTrades] = useState([])
  const [positions,    setPositions]    = useState([])
  const [livePositions, setLivePositions] = useState([])
  const [cfg,          setCfg]          = useState({})
  const [spinning,     setSpinning]     = useState(false)
  const [dateFilter,   setDateFilter]   = useState('TODAY')
  const [resultFilter, setResultFilter] = useState('ALL')
  const [symbolFilter, setSymbolFilter] = useState('ALL')
  const [typeFilter,   setTypeFilter]   = useState('ALL')
  const [sortCol,      setSortCol]      = useState('createdAt')
  const [sortDir,      setSortDir]      = useState('desc')
  const [hideStraddle, setHideStraddle]  = useState(false)
  const [hideRecovery, setHideRecovery]  = useState(false)
  const [sellingSymbol, setSellingSymbol] = useState(null)
  const alertedPositionKeysRef = useRef(new Set())
  const [customFrom,   setCustomFrom]   = useState('')
  const [customTo,     setCustomTo]     = useState('')
  const [hourFilter,   setHourFilter]   = useState('ALL')
  const lastDingAtRef = useRef(0)

  // ── Fetch history (trades + positions + config) — refreshes every 30s ──────
  const fetchHistory = useCallback(async (silent = false) => {
    try {
      const [aitRes, manualRes, posRes, cfgRes] = await Promise.allSettled([
        fetch(`${API_DISPLAY}/api/options-log?limit=200`),
        fetch(`${API_DISPLAY}/api/manual-trades?limit=200`),
        fetch(`${API_DISPLAY}/api/positions`),
        fetch(`${API_DISPLAY}/api/config`),
      ])

      if (aitRes.status === 'fulfilled' && aitRes.value.ok) {
        const d = await aitRes.value.json()
        const all = (d.trades || []).map(t => {
          const tt = String(t.tradeType || t.trade_type || '').toUpperCase()
          const contractName = t.contractName || t.contract_name || t.symbol
          const optionType = normalizeOptionType(t.optionType || t.option_type, t.direction, contractName, t.symbol)
          const tradeTypeTag = tt === 'STRADDLE'
            ? 'STRADDLE'
            : tt === 'AIT'
              ? 'AIT'
            : tt === 'MONITOR_EXIT'
              ? 'MONITOR'
              : tt === 'RECOVERY'
                  ? 'RECOVERY'
                  : 'UNKNOWN'
          const entryReasonRaw = tt === 'STRADDLE' ? 'STRADDLE' : tt === 'AIT' ? 'AIT' : null
          return {
            ...t,
            contractName,
            optionType,
            tradeTypeTag,
            entryReason_raw: entryReasonRaw,
            entryStrategies: asList(t.entryStrategies ?? t.entry_strategies),
            entryStrategyNames: resolveEntryStrategyNames(t),
          }
        })
        setAitTrades(all)
      } else {
        setAitTrades([])
      }

      if (manualRes.status === 'fulfilled' && manualRes.value.ok) {
        const d = await manualRes.value.json()
        const manual = (d.trades || []).map(t => {
          const contractName = t.contractName || t.contract_name || t.symbol
          const optionType = normalizeOptionType(t.optionType || t.option_type, t.direction, contractName, t.symbol)
          return {
            ...t,
            tradeTypeTag: 'Manual',
            tradeType: 'MANUAL',
            contractName,
            optionType,
            entryReason_raw: 'MANUAL',
          }
        })
        setManualTrades(manual)
      } else {
        setManualTrades([])
      }
      if (posRes.status === 'fulfilled' && posRes.value.ok) {
        const d = await posRes.value.json()
        const rows = Array.isArray(d)
          ? d
          : Array.isArray(d?.positions)
            ? d.positions
            : []
        setPositions(rows)
      }
      if (cfgRes.status === 'fulfilled' && cfgRes.value.ok) {
        setCfg(await cfgRes.value.json())
      }
    } catch (_) {}
    setSpinning(false)
  }, [])

  // ── Fetch live positions — refreshes every 5s ────────────────────────────
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch(`${API_DISPLAY}/api/live-positions`)
      if (res.ok) {
        const d = await res.json()
        setLivePositions(d.positions || [])
      }
    } catch (_) {}
  }, [])

  const fetchAll = useCallback(async (silent = false) => {
    await Promise.all([fetchHistory(silent), fetchLive()])
  }, [fetchHistory, fetchLive])

  useEffect(() => {
    fetchAll()
    const histId = setInterval(() => fetchHistory(true), 30_000)
    const liveId = setInterval(() => fetchLive(), 5_000)
    return () => { clearInterval(histId); clearInterval(liveId) }
  }, [fetchAll, fetchHistory, fetchLive])

  // ── Sell position handler ────────────────────────────────────────────────
  const handleSellPosition = async (symbol) => {
    if (!window.confirm(`Sell ${symbol} now to lock in profit?`)) return
    setSellingSymbol(symbol)
    try {
      const res = await fetch(`${API_TRADING}/api/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const pnl = data.logged_trade?.pnl
      alert(`Sold ${symbol}` + (pnl != null ? ` — P&L: ${fmtPnl(pnl)}` : ''))
      fetchAll()
    } catch (err) {
      alert(`Failed to sell ${symbol}: ${err.message}`)
    } finally {
      setSellingSymbol(null)
    }
  }

  useEffect(() => {
    const currentKeys = new Set(
      positions
        .map(positionAlertKey)
        .filter(Boolean)
    )

    const unseenKeys = []
    currentKeys.forEach((key) => {
      if (!alertedPositionKeysRef.current.has(key)) {
        unseenKeys.push(key)
      }
    })

    // Keep only currently open positions in memory so closed/reopened lots can alert again.
    alertedPositionKeysRef.current = currentKeys

    const now = Date.now()

    if (unseenKeys.length > 0 && now - lastDingAtRef.current > 600) {
      unseenKeys.forEach((_, idx) => {
        setTimeout(() => playAlertDing(), idx * 220)
      })
      lastDingAtRef.current = now
    }
  }, [positions])

  // ── Merge + filter ──────────────────────────────────────────────────────
  const allTrades = useMemo(() => [...aitTrades, ...manualTrades], [aitTrades, manualTrades])

  const filtered = useMemo(() => (
    allTrades.filter(t => {
      if (hideStraddle && t.tradeTypeTag === 'STRADDLE') return false
      if (hideRecovery && String(t.tradeTypeTag || '').toUpperCase() === 'RECOVERY') return false
      const ts = t.createdAt || t.entryTime
      const dateOk = isWithinRange(ts, dateFilter, customFrom, customTo)
      const hourOk = isWithinHours(ts, hourFilter)
      const resOk  = resultFilter === 'ALL' || t.result === resultFilter
      const symOk  = symbolFilter === 'ALL' || t.symbol === symbolFilter
      const tag = String(t.tradeTypeTag || t.trade_type || t.tradeType || '').toUpperCase()
      const typeOk = typeFilter === 'ALL' || (typeFilter === 'AIT' && tag === 'AIT') || (typeFilter === 'MANUAL' && tag === 'MANUAL')
      return dateOk && hourOk && resOk && symOk && typeOk
    })
  ), [allTrades, dateFilter, customFrom, customTo, hourFilter, resultFilter, symbolFilter, hideStraddle, hideRecovery, typeFilter])

  // History card display list — same as filtered (unified filter)
  const historyDisplayed = filtered

  // Sort
  const sorted = useMemo(() => {
    const list = [...historyDisplayed]
    list.sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol]
      if (sortCol === 'pnl' || sortCol === 'pnlPct' || sortCol === 'tradeDurationSec') { av = Number(av) || 0; bv = Number(bv) || 0 }
      if (sortCol === 'buyPrice' || sortCol === 'sellPrice') { av = Number(av) || 0; bv = Number(bv) || 0 }
      if (sortCol === 'createdAt' || sortCol === 'entryTime') {
        av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [historyDisplayed, sortCol, sortDir])

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  // ── Derived stats (from filtered) ───────────────────────────────────────
  const {
    wins,
    losses,
    breakevens,
    netPnl,
    totalProfit,
    totalLoss,
    winRate,
    avgPnl,
    aitCount,
    manualCount,
    avgDuration,
    avgPnlPct,
    avgEntryRsi,
    bestTrade,
    worstTrade,
  } = useMemo(() => {
    let winsCount = 0
    let lossesCount = 0
    let breakevenCount = 0
    let net = 0
    let profit = 0
    let loss = 0
    let ait = 0
    let manual = 0
    let durSum = 0, durCount = 0
    let pctSum = 0, pctCount = 0
    let rsiSum = 0, rsiCount = 0
    let best = -Infinity, worst = Infinity

    filtered.forEach((t) => {
      if (t.result === 'WIN') winsCount += 1
      if (t.result === 'LOSS') lossesCount += 1
      if (t.result === 'BREAKEVEN') breakevenCount += 1
      if (t.tradeTypeTag === 'AIT') ait += 1
      if (t.tradeTypeTag === 'Manual') manual += 1

      const p = Number(t.pnl) || 0
      net += p
      if (p > 0) profit += p
      if (p < 0) loss += p
      if (p > best) best = p
      if (p < worst) worst = p

      const dur = toNum(t.tradeDurationSec)
      if (dur != null) { durSum += dur; durCount++ }
      const pct = toNum(t.pnlPct)
      if (pct != null) { pctSum += pct; pctCount++ }
      const rsi = toNum(t.entryRsi)
      if (rsi != null) { rsiSum += rsi; rsiCount++ }
    })

    return {
      wins: winsCount,
      losses: lossesCount,
      breakevens: breakevenCount,
      netPnl: net,
      totalProfit: profit,
      totalLoss: loss,
      winRate: filtered.length > 0 ? ((winsCount / filtered.length) * 100).toFixed(1) : '—',
      avgPnl: filtered.length > 0 ? (net / filtered.length).toFixed(2) : '—',
      aitCount: ait,
      manualCount: manual,
      avgDuration: durCount > 0 ? fmtDuration(durSum / durCount) : '—',
      avgPnlPct: pctCount > 0 ? (pctSum / pctCount).toFixed(2) : null,
      avgEntryRsi: rsiCount > 0 ? (rsiSum / rsiCount).toFixed(1) : null,
      bestTrade: filtered.length > 0 ? best : null,
      worstTrade: filtered.length > 0 ? worst : null,
    }
  }, [filtered])

  // Merge: live-positions (bot registry) + Alpaca positions (fallback for unmanaged)
  const mergedPositions = useMemo(() => {
    // Build a set of contract symbols already covered by live-positions
    const liveCoveredSymbols = new Set(livePositions.map(lp => lp.contract_symbol))

    // Convert live-positions to the same shape as Alpaca positions for unified display
    const fromLive = livePositions
      .filter(lp => !lp.live?.exit_reason) // only active (not exited)
      .map(lp => {
        const live = lp.live || {}
        const fillPrice = parseFloat(lp.fill_price || 0)
        const curPrice = parseFloat(live.current_price || fillPrice)
        const pnlPct = parseFloat(live.pnl_pct || 0)
        const pnlDollar = parseFloat(live.pnl_dollar || 0)
        return {
          symbol: lp.contract_symbol,
          qty: lp.qty,
          avg_entry_price: fillPrice,
          current_price: curPrice,
          market_value: curPrice * (lp.qty || 1) * 100,
          unrealized_pl: pnlDollar,
          unrealized_plpc: pnlPct / 100,
          side: 'long',
          buy_order_id: lp.buy_order_id,
          cross_time: lp.cross_time,
          signal_time: lp.cross_time,
          entry_time: lp.entry_time,
          // Carry real live exit thresholds
          _live: live,
          _source: 'live',
        }
      })

    // Add Alpaca positions not covered by live-positions
    const fromAlpaca = positions.filter(p => !liveCoveredSymbols.has(p.symbol))

    return [...fromLive, ...fromAlpaca]
  }, [positions, livePositions])

  // positions filtered by symbol
  const filteredPositions = useMemo(() => (
    mergedPositions.filter(p => {
      const sym = parseOptionSymbol(p.symbol)?.underlying || p.symbol
      return symbolFilter === 'ALL' || sym === symbolFilter || p.symbol === symbolFilter
    })
  ), [mergedPositions, symbolFilter])

  // ── Helpers ──────────────────────────────────────────────────────────────
  const CDT_TZ = 'America/Chicago'

  const fmtDate = (s) => {
    if (!s) return '—'
    try {
      const d = new Date(s)
      return isNaN(d)
        ? s
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: CDT_TZ }) +
          ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: CDT_TZ })
    } catch { return s }
  }

  const fmtTimeShort = (s) => {
    if (!s) return null
    try {
      const d = new Date(s)
      return isNaN(d) ? s : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: CDT_TZ })
    } catch { return s }
  }

  const fmtTimeWithSec = (s) => {
    if (!s || s === '—') return null
    try {
      const d = new Date(s)
      if (isNaN(d)) return String(s)
      return d.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: CDT_TZ,
      })
    } catch {
      return String(s)
    }
  }

  const badgeForResult = (r) => {
    if (r === 'WIN')       return <span style={{ ...S.badge(), ...S.winBadge  }}>WIN</span>
    if (r === 'LOSS')      return <span style={{ ...S.badge(), ...S.lossBadge }}>LOSS</span>
    if (r === 'BREAKEVEN') return <span style={S.badge('rgba(100,116,139,0.12)', '#475569')}>BREAKEVEN</span>
    return <span style={S.badge('rgba(201,162,39,0.12)', GOLD_DEEP)}>{r ?? '—'}</span>
  }

  const optBadge = (v, colors) => (
    v
      ? <span style={S.badge(colors[0], colors[1])}>{v}</span>
      : <span style={{ color: '#ccc' }}>—</span>
  )

  return (
    <div style={S.page}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .os-tr:hover td { background: rgba(201,162,39,0.03) !important; }
        .sym-opt:hover { background: rgba(201,162,39,0.1) !important; }
        .stat-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08) !important; }
        .trade-card {
          transition: box-shadow 0.18s, transform 0.14s;
          box-shadow: 0 1px 4px rgba(0,0,0,0.05);
          content-visibility: auto;
          contain-intrinsic-size: 320px;
        }
        .trade-card:hover {
          box-shadow: 0 6px 24px rgba(0,0,0,0.1) !important;
          transform: translateY(-1px);
        }
      `}</style>

      <div style={S.inner}>

        {/* ── PAGE HEADER ─────────────────────────────────────────────────── */}
        <div style={S.pageHeader}>
          <div>
            <h1 style={S.pageTitle}>Overall Summary</h1>
            <p style={S.pageSub}>
              All buy &amp; sell history · open positions · P&amp;L breakdown
              &nbsp;·&nbsp;{allTrades.length} total records
            </p>
          </div>
          <button
            style={S.refreshBtn}
            onClick={() => { setSpinning(true); fetchAll() }}
          >
            <RefreshCw size={14} style={{ animation: spinning ? 'spin 0.7s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>

        {/* ── FILTER BAR ──────────────────────────────────────────────────── */}
        <div style={{ ...S.filterBar, display: 'flex', flexDirection: 'column', gap: '0' }}>

          {/* Row 1 — Period */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.2rem', paddingBottom: '0.55rem' }}>
            <span style={S.filterLabel}><Activity size={10} /> Period</span>
            <div style={{ display: 'flex', gap: '0.15rem', background: 'rgba(201,162,39,0.06)', borderRadius: '7px', padding: '0.18rem' }}>
              {DATE_FILTERS.filter(f => f !== 'CUSTOM').map(f => (
                <button key={f} style={S.btn(dateFilter === f)} onClick={() => setDateFilter(f)}>{f}</button>
              ))}
            </div>
            <button
              style={{
                ...S.btn(dateFilter === 'CUSTOM'),
                border: '1px dashed rgba(201,162,39,0.3)',
                marginLeft: '0.25rem',
              }}
              onClick={() => setDateFilter('CUSTOM')}
            >Custom</button>

            {/* Active date label */}
            {(dateFilter === 'TODAY' || dateFilter === 'YESTERDAY') && (() => {
              const base = dateFilter === 'YESTERDAY' ? new Date(Date.now() - 86400000) : new Date()
              const label = fmtCtDate(base)
              return (
                <span style={{
                  marginLeft: '0.5rem', fontSize: '0.71rem', fontWeight: 700,
                  color: GOLD_DEEP, padding: '0.18rem 0.6rem',
                  background: 'rgba(201,162,39,0.08)',
                  borderRadius: '5px', border: '1px solid rgba(201,162,39,0.18)',
                  whiteSpace: 'nowrap',
                }}>
                  {label} · 8:30 AM – 3:00 PM CT
                </span>
              )
            })()}

            {dateFilter === 'CUSTOM' && (
              <>
                <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                  style={{ padding: '0.22rem 0.5rem', borderRadius: '6px', fontSize: '0.73rem', fontWeight: 500, border: '1px solid rgba(201,162,39,0.3)', background: 'var(--bg)', color: 'var(--text)', outline: 'none', marginLeft: '0.4rem' }}
                />
                <span style={{ color: '#bbb', fontSize: '0.7rem' }}>→</span>
                <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)}
                  style={{ padding: '0.22rem 0.5rem', borderRadius: '6px', fontSize: '0.73rem', fontWeight: 500, border: '1px solid rgba(201,162,39,0.3)', background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
                />
                {(customFrom || customTo) && (
                  <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', fontWeight: 600, color: GOLD_DEEP, padding: '0.18rem 0.5rem', background: 'rgba(201,162,39,0.08)', borderRadius: '5px', border: '1px solid rgba(201,162,39,0.18)', whiteSpace: 'nowrap' }}>
                    {customFrom ? new Date(customFrom).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '…'}
                    {' → '}
                    {customTo ? new Date(customTo).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'now'}
                  </span>
                )}
              </>
            )}
          </div>

          <div style={S.filterSep} />

          {/* Row 2 — Hours */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.2rem', padding: '0.55rem 0' }}>
            <span style={S.filterLabel}><Clock size={10} /> Hours (CT)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.15rem', background: 'rgba(201,162,39,0.06)', borderRadius: '7px', padding: '0.18rem' }}>
              {HOUR_FILTERS.map(f => (
                <button key={f.key} style={S.btn(hourFilter === f.key)} onClick={() => setHourFilter(f.key)}>{f.label}</button>
              ))}
            </div>
            {hourFilter !== 'ALL' && (() => {
              const active = HOUR_FILTERS.find(f => f.key === hourFilter)
              return active?.range
                ? <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', fontWeight: 700, color: GOLD_DEEP, padding: '0.18rem 0.55rem', background: 'rgba(201,162,39,0.08)', borderRadius: '5px', border: '1px solid rgba(201,162,39,0.18)' }}>{active.range}</span>
                : null
            })()}
          </div>

          <div style={S.filterSep} />

          {/* Row 3 — Result · Type · Symbol · Toggles · Reset */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem', paddingTop: '0.55rem' }}>
            <span style={S.filterLabel}>Result</span>
            {RESULT_FILTERS.map(f => (
              <button key={f} style={S.btn(resultFilter === f)} onClick={() => setResultFilter(f)}>{f}</button>
            ))}

            <div style={S.divider} />

            <span style={S.filterLabel}>Type</span>
            {TYPE_FILTERS.map(f => (
              <button key={f} style={S.btn(typeFilter === f)} onClick={() => setTypeFilter(f)}>{f === 'MANUAL' ? 'MT' : f}</button>
            ))}

            <div style={S.divider} />

            <span style={S.filterLabel}><Layers size={10} /> Symbol</span>
            <SymbolDropdown value={symbolFilter} onChange={setSymbolFilter} />

            <div style={S.divider} />

            {/* Straddle toggle */}
            <button onClick={() => setHideStraddle(h => !h)} style={{
              padding: '0.22rem 0.6rem', borderRadius: '6px', cursor: 'pointer',
              fontSize: '0.71rem', fontWeight: 600, transition: 'all 0.15s', border: 'none',
              background: hideStraddle ? 'rgba(239,68,68,0.08)' : 'rgba(22,163,74,0.08)',
              color: hideStraddle ? '#ef4444' : '#16a34a',
            }}>
              {hideStraddle ? '✕' : '✓'} Straddle
            </button>

            {/* Recovery toggle */}
            <button onClick={() => setHideRecovery(h => !h)} style={{
              padding: '0.22rem 0.6rem', borderRadius: '6px', cursor: 'pointer',
              fontSize: '0.71rem', fontWeight: 600, transition: 'all 0.15s', border: 'none',
              background: hideRecovery ? 'rgba(239,68,68,0.08)' : 'rgba(22,163,74,0.08)',
              color: hideRecovery ? '#ef4444' : '#16a34a',
            }}>
              {hideRecovery ? '✕' : '✓'} Recovery
            </button>

            {(dateFilter !== 'TODAY' || resultFilter !== 'ALL' || symbolFilter !== 'ALL' || !hideStraddle || !hideRecovery || typeFilter !== 'ALL' || hourFilter !== 'ALL') && (
              <>
                <div style={S.divider} />
                <button
                  onClick={() => {
                    setDateFilter('TODAY'); setResultFilter('ALL'); setSymbolFilter('ALL')
                    setHideStraddle(true); setHideRecovery(true); setTypeFilter('ALL')
                    setHourFilter('ALL'); setCustomFrom(''); setCustomTo('')
                  }}
                  style={{
                    padding: '0.22rem 0.6rem', borderRadius: '6px', border: 'none',
                    cursor: 'pointer', fontSize: '0.71rem', fontWeight: 600,
                    background: 'rgba(239,68,68,0.08)', color: '#ef4444', transition: 'all 0.15s',
                  }}
                >
                  ✕ Reset
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── STATS GRID ──────────────────────────────────────────────────── */}
        <div style={{ ...S.statsGrid, marginTop: '0.85rem' }}>
          <StatCard
            icon={<BarChart3 size={14} color={GOLD_DEEP} />}
            iconBg="rgba(201,162,39,0.1)"
            label="Total Trades"
            value={filtered.length}
            sub={`AIT: ${aitCount} · MT: ${manualCount}${breakevens > 0 ? ' · BE: ' + breakevens : ''}`}
            accent={GOLD}
          />
          <StatCard
            icon={<TrendingUp size={14} color="#16a34a" />}
            iconBg="rgba(22,163,74,0.1)"
            label="Wins"
            value={wins}
            sub={`Win rate: ${winRate}%`}
            valueColor="#16a34a"
          />
          <StatCard
            icon={<TrendingDown size={14} color="#ef4444" />}
            iconBg="rgba(239,68,68,0.1)"
            label="Losses"
            value={losses}
            sub={`Loss rate: ${filtered.length > 0 ? ((losses/filtered.length)*100).toFixed(1) : '—'}%`}
            valueColor="#ef4444"
          />
          <StatCard
            icon={<ArrowUpRight size={14} color="#16a34a" />}
            iconBg="rgba(22,163,74,0.08)"
            label="Total Profit"
            value={`$${fmt2(totalProfit)}`}
            valueColor="#16a34a"
          />
          <StatCard
            icon={<ArrowDownRight size={14} color="#ef4444" />}
            iconBg="rgba(239,68,68,0.08)"
            label="Total Loss"
            value={`$${fmt2(Math.abs(totalLoss))}`}
            valueColor="#ef4444"
          />
          <StatCard
            icon={<DollarSign size={14} color={netPnl >= 0 ? '#16a34a' : '#ef4444'} />}
            iconBg={netPnl >= 0 ? 'rgba(22,163,74,0.1)' : 'rgba(239,68,68,0.1)'}
            label="Net P&L"
            value={fmtPnl(netPnl)}
            sub={`Per trade: ${avgPnl !== '—' ? fmtPnl(avgPnl) : '—'}`}
            valueColor={netPnl >= 0 ? '#16a34a' : '#ef4444'}
          />
          <StatCard
            icon={<Clock size={14} color="#6366f1" />}
            iconBg="rgba(99,102,241,0.1)"
            label="Avg Duration"
            value={avgDuration}
            sub={avgPnlPct != null ? `Avg PnL: ${fmtPctSigned(avgPnlPct)}` : undefined}
            valueColor="#6366f1"
          />
          <StatCard
            icon={<Target size={14} color="#d97706" />}
            iconBg="rgba(217,119,6,0.1)"
            label="Avg Entry RSI"
            value={avgEntryRsi ?? '—'}
            sub={avgEntryRsi ? (Number(avgEntryRsi) > 50 ? 'Bullish bias' : 'Bearish bias') : undefined}
            valueColor="#d97706"
          />
        </div>

        {/* ── OPEN POSITIONS ───────────────────────────────────────────────── */}
        <div style={S.card}>
          <div style={S.cardHeader}>
            <div style={S.cardTitle}>
              <Circle size={8} color="#22c55e" fill="#22c55e" />
              Open Positions
              <span style={S.cardCount}>{filteredPositions.length}</span>
            </div>
            <span style={{ fontSize: '0.72rem', color: '#bbb', fontWeight: 600 }}>Live positions every 5s · history every 30s</span>
          </div>

          {filteredPositions.length === 0 ? (
            <div style={S.empty}>
              <div style={S.emptyIcon}>📭</div>
              <div style={S.emptyText}>No open positions</div>
            </div>
          ) : (
            <div style={S.posGrid}>
              {filteredPositions.map((p, i) => {
                const uPl    = Number(p.unrealized_pl) || 0
                const uPlPct = Number(p.unrealized_plpc) || 0
                const curPct = uPlPct * 100
                const isPos  = uPl >= 0
                // Use real live exit thresholds when available, else estimate from config
                const liveExit = p._live || null
                const snap = liveExit
                  ? {
                      slPct: parseFloat(liveExit.sl_dynamic_pct || liveExit.sl_static_pct || 0),
                      qpPct: parseFloat(liveExit.qp_dynamic_pct || liveExit.qp_floor_pct || 0),
                      tpPct: parseFloat(liveExit.tp_pct || 0),
                    }
                  : calcExitSnapshot(curPct, cfg)
                const opt    = parseOptionSymbol(p.symbol)
                const side   = cleanSide(p.side)

                // Progress bar: map values into [0,100] across the [slPct, tpPct] range
                const rangeMin = Math.min(snap.slPct - 2, curPct - 1)
                const rangeMax = Math.max(snap.tpPct + 2, curPct + 1)
                const toBarPct = (v) =>
                  Math.max(0, Math.min(100, ((v - rangeMin) / (rangeMax - rangeMin)) * 100))

                // ── Bracket order helpers ────────────────────────────────
                const tpId      = (liveExit?.tp_order_ids || [])[0]
                const slId      = (liveExit?.sl_order_ids || [])[0]
                const tpPrice   = liveExit?.tp_price
                const slPrice   = liveExit?.confirmed_sl_price
                const slStatPct = liveExit?.sl_static_pct ?? null
                const slLastPct = liveExit?.sl_last_placed_pct ?? null
                const slDynPct  = liveExit?.sl_dynamic_pct ?? null
                const tpFilled  = liveExit?.tp_order_filled
                const slFilled  = liveExit?.sl_order_filled
                const slPending      = slLastPct != null && slDynPct != null && (slDynPct - slLastPct) > 0.1
                const slUpdated      = !slPending && slLastPct != null && slStatPct != null && (slLastPct - slStatPct) > 0.1
                const slReplaceError = liveExit?.sl_replace_error || null
                const shortId   = (id) => id ? `…${id.slice(-8)}` : '—'

                const currentPrice    = Number(p.current_price) || 0
                const tpAboveAlert    = !tpFilled && tpPrice != null && tpPrice > 0 && currentPrice > tpPrice
                const monitorStalled  = !slFilled && !tpFilled && curPct > 1.0 &&
                                        slDynPct != null && slStatPct != null && (slDynPct - slStatPct) < 0.5

                const slStatusBadge = slFilled
                  ? { label: 'FILLED',  bg: 'rgba(239,68,68,0.15)',    color: '#ef4444' }
                  : slPending
                  ? { label: 'PENDING', bg: 'rgba(245,158,11,0.14)',   color: '#d97706' }
                  : slUpdated
                  ? { label: 'UPDATED ↑', bg: 'rgba(245,158,11,0.14)', color: '#d97706' }
                  : { label: 'ACTIVE',  bg: 'rgba(59,130,246,0.12)',   color: '#3b82f6' }

                const tpUntracked   = !tpFilled && !tpId && tpPrice != null
                const tpStatusBadge = tpFilled
                  ? { label: 'FILLED',        bg: 'rgba(22,163,74,0.15)',    color: '#16a34a' }
                  : tpAboveAlert
                  ? { label: '⚠ ABOVE TP',    bg: 'rgba(245,158,11,0.14)',   color: '#d97706' }
                  : tpUntracked
                  ? { label: '⚠ UNTRACKED',   bg: 'rgba(239,68,68,0.1)',     color: '#ef4444' }
                  : { label: 'ACTIVE',        bg: 'rgba(59,130,246,0.12)',   color: '#3b82f6' }

                const hasBracket = !!(tpId || slId || tpPrice != null)

                return (
                  <div key={i} style={S.posCard(isPos)}>

                    {/* ── Accent bar ── */}
                    <div style={{
                      height: '3px',
                      background: isPos
                        ? 'linear-gradient(90deg,#16a34a,#22c55e)'
                        : 'linear-gradient(90deg,#dc2626,#ef4444)',
                    }} />

                    {/* ── Card header ── */}
                    <div style={{ padding: '0.8rem 1rem 0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 900, fontSize: '1.1rem', color: 'var(--text-h)', letterSpacing: '-0.01em' }}>
                            {opt ? opt.underlying : p.symbol}
                          </span>
                          <span style={{
                            padding: '0.08rem 0.42rem', borderRadius: '4px',
                            fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase',
                            background: side === 'LONG' ? 'rgba(22,163,74,0.12)' : 'rgba(239,68,68,0.12)',
                            color: side === 'LONG' ? '#16a34a' : '#ef4444',
                          }}>{side}</span>
                          {opt && (
                            <span style={{
                              padding: '0.08rem 0.42rem', borderRadius: '4px',
                              fontSize: '0.62rem', fontWeight: 800,
                              background: opt.optType === 'CALL' ? 'rgba(59,130,246,0.1)' : 'rgba(168,85,247,0.1)',
                              color: opt.optType === 'CALL' ? '#2563eb' : '#7c3aed',
                            }}>{opt.optType}</span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.67rem', color: '#999', marginTop: '0.18rem', fontWeight: 500 }}>
                          {opt ? `${opt.strike} · Exp ${opt.expiry} · Qty ${p.qty}` : `Qty: ${p.qty}`}
                        </div>
                      </div>
                      {/* P&L */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 900, color: isPos ? '#16a34a' : '#ef4444', lineHeight: 1 }}>
                          {fmtPnl(uPl)}
                        </div>
                        <div style={{ fontSize: '0.69rem', fontWeight: 700, color: isPos ? '#16a34a' : '#ef4444', opacity: 0.72, marginTop: '0.15rem' }}>
                          {fmtPctSigned(curPct)}
                        </div>
                      </div>
                    </div>

                    {/* ── Price grid (3 cols) ── */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0', borderTop: '1px solid rgba(0,0,0,0.06)', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                      {[
                        { label: 'Entry',   val: `$${fmt2(p.avg_entry_price)}` },
                        { label: 'Current', val: `$${fmt2(p.current_price)}` },
                        { label: 'Mkt Val', val: `$${fmt2(p.market_value)}` },
                      ].map(({ label, val }, ci) => (
                        <div key={label} style={{
                          padding: '0.5rem 0', textAlign: 'center',
                          borderRight: ci < 2 ? '1px solid rgba(0,0,0,0.06)' : 'none',
                        }}>
                          <div style={{ fontSize: '0.58rem', color: '#aaa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                          <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-h)', marginTop: '0.12rem' }}>{val}</div>
                        </div>
                      ))}
                    </div>

                    {/* ── Times ── */}
                    <div style={{ padding: '0.45rem 1rem 0', display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
                      {(p.cross_time || p.signal_time) && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '0.65rem', color: '#aaa', fontWeight: 600 }}>Signal Cross</span>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text)', fontWeight: 700 }}>{fmtDate(p.cross_time || p.signal_time)}</span>
                        </div>
                      )}
                      {p.entry_time && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '0.65rem', color: '#aaa', fontWeight: 600 }}>Entry Time</span>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text)', fontWeight: 700 }}>{fmtDate(p.entry_time)}</span>
                        </div>
                      )}
                    </div>

                    {/* ── Exit thresholds + bar ── */}
                    <div style={{ padding: '0.6rem 1rem 0.7rem', borderTop: '1px dashed rgba(201,162,39,0.18)', marginTop: '0.45rem', background: 'rgba(201,162,39,0.02)' }}>
                      <div style={{ fontSize: '0.6rem', color: '#bbb', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.45rem' }}>
                        Exit Thresholds
                      </div>
                      {/* SL / QP / TP tiles */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.35rem', marginBottom: '0.6rem' }}>
                        {[
                          { label: 'Stop Loss', value: fmtPctSigned(snap.slPct), color: '#ef4444', bg: 'rgba(239,68,68,0.07)' },
                          { label: 'QP Lock',   value: fmtPctSigned(snap.qpPct), color: '#d97706', bg: 'rgba(245,158,11,0.07)' },
                          { label: 'Take Prof', value: fmtPctSigned(snap.tpPct), color: '#16a34a', bg: 'rgba(22,163,74,0.07)' },
                        ].map(({ label, value, color, bg }) => (
                          <div key={label} style={{ textAlign: 'center', background: bg, borderRadius: '6px', padding: '0.35rem 0.1rem' }}>
                            <div style={{ fontSize: '0.57rem', color: '#aaa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                            <div style={{ fontSize: '0.82rem', fontWeight: 900, color, marginTop: '0.08rem' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      {/* Progress bar */}
                      <div style={{ position: 'relative', height: '5px', background: 'rgba(0,0,0,0.07)', borderRadius: '999px' }}>
                        <div style={{ position: 'absolute', left: `${toBarPct(snap.slPct)}%`, top: '-4px', width: '2px', height: '13px', background: '#ef4444', borderRadius: '1px', transform: 'translateX(-50%)' }} />
                        {snap.qpPct !== 0 && <div style={{ position: 'absolute', left: `${toBarPct(snap.qpPct)}%`, top: '-4px', width: '2px', height: '13px', background: '#d97706', borderRadius: '1px', transform: 'translateX(-50%)' }} />}
                        <div style={{ position: 'absolute', left: `${toBarPct(snap.tpPct)}%`, top: '-4px', width: '2px', height: '13px', background: '#16a34a', borderRadius: '1px', transform: 'translateX(-50%)' }} />
                        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${toBarPct(curPct)}%`, background: isPos ? 'rgba(22,163,74,0.32)' : 'rgba(239,68,68,0.32)', borderRadius: '999px 0 0 999px' }} />
                        <div style={{ position: 'absolute', left: `${toBarPct(curPct)}%`, top: '50%', width: '11px', height: '11px', borderRadius: '50%', background: isPos ? '#16a34a' : '#ef4444', border: '2px solid #fff', boxShadow: '0 1px 5px rgba(0,0,0,0.22)', transform: 'translate(-50%,-50%)', zIndex: 2 }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem' }}>
                        <span style={{ fontSize: '0.58rem', color: '#ef4444', fontWeight: 700 }}>SL {fmtPctSigned(snap.slPct)}</span>
                        <span style={{ fontSize: '0.58rem', fontWeight: 800, color: isPos ? '#16a34a' : '#ef4444' }}>Now {fmtPctSigned(curPct)}</span>
                        <span style={{ fontSize: '0.58rem', color: '#16a34a', fontWeight: 700 }}>TP {fmtPctSigned(snap.tpPct)}</span>
                      </div>
                    </div>

                    {/* ── Bracket Orders ── */}
                    {hasBracket && (
                      <div style={{ borderTop: '1px solid rgba(0,0,0,0.07)', padding: '0.6rem 1rem 0.75rem', background: 'rgba(0,0,0,0.015)' }}>
                        <div style={{ fontSize: '0.6rem', color: '#bbb', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                          Bracket Orders
                        </div>

                        {/* TP Order row */}
                        {(tpId || tpPrice != null) && (
                          <div style={{ marginBottom: '0.38rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              {/* Type badge */}
                              <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#16a34a', background: 'rgba(22,163,74,0.12)', borderRadius: '4px', padding: '0.1rem 0.4rem', minWidth: '22px', textAlign: 'center' }}>TP</span>
                              {/* Broker badge */}
                              <span style={{ fontSize: '0.58rem', fontWeight: 700, color: '#6366f1', background: 'rgba(99,102,241,0.1)', borderRadius: '4px', padding: '0.08rem 0.35rem' }}>BROKER</span>
                              {/* Order ID */}
                              <span style={{ fontFamily: 'monospace', fontSize: '0.63rem', color: '#888', flexGrow: 1 }} title={tpId || ''}>{shortId(tpId)}</span>
                              {/* Price */}
                              {tpPrice != null && (
                                <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 800, color: '#16a34a' }}>${fmt2(tpPrice)}</span>
                              )}
                              {/* Status */}
                              <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '0.1rem 0.38rem', borderRadius: '4px', background: tpStatusBadge.bg, color: tpStatusBadge.color, whiteSpace: 'nowrap' }}>
                                {tpStatusBadge.label}
                              </span>
                            </div>
                            {tpAboveAlert && (
                              <div style={{ marginTop: '0.22rem', padding: '0.18rem 0.42rem', borderRadius: '4px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.22)' }}>
                                <span style={{ fontSize: '0.58rem', color: '#d97706', fontWeight: 600 }}>
                                  Current ${fmt2(currentPrice)} has passed TP limit — order may have expired (DAY) or not yet placed
                                </span>
                              </div>
                            )}
                            {tpUntracked && !tpAboveAlert && (
                              <div style={{ marginTop: '0.22rem', padding: '0.18rem 0.42rem', borderRadius: '4px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)' }}>
                                <span style={{ fontSize: '0.58rem', color: '#ef4444', fontWeight: 600 }}>
                                  No order ID — TP may have expired (DAY order) or was not placed. Verify in Alpaca dashboard.
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* SL Order row */}
                        {slId && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                            {/* Type badge */}
                            <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#ef4444', background: 'rgba(239,68,68,0.12)', borderRadius: '4px', padding: '0.1rem 0.4rem', minWidth: '22px', textAlign: 'center' }}>SL</span>
                            {/* Broker badge */}
                            <span style={{ fontSize: '0.58rem', fontWeight: 700, color: '#6366f1', background: 'rgba(99,102,241,0.1)', borderRadius: '4px', padding: '0.08rem 0.35rem' }}>BROKER</span>
                            {/* Order ID */}
                            <span style={{ fontFamily: 'monospace', fontSize: '0.63rem', color: '#888', flexGrow: 1 }} title={slId}>{shortId(slId)}</span>
                            {/* Price */}
                            {slPrice != null && (
                              <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 800, color: '#ef4444' }}>${fmt2(slPrice)}</span>
                            )}
                            {/* Status */}
                            <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '0.1rem 0.38rem', borderRadius: '4px', background: slStatusBadge.bg, color: slStatusBadge.color, whiteSpace: 'nowrap' }}>
                              {slStatusBadge.label}
                            </span>
                          </div>
                        )}

                        {/* SL ratchet detail row */}
                        {slId && slLastPct != null && (() => {
                          const fillPx      = Number(p.avg_entry_price) || 0
                          const placedPx    = fillPx > 0 ? fillPx * (1 + slLastPct / 100) : null
                          const targetPx    = slPending && slDynPct != null && fillPx > 0 ? fillPx * (1 + slDynPct / 100) : null
                          const initSlPx    = slStatPct != null && fillPx > 0 ? fillPx * (1 + slStatPct / 100) : null
                          return (
                            <div style={{ marginTop: '0.35rem', paddingTop: '0.32rem', borderTop: '1px dashed rgba(0,0,0,0.07)', display: 'grid', gap: '0.18rem' }}>
                              {placedPx != null && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '0.6rem', color: '#aaa', fontWeight: 600 }}>Placed at</span>
                                  <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', fontWeight: 800, color: slUpdated ? '#d97706' : '#888' }}>${fmt2(placedPx)}</span>
                                  {slPending && targetPx != null && (
                                    <>
                                      <span style={{ fontSize: '0.6rem', color: '#aaa' }}>→</span>
                                      <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', fontWeight: 800, color: '#d97706' }}>${fmt2(targetPx)}</span>
                                      <span style={{ fontSize: '0.59rem', fontWeight: 700, color: '#d97706', background: 'rgba(245,158,11,0.1)', borderRadius: '4px', padding: '0.06rem 0.3rem' }}>update queued</span>
                                    </>
                                  )}
                                  {slPending && slReplaceError && (
                                    <div style={{ gridColumn: '1/-1', marginTop: '0.22rem', padding: '0.25rem 0.45rem', borderRadius: '5px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)' }}>
                                      <span style={{ fontSize: '0.58rem', color: '#ef4444', fontWeight: 700 }}>Replace error: </span>
                                      <span style={{ fontSize: '0.58rem', color: '#ef4444', fontFamily: 'monospace', wordBreak: 'break-all' }}>{slReplaceError}</span>
                                    </div>
                                  )}
                                  {slUpdated && (
                                    <span style={{ fontSize: '0.59rem', fontWeight: 700, color: '#16a34a', background: 'rgba(22,163,74,0.1)', borderRadius: '4px', padding: '0.06rem 0.3rem' }}>ratcheted ↑</span>
                                  )}
                                </div>
                              )}
                              {initSlPx != null && slUpdated && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <span style={{ fontSize: '0.6rem', color: '#aaa', fontWeight: 600 }}>Original SL</span>
                                  <span style={{ fontFamily: 'monospace', fontSize: '0.63rem', fontWeight: 700, color: '#aaa', textDecoration: 'line-through' }}>${fmt2(initSlPx)}</span>
                                </div>
                              )}
                              {/* Market fallback trigger */}
                              {slDynPct != null && fillPx > 0 && (() => {
                                const mktTrigger = fillPx * (1 + slDynPct / 100)
                                return (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ fontSize: '0.6rem', color: '#f97316', fontWeight: 700 }}>Market SL</span>
                                    <span style={{ fontFamily: 'monospace', fontSize: '0.63rem', fontWeight: 800, color: '#f97316' }}>${fmt2(mktTrigger)}</span>
                                    <span style={{ fontSize: '0.58rem', color: '#aaa', fontWeight: 500 }}>fires if broker SL misses</span>
                                  </div>
                                )
                              })()}
                            </div>
                          )
                        })()}

                        {/* Monitor stall warning */}
                        {monitorStalled && (
                          <div style={{ marginTop: '0.38rem', padding: '0.22rem 0.45rem', borderRadius: '5px', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.22)' }}>
                            <span style={{ fontSize: '0.58rem', color: '#d97706', fontWeight: 700 }}>⚠ SL not ratcheting in profit — monitoring may be stalled or not running</span>
                          </div>
                        )}

                        {/* Buy Order ID */}
                        {p.buy_order_id && (
                          <div style={{ marginTop: '0.45rem', paddingTop: '0.32rem', borderTop: '1px dashed rgba(0,0,0,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.6rem', color: '#aaa', fontWeight: 600 }}>Buy Order</span>
                            <span style={{ fontFamily: 'monospace', fontSize: '0.63rem', color: '#888' }} title={p.buy_order_id}>{shortId(p.buy_order_id)}</span>
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── TRADE HISTORY TABLE ─────────────────────────────────────────── */}
        <div style={{ ...S.card, overflow: 'visible' }}>
          <div style={S.cardHeader}>
            <div style={S.cardTitle}>
              <BarChart3 size={14} color={GOLD_DEEP} />
              Trade History
              <span style={S.cardCount}>{sorted.length}</span>
            </div>
            <span style={{ fontSize: '0.72rem', color: '#bbb', fontWeight: 600 }}>
              AIT + Manual · {sorted.length} trades
            </span>
          </div>

          <div>
          {sorted.length === 0 ? (
            <div style={S.empty}>
              <div style={S.emptyIcon}>📋</div>
              <div style={S.emptyText}>No trades match the selected filters</div>
            </div>
          ) : (
            <>
              {/* ── Sort bar ── */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.45rem',
                padding: '0.6rem 1.25rem', flexWrap: 'wrap',
                borderBottom: '1px solid rgba(201,162,39,0.08)',
                background: 'rgba(253,250,244,0.7)',
              }}>
                <span style={{ fontSize: '0.67rem', fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.07em', marginRight: '0.2rem' }}>Sort</span>
                {[
                  { col: 'createdAt', label: 'Date'   },
                  { col: 'pnl',       label: 'P&L'    },
                  { col: 'pnlPct',    label: 'P&L %'  },
                  { col: 'symbol',    label: 'Symbol' },
                  { col: 'result',    label: 'Result' },
                  { col: 'tradeDurationSec', label: 'Duration' },
                ].map(({ col, label }) => {
                  const active = sortCol === col
                  return (
                    <button
                      key={col}
                      onClick={() => handleSort(col)}
                      style={{
                        padding: '0.28rem 0.75rem', borderRadius: '999px',
                        border: 'none', cursor: 'pointer',
                        fontSize: '0.74rem', fontWeight: 700, transition: 'all 0.15s',
                        background: active ? `linear-gradient(135deg,${GOLD},${GOLD_LIGHT})` : 'rgba(201,162,39,0.07)',
                        color: active ? '#111' : '#888',
                        boxShadow: active ? '0 2px 6px rgba(201,162,39,0.28)' : 'none',
                      }}
                    >
                      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  )
                })}
              </div>

              {/* ── Trade cards ── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem 1.5rem', maxHeight: '720px', overflowY: 'auto' }}>
                {sorted.map((t, i) => {
                  const pnl    = Number(t.pnl) || 0
                  const pnlPos = pnl >= 0
                  const optRaw = String(
                    normalizeOptionType(
                      t.optionType,
                      t.direction,
                      t.contractName,
                      t.symbol,
                    ) || '—'
                  ).toUpperCase()
                  const raw    = t.entryReason_raw
                  const entryMeaning = entryReasonMeaning(raw)
                  const exitReasonRaw = (t.exitReason || t.exit_reason || '')
                  const exitReasonText = reasonLabel(exitReasonRaw)
                  const exitMeaning = exitReasonMeaning(exitReasonRaw)
                  const entrySignalTime = t.entrySignalTime || t.entry_signal_time || t.signalTime || t.entryTime
                  const buyFilledTime = t.buyFilledTime || t.buy_filled_time || t.entryTime
                  const exitSignalTime = t.exitSignalTime || t.exit_signal_time || t.exitTime || t.sellFilledTime || t.sell_filled_time
                  const sellFilledTime = t.sellFilledTime || t.sell_filled_time || t.exitTime
                  const entrySignalPrice = toNum(t.entrySignalPrice ?? t.entry_signal_price)
                  const buyFilledPrice = toNum(t.buyFilledPrice ?? t.buy_filled_price ?? t.buyPrice ?? t.buy_price)
                  const exitSignalPrice = toNum(t.exitSignalPrice ?? t.exit_signal_price ?? t.sellPrice ?? t.sell_price)
                  const sellFilledPrice = toNum(t.sellFilledPrice ?? t.sell_filled_price ?? t.sellPrice ?? t.sell_price)
                  const hasLifecycleTimes = Boolean(
                    entrySignalTime || buyFilledTime || exitSignalTime || sellFilledTime ||
                    entrySignalPrice != null || buyFilledPrice != null || exitSignalPrice != null || sellFilledPrice != null
                  )

                  const entryBadgeLabel = raw === 'STRADDLE' ? 'Straddle'
                    : raw === 'AIT'    ? 'RSI X'
                    : raw === 'MANUAL' ? 'Manual'
                    : raw || null
                  const entryBadgeBg = raw === 'STRADDLE' ? 'rgba(201,162,39,0.15)'
                    : raw === 'AIT'    ? 'rgba(99,102,241,0.12)'
                    : 'rgba(0,0,0,0.05)'
                  const entryBadgeColor = raw === 'STRADDLE' ? GOLD_DEEP
                    : raw === 'AIT'    ? '#4338ca'
                    : '#888'

                  const contractParsed = parseOptionSymbol(t.contractName || '')
                  const strikeExp = contractParsed
                    ? `${contractParsed.strike} · Exp ${contractParsed.expiry}`
                    : (t.contractName || null)

                  // If symbol field IS a contract string (e.g. "TSLA260406C00362500"), parse it
                  const symbolParsed = parseOptionSymbol(t.symbol || '')
                  const displaySymbol = symbolParsed ? symbolParsed.underlying : (t.symbol || '—')
                  // Contract subtitle: show if symbol was a contract OR contractName differs from symbol
                  const contractSubtitle = symbolParsed
                    ? t.symbol  // show the raw contract as subtitle
                    : (t.contractName && t.contractName !== t.symbol ? t.contractName : null)

                  // Slippage flag: profit-intent exit but filled at a loss
                  const exitStr = (t.exitReason || t.exit_reason || '').toUpperCase()
                  const profitIntentExit = exitStr.includes('PROFIT') || exitStr.includes('QP') || exitStr.includes('MONITOR_EXIT')
                  const isSlippage = profitIntentExit && t.result === 'LOSS'
                  const slippageDiff = isSlippage && t.buyPrice != null && t.sellPrice != null
                    ? ((Number(t.sellPrice) - Number(t.buyPrice)) * (t.qty || 1) * 100).toFixed(2)
                    : null

                  // Determine accent color: BREAKEVEN = amber, win = green, loss = red
                  const isBreakeven = t.result === 'BREAKEVEN'
                  const accentColor = isBreakeven ? '#d97706' : pnlPos ? '#16a34a' : '#dc2626'
                  const accentBorder = isBreakeven
                    ? 'rgba(217,119,6,0.22)'
                    : pnlPos ? 'rgba(22,163,74,0.22)' : 'rgba(220,38,38,0.2)'

                  // Build strike/expiry/qty line from direct API fields (preferred over symbol parsing)
                  const strikeLine = [
                    t.strikePrice != null ? `Strike $${Number(t.strikePrice).toFixed(2)}` : null,
                    t.expiry       ? `Exp ${t.expiry}` : null,
                    t.qty          ? `Qty ${t.qty}`    : null,
                  ].filter(Boolean).join('  ·  ')

                  // Snapshot row from actual DB values
                  const hasPeak = toNum(t.peakPnlPct) != null

                  return (
                    <div
                      key={t.id || i}
                      className="trade-card"
                      style={{
                        borderRadius: '12px',
                        border: `1.5px solid ${accentBorder}`,
                        borderLeft: `5px solid ${accentColor}`,
                        background: 'var(--card-bg)',
                      }}
                    >
                      {/* ── Top section ── */}
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        padding: '14px 18px 12px',
                        gap: '16px',
                      }}>

                        {/* Left: symbol + badge row + detail line */}
                        <div>
                          {/* Row 1: Symbol + date */}
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: contractSubtitle ? '3px' : '8px' }}>
                            <span style={{ fontWeight: 900, fontSize: '20px', color: 'var(--text-h)', letterSpacing: '-0.4px', lineHeight: 1 }}>
                              {displaySymbol}
                            </span>
                            <span style={{ fontSize: '12px', color: '#bbb', fontWeight: 500 }}>
                              {fmtDate(t.createdAt)}
                            </span>
                          </div>
                          {/* Contract name subtitle (when symbol was a contract string) */}
                          {contractSubtitle && (
                            <div style={{ fontSize: '11px', color: '#aaa', fontWeight: 500, marginBottom: '7px', fontFamily: 'monospace', letterSpacing: '0.2px' }}>
                              {contractSubtitle}
                            </div>
                          )}

                          {/* Row 2: Badges */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginBottom: '8px' }}>
                            {/* Trade type tag */}
                            {(() => {
                              const tag = String(t.tradeTypeTag || 'UNKNOWN').toUpperCase()
                              const colors = tag === 'AIT'
                                ? ['rgba(22,163,74,0.12)', '#166534']
                                : tag === 'STRADDLE'
                                  ? ['rgba(201,162,39,0.14)', GOLD_DEEP]
                                  : tag === 'MONITOR'
                                    ? ['rgba(100,116,139,0.14)', '#475569']
                                    : tag === 'RECOVERY'
                                      ? ['rgba(245,158,11,0.14)', '#b45309']
                                      : ['rgba(59,130,246,0.12)', '#1d4ed8']
                              return (
                                <span style={S.badge(colors[0], colors[1])}>{tag}</span>
                              )
                            })()}

                            {/* Option type: normalized from optionType/direction/contract symbol */}
                            {optRaw && (
                              <span style={S.badge(
                                optRaw === 'CALL' ? 'rgba(37,99,235,0.1)' : optRaw === 'PUT' ? 'rgba(124,58,237,0.1)' : 'rgba(0,0,0,0.05)',
                                optRaw === 'CALL' ? '#1d4ed8' : optRaw === 'PUT' ? '#6d28d9' : '#777',
                              )}>{optRaw}</span>
                            )}

                            {/* Entry reason */}
                            {entryBadgeLabel && (
                              <span style={S.badge(entryBadgeBg, entryBadgeColor)}>{entryBadgeLabel}</span>
                            )}
                          </div>

                          {/* Row 3: Strike · Expiry · Qty */}
                          {strikeLine && (
                            <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 600 }}>
                              {strikeLine}
                            </div>
                          )}

                          {entryBadgeLabel && entryMeaning && (
                            <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                              Entry meaning: {entryMeaning}
                            </div>
                          )}
                        </div>

                        {/* Right: P&L + result + buy→sell */}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: '26px', fontWeight: 900, color: accentColor, fontFamily: 'monospace', lineHeight: 1, marginBottom: '6px' }}>
                            {fmtPnl(pnl)}
                          </div>
                          {toNum(t.pnlPct) != null && (
                            <div style={{ fontSize: '12px', fontWeight: 700, color: accentColor, opacity: 0.75, marginBottom: '4px', fontFamily: 'monospace' }}>
                              {fmtPctSigned(t.pnlPct)}
                            </div>
                          )}
                          <div style={{ marginBottom: '8px' }}>
                            {badgeForResult(t.result)}
                          </div>
                          <div style={{ fontSize: '13px', color: 'var(--text)', fontFamily: 'monospace', fontWeight: 600 }}>
                            Buy&nbsp;
                            <span style={{ color: 'var(--text-h)' }}>{t.buyPrice != null ? `$${fmt2(t.buyPrice)}` : '—'}</span>
                            <span style={{ color: '#ddd', margin: '0 5px' }}>→</span>
                            Sell&nbsp;
                            <span style={{ color: 'var(--text-h)' }}>{t.sellPrice != null ? `$${fmt2(t.sellPrice)}` : '—'}</span>
                          </div>
                        </div>
                      </div>

                      {/* ── Footer strip ── */}
                      <div style={{
                        padding: '9px 18px 11px',
                        borderTop: '1px solid #f0f0f0',
                        background: 'var(--bg)',
                        borderRadius: '0 0 11px 11px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '7px',
                      }}>

                        {hasLifecycleTimes && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            {[
                              { label: 'Entry Signal', time: fmtTimeWithSec(entrySignalTime), price: entrySignalPrice },
                              { label: 'Buy Filled', time: fmtTimeWithSec(buyFilledTime), price: buyFilledPrice },
                              { label: 'Exit Signal', time: fmtTimeWithSec(exitSignalTime), price: exitSignalPrice },
                              { label: 'Sell Filled', time: fmtTimeWithSec(sellFilledTime), price: sellFilledPrice },
                            ].map(({ label, time, price }) => (
                              <span key={label} style={{
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                padding: '2px 8px', borderRadius: '6px',
                                background: 'rgba(201,162,39,0.08)', fontSize: '11px',
                              }}>
                                <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</span>
                                <span style={{ color: 'var(--text)', fontFamily: 'monospace', fontWeight: 700 }}>{time || '—'}</span>
                                <span style={{ color: '#aaa' }}>@</span>
                                <span style={{ color: 'var(--text-h)', fontFamily: 'monospace', fontWeight: 800 }}>{price != null ? `$${fmt2(price)}` : '—'}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Line 1: entry → exit time + exit reason */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                          {(t.entryTime || t.exitTime) && (
                            <span style={{ fontSize: '12px', color: 'var(--text)' }}>
                              <span style={{ fontSize: '10px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '5px' }}>Entry</span>
                              <span style={{ fontFamily: 'monospace' }}>{fmtTimeShort(t.entryTime) || '—'}</span>
                              {t.exitTime && (
                                <>
                                  <span style={{ color: '#ddd', margin: '0 5px' }}>→</span>
                                  <span style={{ fontSize: '10px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '5px' }}>Exit</span>
                                  <span style={{ fontFamily: 'monospace' }}>{fmtTimeShort(t.exitTime)}</span>
                                </>
                              )}
                            </span>
                          )}
                          {exitReasonText && (
                            <span style={{ fontSize: '12px', color: 'var(--text)' }}>
                              <span style={{ fontSize: '10px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '5px' }}>Exit</span>
                              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{exitReasonText}</span>
                              {exitMeaning && <span style={{ marginLeft: '6px', color: '#999' }}>({exitMeaning})</span>}
                            </span>
                          )}
                        </div>

                        {/* Line 2: Peak / SL / QP / TP chips from DB */}
                        {hasPeak && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '10px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '2px' }}>Peak</span>
                            {[{
                              label: 'Peak', val: t.peakPnlPct, bg: 'rgba(99,102,241,0.08)', color: '#4338ca',
                            }, {
                              label: 'SL',   val: t.exitSlPct,  bg: 'rgba(220,38,38,0.07)',  color: '#dc2626',
                            }, {
                              label: 'QP',   val: t.exitQpPct,  bg: 'rgba(217,119,6,0.08)',  color: '#d97706',
                            }, {
                              label: 'TP',   val: t.exitTpPct,  bg: 'rgba(22,163,74,0.08)',  color: '#16a34a',
                            }].map(({ label, val, bg, color }) => {
                              const n = toNum(val)
                              if (n == null) return null
                              return (
                                <span key={label} style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '3px',
                                  padding: '2px 8px', borderRadius: '6px',
                                  background: bg, fontSize: '11px', fontWeight: 700,
                                }}>
                                  <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</span>
                                  <span style={{ color, fontFamily: 'monospace' }}>{fmtPctSigned(n)}</span>
                                </span>
                              )
                            })}
                          </div>
                        )}
                        {/* Line 3: Duration + PnL% + Entry Indicators */}
                        {(() => {
                          const dur = toNum(t.tradeDurationSec)
                          const rsi = toNum(t.entryRsi)
                          const rsiMa = toNum(t.entryRsiMa)
                          const rsiGap = toNum(t.entryRsiMaGap)
                          const volRatio = toNum(t.entryVolumeRatio)
                          const bodyRatio = toNum(t.entryBodyRatio)
                          const pullback = toNum(t.entryPullbackPct)
                          const emaBull = t.entryEmaBullish
                          const underlying = toNum(t.entryUnderlyingPrice)
                          const filters = t.entryFiltersPassed
                          const entryVwap = toNum(t.entryVwap)
                          const priceAboveVwap = t.entryPriceAboveVwap
                          const entryStrategyNames = resolveEntryStrategyNames(t)
                          const hasAny = dur != null || rsi != null || volRatio != null || underlying != null || entryVwap != null || entryStrategyNames.length > 0 || (filters && filters.length > 0)
                          if (!hasAny) return null
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              {/* Duration + underlying price */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                {entryStrategyNames.length > 0 && (
                                  <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    padding: '2px 8px', borderRadius: '6px',
                                    background: 'rgba(201,162,39,0.09)', fontSize: '11px',
                                  }}>
                                    <span style={{ fontSize: '9px', fontWeight: 800, color: '#b5973b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Entry Strategy</span>
                                    <span style={{ color: GOLD_DEEP, fontWeight: 800 }}>{entryStrategyNames.join(', ')}</span>
                                  </span>
                                )}
                                {dur != null && (
                                  <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    padding: '2px 8px', borderRadius: '6px',
                                    background: 'rgba(99,102,241,0.08)', fontSize: '11px',
                                  }}>
                                    <Clock size={10} color="#6366f1" />
                                    <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Duration</span>
                                    <span style={{ color: '#4338ca', fontFamily: 'monospace', fontWeight: 700 }}>{fmtDuration(dur)}</span>
                                  </span>
                                )}
                                {underlying != null && (
                                  <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    padding: '2px 8px', borderRadius: '6px',
                                    background: 'rgba(0,0,0,0.04)', fontSize: '11px',
                                  }}>
                                    <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Stock</span>
                                    <span style={{ color: 'var(--text-h)', fontFamily: 'monospace', fontWeight: 700 }}>${fmt2(underlying)}</span>
                                  </span>
                                )}
                              </div>
                              {/* RSI + EMA indicators */}
                              {(rsi != null || rsiGap != null || emaBull != null) && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  {rsi != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: rsi > 50 ? 'rgba(22,163,74,0.08)' : 'rgba(239,68,68,0.08)',
                                      fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>RSI</span>
                                      <span style={{ color: rsi > 50 ? '#16a34a' : '#ef4444', fontFamily: 'monospace' }}>{Number(rsi).toFixed(1)}</span>
                                    </span>
                                  )}
                                  {rsiMa != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: 'rgba(168,85,247,0.08)', fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>RSI-MA</span>
                                      <span style={{ color: '#7c3aed', fontFamily: 'monospace' }}>{Number(rsiMa).toFixed(1)}</span>
                                    </span>
                                  )}
                                  {rsiGap != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: 'rgba(201,162,39,0.08)', fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>Gap</span>
                                      <span style={{ color: GOLD_DEEP, fontFamily: 'monospace' }}>{Number(rsiGap).toFixed(1)}</span>
                                    </span>
                                  )}
                                  {emaBull != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: emaBull ? 'rgba(22,163,74,0.08)' : 'rgba(239,68,68,0.08)',
                                      fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>EMA</span>
                                      <span style={{ color: emaBull ? '#16a34a' : '#ef4444' }}>{emaBull ? '▲ Bull' : '▼ Bear'}</span>
                                    </span>
                                  )}
                                  {volRatio != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: 'rgba(59,130,246,0.08)', fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>Vol</span>
                                      <span style={{ color: '#2563eb', fontFamily: 'monospace' }}>{Number(volRatio).toFixed(2)}x</span>
                                    </span>
                                  )}
                                  {pullback != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: 'rgba(217,119,6,0.08)', fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>Pullback</span>
                                      <span style={{ color: '#d97706', fontFamily: 'monospace' }}>{Number(pullback).toFixed(2)}%</span>
                                    </span>
                                  )}
                                  {entryVwap != null && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                                      padding: '2px 8px', borderRadius: '6px',
                                      background: priceAboveVwap ? 'rgba(22,163,74,0.08)' : 'rgba(239,68,68,0.08)',
                                      fontSize: '11px', fontWeight: 700,
                                    }}>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase' }}>VWAP</span>
                                      <span style={{ color: priceAboveVwap ? '#16a34a' : '#ef4444', fontFamily: 'monospace' }}>${fmt2(entryVwap)}</span>
                                      <span style={{ fontSize: '9px', fontWeight: 800, color: priceAboveVwap ? '#16a34a' : '#ef4444' }}>{priceAboveVwap ? '▲' : '▼'}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                              {/* Filters passed */}
                              {filters && filters.length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '9px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.4px', marginRight: '2px' }}>Filters</span>
                                  {filters.map(f => (
                                    <span key={f} style={{
                                      padding: '1px 6px', borderRadius: '4px',
                                      background: 'rgba(22,163,74,0.08)',
                                      fontSize: '10px', fontWeight: 700, color: '#166534',
                                      textTransform: 'uppercase',
                                    }}>{String(f).replace(/_/g, ' ')}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                        {/* Line 4: Order IDs */}
                        {(t.buyOrderId || t.sellOrderId) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginTop: '1px' }}>
                            {t.buyOrderId && (
                              <span style={{ fontSize: '11px', color: '#aaa', fontFamily: 'monospace' }}>
                                <span style={{ fontSize: '9px', fontWeight: 800, color: '#ccc', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '4px' }}>Buy ID</span>
                                {t.buyOrderId}
                              </span>
                            )}
                            {t.sellOrderId && (
                              <span style={{ fontSize: '11px', color: '#aaa', fontFamily: 'monospace' }}>
                                <span style={{ fontSize: '9px', fontWeight: 800, color: '#ccc', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '4px' }}>Sell ID</span>
                                {t.sellOrderId}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Slippage note */}
                        {isSlippage && (
                          <div style={{
                            display: 'flex', alignItems: 'flex-start', gap: '7px',
                            padding: '7px 10px',
                            background: 'rgba(220,38,38,0.05)',
                            border: '1px solid rgba(220,38,38,0.15)',
                            borderRadius: '7px',
                            marginTop: '2px',
                          }}>
                            <span style={{ fontSize: '13px', lineHeight: 1, marginTop: '1px' }}></span>
                            <span style={{ fontSize: '11px', color: '#b91c1c', lineHeight: '1.5' }}>
                              <strong>Profit exit triggered but filled at a loss.</strong>
                              {slippageDiff !== null && (
                                <> Fill slipped <strong>${Math.abs(Number(slippageDiff)).toFixed(2)}</strong> below breakeven
                                  &nbsp;(Buy ${fmt2(t.buyPrice)} → Sell ${fmt2(t.sellPrice)} = ${Number(slippageDiff).toFixed(2)} per contract × 100).</>
                              )}
                              &nbsp;This is <strong>market slippage</strong> — the option price moved against you between signal detection and the fill.
                            </span>
                          </div>
                        )}

                        {/* ── Tick-by-tick timeline ── */}
                        <TradeTimeline
                          timeline={t.timeline}
                          fillPrice={toNum(t.buyPrice) ?? toNum(t.buyFilledPrice)}
                          qpArmed={t.qpArmed}
                          qpArmTime={t.qpArmTime}
                          qpArmPrice={t.qpArmPrice}
                          qpArmPnlPct={t.qpArmPnlPct}
                          buyFilledTime={buyFilledTime}
                          sellFilledTime={sellFilledTime}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          </div>
        </div>

      </div>
    </div>
  )
}
