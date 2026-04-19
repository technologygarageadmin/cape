import { useEffect, useMemo, useRef, useState } from 'react'

const PIN_LENGTH = 6
const ENCRYPTED_PIN_SHA256 = 'dce4a7b74a841e253825984e8a4a0a91b8cf8667077e076b10fcf4b3b1da32cf'
const MAX_ATTEMPTS = 3

function toHex(bytes) {
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text) {
	if (!window?.crypto?.subtle) throw new Error('Crypto API unavailable')
	const encoded = new TextEncoder().encode(text)
	const digest = await window.crypto.subtle.digest('SHA-256', encoded)
	return toHex(new Uint8Array(digest))
}

const css = `
	@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap');

	.wl-root {
		min-height: 100vh;
		display: grid;
		place-items: center;
		background: #0c0c0d;
		background-image:
			radial-gradient(ellipse 60% 40% at 50% 0%, rgba(201,162,39,0.08) 0%, transparent 70%),
			repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(255,255,255,0.025) 40px),
			repeating-linear-gradient(90deg, transparent, transparent 39px, rgba(255,255,255,0.025) 40px);
		padding: 1.5rem;
		font-family: 'Poppins', sans-serif;
	}

	.wl-card {
		width: min(100%, 440px);
		background: #111114;
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 20px;
		overflow: hidden;
		position: relative;
	}

	.wl-card::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 20px;
		padding: 1px;
		background: linear-gradient(135deg, rgba(201,162,39,0.4) 0%, transparent 50%, rgba(201,162,39,0.1) 100%);
		-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
		-webkit-mask-composite: xor;
		mask-composite: exclude;
		pointer-events: none;
	}

	.wl-glow {
		position: absolute;
		top: -80px;
		left: 50%;
		transform: translateX(-50%);
		width: 280px;
		height: 200px;
		background: radial-gradient(ellipse, rgba(201,162,39,0.12) 0%, transparent 70%);
		pointer-events: none;
	}

	.wl-header {
		padding: 1.25rem 1.5rem 1rem;
		border-bottom: 1px solid rgba(255,255,255,0.06);
		display: flex;
		align-items: center;
		gap: 12px;
		position: relative;
	}

	.wl-shield {
		width: 38px;
		height: 38px;
		border-radius: 10px;
		background: rgba(201,162,39,0.1);
		border: 1px solid rgba(201,162,39,0.25);
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}

	.wl-eyebrow {
		font-size: 10px;
		font-family: 'Poppins', sans-serif;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #C9A227;
		margin: 0 0 3px;
		opacity: 0.9;
	}

	.wl-platform {
		font-size: 15px;
		font-weight: 700;
		color: rgba(255,255,255,0.9);
		margin: 0;
		letter-spacing: -0.01em;
	}

	.wl-body {
		padding: 1.75rem 1.5rem 1.5rem;
	}

	.wl-prompt {
		font-size: 22px;
		font-weight: 800;
		color: #fff;
		letter-spacing: -0.03em;
		margin: 0 0 6px;
		line-height: 1.15;
	}

	.wl-sub {
		font-size: 13px;
		color: rgba(255,255,255,0.38);
		margin: 0 0 1.75rem;
		font-weight: 400;
		line-height: 1.5;
	}

	.wl-inputs {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 8px;
		margin-bottom: 1.25rem;
	}

	.wl-input {
		height: 56px;
		border-radius: 10px;
		border: 1px solid rgba(255,255,255,0.1);
		background: rgba(255,255,255,0.04);
		color: #fff;
		font-size: 20px;
		font-weight: 700;
		font-family: 'Poppins', sans-serif;
		text-align: center;
		outline: none;
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
		-webkit-text-security: disc;
		caret-color: #C9A227;
	}

	.wl-input:focus {
		border-color: rgba(201,162,39,0.6);
		background: rgba(201,162,39,0.06);
		box-shadow: 0 0 0 3px rgba(201,162,39,0.1), inset 0 0 0 1px rgba(201,162,39,0.2);
	}

	.wl-input.filled {
		border-color: rgba(201,162,39,0.3);
		background: rgba(201,162,39,0.05);
	}

	.wl-input.error {
		border-color: rgba(239,68,68,0.5);
		background: rgba(239,68,68,0.06);
		animation: shake 0.35s ease;
	}

	.wl-input:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@keyframes shake {
		0%,100% { transform: translateX(0); }
		20% { transform: translateX(-4px); }
		40% { transform: translateX(4px); }
		60% { transform: translateX(-3px); }
		80% { transform: translateX(3px); }
	}

	.wl-progress {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 1.25rem;
	}

	.wl-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: rgba(255,255,255,0.12);
		transition: background 0.2s, transform 0.2s;
	}

	.wl-dot.active {
		background: #C9A227;
		transform: scale(1.3);
	}

	.wl-dot.error {
		background: #ef4444;
	}

	.wl-dot-label {
		font-size: 11px;
		font-family: 'Poppins', sans-serif;
		color: rgba(255,255,255,0.25);
		margin-left: 4px;
	}

	.wl-error {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 600;
		color: #f87171;
		background: rgba(239,68,68,0.08);
		border: 1px solid rgba(239,68,68,0.2);
		border-radius: 8px;
		padding: 8px 11px;
		margin-bottom: 1rem;
		font-family: 'DM Mono', monospace;
		letter-spacing: 0.01em;
	}

	.wl-error-hidden {
		visibility: hidden;
		margin-bottom: 1rem;
		height: 34px;
	}

	.wl-btn {
		width: 100%;
		height: 48px;
		border-radius: 10px;
		border: none;
		font-family: 'Poppins', sans-serif;
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition: all 0.18s ease;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		position: relative;
		overflow: hidden;
	}

	.wl-btn-ready {
		background: linear-gradient(135deg, #C9A227 0%, #E8BC35 50%, #C9A227 100%);
		background-size: 200% 100%;
		background-position: 0% 0%;
		color: #1a1200;
	}

	.wl-btn-ready:hover {
		background-position: 100% 0%;
		transform: translateY(-1px);
		box-shadow: 0 8px 24px rgba(201,162,39,0.3);
	}

	.wl-btn-ready:active {
		transform: translateY(0px) scale(0.99);
	}

	.wl-btn-disabled {
		background: rgba(255,255,255,0.06);
		color: rgba(255,255,255,0.22);
		cursor: not-allowed;
		border: 1px solid rgba(255,255,255,0.06);
	}

	.wl-btn-locked {
		background: rgba(239,68,68,0.1);
		color: #f87171;
		cursor: not-allowed;
		border: 1px solid rgba(239,68,68,0.2);
	}

	.wl-btn-success {
		background: rgba(34,197,94,0.12);
		color: #4ade80;
		border: 1px solid rgba(34,197,94,0.25);
		cursor: default;
	}

	.wl-footer {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid rgba(255,255,255,0.06);
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.wl-footer-text {
		font-size: 11px;
		font-family: 'Poppins', sans-serif;
		color: rgba(255,255,255,0.22);
		line-height: 1.5;
	}

	.wl-attempts {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-left: auto;
		flex-shrink: 0;
	}

	.wl-attempt-pip {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255,255,255,0.15);
		transition: background 0.2s;
	}

	.wl-attempt-pip.used {
		background: rgba(239,68,68,0.6);
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.wl-spinner {
		animation: spin 0.7s linear infinite;
	}

	@keyframes pulse-dot {
		0%,100% { opacity: 1; }
		50% { opacity: 0.3; }
	}
`

