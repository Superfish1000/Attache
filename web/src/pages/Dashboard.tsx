import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner, fmtDate } from '../components'
import type { StatusResponse } from '../types'

export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e: Error) => setErr(e.message))
  }, [])

  return (
    <>
      <h1>Dashboard</h1>
      <p className="subtitle">Containerized AI agents at a glance</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {status && (
        <>
          <div className="cards">
            <div className="card">
              <div className="card-label">Users</div>
              <div className="card-value">{status.counts.users}</div>
            </div>
            <div className="card">
              <div className="card-label">Agents</div>
              <div className="card-value">{status.counts.agents}</div>
            </div>
            <div className="card">
              <div className="card-label">Docker</div>
              <div className="card-value small">
                {status.docker.available ? (
                  <Chip tone="ok">available</Chip>
                ) : (
                  <Chip tone="err">daemon offline</Chip>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-label">Office 365</div>
              <div className="card-value small">
                {status.o365.configured ? (
                  <Chip tone="ok">configured</Chip>
                ) : (
                  <Chip tone="off">not configured</Chip>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-label">MCP Tools</div>
              <div className="card-value small">
                {status.mcp.enabled ? <Chip tone="ok">enabled</Chip> : <Chip tone="off">stub</Chip>}
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="muted">
              Last O365 sync: {fmtDate(status.o365.lastSync)} —{' '}
              <Link to="/integrations">Integrations</Link>
            </div>
          </div>
        </>
      )}
    </>
  )
}
