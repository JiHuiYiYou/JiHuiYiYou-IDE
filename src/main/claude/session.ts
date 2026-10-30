import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type {
  ClaudeContentBlock,
  ClaudeEvent,
  ClaudeMessage,
  ClaudeSessionState,
  ClaudeStatus,
  ClaudeToolUse,
} from '@shared/claude'
import { buildMcpConfig } from './mcp'

/**
 * Claude Code 会话管理 —— 直接 spawn 本机的 `claude` CLI。
 *
 * ## 协议（全部在本机 claude 2.1.302 上实测验证过）
 *
 * - `--output-format stream-json` **必须**配 `--verbose`，否则 CLI 直接拒绝启动。
 * - `--include-partial-messages` 会额外吐 `stream_event`，里面是原始 Anthropic
 *   SSE 负载；增量文本在 `event.delta.type === 'text_delta'` → `event.delta.text`。
 * - `--input-format stream-json` 让 stdin 变成多轮输入：每轮写一行
 *   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`。
 *   同一进程内可以连着写多轮，session_id 不变，每轮回一个 `result` 事件。
 * - 结束会话 = **关掉 stdin（EOF）** → CLI 跑完当前轮、发最后的 result、exit 0。
 * - `--permission-mode acceptEdits` 自动放行 Edit/Write；`--permission-prompts none`
 *   保证任何会触发询问的调用**直接被拒**而不是卡住（headless 下没人能回答询问，
 *   卡住就等于 IDE 挂死）。
 * - `--system-prompt` 会**替换**掉 Claude Code 的内置 system prompt（工具用法
 *   之类的指导会丢），所以要用 `--append-system-prompt`。
 * - 2.1.302 **没有** `--max-turns`（用 `--max-budget-usd`），也**没有**
 *   `--permission-prompt-tool`（所以做不了 IDE 内审批 UI）。
 */

/**
 * 传给 CLI 的工具白名单。
 *
 * ⚠️ `mcp__jhyy` 必须显式放行 —— jhyy MCP server 里的 `jhyy_check` /
 * `jhyy_run` / `jhyy_lang_ref` 是这个 IDE 里 Claude 能自己验证代码的关键。
 * 不放行的话它们会被 `--permission-prompts none` 直接拒掉（headless 下没人
 * 能回答询问），Claude 就只能靠猜。
 */
const ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'mcp__jhyy',
]

export interface SessionOptions {
  /** 工作目录 —— 一般是当前项目目录 */
  cwd: string
  /** 恢复已有会话 */
  resumeSessionId?: string
  /** 追加到 Claude Code 内置 system prompt 后面的内容 */
  appendSystemPrompt?: string
  /** 允许 Claude 碰的额外目录 */
  addDirs?: string[]
  /** 事件回调 */
  onEvent: (event: ClaudeEvent) => void
}

