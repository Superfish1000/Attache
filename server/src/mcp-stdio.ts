#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAgentTools } from './mcp-tools-registry-agents.js'
import { registerMcpToolTools } from './mcp-tools-registry-mcp-tools.js'

const server = new McpServer({ name: 'attache-management-local', version: '1.0.0' })
registerAgentTools(server)
registerMcpToolTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
