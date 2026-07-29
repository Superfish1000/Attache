import { db, save } from './store.js'
import { createAgent } from './agents.js'
import { createUser, setUserDisabled } from './users.js'
import { diffMembership } from './o365-diff.js'
import { emailConfigured, sendSetPasswordEmail } from './mailer.js'
import type { SyncRun } from './types.js'

export function o365Configured(): boolean {
  const s = db.settings.o365
  return Boolean(s.tenantId && s.clientId && s.clientSecret && s.groupId)
}

export interface GraphMember {
  id: string
  displayName: string | null
  mail: string | null
  userPrincipalName: string
}

async function getToken(): Promise<string> {
  const s = db.settings.o365
  const res = await fetch(`https://login.microsoftonline.com/${s.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) {
    throw new Error(`O365 token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const body = (await res.json()) as { access_token: string }
  return body.access_token
}

export async function listGroupMembers(): Promise<GraphMember[]> {
  if (!o365Configured()) throw new Error('O365 is not configured (Integrations page)')
  const token = await getToken()
  const members: GraphMember[] = []
  let url = `https://graph.microsoft.com/v1.0/groups/${db.settings.o365.groupId}/members?$select=id,displayName,mail,userPrincipalName&$top=999`
  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      throw new Error(`Graph request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    const page = (await res.json()) as {
      value?: Array<GraphMember & { '@odata.type'?: string }>
      '@odata.nextLink'?: string
    }
    for (const m of page.value ?? []) {
      // group members can also be devices/nested groups — users only
      if (m['@odata.type'] === '#microsoft.graph.user' || (!m['@odata.type'] && m.userPrincipalName)) {
        members.push(m)
      }
    }
    url = page['@odata.nextLink'] ?? ''
  }
  return members
}

export async function testConnection(): Promise<{ groupName: string; memberCount: number }> {
  if (!o365Configured()) throw new Error('O365 is not configured')
  const token = await getToken()
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/groups/${db.settings.o365.groupId}?$select=displayName`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    throw new Error(`Graph group lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const group = (await res.json()) as { displayName?: string }
  return { groupName: group.displayName ?? '(unnamed group)', memberCount: (await listGroupMembers()).length }
}

let syncRunning = false

/**
 * Full membership sync: create + welcome-email new members, disable vanished
 * o365 users (never admins), re-enable returned ones. Records itself into
 * settings.o365.lastRuns (ring of 10). Throws only when a run is already in
 * flight — every other failure is captured in the run record.
 */
export async function runFullSync(): Promise<SyncRun> {
  if (syncRunning) throw new Error('a sync is already running')
  syncRunning = true
  const run: SyncRun = {
    at: new Date().toISOString(),
    total: 0,
    created: 0,
    disabled: 0,
    reenabled: 0,
    skippedAdmins: 0,
    emailFailures: 0,
  }
  try {
    const members = await listGroupMembers()
    run.total = members.length
    // backfill o365Id on email-matched users (mirrors the old sync's behavior)
    for (const m of members) {
      const email = (m.mail ?? m.userPrincipalName).toLowerCase()
      const existing =
        db.users.find((u) => u.o365Id === m.id) ??
        db.users.find((u) => u.email.toLowerCase() === email)
      if (existing && !existing.o365Id) existing.o365Id = m.id
    }
    const diff = diffMembership(members, db.users)
    for (const m of diff.toCreate) {
      const email = m.mail ?? m.userPrincipalName
      try {
        const user = createUser({ name: m.displayName ?? email, email, source: 'o365', o365Id: m.id })
        if (db.settings.o365.createAgents) createAgent(user.id)
        run.created++
        if (db.settings.o365.sendWelcomeEmails) {
          if (emailConfigured()) {
            try {
              await sendSetPasswordEmail(user, 'welcome')
            } catch {
              run.emailFailures++
            }
          } else {
            run.emailFailures++
          }
        }
      } catch (err) {
        run.error = ((run.error ? run.error + '; ' : '') + `create ${email}: ${(err as Error).message}`).slice(0, 300)
      }
    }
    for (const u of diff.toDisable) {
      await setUserDisabled(u, true)
      run.disabled++
    }
    for (const u of diff.toReenable) {
      await setUserDisabled(u, false)
      run.reenabled++
    }
    run.skippedAdmins = diff.skippedAdmins.length
    db.settings.lastO365Sync = run.at
  } catch (err) {
    run.error = (err as Error).message.slice(0, 300)
  } finally {
    db.settings.o365.lastRuns = [run, ...db.settings.o365.lastRuns].slice(0, 10)
    save()
    syncRunning = false
  }
  return run
}
