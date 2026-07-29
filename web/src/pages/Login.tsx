import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth'
import { api } from '../api'
import { ErrorBanner } from '../components'

export default function Login() {
  const { needsSetup, login, setup } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot' | 'sent'>('login')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      if (needsSetup) await setup(name, email, password)
      else await login(email, password)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const forgot = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api.auth.forgot(email)
      setMode('sent')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (mode !== 'login') {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={forgot}>
          <div className="brand login-brand">
            ATTACHÉ<span className="brand-dot">●</span>
          </div>
          {mode === 'sent' ? (
            <>
              <p>If that account exists, a set-password link is on its way to {email}.</p>
              <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setMode('login')}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Enter your email — if the account exists we'll send a set-password link.
              </p>
              <ErrorBanner message={err} onDismiss={() => setErr('')} />
              <div className="field">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !email}>
                Send reset link
              </button>
              <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setMode('login')}>
                Back to sign in
              </button>
            </>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          ATTACHÉ<span className="brand-dot">●</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {needsSetup
            ? 'First run — create the initial admin account.'
            : 'Sign in to manage your agents.'}
        </p>
        <ErrorBanner message={err} onDismiss={() => setErr('')} />
        {needsSetup && (
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus={!needsSetup}
          />
        </div>
        <div className="field">
          <label>Password {needsSetup && <span className="muted">(min 8 chars)</span>}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={busy || !email || !password || (needsSetup && !name)}
        >
          {needsSetup ? 'Create admin account' : 'Sign in'}
        </button>
        {!needsSetup && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => {
              setErr('')
              setMode('forgot')
            }}
          >
            Forgot password?
          </button>
        )}
      </form>
    </div>
  )
}
