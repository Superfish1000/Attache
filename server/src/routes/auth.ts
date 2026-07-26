import type { FastifyInstance } from 'fastify'
import { db } from '../store.js'
import { createUser } from '../users.js'
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSessionUser,
  hashPassword,
  needsSetup,
  safeUser,
  verifyPassword,
} from '../auth.js'

function cookieOpts(maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: maxAgeSeconds }
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
}
