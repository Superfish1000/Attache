import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Agent, Session, Settings, User } from './types.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DATA_DIR = process.env.ATTACHE_DATA_DIR ?? join(ROOT, 'data')
export const AGENTS_DIR = join(DATA_DIR, 'agents')
const DB_FILE = join(DATA_DIR, 'db.json')

interface DB {
  users: User[]
  agents: Agent[]
  sessions: Session[]
  settings: Settings
}

const defaults = (): DB => ({
  users: [],
  agents: [],
  sessions: [],
  settings: {
    o365: { tenantId: '', clientId: '', clientSecret: '', groupId: '' },
    server: { host: '127.0.0.1', port: 7701 },
    docker: {
      socketPath: '',
      defaultImage: 'nousresearch/hermes-agent:latest',
      defaultCommand: ['gateway', 'run'],
      autoPull: true,
      defaultMountPath: '/opt/data',
      defaultContainerPorts: [8642],
      portRangeStart: 18000,
      defaultEnv: { API_SERVER_ENABLED: 'true', API_SERVER_HOST: '0.0.0.0' },
      restartPolicy: 'unless-stopped',
    },
    security: { sessionTtlHours: 72 },
    lastO365Sync: null,
  },
})

function load(): DB {
  if (!existsSync(DB_FILE)) return defaults()
  const raw = JSON.parse(readFileSync(DB_FILE, 'utf8'))
  const d = defaults()
  return {
    // role backfill for records written before auth existed
    users: (raw.users ?? []).map((u: Omit<User, 'role'> & { role?: User['role'] }) => ({
      ...u,
      role: u.role ?? 'standard',
    })),
    // mountPath/ports backfill for agents created before container config grew
    agents: (raw.agents ?? []).map(
      (a: Omit<Agent, 'config'> & { config: Partial<Agent['config']> }) => ({
        ...a,
        config: {
          ...a.config,
          mountPath: a.config.mountPath ?? '/agent',
          ports: a.config.ports ?? {},
        } as Agent['config'],
      }),
    ),
    sessions: raw.sessions ?? [],
    settings: {
      ...d.settings,
      ...(raw.settings ?? {}),
      o365: { ...d.settings.o365, ...(raw.settings?.o365 ?? {}) },
      server: { ...d.settings.server, ...(raw.settings?.server ?? {}) },
      docker: { ...d.settings.docker, ...(raw.settings?.docker ?? {}) },
      security: { ...d.settings.security, ...(raw.settings?.security ?? {}) },
    },
  }
}

export const db: DB = load()

/** Atomic write: tmp file + rename. Single-process tool, sync IO is fine. */
export function save(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DB_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, DB_FILE)
}

export function newId(): string {
  let id = randomUUID().split('-')[0]
  while (db.users.some((u) => u.id === id) || db.agents.some((a) => a.id === id)) {
    id = randomUUID().split('-')[0]
  }
  return id
}
