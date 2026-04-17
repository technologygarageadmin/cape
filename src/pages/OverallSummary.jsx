import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  TrendingUp, TrendingDown, DollarSign, BarChart3,
  RefreshCw, Filter, Activity, Layers, ChevronDown,
  Circle, ArrowUpRight, ArrowDownRight, Clock, Zap,
  Target, Percent,
} from 'lucide-react'

const API = 'http://localhost:8000'
const GOLD      = '#C9A227'
const GOLD_DEEP = '#A07C10'
const GOLD_LIGHT = '#F5C518'

const SYMBOLS = ['ALL','SPY','QQQ','AAPL','MSFT','NVDA','AMZN','META','TSLA','GOOGL','AMD','NFLX','AVGO']
const DATE_FILTERS  = ['1H','3H','TODAY','WEEK','MONTH','ALL TIME']
const RESULT_FILTERS = ['ALL','WIN','LOSS']

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

function isWithinRange(dateStr, range) {
  if (!dateStr || range === 'ALL TIME') return true
  const d = parseApiDate(dateStr)
  if (!d) return true

  if (range === '1H') {
    return d >= new Date(Date.now() - 60 * 60 * 1000)
  }
  if (range === '3H') {
    return d >= new Date(Date.now() - 3 * 60 * 60 * 1000)
  }

  const nowCDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  if (range === 'TODAY') {
    return cdtDateKey(d) === cdtDateKey(nowCDT)
  }
  if (range === 'WEEK') {
    const w = new Date(nowCDT); w.setDate(w.getDate() - 7); return d >= w
  }
  if (range === 'MONTH') {
    const m = new Date(nowCDT); m.setMonth(m.getMonth() - 1); return d >= m
  }
  return true
}

