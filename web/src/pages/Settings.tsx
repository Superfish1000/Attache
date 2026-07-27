import { useEffect, useState } from 'react'
import { api } from '../api'
import { EnvVarsHelp, ErrorBanner, InfoPopup } from '../components'
import type { SettingsView } from '../types'

export default function Settings() {
  const [dataDir, setDataDir] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [socketPath, setSocketPath] = useState('')
  const [autoPull, setAutoPull] = useState(true)
  const [portRangeStart, setPortRangeStart] = useState('')
  const [defaultEnvText, setDefaultEnvText] = useState('{}')
  const [restartPolicy, setRestartPolicy] = useState<SettingsView['docker']['restartPolicy']>('unless-stopped')
  const [sessionTtl, setSessionTtl] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = (s: SettingsView) => {
    setDataDir(s.dataDir)
    setHost(s.server.host)
    setPort(String(s.server.port))
    setSocketPath(s.docker.socketPath)
    setAutoPull(s.docker.autoPull)
    setPortRangeStart(String(s.docker.portRangeStart))
    setDefaultEnvText(JSON.stringify(s.docker.defaultEnv, null, 2))
    setRestartPolicy(s.docker.restartPolicy)
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
