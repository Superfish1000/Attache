import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import { ErrorBanner } from '../components'

/** Set-password page — reached from emailed links, renders without a session. */
export default function Reset() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      setErr('passwords do not match')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await api.auth.reset(token, password)
      setDone(true)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          ATTACHÉ<span className="brand-dot">●</span>
        </div>
        {done ? (
          <>
            <p>Password set. Sign in with it now.</p>
            <a className="btn btn-primary" style={{ width: '100%', textAlign: 'center' }} href="/">
              Go to sign in
            </a>
          </>
        ) : !token ? (
          <p>
            This link is missing its token — request a new one from the sign-in screen.{' '}
            <a href="/">Go to sign in</a>
          </p>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Choose a password for your account.
            </p>
            <ErrorBanner message={err} onDismiss={() => setErr('')} />
            <div className="field">
              <label>
                New password <span className="muted">(min 8 chars)</span>
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || password.length < 8 || !confirm}>
              Set password
            </button>
          </>
        )}
      </form>
    </div>
  )
}
