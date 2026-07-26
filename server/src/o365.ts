import { db, save } from './store.js'
import { createAgent } from './agents.js'
import { createUser } from './users.js'

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

export interface SyncResult {
  total: number
  created: number
  skipped: number
}

/** Pulls group members and auto-creates a user + default agent for each new one. */
export async function syncGroup(): Promise<SyncResult> {
  const members = await listGroupMembers()
  let created = 0
  let skipped = 0
  for (const m of members) {
    const email = m.mail ?? m.userPrincipalName
    const existing =
      db.users.find((u) => u.o365Id === m.id) ??
      db.users.find((u) => u.email.toLowerCase() === email.toLowerCase())
    if (existing) {
      if (!existing.o365Id) existing.o365Id = m.id
      skipped++
      continue
    }
    const user = createUser({ name: m.displayName ?? email, email, source: 'o365', o365Id: m.id })
    createAgent(user.id)
    created++
  }
  db.settings.lastO365Sync = new Date().toISOString()
  save()
  return { total: members.length, created, skipped }
}
