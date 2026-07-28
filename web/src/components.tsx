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

/** Field-by-field help for the "MCP servers" list on a container definition. */
export function McpServersHelp() {
  return (
    <div className="env-help">
      <p>
        Each row is one MCP (Model Context Protocol) server pre-loaded into <b>every agent</b> of
        this definition — automatically at container start/regenerate, or manually via the agent
        page's <b>Provision MCP</b> button.
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Name</td>
            <td>Identifier inside the agent runtime (letters, digits, dashes). Also used to derive the token env key.</td>
          </tr>
          <tr>
            <td>URL</td>
            <td>For hosted servers reached over HTTP/SSE (e.g. <span className="mono">https://mcp.linear.app/mcp</span>). Leave blank for stdio servers.</td>
          </tr>
          <tr>
            <td>Stdio command</td>
            <td>For servers launched as a child process inside the container (the binary must exist in the image — see the Dockerfile field). Exactly one of URL / command is required.</td>
          </tr>
          <tr>
            <td>Bearer token</td>
            <td>Optional static API token. Written into the agent's <span className="mono">.env</span> under the token env-key pattern before provisioning; also available to templates as <span className="mono">{'{{TOKEN}}'}</span>. OAuth servers leave this blank and sign in interactively instead.</td>
          </tr>
          <tr>
            <td>Extra args</td>
            <td>Appended into the provision template as <span className="mono">{'{{EXTRA}}'}</span>. Placeholders below substitute per agent — this is how per-user settings (like an identity pin) deploy with no manual steps.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <b>Example — Microsoft 365, identity-pinned per user</b> (stdio command{' '}
        <span className="mono">ms-365-mcp-server</span>):
      </p>
      <p className="mono" style={{ fontSize: 12 }}>
        --env MS365_MCP_ORG_MODE=true --env MS365_MCP_EXPECTED_USERNAME={'{{OWNER_EMAIL}}'} --env
        MS365_MCP_TOKEN_CACHE_PATH=/opt/data/m365/token-cache.json --args --org-mode
      </p>
      <p className="muted">
        Heads-up: Hermes only persists servers it can reach at add time — after adding one, run{' '}
        <b>Provision MCP</b> on an agent and read the per-server output.
      </p>
    </div>
  )
}

/** Placeholder + template reference for MCP provisioning/login configuration. */
export function McpTemplatesHelp() {
  return (
    <div className="env-help">
      <p>
        Three definition-level settings control <i>how</i> this runtime ingests MCP servers. All are
        plain shell run inside the container (as root — drop privileges in the template where the
        runtime needs it, e.g. <span className="mono">runuser -u hermes --</span>).
      </p>
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Provision command</td>
            <td>Run once per server row. The stock Hermes template branches on URL vs stdio and pipes a <span className="mono">y</span> into Hermes' "enable all tools?" prompt. Blank disables provisioning.</td>
          </tr>
          <tr>
            <td>Token env-key pattern</td>
            <td>Where bearer tokens land in the agent's <span className="mono">.env</span> (Hermes reads <span className="mono">MCP_&lt;NAME&gt;_API_KEY</span> and wires the Authorization header itself). Blank = tokens are never written.</td>
          </tr>
          <tr>
            <td>MCP sign-in command</td>
            <td>Optional interactive auth bootstrap (OAuth device-code flows). Runs detached; must redirect output to <span className="mono">{'{{LOG}}'}</span>, which Attaché tails and shows to the user. When set, agent pages get an owner-accessible <b>MCP sign-in</b> button.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <b>All placeholders</b> (substituted before running; unused ones are fine):
      </p>
      <table>
        <thead>
          <tr>
            <th>Placeholder</th>
            <th>Becomes</th>
            <th>Available in</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">{'{{NAME}}'}</td>
            <td>The server row's name</td>
            <td>provision, extra args</td>
          </tr>
          <tr>
            <td className="mono">{'{{URL}}'}</td>
            <td>The server row's URL</td>
            <td>provision, extra args</td>
          </tr>
          <tr>
            <td className="mono">{'{{COMMAND}}'}</td>
            <td>The server row's stdio command</td>
            <td>provision, extra args</td>
          </tr>
          <tr>
            <td className="mono">{'{{TOKEN}}'}</td>
            <td>The server row's bearer token</td>
            <td>provision, extra args</td>
          </tr>
          <tr>
            <td className="mono">{'{{EXTRA}}'}</td>
            <td>The server row's extra args (with its own placeholders already substituted)</td>
            <td>provision</td>
          </tr>
          <tr>
            <td className="mono">{'{{OWNER_EMAIL}}'}</td>
            <td>The agent owner's Attaché email — per-agent identity pinning</td>
            <td>provision, extra args, sign-in</td>
          </tr>
          <tr>
            <td className="mono">{'{{OWNER_NAME}}'}</td>
            <td>The agent owner's display name</td>
            <td>provision, extra args, sign-in</td>
          </tr>
          <tr>
            <td className="mono">{'{{NAME_UPPER}}'}</td>
            <td>Server name uppercased/sanitized (e.g. <span className="mono">ms365 → MS365</span>)</td>
            <td>token env-key pattern</td>
          </tr>
          <tr>
            <td className="mono">{'{{LOG}}'}</td>
            <td>In-container log file path the sign-in command must write to</td>
            <td>sign-in</td>
          </tr>
        </tbody>
      </table>
    </div>
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
