import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTS_DIR, db, newId, save } from './store.js'
import type { Agent, AgentConfig, ContainerDef, ContainerFileDef } from './types.js'

/** Sequential free host ports starting at settings.docker.portRangeStart. */
function nextFreeHostPorts(count: number): number[] {
  const used = new Set<number>()
  for (const a of db.agents) for (const p of Object.values(a.config.ports)) used.add(p)
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

/** Behavior files this agent exposes, from its container definition. */
export function agentFileDefs(agent: Agent): ContainerFileDef[] {
  return containerDefFor(agent)?.files ?? []
}

/** null = unknown key; '' = file not created yet. */
export function readAgentDoc(agent: Agent, key: string): string | null {
  const f = agentFileDefs(agent).find((f) => f.key === key)
  if (!f || !isSafeRelPath(f.path)) return null
  const p = join(agentDir(agent.id), f.path)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
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
const CRON_FILE_RE = /^[\w][\w.-]*$/

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
  rmSync(agentDir(id), { recursive: true, force: true })
}
