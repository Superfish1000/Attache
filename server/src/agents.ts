import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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

export interface AgentFileEntry {
  name: string
  dir: boolean
  size: number
}

/** Resolves rel inside the agent dir; throws on traversal escapes. */
function safeAgentPath(agentId: string, rel: string): string {
  const base = resolve(agentDir(agentId))
  const p = resolve(base, rel || '.')
  if (p !== base && !p.startsWith(base + sep)) throw new Error('path escapes the agent directory')
  return p
}

export function listAgentFiles(agentId: string, rel: string): AgentFileEntry[] {
  const dir = safeAgentPath(agentId, rel)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => {
      try {
        const st = statSync(join(dir, name))
        return { name, dir: st.isDirectory(), size: st.size }
      } catch {
        return null // races/permission oddities — skip entry
      }
    })
    .filter((e): e is AgentFileEntry => e !== null)
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

const MAX_EDIT_BYTES = 1024 * 1024

export function readAgentFile(agentId: string, rel: string): string {
  const p = safeAgentPath(agentId, rel)
  const st = statSync(p)
  if (st.isDirectory()) throw new Error('that path is a directory')
  if (st.size > MAX_EDIT_BYTES) throw new Error('file exceeds the 1MB edit cap')
  const buf = readFileSync(p)
  if (buf.includes(0)) throw new Error('binary file — not editable here')
  return buf.toString('utf8')
}

export function writeAgentFile(agentId: string, rel: string, content: string): void {
  const p = safeAgentPath(agentId, rel)
  if (existsSync(p) && statSync(p).isDirectory()) throw new Error('that path is a directory')
  writeFileSync(p, content)
}

export function deleteAgent(id: string): void {
  db.agents = db.agents.filter((a) => a.id !== id)
  save()
  rmSync(agentDir(id), { recursive: true, force: true })
}
