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
  /** Container image the agent runs in (default: Hermes Agent). */
  image: string
  command: string[]
  /** Per-agent env — merged over settings.docker.defaultEnv (agent wins). */
  env: Record<string, string>
  /** Container path the agent's data dir is mounted at (Hermes expects /opt/data). */
  mountPath: string
  /** containerPort -> hostPort mappings (e.g. { "8642": 18000 }). */
  ports: Record<string, number>
  memoryMb?: number
  cpus?: number
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
  /** Container path new agents mount their data dir at. */
  defaultMountPath: string
  /** Container ports auto-mapped to host ports when an agent is created. */
  defaultContainerPorts: number[]
  /** First host port used when auto-assigning agent port mappings. */
  portRangeStart: number
  /** Env applied to every agent container (per-agent env overrides). */
  defaultEnv: Record<string, string>
  restartPolicy: 'no' | 'unless-stopped' | 'on-failure' | 'always'
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
