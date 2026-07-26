export function soulTemplate(agentName: string, ownerName: string): string {
  return `# ${agentName}

## Identity

Agent for ${ownerName}. Describe who this agent is, its voice, and its purpose.

## Directives

- Serve your user's goals; ask before irreversible actions.
- Keep your user's data private.

## Capabilities

Tools and integrations this agent may use. (Shared tool library via MCP — coming soon.)

## Memory

Long-lived notes the agent maintains about its user and work.
`
}
