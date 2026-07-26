import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS_DIR, db, newId, save } from './store.js'
import type { Agent, AgentConfig } from './types.js'
import { soulTemplate } from './soul-template.js'

/** Placeholder until a real agent image exists. */
export const DEFAULT_IMAGE = 'alpine:3.20'
export const DEFAULT_COMMAND = ['sleep', 'infinity']

export function agentDir(id: string): string {
  return join(AGENTS_DIR, id)
}

function soulPath(id: string): string {
  return join(agentDir(id), 'SOUL.md')
}

export function createAgent(userId: string, name?: string, config?: Partial<AgentConfig>): Agent {
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error(`user ${userId} not found`)
  const agent: Agent = {
    id: newId(),
    userId,
    name: name?.trim() || `${user.name}'s Agent`,
    config: {
      image: config?.image ?? DEFAULT_IMAGE,
      command: config?.command ?? [...DEFAULT_COMMAND],
      env: config?.env ?? {},
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

export function deleteAgent(id: string): void {
  db.agents = db.agents.filter((a) => a.id !== id)
  save()
  rmSync(agentDir(id), { recursive: true, force: true })
}
