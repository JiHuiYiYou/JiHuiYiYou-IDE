import type { TerminalShell } from '@shared/terminal'

/**
 * 终端后端的**接口**。
 *
 * ## 为什么要抽这一层
 *
 * 终端有两个消费者：
 * - **终端面板** —— 起一个 shell（bash / cmd / powershell）
 * - **「运行」按钮** —— 起编译出来的程序（不经 shell）
 *
 * 它们要的能力**完全一样**（起进程 / 写 / 改尺寸 / 收输出 / 杀）⇒ 一套接口。
 *
 * ## 为什么接口不叫「Terminal」
 *
 * 因为底下**可能有两种实现**：
 * - **管道版**（今天）：`child_process.spawn` + 管道。程序拿到的是**管道** ⇒
 *   `isatty(1)` 是 FALSE ⇒ C 运行时**全缓冲** stdout ⇒ 交互式程序的提示
 *   要等程序退出才显示（已由编译器 runtime 的 `setvbuf` 兜住）。
 * - **真控制台版**（ConPTY / node-pty）：程序拿到的是**控制台** ⇒
 *   `isatty(1)` 是 TRUE ⇒ CRT 不缓冲 ⇒ 提示立刻可见、`vim`/`top` 能跑、
 *   窗口尺寸也对。
 *
 * ⇒ **接口不变，实现可换**。上层（终端面板、运行按钮）不该知道底下是哪种。
 */
export interface PtySession {
  /** 进程还活着吗 */
  readonly running: boolean

  /**
   * 底下是**哪个后端**？
   *
   * - `node-pty` ⇒ **真控制台**（ConPTY）：程序拿到控制台设备、TUI 能跑、
   *   尺寸实时对得上、控制台自己回显。
   * - `pipe` ⇒ 管道（兜底）：没有 TTY。
   *
   * ⚠️ **别拿「node-pty 模块能不能 require」当判据** —— 模块能加载不等于
   * 原生模块的 ABI 对得上（那要等真的 spawn 才知道）⇒ 所以这个字段由
   * **实际起起来的后端**报，不是探测出来的 ✓。
   */
  readonly backend: 'node-pty' | 'pipe'

  /**
   * 往这个后端发「一整行命令」时，**行尾用哪个字节**？
   *
   * ⚠️⚠️ **绝对不能发 `\r\n`** —— 那对 shell 来说是**两个回车**
   *    （readline 的两个 accept-line）⇒ **shell 会打两个提示符**，
   *    中间还夹一个空行 ⇒ 终端里就是「一堆空提示符」（用户报过）✓
   *    （实测：管道版和真控制台版都是 `\r\n` ⇒ 2 个提示符，`\n` 或 `\r` ⇒ 1 个 ✓）
   *
   * - **管道**：shell 从管道里按 **`\n`** 切行 ⇒ 用 `\n`
   * - **真控制台**：控制台的行编辑把 **`\r`**（回车键）当提交 ⇒ 用 `\r`
   */
  readonly lineEnding: '\r' | '\n'

  /** 往终端里写（用户的按键） */
  write(data: string): void

  /**
   * 改窗口大小。
   *
   * - 管道版：**做不到**（没有 TIOCSWINSZ）⇒ 只能记下来，
   *   给**下一个**起的进程用（`COLUMNS`/`LINES` 环境变量），
   *   而且已经在跑的 shell 收不到（它的 `stty` 尺寸不变 ⇒ `vim` 会错位）。
   * - 真控制台版：`ResizePseudoConsole` ⇒ 内核发 SIGWINCH ⇒ 程序重排 ✓。
   */
  resize(cols: number, rows: number): void

  /**
   * 这个后端**自己会不会回显**输入？
   *
   * - **管道版**：不会 ⇒ 程序从管道读 stdin，它没有 TTY ⇒ **IDE 得自己回显**
   *   （用户报过「scanf 是坏的，他根本就不会让我读」—— 不回显就看着像坏了）。
   * - **真控制台版**：**会** —— 控制台自己把敲进去的字符画出来（而且画得
   *   更对：光标位置、退格、宽字符都对）⇒ IDE **千万别再回显一遍**
   *   （否则每个字出现两次）。
   */
  readonly echoesInput: boolean

  /** 订阅输出 */
  onData(cb: (data: string) => void): void

  /** 订阅退出（退出码可能是 null —— 被信号杀掉时） */
  onExit(cb: (code: number | null) => void): void

  /** 杀掉进程树 */
  kill(): Promise<void>
}

