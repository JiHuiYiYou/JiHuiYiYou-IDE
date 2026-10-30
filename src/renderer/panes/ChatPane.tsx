import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeEvent, ClaudeStatus } from '@shared/claude'
import { Icon } from '../workbench/icons'
import { Markdown } from './Markdown'

interface Props {
  /** 当前打开的文件路径 —— Claude 的工作目录 */
  filePath: string | null
  /** 文件在外部（Claude）被改了 */
  externalChange?: string | null
  /** 外部改了文件 → 重新加载 */
  onReload?: () => void
  /** 只读模式 —— Claude 只给建议、不改文件 */
  readOnly?: boolean
  /** 切换只读模式 */
  onReadOnlyChange?: (readOnly: boolean) => void
}

/** 一条历史会话。 */
interface SavedSession {
  sessionId: string
  title: string
  cwd: string
  ts: number
  /**
   * 这轮对话的内容（用户的话 + 助手的回答 + 过程）。
   *
   * ⚠️ **必须自己存** —— `claude --resume` 只会把对话**接上**，
   * **不会把历史消息再吐一遍**（用户报过「点历史会话然后点其中一个，
   * 还是没有历史对话」）。所以历史得由 IDE 自己留着 ✓。
   */
  turns?: {
    userText: string
    answer?: string
    steps: { kind: 'thinking' | 'tool' | 'tool-result'; text?: string; name?: string; input?: unknown; result?: string; isError?: boolean }[]
  }[]
}

const SESSIONS_KEY = 'jhyy-ide.claude-sessions.v1'

/**
 * 一轮对话里的一个**过程**条目。
 *
 * ⚠️ 这些东西以前是一条条气泡直接打出来的 —— 一轮下来能刷十几行
 * （思考 + 每个工具的入参 + 每个工具的输出），把真正的回答挤到屏幕外。
 * 现在它们收进一个折叠块里。
 */
interface ChatStep {
  kind: 'thinking' | 'tool' | 'tool-result'
  /** 思考的正文 */
  text?: string
  /** 工具名 */
  name?: string
  /** 工具入参 */
  input?: unknown
  /** 工具的输出 */
  result?: string
  isError?: boolean
}

/**
 * 一轮对话 —— 用户一句 + 助手的所有过程 + 最终回答。
 *
 * 「过程」的展示规则（用户提的）：
 * - **进行中** ⇒ 只显示一行状态（「正在思考…」/「正在调用工具 Read…」）
 * - **出了最终回答** ⇒ 过程整个折叠成一行「已完成」，回答照常显示
 */
interface ChatTurn {
  id: string
  /** 用户说的话 */
  userText: string
  /** 过程 */
  steps: ChatStep[]
  /** 最终回答 */
  answer?: string
  /** 正在流式输出的回答（还没定稿） */
  streaming: string
  /** 正在进行中的活动 */
  activity?: string
  /** 过程要不要折叠起来 */
  collapsed: boolean
}

/**
 * 内嵌 Claude Code 对话面板 —— 抄 VS Code 的 Copilot 聊天侧栏。
 *
 * 流式机制（增量文本、工具调用、思考）跟主进程的对接一个字没动，
 * 改的是**怎么展示**：过程收进折叠块，只留最终回答。
 */
