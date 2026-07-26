export interface User {
  id: string
  name: string
  email: string
  source: 'manual' | 'o365'
  o365Id?: string
  createdAt: string
}

export interface AgentConfig {
  /** Container image the agent runs in. Placeholder default until a real agent image exists. */
  image: string
  command: string[]
  env: Record<string, string>
}

export interface Agent {
  id: string
  userId: string
  name: string
  config: AgentConfig
  createdAt: string
}

export interface O365Settings {
  tenantId: string
  clientId: string
  clientSecret: string
  groupId: string
}

export interface Settings {
  o365: O365Settings
  lastO365Sync: string | null
}
