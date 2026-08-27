import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorBanner } from '../components'
import { useAuth } from '../auth'

export default function OAuthConsent() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const clientId = searchParams.get('client_id') ?? ''
  const clientName = searchParams.get('client_name') ?? 'An MCP client'
  const redirectUri = searchParams.get('redirect_uri') ?? ''
  const codeChallenge = searchParams.get('code_challenge') ?? ''
  const state = searchParams.get('state') ?? ''
  const resource = searchParams.get('resource') ?? ''

  const approve = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch('/authorize/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, redirectUri, codeChallenge, state, resource }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'approval failed')
      window.location.href = body.redirectTo
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const deny = () => {
    const redirect = new URL(redirectUri)
    redirect.searchParams.set('error', 'access_denied')
    if (state) redirect.searchParams.set('state', state)
    window.location.href = redirect.toString()
  }

  if (!user || user.role !== 'admin') {
    return (
      <div className="login-wrap">
        <div className="panel" style={{ maxWidth: 480 }}>
          <h1>Admin required</h1>
          <p className="muted">
            Only an admin can approve an MCP client's access to Attaché's management server.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="login-wrap">
      <div className="panel" style={{ maxWidth: 480 }}>
        <h1>Connect to Attaché</h1>
        <ErrorBanner message={err} onDismiss={() => setErr('')} />
        <p>
          <b>{clientName}</b> wants to connect to Attaché's MCP management server. Once approved,
          it can create, update, and manage agent and MCP tool containers — the same access an
          admin has in the GUI.
        </p>
        <div className="btn-row" style={{ marginTop: 18 }}>
          <button className="btn btn-primary" disabled={busy} onClick={approve}>
            Approve
          </button>
          <button className="btn" disabled={busy} onClick={deny}>
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}
