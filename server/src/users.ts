import { db, newId, save } from './store.js'
import type { Role, User } from './types.js'
import { deleteAgent } from './agents.js'
import { removeAgentContainer } from './docker.js'
import { destroyUserSessions, hashPassword } from './auth.js'

export function createUser(input: {
  name: string
  email: string
  source: User['source']
  role?: Role
  password?: string
  o365Id?: string
}): User {
  const user: User = {
    id: newId(),
    name: input.name,
    email: input.email,
    role: input.role ?? 'standard',
    source: input.source,
    ...(input.o365Id ? { o365Id: input.o365Id } : {}),
    ...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
    createdAt: new Date().toISOString(),
  }
  db.users.push(user)
  save()
  return user
}

/** Deletes the user and cascades to their agents (containers removed best-effort) and sessions. */
export async function deleteUser(id: string): Promise<void> {
  const agents = db.agents.filter((a) => a.userId === id)
  for (const agent of agents) {
    try {
      await removeAgentContainer(agent.id)
    } catch {
      // docker unavailable — agent record still goes away
    }
    deleteAgent(agent.id)
  }
  destroyUserSessions(id)
  db.users = db.users.filter((u) => u.id !== id)
  save()
}
