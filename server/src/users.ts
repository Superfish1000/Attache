import { db, newId, save } from './store.js'
import type { User } from './types.js'
import { deleteAgent } from './agents.js'
import { removeAgentContainer } from './docker.js'

export function createUser(input: {
  name: string
  email: string
  source: User['source']
  o365Id?: string
}): User {
  const user: User = {
    id: newId(),
    name: input.name,
    email: input.email,
    source: input.source,
    ...(input.o365Id ? { o365Id: input.o365Id } : {}),
    createdAt: new Date().toISOString(),
  }
  db.users.push(user)
  save()
  return user
}

/** Deletes the user and cascades to their agents (containers removed best-effort). */
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
  db.users = db.users.filter((u) => u.id !== id)
  save()
}
