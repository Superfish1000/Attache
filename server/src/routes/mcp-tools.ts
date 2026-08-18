import type { FastifyInstance } from 'fastify'
import { db, newId, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { buildDockerfileImage } from '../docker-build.js'
import type { McpToolContainerDef } from '../types.js'

/**
 * Validates/merges body fields onto def. Returns an error string or null.
 */
function applyBody(def: McpToolContainerDef, body: Partial<McpToolContainerDef>): string | null {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name cannot be empty'
    def.name = body.name.trim()
  }
  if (body.image !== undefined) {
    if (typeof body.image !== 'string') return 'image must be a string'
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
  if (body.containerPorts !== undefined) {
    if (
      !Array.isArray(body.containerPorts) ||
      body.containerPorts.some((p) => !Number.isInteger(Number(p)) || Number(p) < 1 || Number(p) > 65535)
    ) {
      return 'containerPorts must be a list of ports'
    }
    def.containerPorts = body.containerPorts.map(Number)
  }
  if (body.mountPath !== undefined) {
    if (typeof body.mountPath !== 'string') return 'mountPath must be a string'
    if (body.mountPath && !body.mountPath.startsWith('/')) {
      return 'mountPath must be an absolute container path (or empty for no mount)'
    }
    def.mountPath = body.mountPath
  }
  if (body.memoryMb !== undefined) {
    const m = Number(body.memoryMb)
    if (Number.isNaN(m)) return 'memoryMb must be a number (blank or 0 clears)'
    if (m && (!Number.isInteger(m) || m < 64)) return 'memoryMb must be an integer >= 64 (0 clears)'
    if (m) def.memoryMb = m
    else delete def.memoryMb
  }
  if (body.cpus !== undefined) {
    const c = Number(body.cpus)
    if (Number.isNaN(c)) return 'cpus must be a number (blank or 0 clears)'
    if (c && (c <= 0 || c > 64)) return 'cpus must be > 0 and <= 64 (0 clears)'
    if (c) def.cpus = c
    else delete def.cpus
  }
  if (body.shmSizeMb !== undefined) {
    const s = Number(body.shmSizeMb)
    if (Number.isNaN(s)) return 'shmSizeMb must be a number (blank or 0 clears)'
    if (s && (!Number.isInteger(s) || s < 1)) return 'shmSizeMb must be an integer >= 1 (0 clears)'
    if (s) def.shmSizeMb = s
    else delete def.shmSizeMb
  }
  if (body.dockerfile !== undefined) {
    if (typeof body.dockerfile !== 'string') return 'dockerfile must be a string'
    def.dockerfile = body.dockerfile
  }
  return null
}

export default async function mcpToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  app.get('/', async () => ({ tools: db.mcpTools }))

  app.post('/', async (req, reply) => {
    const def: McpToolContainerDef = {
      id: newId(),
      name: 'New tool container',
      image: '',
      command: [],
      env: {},
      containerPorts: [],
      mountPath: '',
      dockerfile: '',
      createdAt: new Date().toISOString(),
    }
    const err = applyBody(def, (req.body ?? {}) as Partial<McpToolContainerDef>)
    if (err) return reply.code(400).send({ error: err })
    db.mcpTools.push(def)
    save()
    return reply.code(201).send(def)
  })

  app.patch('/:id', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    const err = applyBody(def, (req.body ?? {}) as Partial<McpToolContainerDef>)
    if (err) return reply.code(400).send({ error: err })
    save()
    return def
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const def = db.mcpTools.find((t) => t.id === id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    const inUse = db.mcpToolInstances.filter((i) => i.defId === id).length
    if (inUse > 0) {
      return reply.code(409).send({ error: `${inUse} instance(s) use this definition — delete them first` })
    }
    db.mcpTools = db.mcpTools.filter((t) => t.id !== id)
    save()
    return reply.code(204).send()
  })

  app.post('/:id/build', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    if (!def.dockerfile.trim()) return reply.code(400).send({ error: 'no Dockerfile on this definition' })
    if (!def.image.trim() || def.image.includes(' ')) {
      return reply.code(400).send({ error: 'definition image must be a valid tag to build into' })
    }
    return buildDockerfileImage(
      def.image,
      def.dockerfile,
      `attache-tool-build-${def.id}`,
      db.settings.docker.securityOpt,
    )
  })
}
