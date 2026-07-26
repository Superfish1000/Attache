import type { ReactNode } from 'react'

export type ChipTone = 'ok' | 'warn' | 'err' | 'off'

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null
  return (
    <div className="error-banner">
      <span>{message}</span>
      {onDismiss && (
        <button className="btn btn-ghost" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  )
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}
