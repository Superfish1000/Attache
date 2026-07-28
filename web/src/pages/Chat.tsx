import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Chip, ErrorBanner } from '../components'
import type { Agent, ContainerState } from '../types'
import type { KeyboardEvent } from 'react'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

const storageKey = (agentId: string) => `attache-chat-${agentId}`

function loadHistory(agentId: string): ChatMsg[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(agentId)) ?? '[]') as ChatMsg[]
  } catch {
    return []
  }
}

export default function Chat() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [sel, setSel] = useState('')
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [container, setContainer] = useState<ContainerState | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [err, setErr] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // navigating away aborts the fetch; paired with the server's close handler this
  // also stops the agent generating for nobody
  useEffect(() => () => abortRef.current?.abort(), [])

  // a reload mid-reply loses the answer — make the browser ask first
  useEffect(() => {
    if (!streaming) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [streaming])

  useEffect(() => {
    api.agents
      .list()
      .then((a) => {
        setAgents(a)
        if (a[0]) setSel((cur) => cur || a[0].id)
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  const refreshContainer = useCallback((agentId: string) => {
    api.agents
      .container(agentId)
      .then(setContainer)
      .catch(() => setContainer(null))
  }, [])

  useEffect(() => {
    if (!sel) return
    setMsgs(loadHistory(sel))
    refreshContainer(sel)
  }, [sel, refreshContainer])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [msgs])

  const persist = (agentId: string, m: ChatMsg[]) => {
    try {
      localStorage.setItem(storageKey(agentId), JSON.stringify(m))
    } catch {
      // storage full — chat still works, history just won't survive reload
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming || !sel) return
    const agentId = sel
    setErr('')
    setInput('')
    const history: ChatMsg[] = [...msgs, { role: 'user', content: text }]
    setMsgs([...history, { role: 'assistant', content: '' }])
    setStreaming(true)
    let assistant = ''
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      // warm gateway: OpenAI-compatible SSE stream proxied through the server
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, stream: true }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        let msg = `chat failed (${res.status})`
        try {
          const body = (await res.json()) as { error?: { message?: string } | string }
          msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? msg)
        } catch {
          // non-JSON error body
        }
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const data = line.trim()
          if (!data.startsWith('data:')) continue
          const payload = data.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
            }
            const chunk =
              parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? ''
            if (chunk) {
              assistant += chunk
              setMsgs([...history, { role: 'assistant', content: assistant }])
            }
          } catch {
            // partial frame — wait for more
          }
        }
      }
      const finalMsgs: ChatMsg[] = [
        ...history,
        { role: 'assistant', content: assistant || '(no response)' },
      ]
      setMsgs(finalMsgs)
      persist(agentId, finalMsgs)
    } catch (e) {
      // keep whatever partial text streamed before the failure
      const finalMsgs: ChatMsg[] = assistant
        ? [...history, { role: 'assistant', content: assistant }]
        : history
      setMsgs(finalMsgs)
      persist(agentId, finalMsgs)
      if ((e as Error).name !== 'AbortError') setErr((e as Error).message)
    } finally {
      setStreaming(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const clear = () => {
    if (!confirm('Clear this conversation?')) return
    setMsgs([])
    if (sel) persist(sel, [])
  }

  const startAgent = async () => {
    setErr('')
    try {
      setContainer(await api.agents.containerAction(sel, 'start'))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const agent = agents.find((a) => a.id === sel)
  const running = container?.available && container.exists && container.running

  return (
    <>
      <h1>Chat</h1>
      <p className="subtitle">
        Talk to your agent — it remembers, uses its tools, and may take a minute on complex asks
      </p>
      <ErrorBanner message={err} onDismiss={() => setErr('')} />
      {agents.length === 0 ? (
        <div className="panel empty">
          No agents yet — create one on the <Link to="/agents">Agents</Link> page.
        </div>
      ) : (
        <div className="panel chat-panel">
          <div className="form-row" style={{ marginBottom: 10 }}>
            <select value={sel} disabled={streaming} onChange={(e) => setSel(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {container === null ? (
              <Chip tone="off">…</Chip>
            ) : !container.available ? (
              <Chip tone="err">docker offline</Chip>
            ) : running ? (
              <Chip tone="ok">running</Chip>
            ) : (
              <>
                <Chip tone="warn">not running</Chip>
                <button className="btn" onClick={startAgent}>
                  Start agent
                </button>
              </>
            )}
            {running && agent?.config.ports['9119'] && (
              <a
                className="btn"
                href={`http://${window.location.hostname}:${agent.config.ports['9119']}`}
                target="_blank"
                rel="noreferrer"
                title="Hermes' own web dashboard — sign in with your Attache email & password"
              >
                Open dashboard ↗
              </a>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn" disabled={msgs.length === 0 || streaming} onClick={clear}>
              Clear chat
            </button>
          </div>
          <div className="chat-scroll" ref={scrollRef}>
            {msgs.length === 0 && (
              <div className="empty">
                Say hello — {agent?.name ?? 'your agent'} remembers across conversations via its
                memory files.
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role === 'user' ? 'chat-user' : 'chat-agent'}`}>
                {m.content}
                {streaming && i === msgs.length - 1 && m.role === 'assistant' && (
                  <span className="chat-cursor">&nbsp;</span>
                )}
              </div>
            ))}
            {streaming && (
              <div className="muted" style={{ padding: '4px 2px' }}>
                ⏳ {agent?.name ?? 'The agent'} is thinking — leaving this page cancels the reply.
              </div>
            )}
          </div>
          <div className="chat-input-row">
            <textarea
              rows={2}
              placeholder={running ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Start the agent to chat'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <button className="btn btn-primary" disabled={streaming || !input.trim()} onClick={send}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  )
}
