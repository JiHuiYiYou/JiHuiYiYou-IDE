import type { ClaudeEvent, ClaudeStartOptions, ClaudeStatus } from './claude'
import type { CompileResult, RunResult, ToolchainInfo } from './jhyy'

/** IPC 通道名。集中定义，避免主/渲染两侧写错字符串。 */
export const IPC = {
  toolchainLocate: 'toolchain:locate',
  toolchainSetPath: 'toolchain:setPath',

  fileOpenDialog: 'file:openDialog',
  fileInitial: 'file:initial',
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileChanged: 'file:changed',
  fileWatch: 'file:watch',

  compile: 'jhyy:compile',
  run: 'jhyy:run',
  stop: 'jhyy:stop',

  claudeLocate: 'claude:locate',
  claudeStart: 'claude:start',
  claudeSend: 'claude:send',
  claudeStop: 'claude:stop',
  claudeEvent: 'claude:event',
  claudeStatus: 'claude:status',
} as const

export interface CompileRequest {
  file: string
  /** 只做诊断（--no-link，跳过 gcc 链接），打字时用这个 */
  noLink?: boolean
  /** 额外参数，直接透传给 jhyy.exe */
  extraArgs?: string[]
}

export interface RunRequest {
  file: string
  /** 运行超时（毫秒），默认 10000 */
  timeoutMs?: number
}

/** preload 暴露给渲染进程的 API 形状。 */
export interface JhyyIdeApi {
  toolchain: {
    locate(): Promise<ToolchainInfo>
    setPath(exePath: string): Promise<ToolchainInfo>
  }
  file: {
    openDialog(): Promise<{ path: string; content: string } | null>
    /** 启动参数里带来的文件（没有则 null） */
    initial(): Promise<{ path: string; content: string } | null>
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    onChanged(cb: (path: string) => void): () => void
    /** 让主进程开始监听某个目录（外部改动检测） */
    watch(dir: string): Promise<void>
  }
  jhyy: {
    compile(req: CompileRequest): Promise<CompileResult>
    run(req: RunRequest): Promise<RunResult>
    stop(): Promise<void>
  }
  claude: {
    /** 找 Claude Code 的可执行文件 */
    locate(): Promise<{ path: string; version?: string } | null>
    /** 开会话 */
    start(opts: ClaudeStartOptions): Promise<{ ok: boolean; error?: string }>
    /** 发一句话 */
    send(text: string): Promise<boolean>
    /** 结束会话 */
    stop(): Promise<void>
    /** 订阅主进程推来的事件 */
    onEvent(cb: (event: ClaudeEvent) => void): () => void
    /** 订阅会话状态 */
    onStatus(cb: (status: ClaudeStatus) => void): () => void
  }
}
