import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, EnvVarsHelp, ErrorBanner, InfoPopup } from '../components'
import type { Agent, ContainerDef, ContainerFileDef } from '../types'

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

  const saveDef = async () => {
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
      const updated = await api.containerDefs.update(selId, {
        name,
        image,
        command: command.split(/\s+/).filter(Boolean),
        mountPath,
        containerPorts: portsCsv.split(/[,\s]+/).filter(Boolean).map(Number),
        env,
        memoryMb: memoryMb ? Number(memoryMb) : 0,
        cpus: cpus ? Number(cpus) : 0,
        files,
      })
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
              <div className="field" style={{ flex: 1 }}>
                <label>Image</label>
                <input value={image} onChange={(e) => setImage(e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
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
