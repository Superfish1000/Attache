import { useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, EnvVarsHelp, ErrorBanner, InfoPopup, fmtDate } from '../components'
import type { SettingsView, UpdateCheck, UpdateResult } from '../types'

export default function Settings() {
  const [dataDir, setDataDir] = useState('')
  const [network, setNetwork] = useState<SettingsView['network'] | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [emHost, setEmHost] = useState('')
  const [emPort, setEmPort] = useState('587')
  const [emSecure, setEmSecure] = useState(false)
  const [emUser, setEmUser] = useState('')
  const [emPass, setEmPass] = useState('')
  const [emFrom, setEmFrom] = useState('')
  const [emHasPass, setEmHasPass] = useState(false)
  const [socketPath, setSocketPath] = useState('')
  const [autoPull, setAutoPull] = useState(true)
  const [portRangeStart, setPortRangeStart] = useState('')
  const [defaultEnvText, setDefaultEnvText] = useState('{}')
  const [restartPolicy, setRestartPolicy] = useState<SettingsView['docker']['restartPolicy']>('unless-stopped')
  const [securityOpt, setSecurityOpt] = useState('')
  const [sessionTtl, setSessionTtl] = useState('')
  const [selfAutoHours, setSelfAutoHours] = useState('0')
  const [selfAutoApply, setSelfAutoApply] = useState(false)
  const [imgAutoHours, setImgAutoHours] = useState('0')
  const [imgAutoMode, setImgAutoMode] = useState<SettingsView['imageUpdates']['autoMode']>('check')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [upd, setUpd] = useState<UpdateCheck | null>(null)
  const [updErr, setUpdErr] = useState('')
  const [updBusy, setUpdBusy] = useState(false)
  const [updResult, setUpdResult] = useState<UpdateResult | null>(null)

  const checkUpdates = async () => {
    setUpdBusy(true)
    setUpdErr('')
    try {
      setUpd(await api.update.check())
    } catch (e) {
      setUpd(null)
      setUpdErr((e as Error).message)
    } finally {
      setUpdBusy(false)
    }
  }

  /** Polls /api/health until the server is back (up to 60s), or reports that it needs manual intervention. */
  const waitForServerBack = async (): Promise<boolean> => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const res = await fetch('/api/health')
        if (res.ok) return true
      } catch {
        // still down
      }
    }
    return false
  }

  const applyUpdate = async () => {
    if (!confirm('Pull the latest version from GitHub, install dependencies, and rebuild?')) return
    setUpdBusy(true)
    setUpdErr('')
    setUpdResult(null)
    try {
      const res = await api.update.apply()
      setUpdResult(res)
      if (res.restarting) {
        const back = await waitForServerBack()
        setUpdBusy(false)
        if (back) {
          setUpdResult(null)
          await checkUpdates()
        } else {
          setUpdErr(
            'Server did not come back within 60s — it has no supervisor to restart it. Start it manually on the host.',
          )
        }
        return
      }
      await checkUpdates()
    } catch (e) {
      setUpdErr((e as Error).message)
    } finally {
      setUpdBusy(false)
    }
  }

  const restartServer = async () => {
    if (!confirm('Restart the Attaché server? The GUI reconnects automatically once it is back.')) return
    setUpdBusy(true)
    setUpdErr('')
    try {
      await api.update.restart()
    } catch {
      // the process may die before the response flushes — that's fine
    }
    const back = await waitForServerBack()
    setUpdBusy(false)
    if (back) {
      setUpdResult(null)
      await checkUpdates()
    } else {
      setUpdErr(
        'Server did not come back within 60s — it has no supervisor to restart it. Start it manually on the host.',
      )
    }
  }

  useEffect(() => {
    void checkUpdates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (s: SettingsView) => {
    setDataDir(s.dataDir)
    setNetwork(s.network)
    setHost(s.server.host)
    setPort(String(s.server.port))
    setPublicBaseUrl(s.server.publicBaseUrl)
    setEmHost(s.email.host)
    setEmPort(String(s.email.port))
    setEmSecure(s.email.secure)
    setEmUser(s.email.user)
    setEmFrom(s.email.from)
    setEmHasPass(s.email.hasPass)
    setSocketPath(s.docker.socketPath)
    setAutoPull(s.docker.autoPull)
    setPortRangeStart(String(s.docker.portRangeStart))
    setDefaultEnvText(JSON.stringify(s.docker.defaultEnv, null, 2))
    setRestartPolicy(s.docker.restartPolicy)
    setSecurityOpt(s.docker.securityOpt.join(', '))
    setSessionTtl(String(s.security.sessionTtlHours))
    setSelfAutoHours(String(s.selfUpdate.autoCheckHours))
    setSelfAutoApply(s.selfUpdate.autoApply)
    setImgAutoHours(String(s.imageUpdates.autoCheckHours))
    setImgAutoMode(s.imageUpdates.autoMode)
  }

  useEffect(() => {
    api.settings
      .get()
      .then(apply)
      .catch((e: Error) => setErr(e.message))
  }, [])

  const saveAll = async () => {
    setBusy(true)
    setErr('')
    setNote('')
    try {
      let defaultEnv: Record<string, string>
      try {
        const parsed = JSON.parse(defaultEnvText || '{}')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        defaultEnv = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
      } catch {
        throw new Error('Default env must be a JSON object of key/value strings')
      }
      const saved = await api.settings.save({
        server: { host: host.trim(), port: Number(port), publicBaseUrl: publicBaseUrl.trim() },
        email: {
          host: emHost,
          port: Number(emPort) || 587,
          secure: emSecure,
          user: emUser,
          ...(emPass ? { pass: emPass } : {}),
          from: emFrom,
        },
        docker: {
          socketPath: socketPath.trim(),
          autoPull,
          portRangeStart: Number(portRangeStart),
          defaultEnv,
          restartPolicy,
          securityOpt: securityOpt.split(/[,\s]+/).filter(Boolean),
        },
        security: { sessionTtlHours: Number(sessionTtl) },
        selfUpdate: { autoCheckHours: Number(selfAutoHours) || 0, autoApply: selfAutoApply },
        imageUpdates: { autoCheckHours: Number(imgAutoHours) || 0, autoMode: imgAutoMode },
      })
      apply(saved)
      setEmPass('')
      setNote('Settings saved. Host/port changes take effect after a server restart.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">Server, Docker and security configuration</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <h2>Updates</h2>
      <div className="panel">
        {updErr && <ErrorBanner message={updErr} onDismiss={() => setUpdErr('')} />}
        {upd ? (
          <>
            <p style={{ marginTop: 0 }}>
              Running <span className="mono">{upd.currentShort}</span> from{' '}
              <span className="mono">{upd.repo}</span>{' '}
              {upd.status === 'up-to-date' && <Chip tone="ok">up to date</Chip>}
              {upd.status === 'behind' && (
                <Chip tone="warn">{upd.behindBy} update(s) available</Chip>
              )}
              {upd.status === 'ahead' && <Chip tone="off">ahead of GitHub</Chip>}
              {upd.status === 'diverged' && <Chip tone="err">diverged from GitHub</Chip>}
              {upd.status === 'unknown' && <Chip tone="off">local build</Chip>}
            </p>
            {upd.latest && upd.status !== 'up-to-date' && (
              <p className="muted">
                Latest: <span className="mono">{upd.latest.short}</span> — {upd.latest.message} (
                {fmtDate(upd.latest.date)})
              </p>
            )}
            {upd.restartNeeded && (
              <p>
                <Chip tone="err">restart needed</Chip> The server process is still running{' '}
                <span className="mono">{upd.runningShort}</span> but the checkout is at{' '}
                <span className="mono">{upd.currentShort}</span> — restart Attaché to actually run
                the updated code. Until then, new features 404 and old bugs persist.
              </p>
            )}
          </>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            {updBusy ? 'Checking GitHub…' : 'Update status unavailable.'}
          </p>
        )}
        <div className="btn-row">
          <button className="btn" disabled={updBusy} onClick={checkUpdates}>
            Check for updates
          </button>
          {upd?.status === 'behind' && (
            <button className="btn btn-primary" disabled={updBusy} onClick={applyUpdate}>
              {updBusy ? 'Updating…' : 'Update now'}
            </button>
          )}
          <button
            className="btn"
            disabled={updBusy}
            title="Exit the server so its supervisor — or the dev watcher — brings the updated code up"
            onClick={restartServer}
          >
            Restart server
          </button>
        </div>
        {updResult && (
          <p className={updResult.updated ? 'ok-note' : 'muted'} style={{ marginBottom: 0 }}>
            {updResult.updated
              ? `Updated ${updResult.from} → ${updResult.to}. ${updResult.installNote}. ${updResult.buildNote}. ${updResult.note}`
              : 'Already up to date.'}
          </p>
        )}
      </div>

      <h2>Auto-update</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Attaché itself. Off by default. Checking alone is safe — it only flags an available
          update. Auto-apply also pulls, installs, rebuilds the web frontend, and restarts
          automatically, but only when install and build both succeed (a broken update never
          auto-restarts into a crash loop — fix it and use Restart server once resolved).
        </p>
        <div className="form-row">
          <div className="field">
            <label>Check every N hours (0 = disabled)</label>
            <input value={selfAutoHours} onChange={(e) => setSelfAutoHours(e.target.value)} />
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={selfAutoApply} onChange={(e) => setSelfAutoApply(e.target.checked)} />
          <span>Also auto-apply (not just check) when an update is found</span>
        </label>
      </div>

      <h2>Container image auto-update</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Agent and MCP tool container definitions. Off by default. Checks every definition's base
          image against the registry; "check" only updates the light on the Containers page — the
          other modes also act on whatever's found behind, same as the per-definition
          Stage/Update/Update+regenerate buttons.
        </p>
        <div className="form-row">
          <div className="field">
            <label>Check every N hours (0 = disabled)</label>
            <input value={imgAutoHours} onChange={(e) => setImgAutoHours(e.target.value)} />
          </div>
          <div className="field">
            <label>Action on definitions found behind</label>
            <select
              value={imgAutoMode}
              onChange={(e) => setImgAutoMode(e.target.value as SettingsView['imageUpdates']['autoMode'])}
            >
              <option value="check">Check only — just flag it</option>
              <option value="stage">Stage — pull the base image only</option>
              <option value="update">Update — pull + rebuild (containers untouched)</option>
              <option value="update-regen">Update + regenerate all agents/instances</option>
            </select>
          </div>
        </div>
      </div>

      <h2>Server</h2>
      <div className="panel">
        <div className="field">
          <label>API bind host</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
        </div>
        <div className="field">
          <label>API port (restart required)</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="7701" />
        </div>
        <div className="field">
          <label>Public GUI address (used in emailed links)</label>
          <input
            value={publicBaseUrl}
            onChange={(e) => setPublicBaseUrl(e.target.value)}
            placeholder={window.location.origin}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Data directory: <span className="mono">{dataDir}</span> (override with{' '}
          <span className="mono">ATTACHE_DATA_DIR</span>)
        </p>
      </div>

      <h2>Email (SMTP)</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Used for set-password links: new-user onboarding, "Forgot password?", and the Users page's
          Email link button. Leave host empty to disable.
        </p>
        <div className="form-row">
          <div className="field">
            <label>Host</label>
            <input value={emHost} onChange={(e) => setEmHost(e.target.value)} placeholder="smtp.office365.com" />
          </div>
          <div className="field">
            <label>Port</label>
            <input value={emPort} onChange={(e) => setEmPort(e.target.value)} />
          </div>
          <div className="field">
            <label>TLS mode</label>
            <select value={emSecure ? '1' : '0'} onChange={(e) => setEmSecure(e.target.value === '1')}>
              <option value="0">STARTTLS / none (port 587/25)</option>
              <option value="1">implicit TLS (port 465)</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>Username (blank = no auth)</label>
            <input value={emUser} onChange={(e) => setEmUser(e.target.value)} />
          </div>
          <div className="field">
            <label>Password {emHasPass && <span className="ok-note">(saved — leave blank to keep)</span>}</label>
            <input
              type="password"
              value={emPass}
              onChange={(e) => setEmPass(e.target.value)}
              placeholder={emHasPass ? '••••••••' : ''}
            />
          </div>
          <div className="field">
            <label>From address</label>
            <input value={emFrom} onChange={(e) => setEmFrom(e.target.value)} placeholder="attache@example.com" />
          </div>
        </div>
        <div className="btn-row">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setErr('')
              try {
                const r = await api.settings.emailTest()
                alert(`Test email sent to ${r.to}`)
              } catch (e) {
                setErr((e as Error).message)
              }
            }}
          >
            Send test email
          </button>
          <span className="muted" style={{ alignSelf: 'center' }}>
            Save settings first — the test uses saved values.
          </span>
        </div>
      </div>

      <h2>Docker</h2>
      <div className="panel">
        <div className="field">
          <label>Socket / pipe path (blank = platform default)</label>
          <input
            value={socketPath}
            onChange={(e) => setSocketPath(e.target.value)}
            placeholder="//./pipe/docker_engine"
          />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Image, command, mount path, ports and behavior files are configured per container
          definition on the <b>Containers</b> page.
        </p>
        <div className="form-row">
          <div className="field">
            <label>Host port range start</label>
            <input value={portRangeStart} onChange={(e) => setPortRangeStart(e.target.value)} />
          </div>
          <div className="field">
            <label>Restart policy</label>
            <select
              value={restartPolicy}
              onChange={(e) => setRestartPolicy(e.target.value as SettingsView['docker']['restartPolicy'])}
            >
              <option value="no">no</option>
              <option value="unless-stopped">unless-stopped</option>
              <option value="on-failure">on-failure</option>
              <option value="always">always</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Security options (comma-separated, e.g. seccomp=unconfined for old daemons)</label>
          <input value={securityOpt} onChange={(e) => setSecurityOpt(e.target.value)} />
        </div>
        <div className="field">
          <label>
            Default env for all agents (JSON — put ANTHROPIC_API_KEY / OPENAI_API_KEY here){' '}
            <InfoPopup title="Environment variables">
              <EnvVarsHelp />
            </InfoPopup>
          </label>
          <textarea
            rows={5}
            value={defaultEnvText}
            onChange={(e) => setDefaultEnvText(e.target.value)}
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={autoPull} onChange={(e) => setAutoPull(e.target.checked)} />
          <span>Auto-pull missing images when starting a container</span>
        </label>
        {network && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Shared container network: <span className="mono">{network.name}</span>{' '}
            {network.exists ? <Chip tone="ok">exists</Chip> : <Chip tone="off">not created yet</Chip>} — agent
            and MCP tool containers join this network automatically and reach each other by name
            (see <b>MCP Tools</b>). Connect another container to it manually with{' '}
            <span className="mono">docker network connect {network.name} &lt;container&gt;</span> for
            inter-container linking.
          </p>
        )}
      </div>

      <h2>Security</h2>
      <div className="panel">
        <div className="field">
          <label>Session lifetime (hours)</label>
          <input value={sessionTtl} onChange={(e) => setSessionTtl(e.target.value)} />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Applies to new sessions. Passwords are stored as scrypt hashes in the data directory.
        </p>
      </div>

      <div className="btn-row" style={{ marginBottom: 24 }}>
        <button className="btn btn-primary" disabled={busy} onClick={saveAll}>
          Save settings
        </button>
      </div>
    </>
  )
}
