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
  disabled?: boolean
  createdAt: string
}

export interface AgentConfig {
  image: string
  command: string[]
  env: Record<string, string>
  mountPath: string
  ports: Record<string, number>
  memoryMb?: number
  cpus?: number
}

export interface Agent {
  id: string
  userId: string
  name: string
  containerId: string
  config: AgentConfig
  createdAt: string
}

export interface ContainerFileDef {
  key: string
  label: string
  path: string
  hint: string
  template: string
}

export interface McpServerDef {
  name: string
  url: string
  command: string
  extraArgs: string
  authToken: string
}

export interface McpInfo {
  servers: string[]
  hasLogin: boolean
}

export interface McpProvisionResult {
  name: string
  ok: boolean
  output: string
}

export interface ContainerDef {
  id: string
  name: string
  image: string
  command: string[]
  env: Record<string, string>
  mountPath: string
  containerPorts: number[]
  memoryMb?: number
  cpus?: number
  files: ContainerFileDef[]
  mcpServers: McpServerDef[]
  mcpProvisionCommand: string
  mcpTokenEnvKey: string
  mcpLoginCommand: string
  dockerfile: string
  createdAt: string
}

export interface McpToolContainerDef {
  id: string
  name: string
  image: string
  command: string[]
  env: Record<string, string>
  containerPorts: number[]
  mountPath: string
  memoryMb?: number
  cpus?: number
  dockerfile: string
  createdAt: string
}

export interface McpToolInstanceConfig {
  image: string
  command: string[]
  env: Record<string, string>
  containerPorts: number[]
  hostPorts: Record<string, number>
  publishToHost: boolean
  mountPath: string
  memoryMb?: number
  cpus?: number
}

export interface McpToolInstance {
  id: string
  defId: string
  name: string
  networkAlias: string
  config: McpToolInstanceConfig
  createdAt: string
  /** Response-only convenience: the owning definition's name. Non-admin responses only include config.containerPorts (the rest is redacted server-side), so treat other config fields as absent unless you know this came from an admin request. */
  defName?: string
}

export interface AgentDocInfo {
  key: string
  label: string
  path: string
  hint: string
}

export interface StatusResponse {
  docker: { available: boolean }
  o365: { configured: boolean; lastSync: string | null }
  mcp: { enabled: boolean }
  counts: { users: number; agents: number; mcpToolInstances: number }
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
  pollMinutes: number
  createAgents: boolean
  startAgents: boolean
  provisionMcp: boolean
  sendWelcomeEmails: boolean
  lastRuns: SyncRun[]
}

export interface O365Member {
  id: string
  name: string
  email: string
}

export interface SyncRun {
  at: string
  total: number
  created: number
  disabled: number
  reenabled: number
  skippedAdmins: number
  emailFailures: number
  error?: string
}

export interface McpStatus {
  enabled: boolean
  endpoint: string | null
  note: string
  plannedTools: { name: string; description: string }[]
}

export interface SettingsView {
  server: { host: string; port: number; publicBaseUrl: string }
  email: { host: string; port: number; secure: boolean; user: string; from: string; hasPass: boolean }
  docker: {
    socketPath: string
    autoPull: boolean
    portRangeStart: number
    defaultEnv: Record<string, string>
    restartPolicy: 'no' | 'unless-stopped' | 'on-failure' | 'always'
    securityOpt: string[]
    defaultContainerId: string
  }
  security: { sessionTtlHours: number }
  dataDir: string
  /** Shared bridge network agent/tool containers use to reach each other by alias — created on demand, not user-configurable. */
  network: { name: string; exists: boolean }
}

export interface UpdateCheck {
  repo: string
  currentShort: string
  status: 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'unknown'
  behindBy: number
  latest: { short: string; message: string; date: string } | null
  runningShort?: string
  restartNeeded?: boolean
}

export interface UpdateResult {
  updated: boolean
  from: string
  to: string
  pull: string
  installNote: string
  note: string
}

export interface MeResponse {
  user: User | null
  needsSetup: boolean
}
