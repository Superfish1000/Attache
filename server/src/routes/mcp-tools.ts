import type { FastifyInstance } from 'fastify'
import { db, newId, save } from '../store.js'
import { requireAdmin } from '../auth.js'
import { buildDockerfileImage, pullImage } from '../docker-build.js'
import { checkImageUpdate, firstFromImage } from '../image-updates.js'
import { dockerAvailable, removeToolContainer, startToolContainer } from '../docker.js'
import type { ImageUpdateCheck, McpToolContainerDef } from '../types.js'

type UpdateMode = 'stage' | 'update' | 'update-regen'

interface Regenerated {
  instanceId: string
  ok: boolean
  error?: string
}

/** The image this definition's "check for updates" / "upgrade" acts on: the Dockerfile's FROM image, or the definition's own image if there's no Dockerfile. */
export function checkedImageFor(def: McpToolContainerDef): string | null {
  if (def.dockerfile.trim()) return firstFromImage(def.dockerfile)
  return def.image.trim() || null
}

/** Runs a check, persists it onto the definition (so the UI's light survives a reload / reflects scheduled checks), and returns it. Exported for the scheduler's sweep. */
export async function checkAndPersist(def: McpToolContainerDef): Promise<ImageUpdateCheck> {
  const image = checkedImageFor(def)
  const check: ImageUpdateCheck = image
    ? await checkImageUpdate(image)
    : { status: 'unknown', checkedImage: '', error: 'no image to check' }
  def.lastUpdateCheck = { ...check, checkedAt: new Date().toISOString() }
  save()
  return check
}

/**
 * stage = pull only. update = pull + rebuild (or just pull, for a
 * non-Dockerfile definition). update-regen additionally
 * remove+recreate+starts every instance of this definition, same steps as
 * the existing per-instance regenerate route.
 */
export async function applyImageUpdate(def: McpToolContainerDef, image: string, mode: UpdateMode) {
  const pull = await pullImage(image)
  if (mode === 'stage') return { ok: pull.ok, mode, pull: pull.output, regenerated: [] as Regenerated[] }

  const build = def.dockerfile.trim()
    ? await buildDockerfileImage(def.image, def.dockerfile, `attache-tool-build-${def.id}`, db.settings.docker.securityOpt)
    : undefined

  const regenerated: Regenerated[] = []
  if (mode === 'update-regen') {
    for (const instance of db.mcpToolInstances.filter((i) => i.defId === def.id)) {
      try {
        await removeToolContainer(instance.id)
        await startToolContainer(instance)
        regenerated.push({ instanceId: instance.id, ok: true })
      } catch (err) {
        regenerated.push({ instanceId: instance.id, ok: false, error: (err as Error).message })
      }
    }
  }
  return { ok: pull.ok && (build?.ok ?? true), mode, pull: pull.output, build, regenerated }
}

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

  /** On-demand by default (via this route) — checks the registry's current digest against what's cached locally, persisting the result. Also driven on a schedule if settings.imageUpdates.autoCheckHours is set. */
  app.get('/:id/update-check', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    return checkAndPersist(def)
  })

  app.post('/:id/update', async (req, reply) => {
    const def = db.mcpTools.find((t) => t.id === (req.params as { id: string }).id)
    if (!def) return reply.code(404).send({ error: 'tool container definition not found' })
    const { mode } = (req.body ?? {}) as { mode?: string }
    if (!mode || !['stage', 'update', 'update-regen'].includes(mode)) {
      return reply.code(400).send({ error: "mode must be 'stage', 'update', or 'update-regen'" })
    }
    const image = checkedImageFor(def)
    if (!image) return reply.code(400).send({ error: 'no image to check/pull for this definition' })
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker daemon is not available' })
    try {
      const result = await applyImageUpdate(def, image, mode as UpdateMode)
      save()
      return result
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `update failed: ${(err as Error).message}` })
    }
  })

  /** Checks every definition, then applies `mode` only to the ones actually found behind. */
  app.post('/update-all', async (req, reply) => {
    const { mode } = (req.body ?? {}) as { mode?: string }
    if (!mode || !['stage', 'update', 'update-regen'].includes(mode)) {
      return reply.code(400).send({ error: "mode must be 'stage', 'update', or 'update-regen'" })
    }
    if (!(await dockerAvailable())) return reply.code(503).send({ error: 'Docker daemon is not available' })
    return { results: await sweepAndApply(mode as UpdateMode) }
  })
}

/**
 * Checks every MCP tool container definition, then applies `mode` only to
 * the ones found behind — the shared core of the bulk "/update-all" route
 * and the scheduler's periodic sweep (scheduler.ts).
 */
export async function sweepAndApply(mode: UpdateMode) {
  const results: Array<{ defId: string; name: string; skipped?: string; result?: unknown; error?: string }> = []
  for (const def of db.mcpTools) {
    const image = checkedImageFor(def)
    if (!image) {
      results.push({ defId: def.id, name: def.name, skipped: 'no image to check' })
      continue
    }
    const check = await checkAndPersist(def)
    if (check.status !== 'behind') {
      results.push({ defId: def.id, name: def.name, skipped: check.status })
      continue
    }
    try {
      results.push({ defId: def.id, name: def.name, result: await applyImageUpdate(def, image, mode) })
    } catch (err) {
      results.push({ defId: def.id, name: def.name, error: (err as Error).message })
    }
  }
  save()
  return results
}
