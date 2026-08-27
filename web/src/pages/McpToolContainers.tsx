import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import {
  Chip,
  ErrorBanner,
  normalizeImageRef,
  parseLimitField,
  UpdateLight,
  UpgradeSplitButton,
} from '../components'
import type { ImageUpdateCheck, McpToolContainerDef, McpToolInstance, UpdateMode } from '../types'

export default function McpToolContainers() {
  const [defs, setDefs] = useState<McpToolContainerDef[]>([])
  const [instances, setInstances] = useState<McpToolInstance[]>([])
  const [selId, setSelId] = useState('')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [command, setCommand] = useState('')
  const [envText, setEnvText] = useState('{}')
  const [portsCsv, setPortsCsv] = useState('')
  const [mountPath, setMountPath] = useState('')
  const [memoryMb, setMemoryMb] = useState('')
  const [cpus, setCpus] = useState('')
  const [shmSizeMb, setShmSizeMb] = useState('')
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

  const select = useCallback((def: McpToolContainerDef) => {
    setSelId(def.id)
    setName(def.name)
    setImage(def.image)
    setCommand(def.command.join(' '))
    setEnvText(JSON.stringify(def.env, null, 2))
    setPortsCsv(def.containerPorts.join(', '))
    setMountPath(def.mountPath)
    setMemoryMb(def.memoryMb ? String(def.memoryMb) : '')
    setCpus(def.cpus ? String(def.cpus) : '')
    setShmSizeMb(def.shmSizeMb ? String(def.shmSizeMb) : '')
    setDockerfile(def.dockerfile)
    setImgMode(def.dockerfile.trim() ? 'dockerfile' : 'image')
    setBuildOut('')
  }, [])

  const reload = useCallback(
    (keepSel = true) => {
      Promise.all([api.mcpTools.list(), api.mcpToolInstances.list()])
        .then(([t, i]) => {
          setDefs(t.tools)
          setInstances(i.instances)
          // seed from persisted checks (scheduled or previous-session) — an
          // already-fresher in-memory check (this session's own click) wins
          setUpdateChecks((prev) => {
            const seeded: Record<string, ImageUpdateCheck> = {}
            for (const d of t.tools) if (d.lastUpdateCheck) seeded[d.id] = d.lastUpdateCheck
            return { ...seeded, ...prev }
          })
          if (keepSel) {
            const cur = t.tools.find((d) => d.id === selId)
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

  const instanceCount = (defId: string) => instances.filter((i) => i.defId === defId).length

  const checkOne = async (id: string) => {
    try {
      const check = await api.mcpTools.updateCheck(id)
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
      const res = await api.mcpTools.upgradeImage(id, mode)
      const def = defs.find((d) => d.id === id)
      flash(
        `${def?.name ?? 'Definition'}: ${mode} ${res.ok ? 'succeeded' : 'had errors'}` +
          (res.regenerated.length ? ` — ${res.regenerated.filter((r) => r.ok).length}/${res.regenerated.length} instance(s) regenerated` : ''),
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
      const { results } = await api.mcpTools.upgradeAll(mode)
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
      image: normalizeImageRef(image),
      command: command.split(/\s+/).filter(Boolean),
      env,
      containerPorts: portsCsv.split(/[,\s]+/).filter(Boolean).map(Number),
      mountPath,
      memoryMb: parseLimitField('Memory MB', memoryMb),
      cpus: parseLimitField('CPUs', cpus),
      shmSizeMb: parseLimitField('Shared memory MB', shmSizeMb),
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

  const removeDef = async () => {
    const def = defs.find((d) => d.id === selId)
    if (!def) return
    if (!confirm(`Delete MCP tool container definition "${def.name}"?`)) return
    setErr('')
    try {
      await api.mcpTools.remove(selId)
      setSelId('')
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
      await persistDef()
      const res = await api.mcpTools.build(selId)
      setBuildOut(`${res.ok ? '✓ built' : '✗ failed'} (${res.method})\n${res.output}`)
      if (res.ok) flash(`Image ${image} built via ${res.method}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBuilding(false)
    }
  }

  return (
    <>
      <h2>MCP tool containers</h2>
      <p className="muted">
        Reusable templates for standalone MCP server containers. Each definition can be spun up as
        several independent copies — manage running copies on the <b>MCP Tools</b> page.
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {note && <div className="panel ok-note">{note}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>Instances</th>
              <th>Update</th>
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
                <td>{instanceCount(d.id)}</td>
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
            New tool container
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
                <select value={imgMode} onChange={(e) => setImgMode(e.target.value as 'image' | 'dockerfile')}>
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
                  <b>Dockerfile</b> <span className="mono muted">built as {image || '(set a tag above)'}</span>
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
                    <button className="btn" disabled={building || !dockerfile.trim()} onClick={buildImage}>
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
              <div className="field">
                <label>Shared memory (/dev/shm) MB (blank = Docker default ~64MB)</label>
                <input value={shmSizeMb} onChange={(e) => setShmSizeMb(e.target.value)} />
              </div>
            </div>

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" disabled={busy} onClick={saveDef}>
                Save definition
              </button>
              <button className="btn btn-danger" disabled={instanceCount(selId) > 0} onClick={removeDef}>
                Delete
              </button>
              {instanceCount(selId) > 0 && (
                <span className="muted" style={{ alignSelf: 'center' }}>
                  in use by {instanceCount(selId)} instance(s)
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
