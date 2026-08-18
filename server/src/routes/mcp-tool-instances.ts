import type { FastifyInstance } from 'fastify'
import { db, newId, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { nextFreeHostPorts } from '../agents.js'
import { mcpToolDir, nextAvailableAlias } from '../mcp-tools.js'
import {
  dockerAvailable,
  removeContainerStorage,
  removeToolContainer,
  restartToolContainer,
  startToolContainer,
  stopToolContainer,
  toolContainerInfo,
  toolContainerLogs,
} from '../docker.js'
import type { McpToolInstance } from '../types.js'

const ALIAS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Validates/merges body fields onto instance. Returns an error string or null.
 * Auto-assigns host ports for any container port missing one while
 * publishToHost is true — runs on every call so it stays consistent
 * whichever field actually changed.
 */
function applyBody(
  instance: McpToolInstance,
  body: Partial<McpToolInstance> & { config?: Partial<McpToolInstance['config']> },
): string | null {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name cannot be empty'
    instance.name = body.name.trim()
  }
  if (body.networkAlias !== undefined) {
    if (typeof body.networkAlias !== 'string') return 'networkAlias must be a string'
    const alias = body.networkAlias.trim().toLowerCase()
    if (!alias) return 'networkAlias cannot be empty'
    if (!ALIAS_RE.test(alias)) {
      return 'networkAlias must be a valid DNS label (lowercase letters, digits, hyphens; no leading/trailing hyphen)'
    }
    if (db.mcpToolInstances.some((i) => i.id !== instance.id && i.networkAlias.toLowerCase() === alias)) {
      return `networkAlias '${alias}' is already in use`
    }
    instance.networkAlias = alias
  }
  const c = body.config
  if (c) {
    if (c.image !== undefined) {
      if (typeof c.image !== 'string') return 'config.image must be a string'
      instance.config.image = c.image.trim()
    }
    if (c.command !== undefined) {
      if (!Array.isArray(c.command) || c.command.some((v) => typeof v !== 'string')) {
        return 'config.command must be an array of strings'
      }
      instance.config.command = c.command
    }
    if (c.env !== undefined) {
      if (typeof c.env !== 'object' || c.env === null || Array.isArray(c.env)) {
        return 'config.env must be an object of string values'
      }
      instance.config.env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)]))
    }
    if (c.containerPorts !== undefined) {
      if (
        !Array.isArray(c.containerPorts) ||
        c.containerPorts.some((p) => !Number.isInteger(Number(p)) || Number(p) < 1 || Number(p) > 65535)
      ) {
        return 'config.containerPorts must be a list of ports'
      }
      instance.config.containerPorts = c.containerPorts.map(Number)
    }
    if (c.publishToHost !== undefined) {
      if (typeof c.publishToHost !== 'boolean') return 'config.publishToHost must be a boolean'
      instance.config.publishToHost = c.publishToHost
    }
    if (c.mountPath !== undefined) {
      if (typeof c.mountPath !== 'string') return 'config.mountPath must be a string'
      if (c.mountPath && !c.mountPath.startsWith('/')) {
        return 'config.mountPath must be an absolute container path (or empty for no mount)'
      }
      instance.config.mountPath = c.mountPath
    }
    if (c.memoryMb !== undefined) {
      const m = Number(c.memoryMb)
      if (m && (!Number.isInteger(m) || m < 64)) return 'config.memoryMb must be an integer >= 64 (0 clears)'
      if (m) instance.config.memoryMb = m
      else delete instance.config.memoryMb
    }
    if (c.cpus !== undefined) {
      const cp = Number(c.cpus)
      if (cp && (!Number.isFinite(cp) || cp <= 0 || cp > 64)) return 'config.cpus must be > 0 and <= 64 (0 clears)'
      if (cp) instance.config.cpus = cp
      else delete instance.config.cpus
    }
  }
  if (instance.config.publishToHost) {
    const missing = instance.config.containerPorts.filter((cp) => !(String(cp) in instance.config.hostPorts))
    if (missing.length) {
      const assigned = nextFreeHostPorts(missing.length)
      missing.forEach((cp, i) => {
        instance.config.hostPorts[String(cp)] = assigned[i]
      })
    }
  }
  return null
}

export default async function mcpToolInstanceRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ instances: db.mcpToolInstances }))

  app.get('/:id', async (req, reply) => {
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    return instance
  })

  app.post('/', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { defId, name, networkAlias } = (req.body ?? {}) as {
      defId?: string
      name?: string
      networkAlias?: string
    }
    const def = db.mcpTools.find((d) => d.id === defId)
    if (!def) return reply.code(400).send({ error: 'valid defId is required' })
    const instance: McpToolInstance = {
      id: newId(),
      defId: def.id,
      name: name?.trim() || def.name,
      networkAlias: nextAvailableAlias(def.name, db.mcpToolInstances.map((i) => i.networkAlias)),
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
      },
      createdAt: new Date().toISOString(),
    }
    if (networkAlias?.trim()) {
      const err = applyBody(instance, { networkAlias })
      if (err) return reply.code(400).send({ error: err })
    }
    db.mcpToolInstances.push(instance)
    save()
    return reply.code(201).send(instance)
  })

  app.patch('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    const err = applyBody(instance, (req.body ?? {}) as Partial<McpToolInstance>)
    if (err) return reply.code(400).send({ error: err })
    save()
    return instance
  })

  app.delete('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { id } = req.params as { id: string }
    const instance = db.mcpToolInstances.find((i) => i.id === id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    try {
      await removeToolContainer(id)
    } catch {
      // docker unavailable — record still goes away
    }
    if (instance.config.image) await removeContainerStorage(instance.config.image, mcpToolDir(id))
    db.mcpToolInstances = db.mcpToolInstances.filter((i) => i.id !== id)
    save()
    return reply.code(204).send()
  })

  app.get('/:id/container', async (req, reply) => {
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    if (!(await dockerAvailable())) return { available: false, exists: false }
    return { available: true, ...(await toolContainerInfo(instance.id)) }
  })

  app.get('/:id/container/logs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      return { logs: await toolContainerLogs(instance.id) }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'no container for this instance yet' })
      }
      throw err
    }
  })

  app.post('/:id/container/:action', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    const { action } = req.params as { action: string }
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      if (action === 'start') {
        if (!instance.config.image.trim() || !instance.networkAlias.trim()) {
          return reply.code(400).send({ error: 'set an image and a network alias before starting' })
        }
        return { available: true, ...(await startToolContainer(instance)) }
      }
      if (action === 'stop') return { available: true, ...(await stopToolContainer(instance.id)) }
      if (action === 'restart') return { available: true, ...(await restartToolContainer(instance.id)) }
      if (action === 'remove') return { available: true, ...(await removeToolContainer(instance.id)) }
      return reply.code(400).send({ error: `unknown action '${action}' (start|stop|restart|remove)` })
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `docker ${action} failed: ${(err as Error).message}` })
    }
  })

  /** Remove + recreate + start in one step so image/env/port changes apply. */
  app.post('/:id/regenerate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const instance = db.mcpToolInstances.find((i) => i.id === (req.params as { id: string }).id)
    if (!instance) return reply.code(404).send({ error: 'instance not found' })
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      await removeToolContainer(instance.id)
    } catch {
      // best-effort — proceed to start regardless
    }
    try {
      return { available: true, ...(await startToolContainer(instance)) }
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `regenerate failed: ${(err as Error).message}` })
    }
  })
}
