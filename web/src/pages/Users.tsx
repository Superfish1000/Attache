import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner } from '../components'
import type { Agent, User } from '../types'

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(() => {
    Promise.all([api.users.list(), api.agents.list()])
      .then(([u, a]) => {
        setUsers(u)
        setAgents(a)
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  useEffect(reload, [reload])

  const addUser = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.users.create(name, email)
      setName('')
      setEmail('')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const newAgent = async (userId: string) => {
    setErr('')
    try {
      const agent = await api.agents.create(userId)
      navigate(`/agents/${agent.id}`)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const removeUser = async (user: User) => {
    const owned = agents.filter((a) => a.userId === user.id).length
    if (!confirm(`Delete ${user.name}? This also deletes their ${owned} agent(s).`)) return
    setErr('')
    try {
      await api.users.remove(user.id)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <>
      <h1>Users</h1>
      <p className="subtitle">People who own agents — added manually or synced from O365</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      <div className="panel">
        <div className="form-row">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
            />
          </div>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !email.trim()} onClick={addUser}>
            Add user
          </button>
        </div>
      </div>
      <div className="panel">
        {users.length === 0 ? (
          <div className="empty">No users yet. Add one above or sync from O365.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Source</th>
                <th>Agents</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <Chip tone={u.source === 'o365' ? 'warn' : 'off'}>{u.source}</Chip>
                  </td>
                  <td>{agents.filter((a) => a.userId === u.id).length}</td>
                  <td>
                    <div className="btn-row">
                      <button className="btn" onClick={() => newAgent(u.id)}>
                        New agent
                      </button>
                      <button className="btn btn-danger" onClick={() => removeUser(u)}>
                        Delete
                      </button>
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
