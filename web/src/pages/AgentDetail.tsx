import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner, fmtDate } from '../components'
import { useAuth } from '../auth'
import type { Agent, ContainerState, User } from '../types'

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
  const [soul, setSoul] = useState('')
  const [logs, setLogs] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    Promise.all([api.agents.get(id), api.users.list(), api.agents.soul(id), api.agents.container(id)])
      .then(([a, users, s, c]) => {
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
        setSoul(s.content)
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

  const saveSoul = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.agents.saveSoul(id, soul)
      flash('Soul saved')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
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

  const fetchLogs = async () => {
    setErr('')
    try {
      const res = await api.agents.containerLogs(id)
      setLogs(res.logs || '(no output yet)')
    } catch (e) {
      setErr((e as Error).message)
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
          <button className="btn" disabled={!dockerUp} onClick={fetchLogs}>
            {logs === null ? 'View logs' : 'Refresh logs'}
          </button>
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

      <h2>Soul file</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          <span className="mono">data/agents/{agent.id}/SOUL.md</span> — mounted into the container at{' '}
          <span className="mono">/agent</span>
        </p>
        <textarea rows={14} value={soul} onChange={(e) => setSoul(e.target.value)} />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy} onClick={saveSoul}>
            Save soul
          </button>
        </div>
      </div>

      <h2>Configuration</h2>
      <div className="panel">
        {!admin && (
          <p className="muted" style={{ marginTop: 0 }}>
            Configuration is managed by an administrator.
          </p>
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
          <label>Environment (JSON object)</label>
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
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={saveConfig}>
              Save config
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={removeAgent}>
              Delete agent
            </button>
          </div>
        )}
      </div>
    </>
  )
}
