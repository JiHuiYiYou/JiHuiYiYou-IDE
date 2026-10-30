import type { ClaudeEvent, ClaudeStartOptions, ClaudeStatus } from './claude'
import type { CompileResult, RunResult, ToolchainInfo } from './jhyy'
import type {
  TerminalCommandEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStartRequest,
  TerminalStartResult,
} from './terminal'

/** IPC 通道名。集中定义，避免主/渲染两侧写错字符串。 */
export const IPC = {
  toolchainLocate: 'toolchain:locate',
  toolchainSetPath: 'toolchain:setPath',

  fileOpenDialog: 'file:openDialog',
  fileSaveDialog: 'file:saveDialog',
  fileInitial: 'file:initial',
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileChanged: 'file:changed',
  fileWatch: 'file:watch',
  /** 没打开文件时的默认工作目录（Claude 会话 / 终端用） */
  fileCwd: 'file:cwd',

  compile: 'jhyy:compile',
  run: 'jhyy:run',
  stop: 'jhyy:stop',
  /** main → renderer：程序的输出**边跑边**推（像 VS Code 的任务终端） */
  runOutput: 'jhyy:runOutput',

  claudeLocate: 'claude:locate',
  claudeStart: 'claude:start',
  claudeSend: 'claude:send',
  claudeStop: 'claude:stop',
  claudeEvent: 'claude:event',
  claudeStatus: 'claude:status',

  // 终端（管道 stdio，不是 PTY —— 见 shared/terminal.ts 的说明）
  terminalStart: 'terminal:start',
  /** 逐键触发，走 send/on 而不是 invoke —— 见 src/main/terminal.ts */
  terminalWrite: 'terminal:write',
  terminalKill: 'terminal:kill',
  terminalCd: 'terminal:cd',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  /** main → renderer：IDE 执行了一条命令，终端里已经显示出来了 */
  terminalCommand: 'terminal:command',

  // 剪贴板（走 Electron 的 clipboard 模块，不用 navigator.clipboard）
  clipboardReadText: 'clipboard:readText',
  clipboardWriteText: 'clipboard:writeText',

  // 窗口（标题栏上的「已保存」小圆点）
  windowSetEdited: 'window:setEdited',

  /** 渲染进程 → 主进程：把「IDE 现在是什么状态」告诉 Claude（写进系统提示） */
  ideContext: 'ide:context',
} as const

export interface CompileRequest {
  file: string
  /** 只做诊断（--no-link，跳过 gcc 链接），打字时用这个 */
  noLink?: boolean
  /** 超时（毫秒）—— 后台实时诊断要短一点，别占着 CPU 不放 */
  timeoutMs?: number
  /** 额外参数，直接透传给 jhyy.exe */
  extraArgs?: string[]
  /**
   * **后台的**检查（打字时的实时诊断）—— 别把命令回显到终端里。
   *
   * ⚠️ 用户报过「托块和文本编辑和 ai 聊天只要改了代码……都会触发就很烦人」：
   * 实时诊断是每 600 ms 一次的后台编译，要是每次都往终端里打一行
   * `> jhyy compile --no-link …`，终端就被刷满了（而且用户根本没点「检查」）。
   */
  quiet?: boolean
}

export interface RunRequest {
  file: string
  /** 运行超时（毫秒），默认 10000 */
  timeoutMs?: number
}

/**
 * 程序输出的一小段（**流式** —— 边跑边推）。
 *
 * ⚠️ VS Code 那边是 PTY + xterm 增量渲染，我们没 PTY ⇒ 自己推，
 * 这样用户能像 VS Code 那样边跑边看输出。
 */
export interface RunOutputEvent {
  stream: 'stdout' | 'stderr'
  text: string
}

/**
 * 磁盘上的文件被改了。
 *
 * ⚠️ `internal` 区分「**谁**改的」：
 * - `true` —— **IDE 内部**改的（Claude 这个 agent 用了 Edit/Write）。
 *   用户是让 Claude 改的 ⇒ 直接应用到编辑器，不用弹提示。
 * - `false` —— **外部程序**改的（别的编辑器、git checkout…）
 *   ⇒ 这时候才提示用户「文件在外部被修改了」。
 *
 * IDE 自己保存的文件根本不会走到这儿（主进程直接吞掉）。
 */
export interface FileChangedEvent {
  path: string
  internal: boolean
}

/** preload 暴露给渲染进程的 API 形状。 */
export interface JhyyIdeApi {
  toolchain: {
    locate(): Promise<ToolchainInfo>
    setPath(exePath: string): Promise<ToolchainInfo>
  }
  file: {
    openDialog(): Promise<{ path: string; content: string } | null>
    /** 另存为 —— 只问路径，不写文件 */
    saveDialog(defaultName?: string): Promise<string | null>
    /** 启动参数里带来的文件（没有则 null） */
    initial(): Promise<{ path: string; content: string } | null>
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    onChanged(cb: (e: FileChangedEvent) => void): () => void
    /** 让主进程开始监听某个目录（外部改动检测） */
    watch(dir: string): Promise<void>
    /** 没打开文件时的默认工作目录 */
    cwd(): Promise<string>
  }
  jhyy: {
    compile(req: CompileRequest): Promise<CompileResult>
    run(req: RunRequest): Promise<RunResult>
    stop(): Promise<void>
    /** 订阅程序的实时输出（stdout / stderr） */
    onOutput(cb: (e: RunOutputEvent) => void): () => void
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
  terminal: {
    /** 拉起一个 shell（懒启动 —— 只有切到「终端」页签才调） */
    start(req: TerminalStartRequest): Promise<TerminalStartResult>
    /** 往 stdin 写一段（逐键触发，不等回执） */
    write(data: string): void
    /** 杀掉 shell 进程树 */
    kill(): Promise<void>
    /** 换目录（管道没法改 cwd，只能往 shell 里发一条 cd 命令） */
    cd(cwd: string): Promise<void>
    /** 订阅 shell 的输出 */
    onData(cb: (event: TerminalDataEvent) => void): () => void
    /** 订阅 shell 退出 */
    onExit(cb: (event: TerminalExitEvent) => void): () => void
    /** 订阅「IDE 执行了一条命令」—— 用来把面板切到终端页签 */
    onCommand(cb: (event: TerminalCommandEvent) => void): () => void
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  window: {
    /** 让 Windows 在关闭按钮上画/抹掉「已保存」小圆点 */
    setEdited(edited: boolean): Promise<void>
  }
  ide: {
    /**
     * 把 IDE 的当前状态告诉主进程（写进 Claude 的系统提示）。
     *
     * ⚠️ 用户提的：「agent 拿不到部分重要信息 —— **不知道你当前打开的是哪个
     * 文件**。系统提示里完全没有编辑器/IDE 的状态，只有工作目录」。
     */
    setContext(ctx: IdeContext): void
  }
}

/** IDE 的当前状态 —— 给 Claude 看的。 */
export interface IdeContext {
  /** 当前打开的文件（没打开就是 null） */
  filePath: string | null
  /** 终端 / 程序的工作目录 */
  cwd: string | null
  /** 最近的诊断（问题面板里的那些） */
  diagnostics: { file: string; line: number; col: number; message: string }[]
  /** 输出面板的最后几行 */
  outputTail: string
  /** 用户开了「只读」⇒ Claude 只给建议、不改文件 */
  readOnly?: boolean
}
