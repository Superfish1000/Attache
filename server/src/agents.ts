import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTS_DIR, db, newId, save } from './store.js'
import { hermesHashPassword } from './auth.js'
import type { Agent, AgentConfig, ContainerDef, ContainerFileDef, User } from './types.js'

/** Sequential free host ports starting at settings.docker.portRangeStart. */
export function nextFreeHostPorts(count: number): number[] {
  const used = new Set<number>()
  for (const a of db.agents) for (const p of Object.values(a.config.ports)) used.add(p)
  for (const t of db.mcpToolInstances) for (const p of Object.values(t.config.hostPorts)) used.add(p)
  const out: number[] = []
  let candidate = db.settings.docker.portRangeStart
  while (out.length < count) {
    if (!used.has(candidate)) {
      out.push(candidate)
      used.add(candidate)
    }
    candidate++
  }
  return out
}

export function agentDir(id: string): string {
  return join(AGENTS_DIR, id)
}

export function containerDefFor(agent: Agent): ContainerDef | undefined {
  return db.containers.find((c) => c.id === agent.containerId)
}

/** Relative path safe to join under the agent dir: no leading slash, no '..', no backslash. */
export function isSafeRelPath(p: string): boolean {
  return /^[\w.][\w.\-/ ]*$/.test(p) && !p.includes('..') && !p.includes('\\') && !p.endsWith('/')
}

export function createAgent(
  userId: string,
  name?: string,
  containerId?: string,
  config?: Partial<AgentConfig>,
): Agent {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`user ${userId} not found`)
  const def =
    db.containers.find((c) => c.id === (containerId ?? db.settings.docker.defaultContainerId)) ??
    db.containers[0]
  if (!def) throw new Error('no container definitions configured — add one under Containers')

  let ports = config?.ports
  if (!ports) {
    const hostPorts = nextFreeHostPorts(def.containerPorts.length)
    ports = Object.fromEntries(def.containerPorts.map((cp, i) => [String(cp), hostPorts[i]]))
  }
  const memoryMb = config?.memoryMb ?? def.memoryMb
  const cpus = config?.cpus ?? def.cpus
  const agent: Agent = {
    id: newId(),
    userId,
    name: name?.trim() || `${user.name}'s Agent`,
    containerId: def.id,
    config: {
      image: config?.image ?? def.image,
      command: config?.command ?? [...def.command],
      // per-agent gateway auth token (used by Hermes' OpenAI-compatible API)
      env: config?.env ?? { API_SERVER_KEY: randomBytes(12).toString('hex'), ...def.env },
      mountPath: config?.mountPath ?? def.mountPath,
      ports,
      ...(memoryMb !== undefined ? { memoryMb } : {}),
      ...(cpus !== undefined ? { cpus } : {}),
    },
    createdAt: new Date().toISOString(),
  }
  mkdirSync(agentDir(agent.id), { recursive: true })
  resetAgentFiles(agent)
  writeDashboardCreds(agent, user)
  db.agents.push(agent)
  save()
  return agent
}

/** (Re)writes this agent's templated behavior files from its definition. Returns paths written. */
export function resetAgentFiles(agent: Agent): string[] {
  const def = containerDefFor(agent)
  const owner = db.users.find((u) => u.id === agent.userId)
  const written: string[] = []
  if (!def) return written
  for (const f of def.files) {
    if (!f.template || !isSafeRelPath(f.path)) continue
    const p = join(agentDir(agent.id), f.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      f.template
        .replaceAll('{{AGENT_NAME}}', agent.name)
        .replaceAll('{{OWNER_NAME}}', owner?.name ?? ''),
    )
    written.push(f.path)
  }
  return written
}

/**
 * Ensures every container port the definition declares has a host mapping,
 * auto-assigning free host ports for missing ones. Returns true if anything changed.
 */
export function syncAgentPorts(agent: Agent): boolean {
  const def = containerDefFor(agent)
  if (!def) return false
  const missing = def.containerPorts.filter((cp) => !(String(cp) in agent.config.ports))
  if (missing.length === 0) return false
  const hostPorts = nextFreeHostPorts(missing.length)
  missing.forEach((cp, i) => {
    agent.config.ports[String(cp)] = hostPorts[i]
  })
  save()
  return true
}

/** Upserts KEY=VALUE lines into env-file text, preserving unrelated lines. */
export function mergeEnvLines(existing: string, entries: Record<string, string>): string {
  const lines = existing.split(/\r?\n/)
  const keys = new Set(Object.keys(entries))
  const keep = lines.filter((l) => l.trim() !== '' && !keys.has(l.split('=')[0]))
  for (const [k, v] of Object.entries(entries)) keep.push(`${k}=${v}`)
  return keep.join('\n') + '\n'
}

