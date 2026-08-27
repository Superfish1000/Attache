import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner, NeedsRegenLight, UpdateLight } from '../components'
import { useAuth } from '../auth'
import type { Agent, ContainerDef, ContainersResponse, User } from '../types'

export default function Agents() {
  const { user: me } = useAuth()
  const admin = me?.role === 'admin'
  const [agents, setAgents] = useState<Agent[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [containers, setContainers] = useState<ContainersResponse | null>(null)
  const [defs, setDefs] = useState<ContainerDef[]>([])
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState('')
  const [search, setSearch] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [defFilter, setDefFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const reload = useCallback(() => {
    // Container definitions (/api/container-defs) are admin-only — skip that
    // call for standard users instead of letting its 403 fail the whole
    // Promise.all (see McpToolInstances.tsx for the same pattern).
    const fetchDefs: Promise<{ defs: ContainerDef[]; defaultId: string }> = admin
      ? api.containerDefs.list()
      : Promise.resolve({ defs: [], defaultId: '' })
    Promise.all([api.agents.list(), api.users.list(), api.containers(), fetchDefs])
      .then(([a, u, c, d]) => {
        setAgents(a)
        setUsers(u)
        setContainers(c)
        setDefs(d.defs)
      })
      .catch((e: Error) => setErr(e.message))
  }, [admin])

  useEffect(reload, [reload])

  const ownerName = (userId: string) => users.find((u) => u.id === userId)?.name ?? '?'
  const defForAgent = (a: Agent) => defs.find((d) => d.id === a.containerId)
  const findContainer = (agentId: string) => containers?.containers.find((c) => c.agentId === agentId)

  const stateChip = (agentId: string) => {
    if (!containers) return <Chip tone="off">…</Chip>
    if (!containers.available) return <Chip tone="err">docker offline</Chip>
    const c = findContainer(agentId)
    if (!c) return <Chip tone="off">no container</Chip>
    return <Chip tone={c.state === 'running' ? 'ok' : 'warn'}>{c.state}</Chip>
  }

  const containerStatus = (agentId: string): 'running' | 'stopped' | 'none' | 'unknown' => {
    if (!containers?.available) return 'unknown'
    const c = findContainer(agentId)
    if (!c) return 'none'
    return c.state === 'running' ? 'running' : 'stopped'
  }

  const ownerOptions = admin ? Array.from(new Set(agents.map((a) => ownerName(a.userId)))).sort() : []

  const filtersActive = Boolean(search || ownerFilter || defFilter || statusFilter)
  const clearFilters = () => {
    setSearch('')
    setOwnerFilter('')
    setDefFilter('')
    setStatusFilter('')
  }

  const filteredAgents = agents.filter((a) => {
    const owner = ownerName(a.userId)
    const q = search.trim().toLowerCase()
    if (
      q &&
      !(
        a.name.toLowerCase().includes(q) ||
        owner.toLowerCase().includes(q) ||
        a.config.image.toLowerCase().includes(q)
      )
    )
      return false
    if (admin && ownerFilter && owner !== ownerFilter) return false
    if (admin && defFilter && a.containerId !== defFilter) return false
    if (statusFilter && containerStatus(a.id) !== statusFilter) return false
    return true
  })

  const act = async (agentId: string, action: 'start' | 'stop' | 'restart') => {
    setBusyId(agentId)
    setErr('')
    try {
      await api.agents.containerAction(agentId, action)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const regenerate = async (a: Agent) => {
    if (!confirm(`Regenerate ${a.name}'s container? This removes and recreates it, briefly interrupting it.`))
      return
    setBusyId(a.id)
    setErr('')
    try {
      await api.agents.regenerate(a.id, false)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const removeAgent = async (a: Agent) => {
    if (!confirm(`Delete agent "${a.name}"? Removes its container and all files (soul, memories).`))
      return
    setBusyId(a.id)
    setErr('')
    try {
      await api.agents.remove(a.id)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const dockerUp = containers?.available ?? false

  return (
    <>
      <h1>{admin ? 'Agents' : 'My Agents'}</h1>
      <p className="subtitle">
        {admin ? 'One agent per container — create them from the Users page' : 'Your personal agents'}
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {agents.length > 0 && (
        <div className="panel">
          <div className="form-row">
            <div className="field">
              <label>Search</label>
              <input
                placeholder="name, owner, or image"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {admin && (
              <div className="field">
                <label>Owner</label>
                <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="">All</option>
                  {ownerOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {admin && (
              <div className="field">
                <label>Container definition</label>
                <select value={defFilter} onChange={(e) => setDefFilter(e.target.value)}>
                  <option value="">All</option>
                  {defs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label>Container status</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All</option>
                <option value="running">Running</option>
                <option value="stopped">Stopped</option>
                <option value="none">No container</option>
              </select>
            </div>
          </div>
          {filtersActive && (
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}
      <div className="panel">
        {agents.length === 0 ? (
          <div className="empty">
            {admin ? (
              <>
                No agents yet. Create one from the <Link to="/users">Users</Link> page.
              </>
            ) : (
              'No agents assigned to you yet — ask an administrator.'
            )}
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="empty">No agents match the current filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>Image</th>
                <th>Container</th>
                <th>Update</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/agents/${a.id}`}>{a.name}</Link>
                  </td>
                  <td className="muted">{ownerName(a.userId)}</td>
                  <td className="mono">{a.config.image}</td>
                  <td>{stateChip(a.id)}</td>
                  <td>
                    {admin && <UpdateLight check={defForAgent(a)?.lastUpdateCheck} />}{' '}
                    <NeedsRegenLight stale={findContainer(a.id)?.stale} />
                  </td>
                  <td>
                    <div className="btn-row">
                      <button
                        className="btn"
                        disabled={!dockerUp || busyId === a.id}
                        onClick={() => act(a.id, 'start')}
                      >
                        Start
                      </button>
                      <button
                        className="btn"
                        disabled={!dockerUp || busyId === a.id}
                        onClick={() => act(a.id, 'stop')}
                      >
                        Stop
                      </button>
                      <button
                        className="btn"
                        disabled={!dockerUp || busyId === a.id}
                        onClick={() => act(a.id, 'restart')}
                      >
                        Restart
                      </button>
                      <button
                        className="btn"
                        disabled={!dockerUp || busyId === a.id}
                        onClick={() => regenerate(a)}
                      >
                        Regenerate
                      </button>
                      {admin && (
                        <button
                          className="btn btn-danger"
                          disabled={busyId === a.id}
                          onClick={() => removeAgent(a)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
