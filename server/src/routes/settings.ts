import type { FastifyInstance } from 'fastify'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DATA_DIR, db, runtimeStatus, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { sendMail, verifySmtp } from '../mailer.js'
import { ATTACHE_NETWORK, attacheNetworkExists } from '../docker.js'

/** Non-internal IPv4 addresses on this machine — shown in Settings purely to make the `mkcert <ip> ...` step easier to get right. Not stored, not actionable. */
function detectLocalIps(): string[] {
  const ips: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  return ips
}

async function view() {
  const { server, docker, security, email, selfUpdate, imageUpdates, mcpServer, tls } = db.settings
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
    selfUpdate,
    imageUpdates,
    mcpServer,
    tls,
    tlsStatus: runtimeStatus,
    detectedIps: detectLocalIps(),
    dataDir: DATA_DIR,
    // shared bridge network agent/tool containers use to reach each other by
    // alias — created on demand at first container start, not user-configurable
    network: { name: ATTACHE_NETWORK, exists: await attacheNetworkExists() },
  }
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/', async () => view())

  app.get('/tls/ca-cert', async (req, reply) => {
    const path = db.settings.tls.caCertPath
    if (!path) {
      return reply.code(400).send({ error: 'no CA certificate path configured — set it under Settings → HTTPS' })
    }
    try {
      const content = readFileSync(path)
      const text = content.toString('utf8')
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        return reply.code(400).send({
          error:
            "this file looks like a private key, not a certificate — check caCertPath points at the CA's public cert (e.g. rootCA.pem), not its key file",
        })
      }
      if (!text.includes('-----BEGIN CERTIFICATE-----')) {
        return reply.code(400).send({ error: "this file doesn't look like a PEM certificate" })
      }
      reply.header('Content-Disposition', 'attachment; filename="attache-ca.pem"')
      reply.header('Content-Type', 'application/x-pem-file')
      return reply.send(content)
    } catch (err) {
      return reply.code(500).send({ error: `couldn't read CA certificate file: ${(err as Error).message}` })
    }
  })

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
      selfUpdate: Partial<{ autoCheckHours: number; autoApply: boolean }>
      imageUpdates: Partial<{ autoCheckHours: number; autoMode: string }>
      mcpServer: Partial<{ enabled: boolean }>
      tls: Partial<{ enabled: boolean; port: number; certPath: string; keyPath: string; caCertPath: string }>
    }>
    const s = db.settings

    // Compute the effective resulting server.port and tls.port (request body where
    // provided, else the current saved value) and validate they'd differ BEFORE
    // assigning either field below — otherwise a request that changes one to collide
    // with the other could mutate db.settings.server.port in memory and then 400 on
    // the tls check, leaving a partially-applied, unsaved change live.
    let effectiveServerPort = s.server.port
    if (body.server?.port !== undefined) {
      const port = Number(body.server.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return reply.code(400).send({ error: 'port must be an integer between 1 and 65535' })
      }
      effectiveServerPort = port
    }
    let effectiveTlsPort = s.tls.port
    if (body.tls?.port !== undefined) {
      const p = Number(body.tls.port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return reply.code(400).send({ error: 'tls.port must be an integer between 1 and 65535' })
      }
      effectiveTlsPort = p
    }
    if (effectiveServerPort === effectiveTlsPort) {
      return reply.code(400).send({ error: 'tls.port must differ from the API port (Settings → Server)' })
    }

    if (body.server) {
      if (body.server.host !== undefined) s.server.host = String(body.server.host).trim()
      if (body.server.port !== undefined) s.server.port = effectiveServerPort
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
    if (body.selfUpdate) {
      if (body.selfUpdate.autoCheckHours !== undefined) {
        const h = Number(body.selfUpdate.autoCheckHours)
        if (!Number.isFinite(h) || h < 0 || h > 24 * 30) {
          return reply.code(400).send({ error: 'selfUpdate.autoCheckHours must be between 0 and 720 (0 disables)' })
        }
        s.selfUpdate.autoCheckHours = h
      }
      if (body.selfUpdate.autoApply !== undefined) s.selfUpdate.autoApply = Boolean(body.selfUpdate.autoApply)
    }
    if (body.imageUpdates) {
      if (body.imageUpdates.autoCheckHours !== undefined) {
        const h = Number(body.imageUpdates.autoCheckHours)
        if (!Number.isFinite(h) || h < 0 || h > 24 * 30) {
          return reply.code(400).send({ error: 'imageUpdates.autoCheckHours must be between 0 and 720 (0 disables)' })
        }
        s.imageUpdates.autoCheckHours = h
      }
      if (body.imageUpdates.autoMode !== undefined) {
        const mode = String(body.imageUpdates.autoMode)
        if (!['check', 'stage', 'update', 'update-regen'].includes(mode)) {
          return reply.code(400).send({ error: "imageUpdates.autoMode must be 'check', 'stage', 'update', or 'update-regen'" })
        }
        s.imageUpdates.autoMode = mode as typeof s.imageUpdates.autoMode
      }
    }
    if (body.mcpServer?.enabled !== undefined) {
      s.mcpServer.enabled = Boolean(body.mcpServer.enabled)
    }
    if (body.tls) {
      if (body.tls.enabled !== undefined) s.tls.enabled = Boolean(body.tls.enabled)
      if (body.tls.port !== undefined) s.tls.port = effectiveTlsPort
      if (body.tls.certPath !== undefined) s.tls.certPath = String(body.tls.certPath).trim()
      if (body.tls.keyPath !== undefined) s.tls.keyPath = String(body.tls.keyPath).trim()
      if (body.tls.caCertPath !== undefined) s.tls.caCertPath = String(body.tls.caCertPath).trim()
    }

    save()
    return view()
  })

  /** Bearer token itself is never settable via the generic PUT above — only via this dedicated action, so it can't be accidentally overwritten with an empty string. */
  app.post('/mcp-server/regenerate-token', async () => {
    db.settings.mcpServer.bearerToken = randomBytes(24).toString('hex')
    save()
    return { bearerToken: db.settings.mcpServer.bearerToken }
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