function reasonLabel(raw) {
  if (!raw) return ''
  return String(raw).replace(/_/g, ' ').trim()
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
            background: '#f9f9f9', borderRadius: '8px', padding: '8px',
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
                <tr style={{ background: '#fdfaf4', position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Time', 'Src', 'Sellable', 'Bid', 'Mid', 'PnL%', 'QP Lmt', 'QP Dyn%', 'Trailing SL Dyn', 'Peak', 'Armed', 'Orders'].map(h => (
                    <th key={h} style={{ padding: '3px 6px', textAlign: 'left', fontWeight: 800, color: '#bbb', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ticks.slice(0, 200).map((tick, idx) => {
                  const isArm = qpArmIdx === idx
                  const isPeak = peakIdx === idx
                  const isEntry = tick.source === 'entry'
                  const isSell = tick.source === 'sell'
                  const isOrder = tick.source === 'order_placed' || tick.source === 'order_replaced'

                  if (isOrder) {
                    const isQP = tick.order_type === 'QP_LIMIT'
                    const isSL = tick.order_type === 'SL_STOP'
                    const isTrail = tick.order_type === 'TRAIL_SL_STOP'
                    const isReplace = tick.source === 'order_replaced'
                    const status = tick.status || 'live'
                    const isError = status === 'error'
                    const statusColor = status === 'filled' ? '#16a34a' : status === 'cancelled' ? '#aaa' : isError ? '#dc2626' : '#d97706'
                    const statusIcon = status === 'filled' ? '✓ FILLED' : status === 'cancelled' ? '✕ CANCELLED' : isError ? '✕ FAILED' : '⏳ LIVE'
                    const rowBg = status === 'filled' ? 'rgba(22,163,74,0.08)' : status === 'cancelled' ? 'rgba(0,0,0,0.03)' : isError ? 'rgba(220,38,38,0.08)' : isQP ? 'rgba(217,119,6,0.05)' : 'rgba(239,68,68,0.05)'
                    const typeLabel = isReplace ? 'ORDER_REPLACED' : (isQP ? 'QP LIMIT' : isTrail ? 'TRAIL SL STOP' : 'SL STOP')
                    const typeColor = isQP ? '#d97706' : '#ef4444'
                    const orderCountText = tick.order_count != null ? `#${tick.order_count}` : '#—'
                    return (
                      <tr key={idx} style={{ background: rowBg, borderLeft: `3px solid ${isError ? '#dc2626' : typeColor}` }}>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#555', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                        <td style={{ padding: '2px 6px', color: isError ? '#dc2626' : typeColor, fontSize: '9px', fontWeight: 800, textTransform: 'uppercase' }}>{typeLabel}</td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: typeColor, fontWeight: 700 }}>
                          {tick.fill_price != null ? `$${fmt2(tick.fill_price)}` : (tick.limit_price != null ? `$${fmt2(tick.limit_price)}` : '—')}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#777' }}>
                          {tick.stop_price != null ? `stop $${fmt2(tick.stop_price)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#777' }}>
                          {tick.limit_price != null ? `lmt $${fmt2(tick.limit_price)}` : '—'}
                        </td>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: typeColor }}>{fmtPctSigned(tick.pct)}</td>
                        <td colSpan={4} style={{ padding: '2px 6px', fontFamily: 'monospace', fontSize: '9px', color: statusColor, fontWeight: 700 }}>
                          {isError
                            ? `✕ FAILED · ${tick.error || 'unknown error'}`
                            : `${statusIcon} · ${orderCountText} · id ${(tick.order_id || '').slice(0, 8)}…`
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
                  return (
                    <tr key={idx} style={{ background: rowBg, fontWeight: isSell ? 700 : undefined }}>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#555', whiteSpace: 'nowrap' }}>{fmtTickTime(tick.ts)}</td>
                      <td style={{ padding: '2px 6px', color: srcColor, textTransform: 'uppercase', fontSize: '9px', fontWeight: 700 }}>{srcLabel}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', fontWeight: 700, color: isSell ? '#ef4444' : '#111' }}>${fmt2(tick.sellable_price)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#777' }}>{tick.bid_price != null ? `$${fmt2(tick.bid_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#777' }}>{tick.mid_price != null ? `$${fmt2(tick.mid_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', fontWeight: 800, color: pnlColor }}>{fmtPctSigned(tick.pnl_pct)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#d97706' }}>{tick.qp_limit_price != null ? `$${fmt2(tick.qp_limit_price)}` : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#d97706' }}>{tick.qp_dynamic_pct > 0 ? fmtPctSigned(tick.qp_dynamic_pct) : '—'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#ef4444' }}>{fmtPctSigned(tick.sl_dynamic_pct)}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: '#6366f1' }}>{fmtPctSigned(tick.max_pnl_pct)}</td>
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
                })}
                {ticks.length > 200 && (
                  <tr>
                    <td colSpan={12} style={{ padding: '4px 6px', textAlign: 'center', color: '#bbb', fontSize: '10px', fontStyle: 'italic' }}>
                      +{ticks.length - 200} more ticks not shown
                    </td>
                  </tr>
                )}
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
  page: { minHeight: '100vh', background: '#f8f8f8' },
  inner: { maxWidth: '1400px', margin: '0 auto', padding: '0 1.5rem 2rem' },

  // page header
  pageHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '1.5rem 0 1.25rem', flexWrap: 'wrap', gap: '1rem',
  },
  pageTitle: { fontSize: '1.7rem', fontWeight: 900, color: '#111', margin: 0, letterSpacing: '-0.02em' },
  pageSub: { fontSize: '0.85rem', color: '#888', marginTop: '0.25rem' },

  // filter bar
  filterBar: {
    display: 'flex', flexWrap: 'wrap', gap: '0.65rem', alignItems: 'center',
    background: '#fff', border: '1px solid rgba(201,162,39,0.18)',
    borderRadius: '12px', padding: '0.65rem 1rem',
    boxShadow: '0 2px 8px rgba(201,162,39,0.06)',
  },
  filterGroup: { display: 'flex', alignItems: 'center', gap: '0.35rem' },
  filterLabel: {
    fontSize: '0.73rem', fontWeight: 700, color: '#bbb',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    display: 'flex', alignItems: 'center', gap: '0.3rem',
    marginRight: '0.15rem',
  },
  btn: (active) => ({
    padding: '0.35rem 0.85rem', borderRadius: '999px', border: 'none', cursor: 'pointer',
    fontSize: '0.78rem', fontWeight: 700, transition: 'all 0.18s',
    background: active ? `linear-gradient(135deg,${GOLD} 0%,${GOLD_LIGHT} 100%)` : 'rgba(201,162,39,0.07)',
    color: active ? '#111' : '#888',
    boxShadow: active ? '0 2px 6px rgba(201,162,39,0.28)' : 'none',
  }),
  divider: { width: '1px', height: '22px', background: 'rgba(201,162,39,0.18)', margin: '0 0.2rem' },

  refreshBtn: {
    display: 'flex', alignItems: 'center', gap: '0.45rem',
    padding: '0.5rem 1.1rem', background: `linear-gradient(135deg,${GOLD} 0%,${GOLD_LIGHT} 100%)`,
    border: 'none', borderRadius: '8px', cursor: 'pointer',
    fontSize: '0.82rem', fontWeight: 700, color: '#111',
    boxShadow: '0 2px 8px rgba(201,162,39,0.22)', transition: 'all 0.2s',
  },

  // stats grid
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '0.9rem', marginBottom: '1.5rem',
  },
  statCard: {
    background: '#fff', borderRadius: '12px',
    border: '1px solid rgba(201,162,39,0.15)',
    padding: '1.1rem 1.25rem',
    boxShadow: '0 2px 10px rgba(201,162,39,0.05)',
  },
  statIcon: (bg) => ({
    width: '34px', height: '34px', borderRadius: '8px',
    background: bg || 'rgba(201,162,39,0.1)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: '0.65rem',
  }),
  statLabel: { fontSize: '0.71rem', fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' },
  statVal: (color) => ({ fontSize: '1.5rem', fontWeight: 900, color: color || '#111', lineHeight: 1 }),
  statSub: { fontSize: '0.7rem', color: '#bbb', marginTop: '0.35rem' },

  // section card
  card: {
    background: '#fff', borderRadius: '14px',
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
  cardTitle: { fontSize: '0.95rem', fontWeight: 800, color: '#111', display: 'flex', alignItems: 'center', gap: '0.55rem' },
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
    background: '#fff',
    boxShadow: pnlPos ? '0 4px 18px rgba(22,163,74,0.07)' : '0 4px 18px rgba(239,68,68,0.07)',
  }),
  posRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.42rem' },
  posKey: { fontSize: '0.72rem', color: '#aaa', fontWeight: 600 },
  posVal: { fontSize: '0.8rem', color: '#111', fontWeight: 700 },

  // table
  tableWrap: { overflowX: 'auto', overflowY: 'auto', maxHeight: '620px', padding: '0 0 0.5rem' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: '1500px' },
  th: {
    textAlign: 'left', padding: '0.75rem 1.1rem',
    fontSize: '0.71rem', fontWeight: 700, color: '#aaa',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    borderBottom: '2px solid rgba(201,162,39,0.12)',
    background: '#fdfaf4', whiteSpace: 'nowrap',
    cursor: 'pointer', userSelect: 'none',
    position: 'sticky', top: 0, zIndex: 2,
  },
  td: {
    padding: '0.82rem 1.1rem', fontSize: '0.85rem', color: '#333',
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
    background: '#fff', fontSize: '0.78rem', fontWeight: 700, color: '#555',
  },
  symbolMenu: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
    background: '#fff', borderRadius: '10px',
    border: '1px solid rgba(201,162,39,0.2)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
    zIndex: 50, minWidth: '130px', overflow: 'hidden',
  },
  symbolOption: (active) => ({
    padding: '0.55rem 1rem', fontSize: '0.81rem', fontWeight: active ? 700 : 500,
    cursor: 'pointer', color: active ? GOLD_DEEP : '#444',
    background: active ? 'rgba(201,162,39,0.08)' : '#fff',
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
function StatCard({ icon, iconBg, label, value, sub, valueColor }) {
  return (
    <div style={S.statCard}>
      <div style={S.statIcon(iconBg)}>{icon}</div>
      <div style={S.statLabel}>{label}</div>
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
  const [sortCol,      setSortCol]      = useState('createdAt')
  const [sortDir,      setSortDir]      = useState('desc')
  const [hideStraddle, setHideStraddle]  = useState(false)
  const [sellingSymbol, setSellingSymbol] = useState(null)
  const alertedPositionKeysRef = useRef(new Set())
  const lastDingAtRef = useRef(0)

  // ── Fetch all data ───────────────────────────────────────────────────────
  const fetchAll = useCallback(async (silent = false) => {
    try {
      const [aitRes, manualRes, posRes, cfgRes, liveRes] = await Promise.allSettled([
        fetch(`${API}/api/options-log?limit=500`),
        fetch(`${API}/api/manual-trades?limit=500`),
        fetch(`${API}/api/positions`),
        fetch(`${API}/api/config`),
        fetch(`${API}/api/live-positions`),
      ])

      if (aitRes.status === 'fulfilled' && aitRes.value.ok) {
        const d = await aitRes.value.json()
        // /api/options-log excludes MANUAL types by backend design.
        const all = (d.trades || []).map(t => {
          const tt = String(t.tradeType || '').toUpperCase()
          const contractName = t.contractName || t.contract_name || t.symbol
          const optionType = normalizeOptionType(t.optionType || t.option_type, t.direction, contractName, t.symbol)
          const tradeTypeTag = tt === 'STRADDLE'
            ? 'STRADDLE'
            : tt === 'MONITOR_EXIT'
              ? 'MONITOR'
              : tt === 'RECOVERY'
                  ? 'RECOVERY'
                  : 'AIT'
          const entryReasonRaw = tt === 'STRADDLE' ? 'STRADDLE' : tt === 'AIT' ? 'AIT' : null
          return { ...t, contractName, optionType, tradeTypeTag, entryReason_raw: entryReasonRaw }
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
      if (liveRes.status === 'fulfilled' && liveRes.value.ok) {
        const d = await liveRes.value.json()
        setLivePositions(d.positions || [])
      }
    } catch (_) {}
    setSpinning(false)
  }, [])

  useEffect(() => {
    fetchAll()
    const id = setInterval(() => fetchAll(true), 5_000)
    return () => clearInterval(id)
  }, [fetchAll])

  // ── Sell position handler ────────────────────────────────────────────────
  const handleSellPosition = async (symbol) => {
    if (!window.confirm(`Sell ${symbol} now to lock in profit?`)) return
    setSellingSymbol(symbol)
    try {
      const res = await fetch(`${API}/api/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' })
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
      const dateOk = isWithinRange(t.createdAt || t.entryTime, dateFilter)
      const resOk  = resultFilter === 'ALL' || t.result === resultFilter
      const symOk  = symbolFilter === 'ALL' || t.symbol === symbolFilter
      return dateOk && resOk && symOk
    })
  ), [allTrades, dateFilter, resultFilter, symbolFilter, hideStraddle])

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
        .trade-card {
          transition: box-shadow 0.18s, transform 0.14s;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          content-visibility: auto;
          contain-intrinsic-size: 320px;
        }
        .trade-card:hover {
          box-shadow: 0 8px 28px rgba(0,0,0,0.12) !important;
          transform: translateY(-2px);
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
        <div style={S.filterBar}>
          {/* Date range */}
          <div style={S.filterGroup}>
            <span style={S.filterLabel}><Activity size={11} /> Period</span>
            {DATE_FILTERS.map(f => (
              <button key={f} style={S.btn(dateFilter === f)} onClick={() => setDateFilter(f)}>{f}</button>
            ))}
          </div>

          <div style={S.divider} />

          {/* Result */}
          <div style={S.filterGroup}>
            <span style={S.filterLabel}><Filter size={11} /> Result</span>
            {RESULT_FILTERS.map(f => (
              <button key={f} style={S.btn(resultFilter === f)} onClick={() => setResultFilter(f)}>{f}</button>
            ))}
          </div>

          <div style={S.divider} />

          {/* Symbol */}
          <div style={S.filterGroup}>
            <span style={S.filterLabel}><Layers size={11} /> Symbol</span>
            <SymbolDropdown value={symbolFilter} onChange={setSymbolFilter} />
          </div>

          <div style={S.divider} />

          {/* Hide Straddle toggle */}
          <div style={S.filterGroup}>
            <span style={S.filterLabel}><Filter size={11} /> Straddle</span>
            <button
              style={{
                padding: '0.35rem 0.85rem', borderRadius: '999px',
                border: `1px solid ${hideStraddle ? 'rgba(239,68,68,0.3)' : 'rgba(22,163,74,0.3)'}`,
                cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700,
                background: hideStraddle ? 'rgba(239,68,68,0.08)' : 'rgba(22,163,74,0.08)',
                color: hideStraddle ? '#ef4444' : '#16a34a',
                display: 'flex', alignItems: 'center', gap: '0.3rem', transition: 'all 0.15s',
              }}
              onClick={() => setHideStraddle(h => !h)}
            >
              {hideStraddle ? '✕ Hidden' : '✓ Included'}
            </button>
          </div>

          {/* Clear filters */}
          {(dateFilter !== 'ALL TIME' || resultFilter !== 'ALL' || symbolFilter !== 'ALL' || !hideStraddle) && (
            <>
              <div style={S.divider} />
              <button
                onClick={() => { setDateFilter('ALL TIME'); setResultFilter('ALL'); setSymbolFilter('ALL'); setHideStraddle(true) }}
                style={{
                  padding: '0.35rem 0.85rem', borderRadius: '999px', border: '1px solid rgba(239,68,68,0.25)',
                  cursor: 'pointer', fontSize: '0.76rem', fontWeight: 700,
                  background: 'rgba(239,68,68,0.06)', color: '#ef4444',
                  display: 'flex', alignItems: 'center', gap: '0.3rem', transition: 'all 0.15s',
                }}
              >
                ✕ Clear Filters
              </button>
            </>
          )}
        </div>

        {/* ── STATS GRID ──────────────────────────────────────────────────── */}
        <div style={{ ...S.statsGrid, marginTop: '1.1rem' }}>
          <StatCard
            icon={<BarChart3 size={16} color={GOLD_DEEP} />}
            iconBg="rgba(201,162,39,0.1)"
            label="Total Trades"
            value={filtered.length}
            sub={`AIT: ${aitCount} · Manual: ${manualCount}${breakevens > 0 ? ' · BE: ' + breakevens : ''}`}
          />
          <StatCard
            icon={<TrendingUp size={16} color="#16a34a" />}
            iconBg="rgba(22,163,74,0.1)"
            label="Wins"
            value={wins}
            sub={`Win Rate: ${winRate}%`}
            valueColor="#16a34a"
          />
          <StatCard
            icon={<TrendingDown size={16} color="#ef4444" />}
            iconBg="rgba(239,68,68,0.1)"
            label="Losses"
            value={losses}
            sub={`${filtered.length > 0 ? ((losses/filtered.length)*100).toFixed(1) : '—'}% loss rate`}
            valueColor="#ef4444"
          />
          <StatCard
            icon={<ArrowUpRight size={16} color="#16a34a" />}
            iconBg="rgba(22,163,74,0.08)"
            label="Total Profit"
            value={`$${fmt2(totalProfit)}`}
            valueColor="#16a34a"
          />
          <StatCard
            icon={<ArrowDownRight size={16} color="#ef4444" />}
            iconBg="rgba(239,68,68,0.08)"
            label="Total Loss"
            value={`$${fmt2(Math.abs(totalLoss))}`}
            valueColor="#ef4444"
          />
          <StatCard
            icon={<DollarSign size={16} color={netPnl >= 0 ? '#16a34a' : '#ef4444'} />}
            iconBg={netPnl >= 0 ? 'rgba(22,163,74,0.1)' : 'rgba(239,68,68,0.1)'}
            label="Net P&L"
            value={fmtPnl(netPnl)}
            sub={`Avg per trade: ${avgPnl !== '—' ? fmtPnl(avgPnl) : '—'}`}
            valueColor={netPnl >= 0 ? '#16a34a' : '#ef4444'}
          />
          <StatCard
            icon={<Clock size={16} color="#6366f1" />}
            iconBg="rgba(99,102,241,0.1)"
            label="Avg Duration"
            value={avgDuration}
            sub={avgPnlPct != null ? `Avg PnL: ${fmtPctSigned(avgPnlPct)}` : null}
            valueColor="#6366f1"
          />
          <StatCard
            icon={<Target size={16} color="#d97706" />}
            iconBg="rgba(217,119,6,0.1)"
            label="Avg Entry RSI"
            value={avgEntryRsi ?? '—'}
            sub={avgEntryRsi ? (Number(avgEntryRsi) > 50 ? 'Bullish bias' : 'Bearish bias') : null}
            valueColor="#d97706"
          />
          <StatCard
            icon={<Zap size={16} color="#16a34a" />}
            iconBg="rgba(22,163,74,0.08)"
            label="Best Trade"
            value={bestTrade != null ? fmtPnl(bestTrade) : '—'}
            sub={worstTrade != null ? `Worst: ${fmtPnl(worstTrade)}` : null}
            valueColor="#16a34a"
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
            <span style={{ fontSize: '0.72rem', color: '#bbb', fontWeight: 600 }}>Live synced · refreshes every 5 s</span>
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

                return (
                  <div key={i} style={S.posCard(isPos)}>

                    {/* ── Accent bar ── */}
                    <div style={{
                      height: '3px',
                      background: isPos
                        ? 'linear-gradient(90deg,#16a34a,#22c55e)'
                        : 'linear-gradient(90deg,#dc2626,#ef4444)',
                    }} />

                    {/* ── Card header: symbol left, P&L right ── */}
                    <div style={{ padding: '0.85rem 1.1rem 0.7rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 900, fontSize: '1.05rem', color: '#111' }}>
                            {opt ? opt.underlying : p.symbol}
                          </span>
                          <span style={{
                            padding: '0.1rem 0.48rem', borderRadius: '4px',
                            fontSize: '0.64rem', fontWeight: 800, textTransform: 'uppercase',
                            background: side === 'LONG' ? 'rgba(22,163,74,0.12)' : 'rgba(239,68,68,0.12)',
                            color: side === 'LONG' ? '#16a34a' : '#ef4444',
                          }}>{side}</span>
                          {opt && (
                            <span style={{
                              padding: '0.1rem 0.48rem', borderRadius: '4px',
                              fontSize: '0.64rem', fontWeight: 800,
                              background: opt.optType === 'CALL' ? 'rgba(59,130,246,0.1)' : 'rgba(168,85,247,0.1)',
                              color: opt.optType === 'CALL' ? '#2563eb' : '#7c3aed',
                            }}>{opt.optType}</span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.69rem', color: '#aaa', marginTop: '0.22rem', fontWeight: 500 }}>
                          {opt
                            ? `${opt.strike} · Exp ${opt.expiry} · Qty ${p.qty}`
                            : `Qty: ${p.qty}`}
                        </div>
                      </div>

                      {/* P&L hero */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: '1.15rem', fontWeight: 900, color: isPos ? '#16a34a' : '#ef4444', lineHeight: 1 }}>
                          {fmtPnl(uPl)}
                        </div>
                        <div style={{ fontSize: '0.71rem', fontWeight: 700, color: isPos ? '#16a34a' : '#ef4444', opacity: 0.75, marginTop: '0.18rem' }}>
                          {fmtPctSigned(curPct)}
                        </div>
                      </div>
                    </div>

                    {/* ── Detail rows ── */}
                    <div style={{ padding: '0.1rem 1.1rem 0.75rem', borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                      {[
                        ...((p.cross_time || p.signal_time) ? [{ k: 'Cross Happen Time', v: fmtDate(p.cross_time || p.signal_time) }] : []),
                        { k: 'Entry Time',    v: fmtDate(p.entry_time) },
                        { k: 'Entry Price',   v: `$${fmt2(p.avg_entry_price)}` },
                        { k: 'Current Price', v: `$${fmt2(p.current_price)}`  },
                        { k: 'Market Value',  v: `$${fmt2(p.market_value)}`   },
                      ].map(({ k, v }) => (
                        <div key={k} style={S.posRow}>
                          <span style={S.posKey}>{k}</span>
                          <span style={S.posVal}>{v}</span>
                        </div>
                      ))}
                      {p.buy_order_id && (
                        <div style={S.posRow}>
                          <span style={S.posKey}>Buy Order ID</span>
                          <span style={{ ...S.posVal, fontFamily: 'monospace', fontSize: '0.67rem', color: '#888', wordBreak: 'break-all' }}>{p.buy_order_id}</span>
                        </div>
                      )}
                    </div>

                    {/* ── Exit criteria section ── */}
                    <div style={{
                      background: 'rgba(201,162,39,0.03)',
                      borderTop: '1px dashed rgba(201,162,39,0.2)',
                      padding: '0.6rem 1.1rem 0.85rem',
                    }}>
                      <div style={{ fontSize: '0.65rem', color: '#bbb', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.55rem' }}>
                        Exit Criteria
                      </div>

                      {/* TP / SL / QP tiles */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.4rem', marginBottom: '0.65rem' }}>
                        {[
                          { label: 'SL', value: fmtPctSigned(snap.slPct), color: '#ef4444', bg: 'rgba(239,68,68,0.07)' },
                          { label: 'QP', value: fmtPctSigned(snap.qpPct), color: '#d97706', bg: 'rgba(245,158,11,0.08)' },
                          { label: 'TP', value: fmtPctSigned(snap.tpPct), color: '#16a34a', bg: 'rgba(22,163,74,0.07)' },
                        ].map(({ label, value, color, bg }) => (
                          <div key={label} style={{ textAlign: 'center', background: bg, borderRadius: '7px', padding: '0.38rem 0.15rem' }}>
                            <div style={{ fontSize: '0.61rem', color: '#bbb', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                            <div style={{ fontSize: '0.84rem', fontWeight: 900, color, marginTop: '0.1rem' }}>{value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Progress bar */}
                      <div style={{ position: 'relative', height: '5px', background: 'rgba(0,0,0,0.07)', borderRadius: '999px' }}>
                        {/* SL marker */}
                        <div style={{
                          position: 'absolute', left: `${toBarPct(snap.slPct)}%`,
                          top: '-4px', width: '2px', height: '13px',
                          background: '#ef4444', borderRadius: '1px', transform: 'translateX(-50%)',
                        }} />
                        {/* QP marker */}
                        <div style={{
                          position: 'absolute', left: `${toBarPct(snap.qpPct)}%`,
                          top: '-4px', width: '2px', height: '13px',
                          background: '#d97706', borderRadius: '1px', transform: 'translateX(-50%)',
                        }} />
                        {/* TP marker */}
                        <div style={{
                          position: 'absolute', left: `${toBarPct(snap.tpPct)}%`,
                          top: '-4px', width: '2px', height: '13px',
                          background: '#16a34a', borderRadius: '1px', transform: 'translateX(-50%)',
                        }} />
                        {/* Fill */}
                        <div style={{
                          position: 'absolute', left: 0, top: 0, height: '100%',
                          width: `${toBarPct(curPct)}%`,
                          background: isPos ? 'rgba(22,163,74,0.35)' : 'rgba(239,68,68,0.35)',
                          borderRadius: '999px 0 0 999px',
                        }} />
                        {/* Current dot */}
                        <div style={{
                          position: 'absolute', left: `${toBarPct(curPct)}%`, top: '50%',
                          width: '11px', height: '11px', borderRadius: '50%',
                          background: isPos ? '#16a34a' : '#ef4444',
                          border: '2px solid #fff',
                          boxShadow: '0 1px 5px rgba(0,0,0,0.22)',
                          transform: 'translate(-50%,-50%)', zIndex: 2,
                        }} />
                      </div>

                      {/* Bar labels */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.38rem' }}>
                        <span style={{ fontSize: '0.59rem', color: '#ef4444', fontWeight: 700 }}>SL {fmtPctSigned(snap.slPct)}</span>
                        <span style={{ fontSize: '0.59rem', fontWeight: 800, color: isPos ? '#16a34a' : '#ef4444' }}>Now {fmtPctSigned(curPct)}</span>
                        <span style={{ fontSize: '0.59rem', color: '#16a34a', fontWeight: 700 }}>TP {fmtPctSigned(snap.tpPct)}</span>
                      </div>
                    </div>

                    {/* ── Sell Now button (when in profit) ── */}
                    {isPos && (
                      <div style={{ padding: '0 1.1rem 0.85rem', textAlign: 'center' }}>
                        <button
                          disabled={sellingSymbol === p.symbol}
                          onClick={() => handleSellPosition(p.symbol)}
                          style={{
                            width: '100%', padding: '0.55rem 0', borderRadius: '8px',
                            border: 'none', cursor: sellingSymbol === p.symbol ? 'wait' : 'pointer',
                            fontSize: '0.82rem', fontWeight: 800, letterSpacing: '0.03em',
                            background: sellingSymbol === p.symbol
                              ? '#ccc'
                              : 'linear-gradient(135deg, #16a34a, #22c55e)',
                            color: '#fff',
                            boxShadow: '0 2px 8px rgba(22,163,74,0.25)',
                            transition: 'all 0.15s',
                          }}
                        >
                          {sellingSymbol === p.symbol ? 'Selling…' : `Sell Now · Lock ${fmtPnl(uPl)}`}
                        </button>
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
                        background: '#ffffff',
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
                            <span style={{ fontWeight: 900, fontSize: '20px', color: '#111', letterSpacing: '-0.4px', lineHeight: 1 }}>
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
                              const tag = String(t.tradeTypeTag || 'AIT').toUpperCase()
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
                            <div style={{ fontSize: '13px', color: '#666', fontWeight: 600 }}>
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
                          <div style={{ fontSize: '13px', color: '#888', fontFamily: 'monospace', fontWeight: 600 }}>
                            Buy&nbsp;
                            <span style={{ color: '#333' }}>{t.buyPrice != null ? `$${fmt2(t.buyPrice)}` : '—'}</span>
                            <span style={{ color: '#ddd', margin: '0 5px' }}>→</span>
                            Sell&nbsp;
                            <span style={{ color: '#333' }}>{t.sellPrice != null ? `$${fmt2(t.sellPrice)}` : '—'}</span>
                          </div>
                        </div>
                      </div>

                      {/* ── Footer strip ── */}
                      <div style={{
                        padding: '9px 18px 11px',
                        borderTop: '1px solid #f0f0f0',
                        background: '#fafafa',
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
                                <span style={{ color: '#555', fontFamily: 'monospace', fontWeight: 700 }}>{time || '—'}</span>
                                <span style={{ color: '#aaa' }}>@</span>
                                <span style={{ color: '#333', fontFamily: 'monospace', fontWeight: 800 }}>{price != null ? `$${fmt2(price)}` : '—'}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Line 1: entry → exit time + exit reason */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                          {(t.entryTime || t.exitTime) && (
                            <span style={{ fontSize: '12px', color: '#777' }}>
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
                            <span style={{ fontSize: '12px', color: '#777' }}>
                              <span style={{ fontSize: '10px', fontWeight: 800, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '5px' }}>Exit</span>
                              <span style={{ fontWeight: 700, color: '#555' }}>{exitReasonText}</span>
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
                          const hasAny = dur != null || rsi != null || volRatio != null || underlying != null || entryVwap != null || (filters && filters.length > 0)
                          if (!hasAny) return null
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              {/* Duration + underlying price */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
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
                                    <span style={{ color: '#333', fontFamily: 'monospace', fontWeight: 700 }}>${fmt2(underlying)}</span>
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
