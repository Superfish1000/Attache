import type { FastifyInstance } from 'fastify'
import { db, newId, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { nextFreeHostPorts } from '../agents.js'
import { buildDockerfileImage } from '../docker-build.js'
import {
  dockerAvailable,
  removeContainerStorage,
  removeToolContainer,
  startToolContainer,
  stopToolContainer,
  toolContainerInfo,
  toolContainerLogs,
} from '../docker.js'
import { mcpToolDir } from '../mcp-tools.js'
import type { McpToolContainerDef } from '../types.js'

const ALIAS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Validates/merges body fields onto def. Returns an error string or null.
 * Also auto-assigns host ports for any container port that's missing one
 * while publishToHost is true — this runs on every call so it stays
 * consistent whichever field actually changed.
 */
function applyBody(def: McpToolContainerDef, body: Partial<McpToolContainerDef>): string | null {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name cannot be empty'
    def.name = body.name.trim()
  }
  if (body.networkAlias !== undefined) {
    if (typeof body.networkAlias !== 'string') return 'networkAlias must be a string'
    const alias = body.networkAlias.trim().toLowerCase()
    if (alias) {
      if (!ALIAS_RE.test(alias)) {
        return 'networkAlias must be a valid DNS label (lowercase letters, digits, hyphens; no leading/trailing hyphen)'
      }
      if (db.mcpTools.some((t) => t.id !== def.id && t.networkAlias.toLowerCase() === alias)) {
        return `networkAlias '${alias}' is already in use`
      }
    }
    def.networkAlias = alias
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
  if (body.publishToHost !== undefined) {
    if (typeof body.publishToHost !== 'boolean') return 'publishToHost must be a boolean'
    def.publishToHost = body.publishToHost
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
  if (body.dockerfile !== undefined) {
    if (typeof body.dockerfile !== 'string') return 'dockerfile must be a string'
    def.dockerfile = body.dockerfile
  }
  if (def.publishToHost) {
    const missing = def.containerPorts.filter((cp) => !(String(cp) in def.hostPorts))
    if (missing.length) {
      const assigned = nextFreeHostPorts(missing.length)
      missing.forEach((cp, i) => {
        def.hostPorts[String(cp)] = assigned[i]
      })
    }
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
      networkAlias: '',
      image: '',
      command: [],
      env: {},
      containerPorts: [],
      hostPorts: {},
      publishToHost: false,
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
    try {
      await removeToolContainer(id)
    } catch {
      // docker unavailable — record still goes away
    }
    if (def.image) await removeContainerStorage(def.image, mcpToolDir(id))
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

  app.get('/:id/container', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    if (!(await dockerAvailable())) return { available: false, exists: false }
    return { available: true, ...(await toolContainerInfo(def.id)) }
  })

  app.get('/:id/container/logs', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      return { logs: await toolContainerLogs(def.id) }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'no container for this tool yet' })
      }
      throw err
    }
  })

  app.post('/:id/container/:action', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    const { action } = req.params as { action: string }
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      if (action === 'start') {
        if (!def.image.trim() || !def.networkAlias.trim()) {
          return reply.code(400).send({ error: 'set an image and a network alias before starting' })
        }
        return { available: true, ...(await startToolContainer(def)) }
      }
      if (action === 'stop') return { available: true, ...(await stopToolContainer(def.id)) }
      if (action === 'remove') return { available: true, ...(await removeToolContainer(def.id)) }
      return reply.code(400).send({ error: `unknown action '${action}' (start|stop|remove)` })
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `docker ${action} failed: ${(err as Error).message}` })
    }
  })

  /** Remove + recreate + start in one step so image/env/port changes apply. */
  app.post('/:id/container/regenerate', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      await removeToolContainer(def.id)
    } catch {
      // best-effort — proceed to start regardless
    }
    try {
      return { available: true, ...(await startToolContainer(def)) }
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `regenerate failed: ${(err as Error).message}` })
    }
  })
}
