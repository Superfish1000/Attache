import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db, save } from '../store.js'
import {
  agentFileDefs,
  containerDefFor,
  createAgent,
  deleteAgent,
  readAgentDoc,
  resetAgentFiles,
  syncAgentPorts,
  writeAgentDoc,
} from '../agents.js'
import {
  containerInfo,
  containerLogs,
  dockerAvailable,
  listAgentCron,
  provisionMcpServers,
  readAgentCron,
  readAgentFileViaDocker,
  readMcpLoginLog,
  removeAgentStorage,
  writeAgentCron,
  writeAgentFileViaDocker,
  removeAgentContainer,
  startAgentContainer,
  startMcpLogin,
  stopAgentContainer,
} from '../docker.js'
import { canAccessAgent, requireAdmin } from '../auth.js'
import type { Agent, AgentConfig } from '../types.js'

export default async function agentRoutes(app: FastifyInstance) {
  /** 404s (not 403) for foreign agents so ids aren't probeable. Returns null after replying. */
  const accessibleAgent = (req: FastifyRequest, reply: FastifyReply): Agent | null => {
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent || !canAccessAgent(req.user!, agent)) {
      reply.code(404).send({ error: 'agent not found' })
      return null
    }
    return agent
  }

  app.get('/', async (req) =>
    req.user!.role === 'admin' ? db.agents : db.agents.filter((a) => a.userId === req.user!.id),
  )

  app.post('/', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { userId, name, containerId, config } = (req.body ?? {}) as {
      userId?: string
      name?: string
      containerId?: string
      config?: Partial<AgentConfig>
    }
    if (!userId || !db.users.some((u) => u.id === userId)) {
      return reply.code(400).send({ error: 'valid userId is required' })
    }
    if (containerId && !db.containers.some((c) => c.id === containerId)) {
      return reply.code(400).send({ error: 'unknown container definition' })
    }
    try {
      return reply.code(201).send(createAgent(userId, name, containerId, config))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/:id', async (req, reply) => accessibleAgent(req, reply) ?? reply)

  app.patch('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const agent = db.agents.find((a) => a.id === (req.params as { id: string }).id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const { name, containerId, config } = (req.body ?? {}) as {
      name?: string
      containerId?: string
      config?: Partial<AgentConfig>
    }
    if (name?.trim()) agent.name = name.trim()
    if (containerId !== undefined) {
      if (!db.containers.some((c) => c.id === containerId)) {
        return reply.code(400).send({ error: 'unknown container definition' })
      }
      agent.containerId = containerId
    }
    if (config) {
      if (config.image !== undefined) agent.config.image = config.image
      if (config.command !== undefined) {
        if (!Array.isArray(config.command) || config.command.some((c) => typeof c !== 'string')) {
          return reply.code(400).send({ error: 'config.command must be an array of strings' })
        }
        agent.config.command = config.command
      }
      if (config.env !== undefined) {
        if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
          return reply.code(400).send({ error: 'config.env must be an object of string values' })
        }
        agent.config.env = Object.fromEntries(
          Object.entries(config.env).map(([k, v]) => [k, String(v)]),
        )
      }
      if (config.mountPath !== undefined) {
        if (typeof config.mountPath !== 'string' || !config.mountPath.startsWith('/')) {
          return reply.code(400).send({ error: 'config.mountPath must be an absolute container path' })
        }
        agent.config.mountPath = config.mountPath
      }
      if (config.ports !== undefined) {
        if (typeof config.ports !== 'object' || config.ports === null || Array.isArray(config.ports)) {
          return reply.code(400).send({ error: 'config.ports must map containerPort to hostPort' })
        }
        const ports: Record<string, number> = {}
        for (const [cp, hp] of Object.entries(config.ports)) {
          const cpN = Number(cp)
          const hpN = Number(hp)
          if (!Number.isInteger(cpN) || !Number.isInteger(hpN) || hpN < 1 || hpN > 65535 || cpN < 1 || cpN > 65535) {
            return reply.code(400).send({ error: `invalid port mapping ${cp}:${String(hp)}` })
          }
          ports[String(cpN)] = hpN
        }
        agent.config.ports = ports
      }
      if (config.memoryMb !== undefined) {
        const m = Number(config.memoryMb)
        if (m && (!Number.isInteger(m) || m < 64)) {
          return reply.code(400).send({ error: 'config.memoryMb must be an integer >= 64 (0 clears)' })
        }
        if (m) agent.config.memoryMb = m
        else delete agent.config.memoryMb
      }
      if (config.cpus !== undefined) {
        const c = Number(config.cpus)
        if (c && (!Number.isFinite(c) || c <= 0 || c > 64)) {
          return reply.code(400).send({ error: 'config.cpus must be > 0 and <= 64 (0 clears)' })
        }
        if (c) agent.config.cpus = c
        else delete agent.config.cpus
      }
      if (config.shmSizeMb !== undefined) {
        const s = Number(config.shmSizeMb)
        if (s && (!Number.isInteger(s) || s < 1)) {
          return reply.code(400).send({ error: 'config.shmSizeMb must be an integer >= 1 (0 clears)' })
        }
        if (s) agent.config.shmSizeMb = s
        else delete agent.config.shmSizeMb
      }
    }
    save()
    return agent
  })

  app.delete('/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const { id } = req.params as { id: string }
    if (!db.agents.some((a) => a.id === id)) return reply.code(404).send({ error: 'agent not found' })
    const agent = db.agents.find((a) => a.id === id)!
    try {
      await removeAgentContainer(id)
    } catch {
      // docker unavailable — record still goes away
    }
    await removeAgentStorage(agent)
    deleteAgent(id)
    return reply.code(204).send()
  })

  // behavior files come from the agent's container definition — owner-editable
  app.get('/:id/docs', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    return {
      docs: agentFileDefs(agent).map(({ key, label, path, hint }) => ({ key, label, path, hint })),
    }
  })

  app.get('/:id/doc/:key', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const key = (req.params as { key: string }).key
    const doc = readAgentDoc(agent, key)
    if (doc === null) return reply.code(404).send({ error: 'unknown doc' })
    if (doc.missing || doc.unreadable) {
      // "missing" is not trustworthy: an unsearchable container-owned parent
      // dir makes existsSync say false for files that exist. Check through
      // docker before reporting either state.
      const path = agentFileDefs(agent).find((f) => f.key === key)?.path
      const via = path ? await readAgentFileViaDocker(agent, path) : null
      if (via !== null) return { content: via, missing: false, viaContainer: true }
    }
    return doc
  })

  app.put('/:id/doc/:key', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) required' })
    const docKey = (req.params as { key: string }).key
    const fileDef = agentFileDefs(agent).find((f) => f.key === docKey)
    if (!fileDef) return reply.code(404).send({ error: 'unknown doc' })
    try {
      if (!writeAgentDoc(agent, docKey, content)) {
        return reply.code(404).send({ error: 'unknown doc' })
      }
    } catch {
      // host write blocked (container-owned file) — write through the daemon
      if (!(await writeAgentFileViaDocker(agent, fileDef.path, content))) {
        return reply.code(500).send({
          error:
            'file not writable: host permissions block it and the container write failed — is the container running?',
        })
      }
    }
    return { ok: true }
  })

  // hermes cron jobs — one file per job under cron/ (docker fallback for
  // container-owned dirs, same as the behavior-file editors)
  app.get('/:id/cron', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    return { jobs: await listAgentCron(agent) }
  })

  app.get('/:id/cron/:file', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    try {
      return { content: await readAgentCron(agent, (req.params as { file: string }).file) }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.put('/:id/cron/:file', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { content } = (req.body ?? {}) as { content?: string }
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) required' })
    try {
      await writeAgentCron(agent, (req.params as { file: string }).file, content)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/:id/container', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) return { available: false, exists: false }
    return { available: true, ...(await containerInfo(agent.id)) }
  })

  app.get('/:id/container/logs', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      return { logs: await containerLogs(agent.id) }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'no container for this agent yet' })
      }
      throw err
    }
  })

  /** Remove + recreate + start in one step so env/port/definition changes apply. */
  app.post('/:id/container/regenerate', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { resetFiles } = (req.body ?? {}) as { resetFiles?: boolean }
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      syncAgentPorts(agent)
      await removeAgentContainer(agent.id)
      const filesReset = resetFiles ? resetAgentFiles(agent) : []
      const info = await startAgentContainer(agent)
      void provisionMcpServers(agent).catch(() => undefined) // best-effort background
      return { available: true, ...info, filesReset }
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `regenerate failed: ${(err as Error).message}` })
    }
  })

  /**
   * Chat with the agent through its OpenAI-compatible gateway — a warm,
   * long-running process inside the container, so no per-message cold start.
   * Conversation history comes from the client; the stream is SSE passthrough.
   */
  app.post('/:id/chat', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { messages, stream } = (req.body ?? {}) as {
      messages?: Array<{ role: string; content: string }>
      stream?: boolean
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages array required' })
    }
    const merged = {
      ...db.settings.docker.defaultEnv,
      ...(containerDefFor(agent)?.env ?? {}),
      ...agent.config.env,
    }
    const gatewayPort = merged.API_SERVER_PORT ?? '8642'
    const hostPort = agent.config.ports[gatewayPort] ?? Object.values(agent.config.ports)[0]
    if (!hostPort) {
      return reply.code(400).send({ error: 'no gateway port mapped for this agent' })
    }
    let upstream: Response
    try {
      upstream = await fetch(`http://127.0.0.1:${hostPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(merged.API_SERVER_KEY ? { authorization: `Bearer ${merged.API_SERVER_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: 'hermes-agent',
          messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
          stream: Boolean(stream),
        }),
      })
    } catch {
      return reply.code(502).send({
        error:
          'agent gateway unreachable — the container may be stopped, or still booting (the gateway takes about a minute after start)',
      })
    }
    if (!stream || !upstream.ok || !upstream.body) {
      const text = await upstream.text()
      return reply
        .code(upstream.status)
        .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
        .send(text)
    }
    // hijack: from here the raw socket is ours — fastify must not try to reply on errors
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    })
    const reader = upstream.body.getReader()
    let clientGone = false
    const onClose = () => {
      clientGone = true
      reader.cancel().catch(() => undefined) // stop the agent generating for a dead client
    }
    req.raw.on('close', onClose)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || clientGone) break
        reply.raw.write(Buffer.from(value))
      }
    } catch {
      // upstream died mid-stream — end with what we have
    } finally {
      req.raw.off('close', onClose)
      if (!reply.raw.writableEnded) reply.raw.end()
    }
    return reply
  })

  /** Owner-visible MCP facts: configured servers + whether a sign-in flow exists. */
  app.get('/:id/mcp/info', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const def = db.containers.find((c) => c.id === agent.containerId)
    return {
      servers: (def?.mcpServers ?? []).map((s) => s.name),
      hasLogin: Boolean(def?.mcpLoginCommand.trim()),
    }
  })

  /**
   * Owner-accessible: start the definition's interactive MCP sign-in (device
   * code flow) and return the captured instructions.
   */
  app.post('/:id/mcp/login', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    const info = await containerInfo(agent.id)
    if (!info.exists || !info.running) {
      return reply.code(409).send({ error: 'agent container is not running — start it first' })
    }
    try {
      const owner = db.users.find((u) => u.id === agent.userId)
      return { output: await startMcpLogin(agent, owner) }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /**
   * Owner-accessible: tail of the last sign-in's output WITHOUT restarting
   * the flow — pressing sign-in again invalidates the pending device code,
   * so status checks must not re-run it.
   */
  app.get('/:id/mcp/login-log', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const output = await readMcpLoginLog(agent)
    return { output: output || 'no sign-in output found — run MCP sign-in first' }
  })

  /** Re-run the definition's MCP provisioning and return per-server results. */
  app.post('/:id/mcp/provision', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    const info = await containerInfo(agent.id)
    if (!info.exists || !info.running) {
      return reply.code(409).send({ error: 'agent container is not running — start it first' })
    }
    return { results: await provisionMcpServers(agent) }
  })

  app.post('/:id/container/:action', async (req, reply) => {
    const agent = accessibleAgent(req, reply)
    if (!agent) return reply
    const { action } = req.params as { action: string }
    if (action === 'remove' && !requireAdmin(req, reply)) return reply
    if (!(await dockerAvailable())) {
      return reply.code(503).send({ error: 'Docker daemon is not available' })
    }
    try {
      if (action === 'start') {
        // bindings only apply at container creation — syncing for an existing container
        // would record mappings docker never made (use Regenerate to apply new ports)
        if (!(await containerInfo(agent.id)).exists) syncAgentPorts(agent)
        const info = await startAgentContainer(agent)
        void provisionMcpServers(agent).catch(() => undefined) // best-effort background
        return { available: true, ...info }
      }
      if (action === 'stop') return { available: true, ...(await stopAgentContainer(agent.id)) }
      if (action === 'remove') return { available: true, ...(await removeAgentContainer(agent.id)) }
      return reply.code(400).send({ error: `unknown action '${action}' (start|stop|remove)` })
    } catch (err) {
      req.log.error(err)
      return reply.code(500).send({ error: `docker ${action} failed: ${(err as Error).message}` })
    }
  })
}
