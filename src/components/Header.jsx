import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Bell, X, TrendingUp, Lock, DollarSign } from 'lucide-react'
import logo from '../assets/logo.png'

const styles = {
  header: {
    background: '#ffffff',
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
    color: '#000000',
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
    color: '#666',
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
    color: '#666',
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
    background: '#ffffff',
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
    color: '#000',
  },
  notificationCloseBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.25rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#666',
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
    color: '#000',
  },
  notificationItemText: {
    fontSize: '0.85rem',
    color: '#666',
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
    color: '#666',
    borderRadius: '8px',
  },
  settingsButtonHover: {
    color: '#A07C10',
    background: 'rgba(201,162,39,0.08)',
  },
}

function Header({ activeTab, onTabChange }) {
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
                    e.currentTarget.style.color = '#000'
                  }
                }}
                onMouseLeave={(e) => {
                  if (activeTab !== item.id) {
                    e.currentTarget.style.color = '#666'
                  }
                }}
              >
                {item.label}
              </li>
            ))}
          </ul>
          <div style={styles.rightSection}>
          <div style={{ position: 'relative' }} ref={notificationRef}>
            <button
              style={styles.notificationButton}
              title="Notifications"
              onClick={() => setNotificationOpen(!notificationOpen)}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#000'
                e.currentTarget.style.transform = 'scale(1.1)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#666'
                e.currentTarget.style.transform = 'scale(1)'
              }}
            >
              <Bell size={22} />
              {notificationCount > 0 && (
                <div style={styles.notificationBadge}>{notificationCount}</div>
              )}
            </button>

            {notificationOpen && (
              <div style={styles.notificationDropdown}>
                <div style={styles.notificationHeader}>
                  <span style={styles.notificationTitle}>Notifications</span>
                  <button
                    style={styles.notificationCloseBtn}
                    onClick={() => setNotificationOpen(false)}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#000')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#666')}
                  >
                    <X size={20} />
                  </button>
                </div>
                <div style={styles.notificationList}>
                  {notifications.map((notif) => {
                    const IconComponent = notif.icon
                    return (
                      <div
                        key={notif.id}
                        style={{
                          ...styles.notificationItem,
                          ...(hoveredNotif === notif.id ? styles.notificationItemHover : {}),
                        }}
                        onMouseEnter={() => setHoveredNotif(notif.id)}
                        onMouseLeave={() => setHoveredNotif(null)}
                      >
                        <div style={styles.notificationItemIcon}>
                          <IconComponent size={20} color="#000" strokeWidth={1.5} />
                        </div>
                        <div style={styles.notificationContent}>
                          <div style={styles.notificationItemTitle}>{notif.title}</div>
                          <div style={styles.notificationItemText}>{notif.text}</div>
                          <div style={styles.notificationTime}>{notif.time}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          <button
            style={{
              ...styles.settingsButton,
              ...(settingsHover ? styles.settingsButtonHover : {}),
            }}
            onClick={() => navigate('/profile')}
            onMouseEnter={(e) => {
              setSettingsHover(true)
              e.currentTarget.style.transform = 'rotate(20deg) scale(1.1)'
            }}
            onMouseLeave={(e) => {
              setSettingsHover(false)
              e.currentTarget.style.transform = 'none'
            }}
            title="Go to Profile"
          >
            <Settings size={22} />
          </button>
        </div>
        </div>
      </div>
    </header>
  )
}

export default Header
