import type {
  Agent,
  AgentConfig,
  AgentDocInfo,
  ContainerDef,
  ContainerState,
  ContainersResponse,
  McpInfo,
  McpProvisionResult,
  McpStatus,
  MeResponse,
  O365Member,
  O365SettingsView,
  Role,
  SettingsView,
  StatusResponse,
  SyncRun,
  UpdateCheck,
  UpdateResult,
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
      const body = (await res.json()) as { error?: string; message?: string }
      // fastify's default 500 body puts the useful text in `message`
      if (body.error) msg = body.message && body.message !== body.error ? `${body.error}: ${body.message}` : body.error
      else if (body.message) msg = body.message
    } catch {
      // non-JSON error body
    }
    msg += ` [${res.status} ${url.replace(/^\/api/, '')}]`
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
    forgot: (email: string) => req<{ ok: boolean }>('/api/auth/forgot', json('POST', { email })),
    reset: (token: string, password: string) =>
      req<{ ok: boolean }>('/api/auth/reset', json('POST', { token, password })),
  },
  users: {
    list: () => req<User[]>('/api/users'),
    create: (u: { name: string; email: string; role: Role; password?: string }) =>
      req<User>('/api/users', json('POST', u)),
    update: (id: string, patch: { name?: string; email?: string; role?: Role; disabled?: boolean }) =>
      req<User>(`/api/users/${id}`, json('PATCH', patch)),
    setPassword: (id: string, password: string) =>
      req<User>(`/api/users/${id}/password`, json('PUT', { password })),
    sendReset: (id: string) =>
      req<{ ok: boolean }>(`/api/users/${id}/send-reset`, { method: 'POST' }),
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
    doc: (id: string, name: string) =>
      req<{ content: string; missing?: boolean; unreadable?: boolean; viaContainer?: boolean }>(
        `/api/agents/${id}/doc/${name}`,
      ),
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
    provisionMcp: (id: string) =>
      req<{ results: McpProvisionResult[] }>(`/api/agents/${id}/mcp/provision`, { method: 'POST' }),
    mcpInfo: (id: string) => req<McpInfo>(`/api/agents/${id}/mcp/info`),
    mcpLogin: (id: string) =>
      req<{ output: string }>(`/api/agents/${id}/mcp/login`, { method: 'POST' }),
    mcpLoginLog: (id: string) => req<{ output: string }>(`/api/agents/${id}/mcp/login-log`),
  },
  o365: {
    settings: () => req<O365SettingsView>('/api/o365/settings'),
    saveSettings: (s: {
      tenantId?: string
      clientId?: string
      clientSecret?: string
      groupId?: string
      pollMinutes?: number
      createAgents?: boolean
      startAgents?: boolean
      provisionMcp?: boolean
      sendWelcomeEmails?: boolean
    }) => req<O365SettingsView>('/api/o365/settings', json('PUT', s)),
    preview: () => req<O365Member[]>('/api/o365/preview'),
    sync: () => req<SyncRun>('/api/o365/sync', { method: 'POST' }),
    test: () => req<{ groupName: string; memberCount: number }>('/api/o365/test'),
  },
  containerDefs: {
    list: () => req<{ defs: ContainerDef[]; defaultId: string }>('/api/container-defs'),
    create: (body: Partial<ContainerDef>) =>
      req<ContainerDef>('/api/container-defs', json('POST', body)),
    update: (id: string, patch: Partial<ContainerDef>) =>
      req<ContainerDef>(`/api/container-defs/${id}`, json('PATCH', patch)),
    setDefault: (id: string) =>
      req<{ ok: boolean }>(`/api/container-defs/${id}/default`, { method: 'PUT' }),
    build: (id: string) =>
      req<{ ok: boolean; method: string; output: string }>(`/api/container-defs/${id}/build`, {
        method: 'POST',
      }),
    remove: (id: string) => req<void>(`/api/container-defs/${id}`, { method: 'DELETE' }),
  },
  settings: {
    get: () => req<SettingsView>('/api/settings'),
    save: (s: {
      server?: Partial<SettingsView['server']>
      docker?: Partial<SettingsView['docker']>
      security?: Partial<SettingsView['security']>
      email?: Partial<{ host: string; port: number; secure: boolean; user: string; pass: string; from: string }>
    }) => req<SettingsView>('/api/settings', json('PUT', s)),
    emailTest: () => req<{ ok: boolean; to: string }>('/api/settings/email/test', { method: 'POST' }),
  },
  mcp: {
    status: () => req<McpStatus>('/api/mcp/status'),
  },
  update: {
    check: () => req<UpdateCheck>('/api/update/check'),
    apply: () => req<UpdateResult>('/api/update/apply', { method: 'POST' }),
    restart: () => req<{ ok: boolean }>('/api/update/restart', { method: 'POST' }),
  },
}
