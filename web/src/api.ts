import type {
  Agent,
  AgentConfig,
  AgentDocInfo,
  ContainerDef,
  ContainerState,
  ContainersResponse,
  McpStatus,
  MeResponse,
  O365Member,
  O365SettingsView,
  Role,
  SettingsView,
  StatusResponse,
  SyncResult,
  User,
} from './types'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) {
      // session gone — bounce the app back to the login screen
      window.dispatchEvent(new Event('attache:unauthorized'))
    }
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
  auth: {
    me: () => req<MeResponse>('/api/auth/me'),
    setup: (name: string, email: string, password: string) =>
      req<{ user: User }>('/api/auth/setup', json('POST', { name, email, password })),
    login: (email: string, password: string) =>
      req<{ user: User }>('/api/auth/login', json('POST', { email, password })),
    logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  },
  users: {
    list: () => req<User[]>('/api/users'),
    create: (u: { name: string; email: string; role: Role; password?: string }) =>
      req<User>('/api/users', json('POST', u)),
    update: (id: string, patch: { name?: string; email?: string; role?: Role }) =>
      req<User>(`/api/users/${id}`, json('PATCH', patch)),
    setPassword: (id: string, password: string) =>
      req<User>(`/api/users/${id}/password`, json('PUT', { password })),
    remove: (id: string) => req<void>(`/api/users/${id}`, { method: 'DELETE' }),
  },
  agents: {
    list: () => req<Agent[]>('/api/agents'),
    get: (id: string) => req<Agent>(`/api/agents/${id}`),
    create: (userId: string, name?: string, containerId?: string) =>
      req<Agent>('/api/agents', json('POST', { userId, name, containerId })),
    update: (id: string, patch: { name?: string; containerId?: string; config?: Partial<AgentConfig> }) =>
      req<Agent>(`/api/agents/${id}`, json('PATCH', patch)),
    remove: (id: string) => req<void>(`/api/agents/${id}`, { method: 'DELETE' }),
    docs: (id: string) => req<{ docs: AgentDocInfo[] }>(`/api/agents/${id}/docs`),
    container: (id: string) => req<ContainerState>(`/api/agents/${id}/container`),
    containerLogs: (id: string) => req<{ logs: string }>(`/api/agents/${id}/container/logs`),
    doc: (id: string, name: string) => req<{ content: string }>(`/api/agents/${id}/doc/${name}`),
    saveDoc: (id: string, name: string, content: string) =>
      req<{ ok: boolean }>(`/api/agents/${id}/doc/${name}`, json('PUT', { content })),
    cronJobs: (id: string) => req<{ jobs: string[] }>(`/api/agents/${id}/cron`),
    cronJob: (id: string, file: string) =>
      req<{ content: string }>(`/api/agents/${id}/cron/${encodeURIComponent(file)}`),
    saveCronJob: (id: string, file: string, content: string) =>
      req<{ ok: boolean }>(`/api/agents/${id}/cron/${encodeURIComponent(file)}`, json('PUT', { content })),
    containerAction: (id: string, action: 'start' | 'stop' | 'remove') =>
      req<ContainerState>(`/api/agents/${id}/container/${action}`, { method: 'POST' }),
    regenerate: (id: string, resetFiles: boolean) =>
      req<ContainerState & { filesReset: string[] }>(
        `/api/agents/${id}/container/regenerate`,
        json('POST', { resetFiles }),
      ),
  },
  o365: {
    settings: () => req<O365SettingsView>('/api/o365/settings'),
    saveSettings: (s: { tenantId: string; clientId: string; clientSecret: string; groupId: string }) =>
      req<O365SettingsView>('/api/o365/settings', json('PUT', s)),
    preview: () => req<O365Member[]>('/api/o365/preview'),
    sync: () => req<SyncResult>('/api/o365/sync', { method: 'POST' }),
  },
  containerDefs: {
    list: () => req<{ defs: ContainerDef[]; defaultId: string }>('/api/container-defs'),
    create: (body: Partial<ContainerDef>) =>
      req<ContainerDef>('/api/container-defs', json('POST', body)),
    update: (id: string, patch: Partial<ContainerDef>) =>
      req<ContainerDef>(`/api/container-defs/${id}`, json('PATCH', patch)),
    setDefault: (id: string) =>
      req<{ ok: boolean }>(`/api/container-defs/${id}/default`, { method: 'PUT' }),
    remove: (id: string) => req<void>(`/api/container-defs/${id}`, { method: 'DELETE' }),
  },
  settings: {
    get: () => req<SettingsView>('/api/settings'),
    save: (s: {
      server?: Partial<SettingsView['server']>
      docker?: Partial<SettingsView['docker']>
      security?: Partial<SettingsView['security']>
    }) => req<SettingsView>('/api/settings', json('PUT', s)),
  },
  mcp: {
    status: () => req<McpStatus>('/api/mcp/status'),
  },
}
