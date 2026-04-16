import { useState } from 'react'
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

function ProtectedShell({ activeTab, setActiveTab, onLogout }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#fff' }}>
      <Header activeTab={activeTab} onTabChange={setActiveTab} onLogout={onLogout} />
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
      return sessionStorage.getItem(LOCK_SESSION_KEY) === '1'
    } catch (_) {
      return false
    }
  })

  const handleUnlock = () => {
    try {
      sessionStorage.setItem(LOCK_SESSION_KEY, '1')
    } catch (_) {}
    setIsUnlocked(true)
  }

  const handleLogout = () => {
    try {
      sessionStorage.removeItem(LOCK_SESSION_KEY)
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
            ? <ProtectedShell activeTab={activeTab} setActiveTab={setActiveTab} onLogout={handleLogout} />
            : <Navigate to="/lock" replace />
        }
      />
    </Routes>
  )
}

export default App