/** 起一个终端会话要什么。 */
export interface PtySpawnOptions {
  /** 用哪个 shell */
  shell: TerminalShell
  /** 起始目录 */
  cwd: string
  /** 额外注入的环境变量（覆盖继承来的） */
  env?: Record<string, string>
  /** 初始窗口尺寸（列 / 行） */
  cols?: number
  rows?: number
  /** 起了之后要跑什么（默认 = shell 本身；「运行」按钮传编译产物） */
  command?: { exe: string; args: string[] }
  /**
   * **让 shell 跑这一条命令然后退出**（VS Code 的任务终端模型）。
   *
   * ⚠️⚠️ **这是「运行」按钮走的路** ——
   *   VS Code 的任务命令**不是敲进终端的 stdin**，而是 **shell 的启动参数**
   *   （`bash -c "…"` / `powershell -Command "…"`）
   *   ⇒ shell 跑完就退出 ⇒ **判完成靠「终端进程退出」**、
   *     **退出码就是终端的退出码** ⇒ ⇒ **完全不需要 OSC 633** ✓
   *   ⇒ 也**不用等 shell 集成起来** ⇒ 冷终端也是「shell 一起来就跑」✓
   *
   * ⚠️ **跟 `command` 的区别**：`command` 是「跑这个程序，不经 shell」；
   *    这个是「**在 shell 里**跑这条命令」⇒ shell 集成、用户 profile、
   *    环境变量全都在 ✓
   */
  shellCommand?: string
  /**
   * **别让 shell 加载 profile**（PowerShell 专用）。
   *
   * ⚠️ **用户的 profile 可能要 9～11 秒**（这台机器上是 `conda init`）
   *   ⇒ 「运行」/「检查」每次都等它 ⇒ **按钮点了半天才有反应** ✗
   * ⇒ ⇒ profile 的**环境变量**由主进程**导一次、缓存住**（`shellEnv.ts`），
   *   已经**注入到 shell 的 env 里** ⇒ ⇒ profile 不用再加载 ✓
   * ⇒ ⇒ VS Code 的任务终端也是这个路子（`useShellEnvironment = true`
   *   ⇒ 用的是**算好的** shell 环境，不重新跑 profile）✓
   *
   * ⚠️ **只有「profile 的 env 真的导到了」才能设这个** ⇒ 不然用户的 conda 就没了 ✗
   */
  noProfile?: boolean
  /**
   * 用哪个后端。
   *
   * - `auto`（默认）：**有 node-pty 就用**（真控制台），否则退回管道。
   * - `pipe` / `node-pty`：强制。
   *
   * ⚠️ **测试要用 `pipe`** —— 否则「装没装 node-pty / 是不是按 Electron 的
   * ABI 重编过」会决定测试的结果（真控制台自己回显 ⇒ IDE 不回显 ⇒
   * 断言全反）。
   */
  backend?: 'auto' | 'pipe' | 'node-pty'
}

/**
 * 输出**攒批**。
 *
 * ## 为什么
 *
 * 裸写 `pty.onData(d => ipc.send(d))` 在 `cat` 一个大文件时**必崩**：
 * 每一小段输出都是一个 IPC 消息，渲染进程解析不过来 ⇒ 消息在队列里堆积 ⇒
 * 内存被吃光（VS Code 不会，因为它有 PTY 的**背压**：写端会阻塞）。
 *
 * ⇒ 攒一小会儿（默认 16ms ≈ 一帧）再发 ⇒ IPC 消息数降一个量级，
 * 而用户**看不出延迟**（16ms 比一帧还短）。
 *
 * ⚠️ **按「解码后的字符串」攒**，不按字节 ⇒ 不会把一个多字节字符劈成两半
 * （TextDecoder 的 `stream: true` 保证解码结果永远是完整字符 ✓）。
 */
export class OutputBatcher {
  private buf = ''
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flush: (text: string) => void,
    private readonly intervalMs = 16,
  ) {}

  /** 收到一段输出。 */
  push(text: string): void {
    if (!text) return
    this.buf += text
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushNow()
    }, this.intervalMs)
    // ⚠️ 别因为这一个小定时器把整个 Node 事件循环钉住
    this.timer.unref?.()
  }

  /** 立刻把攒着的发出去（进程结束 / 销毁时用）。 */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buf) return
    const text = this.buf
    this.buf = ''
    this.flush(text)
  }

  /** 丢掉攒着的（进程被杀时，别把半截输出发出去）。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buf = ''
  }
}
