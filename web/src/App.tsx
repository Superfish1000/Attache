import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Agents from './pages/Agents'
import AgentDetail from './pages/AgentDetail'
import Integrations from './pages/Integrations'
import Tools from './pages/Tools'

export default function App() {
  return (
    <BrowserRouter>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            ATTACHE<span className="brand-dot">●</span>
          </div>
          <nav>
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/users">Users</NavLink>
            <NavLink to="/agents">Agents</NavLink>
            <NavLink to="/integrations">Integrations</NavLink>
            <NavLink to="/tools">Tools</NavLink>
          </nav>
          <div className="sidebar-foot">agent container platform</div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/users" element={<Users />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/tools" element={<Tools />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
