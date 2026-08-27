import { execFile } from 'node:child_process'
import { utimesSync } from 'node:fs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: REPO_ROOT })
  return stdout.trim()
}

// The commit this PROCESS booted from. The checkout can move (git pull) while
// the process keeps running old code — comparing the two exposes exactly the
// "updated but not restarted" state that otherwise looks like random bugs.
const RUNNING_COMMIT = await git('rev-parse', '--short', 'HEAD').catch(() => '')

/** "https://github.com/owner/repo.git" | "git@github.com:owner/repo.git" -> "owner/repo" */
function parseGithubRepo(url: string): string | null {
  const m = url.match(/github\.com[:/]+([^/]+\/[^/\s]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

export type CheckForUpdateResult =
  | {
      ok: true
      repo: string
      currentShort: string
      status: 'up-to-date' | 'behind' | 'ahead' | 'diverged'
      behindBy: number
      latest: { short: string; message: string; date: string } | null
      runningShort: string
      restartNeeded: boolean
    }
  | { ok: false; httpStatus: number; error: string }

/** Compares local HEAD against origin/main via `git fetch` — works for private repos (same credentials as push) with no API rate limits. */
export async function checkForUpdate(): Promise<CheckForUpdateResult> {
  let originUrl: string
  try {
    originUrl = await git('remote', 'get-url', 'origin')
  } catch (err) {
    return { ok: false, httpStatus: 400, error: `not a git checkout with an origin remote: ${(err as Error).message.slice(0, 120)}` }
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
    return {
      ok: true,
      repo,
      currentShort,
      status,
      behindBy,
      latest,
      runningShort: RUNNING_COMMIT,
      restartNeeded: Boolean(RUNNING_COMMIT) && RUNNING_COMMIT !== currentShort,
    }
  } catch (err) {
    const e = err as Error & { stderr?: string }
    return { ok: false, httpStatus: 502, error: `update check failed (is GitHub reachable?): ${(e.stderr || e.message).slice(0, 200)}` }
  }
}

/**
 * Signals the process to exit; a supervisor (systemd Restart=always, pm2, a
 * docker restart policy) brings it back in production, or the dev watcher
 * picks it up via the timestamp nudge below. Without either, the process
 * just stays down — this function can't detect that, so callers that need
 * to know should re-poll /api/status after calling it.
 */
export function restartProcess(afterMs = 300): void {
  setTimeout(() => {
    // hard-exit backstop in case anything above hangs (version-proof)
    setTimeout(() => process.exit(0), 5000).unref()
    try {
      // nudge the dev watcher (tsx watch reruns on file change, NOT on clean
      // exit): a timestamp-only touch of the entry file, content untouched
      const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
      const now = new Date()
      utimesSync(entry, now, now)
    } catch {
      // production installs run under a supervisor instead
    }
    process.exit(0)
  }, afterMs)
}

export type ApplyUpdateResult =
  | {
      ok: true
      updated: boolean
      from: string
      to: string
      pull: string
      installNote: string
      buildNote: string
      restarting: boolean
      note: string
    }
  | { ok: false; httpStatus: number; error: string }

/**
 * git pull --ff-only + npm install + rebuild the web frontend (production
 * serves a pre-built static bundle — git pull alone never refreshes it,
 * which left the server running new backend code against a stale frontend
 * after a "successful" update). Auto-restarts ONLY when the pull actually
 * moved AND both install and build succeeded — restarting into a broken
 * install/build would just crash-loop, which is worse than staying on the
 * old (working) code and surfacing the failure for a human to fix.
 */
export async function applyUpdate(): Promise<ApplyUpdateResult> {
  try {
    // Untracked files don't block a pull; git itself errors if one would be overwritten.
    const dirtyOut = await git('status', '--porcelain', '--untracked-files=no')
    // Porcelain lines are "XY path" — strip the status token; the helper's
    // trim() may already have eaten a leading space, so don't count columns.
    let dirtyFiles = dirtyOut
      ? dirtyOut
          .split('\n')
          .map((l) => l.trim().replace(/^\S+\s+/, ''))
          .filter(Boolean)
      : []
    // Lockfile churn is usually our own `npm install` (different npm versions
    // rewrite it) — reset it rather than blocking updates forever; a real
    // update reinstalls right after the pull anyway.
    const lockfiles = dirtyFiles.filter((f) => f.endsWith('package-lock.json'))
    if (lockfiles.length && lockfiles.length === dirtyFiles.length) {
      await git('checkout', '--', ...lockfiles)
      dirtyFiles = []
    }
    if (dirtyFiles.length) {
      return {
        ok: false,
        httpStatus: 409,
        error: `working tree has local changes — commit or stash them before updating: ${dirtyFiles
          .slice(0, 10)
          .join(', ')}${dirtyFiles.length > 10 ? ', …' : ''}`,
      }
    }
    const before = await git('rev-parse', '--short', 'HEAD')
    let pullOut: string
    try {
      pullOut = await git('pull', '--ff-only', 'origin', 'main')
    } catch (err) {
      const e = err as Error & { stderr?: string }
      return { ok: false, httpStatus: 500, error: `git pull failed: ${(e.stderr || e.message).slice(0, 300)}` }
    }
    const after = await git('rev-parse', '--short', 'HEAD')
    const updated = before !== after
    let installNote = ''
    let buildNote = ''
    let installOk = true
    if (updated) {
      try {
        await run('npm', ['install'], {
          cwd: REPO_ROOT,
          shell: true, // npm is npm.cmd on Windows
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        })
        installNote = 'dependencies installed'
      } catch (err) {
        installOk = false
        installNote = `npm install failed — run it manually: ${(err as Error).message.slice(0, 200)}`
      }
      if (installOk) {
        try {
          await run('npm', ['run', 'build', '--workspace', 'web'], {
            cwd: REPO_ROOT,
            shell: true,
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
          })
          buildNote = 'web rebuilt'
        } catch (err) {
          installOk = false
          buildNote = `web build failed — the server would keep serving the OLD frontend against new backend code until this is fixed: ${(err as Error).message.slice(0, 200)}`
        }
      }
    }
    const restarting = updated && installOk
    if (restarting) restartProcess(500) // give this response time to reach the client first
    return {
      ok: true,
      updated,
      from: before,
      to: after,
      pull: pullOut.split('\n').slice(0, 10).join('\n'),
      installNote,
      buildNote,
      restarting,
      note: !updated
        ? ''
        : restarting
          ? 'Restarting automatically to finish the update…'
          : 'NOT restarting automatically — fix the error above, then use Restart server once resolved.',
    }
  } catch (err) {
    return { ok: false, httpStatus: 500, error: `update failed: ${(err as Error).message.slice(0, 300)}` }
  }
}
