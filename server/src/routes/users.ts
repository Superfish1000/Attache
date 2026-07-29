import type { FastifyInstance } from 'fastify'
import { db, save } from '../store.js'
import { createUser, deleteUser, setUserDisabled, syncOwnerDashboards } from '../users.js'
import { hashPassword, hermesHashPassword, requireAdmin, safeUser } from '../auth.js'
import { sendSetPasswordEmail } from '../mailer.js'
import type { Role } from '../types.js'

const isRole = (r: unknown): r is Role => r === 'admin' || r === 'standard'

const lastAdmin = (id: string) => {
  const enabled = db.users.filter((u) => u.role === 'admin' && !u.disabled)
  return enabled.length === 1 && enabled[0].id === id
}

export default async function userRoutes(app: FastifyInstance) {
  // list is open to any session (standard users see only themselves — needed for owner
  // names in the GUI); everything else below is admin-only
  app.get('/', async (req) =>
    req.user!.role === 'admin'
      ? db.users.map(safeUser)
      : db.users.filter((u) => u.id === req.user!.id).map(safeUser),
  )

  app.post('/', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { name, email, role, password } = (req.body ?? {}) as {
      name?: string
      email?: string
      role?: string
      password?: string
    }
    if (!name?.trim() || !email?.trim()) {
      return reply.code(400).send({ error: 'name and email are required' })
    }
    if (role !== undefined && !isRole(role)) {
      return reply.code(400).send({ error: "role must be 'admin' or 'standard'" })
    }
    if (password !== undefined && password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
      return reply.code(409).send({ error: 'a user with that email already exists' })
    }
    const user = createUser({
      name: name.trim(),
      email: email.trim(),
      source: 'manual',
      role: role as Role | undefined,
      password,
    })
    return reply.code(201).send(safeUser(user))
  })

  app.patch('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const user = db.users.find((u) => u.id === (req.params as { id: string }).id)
    if (!user) return reply.code(404).send({ error: 'user not found' })
    const { name, email, role, disabled } = (req.body ?? {}) as {
      name?: string
      email?: string
      role?: string
      disabled?: boolean
    }
    // validate everything before mutating — a 400 below must leave the user untouched
    if (role !== undefined) {
      if (!isRole(role)) return reply.code(400).send({ error: "role must be 'admin' or 'standard'" })
      if (role !== 'admin' && lastAdmin(user.id)) {
        return reply.code(400).send({ error: 'cannot demote the last admin' })
      }
    }
    if (disabled !== undefined) {
      if (typeof disabled !== 'boolean') {
        return reply.code(400).send({ error: 'disabled must be a boolean' })
      }
      if (disabled && req.user?.id === user.id) {
        return reply.code(400).send({ error: 'cannot disable your own account' })
      }
      if (disabled && lastAdmin(user.id)) {
        return reply.code(400).send({ error: 'cannot disable the last admin' })
      }
    }
    if (role !== undefined) user.role = role as Role
    if (name?.trim()) user.name = name.trim()
    if (email?.trim()) user.email = email.trim()
    save()
    if (disabled !== undefined) await setUserDisabled(user, disabled)
    return safeUser(user)
  })

  app.put('/:id/password', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const user = db.users.find((u) => u.id === (req.params as { id: string }).id)
    if (!user) return reply.code(404).send({ error: 'user not found' })
    const { password } = (req.body ?? {}) as { password?: string }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    user.passwordHash = hashPassword(password)
    user.dashboardHash = hermesHashPassword(password)
    save()
    await syncOwnerDashboards(user)
    return safeUser(user)
  })

  /** Emails a set-password link — onboarding for password-less users, reset otherwise. */
  app.post('/:id/send-reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const user = db.users.find((u) => u.id === (req.params as { id: string }).id)
    if (!user) return reply.code(404).send({ error: 'user not found' })
    if (user.disabled) return reply.code(400).send({ error: 'account is disabled — enable it first' })
    try {
      await sendSetPasswordEmail(user, user.passwordHash ? 'reset' : 'welcome')
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { id } = req.params as { id: string }
    if (!db.users.some((u) => u.id === id)) return reply.code(404).send({ error: 'user not found' })
    if (req.user?.id === id) return reply.code(400).send({ error: 'cannot delete your own account' })
    if (lastAdmin(id)) return reply.code(400).send({ error: 'cannot delete the last admin' })
    await deleteUser(id)
    return reply.code(204).send()
  })
}
