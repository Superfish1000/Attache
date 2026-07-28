import Docker from 'dockerode'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import type { Agent, User } from './types.js'
import {
  agentDir,
  mergeDashboardEnv,
  mergeEnvLines,
  upsertAgentEnv,
  writeDashboardCreds,
} from './agents.js'
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

/**
 * Last-resort read: mounts the agent's data dir read-only into a throwaway
 * container and cats the file — the daemon accesses the host dir as root, so
 * this works with the agent container stopped or missing and with host dirs
 * the runtime made unsearchable. ~1–2s; only used when cheaper paths failed.
 */
async function readViaEphemeralMount(agent: Agent, relPath: string): Promise<string | null> {
  let scratch: Docker.Container | null = null
  try {
    const docker = getDocker()
    const bindSrc = resolve(agentDir(agent.id)).replace(/\\/g, '/')
    scratch = await docker.createContainer({
      Image: agent.config.image,
      Entrypoint: ['cat'],
      Cmd: [`/attache-ro/${relPath}`],
      HostConfig: { Binds: [`${bindSrc}:/attache-ro:ro`], NetworkMode: 'none' },
    })
    await scratch.start()
    const done = (await scratch.wait()) as { StatusCode?: number }
    if (done.StatusCode !== 0) return null
    const raw = (await scratch.logs({ stdout: true, stderr: false, follow: false })) as unknown as Buffer
    // strip the log stream's 8-byte multiplex frame headers
    const parts: Buffer[] = []
    let off = 0
    while (off + 8 <= raw.length) {
      const size = raw.readUInt32BE(off + 4)
      parts.push(raw.subarray(off + 8, off + 8 + size))
      off += 8 + size
    }
    return Buffer.concat(parts).toString('utf8')
  } catch {
    return null
  } finally {
    if (scratch) void scratch.remove({ force: true }).catch(() => undefined)
  }
}

/**
 * Reads a file from the agent's data dir through the Docker daemon.
 * Primary: getArchive from the running container (cheap). When the container
 * is stopped or gone — its bind mount inactive — falls back to an ephemeral
 * mount of the agent dir. Returns null only when the file really isn't there
 * (or docker is down).
 */
export async function readAgentFileViaDocker(agent: Agent, relPath: string): Promise<string | null> {
  const rel = relPath.replaceAll('\\', '/')
  try {
    const container = getDocker().getContainer(nameFor(agent.id))
    const inPath = `${agent.config.mountPath.replace(/\/+$/, '')}/${rel}`
    const stream = await container.getArchive({ path: inPath })
    const chunks: Buffer[] = []
    await new Promise<void>((res, rej) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', res)
      stream.on('error', rej)
    })
    const tar = Buffer.concat(chunks)
    // Minimal tar walk: return the body of the first regular-file entry.
    let off = 0
    while (off + 512 <= tar.length) {
      const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0[^]*$/, '')
      if (!name) break // zero block = end of archive
      const size = parseInt(tar.subarray(off + 124, off + 136).toString('ascii').trim() || '0', 8)
      const type = tar[off + 156]
      off += 512
      if (type === 0x30 || type === 0) {
        // Truncated archive (header only): daemon could stat but not read the
        // bytes — e.g. Docker Desktop file-sharing hitting host ACLs. Fail
        // properly instead of returning fake-empty content.
        if (off + size > tar.length) return null
        return tar.subarray(off, off + size).toString('utf8')
      }
      off += Math.ceil(size / 512) * 512
    }
    return null
  } catch {
    // getArchive failed. If the container is running, that's a genuine 404 —
    // its mount IS the host dir. Stopped or missing container: the bind mount
    // is inactive, so read via an ephemeral mount instead.
    try {
      const insp = await getDocker().getContainer(nameFor(agent.id)).inspect()
      if (insp.State?.Running) return null
    } catch {
      // no container at all — ephemeral read still works off the host dir
    }
    return readViaEphemeralMount(agent, rel)
  }
}

/** uid/gid/mode from the first tar header getArchive returns for a path. */
async function statViaArchive(
  agent: Agent,
  inPath: string,
): Promise<{ uid: number; gid: number; mode: number } | null> {
  try {
    const stream = await getDocker().getContainer(nameFor(agent.id)).getArchive({ path: inPath })
    const chunks: Buffer[] = []
    await new Promise<void>((res, rej) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', res)
      stream.on('error', rej)
    })
    const tar = Buffer.concat(chunks)
    if (tar.length < 512) return null
    const oct = (off: number, len: number) =>
      parseInt(tar.subarray(off, off + len).toString('ascii').replace(/\0/g, ' ').trim() || '0', 8)
    return { mode: oct(100, 8), uid: oct(108, 8), gid: oct(116, 8) }
  } catch {
    return null
  }
}

