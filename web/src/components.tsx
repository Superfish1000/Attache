import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'

export type ChipTone = 'ok' | 'warn' | 'err' | 'off'

/**
 * Small ⓘ trigger that opens a modal with help content. The trigger is a span
 * (not a button) and the overlay renders through a portal so the component is
 * safe to nest inside <label> — a labelable trigger would be activated by any
 * click on the label text, and an inline overlay would re-trigger it.
 */
export function InfoPopup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const openIt = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault()
    setOpen(true)
  }
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="info-btn"
        title={title}
        onClick={openIt}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openIt(e)
        }}
      >
        ⓘ
      </span>
      {open &&
        createPortal(
          <div className="modal-overlay" onClick={() => setOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <b>{title}</b>
                <button className="btn btn-ghost" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** Shared env-var reference shown next to every env editor. */
export function EnvVarsHelp() {
  return (
    <div className="env-help">
      <p>
        <b>Setting the model API key</b> (required before agents can think):
      </p>
      <ol>
        <li>
          Go to <b>Settings → Docker → Default env for all agents</b> and add your key, e.g.{' '}
          <span className="mono">{'{"ANTHROPIC_API_KEY": "sk-ant-..."}'}</span>
        </li>
        <li>
          On each agent's page press <b>Regenerate</b> — the container is recreated with the new
          env (files are untouched unless you tick the reset option).
        </li>
      </ol>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">ANTHROPIC_API_KEY</td>
            <td>Anthropic model access (Hermes defaults to a Claude model)</td>
          </tr>
          <tr>
            <td className="mono">OPENAI_API_KEY</td>
            <td>OpenAI model access (alternative provider)</td>
          </tr>
          <tr>
            <td className="mono">API_SERVER_KEY</td>
            <td>Per-agent gateway auth token — auto-generated, used by the Chat tab</td>
          </tr>
          <tr>
            <td className="mono">API_SERVER_ENABLED / _HOST / _PORT</td>
            <td>Expose the OpenAI-compatible gateway (defaults are correct)</td>
          </tr>
          <tr>
            <td className="mono">HERMES_DASHBOARD=1</td>
            <td>
              Hermes' built-in web chat on container port 9119 — map the port on the definition and
              it auto-assigns at deploy
            </td>
          </tr>
          <tr>
            <td className="mono">TELEGRAM_BOT_TOKEN</td>
            <td>Optional Telegram integration</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Layering: universal default env → container definition env → per-agent env (agent wins).
      </p>
    </div>
  )
}

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