function LockIcon({ size = 16, color = 'currentColor' }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="7.5" width="10" height="7" rx="2" />
			<path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />
		</svg>
	)
}

function ShieldIcon({ size = 16, color = 'currentColor' }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
			<path d="M8 1.5L2.5 4v4.5c0 3 2.5 5.5 5.5 5.5s5.5-2.5 5.5-5.5V4L8 1.5z" />
			<path d="M5.5 8l1.5 1.5 3-3" />
		</svg>
	)
}

function KeyIcon({ size = 12, color = 'currentColor' }) {
	return (
		<svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="4.5" cy="4.5" r="2.5" />
			<path d="M7 7l3.5 3.5M8.5 8.5l1 1" />
		</svg>
	)
}

function SpinnerIcon() {
	return (
		<svg className="wl-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
			<path d="M8 2a6 6 0 1 0 6 6" strokeOpacity="0.35" />
			<path d="M8 2a6 6 0 0 1 6 6" />
		</svg>
	)
}

function ArrowIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M2 7h10M8 3l4 4-4 4" />
		</svg>
	)
}

function CheckIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M2.5 7.5l4 4 6-7" />
		</svg>
	)
}

export default function WebLock({ onUnlock }) {
	const [digits, setDigits] = useState(Array(PIN_LENGTH).fill(''))
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')
	const [attempts, setAttempts] = useState(0)
	const [locked, setLocked] = useState(false)
	const [success, setSuccess] = useState(false)
	const inputRefs = useRef([])

	const pin = useMemo(() => digits.join(''), [digits])
	const isReady = pin.length === PIN_LENGTH && !locked && !success

	useEffect(() => {
		inputRefs.current[0]?.focus()
	}, [])

	const clearError = () => setError('')

	const updateDigit = (idx, value) => {
		if (locked || success) return
		if (!/^\d?$/.test(value)) return
		const next = [...digits]
		next[idx] = value
		setDigits(next)
		clearError()
		if (value && idx < PIN_LENGTH - 1) inputRefs.current[idx + 1]?.focus()
	}

	const handleKeyDown = (idx, e) => {
		if (locked || success) return
		if (e.key === 'Backspace' && !digits[idx] && idx > 0) inputRefs.current[idx - 1]?.focus()
		if (e.key === 'ArrowLeft' && idx > 0) inputRefs.current[idx - 1]?.focus()
		if (e.key === 'ArrowRight' && idx < PIN_LENGTH - 1) inputRefs.current[idx + 1]?.focus()
		if (e.key === 'Enter' && isReady) handleSubmit()
	}

	const handlePaste = (e) => {
		if (locked || success) return
		const txt = String(e.clipboardData.getData('text') || '')
		const onlyDigits = txt.replace(/\D/g, '').slice(0, PIN_LENGTH)
		if (!onlyDigits) return
		e.preventDefault()
		const next = Array(PIN_LENGTH).fill('')
		for (let i = 0; i < onlyDigits.length; i++) next[i] = onlyDigits[i]
		setDigits(next)
		clearError()
		inputRefs.current[Math.min(onlyDigits.length, PIN_LENGTH - 1)]?.focus()
	}

	const handleSubmit = async () => {
		if (!isReady || submitting) return
		if (pin.length !== PIN_LENGTH) { setError('Enter all 6 digits'); return }

		setSubmitting(true)
		clearError()
		try {
			const hashed = await sha256Hex(pin)
			if (hashed === ENCRYPTED_PIN_SHA256) {
				setSuccess(true)
				setTimeout(() => onUnlock?.(), 800)
				return
			}
			const newAttempts = attempts + 1
			setAttempts(newAttempts)
			if (newAttempts >= MAX_ATTEMPTS) {
				setLocked(true)
				setError('Session locked — too many failed attempts.')
			} else {
				const remaining = MAX_ATTEMPTS - newAttempts
				setError(`Incorrect PIN — ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining`)
				setDigits(Array(PIN_LENGTH).fill(''))
				inputRefs.current[0]?.focus()
			}
		} catch {
			setError('Security check failed in this browser')
		} finally {
			setSubmitting(false)
		}
	}

	const btnClass = success
		? 'wl-btn wl-btn-success'
		: locked
			? 'wl-btn wl-btn-locked'
			: isReady
				? 'wl-btn wl-btn-ready'
				: 'wl-btn wl-btn-disabled'

	return (
		<>
			<style>{css}</style>
			<div className="wl-root">
				<div className="wl-card">
					<div className="wl-glow" />

					{/* Header */}
					<div className="wl-header">
						<div className="wl-shield">
							<ShieldIcon size={18} color="#C9A227" />
						</div>
						<div>
							<p className="wl-eyebrow">Secure Access</p>
							<p className="wl-platform">Cape Trading Platform</p>
						</div>
					</div>

					{/* Body */}
					<div className="wl-body">
						<h1 className="wl-prompt">Enter your PIN</h1>
						<p className="wl-sub">
							{locked
								? 'This session has been locked due to too many failed attempts.'
								: 'Protected routes remain locked until PIN verification succeeds.'}
						</p>

						{/* Digit inputs */}
						<div className="wl-inputs">
							{digits.map((d, idx) => (
								<input
									key={idx}
									ref={(el) => { inputRefs.current[idx] = el }}
									type="text"
									inputMode="numeric"
									autoComplete={idx === 0 ? 'one-time-code' : 'off'}
									maxLength={1}
									value={d}
									onChange={(e) => updateDigit(idx, e.target.value)}
									onKeyDown={(e) => handleKeyDown(idx, e)}
									onPaste={handlePaste}
									disabled={submitting || locked || success}
									className={[
										'wl-input',
										error ? 'error' : '',
										d && !error ? 'filled' : '',
									].join(' ')}
									aria-label={`PIN digit ${idx + 1}`}
								/>
							))}
						</div>

						{/* Progress dots */}
						<div className="wl-progress" role="status" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
							{Array.from({ length: PIN_LENGTH }).map((_, i) => (
								<div
									key={i}
									className={['wl-dot', i < pin.length ? 'active' : '', error ? 'error' : ''].join(' ')}
								/>
							))}
							<span className="wl-dot-label">{pin.length}/{PIN_LENGTH}</span>
						</div>

						{/* Error */}
						{error ? (
							<div className="wl-error" role="alert">
								<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round">
									<circle cx="6.5" cy="6.5" r="5.5" />
									<path d="M6.5 4v3M6.5 8.5h.01" />
								</svg>
								{error}
							</div>
						) : (
							<div className="wl-error-hidden" aria-hidden="true" />
						)}

						{/* Submit button */}
						<button
							onClick={handleSubmit}
							disabled={!isReady || submitting}
							className={btnClass}
							aria-label={success ? 'Unlocked' : locked ? 'Session locked' : 'Unlock'}
						>
							{submitting && <SpinnerIcon />}
							{success && <CheckIcon />}
							{!submitting && !success && locked && <LockIcon size={14} />}
							{!submitting && !success && !locked && isReady && <ArrowIcon />}
							{submitting
								? 'Verifying…'
								: success
									? 'Unlocked'
									: locked
										? 'Session locked'
										: 'Unlock'}
						</button>

						{/* Footer */}
						<div className="wl-footer">
							<KeyIcon size={12} color="rgba(255,255,255,0.2)" />
							<span className="wl-footer-text">
								PIN verified via SHA-256 hash — never transmitted
							</span>
							{/* Attempt pips */}
							<div className="wl-attempts" aria-label={`${attempts} of ${MAX_ATTEMPTS} attempts used`}>
								{Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
									<div key={i} className={`wl-attempt-pip${i < attempts ? ' used' : ''}`} />
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</>
	)
}