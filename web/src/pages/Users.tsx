import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner } from '../components'
import { useAuth } from '../auth'
import type { Agent, Role, User } from '../types'

export default function Users() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('standard')
  const [password, setPassword] = useState('')
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
      await api.users.create({
        name,
        email,
        role,
        ...(password ? { password } : {}),
      })
      setName('')
      setEmail('')
      setPassword('')
      setRole('standard')
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (u: User, newRole: Role) => {
    setErr('')
    try {
      await api.users.update(u.id, { role: newRole })
      reload()
    } catch (e) {
      setErr((e as Error).message)
      reload()
    }
  }

  const setUserPassword = async (u: User) => {
    const pw = prompt(`New password for ${u.name} (min 8 chars):`)
    if (!pw) return
    setErr('')
    try {
      await api.users.setPassword(u.id, pw)
      reload()
    } catch (e) {
      setErr((e as Error).message)
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
      <p className="subtitle">Accounts that own agents — added manually or synced from O365</p>
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
          <div className="field">
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="standard">standard</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="field">
            <label>Password (optional)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="min 8 chars"
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim() || !email.trim()}
            onClick={addUser}
          >
            Add user
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Users without a password can't sign in until one is set.
        </p>
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
                <th>Role</th>
                <th>Source</th>
                <th>Login</th>
                <th>Agents</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    {me?.id === u.id && <span className="muted"> (you)</span>}
                  </td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                      <option value="standard">standard</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <Chip tone={u.source === 'o365' ? 'warn' : 'off'}>{u.source}</Chip>
                  </td>
                  <td>
                    {u.hasPassword ? <Chip tone="ok">enabled</Chip> : <Chip tone="off">no password</Chip>}
                  </td>
                  <td>{agents.filter((a) => a.userId === u.id).length}</td>
                  <td>
                    <div className="btn-row">
                      <button className="btn" onClick={() => newAgent(u.id)}>
                        New agent
                      </button>
                      <button className="btn" onClick={() => setUserPassword(u)}>
                        Set password
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={me?.id === u.id}
                        onClick={() => removeUser(u)}
                      >
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
