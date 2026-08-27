import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import {
  Chip,
  EnvVarsHelp,
  ErrorBanner,
  InfoPopup,
  McpServersHelp,
  McpTemplatesHelp,
  normalizeImageRef,
  parseLimitField,
  UpdateLight,
  UpgradeSplitButton,
} from '../components'
import McpToolContainers from './McpToolContainers'
import type { Agent, ContainerDef, ContainerFileDef, ImageUpdateCheck, McpServerDef, UpdateMode } from '../types'

export default function Containers() {
  const [searchParams] = useSearchParams()
  const autoSelectedRef = useRef(false)
  const [defs, setDefs] = useState<ContainerDef[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [toolAddresses, setToolAddresses] = useState<string[]>([])
  const [selId, setSelId] = useState('')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('')
  const [mountPath, setMountPath] = useState('')
  const [portsCsv, setPortsCsv] = useState('')
  const [envText, setEnvText] = useState('{}')
  const [memoryMb, setMemoryMb] = useState('')
  const [cpus, setCpus] = useState('')
  const [shmSizeMb, setShmSizeMb] = useState('')
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
  const [updateChecks, setUpdateChecks] = useState<Record<string, ImageUpdateCheck>>({})
  const [checkingAll, setCheckingAll] = useState(false)
  const [upgradeBusyId, setUpgradeBusyId] = useState('')
  const [bulkUpgrading, setBulkUpgrading] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'up-to-date' | 'behind' | 'not-checked'>('all')

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
    setShmSizeMb(def.shmSizeMb ? String(def.shmSizeMb) : '')
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
          // seed from persisted checks (scheduled or previous-session) — an
          // already-fresher in-memory check (this session's own click) wins
          setUpdateChecks((prev) => {
            const seeded: Record<string, ImageUpdateCheck> = {}
            for (const d of res.defs) if (d.lastUpdateCheck) seeded[d.id] = d.lastUpdateCheck
            return { ...seeded, ...prev }
          })
          if (keepSel) {
            const cur = res.defs.find((d) => d.id === selId)
            if (cur) select(cur)
          }
        })
        .catch((e: Error) => setErr(e.message))
      api.mcpToolInstances
        .list()
        .then((res) =>
          setToolAddresses(
            res.instances
              .filter((i) => i.networkAlias && i.config.containerPorts.length > 0)
              .map((i) => `http://${i.networkAlias}:${i.config.containerPorts[0]}`),
          ),
        )
        .catch(() => undefined)
    },
    [selId, select],
  )

  useEffect(() => {
    reload(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Jump-to-definition from the agent detail page (?defId=...) — select it once, then leave the user free to pick something else.
  useEffect(() => {
    if (autoSelectedRef.current) return
    const wanted = searchParams.get('defId')
    if (!wanted) return
    const def = defs.find((d) => d.id === wanted)
    if (def) {
      select(def)
      autoSelectedRef.current = true
    }
  }, [defs, searchParams, select])

  const flash = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(''), 2500)
  }

  const usedBy = (id: string) => agents.filter((a) => a.containerId === id).length

  const statusBucket = (id: string): 'up-to-date' | 'behind' | 'not-checked' => {
    const status = updateChecks[id]?.status
    if (status === 'up-to-date') return 'up-to-date'
    if (status === 'behind') return 'behind'
    return 'not-checked'
  }

  const filtersActive = search.trim() !== '' || statusFilter !== 'all'
  const clearFilters = () => {
    setSearch('')
    setStatusFilter('all')
  }

  const visibleDefs = [...defs]
    .sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0))
    .filter((d) => {
      const q = search.trim().toLowerCase()
      return !q || d.name.toLowerCase().includes(q) || d.image.toLowerCase().includes(q)
    })
    .filter((d) => statusFilter === 'all' || statusBucket(d.id) === statusFilter)

  const checkOne = async (id: string) => {
    try {
      const check = await api.containerDefs.updateCheck(id)
      setUpdateChecks((prev) => ({ ...prev, [id]: check }))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const checkAllUpdates = async () => {
    setCheckingAll(true)
    setErr('')
    try {
      await Promise.all(defs.map((d) => checkOne(d.id)))
    } finally {
      setCheckingAll(false)
    }
  }

  const upgradeOne = async (id: string, mode: UpdateMode) => {
    setUpgradeBusyId(id)
    setErr('')
    try {
      const res = await api.containerDefs.upgradeImage(id, mode)
      const def = defs.find((d) => d.id === id)
      flash(
        `${def?.name ?? 'Definition'}: ${mode} ${res.ok ? 'succeeded' : 'had errors'}` +
          (res.regenerated.length ? ` — ${res.regenerated.filter((r) => r.ok).length}/${res.regenerated.length} agent(s) regenerated` : ''),
      )
      await checkOne(id)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setUpgradeBusyId('')
    }
  }

  const upgradeAll = async (mode: UpdateMode) => {
    setBulkUpgrading(true)
    setErr('')
    try {
      const { results } = await api.containerDefs.upgradeAll(mode)
      const acted = results.filter((r) => r.result)
      flash(
        acted.length
          ? `${mode} applied to ${acted.length} definition(s) that were behind`
          : 'Nothing to upgrade — every definition is already up to date',
      )
      await checkAllUpdates()
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBulkUpgrading(false)
    }
  }

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
      memoryMb: parseLimitField('Memory MB', memoryMb),
      cpus: parseLimitField('CPUs', cpus),
      shmSizeMb: parseLimitField('Shared memory MB', shmSizeMb),
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
        Two kinds of containers: agent runtimes (one per user) and reusable MCP tool templates —
        spin up and manage running copies on the <b>MCP Tools</b> page
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <h2>Agent containers</h2>
      <p className="muted">
        Reusable container setups — image, runtime defaults, and the behavior files agents expose
      </p>
      <div className="panel">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input
            placeholder="Search name or image…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All</option>
            <option value="up-to-date">Up to date</option>
            <option value="behind">Update available</option>
            <option value="not-checked">Not checked</option>
          </select>
          {filtersActive && (
            <button className="btn" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>Files</th>
              <th>Agents</th>
              <th>Update</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleDefs.map((d) => (
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
                  <UpdateLight check={updateChecks[d.id]} />
                </td>
                <td>
                  <button className="btn" onClick={() => (selId === d.id ? setSelId('') : select(d))}>
                    {selId === d.id ? 'Close' : 'Edit'}
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
          <button className="btn" disabled={checkingAll} onClick={checkAllUpdates}>
            {checkingAll ? 'Checking…' : 'Check for updates'}
          </button>
          <UpgradeSplitButton onAction={upgradeAll} busy={bulkUpgrading} label="Upgrade all" />
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
            <div className="btn-row" style={{ alignItems: 'center', marginTop: 8 }}>
              <UpdateLight check={updateChecks[selId]} />
              <button className="btn" disabled={checkingAll} onClick={() => checkOne(selId)}>
                Check for updates
              </button>
              <UpgradeSplitButton onAction={(mode) => upgradeOne(selId, mode)} busy={upgradeBusyId === selId} />
              {updateChecks[selId] && (
                <span className="muted" style={{ alignSelf: 'center' }}>
                  {updateChecks[selId].status === 'behind' && `update available for ${updateChecks[selId].checkedImage}`}
                  {updateChecks[selId].status === 'up-to-date' && `${updateChecks[selId].checkedImage} is up to date`}
                  {updateChecks[selId].status === 'unknown' && (updateChecks[selId].error || 'could not check')}
                </span>
              )}
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
              <div className="field">
                <label>Shared memory (/dev/shm) MB (blank = Docker default ~64MB)</label>
                <input value={shmSizeMb} onChange={(e) => setShmSizeMb(e.target.value)} />
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
            <datalist id="mcp-tool-addresses">
              {toolAddresses.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
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
                      list="mcp-tool-addresses"
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
                  <textarea
                    rows={3}
                    value={s.extraArgs}
                    onChange={(e) => updMcp(i, { extraArgs: e.target.value })}
                    placeholder="--env KEY={{OWNER_EMAIL}} KEY2=val --args --flag"
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

      <McpToolContainers />
    </>
  )
}
