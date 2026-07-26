import type { FastifyInstance } from 'fastify'
import { DATA_DIR, db, save } from '../store.js'
import { requireAdmin } from '../auth.js'

function view() {
  const { server, docker, security } = db.settings
  return { server, docker, security, dataDir: DATA_DIR }
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/', async () => view())

  app.put('/', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      server: Partial<{ host: string; port: number }>
      docker: Partial<{
        socketPath: string
        defaultImage: string
        defaultCommand: string[]
        autoPull: boolean
      }>
      security: Partial<{ sessionTtlHours: number }>
    }>
    const s = db.settings

    if (body.server) {
      if (body.server.host !== undefined) s.server.host = String(body.server.host).trim()
      if (body.server.port !== undefined) {
        const port = Number(body.server.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return reply.code(400).send({ error: 'port must be an integer between 1 and 65535' })
        }
        s.server.port = port
      }
    }
    if (body.docker) {
      if (body.docker.socketPath !== undefined) s.docker.socketPath = String(body.docker.socketPath).trim()
      if (body.docker.defaultImage !== undefined) {
        const img = String(body.docker.defaultImage).trim()
        if (!img) return reply.code(400).send({ error: 'defaultImage cannot be empty' })
        s.docker.defaultImage = img
      }
      if (body.docker.defaultCommand !== undefined) {
        if (
          !Array.isArray(body.docker.defaultCommand) ||
          body.docker.defaultCommand.some((c) => typeof c !== 'string')
        ) {
          return reply.code(400).send({ error: 'defaultCommand must be an array of strings' })
        }
        s.docker.defaultCommand = body.docker.defaultCommand
      }
      if (body.docker.autoPull !== undefined) s.docker.autoPull = Boolean(body.docker.autoPull)
    }
    if (body.security?.sessionTtlHours !== undefined) {
      const ttl = Number(body.security.sessionTtlHours)
      if (!Number.isFinite(ttl) || ttl < 1 || ttl > 24 * 365) {
        return reply.code(400).send({ error: 'sessionTtlHours must be between 1 and 8760' })
      }
      s.security.sessionTtlHours = ttl
    }

    save()
    return view()
  })
}
