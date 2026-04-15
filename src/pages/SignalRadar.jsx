import React, { useState, useEffect, useRef } from 'react'
import {
  Activity, TrendingUp, TrendingDown, Eye, Zap, Radio,
  CheckCircle, XCircle, AlertTriangle, ChevronDown, ChevronUp,
  RefreshCw, Crosshair, Shield, Target, Power, Wifi, WifiOff,
  ArrowUpRight, ArrowDownRight, Clock, BarChart2, Info
} from 'lucide-react'

const GOLD = '#C9A227'
const GOLD_LIGHT = '#F5C518'
const GOLD_DEEP = '#A07C10'
const API = 'http://localhost:8000'

const MODE_CONFIG = {
  AIT:  { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.2)',  icon: Zap,     label: 'AIT — Auto Trading' },
  MT:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.2)', icon: Target,  label: 'MT — Manual Trading' },
  OFF:  { color: '#888',    bg: 'rgba(0,0,0,0.04)',     border: 'rgba(0,0,0,0.08)',     icon: WifiOff, label: 'OFF — Paused' },
}

const STATUS_CONFIG = {
  CALL_READY:   { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  text: 'CALL READY!',   pulse: true },
  PUT_READY:    { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  text: 'PUT READY!',    pulse: true },
  CALL_WARMING: { color: '#22c55e', bg: 'rgba(34,197,94,0.08)',  text: 'CALL Warming',  pulse: false },
  PUT_WARMING:  { color: '#ef4444', bg: 'rgba(239,68,68,0.08)',  text: 'PUT Warming',   pulse: false },
  BUILDING:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', text: 'Building',      pulse: false },
  SCANNING:     { color: '#888',    bg: 'rgba(0,0,0,0.04)',      text: 'Scanning...',   pulse: false },
  OFF:          { color: '#666',    bg: 'rgba(0,0,0,0.04)',      text: 'Offline',       pulse: false },
  ERROR:        { color: '#ef4444', bg: 'rgba(239,68,68,0.06)',  text: 'Error',         pulse: false },
  NO_DATA:      { color: '#888',    bg: 'rgba(0,0,0,0.04)',      text: 'No Data',       pulse: false },
}

