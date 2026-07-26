import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth'
import { ErrorBanner } from '../components'

export default function Login() {
  const { needsSetup, login, setup } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

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
      </form>
    </div>
  )
}
