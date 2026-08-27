import type { FastifyInstance } from 'fastify'
import fastifyFormbody from '@fastify/formbody'
import { db, save } from '../store.js'
import { SESSION_COOKIE, getSessionUser, requireAdmin } from '../auth.js'
import {
  canonicalResource,
  exchangeAuthCode,
  issueAuthCode,
  refreshAccessToken,
  registerDcrClient,
  resolveClient,
  revokeToken,
} from '../mcp-oauth.js'

/** These routes aren't under /api/, so the global session onRequest hook (index.ts) doesn't run for them — resolve the session the same way it does. */
function sessionUser(req: { cookies: Record<string, string | undefined> }) {
  const token = req.cookies[SESSION_COOKIE]
  const user = token ? getSessionUser(token) : null
  return user && !user.disabled ? user : null
}

export default async function mcpOAuthRoutes(app: FastifyInstance) {
  // /token and /revoke are conventionally posted as application/x-www-form-urlencoded (RFC 6749/7009);
  // Fastify only parses JSON by default. Scoped to this plugin only.
  await app.register(fastifyFormbody)

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/api/')) return // client-list/revoke below are already gated by the global /api/ session hook
    if (!db.settings.mcpServer.enabled) {
      return reply.code(503).send({ error: 'MCP server is disabled — enable it in Settings' })
    }
  })

  app.get('/.well-known/oauth-authorization-server', async () => {
    const resource = canonicalResource()
    const issuer = resource ? resource.replace(/\/mcp$/, '') : null
    return {
      issuer,
      authorization_endpoint: issuer ? `${issuer}/authorize` : null,
      token_endpoint: issuer ? `${issuer}/token` : null,
      registration_endpoint: issuer ? `${issuer}/register` : null,
      revocation_endpoint: issuer ? `${issuer}/revoke` : null,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }
  })

  app.get('/.well-known/oauth-protected-resource', async () => {
    const resource = canonicalResource()
    return {
      resource,
      authorization_servers: resource ? [resource.replace(/\/mcp$/, '')] : [],
    }
  })

  app.post('/register', async (req, reply) => {
    const result = registerDcrClient((req.body ?? {}) as Record<string, unknown>)
    if ('error' in result) return reply.code(400).send({ error: result.error })
    return reply.code(201).send({
      client_id: result.clientId,
      client_name: result.name,
      redirect_uris: result.redirectUris,
      application_type: result.applicationType,
      token_endpoint_auth_method: 'none',
    })
  })

  /**
   * Hands off to the web app's consent page (OAuthConsent.tsx, route
   * /oauth/authorize). That page itself shows the login form in place when
   * no session exists yet (Shell's own gating) and reveals the consent UI
   * once signed in — no separate /login redirect needed, the browser never
   * navigates away from this URL.
   */
  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>
    const resource = canonicalResource()
    if (!resource) {
      return reply.code(500).send({ error: 'settings.server.publicBaseUrl must be set before OAuth can be used' })
    }
    if (q.resource && q.resource !== resource) {
      return reply.code(400).send({ error: `resource must be ${resource}` })
    }
    if (q.code_challenge_method !== 'S256') {
      return reply.code(400).send({ error: 'code_challenge_method must be S256' })
    }
    if (!q.client_id || !q.redirect_uri || !q.code_challenge) {
      return reply.code(400).send({ error: 'client_id, redirect_uri, and code_challenge are required' })
    }
    const resolved = await resolveClient(q.client_id)
    if (!resolved) return reply.code(400).send({ error: 'unknown client_id' })
    const redirectUris = resolved.kind === 'dcr' ? resolved.client.redirectUris : resolved.redirectUris
    if (!redirectUris.includes(q.redirect_uri)) {
      return reply.code(400).send({ error: 'redirect_uri not registered for this client' })
    }
    const clientName = resolved.kind === 'dcr' ? resolved.client.name : resolved.name
    const params = new URLSearchParams({
      client_id: q.client_id,
      client_name: clientName,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      state: q.state ?? '',
      resource,
    })
    return reply.redirect(`/oauth/authorize?${params.toString()}`)
  })

  /** Called by the consent page (OAuthConsent.tsx) after the admin clicks Approve. */
  app.post('/authorize/approve', async (req, reply) => {
    const user = sessionUser(req)
    if (!user) return reply.code(401).send({ error: 'sign in required' })
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin access required' })
    const body = req.body as {
      clientId: string
      redirectUri: string
      codeChallenge: string
      state?: string
      resource: string
    }
    const resolved = await resolveClient(body.clientId)
    if (!resolved) return reply.code(400).send({ error: 'unknown client_id' })
    const code = issueAuthCode({
      clientId: body.clientId,
      clientRef: body.clientId,
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      resource: body.resource,
    })
    const resource = canonicalResource()
    const issuer = resource ? resource.replace(/\/mcp$/, '') : ''
    const redirect = new URL(body.redirectUri)
    redirect.searchParams.set('code', code)
    if (body.state) redirect.searchParams.set('state', body.state)
    redirect.searchParams.set('iss', issuer)
    return { redirectTo: redirect.toString() }
  })

  app.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>
    const resource = canonicalResource()
    if (!resource) return reply.code(500).send({ error: 'settings.server.publicBaseUrl must be set' })
    if (body.resource && body.resource !== resource) {
      return reply.code(400).send({ error: `resource must be ${resource}` })
    }
    if (body.grant_type === 'authorization_code') {
      const result = exchangeAuthCode({
        code: body.code,
        clientId: body.client_id,
        codeVerifier: body.code_verifier,
        resource,
      })
      if ('error' in result) return reply.code(400).send({ error: result.error })
      return {
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
      }
    }
    if (body.grant_type === 'refresh_token') {
      const result = refreshAccessToken({ refreshToken: body.refresh_token, resource })
      if ('error' in result) return reply.code(400).send({ error: result.error })
      return { access_token: result.accessToken, token_type: 'Bearer', expires_in: result.expiresIn }
    }
    return reply.code(400).send({ error: `unsupported grant_type '${body.grant_type}'` })
  })

  app.post('/revoke', async (req, reply) => {
    const body = req.body as { token?: string }
    if (!body.token) return reply.code(400).send({ error: 'token is required' })
    revokeToken(body.token)
    return { ok: true }
  })

  /** Admin-only: list DCR-registered clients + revoke. Settings page uses these. Under /api/, so the global session hook (index.ts) already populated req.user. */
  app.get('/api/settings/mcp-oauth-clients', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    return { clients: db.mcpOAuthClients }
  })

  app.delete('/api/settings/mcp-oauth-clients/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { id } = req.params as { id: string }
    const client = db.mcpOAuthClients.find((c) => c.id === id)
    if (!client) return reply.code(404).send({ error: 'client not found' })
    db.mcpOAuthTokens = db.mcpOAuthTokens.filter((t) => t.clientId !== client.clientId)
    db.mcpOAuthClients = db.mcpOAuthClients.filter((c) => c.id !== id)
    save()
    return reply.code(204).send()
  })
}
