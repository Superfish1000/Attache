import { db } from './store.js'
import { o365Configured, runFullSync } from './o365.js'
import { applyUpdate, checkForUpdate } from './self-update.js'
import { dockerAvailable } from './docker.js'
import {
  checkAndPersist as checkAgentDef,
  sweepAndApply as sweepAgentDefs,
} from './routes/container-defs.js'
import {
  checkAndPersist as checkMcpToolDef,
  sweepAndApply as sweepMcpToolDefs,
} from './routes/mcp-tools.js'

const HEARTBEAT_MS = 60_000

async function checkOnlySweep(): Promise<void> {
  for (const def of db.containers) await checkAgentDef(def)
  for (const def of db.mcpTools) await checkMcpToolDef(def)
}

/**
 * Combined poll loop (O365 sync, Attaché self-update, container image
 * updates). A 60s heartbeat evaluates every schedule each beat, so changing
 * any interval in Settings applies without a restart. First eligible run
 * ~30s after boot.
 */
export function startScheduler(): void {
  let lastO365RunAt = 0
  let lastSelfUpdateCheckAt = 0
  let lastImageUpdateCheckAt = 0

  const beat = async () => {
    const o365Minutes = db.settings.o365.pollMinutes
    if (o365Minutes && o365Minutes >= 1 && o365Configured() && Date.now() - lastO365RunAt >= o365Minutes * 60_000) {
      lastO365RunAt = Date.now()
      try {
        await runFullSync()
      } catch (err) {
        // usually just "a sync is already running" (slot skipped); anything else
        // (e.g. a failed save in runFullSync's finally) must not vanish silently
        console.warn('scheduled O365 sync:', (err as Error).message)
      }
    }

    const selfHours = db.settings.selfUpdate.autoCheckHours
    if (selfHours >= 1 && Date.now() - lastSelfUpdateCheckAt >= selfHours * 3_600_000) {
      lastSelfUpdateCheckAt = Date.now()
      try {
        const check = await checkForUpdate()
        if (check.ok && check.status === 'behind' && db.settings.selfUpdate.autoApply) {
          const applied = await applyUpdate()
          if (!applied.ok) console.warn('scheduled self-update apply failed:', applied.error)
        }
      } catch (err) {
        console.warn('scheduled self-update check:', (err as Error).message)
      }
    }

    const imgHours = db.settings.imageUpdates.autoCheckHours
    if (imgHours >= 1 && Date.now() - lastImageUpdateCheckAt >= imgHours * 3_600_000) {
      lastImageUpdateCheckAt = Date.now()
      try {
        const mode = db.settings.imageUpdates.autoMode
        if (mode === 'check') {
          await checkOnlySweep()
        } else if (await dockerAvailable()) {
          await Promise.all([sweepAgentDefs(mode), sweepMcpToolDefs(mode)])
        }
      } catch (err) {
        console.warn('scheduled image-update sweep:', (err as Error).message)
      }
    }
  }

  setTimeout(() => {
    void beat()
    setInterval(() => void beat(), HEARTBEAT_MS).unref?.()
  }, 30_000).unref?.()
}
