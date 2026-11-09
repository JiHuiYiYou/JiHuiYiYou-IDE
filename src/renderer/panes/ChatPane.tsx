import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ClaudeEvent, ClaudeStatus } from '@shared/claude'
import { Icon } from '../workbench/icons'
import { Markdown } from './Markdown'

interface Props {
  /** 当前打开的文件路径 —— Claude 的工作目录 */
  filePath: string | null
  /**
   * 当前标签页显示的名字（磁盘文件是文件名，**未命名的新文件**也是
   * 「未命名-1.jhyy」这种）。
   *
   * ⚠️ 未命名文件**没有路径** —— 只看 `filePath` 的话，聊天面板会对它显示
   * 「（没打开文件）」（用户报过：这不对 —— 用户明明开着一个文件）。
   */
  fileName?: string | null
  /**
   * Claude 的工作目录。
   *
   * ⚠️ 未命名的新文件**没有路径** ⇒ 不能拿它推目录 ⇒ 由外面给
   * （退到最近打开过的那个文件的目录）。
   */
  cwd?: string | null
  /** 文件在外部（Claude）被改了 */
  externalChange?: string | null
  /** 外部改了文件 → 重新加载 */
  onReload?: () => void
  /** 只读模式 —— Claude 只给建议、不改文件 */
  readOnly?: boolean
  /** 切换只读模式 */
  onReadOnlyChange?: (readOnly: boolean) => void
  /**
   * 取当前缓冲区的内容（**只在开始会话的那一刻调一次**）。
   *
   * ⚠️ **这是个「函数」prop，不是「值」prop** ——
   *   传值的话，每敲一个字聊天面板都要重渲染（内容是几 MB 的字符串）✗
   *   ⇒ 传函数 ⇒ 面板不受影响，只有**开始会话**的那一刻才真的去取 ✓
   *
   * ⇒ 返回 `undefined` = 「有未保存的修改，但内容太大没带过来」
   *   （主进程会改成一句话说明，而不是贴一个空代码块）。
   */
  getSource?: () => string | undefined
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
    // ⚠️ **`'text'`** —— 首段正文归到「过程」时用的那一种
    steps: { kind: 'thinking' | 'tool' | 'tool-result' | 'text'; text?: string; name?: string; input?: unknown; result?: string; isError?: boolean }[]
  }[]
}

const SESSIONS_KEY = 'jhyy-ide.claude-sessions.v1'

/** 思考中的提示词 —— 轮着换，别一直杵着同一个（用户提的）。 */
const THINKING_WORDS = ['正在思考…', '思考中…', '让我想想…', '正在琢磨…', '嗯…']

/**
 * 一轮对话里的一个**过程**条目。
 *
 * ⚠️ 这些东西以前是一条条气泡直接打出来的 —— 一轮下来能刷十几行
 * （思考 + 每个工具的入参 + 每个工具的输出），把真正的回答挤到屏幕外。
 * 现在它们收进一个折叠块里。
 */
