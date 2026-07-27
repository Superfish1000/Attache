import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db, save } from '../store.js'
import {
  agentFileDefs,
  createAgent,
  deleteAgent,
  getCronJob,
  listCronJobs,
  putCronJob,
  readAgentDoc,
  writeAgentDoc,
} from '../agents.js'
import {
  containerInfo,
  containerLogs,
  dockerAvailable,
  removeAgentContainer,
  startAgentContainer,
  stopAgentContainer,
} from '../docker.js'
import { canAccessAgent, requireAdmin } from '../auth.js'
import type { Agent, AgentConfig } from '../types.js'

export default async function agentRoutes(app: FastifyInstance) {
  /** 404s (not 403) for foreign agents so ids aren't probeable. Returns null after replying. */
  const accessibleAgent = (req: FastifyRequest, reply: FastifyReply): Agent | null => {
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent || !canAccessAgent(req.user!, agent)) {
      reply.code(404).send({ error: 'agent not found' })
      return null
    }
    return agent
  }

  app.get('/', async (req) =>
    req.user!.role === 'admin' ? db.agents : db.agents.filter((a) => a.userId === req.user!.id),
  )

  app.post('/', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { userId, name, containerId, config } = (req.body ?? {}) as {
      userId?: string
      name?: string
      containerId?: string
      config?: Partial<AgentConfig>
    }
    if (!userId || !db.users.some((u) => u.id === userId)) {
      return reply.code(400).send({ error: 'valid userId is required' })
    }
    if (containerId && !db.containers.some((c) => c.id === containerId)) {
      return reply.code(400).send({ error: 'unknown container definition' })
    }
    try {
      return reply.code(201).send(createAgent(userId, name, containerId, config))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/:id', async (req, reply) => accessibleAgent(req, reply) ?? reply)

  app.patch('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const { name, containerId, config } = (req.body ?? {}) as {
      name?: string
      containerId?: string
      config?: Partial<AgentConfig>
    }
    if (name?.trim()) agent.name = name.trim()
    if (containerId !== undefined) {
      if (!db.containers.some((c) => c.id === containerId)) {
        return reply.code(400).send({ error: 'unknown container definition' })
      }
      agent.containerId = containerId
    }
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
      if (config.mountPath !== undefined) {
        if (typeof config.mountPath !== 'string' || !config.mountPath.startsWith('/')) {
          return reply.code(400).send({ error: 'config.mountPath must be an absolute container path' })
        }
        agent.config.mountPath = config.mountPath
      }
      if (config.ports !== undefined) {
        if (typeof config.ports !== 'object' || config.ports === null || Array.isArray(config.ports)) {
          return reply.code(400).send({ error: 'config.ports must map containerPort to hostPort' })
        }
        const ports: Record<string, number> = {}
        for (const [cp, hp] of Object.entries(config.ports)) {
          const cpN = Number(cp)
          const hpN = Number(hp)
          if (!Number.isInteger(cpN) || !Number.isInteger(hpN) || hpN < 1 || hpN > 65535 || cpN < 1 || cpN > 65535) {
            return reply.code(400).send({ error: `invalid port mapping ${cp}:${String(hp)}` })
          }
          ports[String(cpN)] = hpN
        }
        agent.config.ports = ports
      }
      if (config.memoryMb !== undefined) {
        const m = Number(config.memoryMb)
        if (m && (!Number.isInteger(m) || m < 64)) {
          return reply.code(400).send({ error: 'config.memoryMb must be an integer >= 64 (0 clears)' })
        }
        if (m) agent.config.memoryMb = m
        else delete agent.config.memoryMb
      }
      if (config.cpus !== undefined) {
        const c = Number(config.cpus)
        if (c && (!Number.isFinite(c) || c <= 0 || c > 64)) {
          return reply.code(400).send({ error: 'config.cpus must be > 0 and <= 64 (0 clears)' })
        }
        if (c) agent.config.cpus = c
        else delete agent.config.cpus
      }
    }
    save()
    return agent
  })

  app.delete('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
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

  // behavior files come from the agent's container definition — owner-editable
  app.get('/:id/docs', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    return {
      docs: agentFileDefs(agent).map(({ key, label, path, hint }) => ({ key, label, path, hint })),
    }
  })

  app.get('/:id/doc/:key', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const content = readAgentDoc(agent, (req.params as { key: string }).key)
    if (content === null) return reply.code(404).send({ error: 'unknown doc' })
    return { content }
  })

  app.put('/:id/doc/:key', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) required' })
    if (!writeAgentDoc(agent, (req.params as { key: string }).key, content)) {
      return reply.code(404).send({ error: 'unknown doc' })
    }
    return { ok: true }
  })

  // hermes cron jobs — one file per job under cron/
  app.get('/:id/cron', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    return { jobs: listCronJobs(agent.id) }
  })

  app.get('/:id/cron/:file', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    try {
      return { content: getCronJob(agent.id, (req.params as { file: string }).file) }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.put('/:id/cron/:file', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) required' })
    try {
      putCronJob(agent.id, (req.params as { file: string }).file, content)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/:id/container', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) return { available: false, exists: false }
    return { available: true, ...(await containerInfo(agent.id)) }
  })

  app.get('/:id/container/logs', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      return { logs: await containerLogs(agent.id) }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'no container for this agent yet' })
      }
      throw err
    }
  })

  app.post('/:id/container/:action', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { action } = req.params as { action: string }
    if (action === 'remove' && !requireAdmin(req, reply)) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      if (action === 'start') return { available: true, ...(await startAgentContainer(agent)) }
      if (action === 'stop') return { available: true, ...(await stopAgentContainer(agent.id)) }
      if (action === 'remove') return { available: true, ...(await removeAgentContainer(agent.id)) }
      return reply.code(400).send({ error: `unknown action '${action}' (start|stop|remove)` })
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `docker ${action} failed: ${(err as Error).message}` })
    }
  })
}
