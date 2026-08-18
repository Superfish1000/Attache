import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Chip, CopyButton, ErrorBanner, normalizeImageRef } from '../components'
import type { ContainerState, McpToolContainerDef, McpToolInstance } from '../types'

export default function McpToolInstances() {
  const { user: me } = useAuth()
  const admin = me?.role === 'admin'

  const [defs, setDefs] = useState<McpToolContainerDef[]>([])
  const [instances, setInstances] = useState<McpToolInstance[]>([])
  const [containers, setContainers] = useState<Record<string, ContainerState>>({})
  const [newDefId, setNewDefId] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [name, setName] = useState('')
  const [networkAlias, setNetworkAlias] = useState('')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('')
  const [envText, setEnvText] = useState('{}')
  const [portsCsv, setPortsCsv] = useState('')
  const [publishToHost, setPublishToHost] = useState(false)
  const [mountPath, setMountPath] = useState('')
  const [memoryMb, setMemoryMb] = useState('')
  const [cpus, setCpus] = useState('')
  const [logs, setLogs] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busyId, setBusyId] = useState('')

  const reload = useCallback(() => {
    Promise.all([api.mcpTools.list(), api.mcpToolInstances.list()])
      .then(([t, i]) => {
        setDefs(t.tools)
        setInstances(i.instances)
        if (!newDefId && t.tools[0]) setNewDefId(t.tools[0].id)
        i.instances.forEach((inst) => {
          api.mcpToolInstances
            .container(inst.id)
            .then((c) => setContainers((prev) => ({ ...prev, [inst.id]: c })))
            .catch(() => undefined)
        })
      })
      .catch((e: Error) => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(reload, [reload])

  const flash = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(''), 2500)
  }

  const defName = (defId: string) => defs.find((d) => d.id === defId)?.name ?? '(deleted definition)'

  const expand = (inst: McpToolInstance) => {
    if (expandedId === inst.id) {
      setExpandedId('')
      return
    }
    setExpandedId(inst.id)
    setName(inst.name)
    setNetworkAlias(inst.networkAlias)
    setImage(inst.config.image)
    setCommand(inst.config.command.join(' '))
    setEnvText(JSON.stringify(inst.config.env, null, 2))
    setPortsCsv(inst.config.containerPorts.join(', '))
    setPublishToHost(inst.config.publishToHost)
    setMountPath(inst.config.mountPath)
    setMemoryMb(inst.config.memoryMb ? String(inst.config.memoryMb) : '')
    setCpus(inst.config.cpus ? String(inst.config.cpus) : '')
    setLogs(null)
  }

  const createInstance = async () => {
    if (!newDefId) return
    setErr('')
    try {
      const inst = await api.mcpToolInstances.create({ defId: newDefId })
      flash(`${inst.name} created`)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const saveInstance = async () => {
    setBusyId(expandedId)
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
      await api.mcpToolInstances.update(expandedId, {
        name,
        networkAlias,
        config: {
          image: normalizeImageRef(image),
          command: command.split(/\s+/).filter(Boolean),
          env,
          containerPorts: portsCsv.split(/[,\s]+/).filter(Boolean).map(Number),
          publishToHost,
          mountPath,
          memoryMb: memoryMb ? Number(memoryMb) : 0,
          cpus: cpus ? Number(cpus) : 0,
        },
      })
      flash('Instance saved')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const removeInstance = async (inst: McpToolInstance) => {
    if (!confirm(`Delete MCP tool instance "${inst.name}"? Removes its container.`)) return
    setBusyId(inst.id)
    setErr('')
    try {
      await api.mcpToolInstances.remove(inst.id)
      setExpandedId('')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const act = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusyId(id)
    setErr('')
    try {
      const c = await api.mcpToolInstances.containerAction(id, action)
      setContainers((prev) => ({ ...prev, [id]: c }))
      flash(`Container ${action} ok`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const regenerate = async (id: string) => {
    setBusyId(id)
    setErr('')
    try {
      const c = await api.mcpToolInstances.regenerate(id)
      setContainers((prev) => ({ ...prev, [id]: c }))
      flash('Container regenerated')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const fetchLogs = async (id: string) => {
    setErr('')
    try {
      const res = await api.mcpToolInstances.containerLogs(id)
      setLogs(res.logs || '(no output yet)')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const statusChip = (id: string) => {
    const c = containers[id]
    if (!c) return <Chip tone="off">…</Chip>
    if (!c.available) return <Chip tone="err">docker offline</Chip>
    if (!c.exists) return <Chip tone="off">no container yet</Chip>
    return <Chip tone={c.running ? 'ok' : 'off'}>{c.state ?? (c.running ? 'running' : 'stopped')}</Chip>
  }

  const reachableAt = (inst: McpToolInstance) =>
    inst.networkAlias && inst.config.containerPorts.length > 0
      ? inst.config.containerPorts.map((p) => `http://${inst.networkAlias}:${p}`)
      : []

  return (
    <>
      <h1>MCP Tools</h1>
      <p className="subtitle">
        Running copies of MCP tool container definitions, reachable by any agent over the shared
        Attaché network. Paste a "Reachable at" address into an agent's MCP server URL field.
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <div className="panel">
        {instances.length === 0 ? (
          <div className="empty">
            No MCP tool instances yet.{admin && ' Create one below.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Definition</th>
                <th>Network alias</th>
                <th>Reachable at</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((inst) => (
                <Fragment key={inst.id}>
                  <tr>
                    <td>{inst.name}</td>
                    <td className="muted">{defName(inst.defId)}</td>
                    <td className="mono">
                      {inst.networkAlias} <CopyButton text={inst.networkAlias} />
                    </td>
                    <td className="mono">
                      {reachableAt(inst).map((url) => (
                        <div key={url}>
                          {url} <CopyButton text={url} />
                        </div>
                      ))}
                    </td>
                    <td>{statusChip(inst.id)}</td>
                    <td>
                      <div className="btn-row">
                        {admin && (
                          <button className="btn" disabled={busyId === inst.id} onClick={() => expand(inst)}>
                            {expandedId === inst.id ? 'Close' : 'Manage'}
                          </button>
                        )}
                        {!admin && (
                          <button className="btn" onClick={() => expand(inst)}>
                            {expandedId === inst.id ? 'Close' : 'Details'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === inst.id && (
                    <tr>
                      <td colSpan={6}>
                        {admin ? (
                          <div className="panel" style={{ margin: '8px 0' }}>
                            <div className="form-row">
                              <div className="field">
                                <label>Name</label>
                                <input value={name} onChange={(e) => setName(e.target.value)} />
                              </div>
                              <div className="field">
                                <label>Network alias</label>
                                <input
                                  value={networkAlias}
                                  onChange={(e) =>
                                    setNetworkAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                                  }
                                />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label>Image</label>
                                <input
                                  value={image}
                                  onChange={(e) => setImage(normalizeImageRef(e.target.value))}
                                  style={{ width: '100%' }}
                                />
                              </div>
                            </div>
                            <div className="field" style={{ marginTop: 14 }}>
                              <label>Command (space-separated)</label>
                              <input value={command} onChange={(e) => setCommand(e.target.value)} />
                            </div>
                            <div className="field" style={{ marginTop: 14 }}>
                              <label>Env (JSON)</label>
                              <textarea rows={4} value={envText} onChange={(e) => setEnvText(e.target.value)} />
                            </div>
                            <div className="form-row">
                              <div className="field">
                                <label>Container ports (comma-sep)</label>
                                <input value={portsCsv} onChange={(e) => setPortsCsv(e.target.value)} />
                              </div>
                              <div className="field">
                                <label>Data mount path (blank = none)</label>
                                <input value={mountPath} onChange={(e) => setMountPath(e.target.value)} />
                              </div>
                              <div className="field">
                                <label>Memory MB (blank = none)</label>
                                <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
                              </div>
                              <div className="field">
                                <label>CPUs (blank = none)</label>
                                <input value={cpus} onChange={(e) => setCpus(e.target.value)} />
                              </div>
                            </div>
                            <label className="check-row">
                              <input
                                type="checkbox"
                                checked={publishToHost}
                                onChange={(e) => setPublishToHost(e.target.checked)}
                              />
                              <span className="muted">Also publish to a host port (for direct/admin access)</span>
                            </label>
                            <div className="btn-row" style={{ marginTop: 14 }}>
                              <button className="btn btn-primary" disabled={busyId === inst.id} onClick={saveInstance}>
                                Save
                              </button>
                              <button
                                className="btn"
                                disabled={busyId === inst.id}
                                onClick={() => act(inst.id, 'start')}
                              >
                                Start
                              </button>
                              <button className="btn" disabled={busyId === inst.id} onClick={() => act(inst.id, 'stop')}>
                                Stop
                              </button>
                              <button
                                className="btn"
                                disabled={busyId === inst.id}
                                onClick={() => act(inst.id, 'restart')}
                              >
                                Restart
                              </button>
                              <button
                                className="btn"
                                disabled={busyId === inst.id}
                                title="Remove + recreate + start so config/image changes apply"
                                onClick={() => regenerate(inst.id)}
                              >
                                Regenerate
                              </button>
                              <button className="btn" onClick={() => fetchLogs(inst.id)}>
                                {logs === null ? 'View logs' : 'Refresh logs'}
                              </button>
                              <button
                                className="btn btn-danger"
                                disabled={busyId === inst.id}
                                onClick={() => removeInstance(inst)}
                              >
                                Delete
                              </button>
                            </div>
                            {logs !== null && <pre className="logbox">{logs}</pre>}
                          </div>
                        ) : (
                          <div className="panel" style={{ margin: '8px 0' }}>
                            <p className="muted" style={{ margin: 0 }}>
                              Based on definition <b>{defName(inst.defId)}</b>. Connect using the alias and
                              ports above — configuration and controls are admin-only.
                            </p>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {admin && (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <select value={newDefId} onChange={(e) => setNewDefId(e.target.value)}>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={!newDefId} onClick={createInstance}>
              New instance
            </button>
            {defs.length === 0 && (
              <span className="muted" style={{ alignSelf: 'center' }}>
                Create a definition on the Containers page first.
              </span>
            )}
          </div>
        )}
      </div>
    </>
  )
}