export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private state: ClaudeSessionState = 'idle'
  private sessionId: string | undefined
  private cwd: string
  private readonly onEvent: (event: ClaudeEvent) => void
  /** 本轮已发出的增量文本（用于去重） */
  private turnText = ''

  constructor(options: SessionOptions) {
    this.cwd = options.cwd
    this.onEvent = options.onEvent
    this.resumeSessionId = options.resumeSessionId
    this.appendSystemPrompt = options.appendSystemPrompt
    this.addDirs = options.addDirs ?? []
  }

  private resumeSessionId: string | undefined
  private appendSystemPrompt: string | undefined
  private addDirs: string[]

  get session(): ClaudeSessionState {
    return this.state
  }

  get currentSessionId(): string | undefined {
    return this.sessionId
  }

  private emitStatus(status?: Partial<ClaudeStatus>): void {
    this.onEvent({
      type: 'status',
      status: {
        state: this.state,
        sessionId: this.sessionId,
        ...status,
      },
    })
  }

  private setState(state: ClaudeSessionState, extra?: Partial<ClaudeStatus>): void {
    this.state = state
    this.emitStatus(extra)
  }

  /** 启动 CLI 进程。 */
  async start(exePath: string): Promise<void> {
    if (this.child) return

    /*
      ⚠️ **先把 sessionId 定下来**（而且是**我们自己**生成的）——
      不要等 CLI 的 `system/init` 事件。

      原因：CLI 可能因为别的原因**根本没初始化**（比如模型名不被它认，
      实测就见过 `[claude-code:unrecognized_model]`）⇒ 那个事件永远不来
      ⇒ 渲染进程拿不到 sessionId ⇒ **历史会话一次都存不下来**
      （用户报过「还是看不到历史会话」）。
    */
    this.sessionId = this.resumeSessionId ?? randomUUID()
    this.setState('starting')

    const args: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // ⚠️ **不要** `--replay-user-messages` —— 它的作用只是
      // 「把用户消息从 stdin 再吐回 stdout 确认一下」（CLI 自己的 help 原文）。
      // 留着它 ⇒ 我们刚发出去的话会被回显一遍 ⇒ 界面上多出重复的一轮。
      // 模型的上下文来自 `--resume` 加载的 transcript ✓，不受影响。
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
    ]

    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId)
    } else {
      // 自己生成 session id —— 进程还没起就知道会话 id，重启后可以直接恢复
      args.push('--session-id', this.sessionId)
    }

    args.push('--add-dir', this.cwd)
    for (const dir of this.addDirs) args.push('--add-dir', dir)

    // MCP：把语言仓库现成的 jhyy MCP server 挂上，Claude 就能自己跑
    // jhyy_check 看真实编译错误并自我修正
    const mcpConfig = await buildMcpConfig()
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig)
      args.push('--strict-mcp-config')
    }

    if (this.appendSystemPrompt) {
      args.push('--append-system-prompt', this.appendSystemPrompt)
    }

    const child = spawn(exePath, args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // stderr 是**日志通道**，不是错误通道 —— 实测正常运行时也只有警告行。
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.onEvent({ type: 'log', text: line })
      }
    })

    child.on('error', (err) => {
      this.setState('error', { error: err.message })
      this.child = null
    })

    child.on('close', (code) => {
      this.child = null
      if (this.state !== 'error') {
        this.setState('stopped', { turnComplete: true })
      }
      this.onEvent({ type: 'log', text: `[claude] 进程退出，退出码 ${code}` })
    })
  }

  /** 发一句话（新一轮）。 */
  send(text: string): boolean {
    const child = this.child
    if (!child || !child.stdin.writable) return false
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    this.turnText = ''
    this.setState('running')
    return true
  }

  /** 结束会话 —— 关 stdin（EOF），CLI 会跑完当前轮再退出。 */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.setState('stopping' as ClaudeSessionState)
    try {
      child.stdin.end()
    } catch {
      /* 已经关了 */
    }
    // 给它一点时间跑完当前轮；超时就强杀
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (this.child === child) {
      await this.killTree(child.pid)
      this.child = null
      this.setState('stopped')
    }
  }

  /** 杀掉进程树（Windows 上 taskkill /T 才能连子进程一起清掉）。 */
  private async killTree(pid: number | undefined): Promise<void> {
    if (!pid) return
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve())
    })
  }

  // ── stdout 解析 ───────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.buffer += this.decoder.write(chunk)
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        this.handleEvent(JSON.parse(line))
      } catch {
        // 不是 JSON —— 当日志看
        this.onEvent({ type: 'log', text: line })
      }
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'system': {
        const subtype = event.subtype as string | undefined
        if (subtype === 'init') {
          this.sessionId = (event.session_id as string) ?? this.sessionId
          this.setState('running')
        }
        return
      }

      case 'stream_event': {
        const inner = event.event as
          | { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
          | undefined
        const delta = inner?.delta
        if (!delta) return
        if (delta.type === 'text_delta' && delta.text) {
          this.turnText += delta.text
          this.onEvent({ type: 'delta', text: delta.text })
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          this.onEvent({ type: 'thinking-delta', text: delta.thinking })
        }
        return
      }

      case 'assistant': {
        const message = event.message as { content?: ClaudeContentBlock[] } | undefined
        const content = message?.content ?? []
        const blocks: ClaudeContentBlock[] = []
        let text: string | undefined
        let thinking: string | undefined
        const toolUses: ClaudeToolUse[] = []

        for (const block of content) {
          blocks.push(block)
          if (block.type === 'text') text = (text ?? '') + block.text
          else if (block.type === 'thinking') thinking = (thinking ?? '') + block.thinking
          else if (block.type === 'tool_use') {
            toolUses.push({ id: block.id, name: block.name, input: block.input })
          }
        }

        const msg: ClaudeMessage = { role: 'assistant' }
        if (text !== undefined) msg.text = text
        if (thinking !== undefined) msg.thinking = thinking
        if (toolUses.length > 0) msg.toolUses = toolUses
        this.onEvent({ type: 'message', message: msg })
        return
      }

      case 'user': {
        const message = event.message as
          | {
              content?: (
                | { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
              )[]
            }
          | undefined
        for (const block of message?.content ?? []) {
          if (block.type !== 'tool_result') continue
          this.onEvent({
            type: 'message',
            message: {
              role: 'user',
              toolResult: {
                toolUseId: block.tool_use_id ?? '',
                content: stringifyToolResult(block.content),
                isError: Boolean(block.is_error),
              },
            },
          })
        }
        return
      }

      case 'result': {
        const usage = event.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined
        this.setState('waiting', {
          turnComplete: true,
          usage: {
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            durationMs: event.duration_ms as number | undefined,
            costUsd: event.total_cost_usd as number | undefined,
            numTurns: event.num_turns as number | undefined,
          },
          permissionDenials: (event.permission_denials as string[] | undefined) ?? [],
        })
        return
      }

      default:
        return
    }
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text)
        return JSON.stringify(c)
      })
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}
