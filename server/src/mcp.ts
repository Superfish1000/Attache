/**
 * Shared tool library, exposed as an MCP server — STUB.
 * Future: real MCP server (streamable HTTP) that agents connect to for shared
 * tools (mail, calendar, knowledge base, ...). Tool registry will live in the
 * store with per-agent grants.
 */
export function mcpStatus() {
  return {
    enabled: false,
    endpoint: null as string | null,
    note: 'Shared tool library MCP server is planned — this is a stub.',
    plannedTools: [
      { name: 'send_mail', description: "Send email through the agent user's mailbox (O365)" },
      { name: 'calendar_read', description: "Read the agent user's calendar" },
      { name: 'kb_search', description: 'Search the shared knowledge base' },
    ],
  }
}
