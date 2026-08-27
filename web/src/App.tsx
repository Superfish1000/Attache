import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth'
import { Chip } from './components'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Agents from './pages/Agents'
import AgentDetail from './pages/AgentDetail'
import Integrations from './pages/Integrations'
import Settings from './pages/Settings'
import Containers from './pages/Containers'
import McpToolInstances from './pages/McpToolInstances'
import Chat from './pages/Chat'
import Login from './pages/Login'
import Reset from './pages/Reset'
import OAuthConsent from './pages/OAuthConsent'

function Brand() {
  return (
    <div className="brand">
      ATTACHÉ<span className="brand-dot">●</span>
    </div>
  )
}

function Shell() {
  const { user, loading, logout } = useAuth()

  const { pathname } = useLocation()
  if (pathname === '/reset') return <Reset />

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="muted">Loading…</div>
      </div>
    )
  }
  if (!user) return <Login />

  const admin = user.role === 'admin'
  const AdminRoute = ({ children }: { children: ReactNode }) =>
    admin ? <>{children}</> : <Navigate to="/agents" replace />

  return (
    <div className="layout">
      <aside className="sidebar">
        <Brand />
        <nav>
          {admin && (
            <NavLink to="/" end>
              Dashboard
            </NavLink>
          )}
          <NavLink to="/chat">Chat</NavLink>
          {admin && <NavLink to="/users">Users</NavLink>}
          <NavLink to="/agents">{admin ? 'Agents' : 'My Agents'}</NavLink>
          {admin && <NavLink to="/containers">Containers</NavLink>}
          <NavLink to="/mcp-tools">MCP Tools</NavLink>
          {admin && <NavLink to="/integrations">Integrations</NavLink>}
          {/* Tools (MCP library) hidden until it's more than a stub — page kept at pages/Tools.tsx */}
          {admin && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <div className="userbox">
          <div className="userbox-name">{user.name}</div>
          <div className="userbox-row">
            <Chip tone={admin ? 'warn' : 'off'}>{user.role}</Chip>
            <button className="btn btn-ghost userbox-logout" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
        <div className="sidebar-foot">agent container platform</div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={admin ? <Dashboard /> : <Navigate to="/agents" replace />} />
          <Route
            path="/users"
            element={
              <AdminRoute>
                <Users />
              </AdminRoute>
            }
          />
          <Route path="/chat" element={<Chat />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route
            path="/containers"
            element={
              <AdminRoute>
                <Containers />
              </AdminRoute>
            }
          />
          <Route path="/mcp-tools" element={<McpToolInstances />} />
          <Route
            path="/integrations"
            element={
              <AdminRoute>
                <Integrations />
              </AdminRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <AdminRoute>
                <Settings />
              </AdminRoute>
            }
          />
          <Route path="/oauth/authorize" element={<OAuthConsent />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  )
}
