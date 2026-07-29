import { useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, ErrorBanner, fmtDate } from '../components'
import type { O365Member, O365SettingsView, SettingsView, SyncRun } from '../types'

export default function Integrations() {
  const [view, setView] = useState<O365SettingsView | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [groupId, setGroupId] = useState('')
  const [pollMinutes, setPollMinutes] = useState('0')
  const [members, setMembers] = useState<O365Member[] | null>(null)
  const [testResult, setTestResult] = useState<{ groupName: string; memberCount: number } | null>(null)
  const [syncResult, setSyncResult] = useState<SyncRun | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([api.o365.settings(), api.settings.get()])
      .then(([o, s]) => {
        setView(o)
        setSettings(s)
        setTenantId(o.tenantId)
        setClientId(o.clientId)
        setGroupId(o.groupId)
        setPollMinutes(String(o.pollMinutes))
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  const saveSettings = async () => {
    setBusy(true)
    setErr('')
    setNote('')
    try {
      const s = await api.o365.saveSettings({
        tenantId,
        clientId,
        clientSecret,
        groupId,
        pollMinutes: Number(pollMinutes) || 0,
      })
      setView(s)
      setClientSecret('')
      setNote('Saved')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setErr('')
    setTestResult(null)
    try {
      setTestResult(await api.o365.test())
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

  const emailReady = Boolean(settings?.email.host && settings?.email.from)

  return (
    <>
      <h1>Integrations</h1>
      <p className="subtitle">Office 365 group sync — auto-create a user + agent per group member</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />

      <h2>
        1 · App registration{' '}
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
          <label>
            Client secret {view?.hasSecret && <span className="ok-note">(saved — leave blank to keep)</span>}
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={view?.hasSecret ? '••••••••' : ''}
          />
        </div>
        {tenantId && clientId && (
          <p className="muted" style={{ marginBottom: 0 }}>
            After granting the permissions,{' '}
            <a
              href={`https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${clientId}`}
              target="_blank"
              rel="noreferrer"
            >
              grant admin consent
            </a>{' '}
            (opens Microsoft; sign in as a tenant admin).
          </p>
        )}
      </div>

      <h2>2 · Group</h2>
      <div className="panel">
        <div className="field">
          <label>Group ID (object ID of the O365 group to watch)</label>
          <input value={groupId} onChange={(e) => setGroupId(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn" disabled={busy || !view?.configured} onClick={test}>
            Test connection
          </button>
          <button className="btn" disabled={busy || !view?.configured} onClick={preview}>
            Preview members
          </button>
        </div>
        {testResult && (
          <p className="ok-note" style={{ marginBottom: 0 }}>
            Connected: "{testResult.groupName}" — {testResult.memberCount} member(s).
          </p>
        )}
        {members && (
          <>
            <h2>Group members ({members.length})</h2>
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
          </>
        )}
      </div>

      <h2>3 · Polling</h2>
      <div className="panel">
        <div className="form-row">
          <div className="field">
            <label>Poll interval, minutes (0 = off)</label>
            <input value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value)} />
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={saveSettings}>
            Save settings
          </button>
          <button className="btn" disabled={busy || !view?.configured} onClick={sync}>
            Sync now
          </button>
        </div>
        {note && <p className="ok-note">{note}</p>}
        <p className="muted">
          New members get a user + agent (and a set-password email). Members who leave are disabled —
          never deleted, never admins. Last sync: {fmtDate(view?.lastSync)}
        </p>
        {syncResult && (
          <p>
            Sync: {syncResult.total} member(s), {syncResult.created} created, {syncResult.disabled}{' '}
            disabled, {syncResult.reenabled} re-enabled
            {syncResult.skippedAdmins > 0 && <>, {syncResult.skippedAdmins} admin(s) skipped</>}
            {syncResult.emailFailures > 0 && <>, {syncResult.emailFailures} email failure(s)</>}.
            {syncResult.error && <> Error: {syncResult.error}</>}
          </p>
        )}
        {view && view.lastRuns.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Members</th>
                <th>Created</th>
                <th>Disabled</th>
                <th>Re-enabled</th>
                <th>Email failures</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {view.lastRuns.map((r) => (
                <tr key={r.at}>
                  <td className="muted">{fmtDate(r.at)}</td>
                  <td>{r.total}</td>
                  <td>{r.created}</td>
                  <td>{r.disabled}</td>
                  <td>{r.reenabled}</td>
                  <td>{r.emailFailures}</td>
                  <td className="muted">{r.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>4 · Email readiness</h2>
      <div className="panel">
        {emailReady ? (
          <p className="ok-note" style={{ margin: 0 }}>
            SMTP is configured — new users receive set-password links automatically.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            <Chip tone="warn">not configured</Chip> New users will be created without a password and
            can't sign in until you email them a link or set one manually. Configure SMTP under
            Settings → Email.
          </p>
        )}
      </div>
    </>
  )
}
