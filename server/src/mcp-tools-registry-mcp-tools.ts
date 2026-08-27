import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, newId, save } from './store.js'
import { nextFreeHostPorts } from './agents.js'
import { mcpToolDir, nextAvailableAlias } from './mcp-tools.js'
import { buildDockerfileImage } from './docker-build.js'
import {
  removeContainerStorage,
  removeToolContainer,
  restartToolContainer,
  startToolContainer,
  stopToolContainer,
  toolContainerInfo,
} from './docker.js'
import {
  applyImageUpdate,
  checkAndPersist,
  checkedImageFor,
  sweepAndApply,
} from './routes/mcp-tools.js'
import type { McpToolContainerDef, McpToolInstance } from './types.js'

const CONFIRM = {
  confirm: z
    .literal(true)
    .describe(
      'Must be true. Only pass true after confirming this action with the human operator — it interrupts or removes something already running.',
    ),
}

/** Same DNS-label rule the REST route enforces — getting this wrong is exactly the class of bug this feature exists to prevent. */
const ALIAS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function validateAlias(alias: string, selfId?: string): string | null {
  if (!ALIAS_RE.test(alias)) {
    return 'networkAlias must be a valid DNS label (lowercase letters, digits, hyphens; no leading/trailing hyphen)'
  }
  if (db.mcpToolInstances.some((i) => i.id !== selfId && i.networkAlias.toLowerCase() === alias)) {
    return `networkAlias '${alias}' is already in use`
  }
  return null
}

/** Auto-assigns host ports for any container port missing one while publishToHost is true — same rule applyBody() enforces in the REST route. */
function assignHostPortsIfNeeded(instance: McpToolInstance): void {
  if (!instance.config.publishToHost) return
  const missing = instance.config.containerPorts.filter((cp) => !(String(cp) in instance.config.hostPorts))
  if (missing.length) {
    const assigned = nextFreeHostPorts(missing.length)
    missing.forEach((cp, i) => {
      instance.config.hostPorts[String(cp)] = assigned[i]
    })
  }
}

