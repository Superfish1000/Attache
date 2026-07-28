import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import {
  Chip,
  EnvVarsHelp,
  ErrorBanner,
  InfoPopup,
  McpServersHelp,
  McpTemplatesHelp,
  normalizeImageRef,
} from '../components'
import type { Agent, ContainerDef, ContainerFileDef, McpServerDef } from '../types'

export default function Containers() {
  const [defs, setDefs] = useState<ContainerDef[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [selId, setSelId] = useState('')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('')
  const [mountPath, setMountPath] = useState('')
  const [portsCsv, setPortsCsv] = useState('')
  const [envText, setEnvText] = useState('{}')
  const [memoryMb, setMemoryMb] = useState('')
  const [cpus, setCpus] = useState('')
  const [files, setFiles] = useState<ContainerFileDef[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerDef[]>([])
  const [mcpCmd, setMcpCmd] = useState('')
  const [mcpEnvKey, setMcpEnvKey] = useState('')
  const [mcpLogin, setMcpLogin] = useState('')
  const [dockerfile, setDockerfile] = useState('')
  const [imgMode, setImgMode] = useState<'image' | 'dockerfile'>('image')
  const [buildOut, setBuildOut] = useState('')
  const [building, setBuilding] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const select = useCallback((def: ContainerDef) => {
    setSelId(def.id)
    setName(def.name)
    setImage(def.image)
    setCommand(def.command.join(' '))
    setMountPath(def.mountPath)
    setPortsCsv(def.containerPorts.join(', '))
    setEnvText(JSON.stringify(def.env, null, 2))
    setMemoryMb(def.memoryMb ? String(def.memoryMb) : '')
    setCpus(def.cpus ? String(def.cpus) : '')
    setFiles(def.files.map((f) => ({ ...f })))
    setMcpServers(def.mcpServers.map((s) => ({ ...s })))
    setMcpCmd(def.mcpProvisionCommand)
    setMcpEnvKey(def.mcpTokenEnvKey)
    setMcpLogin(def.mcpLoginCommand)
    setDockerfile(def.dockerfile)
    setImgMode(def.dockerfile.trim() ? 'dockerfile' : 'image')
    setBuildOut('')
  }, [])

  const reload = useCallback(
    (keepSel = true) => {
      Promise.all([api.containerDefs.list(), api.agents.list()])
        .then(([res, ag]) => {
          setDefs(res.defs)
          setDefaultId(res.defaultId)
          setAgents(ag)
          if (keepSel) {
            const cur = res.defs.find((d) => d.id === selId)
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

  const usedBy = (id: string) => agents.filter((a) => a.containerId === id).length

  const newDef = async () => {
    setErr('')
    try {
      const def = await api.containerDefs.create({ name: 'New container' })
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
    return api.containerDefs.update(selId, {
      name,
      image: normalizeImageRef(image),
      command: command.split(/\s+/).filter(Boolean),
      mountPath,
      containerPorts: portsCsv.split(/[,\s]+/).filter(Boolean).map(Number),
      env,
      memoryMb: memoryMb ? Number(memoryMb) : 0,
      cpus: cpus ? Number(cpus) : 0,
      files,
      mcpServers,
      mcpProvisionCommand: mcpCmd,
      mcpTokenEnvKey: mcpEnvKey,
      mcpLoginCommand: mcpLogin,
      dockerfile: imgMode === 'dockerfile' ? dockerfile : '',
    })
  }

  const saveDef = async () => {
    setBusy(true)
    setErr('')
    try {
      const updated = await persistDef()
      flash(`${updated.name} saved`)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async () => {
    setErr('')
    try {
      await api.containerDefs.setDefault(selId)
      setDefaultId(selId)
      flash('Default updated')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const removeDef = async () => {
    const def = defs.find((d) => d.id === selId)
    if (!def) return
    if (!confirm(`Delete container definition "${def.name}"?`)) return
    setErr('')
    try {
      await api.containerDefs.remove(selId)
      setSelId('')
      reload(false)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const updFile = (i: number, patch: Partial<ContainerFileDef>) =>
    setFiles((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  const addFile = () =>
    setFiles((fs) => [...fs, { key: '', label: '', path: '', hint: '', template: '' }])

  const removeFile = (i: number) => setFiles((fs) => fs.filter((_, j) => j !== i))

  const updMcp = (i: number, patch: Partial<McpServerDef>) =>
    setMcpServers((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const addMcp = () =>
    setMcpServers((ss) => [...ss, { name: '', url: '', command: '', extraArgs: '', authToken: '' }])

  const removeMcp = (i: number) => setMcpServers((ss) => ss.filter((_, j) => j !== i))

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
      await persistDef()
      const res = await api.containerDefs.build(selId)
      setBuildOut(
        `${res.ok ? '✓ built' : '✗ failed'} (${res.method})\n${res.output}`,
      )
      if (res.ok) flash(`Image ${image} built via ${res.method}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBuilding(false)
    }
  }

  return (
    <>
      <h1>Containers</h1>
      <p className="subtitle">
        Reusable container setups — image, runtime defaults, and the behavior files agents expose
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>Files</th>
              <th>Agents</th>
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
                  </a>{' '}
                  {d.id === defaultId && <Chip tone="ok">default</Chip>}
                </td>
                <td className="mono">{d.image}</td>
                <td>{d.files.length}</td>
                <td>{usedBy(d.id)}</td>
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
            New definition
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
                  <p className="muted" style={{ marginTop: 0 }}>
                    Overrides the standard image: the build tags its result as the tag above and
                    agent containers run that. On old Docker daemons where builds abort, simple
                    FROM+RUN files are automatically built via run + commit instead. Switching back
                    to a standard image clears the Dockerfile on save.
                  </p>
                  <div className="field">
                    <textarea
                      rows={6}
                      value={dockerfile}
                      onChange={(e) => setDockerfile(e.target.value)}
                      placeholder={'FROM nousresearch/hermes-agent:latest\nRUN npm install -g some-mcp-server'}
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
            <div className="form-row">
              <div className="field">
                <label>Data mount path</label>
                <input value={mountPath} onChange={(e) => setMountPath(e.target.value)} />
              </div>
              <div className="field">
                <label>Auto-mapped ports (comma-sep)</label>
                <input value={portsCsv} onChange={(e) => setPortsCsv(e.target.value)} />
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
            <div className="field" style={{ marginTop: 14 }}>
              <label>
                Definition env (JSON — applied to every agent container at start; per-agent env
                overrides){' '}
                <InfoPopup title="Environment variables">
                  <EnvVarsHelp />
                </InfoPopup>
              </label>
              <textarea rows={4} value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </div>

            <h2 style={{ marginTop: 18 }}>Behavior files</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Files shown as editors on the agent screen. Templates are written when an agent is
              created — <span className="mono">{'{{AGENT_NAME}}'}</span> and{' '}
              <span className="mono">{'{{OWNER_NAME}}'}</span> are substituted.
            </p>
            {files.map((f, i) => (
              <details key={i} className="doc-exp">
                <summary>
                  <b>{f.label || '(new file)'}</b>{' '}
                  <span className="mono muted">{f.path || 'path not set'}</span>
                </summary>
                <div className="doc-body">
                  <div className="form-row">
                    <div className="field">
                      <label>Key (slug)</label>
                      <input value={f.key} onChange={(e) => updFile(i, { key: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Label</label>
                      <input value={f.label} onChange={(e) => updFile(i, { label: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Path (relative)</label>
                      <input value={f.path} onChange={(e) => updFile(i, { path: e.target.value })} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Hint</label>
                      <input
                        value={f.hint}
                        onChange={(e) => updFile(i, { hint: e.target.value })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}>
                    <label>Template (blank = don't create at agent creation)</label>
                    <textarea
                      rows={6}
                      value={f.template}
                      onChange={(e) => updFile(i, { template: e.target.value })}
                    />
                  </div>
                  <button className="btn btn-danger" onClick={() => removeFile(i)}>
                    Remove file
                  </button>
                </div>
              </details>
            ))}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={addFile}>
                Add file
              </button>
            </div>

            <h2 style={{ marginTop: 18 }}>
              MCP servers{' '}
              <InfoPopup title="Adding MCP servers">
                <McpServersHelp />
              </InfoPopup>
            </h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Pre-loaded into every agent of this definition at container start (and via the
              agent page's provision button). The command template below defines how this
              runtime ingests one server — <span className="mono">{'{{NAME}}'}</span> and{' '}
              <span className="mono">{'{{URL}}'}</span> are substituted per server.
            </p>
            {mcpServers.map((s, i) => (
              <div key={i} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
                <div className="form-row">
                  <div className="field">
                    <label>Name</label>
                    <input
                      value={s.name}
                      onChange={(e) => updMcp(i, { name: e.target.value })}
                      placeholder="ms365"
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>URL (http/sse — blank for stdio)</label>
                    <input
                      value={s.url}
                      onChange={(e) => updMcp(i, { url: e.target.value })}
                      placeholder="https://example.com/mcp"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="field">
                    <label>Stdio command (blank for URL)</label>
                    <input
                      value={s.command}
                      onChange={(e) => updMcp(i, { command: e.target.value })}
                      placeholder="ms-365-mcp-server"
                    />
                  </div>
                  <div className="field">
                    <label>Bearer token (optional)</label>
                    <input
                      type="password"
                      value={s.authToken}
                      onChange={(e) => updMcp(i, { authToken: e.target.value })}
                      placeholder="none / OAuth"
                    />
                  </div>
                  <button className="btn btn-danger" onClick={() => removeMcp(i)}>
                    Remove
                  </button>
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <label>
                    {'Extra args ({{OWNER_EMAIL}}/{{OWNER_NAME}}/{{TOKEN}} substituted per agent)'}
                  </label>
                  <input
                    value={s.extraArgs}
                    onChange={(e) => updMcp(i, { extraArgs: e.target.value })}
                    placeholder="--env KEY={{OWNER_EMAIL}} --args --flag"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            ))}
            <div className="btn-row">
              <button className="btn" onClick={addMcp}>
                Add MCP server
              </button>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>
                Provision command template (runtime-specific; blank = disabled){' '}
                <InfoPopup title="MCP configuration & placeholders">
                  <McpTemplatesHelp />
                </InfoPopup>
              </label>
              <textarea rows={3} value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} />
            </div>
            <div className="field">
              <label>
                {'Token env-key pattern (written to the agent .env; {{NAME_UPPER}} substituted; blank = never)'}
              </label>
              <input value={mcpEnvKey} onChange={(e) => setMcpEnvKey(e.target.value)} />
            </div>
            <div className="field">
              <label>
                {'MCP sign-in command (optional device-code flow; runs detached, output to {{LOG}}; shows a sign-in button on agent pages)'}
              </label>
              <textarea rows={3} value={mcpLogin} onChange={(e) => setMcpLogin(e.target.value)} />
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" disabled={busy} onClick={saveDef}>
                Save definition
              </button>
              <button className="btn" disabled={selId === defaultId} onClick={makeDefault}>
                Set as default
              </button>
              <button className="btn btn-danger" disabled={usedBy(selId) > 0} onClick={removeDef}>
                Delete
              </button>
              {usedBy(selId) > 0 && (
                <span className="muted" style={{ alignSelf: 'center' }}>
                  in use by {usedBy(selId)} agent(s)
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
