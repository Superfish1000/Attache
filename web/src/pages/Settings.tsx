import { useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, EnvVarsHelp, ErrorBanner, InfoPopup, fmtDate } from '../components'
import type { SettingsView, UpdateCheck, UpdateResult } from '../types'

export default function Settings() {
  const [dataDir, setDataDir] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [socketPath, setSocketPath] = useState('')
  const [autoPull, setAutoPull] = useState(true)
  const [portRangeStart, setPortRangeStart] = useState('')
  const [defaultEnvText, setDefaultEnvText] = useState('{}')
  const [restartPolicy, setRestartPolicy] = useState<SettingsView['docker']['restartPolicy']>('unless-stopped')
  const [securityOpt, setSecurityOpt] = useState('')
  const [sessionTtl, setSessionTtl] = useState('')
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

  const applyUpdate = async () => {
    if (!confirm('Pull the latest version from GitHub and install dependencies?')) return
    setUpdBusy(true)
    setUpdErr('')
    setUpdResult(null)
    try {
      const res = await api.update.apply()
      setUpdResult(res)
      await checkUpdates()
    } catch (e) {
      setUpdErr((e as Error).message)
    } finally {
      setUpdBusy(false)
    }
  }

  useEffect(() => {
    void checkUpdates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (s: SettingsView) => {
    setDataDir(s.dataDir)
    setHost(s.server.host)
    setPort(String(s.server.port))
    setSocketPath(s.docker.socketPath)
    setAutoPull(s.docker.autoPull)
    setPortRangeStart(String(s.docker.portRangeStart))
    setDefaultEnvText(JSON.stringify(s.docker.defaultEnv, null, 2))
    setRestartPolicy(s.docker.restartPolicy)
    setSecurityOpt(s.docker.securityOpt.join(', '))
    setSessionTtl(String(s.security.sessionTtlHours))
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
        server: { host: host.trim(), port: Number(port) },
        docker: {
          socketPath: socketPath.trim(),
          autoPull,
          portRangeStart: Number(portRangeStart),
          defaultEnv,
          restartPolicy,
          securityOpt: securityOpt.split(/[,\s]+/).filter(Boolean),
        },
        security: { sessionTtlHours: Number(sessionTtl) },
      })
      apply(saved)
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
        </div>
        {updResult && (
          <p className={updResult.updated ? 'ok-note' : 'muted'} style={{ marginBottom: 0 }}>
            {updResult.updated
              ? `Updated ${updResult.from} → ${updResult.to}. ${updResult.installNote}. ${updResult.note}`
              : 'Already up to date.'}
          </p>
        )}
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
        <p className="muted" style={{ marginBottom: 0 }}>
          Data directory: <span className="mono">{dataDir}</span> (override with{' '}
          <span className="mono">ATTACHE_DATA_DIR</span>)
        </p>
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
