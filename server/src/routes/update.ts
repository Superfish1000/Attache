import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../auth.js'
import { applyUpdate, checkForUpdate, restartProcess } from '../self-update.js'

export default async function updateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/check', async (req, reply) => {
    const result = await checkForUpdate()
    if (!result.ok) return reply.code(result.httpStatus).send({ error: result.error })
    const { repo, currentShort, status, behindBy, latest, runningShort, restartNeeded } = result
    return { repo, currentShort, status, behindBy, latest, runningShort, restartNeeded }
  })

  /**
   * Asks the process to exit cleanly. Brought back by a supervisor
   * (systemd Restart=always, pm2, a docker restart policy) in production, or
   * by the dev watcher via the timestamp nudge below. Without either, the GUI
   * reports that it didn't come back.
   */
  app.post('/restart', async (req, reply) => {
    reply.send({ ok: true })
    setTimeout(async () => {
      try {
        await app.close()
      } catch {
        // close best-effort — restartProcess's own hard-exit backstop covers this
      }
      restartProcess(0)
    }, 300)
  })

  /** git pull --ff-only + npm install + rebuild web. Auto-restarts on success — see self-update.ts. */
  app.post('/apply', async (req, reply) => {
    const result = await applyUpdate()
    if (!result.ok) return reply.code(result.httpStatus).send({ error: result.error })
    const { updated, from, to, pull, installNote, buildNote, restarting, note } = result
    return { updated, from, to, pull, installNote, buildNote, restarting, note }
  })
}
