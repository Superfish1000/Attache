import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner } from '../components'
import { useAuth } from '../auth'
import type { Agent, ContainersResponse, User } from '../types'

export default function Agents() {
  const { user: me } = useAuth()
  const admin = me?.role === 'admin'
  const [agents, setAgents] = useState<Agent[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [containers, setContainers] = useState<ContainersResponse | null>(null)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState('')

  const reload = useCallback(() => {
    Promise.all([api.agents.list(), api.users.list(), api.containers()])
      .then(([a, u, c]) => {
        setAgents(a)
        setUsers(u)
        setContainers(c)
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  useEffect(reload, [reload])

  const ownerName = (userId: string) => users.find((u) => u.id === userId)?.name ?? '?'

  const stateChip = (agentId: string) => {
    if (!containers) return <Chip tone="off">…</Chip>
    if (!containers.available) return <Chip tone="err">docker offline</Chip>
    const c = containers.containers.find((c) => c.agentId === agentId)
    if (!c) return <Chip tone="off">no container</Chip>
    return <Chip tone={c.state === 'running' ? 'ok' : 'warn'}>{c.state}</Chip>
  }

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
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>Image</th>
                <th>Container</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/agents/${a.id}`}>{a.name}</Link>
                  </td>
                  <td className="muted">{ownerName(a.userId)}</td>
                  <td className="mono">{a.config.image}</td>
                  <td>{stateChip(a.id)}</td>
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
