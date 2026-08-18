import type { FastifyInstance } from 'fastify'
import { db, newId, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { isSafeRelPath } from '../agents.js'
import { buildDockerfileImage } from '../docker-build.js'
import type { ContainerDef, ContainerFileDef } from '../types.js'

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/

/** Returns an error string, or null when valid. Normalizes values in place. */
function validateFiles(files: unknown): string | null {
  if (!Array.isArray(files)) return 'files must be an array'
  const seen = new Set<string>()
  for (const f of files as ContainerFileDef[]) {
    if (typeof f !== 'object' || f === null) return 'each file must be an object'
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) {
      return `file key '${String(f.key)}' must be a lowercase slug (a-z, 0-9, dashes)`
    }
    if (seen.has(f.key)) return `duplicate file key '${f.key}'`
    seen.add(f.key)
    if (typeof f.label !== 'string' || !f.label.trim()) return `file '${f.key}' needs a label`
    if (typeof f.path !== 'string' || !isSafeRelPath(f.path)) {
      return `file '${f.key}' path must be relative, without '..' or a leading slash`
    }
    f.label = f.label.trim()
    f.hint = typeof f.hint === 'string' ? f.hint : ''
    f.template = typeof f.template === 'string' ? f.template : ''
  }
  return null
}

/** Validates/merges body fields onto def. Returns error string or null. */
function applyBody(def: ContainerDef, body: Partial<ContainerDef>): string | null {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name cannot be empty'
    def.name = body.name.trim()
  }
  if (body.image !== undefined) {
    if (typeof body.image !== 'string' || !body.image.trim()) return 'image cannot be empty'
    def.image = body.image.trim()
  }
  if (body.command !== undefined) {
    if (!Array.isArray(body.command) || body.command.some((c) => typeof c !== 'string')) {
      return 'command must be an array of strings'
    }
    def.command = body.command
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) {
      return 'env must be an object of string values'
    }
    def.env = Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)]))
  }
  if (body.mountPath !== undefined) {
    if (typeof body.mountPath !== 'string' || !body.mountPath.startsWith('/')) {
      return 'mountPath must be an absolute container path'
    }
    def.mountPath = body.mountPath
  }
  if (body.containerPorts !== undefined) {
    if (
      !Array.isArray(body.containerPorts) ||
      body.containerPorts.some((p) => !Number.isInteger(Number(p)) || Number(p) < 1 || Number(p) > 65535)
    ) {
      return 'containerPorts must be a list of ports'
    }
    def.containerPorts = body.containerPorts.map(Number)
  }
  if (body.memoryMb !== undefined) {
    const m = Number(body.memoryMb)
    if (m && (!Number.isInteger(m) || m < 64)) return 'memoryMb must be an integer >= 64 (0 clears)'
    if (m) def.memoryMb = m
    else delete def.memoryMb
  }
  if (body.cpus !== undefined) {
    const c = Number(body.cpus)
    if (c && (!Number.isFinite(c) || c <= 0 || c > 64)) return 'cpus must be > 0 and <= 64 (0 clears)'
    if (c) def.cpus = c
    else delete def.cpus
  }
  if (body.shmSizeMb !== undefined) {
    const s = Number(body.shmSizeMb)
    if (s && (!Number.isInteger(s) || s < 1)) return 'shmSizeMb must be an integer >= 1 (0 clears)'
    if (s) def.shmSizeMb = s
    else delete def.shmSizeMb
  }
  if (body.files !== undefined) {
    const err = validateFiles(body.files)
    if (err) return err
    def.files = body.files as ContainerFileDef[]
  }
  if (body.mcpServers !== undefined) {
    if (!Array.isArray(body.mcpServers)) return 'mcpServers must be an array'
    const seen = new Set<string>()
    for (const s of body.mcpServers) {
      if (typeof s !== 'object' || s === null) return 'each MCP server must be an object'
      if (typeof s.name !== 'string' || !/^[\w-]+$/.test(s.name)) {
        return `MCP server name '${String(s.name)}' must be letters, digits, dashes, underscores`
      }
      if (seen.has(s.name)) return `duplicate MCP server name '${s.name}'`
      seen.add(s.name)
      s.url = typeof s.url === 'string' ? s.url.trim() : ''
      s.command = typeof s.command === 'string' ? s.command.trim() : ''
      if (!s.url && !s.command) {
        return `MCP server '${s.name}' needs a URL or a stdio command`
      }
      if (s.url && !/^https?:\/\/\S+$/.test(s.url)) {
        return `MCP server '${s.name}' URL must be http(s)`
      }
      s.extraArgs = typeof s.extraArgs === 'string' ? s.extraArgs.trim() : ''
      s.authToken = typeof s.authToken === 'string' ? s.authToken.trim() : ''
    }
    def.mcpServers = body.mcpServers
  }
  if (body.mcpLoginCommand !== undefined) {
    if (typeof body.mcpLoginCommand !== 'string') return 'mcpLoginCommand must be a string'
    def.mcpLoginCommand = body.mcpLoginCommand
  }
  if (body.dockerfile !== undefined) {
    if (typeof body.dockerfile !== 'string') return 'dockerfile must be a string'
    def.dockerfile = body.dockerfile
  }
  if (body.mcpTokenEnvKey !== undefined) {
    if (typeof body.mcpTokenEnvKey !== 'string') return 'mcpTokenEnvKey must be a string'
    def.mcpTokenEnvKey = body.mcpTokenEnvKey.trim()
  }
  if (body.mcpProvisionCommand !== undefined) {
    if (typeof body.mcpProvisionCommand !== 'string') {
      return 'mcpProvisionCommand must be a string'
    }
    def.mcpProvisionCommand = body.mcpProvisionCommand
  }
  return null
}

