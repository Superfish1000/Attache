import { db } from './store.js'
import { o365Configured, runFullSync } from './o365.js'

const HEARTBEAT_MS = 60_000

/**
 * O365 poll loop. A 60s heartbeat evaluates the schedule each beat, so
 * changing settings.o365.pollMinutes applies without a restart. First
 * eligible run ~30s after boot. runFullSync records results/errors itself;
 * its only throw ("already running") is deliberately swallowed here.
 */
export function startScheduler(): void {
  let lastRunAt = 0
  const beat = async () => {
    const minutes = db.settings.o365.pollMinutes
    if (!minutes || minutes < 1 || !o365Configured()) return
    if (Date.now() - lastRunAt < minutes * 60_000) return
    lastRunAt = Date.now()
    try {
      await runFullSync()
    } catch (err) {
      // usually just "a sync is already running" (slot skipped); anything else
      // (e.g. a failed save in runFullSync's finally) must not vanish silently
      console.warn('scheduled O365 sync:', (err as Error).message)
    }
  }
  setTimeout(() => {
    void beat()
    setInterval(() => void beat(), HEARTBEAT_MS).unref?.()
  }, 30_000).unref?.()
}
