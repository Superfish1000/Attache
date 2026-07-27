import Docker from 'dockerode'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import type { Agent } from './types.js'
import { agentDir } from './agents.js'
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

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function execInAgent(agent: Agent, cmd: string[]): Promise<ExecResult> {
  const container = getDocker().getContainer(nameFor(agent.id))
  const exec = await container.exec({
    Cmd: cmd,
    User: 'hermes', // root-written session files would break the supervised gateway
    Env: ['HOME=/opt/data'],
    AttachStdout: true,
    AttachStderr: true,
  })
  const stream = await exec.start({ hijack: true, stdin: false })
  const out: Buffer[] = []
  const err: Buffer[] = []
  const sink = (bufs: Buffer[]) =>
    new Writable({
      write(chunk, _enc, cb) {
        bufs.push(Buffer.from(chunk))
        cb()
      },
    })
  // Old daemons (20.10.x named pipe) never emit end/close on hijacked exec
  // streams, so completion is detected by polling exec.inspect().Running.
  const CHAT_TIMEOUT_MS = 10 * 60_000
  await new Promise<void>((resolveDone, reject) => {
    getDocker().modem.demuxStream(stream, sink(out), sink(err))
    let settled = false
    const finish = (fail?: Error) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(cap)
      stream.destroy()
      fail ? reject(fail) : resolveDone()
    }
    stream.on('end', () => finish())
    stream.on('close', () => finish())
    stream.on('error', (e: Error) => finish(e))
    const poll = setInterval(() => {
      exec
        .inspect()
        .then((i) => {
          // grace period lets trailing output flush before we stop reading
          if (i.Running === false) setTimeout(() => finish(), 300)
        })
        .catch(() => undefined)
    }, 1000)
    const cap = setTimeout(() => finish(new Error('agent chat timed out')), CHAT_TIMEOUT_MS)
  })
  const inspect = await exec.inspect()
  const strip = (b: Buffer) =>
    b
      .toString('utf8')
      // ANSI colors/cursor sequences from the CLI renderer
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return {
    exitCode: inspect.ExitCode ?? 0,
    stdout: strip(Buffer.concat(out)),
    stderr: strip(Buffer.concat(err)),
  }
}

/**
 * Chat with the agent via its CLI inside the container (`hermes chat -q -Q`).
 * This Hermes build ships no HTTP inference endpoint — the messaging gateway,
 * dashboard backend and OAuth proxy are all something else — so the CLI is the
 * supported programmatic transport. Conversation context lives in a hermes
 * session per Attache user; the session id is kept in the agent's data dir.
 */
export async function execAgentChat(agent: Agent, text: string, userId: string): Promise<string> {
  const sessFile = join(agentDir(agent.id), '.attache', `chat-${userId}.session`)
  const prev = existsSync(sessFile) ? readFileSync(sessFile, 'utf8').trim() : ''
  const base = ['/opt/hermes/.venv/bin/hermes', 'chat', '-q', text, '-Q']
  let res = await execInAgent(agent, prev ? [...base, '--resume', prev] : base)
  if (res.exitCode !== 0 && prev && /No session found/i.test(res.stdout + res.stderr)) {
    // agent pruned the session — start a fresh thread
    res = await execInAgent(agent, base)
  }
  const raw = res.stdout
  // -Q prints the session id on stderr; older formats used stdout ("Session:")
  const sessionMatch = /(?:^|\n)\s*(?:Session|session_id):\s*(\S+)/.exec(
    raw + '\n' + res.stderr,
  )
  if (sessionMatch) {
    mkdirSync(dirname(sessFile), { recursive: true })
    writeFileSync(sessFile, sessionMatch[1])
  }
  let content = raw
  for (const marker of [
    /\nResume this session with:[\s\S]*$/,
    /\n\s*Session:\s[\s\S]*$/,
    /\n?\s*session_id:[\s\S]*$/,
  ]) {
    content = content.replace(marker, '')
  }
  content = content
    // ⚠ warnings wrap to a short continuation line (e.g. "... for \nanthropic.")
    .replace(/^\s*⚠.*(?:\n[a-z0-9_./-]+\.)?/gim, '')
    .trim()
  if (res.exitCode !== 0) {
    throw new Error((content || res.stderr.trim() || 'agent chat failed').slice(-400))
  }
  return content
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
