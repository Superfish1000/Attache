import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { Chip, EnvVarsHelp, ErrorBanner, InfoPopup, fmtDate } from '../components'
import { useAuth } from '../auth'
import type { Agent, AgentDocInfo, ContainerDef, ContainerState, McpInfo, User } from '../types'

export default function AgentDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user: me } = useAuth()
  const admin = me?.role === 'admin'
  const [agent, setAgent] = useState<Agent | null>(null)
  const [owner, setOwner] = useState<User | null>(null)
  const [container, setContainer] = useState<ContainerState | null>(null)
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('')
  const [envText, setEnvText] = useState('{}')
  const [mountPath, setMountPath] = useState('')
  const [portsText, setPortsText] = useState('{}')
  const [memoryMb, setMemoryMb] = useState('')
  const [cpus, setCpus] = useState('')
  const [docs, setDocs] = useState<AgentDocInfo[]>([])
  const [docText, setDocText] = useState<Record<string, string>>({})
  const [docLoaded, setDocLoaded] = useState<Record<string, boolean>>({})
  const [defs, setDefs] = useState<ContainerDef[]>([])
  const [cronJobs, setCronJobs] = useState<string[]>([])
  const [cronSel, setCronSel] = useState('')
  const [cronText, setCronText] = useState('')
  const [logs, setLogs] = useState<string | null>(null)
  const [resetFiles, setResetFiles] = useState(false)
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    Promise.all([
      api.agents.get(id),
      api.users.list(),
      api.agents.docs(id),
      api.agents.container(id),
      api.agents.cronJobs(id),
      api.agents.mcpInfo(id),
    ])
      .then(([a, users, docsRes, c, cj, mi]) => {
        setMcpInfo(mi)
        setAgent(a)
        setOwner(users.find((u) => u.id === a.userId) ?? null)
        setName(a.name)
        setImage(a.config.image)
        setCommand(a.config.command.join(' '))
        setEnvText(JSON.stringify(a.config.env, null, 2))
        setMountPath(a.config.mountPath)
        setPortsText(JSON.stringify(a.config.ports))
        setMemoryMb(a.config.memoryMb ? String(a.config.memoryMb) : '')
        setCpus(a.config.cpus ? String(a.config.cpus) : '')
        setDocs(docsRes.docs)
        setDocLoaded({})
        setDocText({})
        if (docsRes.docs[0]) {
          const first = docsRes.docs[0].key
          api.agents
            .doc(id, first)
            .then((res) => {
              setDocText((t) => ({ ...t, [first]: res.content }))
              setDocLoaded((l) => ({ ...l, [first]: true }))
            })
            .catch(() => undefined)
        }
        setCronJobs(cj.jobs)
        setContainer(c)
      })
      .catch((e: Error) => setErr(e.message))
  }, [id])

  useEffect(load, [load])

  const flash = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(''), 2500)
  }

  const saveConfig = async () => {
    setBusy(true)
    setErr('')
    try {
      let env: Record<string, string>
      try {
        const parsed = JSON.parse(envText || '{}')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        env = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
      } catch {
        throw new Error('Env must be a JSON object of key/value strings')
      }
      let ports: Record<string, number>
      try {
        const parsed = JSON.parse(portsText || '{}')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        ports = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, Number(v)]))
      } catch {
        throw new Error('Ports must be a JSON object: {"containerPort": hostPort}')
      }
      const updated = await api.agents.update(id, {
        name,
        config: {
          image,
          command: command.split(/\s+/).filter(Boolean),
          env,
          mountPath,
          ports,
          memoryMb: memoryMb ? Number(memoryMb) : 0,
          cpus: cpus ? Number(cpus) : 0,
        },
      })
      setAgent(updated)
      flash('Config saved')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const loadDocContent = async (key: string) => {
    if (docLoaded[key]) return
    try {
      const res = await api.agents.doc(id, key)
      setDocText((t) => ({ ...t, [key]: res.content }))
      setDocLoaded((l) => ({ ...l, [key]: true }))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const saveDocContent = async (key: string, label: string) => {
    setBusy(true)
    setErr('')
    try {
      await api.agents.saveDoc(id, key, docText[key] ?? '')
      flash(`${label} saved`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (admin) {
      api.containerDefs
        .list()
        .then((res) => setDefs(res.defs))
        .catch(() => undefined)
    }
  }, [admin])

  const switchDef = async (containerId: string) => {
    setErr('')
    try {
      await api.agents.update(id, { containerId })
      flash('Container definition switched')
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const act = async (action: 'start' | 'stop' | 'remove') => {
    setBusy(true)
    setErr('')
    try {
      setContainer(await api.agents.containerAction(id, action))
      flash(`Container ${action} ok`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    if (
      resetFiles &&
      !confirm('Reset behavior files from templates? Current soul/memory content in templated files will be overwritten.')
    ) {
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await api.agents.regenerate(id, resetFiles)
      setContainer(res)
      flash(
        res.filesReset.length
          ? `Container regenerated · ${res.filesReset.length} file(s) reset from templates`
          : 'Container regenerated',
      )
      setResetFiles(false)
      load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const mcpSignIn = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await api.agents.mcpLogin(id)
      setLogs(res.output)
      flash('Sign-in started — follow the instructions below, then it completes on its own')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const provisionMcp = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await api.agents.provisionMcp(id)
      if (res.results.length === 0) {
        flash('No MCP servers configured on this definition')
      } else {
        const failed = res.results.filter((r) => !r.ok)
        flash(
          failed.length === 0
            ? `MCP provisioned: ${res.results.map((r) => r.name).join(', ')}`
            : `MCP: ${res.results.length - failed.length} ok, ${failed.length} failed`,
        )
        setLogs(
          res.results
            .map((r) => `── ${r.name}: ${r.ok ? 'OK' : 'FAILED'} ──\n${r.output}`)
            .join('\n\n'),
        )
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fetchLogs = async () => {
    setErr('')
    try {
      const res = await api.agents.containerLogs(id)
      setLogs(res.logs || '(no output yet)')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const selectCron = async (file: string) => {
    setCronSel(file)
    setCronText('')
    if (!file) return
    try {
      setCronText((await api.agents.cronJob(id, file)).content)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const newCronJob = () => {
    const name = prompt('New cron job file name (e.g. daily-report.yaml):')
    if (!name) return
    if (!/^[\w][\w.-]*$/.test(name)) {
      setErr('Job file names: letters, digits, dot, dash, underscore only')
      return
    }
    setCronSel(name)
    setCronText('')
  }

  const saveCron = async () => {
    if (!cronSel) return
    setBusy(true)
    setErr('')
    try {
      await api.agents.saveCronJob(id, cronSel, cronText)
      flash(`cron/${cronSel} saved`)
      setCronJobs((await api.agents.cronJobs(id)).jobs)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeAgent = async () => {
    if (!agent) return
    if (!confirm(`Delete agent "${agent.name}" (and its container + soul file)?`)) return
    try {
      await api.agents.remove(id)
      navigate('/agents')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  if (!agent) {
    return (
      <>
        <h1>Agent</h1>
        <ErrorBanner message={err} onDismiss={() => setErr('')} />
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dockerUp = container?.available ?? false

  return (
    <>
      <h1>{agent.name}</h1>
      <p className="subtitle">
        Owned by {owner ? owner.name : '?'} · created {fmtDate(agent.createdAt)} ·{' '}
        <Link to="/agents">back to agents</Link>
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <h2>Container</h2>
      <div className="panel">
        {!dockerUp ? (
          <Chip tone="err">docker offline — start Docker Desktop to manage containers</Chip>
        ) : container?.exists ? (
          <div className="form-row">
            <Chip tone={container.running ? 'ok' : 'warn'}>{container.state}</Chip>
            <span className="mono muted">
              {container.containerId} · {container.image}
            </span>
          </div>
        ) : (
          <Chip tone="off">no container yet</Chip>
        )}
        {Object.keys(agent.config.ports).length > 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Ports:{' '}
            <span className="mono">
              {Object.entries(agent.config.ports)
                .map(([cp, hp]) => `${cp} → localhost:${hp}`)
                .join(' · ')}
            </span>
          </p>
        )}
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" disabled={!dockerUp || busy} onClick={() => act('start')}>
            Start
          </button>
          <button className="btn" disabled={!dockerUp || busy} onClick={() => act('stop')}>
            Stop
          </button>
          <button
            className="btn"
            disabled={!dockerUp || busy}
            title="Remove + recreate + start so env, port and definition changes apply. Uses the last SAVED config — press Save config first if you've edited it."
            onClick={regenerate}
          >
            Regenerate
          </button>
          <label className="check-row" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={resetFiles}
              onChange={(e) => setResetFiles(e.target.checked)}
            />
            <span className="muted">also reset files from templates</span>
          </label>
          <button className="btn" disabled={!dockerUp} onClick={fetchLogs}>
            {logs === null ? 'View logs' : 'Refresh logs'}
          </button>
          {mcpInfo?.hasLogin && (
            <button
              className="btn"
              disabled={!dockerUp || busy || !container?.running}
              title="Start the one-time MCP sign-in (device code) for this agent's integrations"
              onClick={mcpSignIn}
            >
              MCP sign-in
            </button>
          )}
          {admin &&
            (defs.find((d) => d.id === agent.containerId)?.mcpServers.length ?? 0) > 0 && (
              <button
                className="btn"
                disabled={!dockerUp || busy || !container?.running}
                title="Re-run the definition's MCP server provisioning inside the container"
                onClick={provisionMcp}
              >
                Provision MCP
              </button>
            )}
          {container?.running && agent.config.ports['9119'] && (
            <a
              className="btn"
              href={`http://localhost:${agent.config.ports['9119']}`}
              target="_blank"
              rel="noreferrer"
              title="Hermes' own web dashboard — sign in with the owner's Attache email & password"
            >
              Open dashboard ↗
            </a>
          )}
          {admin && (
            <button
              className="btn btn-danger"
              disabled={!dockerUp || busy}
              onClick={() => act('remove')}
            >
              Remove container
            </button>
          )}
        </div>
        {logs !== null && <pre className="logbox">{logs}</pre>}
      </div>

      <h2>Configuration</h2>
      <div className="panel">
        {!admin && (
          <p className="muted" style={{ marginTop: 0 }}>
            Configuration is managed by an administrator.
          </p>
        )}
        {admin && defs.length > 0 && (
          <div className="field">
            <label>Container definition (the Files section below follows this)</label>
            <select value={agent.containerId} onChange={(e) => void switchDef(e.target.value)}>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.image})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>Agent name</label>
          <input value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Container image</label>
          <input value={image} disabled={!admin} onChange={(e) => setImage(e.target.value)} />
        </div>
        <div className="field">
          <label>Command (space-separated)</label>
          <input value={command} disabled={!admin} onChange={(e) => setCommand(e.target.value)} />
        </div>
        <div className="field">
          <label>
            Environment (JSON object){' '}
            <InfoPopup title="Environment variables">
              <EnvVarsHelp />
            </InfoPopup>
          </label>
          <textarea
            rows={5}
            value={envText}
            disabled={!admin}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Data mount path (container)</label>
          <input value={mountPath} disabled={!admin} onChange={(e) => setMountPath(e.target.value)} />
        </div>
        <div className="field">
          <label>{'Ports (JSON: {"containerPort": hostPort})'}</label>
          <input value={portsText} disabled={!admin} onChange={(e) => setPortsText(e.target.value)} />
        </div>
        <div className="form-row">
          <div className="field">
            <label>Memory limit MB (blank = none)</label>
            <input value={memoryMb} disabled={!admin} onChange={(e) => setMemoryMb(e.target.value)} />
          </div>
          <div className="field">
            <label>CPU limit (blank = none)</label>
            <input value={cpus} disabled={!admin} onChange={(e) => setCpus(e.target.value)} />
          </div>
        </div>
        {admin && (
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" disabled={busy} onClick={saveConfig}>
              Save config
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={removeAgent}>
              Delete agent
            </button>
          </div>
        )}
      </div>

      <h2>Files</h2>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        From the <b>{defs.find((d) => d.id === agent.containerId)?.name ?? 'selected'}</b>{' '}
        definition — <span className="mono">data/agents/{agent.id}</span> mounted at{' '}
        <span className="mono">{agent.config.mountPath}</span>
      </p>
      {docs.length === 0 && (
        <div className="panel muted">No behavior files configured for this container definition.</div>
      )}
      {docs.map((d, i) => (
        <details
          key={d.key}
          className="doc-exp"
          open={i === 0}
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void loadDocContent(d.key)
          }}
        >
          <summary>
            <b>{d.label}</b> <span className="mono muted">{d.path}</span>
            {d.hint && <span className="muted"> — {d.hint}</span>}
          </summary>
          <div className="doc-body">
            <textarea
              rows={i === 0 ? 12 : 8}
              value={docText[d.key] ?? ''}
              onChange={(e) => setDocText((t) => ({ ...t, [d.key]: e.target.value }))}
            />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => saveDocContent(d.key, d.label)}
              >
                Save {d.label.toLowerCase()}
              </button>
            </div>
          </div>
        </details>
      ))}

      <h2>Cron jobs</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          Scheduled jobs the agent runs — one YAML/JSON file per job under{' '}
          <span className="mono">cron/</span>.
        </p>
        <div className="form-row">
          <select value={cronSel} onChange={(e) => void selectCron(e.target.value)}>
            <option value="">{cronJobs.length ? '— select a job —' : '(no jobs yet)'}</option>
            {cronJobs.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
          <button className="btn" onClick={newCronJob}>
            New job
          </button>
        </div>
        {cronSel && (
          <div style={{ marginTop: 12 }}>
            <p className="mono muted" style={{ margin: '0 0 6px' }}>
              cron/{cronSel}
            </p>
            <textarea rows={8} value={cronText} onChange={(e) => setCronText(e.target.value)} />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn btn-primary" disabled={busy} onClick={saveCron}>
                Save job
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
