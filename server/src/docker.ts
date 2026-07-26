import Docker from 'dockerode'
import { resolve } from 'node:path'
import type { Agent } from './types.js'
import { agentDir } from './agents.js'

const docker = new Docker() // win32 default: //./pipe/docker_engine

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker.ping()
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
    const insp = await docker.getContainer(nameFor(agentId)).inspect()
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

async function pullIfMissing(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // not present locally — pull below
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
  const info = await containerInfo(agent.id)
  if (info.exists) {
    try {
      await docker.getContainer(nameFor(agent.id)).start()
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err // 304 = already running
    }
    return containerInfo(agent.id)
  }
  await pullIfMissing(agent.config.image)
  const bindSrc = resolve(agentDir(agent.id)).replace(/\\/g, '/')
  const env = Object.entries({ AGENT_ID: agent.id, AGENT_NAME: agent.name, ...agent.config.env })
  const container = await docker.createContainer({
    name: nameFor(agent.id),
    Image: agent.config.image,
    Cmd: agent.config.command,
    Env: env.map(([k, v]) => `${k}=${v}`),
    Labels: { 'attache.managed': 'true', 'attache.agent.id': agent.id },
    HostConfig: { Binds: [`${bindSrc}:/agent`] },
  })
  await container.start()
  return containerInfo(agent.id)
}

export async function stopAgentContainer(agentId: string): Promise<ContainerInfo> {
  try {
    await docker.getContainer(nameFor(agentId)).stop({ t: 5 })
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode
    if (code !== 304 && code !== 404) throw err // 304 = already stopped
  }
  return containerInfo(agentId)
}

export async function removeAgentContainer(agentId: string): Promise<ContainerInfo> {
  try {
    await docker.getContainer(nameFor(agentId)).remove({ force: true })
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
  const list = await docker.listContainers({
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
