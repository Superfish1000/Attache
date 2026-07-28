import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../auth.js'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: REPO_ROOT })
  return stdout.trim()
}

/** "https://github.com/owner/repo.git" | "git@github.com:owner/repo.git" -> "owner/repo" */
function parseGithubRepo(url: string): string | null {
  const m = url.match(/github\.com[:/]+([^/]+\/[^/\s]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

export default async function updateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply
  })

  /**
   * Compare local HEAD against origin/main via `git fetch` — works for
   * private repos (same credentials as push) with no API rate limits.
   */
  app.get('/check', async (req, reply) => {
    let originUrl: string
    try {
      originUrl = await git('remote', 'get-url', 'origin')
    } catch (err) {
      return reply.code(400).send({
        error: `not a git checkout with an origin remote: ${(err as Error).message.slice(0, 120)}`,
      })
    }
    const repo = parseGithubRepo(originUrl) ?? originUrl
    try {
      await git('fetch', '--quiet', 'origin', 'main')
      const currentShort = await git('rev-parse', '--short', 'HEAD')
      const behindBy = Number(await git('rev-list', '--count', 'HEAD..origin/main'))
      const aheadBy = Number(await git('rev-list', '--count', 'origin/main..HEAD'))
      const status =
        behindBy === 0 && aheadBy === 0
          ? 'up-to-date'
          : behindBy > 0 && aheadBy > 0
            ? 'diverged'
            : behindBy > 0
              ? 'behind'
              : 'ahead'
      const latest =
        behindBy > 0
          ? {
              short: await git('rev-parse', '--short', 'origin/main'),
              message: await git('log', '-1', '--format=%s', 'origin/main'),
              date: await git('log', '-1', '--format=%cI', 'origin/main'),
            }
          : null
      return { repo, currentShort, status, behindBy, latest }
    } catch (err) {
      const e = err as Error & { stderr?: string }
      return reply.code(502).send({
        error: `update check failed (is GitHub reachable?): ${(e.stderr || e.message).slice(0, 200)}`,
      })
    }
  })

  /** git pull --ff-only + npm install. The dev server restarts itself (tsx watch). */
  app.post('/apply', async (req, reply) => {
    try {
      // Untracked files don't block a pull; git itself errors if one would be overwritten.
      const dirtyOut = await git('status', '--porcelain', '--untracked-files=no')
      let dirtyFiles = dirtyOut ? dirtyOut.split('\n').map((l) => l.slice(3)) : []
      // Lockfile churn is usually our own `npm install` (different npm versions
      // rewrite it) — reset it rather than blocking updates forever; a real
      // update reinstalls right after the pull anyway.
      const lockfiles = dirtyFiles.filter((f) => f.endsWith('package-lock.json'))
      if (lockfiles.length && lockfiles.length === dirtyFiles.length) {
        await git('checkout', '--', ...lockfiles)
        dirtyFiles = []
      }
      if (dirtyFiles.length) {
        return reply.code(409).send({
          error: `working tree has local changes — commit or stash them before updating: ${dirtyFiles
            .slice(0, 10)
            .join(', ')}${dirtyFiles.length > 10 ? ', …' : ''}`,
        })
      }
      const before = await git('rev-parse', '--short', 'HEAD')
      let pullOut: string
      try {
        pullOut = await git('pull', '--ff-only', 'origin', 'main')
      } catch (err) {
        const e = err as Error & { stderr?: string }
        return reply
          .code(500)
          .send({ error: `git pull failed: ${(e.stderr || e.message).slice(0, 300)}` })
      }
      const after = await git('rev-parse', '--short', 'HEAD')
      let installNote = ''
      if (before !== after) {
        try {
          await run('npm', ['install'], {
            cwd: REPO_ROOT,
            shell: true, // npm is npm.cmd on Windows
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
          })
          installNote = 'dependencies installed'
        } catch (err) {
          installNote = `npm install failed — run it manually: ${(err as Error).message.slice(0, 200)}`
        }
      }
      return {
        updated: before !== after,
        from: before,
        to: after,
        pull: pullOut.split('\n').slice(0, 10).join('\n'),
        installNote,
        note:
          before !== after
            ? 'In dev mode the server restarts itself; with `npm start`, restart it manually to finish.'
            : '',
      }
    } catch (err) {
      return reply
        .code(500)
        .send({ error: `update failed: ${(err as Error).message.slice(0, 300)}` })
    }
  })
}
