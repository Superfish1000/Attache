// Mirrors server/src/types.ts (+ API response shapes). Keep in sync until a shared package exists.

export type Role = 'admin' | 'standard'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  source: 'manual' | 'o365'
  o365Id?: string
  hasPassword: boolean
  createdAt: string
}

export interface AgentConfig {
  image: string
  command: string[]
  env: Record<string, string>
}

export interface Agent {
  id: string
  userId: string
  name: string
  config: AgentConfig
  createdAt: string
}

export interface StatusResponse {
  docker: { available: boolean }
  o365: { configured: boolean; lastSync: string | null }
  mcp: { enabled: boolean }
  counts: { users: number; agents: number }
}

export interface ContainerState {
  available: boolean
  exists: boolean
  running?: boolean
  state?: string
  containerId?: string
  image?: string
}

export interface ManagedContainer {
  containerId: string
  agentId?: string
  image: string
  state: string
  status: string
  names: string[]
}

export interface ContainersResponse {
  available: boolean
  containers: ManagedContainer[]
}

export interface O365SettingsView {
  tenantId: string
  clientId: string
  groupId: string
  hasSecret: boolean
  configured: boolean
  lastSync: string | null
}

export interface O365Member {
  id: string
  name: string
  email: string
}

export interface SyncResult {
  total: number
  created: number
  skipped: number
}

export interface McpStatus {
  enabled: boolean
  endpoint: string | null
  note: string
  plannedTools: { name: string; description: string }[]
}

export interface SettingsView {
  server: { host: string; port: number }
  docker: { socketPath: string; defaultImage: string; defaultCommand: string[]; autoPull: boolean }
  security: { sessionTtlHours: number }
  dataDir: string
}

export interface MeResponse {
  user: User | null
  needsSetup: boolean
}