export default function ChatPane({
  filePath,
  externalChange,
  onReload,
  readOnly = false,
  onReadOnlyChange,
}: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ClaudeStatus>({ state: 'idle' })
  const [log, setLog] = useState<string[]>([])
  const [claudePath, setClaudePath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)
  /** 这次会话用的 sessionId —— 用来存历史 */
  const sessionIdRef = useRef<string | null>(null)
  /** tool_use id → 工具名 —— 工具结果那条只有 id，得靠它补上名字 */
  const toolNamesRef = useRef<Record<string, string>>({})
  /** 轮次 id 计数器 */
  const turnCounter = useRef(0)
  /** 历史会话列表（给 effect 用，避免闭包里拿到旧的） */
  const sessionsRef = useRef<SavedSession[]>([])
  /** 当前对话（给事件回调判断「最后一轮是不是已经结束了」） */
  const turnsRef = useRef<ChatTurn[]>([])

  // 找 Claude Code
  useEffect(() => {
    void window.jhyyIde.claude.locate().then((b) => setClaudePath(b?.path ?? null))
  }, [])

  // 历史会话
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY)
      if (raw) {
        const list = JSON.parse(raw) as SavedSession[]
        sessionsRef.current = list
        setSessions(list)
      }
    } catch {
      // 读不出来就算了
    }
  }, [])

  const persistSessions = useCallback((list: SavedSession[]) => {
    sessionsRef.current = list
    setSessions(list)
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list))
    } catch {
      // 写不进去（隐私模式？）—— 存不住历史而已
    }
  }, [])

  // 订阅主进程事件
  useEffect(() => {
    /** 改最后一轮（正在跑的那一轮）。 */
    const updateLastTurn = (fn: (t: ChatTurn) => ChatTurn): void => {
      setTurns((prev) => {
        if (prev.length === 0) return prev
        const last = prev[prev.length - 1]
        return [...prev.slice(0, -1), fn(last)]
      })
    }

    /**
     * 最后一轮是不是**已经结束**了。
     *
     * ⚠️ 恢复历史会话时，CLI 有可能把老消息**回放**一遍（`--resume` 到底回不放，
     * 跟 CLI 版本有关）。我们已经把历史填回界面了 ⇒ 回放的内容**必须忽略**，
     * 否则界面上会出现重复的一轮。
     *
     * 判据：**最后一轮已经折叠（collapsed）** ⇒ 它是「已经答完的」⇒ 不该再改。
     */
    const lastTurnClosed = (): boolean => !!turnsRef.current[turnsRef.current.length - 1]?.collapsed

    const offEvent = window.jhyyIde.claude.onEvent((event: ClaudeEvent) => {
      switch (event.type) {
        case 'delta':
          // 增量文本 —— 正在流式输出的回答
          if (lastTurnClosed()) break
          updateLastTurn((t) => ({ ...t, streaming: t.streaming + event.text }))
          break
        case 'thinking-delta':
          // 思考的增量 —— 正文等完整的 assistant 消息里才有，这里只更新状态
          if (lastTurnClosed()) break
          updateLastTurn((t) => ({ ...t, activity: '正在思考…' }))
          break
        case 'message': {
          const m = event.message
          if (m.role === 'assistant') {
            if (lastTurnClosed()) break
            updateLastTurn((t) => {
              const steps = [...t.steps]
              if (m.thinking) steps.push({ kind: 'thinking', text: m.thinking })
              const uses = m.toolUses ?? []
              for (const u of uses) {
                toolNamesRef.current[u.id] = u.name
                steps.push({ kind: 'tool', name: u.name, input: u.input })
              }
              if (uses.length > 0) {
                return {
                  ...t,
                  steps,
                  activity: `正在调用工具 ${uses[uses.length - 1].name}…`,
                }
              }
              if (m.text !== undefined) {
                // 最终回答到了 —— 过程整个折叠成一行「已完成」
                return {
                  ...t,
                  steps,
                  answer: m.text,
                  streaming: '',
                  activity: undefined,
                  collapsed: true,
                }
              }
              return { ...t, steps }
            })
          } else if (m.role === 'user') {
            /*
              用户消息 = **一轮的开始**。

              以前用户消息被**整个忽略**了 ⇒ 恢复历史会话时，CLI 那边什么也
              不回吐（`--resume` 只是把对话接上），界面就一直是空的
              （用户报过「点历史会话然后点其中一个还是没有历史对话」）。

              现在：历史由 IDE 自己存、自己还原 ✓；这里只是**兜底**
              （万一 CLI 回吐了用户消息，也不会重复加一轮）。
            */
            if (!m.toolResult) {
              const text = m.text ?? ''
              setTurns((prev) => {
                const last = prev[prev.length - 1]
                // 刚发出去的那条我们自己已经加过了 ⇒ 别重复
                if (last && !last.answer && last.steps.length === 0 && last.userText === text) {
                  return prev
                }
                turnCounter.current += 1
                return [
                  ...prev,
                  {
                    id: `turn-${turnCounter.current}`,
                    userText: text,
                    steps: [],
                    streaming: '',
                    collapsed: false,
                  },
                ]
              })
              break
            }
            const name = toolNamesRef.current[m.toolResult.toolUseId] ?? '工具'
            updateLastTurn((t) => ({
              ...t,
              steps: [
                ...t.steps,
                {
                  kind: 'tool-result',
                  name,
                  result: m.toolResult!.content,
                  isError: m.toolResult!.isError,
                },
              ],
              activity: '正在思考…',
            }))
            break
          }
          break
        }
        case 'log':
          setLog((prev) => [...prev.slice(-50), event.text])
          break
        case 'error':
          setStatus((prev) => ({ ...prev, state: 'error', error: event.message }))
          break
        case 'status':
          setStatus(event.status)
          if (event.status.sessionId) sessionIdRef.current = event.status.sessionId
          // 本轮结束 ⇒ 过程折叠起来（哪怕没有最终回答）
          if (event.status.turnComplete) {
            updateLastTurn((t) => ({ ...t, collapsed: true, activity: undefined }))
          }
          break
      }
    })
    const offStatus = window.jhyyIde.claude.onStatus((s) => setStatus(s))
    return () => {
      offEvent()
      offStatus()
    }
  }, [])

  // turnsRef 跟着状态走（事件回调里要读「最后一轮结束了没」）
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  // 自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, log])

  const ensureSession = useCallback(
    async (resumeSessionId?: string) => {
      if (startedRef.current) return true
      startedRef.current = true
      // ⚠️ 渲染进程里**没有 `process`**（contextIsolation + nodeIntegration 都是关的）。
      // 以前这里写的是 `process.cwd()` —— 没打开文件时会 ReferenceError。
      // 现在让主进程给默认目录。
      const cwd = filePath ? dirnameOf(filePath) : await window.jhyyIde.file.cwd()
      const result = await window.jhyyIde.claude.start({
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      })
      if (!result.ok) {
        startedRef.current = false
        setStatus({ state: 'error', error: result.error })
        return false
      }
      return true
    },
    [filePath],
  )

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    if (!(await ensureSession())) return
    turnCounter.current += 1
    setTurns((prev) => [
      ...prev,
      {
        id: `turn-${turnCounter.current}`,
        userText: text,
        steps: [],
        streaming: '',
        collapsed: false,
      },
    ])
    setInput('')
    await window.jhyyIde.claude.send(text)
  }, [ensureSession, input])

  const stop = useCallback(async () => {
    await window.jhyyIde.claude.stop()
    startedRef.current = false
  }, [])

  /** 新建会话 —— 停掉现在的，清空对话。 */
  const newChat = useCallback(async () => {
    await stop()
    setTurns([])
    setStatus({ state: 'idle' })
    sessionIdRef.current = null
    toolNamesRef.current = {}
  }, [stop])

  /** 恢复一条历史会话。 */
  const resumeSession = useCallback(
    async (s: SavedSession) => {
      await stop()
      setShowHistory(false)
      toolNamesRef.current = {}
      /*
        ⚠️ **把历史对话填回界面** —— `claude --resume` 只会把对话**接上**，
        **不会把历史消息再吐一遍**（用户报过「点历史会话然后点其中一个，
        还是没有历史对话」）。所以历史得由 IDE 自己留着并还原 ✓。
      */
      turnCounter.current += 1
      setTurns(
        (s.turns ?? []).map((t, i) => ({
          id: `turn-${turnCounter.current}-${i}`,
          userText: t.userText,
          steps: t.steps ?? [],
          streaming: '',
          ...(t.answer !== undefined ? { answer: t.answer } : {}),
          collapsed: true,
        })),
      )
      const ok = await ensureSession(s.sessionId)
      if (ok) {
        setStatus((prev) => ({ ...prev, state: 'waiting', sessionId: s.sessionId }))
        sessionIdRef.current = s.sessionId
      }
    },
    [ensureSession, stop],
  )

  /**
   * 有消息了就把这次会话存进历史。
   *
   * ⚠️ **两个条件都得满足**：有消息 **且** 知道 sessionId。
   *
   * 以前只盯着「消息数变了」—— 而第一条消息是在 `claude.start()` 返回**之后**
   * 才发出去的，CLI 的 `system/init` 事件（带 sessionId）**那时候还没到** ⇒
   * sessionId 是空的 ⇒ 直接 return ⇒ **历史永远存不下来**（用户报过
   * 「即使有 ai 的历史对话，也不会显示出来，依旧是空的」）。
   *
   * 所以依赖里要带上 `status.sessionId` —— 它到了就补存一次。
   */
  useEffect(() => {
    const id = status.sessionId
    if (!id || turns.length === 0) return
    const first = turns[0]?.userText ?? '（空会话）'
    const title = first.length > 40 ? `${first.slice(0, 40)}…` : first
    const cwd = filePath ? dirnameOf(filePath) : ''
    const list = sessionsRef.current
    const existing = list.find((s) => s.sessionId === id)
    // ⚠️ **把对话内容也存下来** —— 恢复历史会话时要靠它把界面填回去
    //   （`claude --resume` 不会把历史消息再吐一遍）。
    //   只留最近 20 轮，别把 localStorage 撑爆。
    const saved = turns.slice(-20).map((t) => ({
      userText: t.userText,
      ...(t.answer !== undefined ? { answer: t.answer } : {}),
      steps: t.steps,
    }))
    const next = existing
      ? list.map((s) => (s.sessionId === id ? { ...s, ts: Date.now(), turns: saved } : s))
      : [{ sessionId: id, title, cwd, ts: Date.now(), turns: saved }, ...list].slice(0, 20)
    persistSessions(next)
    // 只在「消息数」或「sessionId」真的变了的时候写 —— 否则每次渲染都写一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, status.sessionId])

  const stateText: Record<string, string> = {
    idle: '未开始',
    starting: '启动中…',
    running: '思考中…',
    waiting: '等你说话',
    stopping: '停止中…',
    stopped: '已结束',
    error: '出错',
  }

  const fileName = filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <span className="chat-header-title">
          <Icon name="chat" size={14} />
          聊天
        </span>
        <span className="chat-header-state">{stateText[status.state] ?? status.state}</span>
        <span className="spacer" />
        <button className="icon-button" title="新建会话" onClick={() => void newChat()}>
          <Icon name="plus" size={14} />
        </button>
        <div className="chat-history-wrap">
          <button
            className="icon-button"
            title="历史会话"
            onClick={() => setShowHistory((v) => !v)}
          >
            <Icon name="history" size={14} />
          </button>
          {showHistory && (
            <div className="chat-history">
              <div className="chat-history-title">会话</div>
              {sessions.length === 0 ? (
                <div className="chat-history-empty">还没有历史会话</div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    className="chat-history-item"
                    onClick={() => void resumeSession(s)}
                  >
                    <span className="chat-history-item-title">{s.title}</span>
                    <span className="chat-history-item-time">
                      {new Date(s.ts).toLocaleDateString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          className="icon-button"
          title="停止"
          disabled={status.state === 'idle'}
          onClick={() => void stop()}
        >
          <Icon name="stop" size={14} />
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
        {turns.length === 0 && (
          <div className="empty">
            {claudePath
              ? '问问 Claude 吧 —— 它能调 jhyy_check 看真实编译错误。'
              : '没找到 Claude Code 可执行文件（claude CLI）。'}
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="chat-turn">
            <div className="bubble user">{turn.userText}</div>

            {turn.collapsed ? (
              <>
                {/*
                  过程收进一个**折叠块** —— 展开才看得到思考和工具调用。
                  折叠起来就只剩一行「已完成」（用户提的）。
                  每轮都有一行 —— 形状一致，用户知道「这一轮已经跑完了」。
                */}
                <details className="chat-turn-steps">
                  <summary>已完成</summary>
                  <div className="chat-turn-body">
                    {turn.steps.map((step, i) => (
                      <StepView key={i} step={step} />
                    ))}
                  </div>
                </details>
                {turn.answer && (
                  <div className="bubble assistant">
                    <Markdown text={turn.answer} />
                  </div>
                )}
              </>
            ) : (
              <>
                {/* 进行中 —— 只留一行状态，不刷屏 */}
                {turn.activity && <div className="bubble activity">{turn.activity}</div>}
                {turn.streaming && (
                  <div className="bubble assistant streaming">{turn.streaming}</div>
                )}
              </>
            )}
          </div>
        ))}

        {log.length > 0 && (
          <details className="chat-log">
            <summary>CLI 日志（{log.length}）</summary>
            <pre>{log.join('\n')}</pre>
          </details>
        )}
      </div>

      <div className="chat-composer">
        {fileName && (
          <div className="chat-attachments">
            <span className="chat-attachment">
              <Icon name="file" size={12} />
              {fileName}
            </span>
          </div>
        )}
        <textarea
          className="chat-textarea"
          value={input}
          placeholder="跟 Claude 说点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="chat-mode-row">
          {/*
            ⚠️ **这几个 chip 以前是纯摆设**（用户提的：「附加文件、agent 和自动
            完全是摆设没法调」）。现在：

            - **当前文件** —— 不是装饰：Claude 的系统提示里**真的有**这个文件
              （见 `IPC.ideContext`）⇒ 悬停能看到说明。
            - **只读** —— 真的开关：打开后系统提示里会写「用户要求你不要修改文件」。
            - ~~模型~~ —— 删掉了：模型是 claude CLI 自己配的，IDE 管不着，
              摆一个假的「自动」下拉反而误导人。
          */}
          <span className="chat-chip static" title="Claude 能看到的当前文件">
            <Icon name="attach" size={13} />
            {fileName ?? '（没打开文件）'}
          </span>
          <button
            className={readOnly ? 'chat-chip on' : 'chat-chip'}
            title={
              readOnly
                ? '已开启只读：Claude 不会被要求修改文件（点一下关掉）'
                : '只读模式：让 Claude 只给建议、不改文件（点一下打开）'
            }
            onClick={() => onReadOnlyChange?.(!readOnly)}
          >
            <Icon name="terminal" size={13} />
            只读
          </button>
          <span className="spacer" />
          <button
            className="chat-send"
            title="发送 (Enter)"
            disabled={!input.trim()}
            onClick={() => void send()}
          >
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>

      <div className="chat-footer">
        <span>Claude Code</span>
        {/*
          ⚠️ **不显示 token / 费用** —— 用户提的：「token 价格反正也算不对，
          不如就不要算」。CLI 报的 usage 跟实际计费对不上，显示一个错的数字
          比不显示更糟。
        */}
      </div>
    </div>
  )
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

/** 折叠块里的一个「过程」条目。 */
function StepView({ step }: { step: ChatStep }) {
  switch (step.kind) {
    case 'thinking':
      return <div className="bubble thinking">{step.text}</div>
    case 'tool':
      return (
        <div className="bubble tool">
          <span className="tool-name">{step.name}</span>
          <pre>{JSON.stringify(step.input, null, 2)}</pre>
        </div>
      )
    case 'tool-result':
      return (
        <div className={`bubble tool-result${step.isError ? ' error' : ''}`}>
          <span className="tool-name">{step.name}</span>
          <pre>{step.result}</pre>
        </div>
      )
  }
}