/** Single-file ustar archive with explicit ownership. */
function tarFor(name: string, content: Buffer, uid: number, gid: number, mode: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write((mode & 0o7777).toString(8).padStart(7, '0'), 100)
  h.write(uid.toString(8).padStart(7, '0'), 108)
  h.write(gid.toString(8).padStart(7, '0'), 116)
  h.write(content.length.toString(8).padStart(11, '0'), 124)
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136)
  h.fill(0x20, 148, 156) // checksum computed over spaces
  h[156] = 0x30 // '0' = regular file
  h.write('ustar', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([h, content, pad, Buffer.alloc(1024)])
}

/**
 * Writes a file into the agent's data dir through the Docker daemon
 * (putArchive) — for hosts where the container's internal user owns the
 * tree and blocks direct writes. Ownership is copied from the existing file
 * (or the data dir itself) so the runtime keeps write access to its own
 * files. Requires a running container: on a stopped one the bind mount
 * isn't active and the write would land in the container layer, shadowed
 * at next start. Returns false on any failure.
 */
export async function writeAgentFileViaDocker(
  agent: Agent,
  relPath: string,
  content: string,
): Promise<boolean> {
  try {
    const container = getDocker().getContainer(nameFor(agent.id))
    const insp = await container.inspect()
    if (!insp.State?.Running) return false
    const mount = agent.config.mountPath.replace(/\/+$/, '')
    const rel = relPath.replaceAll('\\', '/')
    let mode = 0o644
    let stat = await statViaArchive(agent, `${mount}/${rel}`)
    if (stat) mode = stat.mode & 0o7777 || 0o644
    else stat = await statViaArchive(agent, mount)
    if (!stat) return false
    await container.putArchive(tarFor(rel, Buffer.from(content, 'utf8'), stat.uid, stat.gid, mode), {
      path: mount,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Restores host-side access to the container-owned data dir (Linux hosts).
 * Runtimes like hermes chown their mount to an internal user at every
 * container start, locking out the account running Attaché. This execs as
 * root inside the container: group := Attaché's own gid, g+rwX, setgid on
 * dirs so files the runtime creates later inherit the group. Owner stays the
 * runtime's user — it never notices. Scheduled twice after each start since
 * the entrypoint's own chown timing varies; best-effort, no-op off Linux.
 * Files the runtime creates between fixes are group-readable (its umask);
 * they become group-writable at the next start/fix — GUI writes fall back
 * through docker meanwhile.
 */
export function scheduleMountGroupFix(agent: Agent): void {
  if (process.platform !== 'linux' || typeof process.getgid !== 'function') return
  const gid = process.getgid()
  const mount = agent.config.mountPath.replace(/\/+$/, '')
  const cmd = `chown -R :${gid} "${mount}" && chmod -R g+rwX "${mount}" && find "${mount}" -type d -exec chmod g+s {} +`
  for (const delayMs of [20_000, 120_000]) {
    setTimeout(async () => {
      try {
        const exec = await getDocker()
          .getContainer(nameFor(agent.id))
          .exec({ Cmd: ['sh', '-c', cmd], AttachStdout: false, AttachStderr: false })
        await exec.start({ Detach: true })
      } catch {
        // container stopped / docker down — the next start reschedules
      }
    }, delayMs).unref?.()
  }
}

/** Host-first .env upsert; falls back to writing through the container. */
export async function upsertAgentEnvSafe(agent: Agent, entries: Record<string, string>): Promise<void> {
  try {
    upsertAgentEnv(agent.id, entries)
    return
  } catch {
    // EACCES — container-owned tree; go through the daemon instead
  }
  const existing = await readAgentFileViaDocker(agent, '.env')
  if (existing === null) throw new Error('agent .env unreadable on host and via container')
  if (!(await writeAgentFileViaDocker(agent, '.env', mergeEnvLines(existing, entries)))) {
    throw new Error('agent .env not writable on host or via container')
  }
}

/**
 * Host-first dashboard-cred sync; falls back through the container.
 * Best-effort like the password-sync path it serves — returns false instead
 * of throwing when neither route works (creds apply on next opportunity).
 */
export async function writeDashboardCredsSafe(agent: Agent, owner: User): Promise<boolean> {
  try {
    writeDashboardCreds(agent, owner)
    return true
  } catch {
    // EACCES — container-owned tree
  }
  const existing = await readAgentFileViaDocker(agent, '.env')
  if (existing === null) return false
  const merged = mergeDashboardEnv(existing, owner)
  if (merged === null) return true
  return writeAgentFileViaDocker(agent, '.env', merged)
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
  scheduleMountGroupFix(agent)
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

/**
 * Kicks off the definition's interactive-auth bootstrap (device-code login)
 * detached inside the container, then tails its log file from the host side
 * and returns whatever appeared (sign-in URL + code). The login process keeps
 * polling in the container until the user completes it in a browser.
 */
export async function startMcpLogin(
  agent: Agent,
  owner: { email: string; name: string } | undefined,
): Promise<string> {
  const def = db.containers.find((c) => c.id === agent.containerId)
  if (!def?.mcpLoginCommand.trim()) throw new Error('no MCP sign-in command on this definition')
  const logName = '.attache-mcp-login.log'
  const logInContainer = `${agent.config.mountPath.replace(/\/$/, '')}/${logName}`
  const logOnHost = join(agentDir(agent.id), logName)
  try {
    rmSync(logOnHost, { force: true })
  } catch {
    // stale log removal is best-effort
  }
  const rendered = def.mcpLoginCommand
    .replaceAll('{{OWNER_EMAIL}}', owner?.email ?? '')
    .replaceAll('{{OWNER_NAME}}', owner?.name ?? '')
    .replaceAll('{{LOG}}', logInContainer)
  const exec = await getDocker()
    .getContainer(nameFor(agent.id))
    .exec({ Cmd: ['sh', '-c', `nohup sh -c '${rendered.replaceAll("'", "'\\''")}' >/dev/null 2>&1 &`], AttachStdout: false, AttachStderr: false })
  await exec.start({ Detach: true })
  // tail the log for the device code (login itself runs for minutes); host
  // read first, falling back through docker when the container owns the file
  const readLog = async (): Promise<string | null> => {
    try {
      if (existsSync(logOnHost)) return readFileSync(logOnHost, 'utf8')
    } catch {
      // EACCES — container-owned; fall through
    }
    return readAgentFileViaDocker(agent, logName)
  }
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((res) => setTimeout(res, 1000))
    const text = (await readLog())?.trim() ?? ''
    if (text.length > 40) return text.slice(0, 1500)
  }
  return (await readLog())?.slice(0, 1500) || 'sign-in started — no output yet, retry in a moment'
}

/**
 * Tail of the last MCP sign-in output without restarting the flow —
 * host-first, docker fallback for container-owned files.
 */
export async function readMcpLoginLog(agent: Agent): Promise<string> {
  const logName = '.attache-mcp-login.log'
  try {
    const p = join(agentDir(agent.id), logName)
    if (existsSync(p)) return readFileSync(p, 'utf8').slice(-1500)
  } catch {
    // EACCES — container-owned; fall through
  }
  return (await readAgentFileViaDocker(agent, logName))?.slice(-1500) ?? ''
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
  const owner = db.users.find((u) => u.id === agent.userId)
  const container = getDocker().getContainer(nameFor(agent.id))
  const results: McpProvisionResult[] = []
  for (const server of def.mcpServers) {
    // pre-write the token to the agent's .env so runtimes that read it from
    // there (hermes) find it and skip their interactive auth prompt
    if (server.authToken && def.mcpTokenEnvKey.trim()) {
      const nameUpper = server.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
      const envKey = def.mcpTokenEnvKey.replaceAll('{{NAME_UPPER}}', nameUpper)
      try {
        await upsertAgentEnvSafe(agent, { [envKey]: server.authToken })
      } catch (err) {
        results.push({ name: server.name, ok: false, output: `token write failed: ${(err as Error).message}` })
        continue
      }
    }
    const fill = (tpl: string) =>
      tpl
        .replaceAll('{{NAME}}', server.name)
        .replaceAll('{{URL}}', server.url)
        .replaceAll('{{COMMAND}}', server.command)
        .replaceAll('{{TOKEN}}', server.authToken)
        .replaceAll('{{OWNER_EMAIL}}', owner?.email ?? '')
        .replaceAll('{{OWNER_NAME}}', owner?.name ?? '')
    const cmd = fill(def.mcpProvisionCommand).replaceAll('{{EXTRA}}', fill(server.extraArgs))
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
