import { useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, ErrorBanner } from '../components'
import type { McpStatus } from '../types'

export default function Tools() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.mcp
      .status()
      .then(setStatus)
      .catch((e: Error) => setErr(e.message))
  }, [])

  return (
    <>
      <h1>Tool Library</h1>
      <p className="subtitle">Shared tools served to agents over MCP</p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {status && (
        <>
          <div className="panel">
            <div className="form-row">
              {status.enabled ? <Chip tone="ok">enabled</Chip> : <Chip tone="off">stub</Chip>}
              <span className="muted">{status.note}</span>
            </div>
          </div>
          <h2>Planned tools</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {status.plannedTools.map((t) => (
                  <tr key={t.name}>
                    <td className="mono">{t.name}</td>
                    <td className="muted">{t.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
