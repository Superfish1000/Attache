import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, save } from './store.js'
import type { Agent, ResetToken, Session, User } from './types.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

export const SESSION_COOKIE = 'attache_session'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`
}

/**
 * Hash in the format Hermes' dashboard basic-auth provider verifies
 * (`scrypt$N$r$p$<salt_b64>$<dk_b64>`) — lets Attache provision dashboard
 * logins without plaintext at rest anywhere.
 */
export function hermesHashPassword(password: string): string {
  const salt = randomBytes(16)
  const dk = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${dk.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  })
  return timingSafeEqual(expected, actual)
}

export function createSession(userId: string): Session {
  const now = Date.now()
  const ttlMs = db.settings.security.sessionTtlHours * 3600_000
  const session: Session = {
    token: randomBytes(32).toString('hex'),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }
  db.sessions.push(session)
  save()
  return session
}

export function getSessionUser(token: string): User | null {
  const now = Date.now()
  const before = db.sessions.length
  db.sessions = db.sessions.filter((s) => Date.parse(s.expiresAt) > now)
  if (db.sessions.length !== before) save()
  const session = db.sessions.find((s) => s.token === token)
  if (!session) return null
  return db.users.find((u) => u.id === session.userId) ?? null
}

export function destroySession(token: string): void {
  const before = db.sessions.length
  db.sessions = db.sessions.filter((s) => s.token !== token)
  if (db.sessions.length !== before) save()
}

export function destroyUserSessions(userId: string): void {
  db.sessions = db.sessions.filter((s) => s.userId !== userId)
  save()
}

/** True until an admin with a password exists — drives the first-run setup screen. */
export function needsSetup(): boolean {
  return !db.users.some((u) => u.role === 'admin' && u.passwordHash)
}

export function safeUser(user: User): Omit<User, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = user
  return { ...rest, hasPassword: Boolean(passwordHash) }
}

/** Sends 403 and returns false unless the request user is an admin. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== 'admin') {
    reply.code(403).send({ error: 'admin access required' })
    return false
  }
  return true
}

export function canAccessAgent(user: User, agent: Agent): boolean {
  return user.role === 'admin' || agent.userId === user.id
}

const RESET_TOKEN_TTL_MS = 48 * 3600_000

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex')

/** A token that can still be redeemed — same liveness rule the store uses to prune at boot. */
const isLiveToken = (t: ResetToken) => !t.usedAt && Date.parse(t.expiresAt) > Date.now()

/** Creates a single-use set-password token; returns the RAW token (only ever placed in the emailed link). */
export function createResetToken(userId: string): string {
  const raw = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.resetTokens.push({
    tokenHash: hashToken(raw),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RESET_TOKEN_TTL_MS).toISOString(),
  })
  save()
  return raw
}

/** Validates and burns a token. Returns the user or null — never says why it failed (no oracle). */
export function consumeResetToken(raw: string): User | null {
  db.resetTokens = db.resetTokens.filter(isLiveToken)
  const token = db.resetTokens.find((t) => t.tokenHash === hashToken(raw))
  if (!token) {
    save()
    return null
  }
  token.usedAt = new Date().toISOString()
  save()
  return db.users.find((u) => u.id === token.userId) ?? null
}
