import type { FastifyInstance } from 'fastify'
import { db, save } from '../store.js'
import { createAgent, deleteAgent, getSoul, putSoul } from '../agents.js'
import {
  containerInfo,
  dockerAvailable,
  removeAgentContainer,
  startAgentContainer,
  stopAgentContainer,
} from '../docker.js'
import type { AgentConfig } from '../types.js'

export default async function agentRoutes(app: FastifyInstance) {
  app.get('/', async () => db.agents)

  app.post('/', async (req, reply) => {
    const { userId, name, config } = (req.body ?? {}) as {
      userId?: string
      name?: string
      config?: Partial<AgentConfig>
    }
    if (!userId || !db.users.some((u) => u.id === userId)) {
      return reply.code(400).send({ error: 'valid userId is required' })
    }
    return reply.code(201).send(createAgent(userId, name, config))
  })

  app.get('/:id', async (req, reply) => {
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    return agent
  })

  app.patch('/:id', async (req, reply) => {
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const { name, config } = (req.body ?? {}) as { name?: string; config?: Partial<AgentConfig> }
    if (name?.trim()) agent.name = name.trim()
    if (config) {
      if (config.image !== undefined) agent.config.image = config.image
      if (config.command !== undefined) {
        if (!Array.isArray(config.command) || config.command.some((c) => typeof c !== 'string')) {
          return reply.code(400).send({ error: 'config.command must be an array of strings' })
        }
        agent.config.command = config.command
      }
      if (config.env !== undefined) {
        if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
          return reply.code(400).send({ error: 'config.env must be an object of string values' })
        }
        agent.config.env = Object.fromEntries(
          Object.entries(config.env).map(([k, v]) => [k, String(v)]),
        )
      }
    }
    save()
    return agent
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.agents.some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
    try {
      await removeAgentContainer(id)
    } catch {
      // docker unavailable — record still goes away
    }
    deleteAgent(id)
    return reply.code(204).send()
  })

  app.get('/:id/soul', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.agents.some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
    return { content: getSoul(id) }
  })

  app.put('/:id/soul', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.agents.some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) required' })
    putSoul(id, content)
    return { ok: true }
  })

  app.get('/:id/container', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.agents.some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
    if (!(await dockerAvailable())) return { available: false, exists: false }
    return { available: true, ...(await containerInfo(id)) }
  })

  app.post('/:id/container/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string }
    const agent = db.agents.find((a) => a.id === id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      if (action === 'start') return { available: true, ...(await startAgentContainer(agent)) }
      if (action === 'stop') return { available: true, ...(await stopAgentContainer(id)) }
      if (action === 'remove') return { available: true, ...(await removeAgentContainer(id)) }
      return reply.code(400).send({ error: `unknown action '${action}' (start|stop|remove)` })
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `docker ${action} failed: ${(err as Error).message}` })
    }
  })
}
