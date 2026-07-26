import type { FastifyInstance } from 'fastify'
import { mcpStatus } from '../mcp.js'

export default async function mcpRoutes(app: FastifyInstance) {
  app.get('/status', async () => mcpStatus())
}
