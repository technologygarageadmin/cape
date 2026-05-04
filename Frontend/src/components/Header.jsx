import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Bell, X, TrendingUp, Lock, DollarSign, LogOut, Sun, Moon } from 'lucide-react'
import logo from '../assets/logo.png'

const styles = {
  header: {
    background: 'var(--bg)',
    borderBottom: '1px solid rgba(201,162,39,0.15)',
    boxShadow: '0 4px 16px rgba(201,162,39,0.08)',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    backdropFilter: 'blur(8px)',
    width: '100%',
  },
  headerContainer: {
    maxWidth: '100%',
    margin: '0 auto',
    padding: '1rem 2rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '2rem',
  },
  brandSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexShrink: 0,
    cursor: 'pointer',
    transition: 'all 0.3s ease',
  },
  brandSectionHover: {
    transform: 'scale(1.02)',
  },
  logoIcon: {
    width: '68px',
    height: '68px',
    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.08))',
    transition: 'all 0.3s ease',
  },
  brandText: {
    display: 'flex',
    flexDirection: 'column',
    lineHeight: 1.1,
  },
  brandName: {
    fontSize: '1.4rem',
    fontWeight: 900,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--text-h)',
  },
  brandTagline: {
    fontSize: '0.69rem',
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    color: '#A07C10',
    marginTop: '0.05rem',
    fontWeight: 500,
  },
  navMenu: {
    display: 'flex',
    listStyle: 'none',
    gap: '2rem',
    margin: 0,
    padding: 0,
  },
  rightNav: {
    display: 'flex',
    alignItems: 'center',
    gap: '2rem',
  },
  navItem: {
    cursor: 'pointer',
    color: 'var(--text)',
    fontWeight: 500,
    fontSize: '0.85rem',
    transition: 'all 0.3s ease',
    paddingBottom: '0.5rem',
    borderBottom: '2px solid transparent',
    position: 'relative',
    padding: '0.5rem 0',
  },
  navItemActive: {
    color: '#A07C10',
    borderBottom: '2px solid #C9A227',
    fontWeight: 600,
  },
  rightSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    flexShrink: 0,
  },
  notificationButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.3s ease',
    color: 'var(--text)',
    position: 'relative',
  },
  notificationBadge: {
    position: 'absolute',
    top: '0',
    right: '0',
    background: '#ff4757',
    color: 'white',
    borderRadius: '50%',
    width: '18px',
    height: '18px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.65rem',
    fontWeight: 700,
  },
  notificationDropdown: {
    position: 'absolute',
    top: '100%',
    right: '0',
    marginTop: '0.5rem',
    background: 'var(--bg)',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: '12px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
    minWidth: '320px',
    maxWidth: '380px',
    zIndex: 1000,
  },
  notificationHeader: {
    padding: '1rem',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  notificationTitle: {
    fontSize: '1rem',
    fontWeight: 700,
    color: 'var(--text-h)',
  },
  notificationCloseBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.25rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text)',
    transition: 'all 0.2s ease',
  },
  notificationList: {
    maxHeight: '400px',
    overflowY: 'auto',
  },
  notificationItem: {
    padding: '1rem',
    borderBottom: '1px solid rgba(0,0,0,0.04)',
    display: 'flex',
    gap: '1rem',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  notificationItemHover: {
    background: 'rgba(201,162,39,0.06)',
  },
  notificationItemIcon: {
    width: '40px',
    height: '40px',
    borderRadius: '10px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(201,162,39,0.1)',
    flexShrink: 0,
  },
  notificationContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  notificationItemTitle: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: 'var(--text-h)',
  },
  notificationItemText: {
    fontSize: '0.85rem',
    color: 'var(--text)',
    lineHeight: 1.4,
  },
  notificationTime: {
    fontSize: '0.75rem',
    color: '#999',
    marginTop: '0.25rem',
  },
  settingsButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.3s ease',
    color: 'var(--text)',
    borderRadius: '8px',
  },
  settingsButtonHover: {
    color: '#A07C10',
    background: 'rgba(201,162,39,0.08)',
  },
  logoutButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    border: '1px solid rgba(239,68,68,0.28)',
    background: 'rgba(239,68,68,0.08)',
    color: '#dc2626',
    borderRadius: '8px',
    padding: '0.45rem 0.65rem',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700,
    transition: 'all 0.2s ease',
  },
}

