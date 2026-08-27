import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Agent, ContainerDef, McpOAuthClient, McpOAuthCode, McpOAuthToken, McpServerDef, McpToolContainerDef, McpToolInstance, ResetToken, Session, Settings, User } from './types.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DATA_DIR = process.env.ATTACHE_DATA_DIR ?? join(ROOT, 'data')
export const AGENTS_DIR = join(DATA_DIR, 'agents')
export const MCP_TOOLS_DIR = join(DATA_DIR, 'mcp-tools')
const DB_FILE = join(DATA_DIR, 'db.json')

interface DB {
  users: User[]
  agents: Agent[]
  containers: ContainerDef[]
  mcpTools: McpToolContainerDef[]
  mcpToolInstances: McpToolInstance[]
  mcpOAuthClients: McpOAuthClient[]
  mcpOAuthCodes: McpOAuthCode[]
  mcpOAuthTokens: McpOAuthToken[]
  sessions: Session[]
  settings: Settings
  resetTokens: ResetToken[]
}

const SOUL_TEMPLATE = `# {{AGENT_NAME}}

## Identity

Agent for {{OWNER_NAME}}. Describe who this agent is, its voice, and its purpose.

## Directives

- Serve your user's goals; ask before irreversible actions.
- Keep your user's data private.

## Capabilities

Tools and integrations this agent may use. (Shared tool library via MCP — coming soon.)

## Memory

Long-lived notes the agent maintains about its user and work.
`

/** File set for the migrated/default Hermes definition. */
const HERMES_FILES = [
  { key: 'soul', label: 'Soul', path: 'SOUL.md', hint: 'identity — system prompt slot #1', template: SOUL_TEMPLATE },
  { key: 'memory', label: 'Memory', path: 'memories/MEMORY.md', hint: "the agent's long-term memory", template: '' },
  { key: 'user', label: 'User profile', path: 'memories/USER.md', hint: 'what the agent knows about its user', template: '' },
  { key: 'agents', label: 'Agents', path: 'AGENTS.md', hint: 'multi-agent coordination notes', template: '' },
  { key: 'tools', label: 'Tools', path: 'TOOLS.md', hint: 'custom tool documentation', template: '' },
  { key: 'hermes', label: 'Context', path: '.hermes.md', hint: 'project context — auto-loaded when present', template: '' },
  { key: 'config', label: 'Runtime config', path: 'config.yaml', hint: 'hermes runtime settings — model / custom server under "model:" (seeded by hermes on first boot)', template: '' },
]

/**
 * How the stock Hermes definition ingests one MCP server. remove-first makes
 * re-provisioning idempotent; runuser drops root so config files stay owned
 * by the hermes user (root-owned files break the supervised gateway).
 */
/** Hermes reads MCP bearer tokens from .env under this key pattern. */
export const HERMES_MCP_TOKEN_ENV_KEY = 'MCP_{{NAME_UPPER}}_API_KEY'

export const HERMES_MCP_PROVISION =
  // printf feeds the non-TTY "Enable all N tools?" prompt (EOF = cancel)
  'runuser -u hermes -- env HOME=/opt/data /opt/hermes/.venv/bin/hermes mcp remove {{NAME}} >/dev/null 2>&1; ' +
  'if [ -n "{{COMMAND}}" ]; then ' +
  'printf "y\\n" | runuser -u hermes -- env HOME=/opt/data /opt/hermes/.venv/bin/hermes mcp add {{NAME}} --command {{COMMAND}} {{EXTRA}}; ' +
  'else ' +
  'printf "y\\n" | runuser -u hermes -- env HOME=/opt/data /opt/hermes/.venv/bin/hermes mcp add {{NAME}} --url {{URL}} {{EXTRA}}; ' +
  'fi'

const defaults = (): DB => ({
  users: [],
  agents: [],
  containers: [],
  mcpTools: [],
  mcpToolInstances: [],
  mcpOAuthClients: [],
  mcpOAuthCodes: [],
  mcpOAuthTokens: [],
  sessions: [],
  resetTokens: [],
  settings: {
    o365: {
      tenantId: '',
      clientId: '',
      clientSecret: '',
      groupId: '',
      pollMinutes: 0,
      createAgents: true,
      startAgents: false,
      provisionMcp: true,
      sendWelcomeEmails: true,
      lastRuns: [],
    },
    server: { host: '127.0.0.1', port: 7701, publicBaseUrl: '' },
    docker: {
      socketPath: '',
      autoPull: true,
      portRangeStart: 18000,
      defaultEnv: { API_SERVER_ENABLED: 'true', API_SERVER_HOST: '0.0.0.0' },
      restartPolicy: 'unless-stopped',
      securityOpt: [],
      defaultContainerId: '',
    },
    security: { sessionTtlHours: 72 },
    email: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    selfUpdate: { autoCheckHours: 0, autoApply: false },
    imageUpdates: { autoCheckHours: 0, autoMode: 'check' },
    mcpServer: { enabled: false, bearerToken: randomBytes(24).toString('hex') },
    lastO365Sync: null,
  },
})

