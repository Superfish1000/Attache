import Docker from 'dockerode'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import type { Agent } from './types.js'
import { agentDir, upsertAgentEnv } from './agents.js'
import { db } from './store.js'

/** Fresh handle per call so a settings change takes effect without a restart. Construction is cheap. */
function getDocker(): Docker {
  const socketPath = db.settings.docker.socketPath
  return socketPath ? new Docker({ socketPath }) : new Docker() // win32 default: //./pipe/docker_engine
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping()
    return true
  } catch {
    return false
  }
}

const nameFor = (agentId: string) => `attache-agent-${agentId}`

export interface ContainerInfo {
  exists: boolean
  running?: boolean
  state?: string
  containerId?: string
  image?: string
}

export async function containerInfo(agentId: string): Promise<ContainerInfo> {
  try {
    const insp = await getDocker().getContainer(nameFor(agentId)).inspect()
    return {
      exists: true,
      running: insp.State.Running,
      state: insp.State.Status,
      containerId: insp.Id.slice(0, 12),
      image: insp.Config.Image,
    }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return { exists: false }
    throw err
  }
}

async function pullIfMissing(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // not present locally — pull below
  }
  if (!db.settings.docker.autoPull) {
    throw new Error(`image '${image}' is not present locally and auto-pull is disabled`)
  }
  await new Promise<void>((resolvePull, reject) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err)
      docker.modem.followProgress(stream, (doneErr: unknown) =>
        doneErr ? reject(doneErr) : resolvePull(),
      )
    })
  })
}

export async function startAgentContainer(agent: Agent): Promise<ContainerInfo> {
  const docker = getDocker()
  const info = await containerInfo(agent.id)
  if (info.exists) {
    try {
      await docker.getContainer(nameFor(agent.id)).start()
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err // 304 = already running
    }
    return containerInfo(agent.id)
  }
  await pullIfMissing(docker, agent.config.image)
  const cfg = agent.config
  const bindSrc = resolve(agentDir(agent.id)).replace(/\\/g, '/')
  const mountPath = cfg.mountPath || '/agent'
  // env layers: universal settings -> container definition -> per-agent (agent wins)
  const def = db.containers.find((c) => c.id === agent.containerId)
  const env = Object.entries({
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    ...db.settings.docker.defaultEnv,
    ...(def?.env ?? {}),
    ...cfg.env,
  })
  const exposed: Record<string, object> = {}
  const bindings: Record<string, Array<{ HostPort: string }>> = {}
  for (const [containerPort, hostPort] of Object.entries(cfg.ports)) {
    exposed[`${containerPort}/tcp`] = {}
    bindings[`${containerPort}/tcp`] = [{ HostPort: String(hostPort) }]
  }
  const container = await docker.createContainer({
    name: nameFor(agent.id),
    Image: cfg.image,
    Cmd: cfg.command,
    Env: env.map(([k, v]) => `${k}=${v}`),
    Labels: { 'attache.managed': 'true', 'attache.agent.id': agent.id },
    ExposedPorts: exposed,
    HostConfig: {
      Binds: [`${bindSrc}:${mountPath}`],
      PortBindings: bindings,
      RestartPolicy: { Name: db.settings.docker.restartPolicy },
      ...(db.settings.docker.securityOpt.length
        ? { SecurityOpt: db.settings.docker.securityOpt }
        : {}),
      ...(cfg.memoryMb ? { Memory: cfg.memoryMb * 1024 * 1024 } : {}),
      ...(cfg.cpus ? { NanoCpus: Math.round(cfg.cpus * 1e9) } : {}),
    },
  })
  await container.start()
  return containerInfo(agent.id)
}

/**
 * Restarts the agent's dashboard service so it re-reads provisioned creds
 * (s6 relaunches it after --stop). Best-effort: throws only never — callers
 * fire-and-forget after password changes.
 */
export async function bounceDashboard(agentId: string): Promise<void> {
  try {
    const container = getDocker().getContainer(nameFor(agentId))
    const exec = await container.exec({
      Cmd: ['/opt/hermes/.venv/bin/hermes', 'dashboard', '--stop'],
      User: 'hermes',
      Env: ['HOME=/opt/data'],
      AttachStdout: false,
      AttachStderr: false,
    })
    await exec.start({ Detach: true })
  } catch {
    // container stopped / not hermes / daemon down — creds apply on next start
  }
}

