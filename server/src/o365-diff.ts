import type { GraphMember } from './o365.js'
import type { User } from './types.js'

export interface MembershipDiff {
  toCreate: GraphMember[]
  toDisable: User[]
  toReenable: User[]
  skippedAdmins: User[]
}

/**
 * Pure membership diff — no store, no Graph, fully unit-testable.
 * Matching mirrors the sync: o365Id first, then case-insensitive email.
 * Only source==='o365' users are ever disabled; admins are never disabled
 * (lockout rail — they are reported in skippedAdmins instead).
 */
export function diffMembership(members: GraphMember[], users: User[]): MembershipDiff {
  const emailOf = (m: GraphMember) => (m.mail ?? m.userPrincipalName).toLowerCase()
  const memberIds = new Set(members.map((m) => m.id))
  const memberEmails = new Set(members.map(emailOf))

  const toCreate = members.filter(
    (m) =>
      !users.some((u) => u.o365Id === m.id) &&
      !users.some((u) => u.email.toLowerCase() === emailOf(m)),
  )

  const inGroup = (u: User) =>
    (u.o365Id !== undefined && memberIds.has(u.o365Id)) || memberEmails.has(u.email.toLowerCase())

  const gone = users.filter((u) => u.source === 'o365' && !u.disabled && !inGroup(u))
  return {
    toCreate,
    toDisable: gone.filter((u) => u.role !== 'admin'),
    skippedAdmins: gone.filter((u) => u.role === 'admin'),
    toReenable: users.filter((u) => u.source === 'o365' && u.disabled === true && inGroup(u)),
  }
}
