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

/** A behavior file managed on the agent screen, defined per container definition. */
export interface ContainerFileDef {
  /** Slug used in URLs and as the editor id. */
  key: string
  label: string
  /** Path relative to the agent data dir (no leading slash, no '..'). */
  path: string
  hint: string
  /** Default content written at agent creation; {{AGENT_NAME}} / {{OWNER_NAME}} substituted. Empty = don't create. */
  template: string
}

/** A reusable container setup: image/runtime defaults + the behavior files agents expose. */
export interface ContainerDef {
  id: string
  name: string
  image: string
  command: string[]
  /** Definition-level env baked into new agents' config (per-agent env can override later). */
  env: Record<string, string>
  mountPath: string
  /** Container ports auto-mapped to host ports when an agent is created. */
  containerPorts: number[]
  memoryMb?: number
  cpus?: number
  files: ContainerFileDef[]
  createdAt: string
}

export interface Agent {
  id: string
  userId: string
  name: string
  /** Which container definition this agent was created from (drives its file list). */
  containerId: string
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

/** Universal docker configuration — daemon-level details shared by every container. */
export interface DockerSettings {
  /** Empty string = platform default (named pipe on Windows, unix socket elsewhere) */
  socketPath: string
  autoPull: boolean
  /** First host port used when auto-assigning agent port mappings. */
  portRangeStart: number
  /** Env applied to every agent container (per-agent env overrides). */
  defaultEnv: Record<string, string>
  restartPolicy: 'no' | 'unless-stopped' | 'on-failure' | 'always'
  /**
   * docker --security-opt entries applied to every agent container.
   * Needed on old daemons (e.g. 20.10.x) whose seccomp profile blocks clone3,
   * breaking Python threads in modern images: ["seccomp=unconfined"].
   */
  securityOpt: string[]
  /** Container definition used for new agents unless one is chosen explicitly. */
  defaultContainerId: string
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
