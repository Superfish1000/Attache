import type { FastifyInstance } from 'fastify'
import { DATA_DIR, db, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { sendMail, verifySmtp } from '../mailer.js'

function view() {
  const { server, docker, security, email } = db.settings
  return {
    server,
    docker,
    security,
    email: {
      host: email.host,
      port: email.port,
      secure: email.secure,
      user: email.user,
      from: email.from,
      hasPass: Boolean(email.pass),
    },
    dataDir: DATA_DIR,
  }
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/', async () => view())

  app.put('/', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      server: Partial<{ host: string; port: number; publicBaseUrl: string }>
      docker: Partial<{
        socketPath: string
        autoPull: boolean
        portRangeStart: number
        defaultEnv: Record<string, string>
        restartPolicy: string
        securityOpt: string[]
      }>
      security: Partial<{ sessionTtlHours: number }>
      email: Partial<{ host: string; port: number; secure: boolean; user: string; pass: string; from: string }>
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
      if (body.server.publicBaseUrl !== undefined) {
        s.server.publicBaseUrl = String(body.server.publicBaseUrl).trim().replace(/\/+$/, '')
      }
    }
    if (body.docker) {
      if (body.docker.socketPath !== undefined) s.docker.socketPath = String(body.docker.socketPath).trim()
      if (body.docker.autoPull !== undefined) s.docker.autoPull = Boolean(body.docker.autoPull)
      if (body.docker.portRangeStart !== undefined) {
        const p = Number(body.docker.portRangeStart)
        if (!Number.isInteger(p) || p < 1024 || p > 65000) {
          return reply.code(400).send({ error: 'portRangeStart must be between 1024 and 65000' })
        }
        s.docker.portRangeStart = p
      }
      if (body.docker.defaultEnv !== undefined) {
        const e = body.docker.defaultEnv
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          return reply.code(400).send({ error: 'defaultEnv must be an object of string values' })
        }
        s.docker.defaultEnv = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)]))
      }
      if (body.docker.securityOpt !== undefined) {
        if (
          !Array.isArray(body.docker.securityOpt) ||
          body.docker.securityOpt.some((o) => typeof o !== 'string')
        ) {
          return reply.code(400).send({ error: 'securityOpt must be an array of strings' })
        }
        s.docker.securityOpt = body.docker.securityOpt.map((o) => o.trim()).filter(Boolean)
      }
      if (body.docker.restartPolicy !== undefined) {
        const rp = String(body.docker.restartPolicy)
        if (!['no', 'unless-stopped', 'on-failure', 'always'].includes(rp)) {
          return reply.code(400).send({ error: 'restartPolicy must be no|unless-stopped|on-failure|always' })
        }
        s.docker.restartPolicy = rp as typeof s.docker.restartPolicy
      }
    }
    if (body.security?.sessionTtlHours !== undefined) {
      const ttl = Number(body.security.sessionTtlHours)
      if (!Number.isFinite(ttl) || ttl < 1 || ttl > 24 * 365) {
        return reply.code(400).send({ error: 'sessionTtlHours must be between 1 and 8760' })
      }
      s.security.sessionTtlHours = ttl
    }
    if (body.email) {
      const e = s.email
      if (body.email.host !== undefined) e.host = String(body.email.host).trim()
      if (body.email.port !== undefined) {
        const p = Number(body.email.port)
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          return reply.code(400).send({ error: 'email port must be 1-65535' })
        }
        e.port = p
      }
      if (body.email.secure !== undefined) e.secure = Boolean(body.email.secure)
      if (body.email.user !== undefined) e.user = String(body.email.user).trim()
      // empty password in the payload means "keep the existing one" (same as the O365 secret)
      if (body.email.pass) e.pass = String(body.email.pass)
      if (body.email.from !== undefined) e.from = String(body.email.from).trim()
    }

    save()
    return view()
  })

  /** Sends a test email to the signed-in admin — the operational smoke test. */
  app.post('/email/test', async (req, reply) => {
    try {
      await verifySmtp()
      await sendMail(
        req.user!.email,
        'Attaché test email',
        'SMTP is configured correctly — this is the Attaché test email.',
      )
      return { ok: true, to: req.user!.email }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })
}
