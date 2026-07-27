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
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      // the agent CLI answers in one piece (context lives in the agent's own session)
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      })
      const body = (await res.json()) as { content?: string; error?: string }
      if (!res.ok) throw new Error(body.error ?? `chat failed (${res.status})`)
      const finalMsgs: ChatMsg[] = [
        ...history,
        { role: 'assistant', content: body.content || '(no response)' },
      ]
      setMsgs(finalMsgs)
      persist(agentId, finalMsgs)
    } catch (e) {
      setMsgs(history)
      persist(agentId, history)
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
                ⏳ {agent?.name ?? 'The agent'} is thinking — replies can take 1–3 minutes. Stay on
                this page; leaving cancels the reply.
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
