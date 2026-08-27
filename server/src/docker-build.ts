import { spawn } from 'node:child_process'

/** Runs the docker CLI, optionally piping stdin, capturing combined output. */
export function runDocker(args: string[], stdin?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', (err) => resolvePromise({ code: -1, output: String(err) }))
    child.on('close', (code) =>
      resolvePromise({ code: code ?? -1, output: Buffer.concat(chunks).toString('utf8') }),
    )
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
    setTimeout(() => child.kill(), 600_000).unref()
  })
}

/**
 * FROM + RUN-only Dockerfiles can be emulated on daemons whose seccomp
 * breaks `docker build` (run the RUNs in a container with the configured
 * securityOpt, then commit). Anything fancier returns null.
 */
export function parseSimpleDockerfile(text: string): { from: string; runs: string[] } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const fromMatch = lines[0]?.match(/^FROM\s+(\S+)$/i)
  if (!fromMatch) return null
  const runs: string[] = []
  for (const line of lines.slice(1)) {
    const m = line.match(/^RUN\s+(.+)$/i)
    if (!m) return null
    runs.push(m[1])
  }
  return runs.length ? { from: fromMatch[1], runs } : null
}

export const tail = (s: string) => s.slice(-1500)

/** Pulls the latest content for image:tag without building/tagging anything else. */
export async function pullImage(image: string): Promise<{ ok: boolean; output: string }> {
  const res = await runDocker(['pull', image])
  return { ok: res.code === 0, output: tail(res.output) }
}

export interface BuildResult {
  ok: boolean
  method: 'build' | 'run-commit'
  output: string
}

/**
 * Builds a Dockerfile tagged as `image`. Tries a native `docker build`; on
 * failure, simple FROM+RUN-only Dockerfiles are emulated via run (with the
 * given securityOpt) + commit — needed on old daemons whose seccomp profile
 * aborts builds of modern images. tmpNamePrefix scopes the throwaway
 * container's name (must be unique per caller to avoid collisions).
 */
export async function buildDockerfileImage(
  image: string,
  dockerfile: string,
  tmpNamePrefix: string,
  securityOpt: string[],
): Promise<BuildResult> {
  const build = await runDocker(['build', '-t', image, '-'], dockerfile)
  if (build.code === 0) return { ok: true, method: 'build', output: tail(build.output) }

  const simple = parseSimpleDockerfile(dockerfile)
  if (!simple) {
    return { ok: false, method: 'build', output: tail(build.output) }
  }
  const tmp = tmpNamePrefix
  await runDocker(['rm', '-f', tmp])
  const secOpts = securityOpt.flatMap((o) => ['--security-opt', o])
  const run = await runDocker([
    'run', '--name', tmp, ...secOpts, '--entrypoint', 'sh', simple.from, '-c', simple.runs.join(' && '),
  ])
  if (run.code !== 0) {
    await runDocker(['rm', '-f', tmp])
    return {
      ok: false,
      method: 'run-commit',
      output: tail(`build failed:\n${build.output}\n--- emulation also failed ---\n${run.output}`),
    }
  }
  const insp = await runDocker([
    'inspect', simple.from, '--format', '{{json .Config.Entrypoint}}|||{{json .Config.Cmd}}',
  ])
  const changes: string[] = []
  if (insp.code === 0) {
    const [ep, cmd] = insp.output.trim().split('|||')
    if (ep && ep !== 'null') changes.push('--change', `ENTRYPOINT ${ep}`)
    if (cmd && cmd !== 'null') changes.push('--change', `CMD ${cmd}`)
  }
  const commit = await runDocker(['commit', ...changes, tmp, image])
  await runDocker(['rm', '-f', tmp])
  if (commit.code !== 0) return { ok: false, method: 'run-commit', output: tail(commit.output) }
  return {
    ok: true,
    method: 'run-commit',
    output: tail(run.output) + '\n--- built via run+commit (old-daemon fallback) ---',
  }
}
