import { db, newId, save } from './store.js'
import type { Role, User } from './types.js'
import { deleteAgent } from './agents.js'
import {
  bounceDashboard,
  removeAgentContainer,
  startAgentContainer,
  stopAgentContainer,
  writeDashboardCredsSafe,
} from './docker.js'
import { destroyUserSessions, hashPassword, hermesHashPassword } from './auth.js'

/**
 * Re-provisions dashboard logins on every agent the user owns and bounces
 * running dashboards so the change applies immediately. Best-effort — a
 * container-owned .env is written through docker; failures never block the
 * password change itself. Call after updating user.dashboardHash.
 */
export async function syncOwnerDashboards(user: User): Promise<void> {
  for (const agent of db.agents.filter((a) => a.userId === user.id)) {
    if (await writeDashboardCredsSafe(agent, user)) void bounceDashboard(agent.id)
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

/** Disables or re-enables sign-in; stops/starts the user's agent containers best-effort. */
export async function setUserDisabled(user: User, disabled: boolean): Promise<void> {
  user.disabled = disabled
  save()
  if (disabled) destroyUserSessions(user.id)
  for (const agent of db.agents.filter((a) => a.userId === user.id)) {
    try {
      if (disabled) await stopAgentContainer(agent.id)
      else await startAgentContainer(agent)
    } catch {
      // docker unavailable — the flag change still applies
    }
  }
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
