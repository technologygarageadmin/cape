import React, { useState, useEffect, useRef } from 'react'
import {
  Activity, TrendingUp, TrendingDown, AlertTriangle, CheckCircle,
  XCircle, Shield, Zap, Eye, Clock, ArrowUpRight, ArrowDownRight,
  RefreshCw, Target, ChevronDown, ChevronUp
} from 'lucide-react'

const GOLD = '#C9A227'
const GOLD_LIGHT = '#F5C518'
const GOLD_DEEP = '#A07C10'
const API_DISPLAY = 'http://localhost:8002'

const QUALITY_CONFIG = {
  EXCELLENT: { color: '#22c55e', bg: 'rgba(34,197,94,0.1)', icon: CheckCircle, label: 'Excellent Entry' },
  GOOD:      { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', icon: TrendingUp, label: 'Good Entry' },
  NEUTRAL:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', icon: Eye, label: 'Neutral' },
  WEAK:      { color: '#f97316', bg: 'rgba(249,115,22,0.1)', icon: AlertTriangle, label: 'Weak Entry' },
  BAD:       { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',  icon: XCircle, label: 'Bad Entry' },
}

function fmtNum4(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(4) : '—'
}

function fmtSignedPct(v) {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtTickTime(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

const styles = {
  page: { width: '100%' },
  topBanner: {
    background: 'linear-gradient(135deg, #111 0%, #1a1a1a 40%, #2a2000 100%)',
    borderRadius: '16px',
    padding: '2rem',
    marginBottom: '2rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '2rem',
    boxShadow: '0 8px 32px rgba(201,162,39,0.15)',
    position: 'relative',
    overflow: 'hidden',
  },
  bannerGlow: {
    position: 'absolute',
    top: '-40%',
    right: '-5%',
    width: '300px',
    height: '300px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(201,162,39,0.18) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  bannerLeft: { display: 'flex', flexDirection: 'column', gap: '0.5rem', zIndex: 1 },
  bannerTitle: { fontSize: '1.8rem', fontWeight: 800, color: '#fff', lineHeight: 1.1 },
  bannerAccent: { color: GOLD },
  bannerSub: { fontSize: '0.8rem', color: '#888', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 500 },
  bannerRight: { display: 'flex', gap: '2rem', zIndex: 1 },
  bannerStat: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' },
  bannerStatLabel: { fontSize: '0.7rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em' },
  bannerStatValue: { fontSize: '1.5rem', fontWeight: 800, color: GOLD },
  refreshBtn: {
    background: 'rgba(201,162,39,0.15)',
    border: '1px solid rgba(201,162,39,0.3)',
    borderRadius: '10px',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: GOLD,
    fontSize: '0.78rem',
    fontWeight: 600,
    transition: 'all 0.2s ease',
  },
  card: {
    background: '#fff',
    border: '1px solid rgba(201,162,39,0.12)',
    borderRadius: '14px',
    padding: '1.5rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
    marginBottom: '1rem',
    transition: 'all 0.3s ease',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
    cursor: 'pointer',
  },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  symbolBadge: {
    fontSize: '1.1rem',
    fontWeight: 800,
    color: '#111',
  },
  signalBadge: {
    padding: '0.2rem 0.6rem',
    borderRadius: '6px',
    fontSize: '0.7rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  callBadge: { background: 'rgba(34,197,94,0.12)', color: '#16a34a' },
  putBadge: { background: 'rgba(239,68,68,0.12)', color: '#dc2626' },
  tradeBadge: {
    padding: '0.2rem 0.6rem',
    borderRadius: '6px',
    fontSize: '0.65rem',
    fontWeight: 600,
    background: 'rgba(201,162,39,0.12)',
    color: GOLD_DEEP,
  },
  statusBadge: {
    padding: '0.25rem 0.7rem',
    borderRadius: '20px',
    fontSize: '0.7rem',
    fontWeight: 600,
  },
  pnlBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    fontSize: '1.3rem',
    fontWeight: 800,
  },
  // Sections inside card
  section: {
    padding: '1rem 0',
    borderTop: '1px solid rgba(0,0,0,0.05)',
  },
  sectionTitle: {
    fontSize: '0.72rem',
    fontWeight: 700,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: '0.75rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  filterList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.4rem',
  },
  filterChip: {
    padding: '0.3rem 0.7rem',
    borderRadius: '8px',
    fontSize: '0.72rem',
    fontWeight: 500,
    background: 'rgba(34,197,94,0.08)',
    color: '#16a34a',
    border: '1px solid rgba(34,197,94,0.15)',
  },
  entryReasonChip: {
    padding: '0.3rem 0.7rem',
    borderRadius: '8px',
    fontSize: '0.72rem',
    fontWeight: 500,
    background: 'rgba(201,162,39,0.08)',
    color: GOLD_DEEP,
    border: `1px solid rgba(201,162,39,0.15)`,
  },
  // Threshold gauge
  gaugeContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: '0.75rem',
  },
  gaugeItem: {
    background: 'rgba(0,0,0,0.02)',
    borderRadius: '10px',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  gaugeLabel: {
    fontSize: '0.68rem',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  gaugeValue: {
    fontSize: '1.1rem',
    fontWeight: 800,
  },
  gaugeBar: {
    height: '4px',
    borderRadius: '2px',
    background: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  gaugeBarFill: {
    height: '100%',
    borderRadius: '2px',
    transition: 'width 0.5s ease',
  },
  // Threshold notes
  notesList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  noteItem: {
    fontSize: '0.78rem',
    color: '#555',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    lineHeight: 1.4,
  },
  noteDot: {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: GOLD,
    flexShrink: 0,
  },
  // Quality badge
  qualityBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.6rem 1rem',
    borderRadius: '10px',
    fontSize: '0.82rem',
    fontWeight: 600,
  },
  qualityNote: {
    fontSize: '0.75rem',
    color: '#666',
    marginTop: '0.3rem',
  },
  // Exit reason box
  exitBox: {
    background: 'rgba(239,68,68,0.06)',
    border: '1px solid rgba(239,68,68,0.15)',
    borderRadius: '10px',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  exitReason: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: '#dc2626',
  },
  exitDesc: {
    fontSize: '0.78rem',
    color: '#666',
    lineHeight: 1.5,
  },
  // PnL bar
  pnlBarContainer: {
    width: '100%',
    height: '8px',
    borderRadius: '4px',
    background: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
    position: 'relative',
    margin: '0.5rem 0',
  },
  pnlBar: {
    height: '100%',
    borderRadius: '4px',
    transition: 'width 0.4s ease, background 0.4s ease',
    position: 'absolute',
    left: '50%',
  },
  pnlBarCenter: {
    position: 'absolute',
    left: '50%',
    top: 0,
    bottom: 0,
    width: '2px',
    background: 'rgba(0,0,0,0.15)',
  },
  // Price info row
  priceRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
  },
  priceItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15rem',
    alignItems: 'center',
  },
  priceLabel: { fontSize: '0.65rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 },
  priceValue: { fontSize: '0.95rem', fontWeight: 700, color: '#111' },
  bracketGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '0.75rem',
    marginTop: '0.75rem',
  },
  bracketItem: {
    background: 'rgba(201,162,39,0.05)',
    border: '1px solid rgba(201,162,39,0.12)',
    borderRadius: '10px',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  bracketLabel: {
    fontSize: '0.65rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 700,
    color: '#8a6a10',
  },
  bracketValue: {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#333',
    wordBreak: 'break-word',
  },
  // Empty state
  empty: {
    textAlign: 'center',
    padding: '4rem 2rem',
    color: '#888',
  },
  emptyIcon: {
    width: '64px',
    height: '64px',
    margin: '0 auto 1rem',
    borderRadius: '50%',
    background: 'rgba(201,162,39,0.1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: '1.2rem', fontWeight: 700, color: '#333', marginBottom: '0.5rem' },
  emptyText: { fontSize: '0.85rem', color: '#888' },
  // Live dot
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#22c55e',
    boxShadow: '0 0 8px rgba(34,197,94,0.6)',
    animation: 'livePulse 2s infinite',
  },
  liveLabel: { fontSize: '0.72rem', color: '#22c55e', fontWeight: 600 },
}

function PnLBar({ pnl }) {
  const maxRange = 5
  const clamped = Math.max(-maxRange, Math.min(maxRange, pnl))
  const widthPct = Math.abs(clamped) / maxRange * 50
  const isPositive = clamped >= 0
  return (
    <div style={styles.pnlBarContainer}>
      <div style={styles.pnlBarCenter} />
      <div style={{
        ...styles.pnlBar,
        width: `${widthPct}%`,
        background: isPositive
          ? 'linear-gradient(90deg, #22c55e, #16a34a)'
          : 'linear-gradient(270deg, #ef4444, #dc2626)',
        left: isPositive ? '50%' : `${50 - widthPct}%`,
      }} />
    </div>
  )
}

function ThresholdGauges({ live }) {
  const slPct = Math.abs(parseFloat(live.sl_dynamic_pct || live.sl_static_pct || 0))
  const qpPct = parseFloat(live.qp_dynamic_pct || live.qp_floor_pct || 0)
  const tpPct = parseFloat(live.tp_pct || 0)
  const maxPnl = parseFloat(live.max_pnl_pct || 0)

  return (
    <div style={styles.gaugeContainer}>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Stop Loss</span>
        <span style={{ ...styles.gaugeValue, color: '#ef4444' }}>-{slPct.toFixed(2)}%</span>
        <div style={styles.gaugeBar}>
          <div style={{ ...styles.gaugeBarFill, width: `${Math.min(100, slPct / 5 * 100)}%`, background: '#ef4444' }} />
        </div>
      </div>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Quick Profit</span>
        <span style={{ ...styles.gaugeValue, color: '#f59e0b' }}>{qpPct > 0 ? `+${qpPct.toFixed(2)}%` : '—'}</span>
        <div style={styles.gaugeBar}>
          <div style={{ ...styles.gaugeBarFill, width: `${Math.min(100, qpPct / 5 * 100)}%`, background: '#f59e0b' }} />
        </div>
      </div>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Take Profit</span>
        <span style={{ ...styles.gaugeValue, color: '#22c55e' }}>+{tpPct.toFixed(2)}%</span>
        <div style={styles.gaugeBar}>
          <div style={{ ...styles.gaugeBarFill, width: `${Math.min(100, tpPct / 10 * 100)}%`, background: '#22c55e' }} />
        </div>
      </div>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Peak PnL</span>
        <span style={{ ...styles.gaugeValue, color: maxPnl >= 0 ? '#22c55e' : '#ef4444' }}>
          {maxPnl >= 0 ? '+' : ''}{maxPnl.toFixed(2)}%
        </span>
        <div style={styles.gaugeBar}>
          <div style={{ ...styles.gaugeBarFill, width: `${Math.min(100, Math.abs(maxPnl) / 5 * 100)}%`, background: maxPnl >= 0 ? '#22c55e' : '#ef4444' }} />
        </div>
      </div>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Trailing SL</span>
        <span style={{ ...styles.gaugeValue, color: '#8b5cf6' }}>
          {parseFloat(live.sl_dynamic_pct || 0) > parseFloat(live.sl_static_pct || 0) ? 'ARMED' : 'WAITING'}
        </span>
      </div>
      <div style={styles.gaugeItem}>
        <span style={styles.gaugeLabel}>Current Price</span>
        <span style={{ ...styles.gaugeValue, color: '#111' }}>${parseFloat(live.current_price || 0).toFixed(4)}</span>
      </div>
    </div>
  )
}

function QualityBadge({ quality, note }) {
  const config = QUALITY_CONFIG[quality] || QUALITY_CONFIG.NEUTRAL
  const Icon = config.icon
  return (
    <div>
      <div style={{ ...styles.qualityBadge, background: config.bg, color: config.color }}>
        <Icon size={16} />
        <span>{config.label}</span>
      </div>
      {note && <div style={styles.qualityNote}>{note}</div>}
    </div>
  )
}

function ExitForecast({ pos, live }) {
  const fillPrice = parseFloat(pos.fill_price || 0)
  if (!fillPrice) return null

  const pnl = parseFloat(live.pnl_pct || 0)
  const maxPnl = parseFloat(live.max_pnl_pct || 0)
  const slStatic = parseFloat(live.sl_static_pct || 0)
  const slDynamic = parseFloat(live.sl_dynamic_pct || slStatic)
  const tpPct = parseFloat(live.tp_pct || 0)
  const qpFloor = parseFloat(live.qp_floor_pct || 0)
  const qpDynamic = parseFloat(live.qp_dynamic_pct || qpFloor)

  const trailingArmed = slDynamic > slStatic
  const qpArmed = maxPnl >= qpFloor
  const breakevenArmed = maxPnl >= 1.5

  const tpSellPrice = fillPrice * (1 + tpPct / 100)
  const slSellPrice = fillPrice * (1 + slDynamic / 100)
  const qpSellPrice = qpArmed ? fillPrice * (1 + qpDynamic / 100) : null

  const entryTime = pos.entry_time ? new Date(pos.entry_time) : null
  const elapsedSec = entryTime ? Math.max(0, Math.floor((Date.now() - entryTime.getTime()) / 1000)) : 0
  const badEntryDone = elapsedSec >= 45
  const maxHoldRemain = Math.max(0, 420 - elapsedSec)
  const momentumActive = elapsedSec >= 120

  const fmtTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }

  const triggers = []

  triggers.push({
    label: 'Take Profit', value: `$${tpSellPrice.toFixed(4)}`,
    sub: `${(tpPct - pnl).toFixed(1)}% away`, color: '#22c55e', armed: true, Icon: Target,
  })

  triggers.push({
    label: trailingArmed ? 'Trailing Stop' : breakevenArmed ? 'Breakeven SL' : 'Stop Loss',
    value: `$${slSellPrice.toFixed(4)}`,
    sub: `${(pnl - slDynamic).toFixed(1)}% away`, color: '#ef4444', armed: true, Icon: Shield,
    note: trailingArmed ? 'Protecting gains' : breakevenArmed ? 'Floor at breakeven' : null,
  })

  if (qpArmed && qpSellPrice) {
    triggers.push({
      label: 'Quick Profit Lock', value: `$${qpSellPrice.toFixed(4)}`,
      sub: `${(pnl - qpDynamic).toFixed(1)}% away`, color: '#f59e0b', armed: true, Icon: Zap,
    })
  }

  if (!badEntryDone) {
    triggers.push({
      label: 'Bad Entry Check', value: `In ${fmtTime(45 - elapsedSec)}`,
      sub: 'Exits if PnL < \u22121.5% & peak < 0.3%', color: '#f97316', armed: false, Icon: AlertTriangle,
    })
  } else if (pnl < -1.5 && maxPnl < 0.3) {
    triggers.push({
      label: 'Bad Entry', value: 'SELL NOW', sub: 'Weak entry \u2014 exiting',
      color: '#f97316', armed: true, urgent: true, Icon: AlertTriangle,
    })
  }

  if (maxHoldRemain > 0) {
    triggers.push({
      label: 'Max Hold (7min)', value: fmtTime(maxHoldRemain),
      sub: pnl < 0.5 ? 'Will sell if PnL still < 0.5%' : 'Safe \u2014 PnL above 0.5%',
      color: '#8b5cf6', armed: pnl < 0.5, Icon: Clock,
    })
  } else if (pnl < 0.5) {
    triggers.push({
      label: 'Max Hold', value: 'SELL NOW', sub: '7min limit exceeded',
      color: '#8b5cf6', armed: true, urgent: true, Icon: Clock,
    })
  }

  if (!momentumActive) {
    triggers.push({
      label: 'Momentum Stall', value: `In ${fmtTime(120 - elapsedSec)}`,
      sub: 'Monitors RSI flip against signal', color: '#6366f1', armed: false, Icon: Activity,
    })
  } else {
    triggers.push({
      label: 'Momentum Stall', value: 'Active',
      sub: pnl < 0.5 ? 'Will sell if RSI flips against trade' : 'Safe \u2014 PnL above 0.5%',
      color: '#6366f1', armed: pnl < 0.5, Icon: Activity,
    })
  }

  return (
    <div>
      {triggers.map((t, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.5rem 0.75rem', borderRadius: '8px', marginBottom: '0.35rem',
          background: t.urgent ? `${t.color}12` : t.armed ? 'rgba(0,0,0,0.02)' : 'rgba(0,0,0,0.01)',
          border: t.urgent ? `1px solid ${t.color}30` : '1px solid transparent',
          opacity: t.armed ? 1 : 0.55,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <t.Icon size={14} color={t.color} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.08rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.74rem', fontWeight: 700, color: '#333' }}>{t.label}</span>
                <span style={{
                  fontSize: '0.56rem', fontWeight: 700, padding: '0.06rem 0.3rem',
                  borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: t.urgent ? `${t.color}20` : t.armed ? 'rgba(34,197,94,0.1)' : 'rgba(0,0,0,0.05)',
                  color: t.urgent ? t.color : t.armed ? '#16a34a' : '#999',
                }}>
                  {t.urgent ? 'TRIGGERED' : t.armed ? 'ARMED' : 'WAITING'}
                </span>
              </div>
              <span style={{ fontSize: '0.66rem', color: '#888' }}>{t.sub}</span>
              {t.note && <span style={{ fontSize: '0.64rem', color: t.color, fontStyle: 'italic' }}>{t.note}</span>}
            </div>
          </div>
          <span style={{
            fontSize: '0.88rem', fontWeight: 800, color: t.color,
            ...(t.urgent && { animation: 'livePulse 1s infinite' }),
          }}>
            {t.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function PositionCard({ pos }) {
  const [expanded, setExpanded] = useState(true)
  const live = pos.live || {}
  const pnl = parseFloat(live.pnl_pct || 0)
  const isCall = pos.leg_name === 'CALL'
  const isMonitoringActive = live.monitoring_active !== false
  const hasExitReason = !!live.exit_reason
  const isActive = isMonitoringActive && !hasExitReason

  const exitReasonLabel = (live.exit_reason || '').replace(/_/g, ' ').replace(/EXIT$/i, '').trim()
  const pnlDollar = parseFloat(live.pnl_dollar || 0)
  const tpOrderIds = Array.isArray(pos.tp_order_ids) ? pos.tp_order_ids : (Array.isArray(live.tp_order_ids) ? live.tp_order_ids : [])
  const slOrderIds = Array.isArray(pos.sl_order_ids) ? pos.sl_order_ids : (Array.isArray(live.sl_order_ids) ? live.sl_order_ids : [])
  const timeline = Array.isArray(live.timeline) ? live.timeline : []

  return (
    <div style={{
      ...styles.card,
      borderLeft: `4px solid ${hasExitReason ? '#9ca3af' : pnl >= 0 ? '#22c55e' : '#ef4444'}`,
      opacity: hasExitReason ? 0.85 : 1,
      background: hasExitReason ? '#fafafa' : '#fff',
    }}>
      {/* ── Status Banner ── */}
      {hasExitReason ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.6rem 1rem', margin: '-1.5rem -1.5rem 1rem -1.5rem',
          borderRadius: '14px 14px 0 0',
          background: pnl >= 0
            ? 'linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.04))'
            : 'linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))',
          borderBottom: `1px solid ${pnl >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {pnl >= 0
              ? <CheckCircle size={16} color="#16a34a" />
              : <XCircle size={16} color="#dc2626" />
            }
            <span style={{
              fontSize: '0.78rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: pnl >= 0 ? '#16a34a' : '#dc2626',
            }}>
              SOLD — {pnl >= 0 ? 'WIN' : 'LOSS'}
            </span>
            <span style={{
              padding: '0.15rem 0.5rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 600,
              background: 'rgba(0,0,0,0.06)', color: '#555',
            }}>
              {exitReasonLabel || 'Unknown'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{
              fontSize: '1rem', fontWeight: 900,
              color: pnl >= 0 ? '#16a34a' : '#dc2626',
            }}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
            </span>
            {pnlDollar !== 0 && (
              <span style={{
                fontSize: '0.85rem', fontWeight: 800,
                color: pnlDollar >= 0 ? '#16a34a' : '#dc2626',
              }}>
                {pnlDollar >= 0 ? '+' : ''}${pnlDollar.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.6rem 1rem', margin: '-1.5rem -1.5rem 1rem -1.5rem',
          borderRadius: '14px 14px 0 0',
          background: 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(34,197,94,0.02))',
          borderBottom: '1px solid rgba(34,197,94,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={styles.liveDot} />
            <span style={{
              fontSize: '0.78rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: '#16a34a',
            }}>
              MONITORING — LIVE
            </span>
          </div>
          <span style={{
            fontSize: '1rem', fontWeight: 900,
            color: pnl >= 0 ? '#22c55e' : '#ef4444',
          }}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
          </span>
        </div>
      )}

      {/* Header */}
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <div style={styles.cardTitleRow}>
          <span style={styles.symbolBadge}>{pos.symbol}</span>
          <span style={{
            ...styles.signalBadge,
            ...(isCall ? styles.callBadge : styles.putBadge),
          }}>
            {isCall ? <TrendingUp size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} /> : <TrendingDown size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />}
            {pos.leg_name}
          </span>
          <span style={styles.tradeBadge}>{pos.trade_type}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {expanded ? <ChevronUp size={18} color="#888" /> : <ChevronDown size={18} color="#888" />}
          {expanded ? <ChevronUp size={18} color="#888" /> : <ChevronDown size={18} color="#888" />}
        </div>
      </div>

      {/* PnL Bar */}
      <PnLBar pnl={pnl} />

      {expanded && (
        <>
          {/* Price Info */}
          <div style={{ ...styles.section, borderTop: 'none', paddingTop: '0.5rem' }}>
            <div style={styles.priceRow}>
              <div style={styles.priceItem}>
                <span style={styles.priceLabel}>Entry</span>
                <span style={styles.priceValue}>${parseFloat(pos.fill_price || 0).toFixed(4)}</span>
              </div>
              <div style={styles.priceItem}>
                <span style={styles.priceLabel}>Current</span>
                <span style={{ ...styles.priceValue, color: pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                  ${parseFloat(live.current_price || pos.fill_price || 0).toFixed(4)}
                </span>
              </div>
              <div style={styles.priceItem}>
                <span style={styles.priceLabel}>Contract</span>
                <span style={{ ...styles.priceValue, fontSize: '0.78rem' }}>{pos.contract_symbol}</span>
              </div>
              <div style={styles.priceItem}>
                <span style={styles.priceLabel}>Qty</span>
                <span style={styles.priceValue}>{pos.qty}</span>
              </div>
              <div style={styles.priceItem}>
                <span style={styles.priceLabel}>Entry Time</span>
                <span style={{ ...styles.priceValue, fontSize: '0.78rem' }}>
                  {pos.entry_time ? new Date(pos.entry_time).toLocaleTimeString() : '—'}
                </span>
              </div>
            </div>
            {(tpOrderIds.length > 0 || slOrderIds.length > 0) && (
              <div style={styles.bracketGrid}>
                <div style={styles.bracketItem}>
                  <span style={styles.bracketLabel}>TP Child IDs</span>
                  <span style={styles.bracketValue}>{tpOrderIds.length > 0 ? tpOrderIds.join(', ') : '—'}</span>
                </div>
                <div style={styles.bracketItem}>
                  <span style={styles.bracketLabel}>SL Child IDs</span>
                  <span style={styles.bracketValue}>{slOrderIds.length > 0 ? slOrderIds.join(', ') : '—'}</span>
                </div>
                <div style={styles.bracketItem}>
                  <span style={styles.bracketLabel}>Child Count</span>
                  <span style={styles.bracketValue}>{tpOrderIds.length + slOrderIds.length}</span>
                </div>
              </div>
            )}

            {timeline.length > 0 && (
              <div style={{ marginTop: '0.8rem', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '0.8rem' }}>
                <div style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#888',
                  marginBottom: '0.45rem',
                }}>
                  Tick Details (TP/SL change log)
                </div>
                <div style={{ overflowX: 'auto', maxHeight: '230px', overflowY: 'auto', border: '1px solid rgba(201,162,39,0.15)', borderRadius: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.68rem', minWidth: '980px' }}>
                    <thead>
                      <tr style={{ background: '#fdfaf4', position: 'sticky', top: 0, zIndex: 1 }}>
                        {['Time', 'Source', 'Price', 'PnL%', 'Peak%', 'TP', 'SL', 'SL Update', 'SL Order'].map((h) => (
                          <th key={h} style={{ padding: '0.32rem 0.45rem', textAlign: 'left', color: '#777', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.slice(0, 250).map((tick, idx) => {
                        const isOrder = tick.source === 'order_placed' || tick.source === 'order_replaced'
                        return (
                          <tr key={idx} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)', background: idx % 2 === 0 ? '#fff' : '#fcfcfc' }}>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: '#555' }}>{fmtTickTime(tick.ts)}</td>
                            <td style={{ padding: '0.3rem 0.45rem', color: '#666', textTransform: 'uppercase', fontWeight: 700 }}>{tick.source || 'tick'}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace' }}>{tick.sellable_price != null ? `$${fmtNum4(tick.sellable_price)}` : '—'}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: parseFloat(tick.pnl_pct || 0) >= 0 ? '#16a34a' : '#dc2626' }}>{fmtSignedPct(tick.pnl_pct)}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: '#555' }}>{fmtSignedPct(tick.max_pnl_pct)}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: '#555' }}>{tick.tp_action || 'NO_CHANGE'}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: tick.sl_action === 'UPDATED' ? '#dc2626' : '#555', fontWeight: tick.sl_action === 'UPDATED' ? 700 : 500 }}>{tick.sl_action || 'NO_CHANGE'}</td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: '#444', whiteSpace: 'nowrap' }}>
                              {isOrder
                                ? (tick.order_type || 'ORDER_EVENT')
                                : (tick.sl_action === 'UPDATED'
                                  ? `${tick.sl_prev_price != null ? `$${fmtNum4(tick.sl_prev_price)}` : '—'} -> ${tick.sl_new_price != null ? `$${fmtNum4(tick.sl_new_price)}` : '—'}`
                                  : 'No change')}
                            </td>
                            <td style={{ padding: '0.3rem 0.45rem', fontFamily: 'monospace', color: '#444', whiteSpace: 'nowrap' }}>
                              {tick.sl_order_action || (isOrder ? 'ORDER_EVENT' : 'NO_CHANGE')}
                              {tick.sl_order_prev_id ? ` | old:${String(tick.sl_order_prev_id).slice(0, 8)}` : ''}
                              {tick.sl_order_new_id ? ` | new:${String(tick.sl_order_new_id).slice(0, 8)}` : ''}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Why Position Opened */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              <Zap size={13} color={GOLD} />
              WHY POSITION OPENED
            </div>
            {pos.entry_reasons && pos.entry_reasons.length > 0 && (
              <div style={{ ...styles.filterList, marginBottom: '0.5rem' }}>
                {pos.entry_reasons.map((r, i) => (
                  <span key={i} style={styles.entryReasonChip}>{r}</span>
                ))}
              </div>
            )}
            {pos.entry_filters_passed && pos.entry_filters_passed.length > 0 ? (
              <div style={styles.filterList}>
                {pos.entry_filters_passed.map((f, i) => (
                  <span key={i} style={styles.filterChip}>
                    <CheckCircle size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                    {f}
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: '0.78rem', color: '#888' }}>No filter data available (straddle or legacy trade)</span>
            )}
          </div>

          {/* Entry Quality */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              <Target size={13} color={GOLD} />
              ENTRY QUALITY
            </div>
            <QualityBadge quality={live.entry_quality} note={live.entry_quality_note} />
          </div>

          {/* Live Thresholds */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              <Shield size={13} color={GOLD} />
              EXIT THRESHOLDS (LIVE)
            </div>
            <ThresholdGauges live={live} />
            {live.threshold_notes && live.threshold_notes.length > 0 && (
              <div style={{ ...styles.notesList, marginTop: '0.75rem' }}>
                {live.threshold_notes.map((note, i) => (
                  <div key={i} style={styles.noteItem}>
                    <span style={styles.noteDot} />
                    {note}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* When Will It Sell — only for active positions */}
          {!hasExitReason && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <Clock size={13} color={GOLD} />
                WHEN WILL IT SELL?
              </div>
              <ExitForecast pos={pos} live={live} />
            </div>
          )}

          {/* Exit Reason (if exited) */}
          {hasExitReason && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <XCircle size={13} color="#ef4444" />
                WHY SOLD
              </div>
              <div style={styles.exitBox}>
                <div style={styles.exitReason}>{live.exit_reason}</div>
                {live.exit_description && (
                  <div style={styles.exitDesc}>{live.exit_description}</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function LivePositions() {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const intervalRef = useRef(null)

  const fetchPositions = async () => {
    try {
      const res = await fetch(`${API_DISPLAY}/api/live-positions`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setPositions(data.positions || [])
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPositions()
    intervalRef.current = setInterval(fetchPositions, 2000)
    return () => clearInterval(intervalRef.current)
  }, [])

  const activeCount = positions.filter(p => (p.live || {}).monitoring_active !== false && !p.live?.exit_reason).length
  const exitedCount = positions.filter(p => !!p.live?.exit_reason).length
  const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.live?.pnl_pct || 0), 0)

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>

      {/* Banner */}
      <div style={styles.topBanner}>
        <div style={styles.bannerGlow} />
        <div style={styles.bannerLeft}>
          <div style={styles.bannerSub}>Live Position Monitor</div>
          <div style={styles.bannerTitle}>
            Real-Time <span style={styles.bannerAccent}>Trade Intelligence</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
            {activeCount > 0 && <span style={styles.liveDot} />}
            <span style={{ fontSize: '0.8rem', color: '#aaa', fontWeight: 500 }}>
              {activeCount > 0 ? `${activeCount} position${activeCount > 1 ? 's' : ''} actively monitored` : 'No active positions'}
            </span>
          </div>
        </div>
        <div style={styles.bannerRight}>
          <div style={styles.bannerStat}>
            <span style={styles.bannerStatLabel}>Active</span>
            <span style={styles.bannerStatValue}>{activeCount}</span>
          </div>
          <div style={styles.bannerStat}>
            <span style={styles.bannerStatLabel}>Exited</span>
            <span style={styles.bannerStatValue}>{exitedCount}</span>
          </div>
          <div style={styles.bannerStat}>
            <span style={styles.bannerStatLabel}>Net PnL</span>
            <span style={{ ...styles.bannerStatValue, color: totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%
            </span>
          </div>
          <div style={styles.bannerStat}>
            <button style={styles.refreshBtn} onClick={fetchPositions}>
              <RefreshCw size={14} />
              Refresh
            </button>
            {lastUpdate && (
              <span style={{ fontSize: '0.65rem', color: '#555', marginTop: '0.25rem' }}>
                {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          ...styles.card,
          borderLeft: '4px solid #ef4444',
          background: 'rgba(239,68,68,0.04)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}>
          <AlertTriangle size={20} color="#ef4444" />
          <span style={{ color: '#dc2626', fontSize: '0.85rem', fontWeight: 500 }}>
            Failed to fetch live positions: {error}
          </span>
        </div>
      )}

      {/* Positions */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#888' }}>
          <RefreshCw size={24} color={GOLD} style={{ animation: 'spin 1s linear infinite' }} />
          <p style={{ marginTop: '1rem' }}>Loading positions...</p>
        </div>
      ) : positions.length === 0 ? (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>
            <Activity size={28} color={GOLD} />
          </div>
          <div style={styles.emptyTitle}>No Open Positions</div>
          <div style={styles.emptyText}>Positions will appear here when the bot enters a trade</div>
        </div>
      ) : (
        <>
          {/* ── Active Positions ── */}
          {positions.filter(p => !p.live?.exit_reason).length > 0 && (
            <div style={{ marginBottom: '2rem' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem',
                marginBottom: '1rem', paddingBottom: '0.5rem',
                borderBottom: '2px solid rgba(34,197,94,0.2)',
              }}>
                <span style={styles.liveDot} />
                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Active Positions
                </span>
                <span style={{
                  padding: '0.15rem 0.55rem', borderRadius: '20px', fontSize: '0.7rem', fontWeight: 700,
                  background: 'rgba(34,197,94,0.12)', color: '#16a34a',
                }}>
                  {positions.filter(p => !p.live?.exit_reason).length}
                </span>
              </div>
              {positions.filter(p => !p.live?.exit_reason).map(pos => (
                <PositionCard key={pos.buy_order_id} pos={pos} />
              ))}
            </div>
          )}

          {/* ── Exited Positions ── */}
          {positions.filter(p => !!p.live?.exit_reason).length > 0 && (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem',
                marginBottom: '1rem', paddingBottom: '0.5rem',
                borderBottom: '2px solid rgba(156,163,175,0.3)',
              }}>
                <Clock size={14} color="#9ca3af" />
                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Exited Today
                </span>
                <span style={{
                  padding: '0.15rem 0.55rem', borderRadius: '20px', fontSize: '0.7rem', fontWeight: 700,
                  background: 'rgba(0,0,0,0.06)', color: '#6b7280',
                }}>
                  {positions.filter(p => !!p.live?.exit_reason).length}
                </span>
                {(() => {
                  const exitedPnl = positions
                    .filter(p => !!p.live?.exit_reason)
                    .reduce((sum, p) => sum + parseFloat(p.live?.pnl_dollar || 0), 0)
                  return (
                    <span style={{
                      marginLeft: 'auto', fontSize: '0.82rem', fontWeight: 800,
                      color: exitedPnl >= 0 ? '#16a34a' : '#dc2626',
                    }}>
                      Total: {exitedPnl >= 0 ? '+' : ''}${exitedPnl.toFixed(2)}
                    </span>
                  )
                })()}
              </div>
              {positions.filter(p => !!p.live?.exit_reason).map(pos => (
                <PositionCard key={pos.buy_order_id} pos={pos} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
