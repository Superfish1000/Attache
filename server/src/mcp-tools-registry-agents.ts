import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, newId, save } from './store.js'
import { createAgent, deleteAgent, resetAgentFiles, syncAgentPorts } from './agents.js'
import { buildDockerfileImage } from './docker-build.js'
import {
  containerInfo,
  provisionMcpServers,
  removeAgentContainer,
  removeAgentStorage,
  restartAgentContainer,
  startAgentContainer,
  stopAgentContainer,
} from './docker.js'
import {
  applyImageUpdate,
  checkAndPersist,
  checkedImageFor,
  sweepAndApply,
} from './routes/container-defs.js'
import type { ContainerDef, ContainerFileDef } from './types.js'

const CONFIRM = {
  confirm: z
    .literal(true)
    .describe(
      'Must be true. Only pass true after confirming this action with the human operator — it interrupts or removes something already running.',
    ),
}

export function registerAgentTools(server: McpServer): void {
  // --- Agent container definitions ---

  server.tool(
    'list_container_definitions',
    'List every agent container definition (reusable templates agents are created from).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.containers) }] }),
  )

  server.tool(
    'get_container_definition',
    'Get one agent container definition by id.',
    { id: z.string() },
    async ({ id }) => {
      const def = db.containers.find((c) => c.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'create_container_definition',
    'Create a new agent container definition.',
    {
      name: z.string(),
      image: z.string().optional(),
      command: z.array(z.string()).optional(),
      mountPath: z.string().optional(),
      containerPorts: z.array(z.number()).optional(),
    },
    async (body) => {
      const def: ContainerDef = {
        id: newId(),
        name: body.name,
        image: body.image ?? 'alpine:3.20',
        command: body.command ?? ['sleep', 'infinity'],
        env: {},
        mountPath: body.mountPath ?? '/data',
        containerPorts: body.containerPorts ?? [],
        files: [] as ContainerFileDef[],
        mcpServers: [],
        mcpProvisionCommand: '',
        mcpTokenEnvKey: '',
        mcpLoginCommand: '',
        dockerfile: '',
        createdAt: new Date().toISOString(),
      }
      db.containers.push(def)
      if (!db.settings.docker.defaultContainerId) db.settings.docker.defaultContainerId = def.id
      save()
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'update_container_definition',
    'Update fields on an existing agent container definition.',
    {
      id: z.string(),
      name: z.string().optional(),
      image: z.string().optional(),
      command: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      mountPath: z.string().optional(),
      containerPorts: z.array(z.number()).optional(),
      dockerfile: z.string().optional(),
    },
    async ({ id, ...patch }) => {
      const def = db.containers.find((c) => c.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      Object.assign(def, patch)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'delete_container_definition',
    'Delete an agent container definition. Fails if any agent still uses it.',
    { id: z.string(), ...CONFIRM },
    async ({ id }) => {
      const inUse = db.agents.filter((a) => a.containerId === id).length
      if (inUse > 0) {
        return { content: [{ type: 'text', text: `${inUse} agent(s) use this definition` }], isError: true }
      }
      db.containers = db.containers.filter((c) => c.id !== id)
      save()
      return { content: [{ type: 'text', text: 'deleted' }] }
    },
  )

  server.tool(
    'build_container_definition_image',
    "Build a container definition's Dockerfile, tagged as its own image. Only valid for definitions that have a Dockerfile set.",
    { id: z.string() },
    async ({ id }) => {
      const def = db.containers.find((c) => c.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (!def.dockerfile.trim()) {
        return { content: [{ type: 'text', text: 'no Dockerfile on this definition' }], isError: true }
      }
      if (!def.image.trim() || def.image.includes(' ')) {
        return { content: [{ type: 'text', text: 'definition image must be a valid tag to build into' }], isError: true }
      }
      const result = await buildDockerfileImage(def.image, def.dockerfile, `attache-build-${def.id}`, db.settings.docker.securityOpt)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    'check_container_definition_update',
    "Check whether a container definition's base image is behind the registry.",
    { id: z.string() },
    async ({ id }) => {
      const def = db.containers.find((c) => c.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(await checkAndPersist(def)) }] }
    },
  )

  server.tool(
    'upgrade_container_definition_image',
    "Pull/rebuild a container definition's image. mode 'stage' pulls only, 'update' pulls+rebuilds (no running containers touched), 'update-regen' also regenerates every agent on this definition.",
    { id: z.string(), mode: z.enum(['stage', 'update', 'update-regen']), confirm: z.literal(true).optional() },
    async ({ id, mode, confirm }) => {
      if (mode === 'update-regen' && confirm !== true) {
        return { content: [{ type: 'text', text: 'mode update-regen requires confirm: true' }], isError: true }
      }
      const def = db.containers.find((c) => c.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      const image = checkedImageFor(def)
      if (!image) return { content: [{ type: 'text', text: 'no image to check/pull' }], isError: true }
      const result = await applyImageUpdate(def, image, mode)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    'upgrade_all_container_definitions',
    'Check every agent container definition and apply mode to the ones behind (stage/update) or all of them (update-regen).',
    { mode: z.enum(['stage', 'update', 'update-regen']), confirm: z.literal(true).optional() },
    async ({ mode, confirm }) => {
      if (mode === 'update-regen' && confirm !== true) {
        return { content: [{ type: 'text', text: 'mode update-regen requires confirm: true' }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(await sweepAndApply(mode)) }] }
    },
  )

  // --- Agents ---

  server.tool(
    'list_agents',
    'List every agent.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.agents) }] }),
  )

  server.tool(
    'get_agent',
    'Get one agent by id.',
    { id: z.string() },
    async ({ id }) => {
      const agent = db.agents.find((a) => a.id === id)
      if (!agent) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(agent) }] }
    },
  )

  server.tool(
    'create_agent',
    'Create a new agent for a user, optionally from a specific container definition.',
    { userId: z.string(), name: z.string().optional(), containerId: z.string().optional() },
    async ({ userId, name, containerId }) => {
      if (!db.users.some((u) => u.id === userId)) {
        return { content: [{ type: 'text', text: 'unknown userId' }], isError: true }
      }
      try {
        const agent = createAgent(userId, name, containerId)
        return { content: [{ type: 'text', text: JSON.stringify(agent) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
      }
    },
  )

  server.tool(
    'update_agent',
    'Update an agent — rename it, switch its container definition, or edit its runtime config.',
    {
      id: z.string(),
      name: z.string().optional(),
      containerId: z.string().optional(),
      config: z
        .object({
          image: z.string().optional(),
          command: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          memoryMb: z.number().optional(),
          cpus: z.number().optional(),
          shmSizeMb: z.number().optional(),
        })
        .optional(),
    },
    async ({ id, name, containerId, config }) => {
      const agent = db.agents.find((a) => a.id === id)
      if (!agent) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (name?.trim()) agent.name = name.trim()
      if (containerId) agent.containerId = containerId
      if (config) Object.assign(agent.config, config)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(agent) }] }
    },
  )

  server.tool(
    'delete_agent',
    "Delete an agent, its container, and its stored files. Can't be undone.",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => {
      const agent = db.agents.find((a) => a.id === id)
      if (!agent) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      try {
        await removeAgentContainer(id)
      } catch {
        // docker unavailable — record still goes away
      }
      await removeAgentStorage(agent)
      deleteAgent(id)
      return { content: [{ type: 'text', text: 'deleted' }] }
    },
  )

  server.tool(
    'get_agent_container_status',
    "Get an agent's container status (running/stopped, image, whether it needs a regenerate).",
    { id: z.string() },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await containerInfo(id)) }] }),
  )

  server.tool(
    'start_agent_container',
    "Start an agent's container.",
    { id: z.string() },
    async ({ id }) => {
      const agent = db.agents.find((a) => a.id === id)
      if (!agent) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      // bindings only apply at container creation — syncing for an existing
      // container would record mappings docker never made
      if (!(await containerInfo(agent.id)).exists) syncAgentPorts(agent)
      const info = await startAgentContainer(agent)
      void provisionMcpServers(agent).catch(() => undefined)
      return { content: [{ type: 'text', text: JSON.stringify(info) }] }
    },
  )

  server.tool(
    'stop_agent_container',
    "Stop an agent's container.",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await stopAgentContainer(id)) }] }),
  )

  server.tool(
    'restart_agent_container',
    "Restart an agent's container in place (does not pick up config/image changes — use regenerate for that).",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await restartAgentContainer(id)) }] }),
  )

  server.tool(
    'regenerate_agent_container',
    "Remove and recreate an agent's container so config/image changes apply. Briefly interrupts the agent. Set resetFiles to also reset its behavior files (SOUL.md, memory, etc.) back to the container definition's templates.",
    { id: z.string(), resetFiles: z.boolean().optional(), ...CONFIRM },
    async ({ id, resetFiles }) => {
      const agent = db.agents.find((a) => a.id === id)
      if (!agent) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      syncAgentPorts(agent)
      await removeAgentContainer(id)
      const filesReset = resetFiles ? resetAgentFiles(agent) : []
      const info = await startAgentContainer(agent)
      void provisionMcpServers(agent).catch(() => undefined)
      return { content: [{ type: 'text', text: JSON.stringify({ ...info, filesReset }) }] }
    },
  )
}
