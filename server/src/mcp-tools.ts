import { join } from 'node:path'
import { MCP_TOOLS_DIR } from './store.js'

export function mcpToolDir(id: string): string {
  return join(MCP_TOOLS_DIR, id)
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'tool'
}

/** First unused DNS-safe alias derived from `base`: the plain slug, then `-2`, `-3`, … */
export function nextAvailableAlias(base: string, existing: string[]): string {
  const slug = slugify(base)
  const taken = new Set(existing.map((a) => a.toLowerCase()))
  if (!taken.has(slug)) return slug
  let n = 2
  while (taken.has(`${slug}-${n}`)) n++
  return `${slug}-${n}`
}
