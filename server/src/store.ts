import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Agent, ContainerDef, Session, Settings, User } from './types.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DATA_DIR = process.env.ATTACHE_DATA_DIR ?? join(ROOT, 'data')
export const AGENTS_DIR = join(DATA_DIR, 'agents')
const DB_FILE = join(DATA_DIR, 'db.json')

interface DB {
  users: User[]
  agents: Agent[]
  containers: ContainerDef[]
  sessions: Session[]
  settings: Settings
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
]

/**
 * How the stock Hermes definition ingests one MCP server. remove-first makes
 * re-provisioning idempotent; runuser drops root so config files stay owned
 * by the hermes user (root-owned files break the supervised gateway).
 */
export const HERMES_MCP_PROVISION =
  'runuser -u hermes -- env HOME=/opt/data /opt/hermes/.venv/bin/hermes mcp remove {{NAME}} >/dev/null 2>&1; ' +
  'runuser -u hermes -- env HOME=/opt/data /opt/hermes/.venv/bin/hermes mcp add {{NAME}} --url {{URL}}'

const defaults = (): DB => ({
  users: [],
  agents: [],
  containers: [],
  sessions: [],
  settings: {
    o365: { tenantId: '', clientId: '', clientSecret: '', groupId: '' },
    server: { host: '127.0.0.1', port: 7701 },
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
    (c: Omit<ContainerDef, 'mcpServers' | 'mcpProvisionCommand'> & Partial<ContainerDef>) => ({
      ...c,
      mcpServers: c.mcpServers ?? [],
      mcpProvisionCommand:
        c.mcpProvisionCommand ?? (c.name === 'Hermes' ? HERMES_MCP_PROVISION : ''),
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
      createdAt: new Date().toISOString(),
    }
    containers = [def]
    defaultContainerId = def.id
    migrated = true
  }
  if (!defaultContainerId && containers[0]) defaultContainerId = containers[0].id

  const db: DB = {
    // role backfill for records written before auth existed
    users: (raw.users ?? []).map((u: Omit<User, 'role'> & { role?: User['role'] }) => ({
      ...u,
      role: u.role ?? 'standard',
    })),
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
    sessions: raw.sessions ?? [],
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
    db.containers.some((c) => c.id === id)
  ) {
    id = randomUUID().split('-')[0]
  }
  return id
}