// ── Circular gauge component ──
function CircularGauge({ value, size = 120, strokeWidth = 10, color, label, sublabel }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference
  const center = size / 2

  return (
    <div style={{ textAlign: 'center', position: 'relative' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={center} cy={center} r={radius}
          fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={strokeWidth} />
        <circle cx={center} cy={center} r={radius}
          fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.5s ease' }} />
      </svg>
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <span style={{ fontSize: size * 0.22, fontWeight: 800, color }}>{value}%</span>
        <span style={{ fontSize: size * 0.11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      </div>
      {sublabel && <div style={{ fontSize: '0.7rem', color: '#888', marginTop: '0.3rem' }}>{sublabel}</div>}
    </div>
  )
}

// ── Filter checklist ──
function FilterChecklist({ filters, direction }) {
  const order = ['time_window', 'rsi_cross', 'rsi_gap', 'ema_regime', 'ema_triple', 'rsi_level', 'pullback', 'momentum', 'volume', 'extreme', 'streak', 'candle', 'vwap', 'price_structure']
  const labels = {
    time_window:     'Time Window',
    rsi_cross:       'RSI Cross',
    rsi_gap:         'RSI-MA Gap',
    ema_regime:      'EMA 9/21',
    ema_triple:      'EMA Stack',
    rsi_level:       'RSI Level',
    pullback:        'Pullback',
    momentum:        'Momentum',
    volume:          'Volume',
    extreme:         'Extreme',
    streak:          'Streak',
    candle:          'Candle',
    vwap:            'VWAP',
    price_structure: 'Structure',
  }

  const tooltips = {
    time_window:     'Trade only in the two ET windows: 9:45–10:45 AM and 1:15–2:15 PM. Every losing trade today was outside these windows. Non-negotiable Tier 1 kill switch.',
    rsi_cross:       'RSI must cross above its Moving Average (CALL) or below (PUT). This is the primary trigger for a trade signal.',
    rsi_gap:         'The gap between RSI and its MA must be ≥3.0 points. Filters out weak/noisy crosses where RSI barely edges past the MA. (Tier 1 hard requirement)',
    ema_regime:      'EMA 9 must be above EMA 21 for CALL (bullish trend) or below for PUT (bearish trend). Ensures you trade with the trend.',
    ema_triple:      'Full three-EMA fan: EMA9 > EMA21 > EMA55 for CALL (EMA9 < EMA21 < EMA55 for PUT). Trend is fully aligned across timeframes. (Tier 2 strong add)',
    rsi_level:       'RSI must be in the 35–58 zone at cross. Below 35 = oversold bounce with runway. Above 58 = already extended, limited upside before overbought. (Tier 1 hard requirement)',
    pullback:        'Price must be within 0.35% of the 9 EMA. Ensures entry near a support/resistance level rather than chasing an extended move.',
    momentum:        'RSI must be actively moving in the signal direction (delta ≥4.0). Filters sluggish or flattening RSI after a cross. (Tier 2 strong add)',
    volume:          'Current bar volume must be at least 2.0× the 20-bar average. 2x+ means institutions are in the move. (Tier 2 strong add)',
    extreme:         'RSI must be < 58 for CALL (not extended) or > 42 for PUT (not oversold). Avoids entering at the top/bottom of a move. (Tier 1)',
    streak:          'RSI streak must be exactly 2 bars for a CALL/PUT entry. Streak 2 = fresh momentum (ideal). Streak 3 = marginal, rejected. Streak 4+ = exhaustion, wait for reset. Streak 5+ = near-certain reversal — entering here means buying someone else\u2019s exit.',
    candle:          'Current candle body must be ≥60% of its range, and in the right direction (bullish for CALL, bearish for PUT). Strong body = buyers/sellers in control through the whole candle. (Tier 2)',
    vwap:            'Price must be above VWAP for CALL (institutional tailwind) or below VWAP for PUT. Calls below VWAP are fighting the dominant intraday flow. (Tier 1)',
    price_structure: 'Trigger candle must show a bullish pattern (engulfing, hammer, pin bar) for CALL, or bearish pattern for PUT. Inside bar / doji = no directional edge, skip the trade. (Tier 1)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      {order.map(key => {
        const f = filters[key]
        if (!f) return null
        return (
          <div key={key} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.35rem 0.6rem',
            borderRadius: '8px',
            background: f.passed ? (direction === 'call' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)') : 'rgba(0,0,0,0.02)',
            transition: 'all 0.3s ease',
          }}>
            {f.passed
              ? <CheckCircle size={13} color={direction === 'call' ? '#22c55e' : '#ef4444'} />
              : <XCircle size={13} color="#ccc" />
            }
            <span style={{
              fontSize: '0.72rem', fontWeight: 600, color: '#555',
              minWidth: '70px', display: 'flex', alignItems: 'center', gap: '0.3rem',
            }}>
              {labels[key]}
              <span style={{ position: 'relative', display: 'inline-flex', cursor: 'help' }} title={tooltips[key]}>
                <Info size={11} color="#bbb" />
              </span>
            </span>
            <span style={{
              fontSize: '0.7rem', color: f.passed ? '#333' : '#999',
              flex: 1,
            }}>{f.note}</span>
            <span style={{
              fontSize: '0.68rem', fontWeight: 700,
              color: f.pts > 0 ? (direction === 'call' ? '#22c55e' : '#ef4444') : '#ccc',
              minWidth: '30px', textAlign: 'right',
            }}>+{f.pts}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── RSI Momentum bar ──
function RSIMomentumBar({ rsi, rsiMa }) {
  const rsiPos = Math.max(0, Math.min(100, rsi))
  const maPos = Math.max(0, Math.min(100, rsiMa))

  return (
    <div style={{ position: 'relative', height: '28px', borderRadius: '14px', overflow: 'hidden', background: 'rgba(0,0,0,0.04)' }}>
      {/* Zone markers — valid CALL zone 35–58, valid PUT zone 42–65 */}
      <div style={{ position: 'absolute', left: '35%', top: 0, bottom: 0, width: '1px', background: 'rgba(239,68,68,0.25)' }} />
      <div style={{ position: 'absolute', left: '42%', top: 0, bottom: 0, width: '1px', background: 'rgba(245,158,11,0.2)' }} />
      <div style={{ position: 'absolute', left: '55%', top: 0, bottom: 0, width: '1px', background: 'rgba(245,158,11,0.2)' }} />
      <div style={{ position: 'absolute', left: '58%', top: 0, bottom: 0, width: '1px', background: 'rgba(34,197,94,0.25)' }} />
      {/* Valid CALL zone: 35–58 (green band) */}
      <div style={{ position: 'absolute', left: '35%', top: 0, bottom: 0, width: '23%', background: 'rgba(34,197,94,0.04)' }} />
      {/* Valid PUT zone: 42–65 (red band) */}
      <div style={{ position: 'absolute', left: '0', top: 0, bottom: 0, width: '35%', background: 'rgba(239,68,68,0.04)' }} />
      {/* RSI MA marker */}
      <div style={{
        position: 'absolute', left: `${maPos}%`, top: '4px', bottom: '4px',
        width: '3px', borderRadius: '2px',
        background: 'rgba(201,162,39,0.5)',
        transform: 'translateX(-50%)',
        transition: 'left 0.6s ease',
      }} />
      {/* RSI dot */}
      <div style={{
        position: 'absolute', left: `${rsiPos}%`, top: '50%',
        width: '20px', height: '20px', borderRadius: '50%',
        background: rsi >= 35 && rsi <= 58 ? '#22c55e' : rsi <= 42 || rsi > 58 ? '#ef4444' : '#f59e0b',
        border: '2px solid #fff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        transform: 'translate(-50%, -50%)',
        transition: 'left 0.6s ease, background 0.3s ease',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.55rem', fontWeight: 800, color: '#fff',
      }}>
        {rsi.toFixed(0)}
      </div>
      {/* Labels */}
      <span style={{ position: 'absolute', left: '4px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.55rem', color: '#bbb', fontWeight: 500 }}>0</span>
      <span style={{ position: 'absolute', left: '35%', top: '2px', transform: 'translateX(-50%)', fontSize: '0.48rem', color: '#22c55e88', fontWeight: 600 }}>35</span>
      <span style={{ position: 'absolute', left: '58%', top: '2px', transform: 'translateX(-50%)', fontSize: '0.48rem', color: '#22c55e88', fontWeight: 600 }}>58</span>
      <span style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.55rem', color: '#bbb', fontWeight: 500 }}>100</span>
    </div>
  )
}

// ── Trend streak visual ──
function TrendStreak({ upStreak, downStreak }) {
  const bars = 10
  // Color up bars by exhaustion: ≤2 = green (fresh), 3 = orange (marginal), 4+ = red (exhausted)
  const upColor = upStreak <= 2 ? '#22c55e' : upStreak === 3 ? '#f59e0b' : '#ef4444'
  const downColor = downStreak <= 2 ? '#ef4444' : downStreak === 3 ? '#f59e0b' : '#f97316'
  return (
    <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '24px' }}>
      {Array.from({ length: bars }, (_, i) => {
        const isUp = i < upStreak
        const isDown = i < downStreak
        return (
          <div key={i} style={{
            width: '6px',
            height: isUp ? `${40 + i * 6}%` : isDown ? `${40 + i * 6}%` : '20%',
            borderRadius: '2px',
            background: isUp ? upColor : isDown ? downColor : 'rgba(0,0,0,0.06)',
            transition: 'all 0.4s ease',
          }} />
        )
      })}
    </div>
  )
}

// ── Symbol card ──
function SymbolCard({ data, onModeChange }) {
  const [expanded, setExpanded] = useState(false)
  const modeConf = MODE_CONFIG[data.mode_label] || MODE_CONFIG.OFF
  const statusConf = STATUS_CONFIG[data.status] || STATUS_CONFIG.SCANNING
  const ModeIcon = modeConf.icon
  const dominantScore = Math.max(data.call_score, data.put_score)
  const dominantSide = data.call_score >= data.put_score ? 'CALL' : 'PUT'
  const dominantColor = dominantSide === 'CALL' ? '#22c55e' : '#ef4444'
  const isOff = data.mode === 'off'

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${isOff ? 'rgba(0,0,0,0.06)' : 'rgba(201,162,39,0.12)'}`,
      borderRadius: '16px',
      overflow: 'hidden',
      boxShadow: statusConf.pulse ? `0 4px 24px ${statusConf.color}20` : '0 2px 12px rgba(0,0,0,0.04)',
      transition: 'all 0.3s ease',
      opacity: isOff ? 0.6 : 1,
    }}>
      {/* Top accent bar */}
      {!isOff && (
        <div style={{
          height: '3px',
          background: dominantScore >= 70
            ? `linear-gradient(90deg, ${dominantColor}, ${dominantColor}80)`
            : 'linear-gradient(90deg, rgba(201,162,39,0.3), rgba(201,162,39,0.1))',
          transition: 'background 0.5s ease',
        }} />
      )}

      {/* Main row */}
      <div style={{
        padding: '1.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1.25rem',
        cursor: isOff ? 'default' : 'pointer',
      }} onClick={() => !isOff && setExpanded(!expanded)}>
        {/* Symbol + Mode */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '90px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#111' }}>{data.symbol}</span>
            {statusConf.pulse && (
              <span style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: statusConf.color,
                boxShadow: `0 0 10px ${statusConf.color}80`,
                animation: 'radarPulse 1.5s infinite',
              }} />
            )}
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            padding: '0.2rem 0.5rem', borderRadius: '6px',
            background: modeConf.bg, border: `1px solid ${modeConf.border}`,
            width: 'fit-content',
          }}>
            <ModeIcon size={11} color={modeConf.color} />
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: modeConf.color }}>{data.mode_label}</span>
          </div>
        </div>

        {/* Price */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: '80px' }}>
          <span style={{ fontSize: '0.65rem', color: '#999', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Price</span>
          <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#111' }}>
            {data.price != null ? `$${data.price.toFixed(2)}` : '—'}
          </span>
        </div>

        {/* RSI */}
        {!isOff && data.rsi != null && (
          <div style={{ flex: 1, minWidth: '160px', maxWidth: '280px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
              <span style={{ fontSize: '0.65rem', color: '#999', fontWeight: 600 }}>RSI</span>
              <span style={{ fontSize: '0.65rem', color: '#999' }}>
                MA: {data.rsi_ma?.toFixed(1)} | Gap: <span style={{ color: data.rsi_gap >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{data.rsi_gap >= 0 ? '+' : ''}{data.rsi_gap?.toFixed(1)}</span>
              </span>
            </div>
            <RSIMomentumBar rsi={data.rsi} rsiMa={data.rsi_ma || 50} />
          </div>
        )}

        {/* Gauges */}
        {!isOff && (
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <CircularGauge
              value={data.call_score} size={80} strokeWidth={7}
              color={data.call_score >= 70 ? '#22c55e' : data.call_score >= 40 ? '#86efac' : '#ddd'}
              label="CALL"
            />
            <CircularGauge
              value={data.put_score} size={80} strokeWidth={7}
              color={data.put_score >= 70 ? '#ef4444' : data.put_score >= 40 ? '#fca5a5' : '#ddd'}
              label="PUT"
            />
          </div>
        )}

        {/* Status + trend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'flex-end', minWidth: '100px' }}>
          <span style={{
            padding: '0.25rem 0.7rem', borderRadius: '20px',
            fontSize: '0.7rem', fontWeight: 700,
            background: statusConf.bg, color: statusConf.color,
            ...(statusConf.pulse ? { animation: 'statusGlow 2s infinite' } : {}),
          }}>
            {statusConf.text}
          </span>
          {data.trend && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              {data.trend === 'UPTREND' ? <ArrowUpRight size={13} color="#22c55e" /> :
               data.trend === 'DOWNTREND' ? <ArrowDownRight size={13} color="#ef4444" /> :
               <Activity size={13} color="#f59e0b" />}
              <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#888' }}>{data.trend}</span>
            </div>
          )}
          {data.ema_regime && (
            <span style={{
              fontSize: '0.62rem', fontWeight: 600,
              color: data.ema_regime === 'BULLISH' ? '#22c55e' : '#ef4444',
            }}>
              EMA: {data.ema_regime}
            </span>
          )}
          {!isOff && (
            <span onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
              {expanded ? <ChevronUp size={16} color="#999" /> : <ChevronDown size={16} color="#999" />}
            </span>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && !isOff && (
        <div style={{
          padding: '0 1.25rem 1.25rem',
          borderTop: '1px solid rgba(0,0,0,0.05)',
        }}>
          {/* Mode switcher */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '0.75rem 0',
          }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#888' }}>MODE:</span>
            {['auto', 'manual', 'off'].map(m => {
              const ml = { auto: 'AIT', manual: 'MT', off: 'OFF' }[m]
              const mc = MODE_CONFIG[ml]
              const active = data.mode === m
              return (
                <button key={m} onClick={(e) => { e.stopPropagation(); onModeChange(data.symbol, m) }}
                  style={{
                    padding: '0.35rem 0.8rem', borderRadius: '8px',
                    fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${active ? mc.color : 'rgba(0,0,0,0.08)'}`,
                    background: active ? mc.bg : 'transparent',
                    color: active ? mc.color : '#888',
                    transition: 'all 0.2s ease',
                  }}>
                  {ml}
                </button>
              )
            })}
          </div>

          {/* Indicators row */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.6rem',
            padding: '0.75rem 0',
            borderTop: '1px solid rgba(0,0,0,0.04)',
          }}>
            {[
              { label: 'RSI', value: data.rsi?.toFixed(1), color: data.rsi >= 35 && data.rsi <= 58 ? '#22c55e' : '#ef4444' },
              { label: 'RSI Gap', value: data.rsi_gap != null ? `${data.rsi_gap >= 0 ? '+' : ''}${data.rsi_gap.toFixed(1)}` : '—', color: data.rsi_gap >= 3.0 ? '#22c55e' : data.rsi_gap >= 1.5 ? '#f59e0b' : '#ef4444' },
              { label: 'EMA9', value: data.ema_fast ? `$${data.ema_fast.toFixed(2)}` : '—', color: '#111' },
              { label: 'EMA21', value: data.ema_slow ? `$${data.ema_slow.toFixed(2)}` : '—', color: '#111' },
              { label: 'EMA55', value: data.ema_third ? `$${data.ema_third.toFixed(2)}` : '—', color: data.ema_triple_bull ? '#22c55e' : data.ema_triple_bear ? '#ef4444' : '#888' },
              { label: 'Momentum Δ', value: data.rsi_delta != null ? `${data.rsi_delta >= 0 ? '+' : ''}${data.rsi_delta.toFixed(1)}` : '—', color: Math.abs(data.rsi_delta ?? 0) >= 4.0 ? '#22c55e' : '#f59e0b' },
              { label: 'Volume', value: data.volume_ratio != null ? `${data.volume_ratio.toFixed(1)}x` : '—', color: (data.volume_ratio ?? 0) >= 2.0 ? '#22c55e' : (data.volume_ratio ?? 0) >= 1.2 ? '#f59e0b' : '#ef4444' },
              { label: 'Body', value: data.body_ratio != null ? `${(data.body_ratio * 100).toFixed(0)}%` : '—', color: (data.body_ratio ?? 0) >= 0.60 ? '#22c55e' : (data.body_ratio ?? 0) >= 0.35 ? '#f59e0b' : '#ef4444' },
              { label: 'Pullback', value: data.pullback_pct != null ? `${data.pullback_pct.toFixed(2)}%` : '—', color: data.pullback_pct <= 0.35 ? '#22c55e' : '#f59e0b' },
              { label: 'VWAP', value: data.vwap ? `$${data.vwap.toFixed(2)}` : '—', color: data.price_above_vwap === true ? '#22c55e' : data.price_above_vwap === false ? '#ef4444' : '#888' },
            ].map((ind, i) => (
              <div key={i} style={{
                background: 'rgba(0,0,0,0.02)', borderRadius: '8px', padding: '0.5rem',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
              }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ind.label}</span>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: ind.color }}>{ind.value}</span>
              </div>
            ))}
          </div>

          {/* Cross signals */}
          <div style={{
            display: 'flex', gap: '0.5rem', padding: '0.5rem 0',
            flexWrap: 'wrap',
          }}>
            {data.in_trade_window === false && (
              <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(239,68,68,0.1)', color: '#dc2626' }}>⏰ Outside Trade Window</span>
            )}
            {data.in_trade_window === true && (
              <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(34,197,94,0.1)', color: '#16a34a' }}>✓ In Trade Window</span>
            )}
            {data.cross_up && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}>⚡ RSI Cross UP (current bar)</span>}
            {data.prev_cross_up && !data.cross_up && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(34,197,94,0.08)', color: '#22c55e' }}>RSI Cross UP (prev bar)</span>}
            {data.cross_down && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(239,68,68,0.12)', color: '#dc2626' }}>⚡ RSI Cross DOWN (current bar)</span>}
            {data.prev_cross_down && !data.cross_down && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}>RSI Cross DOWN (prev bar)</span>}
            {data.ema_triple_bull && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(34,197,94,0.1)', color: '#16a34a' }}>↑ EMA9 &gt; EMA21 &gt; EMA55</span>}
            {data.ema_triple_bear && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, background: 'rgba(239,68,68,0.1)', color: '#dc2626' }}>↓ EMA9 &lt; EMA21 &lt; EMA55</span>}
            {data.price_structure && data.price_structure !== 'NONE' && (
              <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700,
                background: data.price_structure_bullish ? 'rgba(34,197,94,0.1)' : data.price_structure_bearish ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                color: data.price_structure_bullish ? '#16a34a' : data.price_structure_bearish ? '#dc2626' : '#d97706',
              }}>📊 {data.price_structure?.replace(/_/g, ' ')}</span>
            )}
            {data.price_above_vwap === true && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(34,197,94,0.06)', color: '#22c55e' }}>Price ↑ VWAP</span>}
            {data.price_above_vwap === false && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(239,68,68,0.06)', color: '#ef4444' }}>Price ↓ VWAP</span>}
            {data.is_bullish_candle && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(34,197,94,0.06)', color: '#22c55e' }}>Bullish Candle</span>}
            {data.is_bearish_candle && <span style={{ padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600, background: 'rgba(239,68,68,0.06)', color: '#ef4444' }}>Bearish Candle</span>}
          </div>

          {/* Streak */}
          {(data.up_streak > 0 || data.down_streak > 0) && (
            <div style={{ padding: '0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#999' }}>MOMENTUM:</span>
              <TrendStreak upStreak={data.up_streak || 0} downStreak={data.down_streak || 0} />
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color:
                data.up_streak > 0
                  ? (data.up_streak <= 2 ? '#22c55e' : data.up_streak === 3 ? '#f59e0b' : '#ef4444')
                  : '#ef4444'
              }}>
                {data.up_streak > 0
                  ? `${data.up_streak} bars rising${data.up_streak === 3 ? ' ⚠ marginal' : data.up_streak >= 4 ? ' ✗ exhausted' : ''}`
                  : `${data.down_streak} bars falling${data.down_streak === 3 ? ' ⚠ marginal' : data.down_streak >= 4 ? ' ✗ exhausted' : ''}`}
              </span>
            </div>
          )}

          {/* Filter breakdown */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem',
            padding: '0.75rem 0',
            borderTop: '1px solid rgba(0,0,0,0.04)',
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <TrendingUp size={14} color="#22c55e" />
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#22c55e' }}>CALL Filters ({data.call_score}/100)</span>
              </div>
              {data.call_filters && <FilterChecklist filters={data.call_filters} direction="call" />}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <TrendingDown size={14} color="#ef4444" />
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#ef4444' }}>PUT Filters ({data.put_score}/100)</span>
              </div>
              {data.put_filters && <FilterChecklist filters={data.put_filters} direction="put" />}
            </div>
          </div>

          {/* Bar time */}
          {data.bar_time && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(0,0,0,0.04)' }}>
              <Clock size={12} color="#999" />
              <span style={{ fontSize: '0.68rem', color: '#999' }}>
                Last bar: {new Date(data.bar_time).toLocaleTimeString()}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Heatmap summary ──
function Heatmap({ symbols }) {
  const active = symbols.filter(s => s.mode !== 'off')
  if (active.length === 0) return null

  return (
    <div style={{
      display: 'flex', gap: '0.5rem', flexWrap: 'wrap',
      padding: '1rem',
      background: 'rgba(0,0,0,0.02)',
      borderRadius: '12px',
      marginBottom: '1.5rem',
    }}>
      {active.map(s => {
        const score = Math.max(s.call_score, s.put_score)
        const side = s.call_score >= s.put_score ? 'call' : 'put'
        const baseColor = side === 'call' ? [34, 197, 94] : [239, 68, 68]
        const alpha = Math.max(0.08, score / 100 * 0.7)

        return (
          <div key={s.symbol} style={{
            padding: '0.5rem 0.8rem',
            borderRadius: '10px',
            background: `rgba(${baseColor.join(',')}, ${alpha})`,
            border: score >= 70 ? `1px solid rgba(${baseColor.join(',')}, 0.4)` : '1px solid transparent',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem',
            minWidth: '60px',
            transition: 'all 0.4s ease',
          }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#111' }}>{s.symbol}</span>
            <span style={{
              fontSize: '0.9rem', fontWeight: 800,
              color: score >= 70 ? (side === 'call' ? '#16a34a' : '#dc2626') : '#888',
            }}>{score}%</span>
            <span style={{
              fontSize: '0.55rem', fontWeight: 600, textTransform: 'uppercase',
              color: side === 'call' ? '#22c55e' : '#ef4444',
            }}>{side}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Main page ──
export default function SignalRadar() {
  const [symbols, setSymbols] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)

  const fetchData = async () => {
    try {
      const res = await fetch(`${API}/api/signal-readiness`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSymbols(data.symbols || [])
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleModeChange = async (symbol, mode) => {
    try {
      const res = await fetch(`${API}/api/symbol/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Refresh immediately
      fetchData()
    } catch (err) {
      console.error('Failed to set mode:', err)
    }
  }

  useEffect(() => {
    fetchData()
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 5000)
    }
    return () => clearInterval(intervalRef.current)
  }, [autoRefresh])

  const activeCount = symbols.filter(s => s.mode !== 'off').length
  const hotCount = symbols.filter(s => s.call_score >= 70 || s.put_score >= 70).length
  const readyCount = symbols.filter(s => s.status === 'CALL_READY' || s.status === 'PUT_READY').length

  return (
    <div style={{ width: '100%' }}>
      <style>{`
        @keyframes radarPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }
        @keyframes statusGlow {
          0%, 100% { box-shadow: none; }
          50% { box-shadow: 0 0 12px currentColor; }
        }
        @keyframes radarSweep {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      {/* Banner */}
      <div style={{
        background: 'linear-gradient(135deg, #111 0%, #1a1a1a 40%, #2a2000 100%)',
        borderRadius: '16px',
        padding: '2rem',
        marginBottom: '1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '2rem',
        boxShadow: '0 8px 32px rgba(201,162,39,0.15)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: '-40%', right: '-5%',
          width: '300px', height: '300px', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(201,162,39,0.18) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />

        {/* Radar icon */}
        <div style={{ position: 'relative', width: '70px', height: '70px', flexShrink: 0, zIndex: 1 }}>
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: '50%',
            border: `2px solid ${GOLD}40`,
          }} />
          <div style={{
            position: 'absolute', inset: '15%',
            borderRadius: '50%',
            border: `1px solid ${GOLD}30`,
          }} />
          <div style={{
            position: 'absolute', inset: '35%',
            borderRadius: '50%',
            background: GOLD,
            opacity: 0.4,
          }} />
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            width: '50%', height: '2px',
            background: `linear-gradient(90deg, ${GOLD}, transparent)`,
            transformOrigin: '0% 50%',
            animation: 'radarSweep 3s linear infinite',
          }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', zIndex: 1, flex: 1 }}>
          <div style={{ fontSize: '0.8rem', color: '#888', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 500 }}>Signal Radar</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#fff', lineHeight: 1.1 }}>
            Waiting for <span style={{ color: GOLD }}>Signals</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
            {readyCount > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.6)', animation: 'radarPulse 1.5s infinite' }} />
                <span style={{ fontSize: '0.8rem', color: '#22c55e', fontWeight: 600 }}>{readyCount} signal{readyCount > 1 ? 's' : ''} ready!</span>
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: '#aaa', fontWeight: 500 }}>
              {activeCount} symbol{activeCount !== 1 ? 's' : ''} active
              {hotCount > 0 && ` · ${hotCount} warming up`}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '2rem', zIndex: 1, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.7rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Hot Signals</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: hotCount > 0 ? '#22c55e' : '#555' }}>{hotCount}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.7rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Ready</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: readyCount > 0 ? GOLD : '#555' }}>{readyCount}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setAutoRefresh(!autoRefresh)} style={{
                background: autoRefresh ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.08)',
                border: `1px solid ${autoRefresh ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: '8px',
                padding: '0.4rem 0.8rem',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                color: autoRefresh ? '#22c55e' : '#888',
                fontSize: '0.72rem', fontWeight: 600,
                transition: 'all 0.2s ease',
              }}>
                {autoRefresh ? <Wifi size={12} /> : <WifiOff size={12} />}
                {autoRefresh ? 'Live' : 'Paused'}
              </button>
              <button onClick={fetchData} style={{
                background: 'rgba(201,162,39,0.15)',
                border: '1px solid rgba(201,162,39,0.3)',
                borderRadius: '8px',
                padding: '0.4rem 0.8rem',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                color: GOLD,
                fontSize: '0.72rem', fontWeight: 600,
                transition: 'all 0.2s ease',
              }}>
                <RefreshCw size={12} />
              </button>
            </div>
            {lastUpdate && (
              <span style={{ fontSize: '0.6rem', color: '#555' }}>
                Updated {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Heatmap overview */}
      <Heatmap symbols={symbols} />

      {/* Error banner */}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.04)',
          border: '1px solid rgba(239,68,68,0.15)',
          borderLeft: '4px solid #ef4444',
          borderRadius: '10px',
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          display: 'flex', alignItems: 'center', gap: '0.5rem',
        }}>
          <AlertTriangle size={16} color="#ef4444" />
          <span style={{ fontSize: '0.82rem', color: '#dc2626', fontWeight: 500 }}>
            Connection error: {error}
          </span>
        </div>
      )}

      {/* Symbol cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: '#888' }}>
          <Radio size={32} color={GOLD} style={{ animation: 'radarPulse 1.5s infinite' }} />
          <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>Scanning markets...</p>
        </div>
      ) : symbols.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: '#888' }}>
          <Crosshair size={48} color={GOLD} style={{ opacity: 0.3 }} />
          <p style={{ marginTop: '1rem', fontSize: '1rem', fontWeight: 600, color: '#555' }}>No Symbols Configured</p>
          <p style={{ fontSize: '0.85rem' }}>Add symbols to your watchlist to start tracking signals</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {symbols.map(s => (
            <SymbolCard key={s.symbol} data={s} onModeChange={handleModeChange} />
          ))}
        </div>
      )}
    </div>
  )
}
