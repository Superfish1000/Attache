import type { FastifyInstance } from 'fastify'
import { db, save } from '../store.js'
import { createUser, syncOwnerDashboards } from '../users.js'
import {
  SESSION_COOKIE,
  consumeResetToken,
  createSession,
  destroySession,
  destroyUserSessions,
  getSessionUser,
  hashPassword,
  hermesHashPassword,
  needsSetup,
  safeUser,
  verifyPassword,
} from '../auth.js'
import { sendSetPasswordEmail } from '../mailer.js'

function cookieOpts(maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: maxAgeSeconds }
}

// naive per-account limiter for the unauthenticated forgot endpoint.
// keyed by normalized email, not req.ip — behind the Vite proxy every
// request arrives as 127.0.0.1, which would make an IP bucket global.
const forgotHits = new Map<string, { count: number; resetAt: number }>()
function forgotAllowedFor(email: string): boolean {
  const now = Date.now()
  if (forgotHits.size > 1000) {
    for (const [k, v] of forgotHits) if (v.resetAt < now) forgotHits.delete(k)
    // still over cap (attacker-chosen keys within one window): drop oldest
    // entries. Limiting degrades only while actively under attack — memory
    // stays bounded.
    for (const k of forgotHits.keys()) {
      if (forgotHits.size <= 1000) break
      forgotHits.delete(k)
    }
  }
  const hit = forgotHits.get(email)
  if (!hit || hit.resetAt < now) {
    forgotHits.set(email, { count: 1, resetAt: now + 3600_000 })
    return true
  }
  hit.count++
  return hit.count <= 5
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const token = req.cookies[SESSION_COOKIE]
    const user = token ? getSessionUser(token) : null
    return { user: user ? safeUser(user) : null, needsSetup: needsSetup() }
  })

  /** First-run: create the initial admin account. Locked once any admin can log in. */
  app.post('/setup', async (req, reply) => {
    if (!needsSetup()) return reply.code(403).send({ error: 'setup already completed' })
    const { name, email, password } = (req.body ?? {}) as {
      name?: string
      email?: string
      password?: string
    }
    if (!name?.trim() || !email?.trim() || !password) {
      return reply.code(400).send({ error: 'name, email and password are required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    const existing = db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
    let user
    if (existing) {
      existing.role = 'admin'
      existing.passwordHash = hashPassword(password)
      existing.dashboardHash = hermesHashPassword(password)
      save()
      await syncOwnerDashboards(existing)
      user = existing
    } else {
      user = createUser({
        name: name.trim(),
        email: email.trim(),
        source: 'manual',
        role: 'admin',
        password,
      })
    }
    const session = createSession(user.id)
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(db.settings.security.sessionTtlHours * 3600))
    return { user: safeUser(user) }
  })

  app.post('/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string }
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' })
    const user = db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid email or password' })
    }
    if (user.disabled) {
      return reply.code(403).send({ error: 'account disabled — contact an administrator' })
    }
    // opportunistic backfill: accounts whose password predates dashboard
    // provisioning get their agents' dashboard logins on next sign-in
    if (!user.dashboardHash) {
      user.dashboardHash = hermesHashPassword(password)
      save()
      await syncOwnerDashboards(user)
    }
    const session = createSession(user.id)
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(db.settings.security.sessionTtlHours * 3600))
    return { user: safeUser(user) }
  })

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) destroySession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  /**
   * Unauthenticated. The body is identical for all outcomes (unknown email,
   * disabled account, rate-limited, send failure) and no SMTP round-trip or
   * token work happens in the response path.
   */
  app.post('/forgot', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown }
    if (typeof email !== 'string' || !email.trim() || email.trim().length > 254) {
      return reply.code(400).send({ error: 'email required' })
    }
    const generic = { ok: true }
    const key = email.trim().toLowerCase()
    if (!forgotAllowedFor(key)) {
      req.log.warn({ email: key }, 'forgot-password rate limited')
      return generic
    }
    const user = db.users.find((u) => u.email.toLowerCase() === key)
    if (!user || user.disabled) return generic
    setImmediate(() => {
      void sendSetPasswordEmail(user, 'reset').catch((err) =>
        req.log.warn({ err }, 'forgot-password email failed'),
      )
    })
    return generic
  })

  /** Unauthenticated. Burns the token, sets both password hashes, revokes sessions. */
  app.post('/reset', async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: unknown; password?: unknown }
    if (typeof token !== 'string' || typeof password !== 'string' || !token || !password) {
      return reply.code(400).send({ error: 'token and password required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    const user = consumeResetToken(token)
    if (!user) return reply.code(400).send({ error: 'invalid or expired link — request a new one' })
    user.passwordHash = hashPassword(password)
    user.dashboardHash = hermesHashPassword(password)
    save()
    destroyUserSessions(user.id)
    await syncOwnerDashboards(user)
    return { ok: true }
  })
}
