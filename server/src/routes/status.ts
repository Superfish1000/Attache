import type { FastifyInstance } from 'fastify'
import { db } from '../store.js'
import { dockerAvailable, listManagedContainers } from '../docker.js'
import { o365Configured } from '../o365.js'
import { mcpStatus } from '../mcp.js'

export default async function statusRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }))

  app.get('/status', async () => ({
    docker: { available: await dockerAvailable() },
    o365: { configured: o365Configured(), lastSync: db.settings.lastO365Sync },
    mcp: { enabled: mcpStatus().enabled },
    counts: { users: db.users.length, agents: db.agents.length },
  }))

  app.get('/containers', async () => {
    if (!(await dockerAvailable())) return { available: false, containers: [] }
    return { available: true, containers: await listManagedContainers() }
  })
}
