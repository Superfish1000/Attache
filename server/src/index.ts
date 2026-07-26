import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import userRoutes from './routes/users.js'
import agentRoutes from './routes/agents.js'
import o365Routes from './routes/o365.js'
import mcpRoutes from './routes/mcp.js'
import statusRoutes from './routes/status.js'

const app = Fastify({ logger: true })

await app.register(userRoutes, { prefix: '/api/users' })
await app.register(agentRoutes, { prefix: '/api/agents' })
await app.register(o365Routes, { prefix: '/api/o365' })
await app.register(mcpRoutes, { prefix: '/api/mcp' })
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

// deliberately NOT process.env.PORT — preview/launch harnesses inject PORT for the web app
const port = Number(process.env.ATTACHE_API_PORT ?? 7701)
await app.listen({ port, host: '127.0.0.1' })
