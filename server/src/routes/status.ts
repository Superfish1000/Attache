import type { FastifyInstance } from 'fastify'
import { db } from '../store.js'
import { dockerAvailable, listManagedContainers } from '../docker.js'
import { o365Configured } from '../o365.js'
import { mcpStatus } from '../mcp.js'

export default async function statusRoutes(app: FastifyInstance) {
  app.get('/status', async (req) => {
    const admin = req.user!.role === 'admin'
    const myAgents = admin ? db.agents : db.agents.filter((a) => a.userId === req.user!.id)
    return {
      docker: { available: await dockerAvailable() },
      o365: { configured: o365Configured(), lastSync: db.settings.lastO365Sync },
      mcp: { enabled: mcpStatus().enabled },
      counts: {
        users: admin ? db.users.length : 1,
        agents: myAgents.length,
        mcpToolInstances: db.mcpToolInstances.length,
      },
    }
  })

  app.get('/containers', async (req) => {
    if (!(await dockerAvailable())) return { available: false, containers: [] }
    let containers = await listManagedContainers()
    if (req.user!.role !== 'admin') {
      const mine = new Set(db.agents.filter((a) => a.userId === req.user!.id).map((a) => a.id))
      containers = containers.filter((c) => c.agentId && mine.has(c.agentId))
    }
    return { available: true, containers }
  })
}