export function registerMcpToolTools(server: McpServer): void {
  // --- MCP tool container definitions ---

  server.tool(
    'list_mcp_tool_definitions',
    'List every MCP tool container definition (reusable templates instances are created from).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.mcpTools) }] }),
  )

  server.tool(
    'get_mcp_tool_definition',
    'Get one MCP tool container definition by id.',
    { id: z.string() },
    async ({ id }) => {
      const def = db.mcpTools.find((t) => t.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'create_mcp_tool_definition',
    'Create a new MCP tool container definition.',
    {
      name: z.string(),
      image: z.string().optional(),
      command: z.array(z.string()).optional(),
      containerPorts: z.array(z.number()).optional(),
      dockerfile: z.string().optional(),
    },
    async (body) => {
      const def: McpToolContainerDef = {
        id: newId(),
        name: body.name,
        image: body.image ?? '',
        command: body.command ?? [],
        env: {},
        containerPorts: body.containerPorts ?? [],
        mountPath: '',
        dockerfile: body.dockerfile ?? '',
        createdAt: new Date().toISOString(),
      }
      db.mcpTools.push(def)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'update_mcp_tool_definition',
    'Update fields on an existing MCP tool container definition.',
    {
      id: z.string(),
      name: z.string().optional(),
      image: z.string().optional(),
      command: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      containerPorts: z.array(z.number()).optional(),
      dockerfile: z.string().optional(),
    },
    async ({ id, ...patch }) => {
      const def = db.mcpTools.find((t) => t.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      Object.assign(def, patch)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(def) }] }
    },
  )

  server.tool(
    'delete_mcp_tool_definition',
    'Delete an MCP tool container definition. Fails if any instance still uses it.',
    { id: z.string(), ...CONFIRM },
    async ({ id }) => {
      const inUse = db.mcpToolInstances.filter((i) => i.defId === id).length
      if (inUse > 0) {
        return { content: [{ type: 'text', text: `${inUse} instance(s) use this definition — delete them first` }], isError: true }
      }
      db.mcpTools = db.mcpTools.filter((t) => t.id !== id)
      save()
      return { content: [{ type: 'text', text: 'deleted' }] }
    },
  )

  server.tool(
    'build_mcp_tool_definition_image',
    "Build an MCP tool definition's Dockerfile, tagged as its own image. Only valid for definitions that have a Dockerfile set. This is the tool that replaces manually remoting into the host to rebuild a custom MCP tool image.",
    { id: z.string() },
    async ({ id }) => {
      const def = db.mcpTools.find((t) => t.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (!def.dockerfile.trim()) {
        return { content: [{ type: 'text', text: 'no Dockerfile on this definition' }], isError: true }
      }
      if (!def.image.trim() || def.image.includes(' ')) {
        return { content: [{ type: 'text', text: 'definition image must be a valid tag to build into' }], isError: true }
      }
      const result = await buildDockerfileImage(def.image, def.dockerfile, `attache-tool-build-${def.id}`, db.settings.docker.securityOpt)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    'check_mcp_tool_definition_update',
    "Check whether an MCP tool definition's base image is behind the registry.",
    { id: z.string() },
    async ({ id }) => {
      const def = db.mcpTools.find((t) => t.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(await checkAndPersist(def)) }] }
    },
  )

  server.tool(
    'upgrade_mcp_tool_definition_image',
    "Pull/rebuild an MCP tool definition's image. mode 'stage' pulls only, 'update' pulls+rebuilds (no running instances touched), 'update-regen' also regenerates every instance of this definition.",
    { id: z.string(), mode: z.enum(['stage', 'update', 'update-regen']), confirm: z.literal(true).optional() },
    async ({ id, mode, confirm }) => {
      if (mode === 'update-regen' && confirm !== true) {
        return { content: [{ type: 'text', text: 'mode update-regen requires confirm: true' }], isError: true }
      }
      const def = db.mcpTools.find((t) => t.id === id)
      if (!def) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      const image = checkedImageFor(def)
      if (!image) return { content: [{ type: 'text', text: 'no image to check/pull' }], isError: true }
      const result = await applyImageUpdate(def, image, mode)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    'upgrade_all_mcp_tool_definitions',
    'Check every MCP tool definition and apply mode to the ones behind (stage/update) or all of them (update-regen).',
    { mode: z.enum(['stage', 'update', 'update-regen']), confirm: z.literal(true).optional() },
    async ({ mode, confirm }) => {
      if (mode === 'update-regen' && confirm !== true) {
        return { content: [{ type: 'text', text: 'mode update-regen requires confirm: true' }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(await sweepAndApply(mode)) }] }
    },
  )

  // --- MCP tool instances ---

  server.tool(
    'list_mcp_tool_instances',
    'List every MCP tool instance (running or stoppable copies of a definition).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(db.mcpToolInstances) }] }),
  )

  server.tool(
    'get_mcp_tool_instance',
    'Get one MCP tool instance by id.',
    { id: z.string() },
    async ({ id }) => {
      const instance = db.mcpToolInstances.find((i) => i.id === id)
      if (!instance) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(instance) }] }
    },
  )

  server.tool(
    'create_mcp_tool_instance',
    'Create a new instance (running copy) of an MCP tool definition. networkAlias is auto-generated if omitted — other containers reach this instance by that DNS name on the shared network, so getting it right matters.',
    { defId: z.string(), name: z.string().optional(), networkAlias: z.string().optional() },
    async ({ defId, name, networkAlias }) => {
      const def = db.mcpTools.find((t) => t.id === defId)
      if (!def) return { content: [{ type: 'text', text: 'unknown defId' }], isError: true }
      let alias = nextAvailableAlias(def.name, db.mcpToolInstances.map((i) => i.networkAlias))
      if (networkAlias?.trim()) {
        const candidate = networkAlias.trim().toLowerCase()
        const err = validateAlias(candidate)
        if (err) return { content: [{ type: 'text', text: err }], isError: true }
        alias = candidate
      }
      const instance: McpToolInstance = {
        id: newId(),
        defId: def.id,
        name: name?.trim() || def.name,
        networkAlias: alias,
        config: {
          image: def.image,
          command: [...def.command],
          env: { ...def.env },
          containerPorts: [...def.containerPorts],
          hostPorts: {},
          publishToHost: false,
          mountPath: def.mountPath,
          ...(def.memoryMb ? { memoryMb: def.memoryMb } : {}),
          ...(def.cpus ? { cpus: def.cpus } : {}),
          ...(def.shmSizeMb ? { shmSizeMb: def.shmSizeMb } : {}),
        },
        createdAt: new Date().toISOString(),
      }
      db.mcpToolInstances.push(instance)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(instance) }] }
    },
  )

  server.tool(
    'update_mcp_tool_instance',
    "Update an instance's name, network alias, or config.",
    {
      id: z.string(),
      name: z.string().optional(),
      networkAlias: z.string().optional(),
      config: z
        .object({
          image: z.string().optional(),
          command: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          containerPorts: z.array(z.number()).optional(),
          publishToHost: z.boolean().optional(),
          mountPath: z.string().optional(),
          memoryMb: z.number().optional(),
          cpus: z.number().optional(),
        })
        .optional(),
    },
    async ({ id, name, networkAlias, config }) => {
      const instance = db.mcpToolInstances.find((i) => i.id === id)
      if (!instance) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (name?.trim()) instance.name = name.trim()
      if (networkAlias?.trim()) {
        const candidate = networkAlias.trim().toLowerCase()
        const err = validateAlias(candidate, instance.id)
        if (err) return { content: [{ type: 'text', text: err }], isError: true }
        instance.networkAlias = candidate
      }
      if (config) Object.assign(instance.config, config)
      assignHostPortsIfNeeded(instance)
      save()
      return { content: [{ type: 'text', text: JSON.stringify(instance) }] }
    },
  )

  server.tool(
    'delete_mcp_tool_instance',
    "Delete an MCP tool instance and its container. Can't be undone.",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => {
      const instance = db.mcpToolInstances.find((i) => i.id === id)
      if (!instance) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      try {
        await removeToolContainer(id)
      } catch {
        // docker unavailable — record still goes away
      }
      if (instance.config.image) await removeContainerStorage(instance.config.image, mcpToolDir(id))
      db.mcpToolInstances = db.mcpToolInstances.filter((i) => i.id !== id)
      save()
      return { content: [{ type: 'text', text: 'deleted' }] }
    },
  )

  server.tool(
    'get_mcp_tool_instance_container_status',
    "Get an MCP tool instance's container status (running/stopped, image, whether it needs a regenerate).",
    { id: z.string() },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await toolContainerInfo(id)) }] }),
  )

  server.tool(
    'start_mcp_tool_instance_container',
    "Start an MCP tool instance's container. Requires the instance to have an image and network alias set.",
    { id: z.string() },
    async ({ id }) => {
      const instance = db.mcpToolInstances.find((i) => i.id === id)
      if (!instance) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      if (!instance.config.image.trim() || !instance.networkAlias.trim()) {
        return { content: [{ type: 'text', text: 'set an image and a network alias before starting' }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(await startToolContainer(instance)) }] }
    },
  )

  server.tool(
    'stop_mcp_tool_instance_container',
    "Stop an MCP tool instance's container.",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await stopToolContainer(id)) }] }),
  )

  server.tool(
    'restart_mcp_tool_instance_container',
    "Restart an MCP tool instance's container in place (does not pick up config/image changes — use regenerate for that).",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await restartToolContainer(id)) }] }),
  )

  server.tool(
    'regenerate_mcp_tool_instance',
    "Remove and recreate an MCP tool instance's container so config/image changes apply. Use this after upgrading the instance's definition image so agents connected to it pick up the change — this is the tool that replaces the manual regenerate-then-reconnect dance.",
    { id: z.string(), ...CONFIRM },
    async ({ id }) => {
      const instance = db.mcpToolInstances.find((i) => i.id === id)
      if (!instance) return { content: [{ type: 'text', text: 'not found' }], isError: true }
      try {
        await removeToolContainer(id)
      } catch {
        // best-effort — proceed to start regardless
      }
      return { content: [{ type: 'text', text: JSON.stringify(await startToolContainer(instance)) }] }
    },
  )
}
