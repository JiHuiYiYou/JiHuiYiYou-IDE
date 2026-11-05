/**
 * 终端相关的共享类型。
 *
 * **终端跑在真 PTY 上**（`node-pty` ⇒ Windows 上就是 ConPTY）⇒ 子进程拿到的是
 * **控制台设备**（`GetFileType(stdout) == 2`）⇒
 * - `vim` / `top` 这类全屏 TUI 程序**能跑** ✓
 * - 子进程收得到窗口尺寸（`resize()` ⇒ 内核发 SIGWINCH）✓
 * - C 运行时**不缓冲**控制台的 stdout ⇒ 交互式程序的提示立刻可见 ✓
 * - ANSI 转义序列照常工作（xterm 自己解析）✓
 *
 * ⚠️ **但它可能悄悄退化**：`node-pty` 是可选依赖（原生模块，要按 Electron 的
 * ABI 重编 ⇒ 要 MSVC）⇒ 编不出来 / 起不来时，后端会退回**管道版**
 * （`child_process.spawn`，没有真 TTY）。
 * ⇒ 所以状态栏上有个 **PTY 徽章**，一眼能看出「这台机器现在是真控制台还是管道」✓
 * （用户报过「终端一会真一会假的」⇒ 得**看得见**才说得清）。
 *
 * ⇒ 终端后端是接口（`src/main/pty.ts` 的 `PtySession`），真控制台版
 * （`ptyNode.ts`）和管道版（`ptyPipe.ts`）只是**其中两种实现**。
 */

/** 终端用哪种 shell。 */
export type TerminalShell = 'powershell' | 'cmd' | 'bash'

/** 终端后端现在是哪个。 */
export type PtyBackend = 'node-pty' | 'pipe'

/** 终端后端的状态（给状态栏显示）。 */
export interface PtyBackendInfo {
  /**
   * `node-pty` = **真控制台**（ConPTY）⇒ TUI 能跑、提示立刻可见、尺寸实时对得上。
   * `pipe` = 管道兜底 ⇒ 没有真 TTY。
   */
  backend: PtyBackend
  /**
   * 退到管道版的原因（`backend === 'pipe'` 时有）。
   *
   * 例：「node-pty 模块没装」/「原生模块起不来：...」
   */
  reason?: string
}

export interface TerminalStartRequest {
  shell?: TerminalShell
  /** 起始目录 —— 一般是当前打开的 .jhyy 所在目录 */
  cwd?: string
}

export interface TerminalStartResult {
  ok: boolean
  shell: TerminalShell
  cwd: string
  error?: string
}

/** main → renderer：已经做过 CRLF 归一的输出。 */
export interface TerminalDataEvent {
  data: string
  /**
   * 这一批的**序号**（主进程按顺序编的）。
   *
   * ⚠️ 渲染进程**写完**（xterm 解析完）之后要把序号**回执**给主进程 ⇒
   *    主进程才知道「输出流到哪儿了」⇒ 才能**限速**（背压）。
   *    没有它的话，终端狂打输出时 IPC 队列会无限涨 ⇒ 整个 IDE 卡死
   *    （用户报过：「运行 `while true` 的程序时整个 IDE 卡死」）。
   */
  seq: number
  /**
   * 这是**哪个终端**的输出。
   *
   * ⚠️ **多终端必须有它** —— 渲染进程那边每个终端一个 xterm 实例 ⇒
   *    事件不带 id 就不知道该写进哪个 ✓
   */
  terminalId: number
}

/** main → renderer：shell 进程退出了。 */
export interface TerminalExitEvent {
  code: number | null
  /** 这是哪个终端退出了。 */
  terminalId: number
}

/**
 * 一个终端的**信息**（给渲染进程画终端列表用）。
 *
 * ⚠️ 跟 VS Code 一个模型：**可以有多个终端**，各有各的 shell 和 scrollback；
 *    「运行」用的是**当前那个**，没有就**新开一个** ✓
 */
export interface TerminalInfo {
  /** 终端的 id（主进程编的，稳定不变） */
  id: number
  /** 名字（VS Code 那样显示「bash」/「PowerShell」） */
  name: string
  /** 用的是哪个 shell */
  shell: TerminalShell
  /** 当前目录（shell 自己报的，不是猜的） */
  cwd: string | null
}

/**
 * 终端**列表变了**（开 / 关 / 切）。
 *
 * ⚠️ **带上「当前是哪个」** —— 当前终端由**主进程**说了算 ⇒
 *    渲染进程只管跟着走 ⇒ 不会出现「两边以为当前的不是同一个」✗
 */
export interface TerminalListEvent {
  activeId: number | null
  terminals: TerminalInfo[]
}

/** main → renderer：某个终端的 shell 状态变了。 */
export interface TerminalStateEvent {
  terminalId: number
  state: ShellState
}

/** main → renderer：IDE 执行了一条命令（终端里已经显示出来了）。 */
export interface TerminalCommandEvent {
  /** 给人看的命令行 */
  command: string
  /**
   * 要不要把底部面板切到「终端」页签？
   *
   * - 运行 ⇒ `true` —— 程序的输出就在终端里，切过去跟 VS Code 一样
   * - 检查 ⇒ `false` —— 用户是来看诊断的，别把面板抢走
   */
  focus: boolean
}

/**
 * **shell 的状态** —— shell 自己报上来的（OSC 633，见 `shellIntegration.ts`）。
 *
 * ⚠️ **不是 IDE 猜的** —— 猜的那套（记「用户这一行有没有输入」）不准 ⇒
 *    终端里就出现「多一行空白」「一堆空提示符」这些怪现象。
 */
export interface ShellState {
  /** shell 现在在哪个目录（`null` = 还没知道） */
  cwd: string | null
  /** 上一条命令的退出码（`null` = 没跑过命令，或者还没知道） */
  exitCode: number | null
  /**
   * shell 是不是**停在提示符上**（空闲）。
   *
   * - `true` —— 空闲，可以往它发命令
   * - `false` —— 有命令在跑
   * - `null` —— **还不知道**（shell 刚起来，或者这个 shell 不支持集成）
   */
  idle: boolean | null
  /**
   * **这个终端上正在跑的东西**的状态。
   *
   * ⚠️ **为什么放在这儿**（而不是状态栏）——
   *    VS Code 的**底右状态栏没有任务消息**；任务状态在**终端页签**上
   *    （`tasks/browser/taskTerminalStatus.ts` ⇒ 转圈 / ✓ / ✗）✓
   *    ⇒ 用户明说「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   *
   * - `running` —— 正在跑（页签上转圈）
   * - `ok` —— 跑完了（页签上 ✓）
   * - `failed` —— 跑挂了（页签上 ✗）
   */
  run?: 'running' | 'ok' | 'failed'
}
