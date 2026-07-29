import type { FastifyInstance } from 'fastify'
import { db, save } from '../store.js'
import { listGroupMembers, o365Configured, runFullSync, testConnection } from '../o365.js'
import { requireAdmin } from '../auth.js'

function maskedSettings() {
  const s = db.settings.o365
  return {
    tenantId: s.tenantId,
    clientId: s.clientId,
    groupId: s.groupId,
    hasSecret: Boolean(s.clientSecret),
    configured: o365Configured(),
    lastSync: db.settings.lastO365Sync,
    pollMinutes: s.pollMinutes,
    lastRuns: s.lastRuns,
  }
}

export default async function o365Routes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/settings', async () => maskedSettings())

  app.put('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenantId: string
      clientId: string
      clientSecret: string
      groupId: string
      pollMinutes: number
    }>
    const s = db.settings.o365
    if (body.tenantId !== undefined) s.tenantId = body.tenantId.trim()
    if (body.clientId !== undefined) s.clientId = body.clientId.trim()
    if (body.groupId !== undefined) s.groupId = body.groupId.trim()
    // empty secret in the payload means "keep the existing one"
    if (body.clientSecret) s.clientSecret = body.clientSecret
    if (body.pollMinutes !== undefined) {
      const m = Number(body.pollMinutes)
      if (!Number.isInteger(m) || m < 0 || m > 10080) {
        return reply.code(400).send({ error: 'pollMinutes must be 0 (off) to 10080 (weekly)' })
      }
      s.pollMinutes = m
    }
    save()
    return maskedSettings()
  })

  app.get('/preview', async (req, reply) => {
    try {
      const members = await listGroupMembers()
      return members.map((m) => ({
        id: m.id,
        name: m.displayName ?? m.userPrincipalName,
        email: m.mail ?? m.userPrincipalName,
      }))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.post('/sync', async (req, reply) => {
    try {
      return await runFullSync()
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /** Live check: token + group lookup + member count. */
  app.get('/test', async (req, reply) => {
    try {
      return await testConnection()
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })
}
