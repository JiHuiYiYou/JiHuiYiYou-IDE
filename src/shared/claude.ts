/**
 * Claude Code 集成的共享类型。
 *
 * 协议细节是在本机 `claude 2.1.302` 上实测验证过的（不是照文档推断）——
 * 见计划书 P5.1 / P5.2。
 */

/** 流式事件里，助手消息的内容块。 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

/** 一次工具调用。 */
export interface ClaudeToolUse {
  id: string
  name: string
  input: unknown
}

/** 工具调用结果。 */
export interface ClaudeToolResult {
  toolUseId: string
  /** 结果文本 */
  content: string
  isError: boolean
}

/** 一轮对话里的一条消息。 */
export interface ClaudeMessage {
  role: 'user' | 'assistant'
  /** 助手的文本内容 */
  text?: string
  /** 助手的思考内容 */
  thinking?: string
  /** 助手发起的工具调用 */
  toolUses?: ClaudeToolUse[]
  /** 工具执行结果（role 为 user 时） */
  toolResult?: ClaudeToolResult
}

/** 会话状态。 */
export type ClaudeSessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'error'

/** 会话整体状态（推给渲染进程）。 */
export interface ClaudeStatus {
  state: ClaudeSessionState
  /** session id（用于恢复会话） */
  sessionId?: string
  /** 出错时的说明 */
  error?: string
  /** 本轮是否已结束 */
  turnComplete?: boolean
  /** 本轮的统计 */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    costUsd?: number
    numTurns?: number
  }
  /** 被拒绝的权限请求 */
  permissionDenials?: string[]
}

/** 主进程 → 渲染进程的事件。 */
export type ClaudeEvent =
  | { type: 'status'; status: ClaudeStatus }
  | { type: 'message'; message: ClaudeMessage }
  | { type: 'delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'log'; text: string }
  | { type: 'error'; message: string }

/** 渲染进程 → 主进程的请求。 */
export interface ClaudeStartOptions {
  /** 工作目录（一般是当前打开的文件所在的项目目录） */
  cwd: string
  /** 恢复已有会话 */
  resumeSessionId?: string
  /** 系统提示词追加内容 */
  appendSystemPrompt?: string
}
