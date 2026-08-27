import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { db } from '../store.js'
import { canonicalResource, validateAccessToken } from '../mcp-oauth.js'
import { registerAgentTools } from '../mcp-tools-registry-agents.js'
import { registerMcpToolTools } from '../mcp-tools-registry-mcp-tools.js'

function buildServer(): McpServer {
  const server = new McpServer({ name: 'attache-management', version: '1.0.0' })
  registerAgentTools(server)
  registerMcpToolTools(server)
  return server
}

/** Accepts the static settings.mcpServer.bearerToken OR a valid OAuth access token scoped to this resource. */
function isAuthorized(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice('Bearer '.length)
  if (token === db.settings.mcpServer.bearerToken) return true
  const resource = canonicalResource()
  return resource ? validateAccessToken(token, resource) : false
}

export default async function mcpServerRoutes(app: FastifyInstance) {
  // one transport per MCP session id, so concurrent clients don't share state
  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.addHook('preHandler', async (req, reply) => {
    if (!db.settings.mcpServer.enabled) {
      return reply.code(503).send({ error: 'MCP server is disabled — enable it in Settings' })
    }
    if (!isAuthorized(req.headers.authorization)) {
      reply.header('WWW-Authenticate', 'Bearer realm="attache"')
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.all('/mcp', async (req, reply) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) {
      const newSessionId = randomUUID()
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          transports.set(id, transport!)
        },
      })
      transport.onclose = () => transports.delete(newSessionId)
      await buildServer().connect(transport)
    }
    await transport.handleRequest(req.raw, reply.raw, req.body)
    reply.hijack()
  })
}