export default async function containerDefRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/', async () => ({
    defs: db.containers,
    defaultId: db.settings.docker.defaultContainerId,
  }))

  app.post('/', async (req, reply) => {
    const def: ContainerDef = {
      id: newId(),
      name: 'New container',
      image: 'alpine:3.20',
      command: ['sleep', 'infinity'],
      env: {},
      mountPath: '/data',
      containerPorts: [],
      files: [],
      mcpServers: [],
      mcpProvisionCommand: '',
      mcpTokenEnvKey: '',
      mcpLoginCommand: '',
      dockerfile: '',
      createdAt: new Date().toISOString(),
    }
    const err = applyBody(def, (req.body ?? {}) as Partial<ContainerDef>)
    if (err) return reply.code(400).send({ error: err })
    db.containers.push(def)
    if (!db.settings.docker.defaultContainerId) db.settings.docker.defaultContainerId = def.id
    save()
    return reply.code(201).send(def)
  })

  app.patch('/:id', async (req, reply) => {
    const def = db.containers.find((c) => c.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'container definition not found' })
    const err = applyBody(def, (req.body ?? {}) as Partial<ContainerDef>)
    if (err) return reply.code(400).send({ error: err })
    save()
    return def
  })

  /**
   * Build the definition's Dockerfile, tagged as its image. Tries a native
   * `docker build`; on failure, simple FROM+RUN files are emulated via
   * run (with settings securityOpt) + commit — needed on old daemons whose
   * seccomp profile aborts builds of modern images.
   */
  app.post('/:id/build', async (req, reply) => {
    const def = db.containers.find((c) => c.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'container definition not found' })
    if (!def.dockerfile.trim()) return reply.code(400).send({ error: 'no Dockerfile on this definition' })
    if (!def.image.trim() || def.image.includes(' ')) {
      return reply.code(400).send({ error: 'definition image must be a valid tag to build into' })
    }
    return buildDockerfileImage(
      def.image,
      def.dockerfile,
      `attache-build-${def.id}`,
      db.settings.docker.securityOpt,
    )
  })

  app.put('/:id/default', async (req, reply) => {
    const def = db.containers.find((c) => c.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'container definition not found' })
    db.settings.docker.defaultContainerId = def.id
    save()
    return { ok: true, defaultId: def.id }
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!db.containers.some((c) => c.id === id)) {
      return reply.code(404).send({ error: 'container definition not found' })
    }
    const inUse = db.agents.filter((a) => a.containerId === id).length
    if (inUse > 0) {
      return reply.code(409).send({ error: `${inUse} agent(s) use this definition — delete them first` })
    }
    db.containers = db.containers.filter((c) => c.id !== id)
    if (db.settings.docker.defaultContainerId === id) {
      db.settings.docker.defaultContainerId = db.containers[0]?.id ?? ''
    }
    save()
    return reply.code(204).send()
  })
}