export interface McpProvisionResult {
  name: string
  ok: boolean
  output: string
}

/**
 * Runs the definition's MCP provision-command template once per configured
 * server inside the agent's container. Generic: the template is
 * runtime-specific shell ({{NAME}}/{{URL}} substituted), executed as root
 * via sh -c — templates drop privileges themselves where needed.
 */
export async function provisionMcpServers(agent: Agent): Promise<McpProvisionResult[]> {
  const def = db.containers.find((c) => c.id === agent.containerId)
  if (!def?.mcpProvisionCommand.trim() || def.mcpServers.length === 0) return []
  const container = getDocker().getContainer(nameFor(agent.id))
  const results: McpProvisionResult[] = []
  for (const server of def.mcpServers) {
    // pre-write the token to the agent's .env so runtimes that read it from
    // there (hermes) find it and skip their interactive auth prompt
    if (server.authToken && def.mcpTokenEnvKey.trim()) {
      const nameUpper = server.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
      const envKey = def.mcpTokenEnvKey.replaceAll('{{NAME_UPPER}}', nameUpper)
      upsertAgentEnv(agent.id, { [envKey]: server.authToken })
    }
    const cmd = def.mcpProvisionCommand
      .replaceAll('{{NAME}}', server.name)
      .replaceAll('{{URL}}', server.url)
      .replaceAll('{{TOKEN}}', server.authToken)
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
      })
      const stream = await exec.start({ hijack: true, stdin: false })
      const bufs: Buffer[] = []
      const sink = new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          bufs.push(Buffer.from(chunk))
          cb()
        },
      })
      getDocker().modem.demuxStream(stream, sink, sink)
      // hijacked exec streams never emit 'end' on some daemons (observed on
      // 20.10.x) — poll the exec state for completion instead, capped at 2 min
      let inspect = await exec.inspect()
      for (let tick = 0; inspect.Running && tick < 120; tick++) {
        await new Promise((res) => setTimeout(res, 1000))
        inspect = await exec.inspect()
      }
      try {
        stream.destroy()
      } catch {
        // already closed
      }
      if (inspect.Running) {
        results.push({ name: server.name, ok: false, output: 'timed out after 120s' })
        continue
      }
      const output = Buffer.concat(bufs)
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .trim()
        .slice(-500)
      results.push({ name: server.name, ok: inspect.ExitCode === 0, output })
    } catch (err) {
      results.push({ name: server.name, ok: false, output: (err as Error).message.slice(0, 300) })
    }
  }
  return results
}

/** Tail of container output with docker's stream-multiplex headers stripped. */
export async function containerLogs(agentId: string, tail = 200): Promise<string> {
  const buf = (await getDocker()
    .getContainer(nameFor(agentId))
    .logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer
  if (buf.length === 0) return ''
  // multiplexed frames: [type, 0, 0, 0, len(4BE), payload]; raw output if TTY
  if (buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) return buf.toString('utf8')
  const parts: string[] = []
  let off = 0
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4)
    parts.push(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
    off += 8 + len
  }
  return parts.join('')
}

export async function stopAgentContainer(agentId: string): Promise<ContainerInfo> {
  try {
    await getDocker().getContainer(nameFor(agentId)).stop({ t: 5 })
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode
    if (code !== 304 && code !== 404) throw err // 304 = already stopped
  }
  return containerInfo(agentId)
}

export async function removeAgentContainer(agentId: string): Promise<ContainerInfo> {
  try {
    await getDocker().getContainer(nameFor(agentId)).remove({ force: true })
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err
  }
  return { exists: false }
}

export interface ManagedContainer {
  containerId: string
  agentId: string | undefined
  image: string
  state: string
  status: string
  names: string[]
}

export async function listManagedContainers(): Promise<ManagedContainer[]> {
  const list = await getDocker().listContainers({
    all: true,
    filters: { label: ['attache.managed=true'] },
  })
  return list.map((c) => ({
    containerId: c.Id.slice(0, 12),
    agentId: c.Labels['attache.agent.id'],
    image: c.Image,
    state: c.State,
    status: c.Status,
    names: c.Names,
  }))
}
