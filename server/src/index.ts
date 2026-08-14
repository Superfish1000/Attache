import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db } from './store.js'
import { scheduleMountGroupFix, retrofitAgentsOntoNetwork } from './docker.js'
import { startScheduler } from './scheduler.js'
import { SESSION_COOKIE, getSessionUser } from './auth.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import agentRoutes from './routes/agents.js'
import o365Routes from './routes/o365.js'
import mcpRoutes from './routes/mcp.js'
import statusRoutes from './routes/status.js'
import settingsRoutes from './routes/settings.js'
import containerDefRoutes from './routes/container-defs.js'
import mcpToolRoutes from './routes/mcp-tools.js'
import updateRoutes from './routes/update.js'

const app = Fastify({ logger: true })

await app.register(fastifyCookie)

// everything under /api requires a session except health + auth endpoints
app.addHook('onRequest', async (req, reply) => {
  const url = req.url
  if (!url.startsWith('/api/')) return
  if (url === '/api/health' || url.startsWith('/api/auth/')) return
  const token = req.cookies[SESSION_COOKIE]
  const user = token ? getSessionUser(token) : null
  if (!user || user.disabled) return reply.code(401).send({ error: 'unauthorized' })
  req.user = user
})

app.get('/api/health', async () => ({ ok: true }))

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(userRoutes, { prefix: '/api/users' })
await app.register(agentRoutes, { prefix: '/api/agents' })
await app.register(o365Routes, { prefix: '/api/o365' })
await app.register(mcpRoutes, { prefix: '/api/mcp' })
await app.register(settingsRoutes, { prefix: '/api/settings' })
await app.register(containerDefRoutes, { prefix: '/api/container-defs' })
await app.register(mcpToolRoutes, { prefix: '/api/mcp-tools' })
await app.register(updateRoutes, { prefix: '/api/update' })
await app.register(statusRoutes, { prefix: '/api' })

// serve the built GUI when it exists (production); dev uses the Vite server
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
    return reply.sendFile('index.html')
  })
}

// deliberately NOT process.env.PORT — preview/launch harnesses inject PORT for the web app.
// env override > saved settings; host/port settings changes need a server restart.
const port = Number(process.env.ATTACHE_API_PORT ?? db.settings.server.port)
const host = process.env.ATTACHE_API_HOST ?? db.settings.server.host
await app.listen({ port, host })

// containers that were already running before this server started never see a
// start event — schedule the host-access group fix for them too (Linux only;
// harmless no-op for stopped containers)
for (const agent of db.agents) scheduleMountGroupFix(agent)
void retrofitAgentsOntoNetwork(db.agents.map((a) => a.id))

startScheduler()
