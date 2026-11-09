import type { ClaudeEvent, ClaudeStartOptions, ClaudeStatus } from './claude'
import type { CompileResult, RunResult, ToolchainInfo } from './jhyy'
import type {
  PtyBackendInfo,
  TerminalInfo,
  TerminalListEvent,
  TerminalStateEvent,
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

  // 终端（真 PTY = node-pty/ConPTY，管道兜底 —— 见 shared/terminal.ts 的说明）
  terminalStart: 'terminal:start',
  /** 逐键触发，走 send/on 而不是 invoke —— 见 src/main/terminal.ts */
  terminalWrite: 'terminal:write',
  terminalKill: 'terminal:kill',
  terminalCd: 'terminal:cd',
  terminalData: 'terminal:data',
  /** 终端**列表**（VS Code 那样：可以有多个） */
  terminalList: 'terminal:list',
  /** 开一个新的终端 */
  terminalCreate: 'terminal:create',
  /** 关掉一个终端（杀它的 shell） */
  terminalClose: 'terminal:close',
  /** 切换当前终端 */
  terminalSelect: 'terminal:select',
  /** 终端列表变了（开 / 关 / 换）—— main → renderer 的推送 */
  terminalListEvent: 'terminal:listEvent',
  /**
   * 渲染进程 → 主进程：**这一批输出我已经写完了**（背压的回执）。
   *
   * ⚠️ 没有它，主进程只能一股脑往前推 ⇒ IPC 队列无限涨 ⇒ IDE 卡死。
   */
  terminalAck: 'terminal:ack',
  /**
   * 渲染进程 → 主进程：**我（新的）终端准备好了**。
   *
   * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ 它没回执过任何东西 ⇒
   *    主进程那边的「在途字节」会一直卡着 ⇒ 终端再也不出东西 ⇒
   *    ⇒ 渲染进程挂上来时要把背压状态**重置**一下 ✓
   */
  terminalReady: 'terminal:ready',
  /**
   * 主进程 → 渲染进程：**这个终端被「重启」了**（复用 ⇒ shell 重启 ⇒ 屏幕要清空）。
   *
   * ⚠️ VS Code 复用任务终端时会 `clearBuffer()`
   *   （`tasks/browser/terminalTaskSystem.ts:1614`）⇒ 不清的话
   *   上一轮跑程序的输出会**堆在**这一轮上面 ⇒ 看得莫名其妙 ✓
   */
  terminalRestart: 'terminal:restart',
  /**
   * 渲染进程 → 主进程：**把终端的当前内容存下来**（序列化后的字符串）。
   *
   * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ 终端的 scrollback 就没了 ⇒
   *    VS Code 是靠「pty 宿主进程还在 + 序列化回放」保住的 ⇒
   *    我们也存一份（主进程拿着，渲染进程来要的时候给它）✓
   */
  terminalSaveBuffer: 'terminal:saveBuffer',
  /** 渲染进程 → 主进程：**把之前存的终端内容给我**（重载后恢复用）。 */
  terminalGetBuffer: 'terminal:getBuffer',
  terminalExit: 'terminal:exit',
  /** main → renderer：IDE 执行了一条命令，终端里已经显示出来了 */
  terminalCommand: 'terminal:command',
  /** 窗口尺寸变了（列 / 行）—— 真控制台后端据此发 SIGWINCH */
  terminalResize: 'terminal:resize',
  /** 只写显示层（不进 stdin）—— 免得被 shell 当命令执行 */
  terminalDisplay: 'terminal:display',
  /** 现在是「真控制台」还是「管道兜底」—— 状态栏上那个徽章 */
  terminalBackend: 'terminal:backend',
  /** 后端变了（真控制台 ⇄ 管道兜底）—— main → renderer 的推送 */
  terminalBackendEvent: 'terminal:backendEvent',
  /**
   * shell 的状态变了（当前目录 / 空闲与否 / 上一条命令的退出码）——
   * main → renderer 的推送。
   *
   * ⚠️ 这些是 **shell 自己报上来的**（OSC 633），不是 IDE 猜的 ✓。
   */
  terminalState: 'terminal:state',
  /**
   * 用户**是不是正在看终端**（终端页签在前台）—— renderer → main。
   *
   * ⚠️ 看不见的时候主进程**不补提示符** ⇒ 后台跑十个命令不会攒十个
   *    「空提示符」（用户报过：「有时候会打印一堆这种空的」）⇒
   * ⇒ 等用户打开终端时补**一个** ✓。
   */

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
  /**
   * **编这段内容，而不是磁盘上的那个文件**。
   *
   * ⚠️ **后台实时诊断必须用它** ——
   *    诊断要反映**编辑器里现在是什么**，而不是**上次存盘时是什么** ⇒
   *    以前编的是磁盘上的旧文件 ⇒ **边打字边不报错**（用户改错了都看不见）✗
   *    而且诊断的行/列是**旧版本**的 ⇒ 波浪线落在错的行上 ✗
   *
   * ⚠️ 主进程会把它写进 scratch 目录的临时文件再编 ⇒
   *    **不会碰用户的项目目录** ✓；诊断里的文件名会被换回 `file` ✓
   */
  contents?: string
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
    /**
     * **终端列表**（VS Code 那样：可以有多个）。
     *
     * ⚠️ 至少有一个（IDE 启动时就开好）⇒ 「运行」直接用它 ⇒ 反复运行**不新开** ✓
     */
    list(): Promise<TerminalInfo[]>
    /** 开一个新的终端 */
    create(): Promise<TerminalInfo>
    /** 关掉一个终端（杀它的 shell） */
    close(id: number): Promise<void>
    /** 切换当前终端（「运行」用的是当前那个） */
    select(id: number): void
    /** 订阅「终端列表变了」 */
    onList(cb: (event: TerminalListEvent) => void): () => void
    /** 往 stdin 写一段（逐键触发，不等回执） */
    write(data: string): void
    /**
     * 只写**显示层**，不进 stdin。
     *
     * ⚠️ 「显示」和「输入」是两条道 —— 往 stdin 写的东西会被 shell 当成
     * **命令**执行掉（用户报过「程序的输出被当命令执行了」）⇒
     * IDE 自己要往终端里显示一行字（比如「shell 起不来」）时走这里 ✓。
     */
    display(data: string): void
    /** 杀掉 shell 进程树 */
    kill(): Promise<void>
    /** 换目录（管道没法改 cwd，只能往 shell 里发一条 cd 命令） */
    cd(cwd: string): Promise<void>
    /**
     * 窗口尺寸变了（列 / 行）。
     *
     * ⚠️ 管道版**做不到实时改**（已经在跑的 shell 收不到 SIGWINCH）⇒ 只记下来
     * 给下一个进程用；真控制台后端（ConPTY / node-pty）才会实时 resize。
     *
     * ⚠️ **必须带 `terminalId`** —— 每个终端的 xterm 尺寸**各是各的**
     *    （隐藏着的那个尺寸还是老的）⇒ 不带 id 就只能把**前台终端**的尺寸
     *    套到**所有**终端上 ⇒ 它们的 shell 按错的宽度折行 ⇒ TUI 全花 ✗
     */
    resize(terminalId: number, cols: number, rows: number): void
    /**
     * 现在这个终端后端是**真控制台**（node-pty/ConPTY）还是**管道兜底**？
     *
     * ⚠️ 这**会变** —— node-pty 起不来时会退到管道版 ⇒ 状态栏上那个徽章
     *    就是给用户看的（用户报过「终端一会真一会假的」⇒ 得看得见）。
     */
    backend(): Promise<PtyBackendInfo>
    /** 订阅「后端变了」—— 状态栏的徽章要跟着变（真控制台 ⇄ 管道兜底） */
    onBackendChange(cb: (info: PtyBackendInfo) => void): () => void
    /**
     * 告诉主进程「用户正在看 / 没在看这个终端」。
     *
     * ⚠️ 看不见时主进程**不补提示符** ⇒ 后台跑命令不会攒一堆「空提示符」
     *    （用户报过）⇒ 打开终端时补**一个** ✓。
     */
    /** 订阅 shell 的输出 */
    onData(cb: (event: TerminalDataEvent) => void): () => void
    /**
     * 回执：**这一批输出我已经写进 xterm 了**（背压）。
     *
     * ⚠️ 主进程靠它限速 ⇒ 没有它，终端狂打输出时 IDE 会卡死。
     */
    ack(terminalId: number, seq: number): void
    /**
     * 告诉主进程「我（新的）终端准备好了」。
     *
     * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ 主进程那边的背压状态会卡住
     *    ⇒ 终端再也不出东西 ⇒ 挂上来时重置一下 ✓
     */
    ready(terminalId: number): void
    /** 把终端的当前内容（序列化后的）存到主进程 —— 重载后恢复用。 */
    saveBuffer(terminalId: number, data: string): void
    /** 要之前存的终端内容（重载后恢复用；没有就是 null）。 */
    getBuffer(terminalId: number): Promise<string | null>
    /** 订阅 shell 退出 */
    onExit(cb: (event: TerminalExitEvent) => void): () => void
    /** 订阅「IDE 执行了一条命令」—— 用来把面板切到终端页签 */
    onCommand(cb: (event: TerminalCommandEvent) => void): () => void
    /**
     * 订阅 shell 的状态（当前目录 / 空闲与否 / 上一条命令的退出码）。
     *
     * ⚠️ 这些是 **shell 自己报上来的**（OSC 633），不是 IDE 猜的 ✓。
     */
    onState(cb: (event: TerminalStateEvent) => void): () => void
    /** 订阅「终端被重启了」（复用 ⇒ shell 重启 ⇒ 屏幕要清空）✓ */
    onRestart(cb: (terminalId: number) => void): () => void
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
  /**
   * 当前标签页显示的名字（磁盘文件是文件名，**新建的未命名文件**也是
   * 「未命名-1.jhyy」这种）。
   *
   * ⚠️ 未命名文件**没有路径**（`filePath` 是 null）—— 光看 `filePath`
   * 分不清「用户没打开文件」和「用户打开了一个还没保存的新文件」，
   * 聊天面板就会对后者显示「（没打开文件）」（用户报过：这不对）。
   */
  fileName: string | null
  /**
   * 当前缓冲区**还没落盘**（新建的未命名文件，或者改了没保存）。
   *
   * ⇒ Claude **读不到磁盘上的这份代码** ⇒ 得把内容直接塞进系统提示。
   */
  unsaved: boolean
  /**
   * 当前缓冲区的内容（**只在 `unsaved` 时给**）。
   *
   * 已保存的文件 Claude 自己 `Read` 就行，不必塞进来（白白撑大系统提示）。
   */
  source?: string
  /** 终端 / 程序的工作目录 */
  cwd: string | null
  /** 最近的诊断（问题面板里的那些） */
  diagnostics: { file: string; line: number; col: number; message: string }[]
  /** 输出面板的最后几行 */
  outputTail: string
  /** 用户开了「只读」⇒ Claude 只给建议、不改文件 */
  readOnly?: boolean
}
