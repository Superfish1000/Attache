import type { FastifyInstance } from 'fastify'
import { db } from '../store.js'
import { createUser, deleteUser } from '../users.js'

export default async function userRoutes(app: FastifyInstance) {
  app.get('/', async () => db.users)

  app.post('/', async (req, reply) => {
    const { name, email } = (req.body ?? {}) as { name?: string; email?: string }
    if (!name?.trim() || !email?.trim()) {
      return reply.code(400).send({ error: 'name and email are required' })
    }
    if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
      return reply.code(409).send({ error: 'a user with that email already exists' })
    }
    return reply.code(201).send(createUser({ name: name.trim(), email: email.trim(), source: 'manual' }))
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.users.some((u) => u.id === id)) return reply.code(404).send({ error: 'user not found' })
    await deleteUser(id)
    return reply.code(204).send()
  })
}
