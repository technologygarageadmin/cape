import React, { useState, useEffect } from 'react'
import {
  TrendingUp, TrendingDown, Activity, DollarSign,
  Bot, Zap, BarChart2, ArrowUpRight, ArrowDownRight,
  RefreshCw, CheckCircle, AlertCircle, Clock
} from 'lucide-react'

const GOLD = '#C9A227'
const GOLD_LIGHT = '#F5C518'
const GOLD_DEEP = '#A07C10'

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
    boxShadow: `0 8px 32px rgba(201,162,39,0.15)`,
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
  bannerGreeting: { fontSize: '0.8rem', color: '#888', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 500 },
  bannerTitle: { fontSize: '1.8rem', fontWeight: 800, color: '#fff', lineHeight: 1.1 },
  bannerTitleAccent: { color: GOLD },
  bannerStatus: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' },
  statusDot: {
    width: '8px', height: '8px', borderRadius: '50%',
    background: '#22c55e',
    boxShadow: '0 0 8px rgba(34,197,94,0.6)',
    animation: 'pulse 2s infinite',
  },
  statusText: { fontSize: '0.8rem', color: '#aaa', fontWeight: 500 },
  bannerRight: { display: 'flex', gap: '2rem', zIndex: 1 },
  bannerStat: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' },
  bannerStatLabel: { fontSize: '0.7rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.1em' },
  bannerStatValue: { fontSize: '1.5rem', fontWeight: 800, color: GOLD },
  bannerStatChange: { fontSize: '0.75rem', color: '#22c55e', fontWeight: 600 },
  // Stats grid
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '1.25rem',
    marginBottom: '2rem',
  },
  statCard: {
    background: '#fff',
    border: `1px solid rgba(201,162,39,0.15)`,
    borderRadius: '14px',
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
    transition: 'all 0.3s ease',
    cursor: 'default',
  },
  statCardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  statLabel: { fontSize: '0.8rem', color: '#888', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' },
  statIconBox: {
    width: '40px', height: '40px', borderRadius: '10px',
    background: `rgba(201,162,39,0.1)`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  statValue: { fontSize: '1.7rem', fontWeight: 800, color: '#111', lineHeight: 1 },
  statChange: { display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', fontWeight: 600 },
  // Main content
  mainGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem', marginBottom: '2rem' },
  card: {
    background: '#fff',
    border: `1px solid rgba(201,162,39,0.12)`,
    borderRadius: '14px',
    padding: '1.5rem',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
  },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' },
  cardTitle: { fontSize: '1rem', fontWeight: 700, color: '#111' },
  cardSubtitle: { fontSize: '0.78rem', color: '#888', marginTop: '0.15rem' },
  badge: {
    padding: '0.3rem 0.8rem',
    borderRadius: '20px',
    fontSize: '0.72rem',
    fontWeight: 600,
  },
  // Bot controls
  botControlRow: { display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  botBtn: {
    flex: 1,
    minWidth: '120px',
    padding: '0.9rem 1rem',
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: '0.85rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    transition: 'all 0.2s ease',
    letterSpacing: '0.03em',
  },
  botBtnPrimary: {
    background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
    color: '#111',
    boxShadow: `0 4px 16px rgba(201,162,39,0.35)`,
  },
  botBtnDanger: { background: '#fff0f0', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' },
  botBtnNeutral: { background: '#f5f5f5', color: '#555', border: '1px solid #e5e5e5' },
  // Performance mini chart (fake bars)
  miniChart: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '60px', marginBottom: '1rem' },
  miniBar: { flex: 1, borderRadius: '3px 3px 0 0', transition: 'all 0.4s ease' },
  // Active trades
  tradeRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.9rem 0', borderBottom: '1px solid rgba(0,0,0,0.05)',
  },
  tradeLeft: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  tradeSymbolBox: {
    width: '38px', height: '38px', borderRadius: '10px',
    background: `rgba(201,162,39,0.1)`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.7rem', fontWeight: 700, color: GOLD, letterSpacing: '0.05em',
  },
  tradeInfo: { display: 'flex', flexDirection: 'column', gap: '0.15rem' },
  tradeName: { fontWeight: 700, fontSize: '0.9rem', color: '#111' },
  tradeType: { fontSize: '0.72rem', color: '#999', fontWeight: 500 },
  tradeRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.15rem' },
  tradeValue: { fontWeight: 700, fontSize: '0.9rem', color: '#111' },
  tradePnl: { fontSize: '0.75rem', fontWeight: 600 },
  // bot stats
  botStatGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.5rem' },
  botStatItem: {
    background: '#fafafa',
    border: '1px solid rgba(0,0,0,0.06)',
    borderRadius: '10px',
    padding: '0.85rem',
    display: 'flex', flexDirection: 'column', gap: '0.25rem',
  },
  botStatLabel: { fontSize: '0.7rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 500 },
  botStatValue: { fontSize: '1.1rem', fontWeight: 800, color: '#111' },
  // Bottom row
  bottomRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1.5rem' },
  logList: { display: 'flex', flexDirection: 'column', gap: '0', maxHeight: '200px', overflowY: 'auto' },
  logItem: {
    display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
    padding: '0.6rem 0', borderBottom: '1px solid rgba(0,0,0,0.04)', fontSize: '0.8rem',
  },
  logTime: { color: '#bbb', fontWeight: 500, whiteSpace: 'nowrap', marginTop: '1px', fontSize: '0.72rem' },
  logText: { color: '#555', lineHeight: 1.4 },
}

const statCards = [
  {
    label: 'Portfolio Value',
    value: '$48,320.50',
    change: '+2.4%',
    up: true,
    icon: DollarSign,
  },
  {
    label: 'Total P&L Today',
    value: '+$1,142',
    change: '+5.8%',
    up: true,
    icon: TrendingUp,
  },
  {
    label: 'Active Trades',
    value: '7',
    change: '3 open',
    up: null,
    icon: Activity,
  },
  {
    label: 'Win Rate',
    value: '73.2%',
    change: '+1.2% this week',
    up: true,
    icon: BarChart2,
  },
]

const activeTrades = [
  { symbol: 'AAPL', name: 'Apple Inc.', type: 'LONG', value: '$12,800', pnl: '+$512', up: true },
  { symbol: 'TSLA', name: 'Tesla Inc.', type: 'LONG', value: '$9,400', pnl: '+$275', up: true },
  { symbol: 'MSFT', name: 'Microsoft', type: 'SHORT', value: '$7,200', pnl: '-$85', up: false },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', type: 'LONG', value: '$15,600', pnl: '+$820', up: true },
]

const botLogs = [
  { time: '14:32', text: 'BUY signal detected — AAPL at $182.40', type: 'buy' },
  { time: '14:28', text: 'SELL executed — TSLA at $248.60 (+1.8%)', type: 'sell' },
  { time: '14:15', text: 'ATR threshold crossed — NVDA', type: 'info' },
  { time: '14:02', text: 'BUY executed — MSFT at $415.20', type: 'buy' },
  { time: '13:55', text: 'Risk limit check passed — all positions OK', type: 'info' },
  { time: '13:41', text: 'Strategy re-evaluated after market dip', type: 'info' },
]

const performanceBars = [45, 62, 38, 71, 55, 83, 67, 92, 78, 88, 95, 82]

export default function Dashboard() {
  const [botRunning, setBotRunning] = useState(true)
  const [hovered, setHovered] = useState(null)

  return (
    <div style={styles.page}>
      {/* Top banner */}
      <div style={styles.topBanner}>
        <div style={styles.bannerGlow} />
        <div style={styles.bannerLeft}>
          <span style={styles.bannerGreeting}>Welcome back, Trader</span>
          <div style={styles.bannerTitle}>
            Cape <span style={styles.bannerTitleAccent}>Trading Bot</span>
          </div>
          <div style={styles.bannerStatus}>
            <div style={{ ...styles.statusDot, background: botRunning ? '#22c55e' : '#ef4444', boxShadow: botRunning ? '0 0 8px rgba(34,197,94,0.6)' : '0 0 8px rgba(239,68,68,0.5)' }} />
            <span style={styles.statusText}>{botRunning ? 'Bot is actively trading' : 'Bot is stopped'}</span>
          </div>
        </div>
        <div style={styles.bannerRight}>
          <div style={styles.bannerStat}>
            <span style={styles.bannerStatLabel}>Today's Profit</span>
            <span style={styles.bannerStatValue}>+$1,142</span>
            <span style={styles.bannerStatChange}>▲ 5.8%</span>
          </div>
          <div style={{ width: '1px', background: 'rgba(255,255,255,0.08)' }} />
          <div style={styles.bannerStat}>
            <span style={styles.bannerStatLabel}>Trades Today</span>
            <span style={styles.bannerStatValue}>24</span>
            <span style={styles.bannerStatChange}>17 wins</span>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div style={styles.statsGrid}>
        {statCards.map((s, i) => (
          <div
            key={i}
            style={{
              ...styles.statCard,
              ...(hovered === `stat-${i}` ? { transform: 'translateY(-3px)', boxShadow: `0 8px 24px rgba(201,162,39,0.12)`, borderColor: `rgba(201,162,39,0.35)` } : {}),
            }}
            onMouseEnter={() => setHovered(`stat-${i}`)}
            onMouseLeave={() => setHovered(null)}
          >
            <div style={styles.statCardTop}>
              <div>
                <div style={styles.statLabel}>{s.label}</div>
              </div>
              <div style={styles.statIconBox}>
                <s.icon size={18} color={GOLD} />
              </div>
            </div>
            <div style={styles.statValue}>{s.value}</div>
            <div style={{ ...styles.statChange, color: s.up === true ? '#22c55e' : s.up === false ? '#ef4444' : '#888' }}>
              {s.up === true ? <ArrowUpRight size={14} /> : s.up === false ? <ArrowDownRight size={14} /> : <Clock size={14} />}
              {s.change}
            </div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div style={styles.mainGrid}>
        {/* Bot control + performance */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Bot Control Center</div>
              <div style={styles.cardSubtitle}>Manage your automated trading strategy</div>
            </div>
            <span style={{
              ...styles.badge,
              background: botRunning ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
              color: botRunning ? '#16a34a' : '#dc2626',
            }}>
              {botRunning ? '● LIVE' : '● STOPPED'}
            </span>
          </div>

          <div style={styles.botControlRow}>
            <button
              style={{
                ...styles.botBtn,
                ...(botRunning ? styles.botBtnDanger : styles.botBtnPrimary),
              }}
              onClick={() => setBotRunning(!botRunning)}
            >
              {botRunning ? <><AlertCircle size={16} /> Stop Bot</> : <><Zap size={16} /> Start Bot</>}
            </button>
            <button style={{ ...styles.botBtn, ...styles.botBtnNeutral }}>
              <RefreshCw size={16} /> Restart
            </button>
            <button style={{ ...styles.botBtn, ...styles.botBtnNeutral }}>
              <Bot size={16} /> Configure
            </button>
          </div>

          {/* Performance bars */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: '0.75rem', fontWeight: 500 }}>Daily Performance (last 12 hours)</div>
            <div style={styles.miniChart}>
              {performanceBars.map((h, i) => (
                <div
                  key={i}
                  style={{
                    ...styles.miniBar,
                    height: `${h}%`,
                    background: h > 70
                      ? `linear-gradient(180deg, ${GOLD_LIGHT}, ${GOLD})`
                      : h > 45
                        ? `rgba(201,162,39,0.5)`
                        : 'rgba(239,68,68,0.4)',
                  }}
                />
              ))}
            </div>
          </div>

          <div style={styles.botStatGrid}>
            {[
              { label: 'Total Trades', value: '1,247' },
              { label: 'Win Rate', value: '73.2%' },
              { label: 'Avg Return', value: '+1.8%' },
              { label: 'Drawdown', value: '3.4%' },
            ].map((s, i) => (
              <div key={i} style={styles.botStatItem}>
                <span style={styles.botStatLabel}>{s.label}</span>
                <span style={styles.botStatValue}>{s.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Active trades */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Active Positions</div>
              <div style={styles.cardSubtitle}>{activeTrades.length} open trades</div>
            </div>
            <span style={{ ...styles.badge, background: 'rgba(201,162,39,0.1)', color: GOLD_DEEP }}>
              Live
            </span>
          </div>
          {activeTrades.map((t, i) => (
            <div key={i} style={{ ...styles.tradeRow, ...(i === activeTrades.length - 1 ? { borderBottom: 'none' } : {}) }}>
              <div style={styles.tradeLeft}>
                <div style={styles.tradeSymbolBox}>{t.symbol}</div>
                <div style={styles.tradeInfo}>
                  <span style={styles.tradeName}>{t.name}</span>
                  <span style={{
                    ...styles.tradeType,
                    color: t.type === 'LONG' ? GOLD_DEEP : '#9333ea',
                    fontWeight: 600,
                  }}>{t.type}</span>
                </div>
              </div>
              <div style={styles.tradeRight}>
                <span style={styles.tradeValue}>{t.value}</span>
                <span style={{ ...styles.tradePnl, color: t.up ? '#22c55e' : '#ef4444' }}>{t.pnl}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom row */}
      <div style={styles.bottomRow}>
        {/* Bot log */}
        <div style={{ ...styles.card, gridColumn: '1 / 3' }}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Bot Activity Log</div>
              <div style={styles.cardSubtitle}>Real-time trading actions</div>
            </div>
            <span style={{ ...styles.badge, background: 'rgba(34,197,94,0.08)', color: '#16a34a' }}>Live</span>
          </div>
          <div style={styles.logList}>
            {botLogs.map((l, i) => (
              <div key={i} style={styles.logItem}>
                <span style={styles.logTime}>{l.time}</span>
                <CheckCircle size={14} color={l.type === 'buy' ? GOLD : l.type === 'sell' ? '#ef4444' : '#888'} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span style={styles.logText}>{l.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick stats */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Risk Overview</div>
              <div style={styles.cardSubtitle}>Current exposure</div>
            </div>
          </div>
          {[
            { label: 'Max Drawdown', value: '3.4%', color: '#f59e0b' },
            { label: 'Exposure', value: '62%', color: GOLD },
            { label: 'Free Capital', value: '$18,440', color: '#22c55e' },
            { label: 'Risk/Trade', value: '1.5%', color: '#888' },
          ].map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.7rem 0', borderBottom: i < 3 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
              <span style={{ fontSize: '0.82rem', color: '#666' }}>{r.label}</span>
              <span style={{ fontSize: '0.92rem', fontWeight: 700, color: r.color }}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
