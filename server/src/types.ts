export type Role = 'admin' | 'standard'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  /** Set by the O365 poller (left the group) or an admin. Login rejected while true. */
  disabled?: boolean
  source: 'manual' | 'o365'
  o365Id?: string
  /** scrypt hash — absent means the account cannot log in yet */
  passwordHash?: string
  /** Hermes-format scrypt hash of the same password, provisioned to owned agents' dashboards. */
  dashboardHash?: string
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

/** An MCP server pre-loaded into agents of a definition. */
export interface McpServerDef {
  /** Config key / identifier inside the agent runtime. */
  name: string
  /** HTTP/SSE endpoint URL (leave empty for stdio/command servers). */
  url: string
  /** Stdio launch command (leave empty for URL servers). */
  command: string
  /**
   * Extra template text appended per server (e.g. --env/--args flags).
   * Placeholders substituted like the provision template, incl.
   * {{OWNER_EMAIL}} / {{OWNER_NAME}} for per-agent identity pinning.
   */
  extraArgs: string
  /**
   * Optional bearer/API token. Written into the agent's data-dir .env under
   * the definition's mcpTokenEnvKey pattern before provisioning, and available
   * to the provision template as {{TOKEN}}. Empty = unauthenticated (or OAuth
   * completed interactively in the runtime's own UI).
   */
  authToken: string
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
  /** MCP servers provisioned into each agent of this definition. */
  mcpServers: McpServerDef[]
  /**
   * Shell template run inside the container (as root, via sh -c) once per MCP
   * server; {{NAME}} and {{URL}} are substituted. Runtime-specific — drop
   * privileges inside the template if the runtime needs it. Empty = disabled.
   */
  mcpProvisionCommand: string
  /**
   * Env-var key pattern for MCP tokens written to the agent's .env
   * ({{NAME_UPPER}} = server name uppercased/sanitized). Runtime-specific —
   * Hermes reads MCP_{{NAME_UPPER}}_API_KEY. Empty = never write tokens.
   */
  mcpTokenEnvKey: string
  /**
   * Optional interactive-auth bootstrap (e.g. an OAuth device-code login),
   * run detached in the container via sh -c. Same placeholders as the
   * provision template plus {{LOG}} — an in-container file path the command
   * should redirect output to; Attache tails it from the host and shows it
   * (device codes, URLs) to the user. Empty = no sign-in button.
   */
  mcpLoginCommand: string
  /**
   * Optional Dockerfile for this definition's image. "Build image" builds it
   * tagged as `image`. On daemons whose seccomp breaks builds, simple
   * FROM+RUN files are emulated via run (with settings securityOpt) + commit.
   */
  dockerfile: string
  createdAt: string
}

/** A reusable MCP tool container template — image/runtime defaults instances are created from. */
export interface McpToolContainerDef {
  id: string
  name: string
  image: string
  command: string[]
  env: Record<string, string>
  /** Ports the server listens on inside the container. */
  containerPorts: number[]
  /** Container path for persistent state; empty string = no data mount. */
  mountPath: string
  memoryMb?: number
  cpus?: number
  /** Optional Dockerfile; built the same way container definitions are (native build, falls back to run+commit emulation on daemons whose seccomp breaks builds). */
  dockerfile: string
  createdAt: string
}

/** Per-instance runtime config, copied from the definition at creation and independently editable after — mirrors AgentConfig. */
export interface McpToolInstanceConfig {
  image: string
  command: string[]
  env: Record<string, string>
  containerPorts: number[]
  /** containerPort -> hostPort; only populated when publishToHost is true. */
  hostPorts: Record<string, number>
  /** When true, also publish containerPorts to auto-assigned host ports for direct/admin access. Off by default — other containers reach this instance via networkAlias on the shared network. */
  publishToHost: boolean
  mountPath: string
  memoryMb?: number
  cpus?: number
}

/** One running (or stoppable) copy of an MCP tool container definition — mirrors Agent/ContainerDef. */
export interface McpToolInstance {
  id: string
  /** Which definition this instance was created from. */
  defId: string
  name: string
  /** DNS-safe hostname other containers reach this instance by on the shared Attaché network (e.g. "brave-search-2" -> http://brave-search-2:8080/...). Must be unique across all tool instances. Lowercase letters/digits/hyphens, can't start/end with a hyphen. */
  networkAlias: string
  config: McpToolInstanceConfig
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
  /** Poll interval in minutes; 0 = polling off. */
  pollMinutes: number
  /** Create an agent for each newly synced user. */
  createAgents: boolean
  /** Start the new agent's container immediately after creation (first start pulls the image). */
  startAgents: boolean
  /** Run the definition's MCP provisioning script once the new agent's container is running. */
  provisionMcp: boolean
  /** Email each newly synced user a set-password link (requires SMTP + public URL). */
  sendWelcomeEmails: boolean
  /** Last 10 sync runs, newest first. */
  lastRuns: SyncRun[]
}

export interface ServerSettings {
  host: string
  port: number
  /** Address users reach the GUI at (e.g. http://192.168.1.50:7700) — emailed links are built from it. */
  publicBaseUrl: string
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

export interface EmailSettings {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
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

export interface ResetToken {
  /** sha256 hex of the raw token — the raw value only ever exists in the emailed link. */
  tokenHash: string
  userId: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

export interface Settings {
  o365: O365Settings
  server: ServerSettings
  docker: DockerSettings
  security: SecuritySettings
  email: EmailSettings
  lastO365Sync: string | null
}
