import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTS_DIR, db, newId, save } from './store.js'
import type { Agent, AgentConfig } from './types.js'
import { soulTemplate } from './soul-template.js'

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

function soulPath(id: string): string {
  return join(agentDir(id), 'SOUL.md')
}

export function createAgent(userId: string, name?: string, config?: Partial<AgentConfig>): Agent {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`user ${userId} not found`)
  const d = db.settings.docker
  let ports = config?.ports
  if (!ports) {
    const hostPorts = nextFreeHostPorts(d.defaultContainerPorts.length)
    ports = Object.fromEntries(d.defaultContainerPorts.map((cp, i) => [String(cp), hostPorts[i]]))
  }
  const agent: Agent = {
    id: newId(),
    userId,
    name: name?.trim() || `${user.name}'s Agent`,
    config: {
      image: config?.image ?? d.defaultImage,
      command: config?.command ?? [...d.defaultCommand],
      // per-agent gateway auth token for the Hermes OpenAI-compatible API
      env: config?.env ?? { API_SERVER_KEY: randomBytes(12).toString('hex') },
      mountPath: config?.mountPath ?? d.defaultMountPath,
      ports,
      ...(config?.memoryMb !== undefined ? { memoryMb: config.memoryMb } : {}),
      ...(config?.cpus !== undefined ? { cpus: config.cpus } : {}),
    },
    createdAt: new Date().toISOString(),
  }
  mkdirSync(agentDir(agent.id), { recursive: true })
  writeFileSync(soulPath(agent.id), soulTemplate(agent.name, user.name))
  db.agents.push(agent)
  save()
  return agent
}

export function getSoul(id: string): string {
  if (!existsSync(soulPath(id))) return ''
  return readFileSync(soulPath(id), 'utf8')
}

export function putSoul(id: string, content: string): void {
  mkdirSync(agentDir(id), { recursive: true })
  writeFileSync(soulPath(id), content)
}

/** Hermes doc files editable from the agent screen, alongside the soul. */
export const AGENT_DOCS = {
  memory: 'memories/MEMORY.md',
  user: 'memories/USER.md',
  agents: 'AGENTS.md',
  tools: 'TOOLS.md',
  hermes: '.hermes.md',
} as const
export type AgentDocName = keyof typeof AGENT_DOCS

export function getDoc(id: string, doc: AgentDocName): string {
  const p = join(agentDir(id), AGENT_DOCS[doc])
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

export function putDoc(id: string, doc: AgentDocName, content: string): void {
  const p = join(agentDir(id), AGENT_DOCS[doc])
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
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