function load(): { db: DB; migrated: boolean } {
  const d = defaults()
  if (!existsSync(DB_FILE)) return { db: d, migrated: false }
  const raw = JSON.parse(readFileSync(DB_FILE, 'utf8'))
  const rd = raw.settings?.docker ?? {}

  // migrate pre-definition DBs: fold the old settings.docker defaults into a Hermes definition
  // (with mcp-field backfill for definitions saved before MCP support)
  let containers: ContainerDef[] = (raw.containers ?? []).map(
    (
      c: Omit<ContainerDef, 'mcpServers' | 'mcpProvisionCommand' | 'mcpTokenEnvKey'> &
        Partial<ContainerDef>,
    ) => ({
      ...c,
      mcpServers: (c.mcpServers ?? []).map(
        (s: Partial<McpServerDef> & { name: string }) => ({
          name: s.name,
          url: s.url ?? '',
          command: s.command ?? '',
          extraArgs: s.extraArgs ?? '',
          authToken: s.authToken ?? '',
        }),
      ),
      mcpProvisionCommand:
        c.mcpProvisionCommand ?? (c.name === 'Hermes' ? HERMES_MCP_PROVISION : ''),
      mcpTokenEnvKey:
        c.mcpTokenEnvKey ?? (c.name === 'Hermes' ? HERMES_MCP_TOKEN_ENV_KEY : ''),
      mcpLoginCommand: c.mcpLoginCommand ?? '',
      dockerfile: c.dockerfile ?? '',
    }),
  )
  let defaultContainerId: string = rd.defaultContainerId ?? ''
  let migrated = false
  if (containers.length === 0) {
    const def: ContainerDef = {
      id: randomUUID().split('-')[0],
      name: 'Hermes',
      image: rd.defaultImage ?? 'nousresearch/hermes-agent:latest',
      command: rd.defaultCommand ?? ['gateway', 'run'],
      env: {},
      mountPath: rd.defaultMountPath ?? '/opt/data',
      containerPorts: rd.defaultContainerPorts ?? [8642],
      files: HERMES_FILES.map((f) => ({ ...f })),
      mcpServers: [],
      mcpProvisionCommand: HERMES_MCP_PROVISION,
      mcpTokenEnvKey: HERMES_MCP_TOKEN_ENV_KEY,
      mcpLoginCommand: '',
      dockerfile: '',
      createdAt: new Date().toISOString(),
    }
    containers = [def]
    defaultContainerId = def.id
    migrated = true
  }
  if (!defaultContainerId && containers[0]) defaultContainerId = containers[0].id

  // split legacy combined mcpTools rows (def+instance in one) into a trimmed
  // def (fresh id) + an instance that KEEPS the original id, because that id
  // is baked into the already-running Docker container's name
  // (attache-tool-<id>) — see plan Task 1 / spec migration section.
  //
  // MUST run only once: this is gated on raw.mcpToolInstances being absent
  // (the pre-split schema never had that field). Once split, db.json always
  // has both mcpTools and mcpToolInstances, so every later boot falls into
  // the else-branch and loads them as-is. Splitting unconditionally on every
  // boot was a real bug caught in testing — it re-split the ALREADY-TRIMMED
  // mcpTools (no networkAlias/hostPorts left to read) into a fresh def id +
  // exactly one blank-alias instance per def, discarding every other real
  // instance and orphaning their running Docker containers.
  type LegacyMcpToolRow = McpToolContainerDef &
    Partial<{
      networkAlias: string
      hostPorts: Record<string, number>
      publishToHost: boolean
    }>
  let mcpTools: McpToolContainerDef[]
  let mcpToolInstances: McpToolInstance[]
  if (raw.mcpToolInstances === undefined) {
    migrated = true // must persist now — an unsaved split would re-run (and re-orphan instances) on the next boot
    const legacyMcpTools: LegacyMcpToolRow[] = raw.mcpTools ?? []
    mcpTools = []
    mcpToolInstances = []
    for (const t of legacyMcpTools) {
      const image = t.image ?? ''
      const command = t.command ?? []
      const env = t.env ?? {}
      const containerPorts = t.containerPorts ?? []
      const mountPath = t.mountPath ?? ''
      const defId = randomUUID().split('-')[0]
      mcpTools.push({
        id: defId,
        name: t.name,
        image,
        command,
        env,
        containerPorts,
        mountPath,
        ...(t.memoryMb ? { memoryMb: t.memoryMb } : {}),
        ...(t.cpus ? { cpus: t.cpus } : {}),
        dockerfile: t.dockerfile ?? '',
        createdAt: t.createdAt,
      })
      mcpToolInstances.push({
        id: t.id,
        defId,
        name: t.name,
        networkAlias: t.networkAlias ?? '',
        config: {
          image,
          command,
          env,
          containerPorts,
          hostPorts: t.hostPorts ?? {},
          publishToHost: t.publishToHost ?? false,
          mountPath,
          ...(t.memoryMb ? { memoryMb: t.memoryMb } : {}),
          ...(t.cpus ? { cpus: t.cpus } : {}),
        },
        createdAt: t.createdAt,
      })
    }
  } else {
    mcpTools = raw.mcpTools ?? []
    mcpToolInstances = raw.mcpToolInstances ?? []
  }

  const db: DB = {
    // role/disabled backfill for records written before auth/O365-polling existed
    users: (raw.users ?? []).map(
      (u: Omit<User, 'role' | 'disabled'> & { role?: User['role']; disabled?: boolean }) => ({
        ...u,
        role: u.role ?? 'standard',
        disabled: u.disabled ?? false,
      }),
    ),
    // config + containerId backfill for agents created before container definitions
    agents: (raw.agents ?? []).map(
      (a: Omit<Agent, 'config' | 'containerId'> & {
        config: Partial<Agent['config']>
        containerId?: string
      }) => ({
        ...a,
        containerId: a.containerId ?? defaultContainerId,
        config: {
          ...a.config,
          mountPath: a.config.mountPath ?? '/agent',
          ports: a.config.ports ?? {},
        } as Agent['config'],
      }),
    ),
    containers,
    mcpTools,
    mcpToolInstances,
    mcpOAuthClients: raw.mcpOAuthClients ?? [],
    // prune dead codes/tokens at boot, same principle as resetTokens
    mcpOAuthCodes: ((raw.mcpOAuthCodes ?? []) as McpOAuthCode[]).filter(
      (c) => !c.usedAt && Date.parse(c.expiresAt) > Date.now(),
    ),
    mcpOAuthTokens: ((raw.mcpOAuthTokens ?? []) as McpOAuthToken[]).filter(
      (t) => Date.parse(t.expiresAt) > Date.now(),
    ),
    sessions: raw.sessions ?? [],
    // prune dead reset tokens at boot
    resetTokens: ((raw.resetTokens ?? []) as ResetToken[]).filter(
      (t) => !t.usedAt && Date.parse(t.expiresAt) > Date.now(),
    ),
    settings: {
      ...d.settings,
      o365: { ...d.settings.o365, ...(raw.settings?.o365 ?? {}) },
      server: { ...d.settings.server, ...(raw.settings?.server ?? {}) },
      docker: {
        socketPath: rd.socketPath ?? '',
        autoPull: rd.autoPull ?? true,
        portRangeStart: rd.portRangeStart ?? 18000,
        defaultEnv: rd.defaultEnv ?? d.settings.docker.defaultEnv,
        restartPolicy: rd.restartPolicy ?? 'unless-stopped',
        securityOpt: rd.securityOpt ?? [],
        defaultContainerId,
      },
      security: { ...d.settings.security, ...(raw.settings?.security ?? {}) },
      email: { ...d.settings.email, ...(raw.settings?.email ?? {}) },
      selfUpdate: { ...d.settings.selfUpdate, ...(raw.settings?.selfUpdate ?? {}) },
      imageUpdates: { ...d.settings.imageUpdates, ...(raw.settings?.imageUpdates ?? {}) },
      mcpServer: {
        ...d.settings.mcpServer,
        ...(raw.settings?.mcpServer ?? {}),
        // never let a backfill produce an empty token — always keep a real one
        bearerToken: raw.settings?.mcpServer?.bearerToken || d.settings.mcpServer.bearerToken,
      },
      lastO365Sync: raw.settings?.lastO365Sync ?? null,
    },
  }
  return { db, migrated }
}

const loaded = load()
export const db: DB = loaded.db
// persist the migration immediately so definition ids stay stable across restarts
if (loaded.migrated) save()

/** Atomic write: tmp file + rename. Single-process tool, sync IO is fine. */
export function save(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DB_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, DB_FILE)
}

export function newId(): string {
  let id = randomUUID().split('-')[0]
  while (
    db.users.some((u) => u.id === id) ||
    db.agents.some((a) => a.id === id) ||
    db.containers.some((c) => c.id === id) ||
    db.mcpTools.some((t) => t.id === id) ||
    db.mcpToolInstances.some((t) => t.id === id) ||
    db.mcpOAuthClients.some((c) => c.id === id)
  ) {
    id = randomUUID().split('-')[0]
  }
  return id
}
