import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Header from './components/Header'
import Footer from './components/Footer'
import Dashboard from './pages/Dashboard'
import TradingView from './pages/TradingView'
import ATRView from './pages/ATRView'
import OverallSummary from './pages/OverallSummary'
import LivePositions from './pages/LivePositions'
import SignalRadar from './pages/SignalRadar'
import WebLock from './pages/WebLock'

const LOCK_SESSION_KEY = 'cape_ui_unlocked'
const DARK_MODE_KEY   = 'cape_ui_dark'

function ProtectedShell({ activeTab, setActiveTab, onLogout, darkMode, toggleDarkMode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <Header activeTab={activeTab} onTabChange={setActiveTab} onLogout={onLogout} darkMode={darkMode} toggleDarkMode={toggleDarkMode} />
      <main style={{ flex: 1, padding: '2rem', boxSizing: 'border-box' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/trading" element={<TradingView />} />
          <Route path="/atr" element={<ATRView />} />
          <Route path="/summary" element={<OverallSummary />} />
          <Route path="/live" element={<LivePositions />} />
          <Route path="/radar" element={<SignalRadar />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [isUnlocked, setIsUnlocked] = useState(() => {
    try {
      return localStorage.getItem(LOCK_SESSION_KEY) === '1'
    } catch (_) {
      return false
    }
  })
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem(DARK_MODE_KEY) === '1'
    } catch (_) {
      return false
    }
  })
  const [shellVisible, setShellVisible] = useState(true)

  useEffect(() => {
    if (darkMode) {
      document.documentElement.setAttribute('data-dark', '')
    } else {
      document.documentElement.removeAttribute('data-dark')
    }
    try {
      localStorage.setItem(DARK_MODE_KEY, darkMode ? '1' : '0')
    } catch (_) {}
  }, [darkMode])

  const toggleDarkMode = () => {
    setShellVisible(false)
    setTimeout(() => {
      setDarkMode(d => !d)
      setShellVisible(true)
    }, 160)
  }

  const handleUnlock = () => {
    try {
      localStorage.setItem(LOCK_SESSION_KEY, '1')
    } catch (_) {}
    setIsUnlocked(true)
  }

  const handleLogout = () => {
    try {
      localStorage.removeItem(LOCK_SESSION_KEY)
    } catch (_) {}
    setIsUnlocked(false)
  }

  return (
    <Routes>
      <Route
        path="/lock"
        element={
          isUnlocked
            ? <Navigate to="/dashboard" replace />
            : <WebLock onUnlock={handleUnlock} />
        }
      />
      <Route
        path="*"
        element={
          isUnlocked
            ? (
              <div style={{
                opacity: shellVisible ? 1 : 0,
                transition: 'opacity 0.18s ease',
                willChange: 'opacity',
              }}>
                <ProtectedShell activeTab={activeTab} setActiveTab={setActiveTab} onLogout={handleLogout} darkMode={darkMode} toggleDarkMode={toggleDarkMode} />
              </div>
            )
            : <Navigate to="/lock" replace />
        }
      />
    </Routes>
  )
}

export default App
