import Fastify from 'fastify'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, runtimeStatus } from './store.js'
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
import mcpToolInstanceRoutes from './routes/mcp-tool-instances.js'
import updateRoutes from './routes/update.js'
import mcpServerRoutes from './routes/mcp-server.js'
import mcpOAuthRoutes from './routes/mcp-oauth-routes.js'

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))

/**
 * Builds one fully-routed Fastify instance. Called once for the always-on
 * HTTP listener and, when configured, a second time for the HTTPS listener —
 * both transports get identical routes from this one registration path.
 */
async function buildApp(opts: FastifyServerOptions & { https?: any } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, ...opts } as FastifyServerOptions & { https?: any })

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
  await app.register(mcpToolInstanceRoutes, { prefix: '/api/mcp-tool-instances' })
  await app.register(updateRoutes, { prefix: '/api/update' })
  await app.register(statusRoutes, { prefix: '/api' })
  await app.register(mcpServerRoutes) // no prefix — mounts /mcp directly
  await app.register(mcpOAuthRoutes) // no prefix — mounts /register, /authorize, /token, etc. directly

  // serve the built GUI when it exists (production); dev uses the Vite server
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  }

  return app
}

// deliberately NOT process.env.PORT — preview/launch harnesses inject PORT for the web app.
// env override > saved settings; host/port settings changes need a server restart.
const port = Number(process.env.ATTACHE_API_PORT ?? db.settings.server.port)
const host = process.env.ATTACHE_API_HOST ?? db.settings.server.host

const httpApp = await buildApp()
await httpApp.listen({ port, host })

// second, additional listener for clients that require a trusted HTTPS
// connection (e.g. Claude Desktop's remote-MCP connector) — the HTTP
// listener above is completely unaffected either way. A bad cert/key path
// or a port collision must not take down the app: catch, log, record it.
if (db.settings.tls.enabled && db.settings.tls.certPath && db.settings.tls.keyPath) {
  let httpsApp: FastifyInstance | undefined
  try {
    httpsApp = await buildApp({
      https: {
        key: readFileSync(db.settings.tls.keyPath),
        cert: readFileSync(db.settings.tls.certPath),
      },
    })
    await httpsApp.listen({ port: db.settings.tls.port, host })
    runtimeStatus.tlsRunning = true
  } catch (err) {
    if (httpsApp) {
      try {
        await httpsApp.close()
      } catch {
        // best-effort — don't let a close failure mask the original error logged below
      }
    }
    runtimeStatus.tlsError = (err as Error).message
    httpApp.log.error(err, 'failed to start HTTPS listener — continuing on HTTP only')
  }
}

// containers that were already running before this server started never see a
// start event — schedule the host-access group fix for them too (Linux only;
// harmless no-op for stopped containers)
for (const agent of db.agents) scheduleMountGroupFix(agent)
void retrofitAgentsOntoNetwork(db.agents.map((a) => a.id))

startScheduler()
