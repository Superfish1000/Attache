import { join } from 'node:path'
import { MCP_TOOLS_DIR } from './store.js'

export function mcpToolDir(id: string): string {
  return join(MCP_TOOLS_DIR, id)
}
