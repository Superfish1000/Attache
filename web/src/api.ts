import type {
  Agent,
  AgentConfig,
  ContainerState,
  ContainersResponse,
  McpStatus,
  O365Member,
  O365SettingsView,
  StatusResponse,
  SyncResult,
  User,
} from './types'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let msg = `request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      // non-JSON error body
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  status: () => req<StatusResponse>('/api/status'),
  containers: () => req<ContainersResponse>('/api/containers'),
  users: {
    list: () => req<User[]>('/api/users'),
    create: (name: string, email: string) => req<User>('/api/users', json('POST', { name, email })),
    remove: (id: string) => req<void>(`/api/users/${id}`, { method: 'DELETE' }),
  },
  agents: {
    list: () => req<Agent[]>('/api/agents'),
    get: (id: string) => req<Agent>(`/api/agents/${id}`),
    create: (userId: string, name?: string) =>
      req<Agent>('/api/agents', json('POST', { userId, name })),
    update: (id: string, patch: { name?: string; config?: Partial<AgentConfig> }) =>
      req<Agent>(`/api/agents/${id}`, json('PATCH', patch)),
    remove: (id: string) => req<void>(`/api/agents/${id}`, { method: 'DELETE' }),
    soul: (id: string) => req<{ content: string }>(`/api/agents/${id}/soul`),
    saveSoul: (id: string, content: string) =>
      req<{ ok: boolean }>(`/api/agents/${id}/soul`, json('PUT', { content })),
    container: (id: string) => req<ContainerState>(`/api/agents/${id}/container`),
    containerAction: (id: string, action: 'start' | 'stop' | 'remove') =>
      req<ContainerState>(`/api/agents/${id}/container/${action}`, { method: 'POST' }),
  },
  o365: {
    settings: () => req<O365SettingsView>('/api/o365/settings'),
    saveSettings: (s: { tenantId: string; clientId: string; clientSecret: string; groupId: string }) =>
      req<O365SettingsView>('/api/o365/settings', json('PUT', s)),
    preview: () => req<O365Member[]>('/api/o365/preview'),
    sync: () => req<SyncResult>('/api/o365/sync', { method: 'POST' }),
  },
  mcp: {
    status: () => req<McpStatus>('/api/mcp/status'),
  },
}
