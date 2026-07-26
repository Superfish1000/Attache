export type Role = 'admin' | 'standard'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  source: 'manual' | 'o365'
  o365Id?: string
  /** scrypt hash — absent means the account cannot log in yet */
  passwordHash?: string
  createdAt: string
}

export interface Session {
  token: string
  userId: string
  createdAt: string
  expiresAt: string
}

export interface AgentConfig {
  /** Container image the agent runs in. Placeholder default until a real agent image exists. */
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

export interface O365Settings {
  tenantId: string
  clientId: string
  clientSecret: string
  groupId: string
}

export interface ServerSettings {
  host: string
  port: number
}

export interface DockerSettings {
  /** Empty string = platform default (named pipe on Windows, unix socket elsewhere) */
  socketPath: string
  defaultImage: string
  defaultCommand: string[]
  autoPull: boolean
}

export interface SecuritySettings {
  sessionTtlHours: number
}

export interface Settings {
  o365: O365Settings
  server: ServerSettings
  docker: DockerSettings
  security: SecuritySettings
  lastO365Sync: string | null
}
