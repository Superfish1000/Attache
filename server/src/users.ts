import { db, newId, save } from './store.js'
import type { Role, User } from './types.js'
import { deleteAgent, writeDashboardCreds } from './agents.js'
import { bounceDashboard, removeAgentContainer } from './docker.js'
import { destroyUserSessions, hashPassword, hermesHashPassword } from './auth.js'

/**
 * Re-provisions dashboard logins on every agent the user owns and bounces
 * running dashboards so the change applies immediately. Docker parts are
 * best-effort — call after updating user.dashboardHash.
 */
export function syncOwnerDashboards(user: User): void {
  for (const agent of db.agents.filter((a) => a.userId === user.id)) {
    writeDashboardCreds(agent, user)
    void bounceDashboard(agent.id)
  }
}

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
    ...(input.password
      ? {
          passwordHash: hashPassword(input.password),
          dashboardHash: hermesHashPassword(input.password),
        }
      : {}),
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