function Header({ activeTab, onTabChange, onLogout, darkMode, toggleDarkMode }) {
  const navigate = useNavigate()
  const [brandHover, setBrandHover] = useState(false)
  const [settingsHover, setSettingsHover] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [hoveredNotif, setHoveredNotif] = useState(null)
  const [notificationCount] = useState(3)
  const notificationRef = useRef(null)

  const notifications = [
    {
      id: 1,
      icon: TrendingUp,
      title: 'Price Alert',
      text: 'AAPL crossed above $185 — signal triggered',
      time: '5 min ago',
    },
    {
      id: 2,
      icon: DollarSign,
      title: 'Trade Executed',
      text: 'BUY order filled — NVDA at $892.40',
      time: '1 hour ago',
    },
    {
      id: 3,
      icon: Lock,
      title: 'Security Alert',
      text: 'New login from new device detected',
      time: '3 hours ago',
    },
  ]

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setNotificationOpen(false)
      }
    }
    
    if (notificationOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [notificationOpen])

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', route: '/dashboard' },
    { id: 'live', label: 'Live Positions', route: '/live' },
    { id: 'radar', label: 'Signal Radar', route: '/radar' },
    { id: 'atr', label: 'ATR View', route: '/atr' },
    { id: 'trading', label: 'Trading View', route: '/trading' },
    { id: 'summary', label: 'Overall Summary', route: '/summary' },
  ]

  const handleTabChange = (itemId, route) => {
    onTabChange(itemId)
    navigate(route)
  }

  const handleLogoutClick = () => {
    onLogout?.()
    navigate('/lock', { replace: true })
  }

  return (
    <header style={styles.header}>
      <div style={styles.headerContainer}>
        <div
          style={{
            ...styles.brandSection,
            ...(brandHover ? styles.brandSectionHover : {}),
          }}
          onClick={() => navigate('/')}
          onMouseEnter={() => setBrandHover(true)}
          onMouseLeave={() => setBrandHover(false)}
        >
          <img src={logo} alt="Cape Logo" style={styles.logoIcon} />
          <div style={styles.brandText}>
            <span style={styles.brandName}>Cape</span>
            <span style={styles.brandTagline}>Let the money work for you</span>
          </div>
        </div>
        <div style={styles.rightNav}>
          <ul style={styles.navMenu}>
            {menuItems.map((item) => (
              <li
                key={item.id}
                style={{
                  ...styles.navItem,
                  ...(activeTab === item.id ? styles.navItemActive : {}),
                }}
                onClick={() => handleTabChange(item.id, item.route)}
                onMouseEnter={(e) => {
                  if (activeTab !== item.id) {
                    e.currentTarget.style.color = darkMode ? '#e8e8e8' : '#000'
                  }
                }}
                onMouseLeave={(e) => {
                  if (activeTab !== item.id) {
                    e.currentTarget.style.color = 'var(--text)'
                  }
                }}
              >
                {item.label}
              </li>
            ))}
          </ul>
          <div style={styles.rightSection}>
         
          {/* Dark mode toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Sun size={13} color={darkMode ? '#666' : '#C9A227'} />
            <button
              onClick={toggleDarkMode}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{
                position: 'relative',
                width: '40px',
                height: '22px',
                borderRadius: '11px',
                background: darkMode ? '#C9A227' : '#e8e3d8',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                transition: 'background 0.3s ease',
                flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute',
                top: '2px',
                left: darkMode ? '20px' : '2px',
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                background: '#ffffff',
                transition: 'left 0.25s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                display: 'block',
              }} />
            </button>
            <Moon size={13} color={darkMode ? '#C9A227' : '#999'} />
          </div>
          
          <button
            style={styles.logoutButton}
            onClick={handleLogoutClick}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.14)'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(239,68,68,0.08)'
              e.currentTarget.style.transform = 'translateY(0)'
            }}
            title="End session"
          >
            <LogOut size={15} />
            Logout
          </button>
        </div>
        </div>
      </div>
    </header>
  )
}

export default Header
