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

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#fff' }}>
      <Header activeTab={activeTab} onTabChange={setActiveTab} />
      <main style={{ flex: 1, padding: '2rem', boxSizing: 'border-box' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/trading" element={<TradingView />} />
          <Route path="/atr" element={<ATRView />} />
          <Route path="/summary" element={<OverallSummary />} />
          <Route path="/live" element={<LivePositions />} />
          <Route path="/radar" element={<SignalRadar />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

export default App
