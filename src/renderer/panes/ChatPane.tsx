import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeEvent, ClaudeMessage, ClaudeStatus } from '@shared/claude'

interface Props {
  /** 当前打开的文件路径 —— Claude 的工作目录 */
  filePath: string | null
  /** 文件在外部（Claude）被改了 */
  externalChange?: string | null
  /** 外部改了文件 → 重新加载 */
  onReload?: () => void
}

/** 内嵌 Claude Code 对话面板。 */
export default function ChatPane({ filePath, externalChange, onReload }: Props) {
  const [messages, setMessages] = useState<ClaudeMessage[]>([])
  const [pendingText, setPendingText] = useState('')
  const [pendingThinking, setPendingThinking] = useState('')
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ClaudeStatus>({ state: 'idle' })
  const [log, setLog] = useState<string[]>([])
  const [claudePath, setClaudePath] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)

  // 找 Claude Code
  useEffect(() => {
    void window.jhyyIde.claude.locate().then((b) => setClaudePath(b?.path ?? null))
  }, [])

  // 订阅主进程事件
  useEffect(() => {
    const offEvent = window.jhyyIde.claude.onEvent((event: ClaudeEvent) => {
      switch (event.type) {
        case 'delta':
          setPendingText((prev) => prev + event.text)
          break
        case 'thinking-delta':
          setPendingThinking((prev) => prev + event.text)
          break
        case 'message':
          setMessages((prev) => [...prev, event.message])
          // 完整消息到了 —— 增量气泡撤掉
          if (event.message.role === 'assistant') {
            setPendingText('')
            setPendingThinking('')
          }
          break
        case 'log':
          setLog((prev) => [...prev.slice(-50), event.text])
          break
        case 'error':
          setStatus((prev) => ({ ...prev, state: 'error', error: event.message }))
          break
        case 'status':
          setStatus(event.status)
          break
      }
    })
    const offStatus = window.jhyyIde.claude.onStatus((s) => setStatus(s))
    return () => {
      offEvent()
      offStatus()
    }
  }, [])

  // 自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, pendingText, log])

  const ensureSession = useCallback(async () => {
    if (startedRef.current) return true
    startedRef.current = true
    const cwd = filePath ? dirnameOf(filePath) : process.cwd()
    const result = await window.jhyyIde.claude.start({ cwd })
    if (!result.ok) {
      startedRef.current = false
      setStatus({ state: 'error', error: result.error })
      return false
    }
    return true
  }, [filePath])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    if (!(await ensureSession())) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    await window.jhyyIde.claude.send(text)
  }, [ensureSession, input])

  const stop = useCallback(async () => {
    await window.jhyyIde.claude.stop()
    startedRef.current = false
  }, [])

  const stateText: Record<string, string> = {
    idle: '未开始',
    starting: '启动中…',
    running: '思考中…',
    waiting: '等你说话',
    stopping: '停止中…',
    stopped: '已结束',
    error: '出错',
  }

  return (
    <div className="chat-pane">
      <div className="pane-header">
        Claude Code
        <span className="count">{stateText[status.state] ?? status.state}</span>
        <span className="spacer" />
        {status.usage && (
          <span className="count">
            {status.usage.outputTokens ?? 0} tok
            {status.usage.costUsd ? ` · $${status.usage.costUsd.toFixed(4)}` : ''}
          </span>
        )}
        <button className="mini" onClick={() => void stop()} disabled={status.state === 'idle'}>
          停止
        </button>
      </div>

      {status.error && <div className="chat-error">{status.error}</div>}

      {externalChange && (
        <div className="chat-banner">
          文件在外部被修改了
          <button className="mini" onClick={() => onReload?.()}>
            重新加载
          </button>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !pendingText && (
          <div className="empty">
            {claudePath
              ? '问问 Claude 吧 —— 它能调 jhyy_check 看真实编译错误。'
              : '没找到 Claude Code 可执行文件（claude CLI）。'}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === 'user' && !m.toolResult && <div className="bubble user">{m.text}</div>}
            {m.role === 'assistant' && m.thinking && (
              <div className="bubble thinking">{m.thinking}</div>
            )}
            {m.role === 'assistant' && m.text && <div className="bubble assistant">{m.text}</div>}
            {m.toolUses?.map((t) => (
              <div key={t.id} className="bubble tool">
                <span className="tool-name">{t.name}</span>
                <pre>{JSON.stringify(t.input, null, 2)}</pre>
              </div>
            ))}
            {m.toolResult && (
              <div className={`bubble tool-result${m.toolResult.isError ? ' error' : ''}`}>
                <pre>{m.toolResult.content}</pre>
              </div>
            )}
          </div>
        ))}

        {pendingThinking && <div className="chat-msg user">{pendingThinking}</div>}
        {pendingText && (
          <div className="chat-msg assistant">
            <div className="bubble assistant streaming">{pendingText}</div>
          </div>
        )}

        {log.length > 0 && (
          <details className="chat-log">
            <summary>CLI 日志（{log.length}）</summary>
            <pre>{log.join('\n')}</pre>
          </details>
        )}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          placeholder="跟 Claude 说点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}
