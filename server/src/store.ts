import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Agent, Settings, User } from './types.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DATA_DIR = process.env.ATTACHE_DATA_DIR ?? join(ROOT, 'data')
export const AGENTS_DIR = join(DATA_DIR, 'agents')
const DB_FILE = join(DATA_DIR, 'db.json')

interface DB {
  users: User[]
  agents: Agent[]
  settings: Settings
}

const defaults = (): DB => ({
  users: [],
  agents: [],
  settings: {
    o365: { tenantId: '', clientId: '', clientSecret: '', groupId: '' },
    lastO365Sync: null,
  },
})

function load(): DB {
  if (!existsSync(DB_FILE)) return defaults()
  const raw = JSON.parse(readFileSync(DB_FILE, 'utf8'))
  const d = defaults()
  return {
    users: raw.users ?? [],
    agents: raw.agents ?? [],
    settings: {
      ...d.settings,
      ...(raw.settings ?? {}),
      o365: { ...d.settings.o365, ...(raw.settings?.o365 ?? {}) },
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
