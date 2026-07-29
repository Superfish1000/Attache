import { useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, ErrorBanner, fmtDate } from '../components'
import type { O365Member, O365SettingsView, SyncRun } from '../types'

export default function Integrations() {
  const [view, setView] = useState<O365SettingsView | null>(null)
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [groupId, setGroupId] = useState('')
  const [members, setMembers] = useState<O365Member[] | null>(null)
  const [syncResult, setSyncResult] = useState<SyncRun | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.o365
      .settings()
      .then((s) => {
        setView(s)
        setTenantId(s.tenantId)
        setClientId(s.clientId)
        setGroupId(s.groupId)
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  const saveSettings = async () => {
    setBusy(true)
    setErr('')
    setNote('')
    try {
      const s = await api.o365.saveSettings({ tenantId, clientId, clientSecret, groupId })
      setView(s)
      setClientSecret('')
      setNote('Settings saved')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const preview = async () => {
    setBusy(true)
    setErr('')
    setMembers(null)
    try {
      setMembers(await api.o365.preview())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setBusy(true)
    setErr('')
    setSyncResult(null)
    try {
      setSyncResult(await api.o365.sync())
      setView(await api.o365.settings())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Integrations</h1>
      <p className="subtitle">Office 365 group sync — auto-create a user + agent per group member</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />

      <h2>
        Microsoft Graph{' '}
        {view &&
          (view.configured ? <Chip tone="ok">configured</Chip> : <Chip tone="off">not configured</Chip>)}
      </h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Entra app registration with application permissions <span className="mono">GroupMember.Read.All</span>{' '}
          + <span className="mono">User.Read.All</span> (client-credentials flow).
        </p>
        <div className="field">
          <label>Tenant ID</label>
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
        </div>
        <div className="field">
          <label>Client ID</label>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="field">
          <label>Client secret {view?.hasSecret && <span className="ok-note">(saved — leave blank to keep)</span>}</label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={view?.hasSecret ? '••••••••' : ''}
          />
        </div>
        <div className="field">
          <label>Group ID (object ID of the O365 group to watch)</label>
          <input value={groupId} onChange={(e) => setGroupId(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={saveSettings}>
            Save settings
          </button>
          <button className="btn" disabled={busy || !view?.configured} onClick={preview}>
            Preview members
          </button>
          <button className="btn" disabled={busy || !view?.configured} onClick={sync}>
            Sync now
          </button>
        </div>
        {note && <p className="ok-note">{note}</p>}
        <p className="muted">Last sync: {fmtDate(view?.lastSync)}</p>
        {syncResult && (
          <p>
            Sync: {syncResult.created} created, {syncResult.disabled} disabled,{' '}
            {syncResult.reenabled} re-enabled.
          </p>
        )}
      </div>

      {members && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Group members ({members.length})</h2>
          {members.length === 0 ? (
            <div className="empty">Group has no user members.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="muted">{m.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}
