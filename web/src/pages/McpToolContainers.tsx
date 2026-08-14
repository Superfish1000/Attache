import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Chip, ErrorBanner, normalizeImageRef } from '../components'
import type { ContainerState, McpToolContainerDef } from '../types'

export default function McpToolContainers() {
  const [defs, setDefs] = useState<McpToolContainerDef[]>([])
  const [selId, setSelId] = useState('')
  const [savedDef, setSavedDef] = useState<McpToolContainerDef | null>(null)
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
  const [dockerfile, setDockerfile] = useState('')
  const [imgMode, setImgMode] = useState<'image' | 'dockerfile'>('image')
  const [buildOut, setBuildOut] = useState('')
  const [building, setBuilding] = useState(false)
  const [container, setContainer] = useState<ContainerState | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // guards against a stale container() response from a previous selection landing
  // after a newer one was picked (same class of race as Chat.tsx's abortRef)
  const selIdRef = useRef('')

  const select = useCallback((def: McpToolContainerDef) => {
    selIdRef.current = def.id
    setSelId(def.id)
    setSavedDef(def)
    setName(def.name)
    setNetworkAlias(def.networkAlias)
    setImage(def.image)
    setCommand(def.command.join(' '))
    setEnvText(JSON.stringify(def.env, null, 2))
    setPortsCsv(def.containerPorts.join(', '))
    setPublishToHost(def.publishToHost)
    setMountPath(def.mountPath)
    setMemoryMb(def.memoryMb ? String(def.memoryMb) : '')
    setCpus(def.cpus ? String(def.cpus) : '')
    setDockerfile(def.dockerfile)
    setImgMode(def.dockerfile.trim() ? 'dockerfile' : 'image')
    setBuildOut('')
    setLogs(null)
    setContainer(null)
    api.mcpTools
      .container(def.id)
      .then((c) => {
        if (selIdRef.current === def.id) setContainer(c)
      })
      .catch(() => undefined)
  }, [])

  const reload = useCallback(
    (keepSel = true) => {
      api.mcpTools
        .list()
        .then((res) => {
          setDefs(res.tools)
          if (keepSel) {
            const cur = res.tools.find((d) => d.id === selId)
            if (cur) select(cur)
          }
        })
        .catch((e: Error) => setErr(e.message))
    },
    [selId, select],
  )

  useEffect(() => {
    reload(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(''), 2500)
  }

  const newDef = async () => {
    setErr('')
    try {
      const def = await api.mcpTools.create({})
      setDefs((d) => [...d, def])
      select(def)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  /** Persists the editor state to the definition. Throws on validation/API errors. */
  const persistDef = async () => {
    let env: Record<string, string>
    try {
      const parsed = JSON.parse(envText || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
      env = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
    } catch {
      throw new Error('Env must be a JSON object of key/value strings')
    }
    return api.mcpTools.update(selId, {
      name,
      networkAlias,
      image: normalizeImageRef(image),
      command: command.split(/\s+/).filter(Boolean),
      env,
      containerPorts: portsCsv.split(/[,\s]+/).filter(Boolean).map(Number),
      publishToHost,
      mountPath,
      memoryMb: memoryMb ? Number(memoryMb) : 0,
      cpus: cpus ? Number(cpus) : 0,
      dockerfile: imgMode === 'dockerfile' ? dockerfile : '',
    })
  }

  const saveDef = async () => {
    setBusy(true)
    setErr('')
    try {
      const updated = await persistDef()
      setSavedDef(updated)
      flash(`${updated.name} saved`)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const removeDef = async () => {
    const def = defs.find((d) => d.id === selId)
    if (!def) return
    if (!confirm(`Delete MCP tool container "${def.name}"?`)) return
    setErr('')
    try {
      await api.mcpTools.remove(selId)
      setSelId('')
      setSavedDef(null)
      reload(false)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const buildImage = async () => {
    if (
      !confirm(
        `Save the definition and build the Dockerfile as image "${normalizeImageRef(image)}"? This can take several minutes.`,
      )
    )
      return
    setBuilding(true)
    setErr('')
    setBuildOut('')
    try {
      const updated = await persistDef()
      setSavedDef(updated)
      const res = await api.mcpTools.build(selId)
      setBuildOut(`${res.ok ? '✓ built' : '✗ failed'} (${res.method})\n${res.output}`)
      if (res.ok) flash(`Image ${image} built via ${res.method}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBuilding(false)
    }
  }

  const act = async (action: 'start' | 'stop' | 'remove') => {
    setBusy(true)
    setErr('')
    try {
      setContainer(await api.mcpTools.containerAction(selId, action))
      flash(`Container ${action} ok`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const regenerateContainer = async () => {
    setBusy(true)
    setErr('')
    try {
      setContainer(await api.mcpTools.regenerate(selId))
      flash('Container regenerated')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fetchLogs = async () => {
    setErr('')
    try {
      const res = await api.mcpTools.containerLogs(selId)
      setLogs(res.logs || '(no output yet)')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const ports = portsCsv.split(/[,\s]+/).filter(Boolean).map(Number)
  const dockerUp = container?.available ?? false
  const statusChip = !container
    ? null
    : !container.available
      ? <Chip tone="err">docker offline</Chip>
      : container.exists
        ? <Chip tone={container.running ? 'ok' : 'off'}>{container.state ?? (container.running ? 'running' : 'stopped')}</Chip>
        : <Chip tone="off">no container yet</Chip>

  return (
    <>
      <h2>MCP tool containers</h2>
      <p className="muted">
        Standalone containers that run MCP server software, reachable by any agent over the shared
        Attaché network — decoupled from any specific agent. Once one is running, paste its address
        (shown per row below) into an agent's MCP server URL field.
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>Network alias</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {defs.map((d) => (
              <tr key={d.id}>
                <td>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      select(d)
                    }}
                  >
                    {d.name}
                  </a>
                </td>
                <td className="mono">{d.image}</td>
                <td className="mono">{d.networkAlias}</td>
                <td>
                  <button className="btn" onClick={() => select(d)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={newDef}>
            New tool container
          </button>
        </div>
      </div>

      {selId && (
        <>
          <h2>Definition</h2>
          <div className="panel">
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label>Network alias</label>
                <input
                  value={networkAlias}
                  onChange={(e) => setNetworkAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                />
              </div>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              How agents reach this container: http://&lt;alias&gt;:&lt;port&gt;
            </p>

            <div className="form-row">
              <div className="field">
                <label>Image source</label>
                <select
                  value={imgMode}
                  onChange={(e) => setImgMode(e.target.value as 'image' | 'dockerfile')}
                >
                  <option value="image">Standard image</option>
                  <option value="dockerfile">Build from Dockerfile</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{imgMode === 'dockerfile' ? 'Built image tag' : 'Image'}</label>
                <input
                  value={image}
                  onChange={(e) => setImage(normalizeImageRef(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            {imgMode === 'dockerfile' && (
              <details className="doc-exp" style={{ marginTop: 10 }}>
                <summary>
                  <b>Dockerfile</b>{' '}
                  <span className="mono muted">built as {image || '(set a tag above)'}</span>
                </summary>
                <div className="doc-body">
                  <div className="field">
                    <textarea
                      rows={6}
                      value={dockerfile}
                      onChange={(e) => setDockerfile(e.target.value)}
                      placeholder={'FROM node:20-slim\nRUN npm install -g some-mcp-server'}
                    />
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn"
                      disabled={building || !dockerfile.trim()}
                      onClick={buildImage}
                    >
                      {building ? 'Building…' : 'Build image'}
                    </button>
                    <span className="muted" style={{ alignSelf: 'center' }}>
                      Saves the definition first, then builds what was saved.
                    </span>
                  </div>
                  {buildOut && <pre className="logbox">{buildOut}</pre>}
                </div>
              </details>
            )}

            <div className="field" style={{ marginTop: 14 }}>
              <label>Command (space-separated)</label>
              <input value={command} onChange={(e) => setCommand(e.target.value)} />
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>Env (JSON — passed straight to the container process)</label>
              <textarea rows={4} value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </div>

            <div className="form-row">
              <div className="field">
                <label>Container ports (comma-sep)</label>
                <input value={portsCsv} onChange={(e) => setPortsCsv(e.target.value)} />
              </div>
              <div className="field">
                <label>Data mount path (blank = no persistent storage)</label>
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
            {publishToHost && ports.length > 0 && (
              <p className="mono muted" style={{ marginTop: 4 }}>
                {ports
                  .map((p) => {
                    const hp = savedDef?.hostPorts?.[String(p)]
                    return `${p} → ${hp ? `host port ${hp}` : 'assign on next save'}`
                  })
                  .join(' · ')}
              </p>
            )}

            {networkAlias && ports.length > 0 && (
              <p className="mono muted">
                Reachable at: {ports.map((p) => `http://${networkAlias}:${p}`).join(' · ')}
              </p>
            )}

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" disabled={busy} onClick={saveDef}>
                Save definition
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={removeDef}>
                Delete
              </button>
            </div>
          </div>

          <h2>Container</h2>
          <div className="panel">
            <div className="form-row">
              {statusChip}
              {container?.exists && (
                <span className="mono muted">
                  {container.containerId} · {container.image}
                </span>
              )}
            </div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                disabled={!dockerUp || busy || !savedDef?.image.trim() || !savedDef?.networkAlias.trim()}
                title="Uses the last SAVED config — press Save definition first if you've edited it."
                onClick={() => act('start')}
              >
                Start
              </button>
              <button className="btn" disabled={!dockerUp || busy} onClick={() => act('stop')}>
                Stop
              </button>
              <button
                className="btn"
                disabled={!dockerUp || busy}
                title="Remove + recreate + start so env, port and definition changes apply. Uses the last SAVED config — press Save definition first if you've edited it."
                onClick={regenerateContainer}
              >
                Regenerate
              </button>
              <button className="btn" disabled={!dockerUp} onClick={fetchLogs}>
                {logs === null ? 'View logs' : 'Refresh logs'}
              </button>
            </div>
            {logs !== null && <pre className="logbox">{logs}</pre>}
          </div>
        </>
      )}
    </>
  )
}
