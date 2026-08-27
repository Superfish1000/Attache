import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { db, newId, save } from './store.js'
import type { McpOAuthClient } from './types.js'

const AUTH_CODE_TTL_MS = 5 * 60_000
const ACCESS_TOKEN_TTL_MS = 60 * 60_000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000
const CIMD_FETCH_TIMEOUT_MS = 5_000
const CIMD_MAX_BYTES = 64 * 1024
const CIMD_CACHE_TTL_MS = 10 * 60_000

const b64url = (buf: Buffer) => buf.toString('base64url')

/** The MCP resource URI OAuth tokens are scoped to. null if publicBaseUrl isn't set — OAuth can't function without it. */
export function canonicalResource(): string | null {
  const base = db.settings.server.publicBaseUrl.trim()
  return base ? `${base.replace(/\/+$/, '')}/mcp` : null
}

export function generateCodeChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest())
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  try {
    return generateCodeChallenge(verifier) === challenge
  } catch {
    return false
  }
}

/**
 * SSRF guard for CIMD client_id URLs (client-supplied, so untrusted):
 * HTTPS only, and rejects hostnames that are IP literals in loopback/
 * private/link-local ranges. Does NOT resolve DNS to check where a hostname
 * actually points (a determined attacker could still DNS-rebind a public
 * hostname to a private IP) — accepted as a known limitation; this blocks
 * the common/accidental cases.
 */
export function isSafeCimdUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1') return false
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 127) return false // loopback
    if (a === 10) return false // private
    if (a === 172 && b >= 16 && b <= 31) return false // private
    if (a === 192 && b === 168) return false // private
    if (a === 169 && b === 254) return false // link-local
    if (a === 0) return false
  }
  return true
}

interface CimdEntry {
  name: string
  redirectUris: string[]
  applicationType: 'web' | 'native'
  cachedAt: number
}
const cimdCache = new Map<string, CimdEntry>()

/** Fetches and caches a Client ID Metadata Document. Returns null on any failure (unsafe URL, network error, bad shape, too large). */
export async function fetchCimdClient(
  clientIdUrl: string,
): Promise<{ name: string; redirectUris: string[]; applicationType: 'web' | 'native' } | null> {
  const cached = cimdCache.get(clientIdUrl)
  if (cached && Date.now() - cached.cachedAt < CIMD_CACHE_TTL_MS) return cached
  if (!isSafeCimdUrl(clientIdUrl)) return null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CIMD_FETCH_TIMEOUT_MS)
    const res = await fetch(clientIdUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > CIMD_MAX_BYTES) return null
    const body = JSON.parse(text) as {
      client_name?: string
      redirect_uris?: string[]
      application_type?: string
    }
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return null
    const entry: CimdEntry = {
      name: body.client_name || clientIdUrl,
      redirectUris: body.redirect_uris,
      applicationType: body.application_type === 'native' ? 'native' : 'web',
      cachedAt: Date.now(),
    }
    cimdCache.set(clientIdUrl, entry)
    return entry
  } catch {
    return null
  }
}

/** RFC 7591 Dynamic Client Registration. */
export function registerDcrClient(body: {
  client_name?: string
  redirect_uris?: unknown
  application_type?: string
}): McpOAuthClient | { error: string } {
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.some((u) => typeof u !== 'string')) {
    return { error: 'redirect_uris must be a non-empty array of strings' }
  }
  if (body.redirect_uris.length === 0) return { error: 'redirect_uris must not be empty' }
  const client: McpOAuthClient = {
    id: newId(),
    clientId: randomUUID(),
    name: body.client_name?.trim() || 'Unnamed MCP client',
    redirectUris: body.redirect_uris as string[],
    applicationType: body.application_type === 'native' ? 'native' : 'web',
    createdAt: new Date().toISOString(),
  }
  db.mcpOAuthClients.push(client)
  save()
  return client
}

/** A CIMD client_id is itself an https URL; a DCR client_id is an opaque UUID minted by registerDcrClient. */
export async function resolveClient(
  clientId: string,
): Promise<{ kind: 'dcr'; client: McpOAuthClient } | { kind: 'cimd'; name: string; redirectUris: string[] } | null> {
  if (clientId.startsWith('https://')) {
    const cimd = await fetchCimdClient(clientId)
    return cimd ? { kind: 'cimd', name: cimd.name, redirectUris: cimd.redirectUris } : null
  }
  const client = db.mcpOAuthClients.find((c) => c.clientId === clientId)
  return client ? { kind: 'dcr', client } : null
}

export function issueAuthCode(params: {
  clientId: string
  clientRef: string
  redirectUri: string
  codeChallenge: string
  resource: string
}): string {
  const code = b64url(randomBytes(32))
  db.mcpOAuthCodes.push({
    code,
    clientId: params.clientId,
    clientRef: params.clientRef,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: 'S256',
    resource: params.resource,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  })
  save()
  return code
}

function mintTokenPair(clientId: string, resource: string) {
  const accessToken = b64url(randomBytes(32))
  const refreshToken = b64url(randomBytes(32))
  const now = Date.now()
  db.mcpOAuthTokens.push({
    token: accessToken,
    type: 'access',
    clientId,
    resource,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
    pairedToken: refreshToken,
  })
  db.mcpOAuthTokens.push({
    token: refreshToken,
    type: 'refresh',
    clientId,
    resource,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
    pairedToken: accessToken,
  })
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) }
}

export function exchangeAuthCode(params: {
  code: string
  clientId: string
  codeVerifier: string
  resource: string
}): { accessToken: string; refreshToken: string; expiresIn: number } | { error: string } {
  const entry = db.mcpOAuthCodes.find((c) => c.code === params.code)
  if (!entry) return { error: 'invalid or unknown code' }
  if (entry.usedAt) return { error: 'code already used' }
  if (Date.parse(entry.expiresAt) < Date.now()) return { error: 'code expired' }
  if (entry.clientRef !== params.clientId) return { error: 'client_id does not match the code' }
  if (entry.resource !== params.resource) return { error: 'resource does not match the code' }
  if (!verifyPkce(params.codeVerifier, entry.codeChallenge)) return { error: 'PKCE verification failed' }
  entry.usedAt = new Date().toISOString()
  const minted = mintTokenPair(entry.clientId, entry.resource)
  save()
  return minted
}

export function refreshAccessToken(params: {
  refreshToken: string
  resource: string
}): { accessToken: string; expiresIn: number } | { error: string } {
  const entry = db.mcpOAuthTokens.find((t) => t.token === params.refreshToken && t.type === 'refresh')
  if (!entry) return { error: 'invalid refresh token' }
  if (Date.parse(entry.expiresAt) < Date.now()) return { error: 'refresh token expired' }
  if (entry.resource !== params.resource) return { error: 'resource does not match the token' }
  const accessToken = b64url(randomBytes(32))
  const now = Date.now()
  db.mcpOAuthTokens.push({
    token: accessToken,
    type: 'access',
    clientId: entry.clientId,
    resource: entry.resource,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
    pairedToken: entry.token,
  })
  save()
  return { accessToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) }
}

export function validateAccessToken(token: string, resource: string): boolean {
  const entry = db.mcpOAuthTokens.find((t) => t.token === token && t.type === 'access')
  if (!entry) return false
  if (Date.parse(entry.expiresAt) < Date.now()) return false
  return entry.resource === resource
}

export function revokeToken(token: string): void {
  const entry = db.mcpOAuthTokens.find((t) => t.token === token)
  if (!entry) return
  db.mcpOAuthTokens = db.mcpOAuthTokens.filter((t) => t.token !== token && t.token !== entry.pairedToken)
  save()
}