interface ChatStep {
  kind: 'thinking' | 'tool' | 'tool-result' | 'text'
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
  /**
   * 助手说过的**每一段**正文（按顺序）。
   *
   * ⚠️ **一轮里可能有好几段** —— 模型常常「先说一段 → 调工具 → 再说一段」
   *    ⇒ 以前只留**最后一段** ⇒ 前面的**凭空消失** ✗
   *    （用户定的规矩：**首段归「过程」，其余是正文** ✓）
   */
  bodies: string[]
  /** 助手最后一条**完整**消息的正文（= bodies 的最后一段；历史里存的就是它） */
  answer?: string
  /** 正在流式输出的正文（最后一条完整消息之后又收到的增量） */
  streaming: string
  /**
   * `streaming` 是不是比 `answer` **新**。
   *
   * ⚠️ 这是「历史会话显示的不是最终回答，而是思考过程里某句话」的根因：
   * 模型常常先吐一句「我先看看这个文件」（那是一条**完整**的 assistant
   * 消息），再调工具，最后才给最终答案。如果最终答案只以**增量**的形式
   * 到达（有些 CLI 版本只发增量、不发完整消息），那 `answer` 就永远停在
   * 那句「我先看看」上 —— 显示出来的就是它，而不是最终回答 ✓。
   *
   * ⇒ 增量比完整消息新时，**以增量为准**。
   */
  streamingIsNewer: boolean
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
/** 外面能叫它做的事（现在只有「聚焦输入框」）。 */
export interface ChatPaneHandle {
  /** 把光标放进输入框（命令「聚焦聊天」用） */
  focusInput(): void
}

const ChatPane = forwardRef<ChatPaneHandle, Props>(function ChatPane(
  {
    filePath,
    fileName,
    cwd,
    externalChange,
    onReload,
    readOnly = false,
    onReadOnlyChange,
    getSource,
  },
  ref,
) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ClaudeStatus>({ state: 'idle' })
  const [log, setLog] = useState<string[]>([])
  const [claudePath, setClaudePath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 输入框 —— 「聚焦聊天」要把光标放进来 */
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ⚠️ **「聚焦聊天」命令**（Ctrl+Alt+I）要能把光标放进输入框 ⇒ 暴露一个方法
  useImperativeHandle(
    ref,
    () => ({
      focusInput: () => inputRef.current?.focus(),
    }),
    [],
  )
  const startedRef = useRef(false)
  /** 这次会话用的 sessionId —— 用来存历史 */
  const sessionIdRef = useRef<string | null>(null)
  /** 上一次存历史时用的 sessionId —— 用来判断「是不是换了个新会话」 */
  const lastSavedSessionRef = useRef<string | null>(null)
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

    /** 应用一次状态更新（两条通道共用）。 */
    const applyStatus = (s: ClaudeStatus): void => {
      /*
        ⚠️ **别把 sessionId 弄丢** —— 有的状态事件不带它（不带就覆盖掉的话，
        存历史的 effect 依赖 `status.sessionId` ⇒ 一条不带它的状态事件就能让
        「这一轮的内容」再也存不进历史 ⇒ 恢复历史会话时看到的是半截对话）。
        ⚠️ 但 **error 要照旧被清掉**（新状态没带错误 ⇒ 错误没了）——
        不然一条旧错误会一直挂在聊天面板顶上。
      */
      setStatus((prev) => ({
        ...prev,
        ...s,
        sessionId: s.sessionId ?? prev.sessionId,
        error: s.error,
      }))
      if (s.sessionId) sessionIdRef.current = s.sessionId
      // 本轮结束 ⇒ 过程折叠起来（哪怕没有最终回答）
      if (s.turnComplete) {
        updateLastTurn((t) => ({ ...t, collapsed: true, activity: undefined }))
      }
    }

    const offEvent = window.jhyyIde.claude.onEvent((event: ClaudeEvent) => {
      switch (event.type) {
        case 'delta':
          // 增量文本 —— 正在流式输出的回答
          if (lastTurnClosed()) break
          updateLastTurn((t) => ({
            ...t,
            streaming: t.streaming + event.text,
            // 增量比上一条完整消息**新** ⇒ 显示时以它为准
            streamingIsNewer: true,
          }))
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
                /*
                  ⚠️ **这里不能把这一轮标成「已完成」** ——
                  模型可能先写一段文字、再调工具、再写一段。
                  提前折叠 ⇒ 后面的工具调用和思考就都看不见了
                  （用户报过「先显示正在思考，状态就变成已完成，然后才输出那句话，
                  但实际上还没干完活」）。

                  ⇒ 折叠只发生在**这一轮真的结束**时（`status.turnComplete`）✓。

                  ⚠️⚠️ **正文要**累加**，不是覆盖** ——
                  以前 `answer: m.text` ⇒ 第二段正文把第一段**整个冲掉**了
                  （而 body 里还在引用第一段的变量 ⇒ 读了一个未定义的东西）✗
                  ⇒ 现在每一段都进 `bodies` ⇒
                  **首段归「过程」、其余是正文**（见 `splitBodies`）✓
                */
                return {
                  ...t,
                  steps,
                  bodies: [...t.bodies, m.text],
                  answer: m.text,
                  streaming: '',
                  // 完整消息到了 ⇒ 它是**最新**的正文（增量被它取代）
                  streamingIsNewer: false,
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
                /*
                  ⚠️ **恢复历史会话时别再加一轮** ——
                  恢复出来的那些轮子都是「已完成」的（collapsed），CLI 那边
                  万一回放了老消息，也不该在界面上多出重复的一轮。
                */
                if (last?.collapsed) return prev
                turnCounter.current += 1
                return [
                  ...prev,
                  {
                    id: `turn-${turnCounter.current}`,
                    userText: text,
                    steps: [],
                    bodies: [],
                    streaming: '',
                    streamingIsNewer: false,
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
          applyStatus(event.status)
          break
      }
    })
    // ⚠️ 两条通道都要处理 —— 主进程平时走 ，
    //    出错时走  ⇒ 「本轮结束」不能只在一条通道里认。
    const offStatus = window.jhyyIde.claude.onStatus((s) => applyStatus(s))
    return () => {
      offEvent()
      offStatus()
    }
  }, [])

  // turnsRef 跟着状态走（事件回调里要读「最后一轮结束了没」）
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  /*
    思考中的提示**换个花样** —— 用户提的：「思考的时候加点颜文字变化没那么单调」。

    只有一个「正在思考…」杵在那儿 ⇒ 看起来像卡住了。隔一会儿换个说法，
    让人知道**它还在动** ✓。
  */
  useEffect(() => {
    const timer = setInterval(() => {
      setTurns((prev) => {
        if (prev.length === 0) return prev
        const last = prev[prev.length - 1]
        if (!last.activity?.startsWith('正在思考')) return prev
        const idx = THINKING_WORDS.indexOf(last.activity)
        const next = THINKING_WORDS[(idx + 1) % THINKING_WORDS.length]
        return [...prev.slice(0, -1), { ...last, activity: next }]
      })
    }, 1400)
    return () => clearInterval(timer)
  }, [])

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
      //
      // ⚠️ 未命名的新文件**没有路径** ⇒ 用外面给的 `cwd`
      //（最近打开过的那个文件的目录）⇒ 别退到 home 目录去。
      const workDir = cwd ?? (filePath ? dirnameOf(filePath) : await window.jhyyIde.file.cwd())
      const result = await window.jhyyIde.claude.start({
        cwd: workDir,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        /*
          ⚠️ **源码只在「开始会话」这一刻给一次** ——
          系统提示是**烤死**的（`jhyyCheatSheet()` 只在 `claude.start` 里调一次）⇒
          ⇒ 每时每刻发整份源码过 IPC 是纯浪费（用户报过「IDE 特别卡」）⇒
          ⇒ 改成这里取一次最新的内容传过去 ✓
        */
        ...(getSource ? { source: getSource() } : {}),
      })
      if (!result.ok) {
        startedRef.current = false
        setStatus({ state: 'error', error: result.error })
        return false
      }
      return true
    },
    [cwd, filePath, getSource],
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
        bodies: [],
        streaming: '',
        streamingIsNewer: false,
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
      setShowHistory(false)
      toolNamesRef.current = {}
      /*
        ⚠️ **先把历史填回界面，再去连 CLI** ——

        连 CLI 要**停掉旧会话**（等它退出，最长 1.5s）+ **起新进程**
        （CLI 自己启动就要好几秒，里头还要连 MCP server）⇒ 整个几秒。

        以前是「先 await stop() 再填界面」⇒ 点一下历史会话，界面**好几秒
        都不动**（用户报过：「卡好久才会连上之前的对话」）。

        ⇒ 界面**立刻**有东西看，连接在后台慢慢连 ✓。
      */
      turnCounter.current += 1
      setTurns(
        (s.turns ?? []).map((t, i) => ({
          id: `turn-${turnCounter.current}-${i}`,
          userText: t.userText,
          steps: t.steps ?? [],
          // 历史里存的是「最终回答」⇒ 恢复时它就是**唯一**的一段
          bodies: t.answer !== undefined ? [t.answer] : [],
          streaming: '',
          streamingIsNewer: false,
          ...(t.answer !== undefined ? { answer: t.answer } : {}),
          collapsed: true,
        })),
      )
      sessionIdRef.current = s.sessionId
      setStatus((prev) => ({ ...prev, state: 'starting', sessionId: s.sessionId }))
      // 旧的会话得先停掉 —— 不然 CLI 那边两个进程抢同一个终端
      await stop()
      const ok = await ensureSession(s.sessionId)
      if (ok) {
        setStatus((prev) => ({ ...prev, state: 'waiting', sessionId: s.sessionId }))
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
   *
   * ⚠️ **还要盯住「内容变了」** —— 以前只盯「轮数变了」，而一轮的内容是
   * **之后**才慢慢长出来的（模型先思考、再调工具、最后才给回答）⇒
   * 存进去的是**还没写完的那一轮** ⇒ 恢复历史会话时看到的是「思考过程的
   * 某句话」，不是最终回答（用户报过）。
   *
   * ⇒ 依赖 `turns` 本身（内容变了引用就变）。
   *   - **sessionId 刚到** ⇒ 立刻存一次（不然这次会话压根进不了历史）；
   *   - **内容变了** ⇒ 去抖 500ms 再存（流式输出时每来一个字就变一次，
   *     不去抖的话 localStorage 会被写几百次）。
   */
  useEffect(() => {
    const id = status.sessionId
    if (!id || turns.length === 0) return

    const save = (): void => {
      const first = turns[0]?.userText ?? '（空会话）'
      const title = first.length > 40 ? `${first.slice(0, 40)}…` : first
      const sessionCwd = cwd ?? (filePath ? dirnameOf(filePath) : '')
      const list = sessionsRef.current
      const existing = list.find((s) => s.sessionId === id)
      // ⚠️ **把对话内容也存下来** —— 恢复历史会话时要靠它把界面填回去
      //   （`claude --resume` 不会把历史消息再吐一遍）。
      //   只留最近 20 轮，别把 localStorage 撑爆。
      //
      //   `answer` 存的是 `answerOf(t)`（**当前真正显示的那段**）——
      //   有些 CLI 版本只发增量、不发完整消息，光存 `t.answer` 会把
      //   最终回答整个丢掉（用户报过「有时候根本就没有最终的回复，也被吞了」）。
      const saved = turns.slice(-20).map((t) => {
        const answer = answerOf(t)
        return {
          userText: t.userText,
          ...(answer ? { answer } : {}),
          // ⚠️ **用 processSteps** —— 首段正文（归到「过程」的那段）也在里面
          //    ⇒ 不然恢复历史时**首段就丢了** ✗
          steps: processSteps(t),
        }
      })
      const next = existing
        ? list.map((s) => (s.sessionId === id ? { ...s, ts: Date.now(), turns: saved } : s))
        : [{ sessionId: id, title, cwd: sessionCwd, ts: Date.now(), turns: saved }, ...list].slice(0, 20)
      persistSessions(next)
    }

    // 新的会话 ⇒ 立刻存一次（历史列表里得马上出现它）
    if (lastSavedSessionRef.current !== id) {
      lastSavedSessionRef.current = id
      save()
      return
    }
    // 内容变了 ⇒ 去抖
    const timer = setTimeout(save, 500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, status.sessionId])

  const stateText: Record<string, string> = {
    idle: '未开始',
    starting: '启动中…',
    running: '思考中…',
    waiting: '等你说话',
    stopping: '停止中…',
    stopped: '已结束',
    error: '出错',
  }

  /**
   * 聊天面板顶部那个「当前文件」的名字。
   *
   * ⚠️ **优先用 `fileName` 传进来的那个** —— 未命名的新文件没有路径，
   * 光从 `filePath` 推名字会推不出来 ⇒ 只能显示「（没打开文件）」（不对）。
   */
  const shownFileName =
    fileName ?? (filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null)

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
                    {/* ⚠️ **用 processSteps** —— 首段正文（归到「过程」的那段）
                        也在里面 ⇒ 它不会凭空消失 ✓ */}
                    {processSteps(turn).map((step, i) => (
                      <StepView key={i} step={step} />
                    ))}
                  </div>
                </details>
                {answerOf(turn) && (
                  <div className="bubble assistant">
                    <Markdown text={answerOf(turn)!} />
                  </div>
                )}
              </>
            ) : (
              <>
                {/* 进行中 —— 一行状态 + 已经写出来的正文 */}
                {turn.activity && <div className="bubble activity">{turn.activity}</div>}
                {answerOf(turn) && (
                  <div className="bubble assistant streaming">{answerOf(turn)}</div>
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
        {shownFileName && (
          <div className="chat-attachments">
            <span className="chat-attachment">
              <Icon name="file" size={12} />
              {shownFileName}
            </span>
          </div>
        )}
        <textarea
          ref={inputRef}
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
            {shownFileName ?? '（没打开文件）'}
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
})

/**
 * ⚠️ **要 `memo`** —— 聊天面板里有**一长串历史消息** ⇒
 *   `App` 因为别的事重渲染时（后台诊断每 600 ms 更新一次 …）
 *   它**不该**把整串历史重画一遍 ✗ ⇒ ⇒ `memo` 一加就省掉了 ✓
 *
 * ⚠️ **前提：回调得是稳定的** —— `App` 里那个 `onReload` 得是 `useCallback` ✓
 */
export default memo(ChatPane)

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

/**
 * 这一轮已经写出来的正文。
 *
 * ⚠️ **谁更新就以谁为准** ——
 * - `streaming` 比 `answer` 新（增量在完整消息之后到的）⇒ 用 `streaming`；
 * - 否则用 `answer`（完整的 assistant 消息）；再没有就退回 `streaming`。
 *
 * 之前是 `answer ?? streaming`（**永远优先旧的完整消息**）⇒ 模型先说的那句
 * 「我先看看」（一条完整消息）会把后来的最终回答**整个盖掉** ——
 * 用户看到的就是思考过程里某一句话，而不是最终回答。
 *
 * 另外，只有增量的 CLI 版本（只发增量、不发完整消息）也能正常显示 ✓
 * （用户报过「有时候根本就没有最终的回复，也被吞了」）。
 */
function answerOf(turn: ChatTurn): string {
  return splitBodies(turn).answer
}

/**
 * **把这一轮的正文拆成「首段（过程）」和「正文」。**
 *
 * ⚠️ **一轮里可能有好几段** —— 模型常常「先说一段 → 调工具 → 再说一段」
 *    ⇒ 以前只留**最后一段** ⇒ 前面的**凭空消失** ✗
 *
 * ⇒ **用户定的规矩**：**首段归「过程」，其余是正文** ✓
 *   - 只有一段（没别的了）⇒ 它就是**答案**（别把唯一的回答藏进折叠块里）✓
 *   - 首段 + 后续 ⇒ 首段进「过程」，后续是正文 ✓
 *
 * ⚠️ **只有增量的 CLI 版本**（只发增量、不发完整消息）⇒ `bodies` 是空的
 *    ⇒ 全部走 `streaming` ✓（用户报过「有时候根本就没有最终的回复，也被吞了」）
 */
function splitBodies(turn: ChatTurn): { opening?: string; answer: string } {
  const bodies = turn.bodies ?? []
  // ⚠️ 增量比完整消息新 ⇒ 以增量为准（见 ChatTurn.streamingIsNewer 的说明）
  const newer = turn.streamingIsNewer && turn.streaming ? turn.streaming : ''
  if (bodies.length === 0) return { answer: newer }
  const rest = bodies.slice(1)
  const parts = [...rest]
  if (newer) parts.push(newer)
  // 只有首段、后面什么都没有 ⇒ 它就是答案
  if (parts.length === 0) return { answer: bodies[0] }
  return { opening: bodies[0], answer: parts.join('\n\n') }
}

/**
 * 这一轮的**过程条目** —— 首段正文（如果它被归到「过程」了）排在最前面。
 *
 * ⚠️ 首段正文**排在工具调用前面** —— 它是模型**先**说的 ✓
 */
function processSteps(turn: ChatTurn): ChatStep[] {
  const { opening } = splitBodies(turn)
  if (!opening) return turn.steps
  return [{ kind: 'text', text: opening }, ...turn.steps]
}

/** 折叠块里的一个「过程」条目。 */
function StepView({ step }: { step: ChatStep }) {
  switch (step.kind) {
    case 'thinking':
      return <div className="bubble thinking">{step.text}</div>
    case 'text':
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