/** Upserts KEY=VALUE lines into the agent's data-dir .env, preserving others. */
export function upsertAgentEnv(agentId: string, entries: Record<string, string>): void {
  const envPath = join(agentDir(agentId), '.env')
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  mkdirSync(agentDir(agentId), { recursive: true })
  writeFileSync(envPath, mergeEnvLines(existing, entries))
}

/**
 * Provisions the owner's dashboard login into the agent's `.env` (read by
 * Hermes at startup): username = owner email, password as a Hermes-format
 * scrypt hash — no plaintext at rest. The per-agent session-signing secret
 * is generated once and preserved so dashboard sessions survive restarts.
 * Other `.env` lines are left untouched.
 *
 * Owners without a password yet (onboarding via emailed set-password link)
 * get a PLACEHOLDER credential: the hash of a random throwaway password
 * nobody knows. Hermes' dashboard needs an auth provider to bind at all on
 * non-loopback — without one it crash-loops under s6 — so this lets it come
 * up (rejecting every login) until the real hash lands on password set.
 */
export function mergeDashboardEnv(existing: string, owner: User): string {
  const hash = owner.dashboardHash ?? hermesHashPassword(randomBytes(32).toString('hex'))
  const lines = existing.split(/\r?\n/)
  const keep = lines.filter(
    (l) => l.trim() !== '' && !l.startsWith('HERMES_DASHBOARD_BASIC_AUTH_'),
  )
  const existingSecret = lines
    .find((l) => l.startsWith('HERMES_DASHBOARD_BASIC_AUTH_SECRET='))
    ?.split('=')
    .slice(1)
    .join('=')
  keep.push(
    `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${owner.email}`,
    `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=${hash}`,
    `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${existingSecret || randomBytes(32).toString('hex')}`,
  )
  return keep.join('\n') + '\n'
}

export function writeDashboardCreds(agent: Agent, owner: User): void {
  const envPath = join(agentDir(agent.id), '.env')
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const merged = mergeDashboardEnv(existing, owner)
  mkdirSync(agentDir(agent.id), { recursive: true })
  writeFileSync(envPath, merged)
}

/** Behavior files this agent exposes, from its container definition. */
export function agentFileDefs(agent: Agent): ContainerFileDef[] {
  return containerDefFor(agent)?.files ?? []
}

/**
 * null = unknown key. `missing` = file doesn't exist on disk (never created,
 * or the data dir moved). `unreadable` = exists but EACCES — typically owned
 * by the container's internal user on a Linux host.
 */
export function readAgentDoc(
  agent: Agent,
  key: string,
): { content: string; missing: boolean; unreadable?: boolean } | null {
  const f = agentFileDefs(agent).find((f) => f.key === key)
  if (!f || !isSafeRelPath(f.path)) return null
  const p = join(agentDir(agent.id), f.path)
  if (!existsSync(p)) return { content: '', missing: true }
  try {
    return { content: readFileSync(p, 'utf8'), missing: false }
  } catch {
    return { content: '', missing: false, unreadable: true }
  }
}

export function writeAgentDoc(agent: Agent, key: string, content: string): boolean {
  const f = agentFileDefs(agent).find((f) => f.key === key)
  if (!f || !isSafeRelPath(f.path)) return false
  const p = join(agentDir(agent.id), f.path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return true
}

/** Hermes cron job definitions — one YAML/JSON file per job under cron/. */
export const CRON_FILE_RE = /^[\w][\w.-]*$/

function cronPath(id: string, file: string): string {
  if (!CRON_FILE_RE.test(file)) throw new Error('invalid cron file name')
  return join(agentDir(id), 'cron', file)
}

export function listCronJobs(id: string): string[] {
  const dir = join(agentDir(id), 'cron')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

export function getCronJob(id: string, file: string): string {
  const p = cronPath(id, file)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

export function putCronJob(id: string, file: string, content: string): void {
  const p = cronPath(id, file)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

export function deleteAgent(id: string): void {
  db.agents = db.agents.filter((a) => a.id !== id)
  save()
  try {
    rmSync(agentDir(id), { recursive: true, force: true })
  } catch (err) {
    // container-owned files can block host deletion — callers run
    // removeAgentStorage (docker.ts) first; the record removal must not fail
    console.warn('agent data dir left behind:', agentDir(id), (err as Error).message)
  }
}
