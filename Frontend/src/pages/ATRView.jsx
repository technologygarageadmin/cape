import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Loader from '../components/loader'
import { ChevronDown, X, BarChart3, Eye, Clock, RefreshCw, ArrowUpDown, TrendingUp, TrendingDown, Search } from 'lucide-react'

const GOLD = '#C9A227'
const GOLD_LIGHT = '#F5C518'
const GOLD_DEEP = '#A07C10'

const styles = {
  page: {
    minHeight: '100vh',
    background: '#ffffff',
    display: 'flex',
    padding: '0',
    position: 'relative',
  },
  sidebar: {
    position: 'fixed',
    left: '0',
    top: '80px',
    bottom: '0',
    width: '280px',
    background: '#ffffff',
    borderRight: `1px solid rgba(201,162,39,0.15)`,
    padding: '2rem 1.25rem 2rem 1.25rem',
    transition: 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
    overflowY: 'auto',
    overflowX: 'hidden',
    boxSizing: 'border-box',
    zIndex: 40,
    boxShadow: '2px 0 16px rgba(201,162,39,0.06)',
    willChange: 'transform',
  },
  sidebarOpen: {
    transform: 'translateX(0)',
  },
  sidebarClosed: {
    transform: 'translateX(-100%)',
  },
  sidebarLogo: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    marginBottom: '1.75rem',
    paddingBottom: '1.25rem',
    borderBottom: `1px solid rgba(201,162,39,0.15)`,
  },
  sidebarLogoIcon: {
    width: '28px',
    height: '28px',
    background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
    borderRadius: '7px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sidebarLogoText: {
    fontSize: '0.9rem',
    fontWeight: 800,
    color: '#111',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  filterBtn: {
    position: 'fixed',
    left: '16px',
    top: '110px',
    background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
    border: 'none',
    borderRadius: '10px',
    padding: '0.75rem 1.1rem',
    cursor: 'pointer',
    zIndex: 50,
    transition: 'all 0.3s ease',
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    fontSize: '0.88rem',
    fontWeight: 700,
    color: '#111',
    boxShadow: `0 4px 14px rgba(201,162,39,0.35)`,
    letterSpacing: '0.03em',
  },
  toggleBtn: {
    position: 'fixed',
    left: '280px',
    top: '100px',
    background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
    border: 'none',
    borderRadius: '0 8px 8px 0',
    padding: '0.6rem 0.5rem',
    cursor: 'pointer',
    zIndex: 50,
    transition: 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#111',
    boxShadow: `2px 4px 14px rgba(201,162,39,0.3)`,
    willChange: 'transform',
  },
  filterGroup: {
    marginBottom: '1.75rem',
  },
  filterTitle: {
    fontSize: '0.72rem',
    fontWeight: 700,
    color: GOLD_DEEP,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: '0.75rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  dateInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.65rem 0.9rem',
    border: `1.5px solid rgba(201,162,39,0.2)`,
    borderRadius: '8px',
    fontSize: '0.85rem',
    fontWeight: 500,
    color: '#333',
    marginBottom: '0.6rem',
    transition: 'all 0.2s ease',
    outline: 'none',
    background: '#fff',
  },
  marketToggle: {
    display: 'flex',
    gap: '0.4rem',
    marginBottom: '0',
    padding: '0.4rem',
    background: `rgba(201,162,39,0.07)`,
    borderRadius: '10px',
    border: `1px solid rgba(201,162,39,0.15)`,
  },
  marketBtn: {
    flex: 1,
    padding: '0.6rem 0.75rem',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
    fontSize: '0.83rem',
    fontWeight: 600,
    transition: 'all 0.2s ease',
    background: 'transparent',
    color: '#888',
  },
  marketBtnActive: {
    background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
    color: '#111',
    boxShadow: `0 2px 8px rgba(201,162,39,0.3)`,
  },
  mainContent: {
    flex: 1,
    padding: '2.5rem 2rem',
    marginTop: '0',
    overflowY: 'auto',
    overflowX: 'hidden',
    transition: 'margin-left 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
    display: 'flex',
    justifyContent: 'center',
  },
  container: {
    maxWidth: '1300px',
    width: '100%',
  },
  header: {
    marginBottom: '2rem',
  },
  title: {
    fontSize: '1.9rem',
    fontWeight: 800,
    color: '#111',
    marginBottom: '0.3rem',
    lineHeight: 1.1,
  },
  titleAccent: {
    color: GOLD,
  },
  subtitle: {
    fontSize: '0.875rem',
    color: '#888',
  },
  // Stats summary row
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  statCard: {
    background: '#fff',
    border: `1px solid rgba(201,162,39,0.15)`,
    borderRadius: '12px',
    padding: '1.1rem 1.25rem',
    boxShadow: '0 2px 10px rgba(0,0,0,0.04)',
    display: 'flex',
    alignItems: 'center',
    gap: '0.875rem',
  },
  statIconBox: {
    width: '38px',
    height: '38px',
    borderRadius: '10px',
    background: `rgba(201,162,39,0.1)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statInfo: { display: 'flex', flexDirection: 'column', gap: '0.15rem' },
  statLabel: { fontSize: '0.7rem', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 500 },
  statValue: { fontSize: '1.1rem', fontWeight: 800, color: '#111', lineHeight: 1 },
  // Search bar
  searchBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1.25rem',
    justifyContent: 'space-between',
  },
  searchInput: {
    flex: 1,
    maxWidth: '420px',
    padding: '0.7rem 1rem 0.7rem 2.75rem',
    border: `1.5px solid rgba(201,162,39,0.2)`,
    borderRadius: '10px',
    fontSize: '0.88rem',
    color: '#333',
    outline: 'none',
    background: '#fff',
    transition: 'all 0.2s ease',
    fontWeight: 500,
  },
  searchWrap: {
    position: 'relative',
    flex: 1,
    maxWidth: '420px',
  },
  searchIcon: {
    position: 'absolute',
    left: '0.875rem',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: '#bbb',
  },
  refreshInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    fontSize: '0.82rem',
    color: '#888',
    whiteSpace: 'nowrap',
  },
  refreshChip: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.45rem 0.9rem',
    background: `rgba(201,162,39,0.07)`,
    border: `1px solid rgba(201,162,39,0.2)`,
    borderRadius: '20px',
    fontSize: '0.78rem',
    fontWeight: 600,
    color: GOLD_DEEP,
  },
  tableSection: {
    background: '#ffffff',
    border: `1px solid rgba(201,162,39,0.12)`,
    borderRadius: '14px',
    overflow: 'hidden',
    boxShadow: '0 2px 16px rgba(0,0,0,0.04)',
  },
  tableScrollWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
    minWidth: '900px',
  },
  tableHeader: {
    background: `rgba(201,162,39,0.04)`,
    borderBottom: `2px solid rgba(201,162,39,0.15)`,
  },
  tableHeaderCell: {
    padding: '0.9rem 1rem',
    textAlign: 'left',
    fontSize: '0.72rem',
    fontWeight: 700,
    color: GOLD_DEEP,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  tableRow: {
    borderBottom: '1px solid rgba(0,0,0,0.04)',
    transition: 'all 0.15s ease',
  },
  tableRowHover: {
    background: `rgba(201,162,39,0.04)`,
  },
  tableRowTrading: {
    background: `rgba(201,162,39,0.08)`,
    boxShadow: `inset 3px 0 0 ${GOLD}`,
  },
  tableCell: {
    padding: '0.85rem 1rem',
    fontSize: '0.875rem',
    color: '#444',
    whiteSpace: 'nowrap',
  },
  symbol: {
    fontWeight: 700,
    color: '#111',
    fontSize: '0.9rem',
  },
  typeBadge: {
    display: 'inline-block',
    padding: '0.2rem 0.55rem',
    borderRadius: '20px',
    fontSize: '0.68rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  priceUp: {
    color: '#10b981',
  },
  priceDown: {
    color: '#ef4444',
  },
  rowNumber: {
    color: '#ccc',
    fontWeight: 600,
    fontSize: '0.8rem',
  },
  atrBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
  },
  atrBarTrack: {
    width: '60px',
    height: '4px',
    background: 'rgba(0,0,0,0.07)',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  atrBarFill: {
    height: '100%',
    borderRadius: '2px',
    background: `linear-gradient(90deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
  },
}

const CAPE_API_URL = 'https://kvf5ajrze1.execute-api.us-east-1.amazonaws.com/default/Cape_HandleSymbols'
const ATR_SCANNER_API_URL = 'https://2fhpr2inu4.execute-api.us-east-1.amazonaws.com/default/Cape_AtrScanner'

function ATRView() {
  const navigate = useNavigate()
  const isFirstMount = React.useRef(true)
  const [activeTab, setActiveTab] = React.useState('atr')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [hoveredRow, setHoveredRow] = useState(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [viewType, setViewType] = useState('most-active')
  const [selectedMarkets, setSelectedMarkets] = useState(['stock'])
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState([])
  const [tradingSymbols, setTradingSymbols] = useState(new Set())
  const [userId, setUserId] = useState(null)
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' })
  const [lastRefreshTime, setLastRefreshTime] = useState(null)
  const [nextRefreshIn, setNextRefreshIn] = useState(60)
  const [sortConfig, setSortConfig] = useState({ key: 'atr', direction: 'desc' })
  const [searchTerm, setSearchTerm] = useState('')
  const [tooltip, setTooltip] = useState({ show: false, text: '', x: 0, y: 0 })

  // Show toast notification
  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type })
    setTimeout(() => {
      setToast({ show: false, message: '', type: 'success' })
    }, 3000)
  }

  // Handle column sorting
  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }))
  }

  // Show tooltip with info
  const showTooltip = (text, e) => {
    if (e && e.currentTarget) {
      const rect = e.currentTarget.getBoundingClientRect()
      setTooltip({
        show: true,
        text,
        x: rect.left + rect.width / 2,
        y: rect.top - 10
      })
    }
  }

  const hideTooltip = () => {
    setTooltip({ show: false, text: '', x: 0, y: 0 })
  }

  // Get sorted and filtered rows
  const getSortedAndFilteredRows = () => {
    let filtered = rows.filter(row =>
      row.symbol.toLowerCase().includes(searchTerm.toLowerCase())
    )

    const sorted = [...filtered].sort((a, b) => {
      const aVal = a[sortConfig.key] ?? 0
      const bVal = b[sortConfig.key] ?? 0
      return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal
    })

    return sorted
  }

  // Calculate summary stats
  const getStats = (dataRows = null) => {
    const statsData = dataRows || rows
    if (statsData.length === 0) return { gainers: 0, losers: 0, totalVolume: 0, avgAtr: 0 }
    const gainers = statsData.filter(r => (r.chg_pct ?? 0) > 0).length
    const losers = statsData.filter(r => (r.chg_pct ?? 0) < 0).length
    const totalVolume = statsData.reduce((sum, r) => sum + (r.volume ?? 0), 0)
    const avgAtr = statsData.reduce((sum, r) => sum + (r.atr ?? 0), 0) / statsData.length
    return { gainers, losers, totalVolume, avgAtr }
  }

  // Countdown timer for next refresh
  useEffect(() => {
    const countdownInterval = setInterval(() => {
      setNextRefreshIn(prev => {
        if (prev <= 1) {
          return 60
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(countdownInterval)
  }, [])

  // Fetch user ID and trading symbols on mount
  useEffect(() => {
    const storedUserId = localStorage.getItem('userId')
    if (storedUserId) {
      setUserId(storedUserId)
      fetchTradingSymbols(storedUserId)
    }
  }, [])

  // Fetch trading symbols from API
  const fetchTradingSymbols = async (uid) => {
    try {
      
      const response = await fetch(CAPE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: uid,
          mode: 'GET',
        }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.symbols && Array.isArray(data.symbols)) {
          setTradingSymbols(new Set(data.symbols))
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('Failed to fetch trading symbols:', response.status, response.statusText, errorData)
      }
    } catch (err) {
      console.error('Failed to fetch trading symbols:', err)
    }
  }

  // Handle Start/Stop Trading button click
  const handleTradeButtonClick = async (symbol) => {
    if (!userId) {
      alert('User ID not found. Please login again.')
      return
    }

    const isCurrentlyTrading = Array.from(tradingSymbols).includes(symbol)
    const mode = isCurrentlyTrading ? 'REMOVE' : 'ADD'

    try {
      const response = await fetch(CAPE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          symbol,
          mode,
        }),
      })

      if (response.ok) {
        // Update local state
        const newSet = new Set(tradingSymbols)
        if (isCurrentlyTrading) {
          newSet.delete(symbol)
          showToast(`Removed ${symbol} from trading`, 'success')
        } else {
          newSet.add(symbol)
          showToast(`Added ${symbol} to account`, 'success')
        }
        setTradingSymbols(newSet)
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('Failed to update trading symbol:', response.statusText, errorData)
        showToast('Failed to update trading status', 'error')
      }
    } catch (err) {
      console.error('Error updating trading symbol:', err)
      showToast('Error updating trading status', 'error')
    }
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        setError('')

        const include_stocks = selectedMarkets.includes('stock')
        const include_crypto = selectedMarkets.includes('crypto')

        if (!include_stocks && !include_crypto) {
          setRows([])
          setLoading(false)
          setInitialLoading(false)
          return
        }

        const res = await fetch(ATR_SCANNER_API_URL, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        })

        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || `Request failed with status ${res.status}`)
        }

        let data = await res.json()
        data = Array.isArray(data) ? data : []

        // Filter by selected markets
        if (!include_stocks || !include_crypto) {
          data = data.filter(item => {
            const assetType = item.asset_type?.toUpperCase()
            if (assetType === 'STOCK' || assetType === 'EQUITY') {
              return include_stocks
            } else if (assetType === 'CRYPTO' || assetType === 'CRYPTOCURRENCY') {
              return include_crypto
            }
            return true
          })
        }

        // Apply View Type filter (Gainers/Losers/Most Active)
        if (viewType === 'gainers') {
          data.sort((a, b) => (b.chg_pct ?? 0) - (a.chg_pct ?? 0))
        } else if (viewType === 'losers') {
          data.sort((a, b) => (a.chg_pct ?? 0) - (b.chg_pct ?? 0))
        } else if (viewType === 'most-active') {
          // Most active = highest ATR
          data.sort((a, b) => (b.atr ?? 0) - (a.atr ?? 0))
        }

        setRows(data)
        setError('')
        setInitialLoading(false)
        // Cache data in sessionStorage
        sessionStorage.setItem('atrViewData', JSON.stringify(data))
        // Update refresh time
        setLastRefreshTime(new Date().toLocaleTimeString())
        setNextRefreshIn(60)
      } catch (err) {
        console.error(err)
        setError('Failed to load ATR data')
        if (initialLoading) {
          setRows([])
        }
        setInitialLoading(false)
      } finally {
        setLoading(false)
      }
    }

    // On first mount, check for cached data
    if (isFirstMount.current) {
      isFirstMount.current = false
      const cachedData = sessionStorage.getItem('atrViewData')
      
      if (cachedData) {
        try {
          const parsedData = JSON.parse(cachedData)
          setRows(parsedData)
          setInitialLoading(false)
        } catch (err) {
          console.error('Failed to parse cached data:', err)
        }
      }
      
      // Still fetch fresh data in background
      fetchData()

      const intervalId = setInterval(fetchData, 60_000)
      return () => {
        clearInterval(intervalId)
      }
    } else {
      // On filter changes, fetch fresh data
      fetchData()
    }
  }, [selectedMarkets.toString(), viewType, startDate, endDate])

  return (
    <>
      {/* Toast Notification */}
      {toast.show && (
        <div style={{
          position: 'fixed',
          top: '100px',
          right: '24px',
          padding: '0.9rem 1.4rem',
          borderRadius: '12px',
          background: toast.type === 'success'
            ? `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`
            : '#ef4444',
          color: toast.type === 'success' ? '#111' : '#fff',
          fontSize: '0.88rem',
          fontWeight: 700,
          boxShadow: toast.type === 'success'
            ? `0 8px 24px rgba(201,162,39,0.4)`
            : '0 8px 24px rgba(239,68,68,0.35)',
          zIndex: 1000,
          animation: 'slideIn 0.3s ease-out',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          letterSpacing: '0.02em',
        }}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.message}
        </div>
      )}
      
      {/* Tooltip */}
      {tooltip.show && (
        <div style={{
          position: 'fixed',
          left: `${tooltip.x}px`,
          top: `${tooltip.y}px`,
          background: '#1f2937',
          color: '#fff',
          padding: '0.5rem 0.75rem',
          borderRadius: '6px',
          fontSize: '0.8rem',
          whiteSpace: 'nowrap',
          zIndex: 1001,
          pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        }}>
          {tooltip.text}
          <div style={{
            position: 'absolute',
            top: '-4px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '0',
            height: '0',
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderBottom: '4px solid #1f2937',
          }} />
        </div>
      )}
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(400px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes fadeInRow {
          from {
            opacity: 0;
            transform: translateY(-5px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
      <div style={styles.page}>
        {/* Sidebar */}
        <div style={{
          ...styles.sidebar,
          ...(sidebarOpen ? styles.sidebarOpen : styles.sidebarClosed),
        }}>
          {/* Sidebar header */}
          <div style={styles.sidebarLogo}>
            <div style={styles.sidebarLogoIcon}>
              <BarChart3 size={14} color="#111" />
            </div>
            <span style={styles.sidebarLogoText}>Filters</span>
          </div>

          {/* Date Range Filter */}
          <div style={styles.filterGroup}>
            <div style={styles.filterTitle}>
              <Clock size={11} /> Date Range
            </div>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={styles.dateInput}
              onFocus={(e) => { e.target.style.borderColor = GOLD; e.target.style.boxShadow = `0 0 0 3px rgba(201,162,39,0.1)` }}
              onBlur={(e) => { e.target.style.borderColor = 'rgba(201,162,39,0.2)'; e.target.style.boxShadow = 'none' }}
            />
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={styles.dateInput}
              onFocus={(e) => { e.target.style.borderColor = GOLD; e.target.style.boxShadow = `0 0 0 3px rgba(201,162,39,0.1)` }}
              onBlur={(e) => { e.target.style.borderColor = 'rgba(201,162,39,0.2)'; e.target.style.boxShadow = 'none' }}
            />
          </div>

          {/* Market Type Toggle */}
          <div style={styles.filterGroup}>
            <div style={styles.filterTitle}><TrendingUp size={11} /> Market Type</div>
            <div style={styles.marketToggle}>
              <button
                style={{
                  ...styles.marketBtn,
                  ...styles.marketBtnActive,
                }}
                disabled
              >
                Options / Stock
              </button>
            </div>
          </div>

          {/* View Type Filter */}
          <div style={styles.filterGroup}>
            <div style={styles.filterTitle}><BarChart3 size={11} /> View Type</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {[
                { id: 'gainers', label: 'Gainers', color: '#10b981' },
                { id: 'losers', label: 'Losers', color: '#ef4444' },
                { id: 'most-active', label: 'Most Active', color: GOLD_DEEP },
              ].map((type) => (
                <button
                  key={type.id}
                  onClick={() => setViewType(type.id)}
                  style={{
                    padding: '0.65rem 0.9rem',
                    borderRadius: '8px',
                    border: viewType === type.id ? `1.5px solid ${GOLD}` : '1.5px solid rgba(0,0,0,0.07)',
                    background: viewType === type.id ? `rgba(201,162,39,0.08)` : '#fff',
                    color: viewType === type.id ? '#111' : '#666',
                    fontWeight: viewType === type.id ? 700 : 500,
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s ease',
                    letterSpacing: '0.02em',
                  }}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Filter Button - when sidebar is closed */}
        {!sidebarOpen && (
          <button
            style={styles.filterBtn}
            onClick={() => setSidebarOpen(true)}
          >
            <BarChart3 size={17} strokeWidth={2.2} />
            Filters
          </button>
        )}

        {/* Close Button - only visible when sidebar is open */}
        {sidebarOpen && (
          <button
            style={styles.toggleBtn}
            onClick={() => setSidebarOpen(false)}
            title="Close Filters"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        )}

        {/* Main Content */}
        <div style={{
          ...styles.mainContent,
          marginLeft: sidebarOpen ? '300px' : '0',
        }}>
          <div style={styles.container}>
            {/* Header */}
            <div style={{ ...styles.header, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '2rem' }}>
              <div>
                <h1 style={styles.title}>
                  ATR <span style={styles.titleAccent}>Market Scanner</span>
                </h1>
                <p style={styles.subtitle}>Sorted by Average True Range — options &amp; stocks in real-time</p>
              </div>
              <div style={styles.refreshInfo}>
                <div style={styles.refreshChip}>
                  <RefreshCw size={13} />
                  {lastRefreshTime ? lastRefreshTime : 'Updating...'}
                </div>
                <div style={styles.refreshChip}>
                  <Clock size={13} />
                  Next: {nextRefreshIn}s
                </div>
              </div>
            </div>

            {/* Stats summary */}
            {!initialLoading && rows.length > 0 && (() => {
              const stats = getStats()
              return (
                <div style={styles.statsRow}>
                  {[
                    { label: 'Total Symbols', value: rows.length, icon: BarChart3, color: GOLD },
                    { label: 'Gainers', value: stats.gainers, icon: TrendingUp, color: '#10b981' },
                    { label: 'Losers', value: stats.losers, icon: TrendingDown, color: '#ef4444' },
                    { label: 'Avg ATR', value: stats.avgAtr.toFixed(4), icon: Search, color: GOLD_DEEP },
                  ].map((s, i) => (
                    <div key={i} style={styles.statCard}>
                      <div style={{ ...styles.statIconBox, background: `${s.color}18` }}>
                        <s.icon size={17} color={s.color} />
                      </div>
                      <div style={styles.statInfo}>
                        <span style={styles.statLabel}>{s.label}</span>
                        <span style={{ ...styles.statValue, color: s.color }}>{s.value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Search bar */}
            <div style={styles.searchBar}>
              <div style={styles.searchWrap}>
                <Search size={15} style={styles.searchIcon} />
                <input
                  type="text"
                  placeholder="Search symbol..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={styles.searchInput}
                  onFocus={e => { e.target.style.borderColor = GOLD; e.target.style.boxShadow = `0 0 0 3px rgba(201,162,39,0.1)` }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(201,162,39,0.2)'; e.target.style.boxShadow = 'none' }}
                />
              </div>
              {searchTerm && rows.length > 0 && (
                <div style={{ fontSize: '0.8rem', color: '#aaa', fontWeight: 500 }}>
                  {getSortedAndFilteredRows().length} of {rows.length} results
                </div>
              )}
            </div>

            {/* Table Section */}
            <div style={styles.tableSection}>
              {initialLoading && (
                <div style={{ padding: '3rem', display: 'flex', justifyContent: 'center' }}>
                  <Loader size="medium" fullScreen={false} text="Loading ATR data" hardcodeVariant="orbit" />
                </div>
              )}
              {error && !initialLoading && (
                <div style={{ padding: '2rem', color: '#ef4444', fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  ⚠ {error}
                </div>
              )}
              {!initialLoading && !error && rows.length === 0 && (
                <div style={{ padding: '3rem', textAlign: 'center', color: '#aaa', fontSize: '0.9rem' }}>
                  <BarChart3 size={32} style={{ margin: '0 auto 1rem', opacity: 0.3, display: 'block' }} />
                  No data available for the selected filters.
                </div>
              )}

              {!initialLoading && rows.length > 0 && (
                <>
                  <style>{`
                    @keyframes pulse {
                      0%, 100% { opacity: 1; }
                      50% { opacity: 0.5; }
                    }
                  `}</style>
                  {loading && (
                    <div style={{
                      position: 'fixed',
                      bottom: '2rem',
                      right: '2rem',
                      background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
                      color: '#111',
                      padding: '0.7rem 1.25rem',
                      borderRadius: '10px',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      zIndex: 100,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      boxShadow: `0 6px 20px rgba(201,162,39,0.4)`,
                      letterSpacing: '0.02em',
                    }}>
                      <div style={{
                        width: '8px',
                        height: '8px',
                        background: '#111',
                        borderRadius: '50%',
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }}></div>
                      Refreshing data...
                    </div>
                  )}
                  <div style={styles.tableScrollWrap}>
              <table style={styles.table}>
                <thead style={styles.tableHeader}>
                  <tr>
                    {[['#', null], ['Symbol', 'symbol'], ['Type', null], ['Last', 'last_close'], ['Net Chg $', 'net_change'], ['Chg %', 'chg_pct'], ['Volume', 'volume'], ['Bid', null], ['Ask', null], ['ATR', 'atr'], ['Action', null]].map(([label, key], i) => (
                      <th
                        key={i}
                        style={{ ...styles.tableHeaderCell, ...(key ? { cursor: 'pointer' } : {}) }}
                        onClick={key ? () => handleSort(key) : undefined}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          {label}
                          {key && (
                            <ArrowUpDown
                              size={12}
                              style={{ opacity: sortConfig.key === key ? 1 : 0.3, color: sortConfig.key === key ? GOLD : 'inherit' }}
                            />
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {getSortedAndFilteredRows().map((row, index) => {
                    const netChange = row.net_change ?? row.netChange ?? 0
                    const chgPct = row.chg_pct ?? row.chgPercent ?? 0
                    const volume = row.volume ?? ''
                    const last = row.last_close ?? row.last ?? 0
                    const bid = row.bid ?? last
                    const ask = row.ask ?? last

                    const isDown = netChange < 0

                    // ATR bar width relative to max ATR in current view
                    const maxAtr = Math.max(...getSortedAndFilteredRows().map(r => r.atr ?? 0), 1)
                    const atrWidth = Math.min(((row.atr ?? 0) / maxAtr) * 100, 100)
                    const isTrading = tradingSymbols.has(row.symbol)

                    return (
                    <tr
                      key={row.symbol + index}
                      style={{
                        ...styles.tableRow,
                        ...(hoveredRow === index ? styles.tableRowHover : {}),
                        ...(isTrading ? styles.tableRowTrading : {}),
                        animation: 'fadeInRow 0.3s ease-out',
                      }}
                      onMouseEnter={() => setHoveredRow(index)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      <td style={styles.tableCell}>
                        <span style={styles.rowNumber}>{index + 1}</span>
                      </td>
                      <td style={{ ...styles.tableCell, ...styles.symbol }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {isTrading && (
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: GOLD, boxShadow: `0 0 6px ${GOLD}`, flexShrink: 0 }} />
                          )}
                          {row.symbol}
                        </div>
                      </td>
                      <td style={styles.tableCell}>
                        <span style={{
                          ...styles.typeBadge,
                          background: row.asset_type?.toUpperCase().includes('CRYPTO')
                            ? 'rgba(139,92,246,0.1)' : 'rgba(201,162,39,0.1)',
                          color: row.asset_type?.toUpperCase().includes('CRYPTO')
                            ? '#7c3aed' : GOLD_DEEP,
                        }}>
                          {row.asset_type}
                        </span>
                      </td>
                      <td style={styles.tableCell}>${last.toFixed(4)}</td>
                      <td style={{ ...styles.tableCell, color: isDown ? '#ef4444' : '#10b981', fontWeight: 600 }}>
                        {isDown ? '▼' : '▲'} ${Math.abs(netChange).toFixed(4)}
                      </td>
                      <td style={{ ...styles.tableCell, color: chgPct < 0 ? '#ef4444' : '#10b981', fontWeight: 700 }}>
                        {chgPct < 0 ? '▼' : '▲'} {Math.abs(chgPct).toFixed(2)}%
                      </td>
                      <td style={styles.tableCell}>{volume ? (volume.toLocaleString?.() ?? volume) : '—'}</td>
                      <td style={styles.tableCell}>${bid.toFixed(4)}</td>
                      <td style={styles.tableCell}>${ask.toFixed(4)}</td>
                      <td style={styles.tableCell}>
                        <div style={styles.atrBar}>
                          <span style={{ fontWeight: 600, color: '#333', minWidth: '60px' }}>{row.atr?.toFixed(4)}</span>
                          <div style={styles.atrBarTrack}>
                            <div style={{ ...styles.atrBarFill, width: `${atrWidth}%` }} />
                          </div>
                        </div>
                      </td>
                      <td style={styles.tableCell}>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            onClick={() => navigate(`/atr/${encodeURIComponent(row.symbol)}`)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                              padding: '0.45rem 0.9rem',
                              background: `linear-gradient(135deg, ${GOLD} 0%, ${GOLD_LIGHT} 100%)`,
                              color: '#111',
                              border: 'none',
                              borderRadius: '7px',
                              cursor: 'pointer',
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              transition: 'all 0.2s ease',
                              boxShadow: `0 2px 8px rgba(201,162,39,0.25)`,
                              whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = `0 4px 14px rgba(201,162,39,0.4)` }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = `0 2px 8px rgba(201,162,39,0.25)` }}
                          >
                            <Eye size={14} /> View
                          </button>
                          <button
                            onClick={() => handleTradeButtonClick(row.symbol)}
                            style={{
                              padding: '0.45rem 0.9rem',
                              background: isTrading ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
                              color: isTrading ? '#ef4444' : '#10b981',
                              border: isTrading ? '1.5px solid rgba(239,68,68,0.25)' : '1.5px solid rgba(16,185,129,0.25)',
                              borderRadius: '7px',
                              cursor: 'pointer',
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              transition: 'all 0.2s ease',
                              whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = '0.8' }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
                          >
                            {isTrading ? '■ Stop' : '▶ Trade'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )})}  
                </tbody>
              </table>
              
              {getSortedAndFilteredRows().length === 0 && rows.length > 0 && (
                <div style={{
                  textAlign: 'center',
                  padding: '3rem 2rem',
                  color: '#bbb',
                  fontSize: '0.9rem',
                }}>
                  <Search size={28} style={{ margin: '0 auto 0.75rem', opacity: 0.35, display: 'block', color: GOLD }} />
                  <p style={{ fontWeight: 600, color: '#888' }}>No symbols match &ldquo;<span style={{ color: '#111' }}>{searchTerm}</span>&rdquo;</p>
                  <p style={{ fontSize: '0.8rem', marginTop: '0.35rem' }}>Try a different search term</p>
                </div>
              )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default ATRView
