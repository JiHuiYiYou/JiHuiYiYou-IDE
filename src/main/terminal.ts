import { basename } from 'node:path'
import type { ShellState, TerminalShell } from '@shared/terminal'
import {
  normalizeCwd,
  ShellIntegrationParser,
  type ShellIntegrationEvent,
} from '@shared/shellIntegration'
import type { PtySession } from './pty'
import { createPtySession } from './ptyFactory'
import { shellCdCommand } from './ptyPipe'

/**
 * 正在等结果的一条命令（IDE 让 shell 跑的程序）。
 */
interface PendingRun {
  /** 命令行里用来认自己的那个片段（exe 的文件名） */
  match: string
  /**
   * **匹配模式** ——
   * - `'strict'`（默认）：shell 报了「这条命令是什么」（OSC 633 的 `E;`）
   *   ⇒ 必须带 `match` 才算我们的 ✓
   * - `'relaxed'`：shell **压根不报** `E;` ⇒ 只能信「第一条完成的就是我们的」
   *   （只在「发命令前已经确认 shell 空闲」的前提下才安全 ✓）
   */
  matchMode: 'strict' | 'relaxed'
  /**
   * **已经看到 shell 报「我们那条命令是什么」**（`E;` 里带上了 `match`）✓
   *
   * ⇒ 两个用处：
   * ① **超时的时候靠它决定能不能 Ctrl+C** ——
   *    只有它为 true 才说明「我们的命令是**前台进程**」⇒ Ctrl+C 打到的是它 ✓
   *    否则 shell 在跑**用户的**命令 ⇒ Ctrl+C 会打断用户 ✗
   * ② **兜底**：用户中途插了一条命令 ⇒ 我们的 `D;` 丢了 ⇒
   *    后面来的那条 `D;` 就认了它 ⇒ **不然永远等不到**（「运行中」永远亮着）✗
   */
  matched: boolean
  resolve: (r: TerminalRunResult) => void
  /** 超时定时器 */
  timer: ReturnType<typeof setTimeout> | null
  /** 超时之后「再等等看」的定时器 */
  graceTimer: ReturnType<typeof setTimeout> | null
  /** 跑的时候终端里流过的文本 */
  output: string
  startedAt: number
}

/**
 * 各 shell 的「换目录」命令（**不带行尾** —— 要跟别的命令拼一行）。
 */
function cdCommandFor(shell: TerminalShell, dir: string): string {
  switch (shell) {
    case 'powershell':
      // ⚠️ PowerShell 的单引号字面量里，单引号要写成两个 ✓
      return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`
    case 'bash':
      // ⚠️ bash 用**正斜杠**（MSYS2 认 `C:/…`）✓
      return `cd "${dir.replace(/\\/g, '/').replace(/"/g, '\\"')}"`
    case 'cmd':
    default:
      return `cd /d "${dir.replace(/"/g, '""')}"`
  }
}

/**
 * 各 shell 的「跑这个 exe」命令。
 *
 * ⚠️ **必须用调用运算符**（PowerShell 的 `&`）——
 *    不然 PowerShell 会把**不带扩展名**的命令名解析成别的东西
 *    （实测 `cmd /c exit 42` 里 `$LASTEXITCODE` 是空的，
 *      而 `& 'C:\…\cmd.exe' /c exit 44` 才拿得到 44 ⇒ 退出码准不准就在这儿）✓
 */
function buildRunCommand(shell: TerminalShell, exe: string): string {
  return buildShellCommand(shell, exe, [])
}

/**
 * 给某个 shell **引号包起来**的字面量。
 *
 * ⚠️ 三种 shell 的引号规则**不一样** ⇒ 混用就崩：
 * - PowerShell：单引号字面量，里面的单引号**写成两个** ✓
 * - bash：单引号字面量，里面的单引号要 `'\''`（关-转义-开）✓
 * - cmd：双引号字面量，里面的双引号**写成两个** ✓
 */
export function shellQuote(shell: TerminalShell, text: string): string {
  switch (shell) {
    case 'powershell':
      return `'${text.replace(/'/g, "''")}'`
    case 'bash':
      return `'${text.replace(/'/g, "'\\''")}'`
    case 'cmd':
    default:
      return `"${text.replace(/"/g, '""')}"`
  }
}

/**
 * 命令链里的一步。
 */
export interface CommandStep {
  /** 这一步跑什么（**不含** cd） */
  command: string
  /** 这一步在哪个目录跑（不给 = 接着上一步的目录） */
  cwd?: string
}

/**
 * 把命令链拼成**一行**（按 shell 的语法）。
 *
 * ⚠️ **上一步失败 ⇒ 下一步不跑**（编译失败就不该跑产物）✓
 *
 * ⚠️⚠️ **PowerShell 5.1 没有 `&&`**（那是 PS 7 才有的）⇒
 *   得用 `if ($LASTEXITCODE -eq 0) { … }` 嵌套 ⇒
 *   （Windows 默认的 `powershell.exe` 就是 5.1 ⇒ 必须这么写）✓
 */
export function buildCommandChain(shell: TerminalShell, steps: CommandStep[]): string {
  if (steps.length === 0) return ''
  const cd = (dir: string): string => {
    switch (shell) {
      case 'powershell':
        return `Set-Location -LiteralPath ${shellQuote(shell, dir)}`
      case 'cmd':
        return `cd /d ${shellQuote(shell, dir)}`
      case 'bash':
      default:
        return `cd ${shellQuote(shell, dir)}`
    }
  }
  const body = (step: CommandStep): string =>
    (step.cwd ? `${cd(step.cwd)}; ` : '') + step.command

  if (shell === 'powershell') {
    // ⇒ 嵌套 if：上一步失败就不跑下一步 ✓
    const build = (i: number): string => {
      if (i >= steps.length) return ''
      const head = body(steps[i])
      const rest = build(i + 1)
      return rest ? `${head}; if ($LASTEXITCODE -eq 0) { ${rest} }` : head
    }
    return build(0)
  }
  // bash / cmd：`&&` 天生就是「上一步失败就不跑下一步」✓
  return steps.map(body).join(' && ')
}

/**
 * **「运行」按钮的那条命令链**（编译 → 跑产物）—— **生产代码的唯一出处**。
 *
 * ⚠️⚠️ **为什么单独拎出来** ——
 *   这条链**以前完全没有测试覆盖** ⇒
 *   「跑产物」那一步用 `shellQuote` 拼（只是**引号包起来的字面量**）⇒
 *   ⚠️ **PowerShell 里 `'C:\…\prog.exe'` 是「一个字符串」，不是命令** ⇒
 *      解析器 `ParserError` ⇒ **程序压根没跑** ⇒ **一点输出都没有** ✗
 *      （用户报过：「点运行按钮根本就没有程序输出了」）
 *   ⚠️ bash 那边侥幸能跑（引号里有 `/` ⇒ bash 当路径执行）⇒
 *      ⇒ **只有 PowerShell 犯这个病** —— 而 **PowerShell 正是默认 shell** ✗
 *   ⇒ 拎出来 ⇒ **测试跟生产代码用同一个函数** ⇒ 不会再漂 ✓
 *
 * @param shell    用哪个 shell
 * @param compiler 编译器（`jhyy.exe`）
 * @param src      源文件
 * @param outBase  产物（**不含** `.exe`）
 * @param workDir  编译的 scratch 目录（编译器的跨阶段临时文件走**相对 CWD** 的路径）
 * @param runDir   跑产物的目录（一般是**源文件所在目录** ⇒ 程序的相对路径才对）
 */
export function buildRunCommandChain(
  shell: TerminalShell,
  opts: {
    compiler: string
    src: string
    outBase: string
    workDir: string
    runDir: string
  },
): string {
  const exePath = `${opts.outBase}.exe`
  const steps: CommandStep[] = [
    {
      command: buildShellCommand(shell, opts.compiler, ['compile', opts.src, '-o', opts.outBase]),
      cwd: opts.workDir,
    },
    // ⚠️⚠️ **必须用 `buildShellCommand`（它带调用运算符 `&`）** ——
    //   `shellQuote` 只是字面量 ⇒ PowerShell 下**压根不执行** ⇒ **一点输出都没有** ✗
    { command: buildShellCommand(shell, exePath, []), cwd: opts.runDir },
  ]
  return buildCommandChain(shell, steps)
}

/**
 * 各 shell 的「跑这个 exe，带这些参数」命令。
 *
 * ⚠️ **参数也要引号** —— 路径里可能有空格（`C:\Users\我的 项目\`）✓
 */
export function buildShellCommand(shell: TerminalShell, exe: string, args: string[]): string {
  switch (shell) {
    case 'powershell':
      return (
        `& '${exe.replace(/'/g, "''")}'` +
        args.map((a) => ` '${a.replace(/'/g, "''")}'`).join('')
      )
    case 'bash':
      // ⚠️ bash 用正斜杠（MSYS2 认 `C:/…`）✓
      return (
        `'${exe.replace(/\\/g, '/').replace(/'/g, "'\\''")}'` +
        args.map((a) => ` '${a.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('')
      )
    case 'cmd':
    default:
      return (
        `"${exe.replace(/"/g, '""')}"` + args.map((a) => ` "${a.replace(/"/g, '""')}"`).join('')
      )
  }
}

/**
 * 「换目录」那一条命令（按 shell 的语法）**+ 用来认自己的那个片段**。
 *
 * ⚠️ **为什么匹配串要单独给** ——
 *   bash 的路径是**正斜杠**（`C:/Users/…`）、PowerShell 的是**反斜杠**（`C:\Users\…`）
 *   ⇒ 用 IDE 手里那个原始路径去匹配，**两边都对不上** ✗
 *   ⇒ 必须用**命令里实际写进去的那个字符串** ✓
 *
 * ⚠️ **跟 `cdCommandFor` 的区别** —— 那个是给「跟别的命令拼一行」用的（带行尾），
 *   这个是**单独一行**的命令（活 shell 那条路要一行一条）✓
 */
export function cdCommandLine(
  shell: TerminalShell,
  dir: string,
): { command: string; match: string } {
  switch (shell) {
    case 'powershell': {
      const p = dir.replace(/'/g, "''")
      return { command: `Set-Location -LiteralPath '${p}'`, match: p }
    }
    case 'bash': {
      const p = dir.replace(/\\/g, '/').replace(/"/g, '\\"')
      return { command: `cd "${p}"`, match: p }
    }
    case 'cmd':
    default: {
      const p = dir.replace(/"/g, '""')
      return { command: `cd /d "${p}"`, match: p }
    }
  }
}

/**
 * 「运行」/「检查」在**活的 shell** 里要跑的一条条命令。
 */
export interface LiveStep {
  /**
   * 这一条命令。
   *
   * ⚠️⚠️ **必须是「一条简单命令」** ——
   *   bash 的 DEBUG trap（它报「这条命令是什么」，OSC 633 的 `E;`）
   *   **一行只报第一条**（实测 `a && b && c` ⇒ 只报 `E;a`）⇒
   *   ⇒ 一行里塞 `&&` / `;` / 管道 ⇒ shell 报的 `E;` 里**没有**我们的 match
   *   ⇒ **永远匹配不上** ⇒ 「运行」永远挂着 ✗
   *   ⇒ **每条命令单独一行、一个简单命令** ✓
   */
  command: string
  /**
   * 用来认「这条命令跑完了」的片段（**命令行里得有它**）✓
   *
   * ⚠️ 实测 bash 的 `$BASH_COMMAND` 和 PowerShell 的 `Get-History`
   *    都**原样保留引号和大小写** ⇒ 直接用命令原文当 match 最准 ✓
   */
  match: string
  /** 超时（毫秒）—— `0` = 不超时 ✓ */
  timeoutMs?: number
  /**
   * **超时的时候要不要 Ctrl+C**（打断正在跑的东西）。
   *
   * ⚠️ **只对「我们自己的进程」用 true** ——
   *   编译那一步是**我们的编译器** ⇒ Ctrl+C 打断它，shell 活着 ✓
   *   cd 那一步**不能**用 ⇒ 挂住的 cd 说明 shell 正忙 ⇒ Ctrl+C 会打断**用户**的命令 ✗
   */
  interruptOnTimeout?: boolean
  /** 这一步是干什么的（编排时要用，**别用下标猜**）✓ */
  role: 'cd' | 'compile' | 'run'
}

/** 「运行」/「检查」的命令序列里，**cd 那一步**的超时（秒级 ⇒ 不该慢）。 */
const CD_STEP_TIMEOUT_MS = 5_000
/** 编译那一步的超时（要链 gcc ⇒ 可能慢，但也别无限等）。 */
const COMPILE_STEP_TIMEOUT_MS = 120_000

/**
 * **「运行」/「检查」在活的 shell 里的命令序列**（生产代码的唯一出处）。
 *
 * ⚠️ **每一步都是单独一行**（见 `LiveStep.command` 的说明）✓
 * ⚠️ **编译那一步必须在 scratch 目录里跑** ——
 *   编译器的跨阶段临时文件走**相对 CWD** 的路径（`compiler/build/obj/…`）
 *   且**编译器不会自己建那个目录** ⇒
 *   ⇒ 不然就在用户的项目里凭空造出垃圾（CLAUDE.md 记过这个坑）✗
 *
 * ⚠️ **cwd 要自己一路记着，不要在步骤之间回读 `state.cwd`** ——
 *   bash 的 `P;Cwd` 跟 `D;` 是**两次写** ⇒ ConPTY 下 `P;Cwd` 可能晚一个 chunk
 *   ⇒ resolve 的时候 `state.cwd` 还是 cd **之前**的值 ⇒ 判断会错 ✗
 */
export function buildLiveSteps(
  shell: TerminalShell,
  opts: {
    kind: 'run' | 'check'
    compiler: string
    src: string
    outBase: string
    workDir: string
    runDir: string
    /** shell 现在在哪个目录（`null` = 还不知道 ⇒ 冷终端） */
    currentCwd: string | null
    /** 「检查」跑完要 cd 回哪儿（`null` = 不用回） */
    returnCwd?: string | null
    noLink?: boolean
    extraArgs?: string[]
  },
): LiveStep[] {
  const steps: LiveStep[] = []
  // ⚠️ **自己维护 cwd**（见上面的说明）✓
  let cwd = opts.currentCwd

  const needCd = (target: string): boolean =>
    !cwd || normalizeCwd(cwd) !== normalizeCwd(target)

  // ① cd 到 scratch 目录（编译器的跨阶段临时文件走相对 CWD 的路径）
  if (needCd(opts.workDir)) {
    const c = cdCommandLine(shell, opts.workDir)
    steps.push({
      command: c.command,
      match: c.match,
      timeoutMs: CD_STEP_TIMEOUT_MS,
      // ⚠️ **不发 Ctrl+C** —— 挂住的 cd 说明 shell 正忙 ⇒ 不能打断用户 ✗
      interruptOnTimeout: false,
      role: 'cd',
    })
    cwd = opts.workDir
  }

  // ② 编译
  //    ⚠️ **必须用 `buildShellCommand`** —— 它按 shell 决定要不要调用运算符 `&`：
  //    - PowerShell **必须**带 `&`（`'C:\x.exe'` 是字符串不是命令 ⇒ 压根不执行）✗
  //    - bash **不能**带 `&`（bash 的 `&` 是**后台算符** ⇒ 编译会跑到后台
  //      ⇒ shell 立刻回提示符 ⇒ 退出码是假的、产物还没生成就去跑 ⇒ 必错）✗✗
  steps.push({
    command: buildShellCommand(shell, opts.compiler, [
      'compile',
      opts.src,
      '-o',
      opts.outBase,
      ...(opts.noLink ? ['--no-link'] : []),
      ...(opts.extraArgs ?? []),
    ]),
    // ⚠️ **匹配用 basename** —— 路径在 bash 里是正斜杠、PowerShell 里是反斜杠
    //    ⇒ 用整条路径匹配两边都对不上 ⇒ 永远等不到 ✗
    match: basename(opts.outBase),
    timeoutMs: COMPILE_STEP_TIMEOUT_MS,
    // ⚠️ **可以 Ctrl+C** —— 那是**我们自己的**编译器 ⇒ 打断它，shell 活着 ✓
    interruptOnTimeout: true,
    role: 'compile',
  })

  if (opts.kind === 'run') {
    // ③ cd 回源文件目录（程序的相对路径要对）
    if (needCd(opts.runDir)) {
      const c = cdCommandLine(shell, opts.runDir)
      steps.push({
        command: c.command,
        match: c.match,
        timeoutMs: CD_STEP_TIMEOUT_MS,
        interruptOnTimeout: false,
        role: 'cd',
      })
      cwd = opts.runDir
    }
    // ④ 跑产物
    steps.push({
      command: buildShellCommand(shell, `${opts.outBase}.exe`, []),
      // ⚠️ **匹配要带 `.exe`** —— 不带的话编译步的 match（`ide-run-1-0`）
      //    是程序命令（`ide-run-1-0.exe`）的**子串** ⇒ 用户插命令时会张冠李戴 ✗
      match: `${basename(opts.outBase)}.exe`,
      // ⚠️⚠️ **程序默认不设超时**（CLAUDE.md 铁律：用户报过「长时间不理它会程序中断」
      //    —— 那不是程序自己断的，是 IDE 超时把它杀了）✓
      timeoutMs: 0,
      // ⚠️ **不发 Ctrl+C** —— 没超时就没有「要不要打断」这回事 ✓
      interruptOnTimeout: false,
      role: 'run',
    })
  } else {
    // ⚠️⚠️ **「检查」要 cd 回去** ——
    //   不然 shell 就**永远停在 `%TEMP%\jhyy-ide-work`** 了
    //   （渲染进程的 cd effect 只在「文件目录变了」时才发 cd）✗
    const back = opts.returnCwd
    if (back && needCd(back)) {
      const c = cdCommandLine(shell, back)
      steps.push({
        command: c.command,
        match: c.match,
        timeoutMs: CD_STEP_TIMEOUT_MS,
        interruptOnTimeout: false,
        role: 'cd',
      })
    }
  }
  return steps
}

/**
 * 终端会话 —— **IDE 那一层**（输入路由 / 回显 / 提示符 / 换目录）。
 *
 * ⚠️ **底下那个「后端」是可替换的**（`src/main/pty.ts` 的 `PtySession`）：
 * - **管道版**（`ptyPipe.ts`）：`child_process.spawn` + 管道 stdio。
 *   没有真 TTY ⇒ `vim`/`top` 跑不了、stdout 全缓冲（提示要等程序退出）。
 * - **真控制台版**（`ptyNode.ts`，node-pty / ConPTY）：程序拿到控制台 ⇒
 *   `isatty(1)` 为 TRUE ⇒ 提示立刻可见、TUI 能跑、尺寸实时对得上 ✓。
 *
 * ⇒ 这一层只管**IDE 的语义**（输入该去哪儿、回显、提示符、cd），
 *   不碰进程 ⇒ 换后端时这一行都不用改 ✓。
 *
 * 管道带来的两个必做对的细节（在 `ptyPipe.ts` 里）：
 * 1. **CRLF 归一** —— Windows 控制台默认 ONLCR（把 LF 转成 CRLF），但管道没有终端，
 *    没人替我们做。实测 PowerShell 的**回显里是裸 `\n`** —— VT 终端里裸 LF 只下移一行
 *    不回列 0，「ello」会落在下一行第 14 列，看起来是花的。
 * 2. **按 shell 选编码** —— 中文 Windows 上 cmd 的输出是 **OEM 代码页（GBK）**，
 *    按 UTF-8 解会满屏乱码。
 */

/**
 * 终端会话往外报的事件 —— **还不带「是哪个终端」**。
 *
 * ⚠️ **id 由登记表加**（`terminalRegistry.ts`）—— 会话自己不知道
 *    它是第几个终端 ✓（一个会话只归一个终端管 ✓）
 */
export interface TerminalSessionDataEvent {
  data: string
  seq: number
}

/** 终端会话退出。 */
export interface TerminalSessionExitEvent {
  code: number | null
}

/**
 * **让 shell 跑一条命令的结果**。
 *
 * ⚠️ 退出码是**程序自己的**退出码（不是 shell 的）——
 *    shell 集成报的就是它（PowerShell 那边取 `$LASTEXITCODE`）✓
 */
export interface TerminalRunResult {
  /** 退出码（null = 拿不到） */
  exitCode: number | null
  /** 是**超时**被中断的（不是程序自己退的） */
  timedOut: boolean
  /**
   * **终端（shell）在跑的过程中死了** ⇒ 结果是「没收尾」的。
   *
   * ⚠️ **为什么要有它** —— 命令跑完是靠 shell 集成的 OSC 633
   *    「命令执行完」那个事件收尾的 ⇒ shell 一死，那个事件**永远不来**
   *    ⇒ 「运行」就**永远不结束**（状态栏卡在「运行中…」）✗
   *    ⇒ 所以「会话结束」也得能收场 ✓
   */
  terminalClosed?: boolean
  /** 跑了多久（毫秒） */
  durationMs: number
  /**
   * 跑的时候终端里流过的文本。
   *
   * ⚠️ **还带 ANSI 颜色**（xterm 要的就是原样）⇒ 要纯文本的自己剥
   *    （`stripAnsi`）。
   */
  output: string
}

export interface TerminalSessionOptions {
  /**
   * 这个终端的 id（登记表编的）—— 渲染进程那边靠它认「这是哪个终端」✓
   */
  id?: number
  shell: TerminalShell
  cwd: string
  /** 主进程 → 渲染进程的推送 */
  onData: (event: TerminalSessionDataEvent) => void
  /** 主进程 → 渲染进程的推送 */
  onExit: (event: TerminalSessionExitEvent) => void
  /**
   * shell 的状态变了（当前目录 / 空闲与否 / 退出码）—— 主进程 → 渲染进程。
   *
   * ⚠️ 这些是 **shell 自己报上来的**（OSC 633）⇒ 不是 IDE 猜的 ✓。
   */
  onState?: (state: ShellState) => void
  /**
   * 用哪个后端（`auto` = 有 node-pty 就用真控制台）。
   *
   * ⚠️ **测试要传 `pipe`** —— 否则测试结果取决于「装没装 node-pty」+
   * 「是不是按 Electron 的 ABI 重编过」（真控制台自己回显 ⇒ IDE 不回显）。
   */
  backend?: 'auto' | 'pipe' | 'node-pty'
  /**
   * **让 shell 跑这一条命令然后退出**（VS Code 的任务终端模型）。
   *
   * ⚠️⚠️ **「运行」按钮走的就是这条** ——
   *   命令**不是敲进终端的 stdin**，而是 **shell 的启动参数**
   *   ⇒ shell 跑完就退出 ⇒
   *   ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
   *   ⇒ ⇒ **完全不需要 OSC 633** ⇒ 集成挂了也能跑 ✓
   */
  shellCommand?: string
  /**
   * **终端在列表里显示的名字**（不给 = 用 shell 的名字）✓
   *
   * ⚠️ **一次性终端用它**（「运行」/「检查」）⇒
   *    用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
   */
  label?: string
  /**
   * **终端一开就写进显示层的那段文字**（VS Code 的 `initialText`）。
   *
   * ⚠️ **为什么要有它** —— 命令是 shell 的**启动参数**，shell **不会回显**它
   *   ⇒ 用户就看不到「跑的是哪条命令」⇒
   *   ⇒ VS Code 自己写一行 `Executing task: …` ⇒ 我们也自己写 ✓
   */
  initialText?: string
}

export class TerminalSession implements PtySession {
  /** 这个终端的 id（登记表编的） */
  readonly id: number
  /**
   * **终端在列表里显示的名字**（`null` = 用 shell 的名字）✓
   *
   * ⚠️ **一次性终端用它**（「运行」/「检查」）⇒
   *    用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
   */
  label: string | null = null
  /** 底下那个后端（管道 / 真控制台）—— 「重启」时要换 ⇒ 不是 readonly */
  private pty: PtySession
  /**
   * **shell 集成的解析器** —— 从输出流里抠出 OSC 633 序列。
   *
   * ⚠️ 序列本身要**抠掉**再发给渲染进程 —— 不然它会漏到「输出」面板的
   *    纯文本里（那里要的是干净文本）✓。
   */
  private parser = new ShellIntegrationParser()
  /** shell 报上来的状态（不是 IDE 猜的） */
  private state: ShellState = { cwd: null, exitCode: null, idle: null }
  /**
  /**
   * **这个会话结束了**（shell 退了）—— 等结果的人得知道。
   *
   * ⚠️ **为什么要有它** —— 「命令跑完」是靠 OSC 633 报的 ⇒ shell 一死就永远不来
   *    ⇒ 「运行」会**永远不结束**（用户报过：「点运行一直卡在运行中…」）✗
   */
  private sessionEndedPromise!: Promise<void>
  /** resolve 上面那个 promise 的函数（只调一次）。 */
  private markSessionEnded!: () => void
  /**
   * **这个会话退出了**（带退出码）—— VS Code 的任务终端就靠它判「跑完了」✓
   */
  private exitedPromise!: Promise<number | null>
  /** resolve 上面那个 promise 的函数（只调一次）。 */
  private resolveExited!: (code: number | null) => void
  /**
   * **要不要把输出攒起来**（一次性终端要靠它拿编译器的输出）✓
   *
   * ⚠️ 「运行」的终端是**一次性**的 ⇒ 命令是 shell 的**启动参数**
   *    ⇒ 没有 `runCommand` ⇒ 输出没人攒 ⇒ 得自己攒 ✓
   */
  captureOutput = false
  /** 攒下来的输出（纯文本，OSC 序列已抠掉） */
  private captured = ''
  /** 攒下来的输出。 */
  get capturedOutput(): string {
    return this.captured
  }
  /**
   * 最近一次跑完的命令**是什么**（shell 报上来的，OSC 633 的 `E`）。
   *
   * ⚠️ **用来认出「哪条命令跑完了」** ——
   *    IDE 让 shell 跑程序时，用户自己可能还有命令在跑 ⇒
   *    它的「命令执行完」会**先**到 ⇒ 不认一下就会把**用户的**退出码
   *    当成 IDE 的 ⇒ 张冠李戴 ✗
   */
  private lastCommandLine: string | null = null
  /** shell 到底报不报命令行？（不报 ⇒ 只能信「第一条完成的就是我们的」） */
  private reportsCommandLine = false
  /**
   * 正在等结果的一条命令（IDE 让 shell 跑的程序）。
   *
   * ⇒ 同一时刻只允许一条 ⇒ 新的来了就把旧的收场 ✓
   */
  private pendingRun: PendingRun | null = null
  /** 正在跑的程序 stdin 的写入器（跑程序时，终端的输入喂给它） */
  private programInput: ((text: string) => void) | null = null
  /**
   * 程序那侧**要不要 IDE 自己回显**。
   *
   * ⚠️ 真控制台（node-pty）**自己会回显** ⇒ IDE 再回显一遍的话，
   * 每个字会出现**两次** ⇒ 由跑程序的那一侧告诉我 ✓。
   */
  private programEcho = true
  /** 回显用的当前行内容（喂给程序的输入在屏幕上回显出来） */
  private programEchoLine = ''
  /**
   * 用户当前这一行**有没有输入**。
   *
   * ⚠️ 用来防一件坏事：IDE 要往 shell 的 stdin 写一条命令时，
   * 如果这时候用户正敲着半截命令，那条命令会**接在他的半截命令后面**
   * （`ls& 'C:\…'`）⇒ shell 报一个莫名其妙的错 ⇒ 命令根本没跑 ✗
   * 所以有输入的时候就不发。
   */
  private pendingInput = false
  /**
   * **shell 到底报不报「命令开始」（OSC 633 的 `C`）？**
   *
   * ⚠️ **bash 报、PowerShell 不报** —— PowerShell 的集成脚本**故意**不报
   *    （CLAUDE.md：劫持 `PSConsoleHostReadLine` 会把终端搞废）⇒
   *    ⇒ 所以「shell 空闲吗」对 PowerShell 来说**不能只看 `state.idle`** ✓
   */
  private reportsCommandStart = false
  /**
   * **用户提交了一行命令**（敲了回车）⇒ shell 可能在跑它 ⇒ 终端「忙」。
   *
   * ⚠️ **PowerShell 只能靠这个**（它不报 `C` ⇒ `state.idle` 永远是 true）✓
   */
  private userCommandRunning = false
  /**
   * 用户提交那一行之后，**又收到过一条「命令执行完」**（`D;`）。
   *
   * ⚠️ **只有「见过 `D;`」才允许清 `userCommandRunning`** ——
   *   ① `A`（提示符开始，pty 输出）和用户的回车（`IPC.terminalWrite`）
   *      走**两条不同的通道**进主进程 ⇒ 用户看见提示符才可能敲回车，
   *      但主进程可能**先收到回车、后收到那个 `A`** ⇒ 提前清 ⇒ 以为空闲 ✗
   *   ② bash 的 **PS2 续行提示符不发 `A`** ⇒ 续行中途被当成空闲 ✗
   *   ③ PowerShell 的续行**会**发 `A` ⇒ 续行中途被当成空闲 ✗
   *      （但续行时 `Get-History` 没变 ⇒ 脚本不发 `E;`/`D;` ⇒ 不会被清 ✓）
   */
  private userCommandDone = false
  /**
   * **提示符画了几次**（每收到一个 `A` 就 +1）。
   *
   * ⚠️ **用来判断「是不是*新*的提示符」** —— 比 `state.idle` 可靠
   *    （PowerShell 的 `idle` 永远是 true ⇒ 不能用它判断「新的」）✓
   */
  private promptSeq = 0
  /** 等「下一个提示符」的等待者（`waitForPrompt`）。 */
  private promptWaiters: (() => void)[] = []
  /**
   * **这个 pty 是「用户自己的」** ⇒ **别杀它**。
   *
   * ⚠️ 输出太多的时候（16 MB）以前是**直接杀 pty** ——
   *    在一次性终端里没关系（那是扔掉的）⇒
   *    但在**交互终端**里，pty 就是**用户的 shell** ⇒
   *    杀它 = **毁掉用户的会话**（历史、conda、当前目录全丢）✗✗
   * ⇒ 交互终端 ⇒ 改成**打断正在跑的程序**（Ctrl+C）⇒ shell 活着 ✓
   */
  private protectedShell = false
  /**
   * **背压**（flow control）—— 主进程最多往前推多少字节。
   *
   * ⚠️ **为什么要有**：终端狂打输出时（比如 `while true`），
   *    主进程会一直往渲染进程推 ⇒ **IPC 队列无限涨** ⇒ 内存被吃光 ⇒
   *    机器开始换页 ⇒ **整个 IDE 卡死**（用户报过）✓
   * ⇒ 渲染进程**写完**（xterm 解析完）之后回执一个序号 ⇒
   *    主进程才知道「流到哪儿了」⇒ 只推一小段，等回执再推 ✓
   *    （VS Code 那边叫 `AckDataBufferer`，一个意思）。
   */
  private static readonly MAX_INFLIGHT_BYTES = 512 * 1024
  /**
   * **每块多大** —— 一批输出切成 64 KB 一块。
   *
   * ⚠️ **必须切** —— 一次 pipe 的 'data' 事件能给出好几 MB（实测 7.9 MB）
   *    ⇒ 不切的话「在途上限」形同虚设（一批就超了）⇒ 背压等于没有 ✓
   */
  private static readonly CHUNK_BYTES = 64 * 1024
  /**
   * **排队等着发**的数据（还没轮到它）。
   *
   * ⚠️ 队列**必须有上限** —— 不然内存还是在涨（只是涨在主进程里）⇒
   *    超过上限就把那个 pty 掐掉（跟「运行」按钮那条路的 `MAX_CAPTURE`
   *    一个做法：输出太多就停）✓
   */
  private static readonly MAX_QUEUE_BYTES = 16 * 1024 * 1024
  /** 还没回执的批次（序号 → 字节数）。 */
  private readonly inflight = new Map<number, number>()
  /** 还没发出去的批次（等着 in-flight 降下来）。 */
  private readonly queue: { seq: number; data: string }[] = []
  /** 已经发给渲染进程、但还没回执的字节数。 */
  private inflightBytes = 0
  /** 排队中的字节数。 */
  private queuedBytes = 0
  /** 每批的序号（主进程编的，渲染进程回执用它）。 */
  private seq = 0
  /** 当前工作目录（管道没法改 cwd ⇒ 靠往 shell 里发 cd 命令） */
  private cwd: string
  private shell: TerminalShell

  constructor(private readonly opts: TerminalSessionOptions) {
    this.id = opts.id ?? 0
    this.shell = opts.shell
    this.cwd = opts.cwd
    this.label = opts.label ?? null
    this.resetPromises()
    this.pty = this.spawnPty(opts.shellCommand)
    /*
      ⚠️ **一次性终端（`shellCommand`）⇒ 输出一定要攒** ——
        命令是 shell 的启动参数 ⇒ 没有 `runCommand` ⇒ 没人攒 ⇒ 得自己攒 ✓
        ⇒ 在**构造时就打开**（不是事后置位）⇒ 免得漏掉刚起来的那几行 ✓
    */
    if (opts.shellCommand) this.captureOutput = true
    /*
      ⚠️⚠️ **交互终端（没有 `shellCommand`）⇒ 这个 pty 是「用户自己的」** ——
        ⇒ 输出太多的时候**不许杀它**（那是用户的 shell ⇒ 杀了会话就没了）✗
        ⇒ 改成打断正在跑的程序 ✓（见 `overflow()`）
    */
    else this.protectedShell = true
    /*
      ⚠️ **「初始文字」要在 shell 的输出之前写进显示层** ——
        命令是 shell 的**启动参数** ⇒ shell **不会回显**它
        ⇒ 用户看不到「跑的是哪条命令」⇒
        ⇒ VS Code 自己写一行（`initialText`）⇒ 我们也自己写 ✓
        ⇒ 排队 ⇒ 一定排在 shell 的输出**前面** ✓
    */
    if (opts.initialText) this.enqueue(opts.initialText)
    this.wirePty()
  }

  /**
   * **重建那些「只 resolve 一次」的 promise**。
   *
   * ⚠️ **为什么需要** —— 「重启」这个会话（`restart()`）⇒
   *   新的一轮又得重新等「退出」「集成 ready」⇒ ⇒ 旧的 promise 已经用掉了 ⇒
   *   ⇒ 得换新的 ✓
   */
  private resetPromises(): void {
    // ⚠️ **两个 promise 都要在起后端之前建好** ——
    //    「会话结束」「退出码」都是**只 resolve 一次**的事件
    this.sessionEndedPromise = new Promise<void>((resolve) => {
      this.markSessionEnded = resolve
    })
    this.exitedPromise = new Promise<number | null>((resolve) => {
      this.resolveExited = resolve
    })
  }

  /**
   * **重启这个会话，换一条命令**（VS Code 的 `reuseTerminal`）。
   *
   * ⚠️⚠️ **为什么需要它** —— 任务终端跑完那条命令就**退出**了 ⇒
   *   下一次跑要用它 ⇒ 就得**把 shell 重启一遍**
   *   （命令还是**启动参数** ⇒ 一条流、一个提示符 ✓）
   *   ⇒ VS Code：`terminalInstance.ts:1902` 的 `reuseTerminal` ✓
   *
   * ⚠️ **旧的那个 pty 必须已经退出了** —— 否则会有两个进程抢同一个终端 ✓
   */
  restart(shellCommand: string, initialText?: string): void {
    this.resetPromises()
    // ⚠️ **解析器也要重置** —— 上一轮可能留了半个 OSC 序列在里面 ✓
    this.parser = new ShellIntegrationParser()
    // ⚠️ **上一轮的输出不要了**（VS Code 复用终端时会清屏 ⇒ `clearBuffer()`）✓
    this.captured = ''
    this.state = { cwd: null, exitCode: null, idle: null }
    this.pendingRun = null
    this.programInput = null
    this.lastCommandLine = null
    this.reportsCommandLine = false
    // ⚠️ **状态也得重置** —— 新的一轮 ⇒ 又是「没提交过命令、shell 刚起来」✓
    this.reportsCommandStart = false
    this.userCommandRunning = false
    this.userCommandDone = false
    this.promptSeq = 0
    this.promptWaiters = []
    this.pty = this.spawnPty(shellCommand)
    if (initialText) this.enqueue(initialText)
    this.wirePty()
  }

  /** 建一个后端会话（shell 或「让 shell 跑这条命令然后退出」）。 */
  private spawnPty(shellCommand?: string): PtySession {
    return createPtySession({
      shell: this.shell,
      cwd: this.cwd,
      cols: 120,
      rows: 30,
      ...(this.opts.backend ? { backend: this.opts.backend } : {}),
      ...(shellCommand ? { shellCommand } : {}),
    })
  }

  /** 把后端的输出/退出接到这个会话上。 */
  private wirePty(): void {
    // 后端输出 ⇒ 先过一遍 shell 集成解析器（抠出 OSC 633）⇒ 再进显示层
    this.pty.onData((text) => {
      const r = this.parser.push(text)
      // ⚠️⚠️ **先攒输出，再处理事件** ——
      //    「命令执行完」的事件跟输出**可能在同一块里**
      //    （管道后端 16ms 攒一批 ⇒ stdout/stderr 会被合到一起）⇒
      //    先 resolve 的话，**这一块的输出就丢了** ✗
      if (r.text && this.pendingRun) this.pendingRun.output += r.text
      // ⚠️ **一次性终端**：命令是 shell 的启动参数 ⇒ 没有 `runCommand` ⇒
      //    ⇒ 输出得**自己攒**（「运行」要靠它解析诊断、拿程序的输出）✓
      if (r.text && this.captureOutput) this.captured += r.text
      if (r.events.length) this.applyShellEvents(r.events)
      // ⚠️ **只发抠干净之后的文本** —— OSC 序列不该漏到输出面板 ✓
      if (r.text) this.enqueue(r.text)
    })
    this.pty.onExit((code) => {
      // ⚠️ **会话结束了** ⇒ 等结果的人得知道（不然「运行」会永远等）✓
      this.markSessionEnded()
      this.resolveExited(code)
      this.opts.onExit({ code })
    })
  }

  /**
   * **这个会话退出了**（带退出码）—— 等结果的人靠它收场。
   *
   * ⚠️⚠️ **VS Code 的任务终端就是这样判「跑完了」的** ——
   *   `tasks/browser/terminalTaskSystem.ts:971` ⇒ `terminal.onExit(...)`
   *   ⇒ **命令是 shell 的启动参数** ⇒ shell 跑完就退出 ⇒
   *   ⇒ **判完成靠「终端进程退出」、退出码就是终端的退出码**
   *   ⇒ ⇒ **完全不需要 OSC 633** ⇒ 集成挂了也能跑 ✓
   */
  get exited(): Promise<number | null> {
    return this.exitedPromise
  }

  /**
   * 把一批输出**排队**（背压）。
   *
   * ⚠️ **不是直接发** —— 直接发的话，终端狂打输出时 IPC 队列会无限涨 ⇒
   *    内存被吃光 ⇒ 整个 IDE 卡死（用户报过）✓
   * ⇒ 排队 ⇒ 只在「in-flight 字节数」低于上限时才往前推 ✓
   */
  private enqueue(data: string): void {
    /*
      ⚠️⚠️ **必须切成小块** ——

      一次 pipe 的 'data' 事件就可能给**好几 MB**（实测：一次给了 7.9 MB）
      ⇒ 不切的话「在途上限」形同虚设（**一批就超了**）⇒ 背压等于没有 ⇒
      ⇒ 切成 64 KB 一块 ⇒ 在途统计才有意义 ✓
    */
    const size = TerminalSession.CHUNK_BYTES
    for (let i = 0; i < data.length; i += size) {
      this.enqueueChunk(data.slice(i, i + size))
    }
  }

  /** 排队一小块。 */
  private enqueueChunk(data: string): void {
    const bytes = data.length
    this.queuedBytes += bytes
    this.queue.push({ seq: ++this.seq, data })
    // ⚠️ **队列有上限** —— 超过就说明渲染进程根本追不上（或者它没了）
    //    ⇒ 把那个 pty 掐掉（不然内存一直涨 ⇒ 机器换页 ⇒ 整机卡）
    if (this.queuedBytes > TerminalSession.MAX_QUEUE_BYTES) {
      this.overflow()
      return
    }
    this.pump()
  }

  /** 往前推（只要 in-flight 没超限就一直推）。 */
  private pump(): void {
    while (this.queue.length > 0 && this.inflightBytes < TerminalSession.MAX_INFLIGHT_BYTES) {
      const item = this.queue.shift() as { seq: number; data: string }
      this.queuedBytes -= item.data.length
      this.inflight.set(item.seq, item.data.length)
      this.inflightBytes += item.data.length
      this.opts.onData({ data: item.data, seq: item.seq })
    }
  }

  /**
   * 渲染进程回执：**写到第 seq 批的都写完了**。
   *
   * ⚠️ 序号是**连续**的 ⇒ 回执 seq 就等于「≤ seq 的都好了」✓
   */
  ack(seq: number): void {
    for (const [s, bytes] of this.inflight) {
      if (s > seq) continue
      this.inflight.delete(s)
      this.inflightBytes -= bytes
    }
    if (this.inflightBytes < 0) this.inflightBytes = 0
    this.pump()
  }

  /**
   * **存下来的终端内容**（序列化后的字符串）。
   *
   * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ xterm 实例重建 ⇒ scrollback 全丢 ⇒
   *    VS Code 是靠「pty 宿主进程还在 + 序列化回放」保住的 ⇒
   *    我们把内容序列化后存在**主进程**这边 ⇒ 渲染进程来要的时候给它 ✓
   */
  private savedBuffer: string | null = null

  /** 渲染进程把终端内容存过来。 */
  saveBuffer(data: string): void {
    this.savedBuffer = data
  }

  /** 渲染进程来要之前存的内容（重载后恢复用）。 */
  getBuffer(): string | null {
    return this.savedBuffer
  }

  /**
   * **重置背压状态** —— 渲染进程挂上来了（新的终端实例）。
   *
   * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ 它没回执过任何东西 ⇒
   *    主进程这边的「在途字节」会一直卡着 ⇒ **终端再也不出东西** ⇒
   *    ⇒ 把在途清空，队列里的接着发 ✓
   */
  resetFlowControl(): void {
    this.inflight.clear()
    this.inflightBytes = 0
    this.pump()
  }

  /**
   * 输出太多 ⇒ 把 pty 掐掉。
   *
   * ⚠️ **跟「运行」按钮那条路一个做法**（`MAX_CAPTURE` 超了就杀进程）——
   *    不掐的话内存一直涨 ⇒ 机器换页 ⇒ **整机卡住**（比丢一个终端严重得多）✓
   */
  private overflow(): void {
    this.queue.length = 0
    this.queuedBytes = 0
    /*
      ⚠️⚠️ **交互终端 ⇒ 不许杀 pty** ——
        pty 就是**用户的 shell** ⇒ 杀了 ⇒ 用户的会话（历史、conda、当前目录）全丢 ✗✗
        ⇒ 改成**打断正在跑的东西**（Ctrl+C）⇒ shell 活着 ✓
    */
    if (this.protectedShell) {
      this.opts.onData({
        data: '\r\n\x1b[31m[输出太多（超过 16 MB），已打断正在运行的程序]\x1b[0m\r\n',
        seq: ++this.seq,
      })
      this.interrupt()
      return
    }
    this.opts.onData({
      data: '\r\n\x1b[31m[输出太多（超过 16 MB），终端已关闭]\x1b[0m\r\n',
      seq: ++this.seq,
    })
    void this.pty.kill()
  }

  /**
   * 处理 shell 报上来的事件 —— 更新状态、通知渲染进程。
   *
   * ⚠️ **这些是「事实」，不是「猜测」** —— 老办法（记「用户这一行有没有输入」）
   *    是猜的 ⇒ 猜不准 ⇒ 终端里就出现「多一行空白」「一堆空提示符」。
   */
  private applyShellEvents(events: ShellIntegrationEvent[]): void {
    let changed = false
    for (const ev of events) {
      switch (ev.type) {
        case 'promptStart':
          // 提示符画出来了 ⇒ shell 空闲了
          if (this.state.idle !== true) {
            this.state.idle = true
            changed = true
          }
          // ⚠️ **提示符画了几次**（用来判断「是不是*新*的提示符」）✓
          this.promptSeq += 1
          this.notifyPromptWaiters()
          /*
            ⚠️⚠️ **只有「见过 `D;`」才清「用户提交了一行」** ——
              ① 过期的 `A`（用户回车之后才到主进程）会把标志误清 ✗
              ② bash 的 PS2 续行提示符**不发** `A` ⇒ 续行中途会被当成空闲 ✗
              ③ PowerShell 的续行**会**发 `A` ⇒ 同上 ✗
                 （但续行时 `Get-History` 没变 ⇒ 脚本不发 `E;`/`D;` ⇒ 不会被清 ✓）
          */
          if (this.userCommandDone) {
            this.userCommandRunning = false
            this.userCommandDone = false
          }
          break
        case 'commandStart':
          // 命令开始跑了 ⇒ 不空闲
          this.reportsCommandStart = true
          if (this.state.idle !== false) {
            this.state.idle = false
            changed = true
          }
          break
        case 'commandFinished':
          // 命令跑完了（退出码也拿到了）
          if (this.state.exitCode !== ev.exitCode) {
            this.state.exitCode = ev.exitCode
            changed = true
          }
          /*
            ⚠️ **有命令跑完了** ⇒ 若我们等着的是**用户**的那条，它跑完了 ✓
            ⇒ 这时候才可以清「用户提交了一行」（见 `promptStart` 那条）✓
          */
          if (ev.exitCode !== null) this.userCommandDone = true
          // ⚠️ **看看是不是「我们等的那条命令」跑完了** ——
          //    不是的话（用户自己敲的命令先跑完了）⇒ 继续等 ✓
          this.maybeFinishRun(ev.exitCode)
          break
        case 'commandLine': {
          // 这条命令**是什么** ⇒ 用来认出「哪条命令跑完了」✓
          this.lastCommandLine = ev.commandLine
          this.reportsCommandLine = true
          /*
            ⚠️⚠️ **认一下：这是不是我们在等的那条命令？** ——
              ⇒ `matched = true` ⇒
                 ① 我们的命令**确实跑起来了** ⇒ 超时时才敢 Ctrl+C（打到的就是它）✓
                 ② 兜底：用户中途插了命令 ⇒ 我们的 `D;` 丢了 ⇒
                    后面来的那条 `D;` 就认了它 ⇒ **不然永远等不到** ✗
          */
          const run = this.pendingRun
          if (run && run.match && ev.commandLine.includes(run.match)) run.matched = true
          break
        }
        case 'property':
          if (ev.key === 'Cwd' && this.state.cwd !== ev.value) {
            this.state.cwd = ev.value
            changed = true
          }
          break
        default:
          break
      }
    }
    if (changed) this.opts.onState?.({ ...this.state })
  }

  /** shell 报上来的状态（给外部用）。 */
  get shellState(): ShellState {
    return { ...this.state }
  }

  /**
   * **这个终端现在「忙不忙」？** —— 能不能往它敲命令。
   *
   * ⚠️⚠️ **判定要两个信号都看** ——
   * - `userCommandRunning`：用户敲了回车，shell 还在跑它（**PowerShell 只能靠这个**）✓
   * - `reportsCommandStart && state.idle === false`：shell 报了「命令开始」（`C`）
   *   ⇒ **bash 靠这个** ✓
   *
   * ⚠️ **为什么不能只看 `state.idle`** ——
   *   PowerShell 的集成脚本**故意不报 `C`**（CLAUDE.md：劫持 `PSConsoleHostReadLine`
   *   会把终端搞废）⇒ ⇒ 它的 `idle` 永远是 true ⇒ ⇒ 单看它 = **永远以为空闲** ✗
   *   （用户在 vim 里 / 在跑长命令 ⇒ 我们就把命令敲进去了 ⇒ 成了 vim 的按键 ⇒ 危险 ✗）
   */
  get shellBusy(): boolean {
    if (this.userCommandRunning) return true
    if (this.reportsCommandStart && this.state.idle === false) return true
    return false
  }

  /**
   * **用户当前这一行有没有输入**（敲了半截命令）。
   *
   * ⚠️ **这不是「忙」** —— 它在回车时就被清掉了 ⇒
   *    它的用途是「**敲命令之前得先把它清掉**」（不然命令会接在他的半截后面）✓
   */
  get hasPendingInput(): boolean {
    return this.pendingInput
  }

  /**
   * **能不能把用户敲了一半的那行清掉？**
   *
   * ⚠️ **只有真控制台（ConPTY）才行** ——
   *   控制台收到 `0x03` 会产生 CTRL_C_EVENT ⇒ 那一行被丢掉 ✓
   *   （管道版没有控制台 ⇒ `0x03` 只是个普通字节 ⇒ **清不掉** ✗
   *   ⇒ bash 从管道读行时**不做行编辑** ⇒ 半截命令会跟我们的命令**拼成一行** ✗✗）
   */
  get canClearInputLine(): boolean {
    return this.pty.echoesInput
  }

  /**
   * **shell 集成起来了吗？**
   *
   * ⚠️ **判据是「收到过任何 OSC 633」** —— 收到过 ⇒ 集成脚本加载成功了 ✓
   *   （`state.idle !== null` ⇒ 见过提示符；`reportsCommandLine` ⇒ 见过 `E;`）⇒
   *   ⇒ **没起来 ⇒ 等不到「命令执行完」⇒ 整个运行会挂住** ✗ ⇒ 必须能判断 ✓
   */
  get shellIntegrationReady(): boolean {
    return this.reportsCommandLine || this.state.idle !== null
  }

  /** 提示符画了几次（用来判断「是不是*新*的提示符」）✓ */
  get promptGeneration(): number {
    return this.promptSeq
  }

  /**
   * **等下一个「提示符开始」**（OSC 633 的 `A`）。
   *
   * ⚠️ **为什么不能用 `state.idle` 判断「新的」** ——
   *   PowerShell 从不报 `C` ⇒ 它的 `idle` 永远是 true ⇒
   *   ⇒ Ctrl+C 之后 `idle` 还是 true ⇒ 短路返回 ⇒ **白等** ✗
   *   ⇒ ⇒ 用**提示符的次数**（`promptSeq`）⇒ 每次画提示符都 +1（两个 shell 都发 `A`）✓
   *
   * @param timeoutMs 等多久（毫秒）
   * @returns 等到了 = true；超时了 = false
   */
  waitForPrompt(timeoutMs = 3_000): Promise<boolean> {
    const from = this.promptSeq
    if (this.promptSeq > from) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        this.promptWaiters = this.promptWaiters.filter((w) => w !== waiter)
        clearTimeout(timer)
        resolve(ok)
      }
      const waiter = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.promptWaiters.push(waiter)
    })
  }

  /** 有人等提示符 ⇒ 通知它们。 */
  private notifyPromptWaiters(): void {
    const list = this.promptWaiters
    this.promptWaiters = []
    for (const w of list) w()
  }

  /**
   * **报「这个终端上正在跑的东西」的状态**（`running` / `ok` / `failed`）。
   *
   * ⚠️ **状态在终端页签上，不在状态栏** —— VS Code 的底右状态栏**没有**任务消息
   *    （`tasks/browser/taskTerminalStatus.ts` ⇒ 页签上转圈 / ✓ / ✗）✓
   *    ⇒ 用户明说「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   */
  setRunState(run: 'running' | 'ok' | 'failed' | undefined): void {
    if (this.state.run === run) return
    this.state.run = run
    this.opts.onState?.({ ...this.state })
  }

  get running(): boolean {
    return this.pty.running
  }

  /** 底下那个后端自己会不会回显（真控制台会 ⇒ IDE 不要再回显一遍）。 */
  get echoesInput(): boolean {
    return this.pty.echoesInput
  }

  /** 发「一整行命令」时用哪个行尾（**不能 `\r\n`** —— 那是两个回车 ⇒ 两个提示符）。 */
  get lineEnding(): '\r' | '\n' {
    return this.pty.lineEnding
  }

  /**
   * 底下是哪个后端（`node-pty` = 真控制台 / `pipe` = 管道兜底）。
   *
   * ⚠️ 这是**实际起起来**的那个，不是探测出来的 —— 模块能 require 不等于
   * 原生模块的 ABI 对得上（那要等 spawn 才知道）✓。
   */
  get backend(): 'node-pty' | 'pipe' {
    return this.pty.backend
  }

  get currentShell(): TerminalShell {
    return this.shell
  }

  get currentCwd(): string {
    return this.cwd
  }

  /** 订阅输出（`PtySession` 接口）。 */
  onData(cb: (data: string) => void): void {
    this.pty.onData(cb)
  }

  /** 订阅退出（`PtySession` 接口）。 */
  onExit(cb: (code: number | null) => void): void {
    this.pty.onExit(cb)
  }

  /** 改窗口大小（真控制台后端 ⇒ 实时 resize；管道版 ⇒ 只给下一个进程用）。 */
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows)
  }


  /**
   * **这个会话结束了**（shell 退了）那个 promise。
   *
   * ⚠️ 「运行」等结果时得**同时**等它 ⇒ shell 一死就立刻收场，
   *    而不是永远等 OSC 633 的「命令执行完」✓
   */
  get sessionEnded(): Promise<void> {
    return this.sessionEndedPromise
  }

  /**
   * 让 **shell** 去跑一条命令（VS Code 的「任务终端」模型）。
   *
   * ## 为什么不让程序跑在自己的 pty 里
   *
   * 以前程序跑在**自己的** pty 里，输出再**注入**到终端的显示层。
   * ⇒ 注入的内容**不在 conhost 的屏幕里** ⇒
   *    ConPTY 一 resize（拖面板分割线、全屏↔下栏）就会**整屏重画**，
   *    把注入的那段**抹掉**（提示符是 conhost 自己画的 ⇒ 不丢）✗
   *    （用户报过：「调整下栏大小会把程序的输出卡没」）
   *
   * ⇒ 现在程序是 **shell 的孩子** ⇒ 它的输出**就在 conhost 的屏幕里**
   *    ⇒ resize 重画是忠实的 ⇒ 输出不会没 ✓
   *
   * ## 顺带的好处
   *
   * - 程序的 stdout 就是控制台 ⇒ 不缓冲 ⇒ 提示立刻可见 ✓
   * - 程序的 stdin 就是终端 ⇒ `scanf` 能读到东西 ✓
   * - 「停止」= 给 shell 发 Ctrl+C ⇒ 不用杀进程 ✓
   *
   * @param match 命令行里用来认自己的片段（一般是 exe 的文件名）——
   *              shell 报「命令执行完」时，靠它认出**哪条**命令跑完了 ✓
   * @param matchMode `'strict'`（默认）= shell 报了 `E;` ⇒ 按命令行认；
   *                   `'relaxed'` = shell 压根不报 ⇒ 只能信「第一条完成的就是我们的」
   * @param interruptOnTimeout 超时的时候要不要 **Ctrl+C** 打断正在跑的东西
   *                   ⚠️ **只有「我们自己的进程」才该用 true** ——
   *                   否则 Ctrl+C 会打断**用户**的命令 ✗
   */
  async runCommand(
    cmd: string,
    opts: {
      match?: string
      timeoutMs?: number
      matchMode?: 'strict' | 'relaxed'
      interruptOnTimeout?: boolean
    } = {},
  ): Promise<TerminalRunResult> {
    const started = Date.now()
    // 已经有一条在等了 ⇒ 旧的收场（新的优先）
    if (this.pendingRun) this.finishRun(null, false)

    let resolveRun!: (r: TerminalRunResult) => void
    const result = new Promise<TerminalRunResult>((resolve) => {
      resolveRun = resolve
    })
    const run: PendingRun = {
      match: opts.match ?? '',
      matchMode: opts.matchMode ?? 'strict',
      matched: false,
      resolve: resolveRun,
      timer: null,
      graceTimer: null,
      output: '',
      startedAt: started,
    }
    const timeoutMs = opts.timeoutMs ?? 0
    if (timeoutMs > 0) {
      const interruptOnTimeout = opts.interruptOnTimeout ?? true
      run.timer = setTimeout(() => {
        /*
          ⚠️⚠️⚠️ **超时了 ⇒ 能不能 Ctrl+C？** ——
            判据是「**我们的命令是不是前台进程**」⇒ `run.matched`
            - `matched = true` ⇒ 我们的命令**确实在跑** ⇒ Ctrl+C 打到的是它 ✓
              （而且这一步得是「我们自己的进程」—— 见 `interruptOnTimeout`）
            - `matched = false` ⇒ 我们的命令**压根没开始** ⇒
              shell 在跑**用户的**命令 ⇒ **Ctrl+C 会打断用户** ✗ ⇒ 只收场，不碰 shell ✓
        */
        if (!interruptOnTimeout || !run.matched) {
          if (this.pendingRun === run) this.finishRun(null, true)
          return
        }
        // ⚠️ **超时 ⇒ 给它发 Ctrl+C**（不是杀进程）——
        //    杀进程会把 shell 一起干掉 ⇒ 用户的终端报废 ✗
        this.interrupt()
        // 再等一会儿，让 shell 把「命令执行完」报上来
        // （Ctrl+C 之后 shell 要一会儿才回到提示符）✓
        run.graceTimer = setTimeout(() => {
          if (this.pendingRun === run) this.finishRun(null, true)
        }, 3000)
      }, timeoutMs)
    }
    this.pendingRun = run
    /*
      ⚠️⚠️ **终端（shell）在跑的过程中死了 ⇒ 立刻收场** ——
        「命令跑完」是靠 OSC 633 报的 ⇒ shell 一死，那个事件**永远不来**
        ⇒ 「运行」就**永远不结束**（状态栏卡在「运行中…」）✗
        （用户报过：「点运行一直卡在运行中…」）
    */
    void this.sessionEndedPromise.then(() => {
      if (this.pendingRun === run) this.finishRun(null, false, true)
    })
    // ⚠️ **行尾按后端来** —— `\r\n` 是**两个回车** ⇒ shell 会跑两次 ✗
    this.pty.write(cmd + this.pty.lineEnding)
    return result
  }

  /**
   * 让 shell 去跑一个**可执行文件**（编译出来的程序）。
   *
   * @param cwd 程序的**工作目录** —— 默认就是 shell 当前的目录
   *             （IDE 平时就把 shell 的 cwd 同步成「当前文件所在目录」了）✓
   */
  async runProgram(
    exe: string,
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<TerminalRunResult> {
    /*
     * ⚠️ **用户当前这一行有输入** ⇒ 直接把命令接上去会变成
     *    `ls& 'C:\…'` ⇒ shell 报一个莫名其妙的错 ⇒ 程序根本没跑 ✗
     *
     * ⇒ 先 **Ctrl+C** 把那行清掉（Ctrl+C 不会**执行**它 ——
     *    这正是「用户正在敲命令时不能发空行」那条铁律要防的事）✓
     */
    if (this.pendingInput) {
      this.interrupt()
      // ⚠️ **等 shell 把提示符重画出来** —— 不等的话命令会接在旧行后面 ✗
      await new Promise((r) => setTimeout(r, 150))
    }
    // ⚠️ **目录对不上 ⇒ 先补一条 cd**（单独一条！不能跟运行命令拼一行）——
    //    bash 的 DEBUG trap 一行只报**第一条**简单命令 ⇒ 拼一起就认不出了 ✗
    //
    // ⚠️ **只在「shell 报过 cwd 且不一样」时才发** ——
    //    **刚建的终端**（冷 shell）`state.cwd` 还是 null ⇒ **不发** ⇒
    //    不用白等（那条 cd 的完成也得靠 OSC 633 报 ⇒ 等不到要等 5 秒 + Ctrl+C）
    //    ⇒ 而它**本来就在对的目录里**（终端就是用「源文件所在目录」建的）✓
    //    ⇒ **复用的终端**是热的 ⇒ shell 早报过 cwd ⇒ 该 cd 的会 cd ✓
    const target = opts.cwd
    if (target && this.state.cwd && normalizeCwd(this.state.cwd) !== normalizeCwd(target)) {
      await this.runCommand(cdCommandFor(this.shell, target), { timeoutMs: 5000 })
    }
    return this.runCommand(buildRunCommand(this.shell, exe), {
      match: basename(exe),
      timeoutMs: opts.timeoutMs,
    })
  }

  /**
   * 给正在跑的东西发 **Ctrl+C**。
   *
   * ⚠️ **真控制台（ConPTY）才有效** —— 控制台收到 0x03 会产生
   *    CTRL_C_EVENT ⇒ 前台进程真的收到 SIGINT ✓
   *    （管道版没有控制台 ⇒ 0x03 只是一个普通字节 ⇒ 打断不了 ✗）
   */
  interrupt(): void {
    try {
      this.pty.write('\x03')
    } catch {
      /* shell 已经没了 */
    }
  }

  /**
   * 「命令执行完」来了 ⇒ 看看是不是**我们**在等的那条。
   *
   * ⚠️ **必须认一下** —— 用户自己敲的命令可能先跑完 ⇒
   *    它的退出码会被当成我们程序的 ⇒ 张冠李戴 ✗
   */
  private maybeFinishRun(exitCode: number | null): void {
    const run = this.pendingRun
    if (!run) return
    /*
      ⚠️⚠️ **裸 `D`（没有退出码的那个）永远不结束一次运行** ——
        bash 的集成脚本里 `D`（无码）=「**这一行没跑过命令**」（空行）⇒
        ⇒ 拿它收场会把**正在等的那次运行提前收掉**、退出码报成 `null` ✗
        （CLAUDE.md 记过一次同类的坑：「程序的真实退出码被报成 0」）
        ⇒ 真跑过命令时退出码一定有值（bash 报 `$?`、PowerShell 报 `$LASTEXITCODE`/`$?`）✓
    */
    if (exitCode === null) return
    /*
      ⚠️ **relaxed 模式** —— shell 压根不报「这条命令是什么」⇒
        只能信「第一条完成的就是我们的」
        （发命令前我们确认过 shell 空闲 ⇒ 第一条必然是我们的）✓
    */
    if (run.matchMode === 'relaxed') {
      this.finishRun(exitCode, false)
      return
    }
    const line = this.lastCommandLine
    // shell 报了命令行 ⇒ 命令行里得带着我们那个片段（exe 的文件名）✓
    // shell 没报 ⇒ 只能信「第一条完成的就是我们的」（老 shell 的兜底）✓
    if (run.match && line && this.reportsCommandLine && !line.includes(run.match)) {
      /*
        ⚠️⚠️ **兜底：认了它** ——
          我们的命令**开始过**（`matched`）⇒ 说明用户中途插了一条命令 ⇒
          我们的 `D;` 丢了 ⇒ ⇒ 后面来的这条 `D;` 就是我们的 ⇒
          ⇒ **不然永远等不到**（「运行中」永远亮着）✗
          ⇒ ⚠️ 退出码可能取的是**用户那条**的 —— 但比挂死好 ✓
      */
      if (run.matched) this.finishRun(exitCode, false)
      return
    }
    this.finishRun(exitCode, false)
  }

  /** 收场：把结果给出去，清掉定时器。 */
  private finishRun(exitCode: number | null, timedOut: boolean, terminalClosed = false): void {
    const run = this.pendingRun
    if (!run) return
    this.pendingRun = null
    if (run.timer) clearTimeout(run.timer)
    if (run.graceTimer) clearTimeout(run.graceTimer)
    run.resolve({
      exitCode,
      timedOut,
      ...(terminalClosed ? { terminalClosed: true } : {}),
      durationMs: Date.now() - run.startedAt,
      output: run.output,
    })
  }

  /** 往 stdin 写（这是**给 shell 的输入**）。 */
  write(data: string): void {
    // ⚠️ **正在跑程序时，输入要喂给程序** ——
    //   程序自己的 stdin 默认是**空设备** ⇒ `scanf` 立刻拿到 EOF ⇒
    //   用户报过「scanf 是坏的，他根本就不会让我读，直接就跳到后面了」。
    //   跟 VS Code 的「在终端里运行」一个意思 ✓。
    if (this.programInput) {
      this.programInput(data)
      // ⚠️ **真控制台自己会回显**（控制台把敲进去的字符画出来）⇒
      //    IDE 再回显一遍的话，每个字会出现**两次**。
      //    管道版没有 TTY ⇒ 只能 IDE 自己回显 ✓。
      if (this.programEcho) this.echoProgramInput(data)
      return
    }
    this.trackInput(data)
    this.pty.write(data)
  }

  /**
   * 回显「喂给程序的输入」。
   *
   * ⚠️ **必须回显** —— 程序从**管道**读 stdin，它自己**没有 TTY、不会回显**；
   * 而 xterm.js 只负责把按键发出去，也不管回显 ⇒ 用户敲的字**屏幕上一个字都不出现**。
   * 不回显的话，「程序在等我输入」看着就跟「`scanf` 还是坏的」一模一样
   * （用户报过「scanf 是坏的，他根本就不会让我读」）。
   *
   * 只回显**可打印字符**，回车换行、退格擦除 —— 够用就行。
   */
  private echoProgramInput(data: string): void {
    let out = ''
    let inEscape = false
    for (const ch of data) {
      // ESC 序列（方向键、Home/End…）整体跳过 —— 只跳过 ESC 会把 '[A' 当正文回显出来
      if (inEscape) {
        if (ch !== '[' && ch !== 'O') inEscape = false
        continue
      }
      if (ch === '\x1b') {
        inEscape = true
        continue
      }
      if (ch === '\r' || ch === '\n') {
        out += '\r\n'
        this.programEchoLine = ''
        continue
      }
      if (ch === '\x7f' || ch === '\b') {
        // 退格：把屏幕上最后那个字符擦掉（程序那边收到的是原始字节）
        if (this.programEchoLine.length > 0) {
          this.programEchoLine = this.programEchoLine.slice(0, -1)
          out += '\b \b'
        }
        continue
      }
      // 其它控制字符（Ctrl+C…）不回显
      if (ch < ' ') continue
      this.programEchoLine += ch
      out += ch
    }
    // ⚠️ **直接 `enqueue`，不走 `display()`** ——
    //   `display()` 会在前面加 `\n\x1b[G`（VS Code 的写法：让注入的内容
    //   从新行开头写）⇒ 但**回显**是**逐字**的 ⇒ 加了前缀就断了
    //   （退格会擦错位置）✗ ⇒ ⇒ 回显不加前缀 ✓
    if (out) this.enqueue(out)
  }

  /**
   * 设置「正在跑的程序」的输入去向。
   *
   * 传 `null` 表示程序跑完了 ⇒ 输入还给 shell ✓。
   */
  setProgramInput(write: ((text: string) => void) | null, echo = true): void {
    this.programInput = write
    this.programEcho = echo
    // 回显状态清掉 —— 下一次接管是从新的一行开始
    if (!write) this.programEchoLine = ''
  }

  /**
   * 记住「用户当前这一行有没有输入」。
   *
   * 只有**可打印字符**才算输入；控制字符（方向键、退格…）不算 ——
   * 方向键不会产生内容，退格只会把内容删短。
   */
  private trackInput(data: string): void {
    // 回车 / 换行 = 这行提交了 ⇒ shell 又回到空行
    if (data.includes('\r') || data.includes('\n')) {
      /*
        ⚠️⚠️ **这一行有内容 ⇒ 用户提交了一条命令** ⇒ 终端「忙」了 ✓
          （空行 ⇒ 什么都不算 ⇒ shell 立刻又提示符了 ✓）

          ⚠️ **这是 PowerShell 判断「忙不忙」的唯一依据** ——
            它的集成脚本**故意不报 `C`** ⇒ `state.idle` 永远是 true ⇒
            ⇒ 不记这个就永远以为空闲 ⇒ 往用户正在跑的命令后面插命令 ✗

          ⚠️ **IDE 自己发的命令不会走到这里** ——
            `runCommand()` / `cd()` 都直接 `pty.write`（**绕过 `write()`**）⇒
            ⇒ 不会把自己标成「用户提交了一行」✓
      */
      if (this.pendingInput) {
        this.userCommandRunning = true
        this.userCommandDone = false
      }
      this.pendingInput = false
      return
    }
    const printable = data.replace(/[\x00-\x1f\x7f]/g, '')
    if (printable.length > 0) this.pendingInput = true
  }

  /*
    ⚠️⚠️⚠️ **这里曾经有个 `prompt()` —— 「让 shell 重打一遍提示符」—— 现在删了。**

    它的实现是**往 shell 的 stdin 写一个裸 `\r`**，指望 shell 重打提示符。
    ⇒ 但那个 `\r` 是一个**真的回车键** ⇒ shell 会跑**一整轮额外的提示符**：

        IDE  →  shell stdin : 0x0D
        shell → stdout      : 0x0D 0x0A              ← 回车回显（多一个空行）
        shell → stdout      : OSC 633;E; BEL         ← PowerShell：多一条空的历史记录
        shell → stdout      : OSC 633;D;0 BEL        ← ⚠️ 见下面
        shell → stdout      : OSC 633;A BEL
        shell → stdout      : "(base) PS C:\…"       ← ★ 多出来的那个提示符 ★
        shell → stdout      : OSC 633;B BEL

    ⇒ 所以它**不是「保证有一个提示符」，是「再加一个提示符」** ✗
    ⇒ 而且这个 `\r` **不跟 shell 同步**（直接写 pty，绕过 `write()`）：
       shell 忙的时候它被 **ConPTY 的输入缓冲**攒着 ⇒ 等程序跑完才被消费
       ⇒ **提示符就紧跟在程序输出后面** ⇒ 用户报过：
       「先打印程序输出，然后又打印一遍 (base) PS ...」✗

    ⇒ 附带一个更阴的 bug：那个 `\r` 在 PowerShell 里会造一条**空的历史记录**
       ⇒ 报 `OSC 633;D;0` ⇒ `maybeFinishRun()` 看到 `lastCommandLine === ''`
       （falsy）⇒ **跳过了匹配检查** ⇒ **正在等的那次运行被提前用退出码 `0` 收场**
       ⇒ **程序的真实退出码被报成 0** ✗

    ⇒ **VS Code 的模型**（`microsoft/vscode@main`）：
       `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts` +
       `capabilities/commandDetectionCapability.ts` ⇒ 一个状态机
       （`A` 提示符开始 → `C` 命令开始 → `C` 命令已执行 → `D;<code>` 命令结束）
       ⇒ **shell 的提示符是唯一的提示符，IDE 从来不「要」一个提示符** ✓
       ⇒ IDE 要往终端里写东西时写的是 `\n\x1b[G`（见下面的 `display()`）
       ⇒ 全仓库搜不到「往 shell 发 `\r` 让它重打提示符」这种做法 ✓
  */

  /** 换目录。管道改不了 cwd，只能往 shell 里发一条 cd 命令。 */
  cd(dir: string): void {
    this.cwd = dir
    // ⚠️ **shell 已经在那个目录了就别发** —— 发过去会：
    //    - 往 shell 历史里塞一条没用的 `cd`
    //    - 终端里多出「命令 + 输出」两行噪音
    //    ⇒ shell 集成报上来的 cwd 是**事实** ⇒ 直接比 ✓
    //    （⚠️ 路径格式要归一：IDE 的是 `C:\x\y`，shell 报的是 `C:/x/y`）
    const shellCwd = this.state.cwd
    if (shellCwd && normalizeCwd(shellCwd) === normalizeCwd(dir)) return
    // ⚠️ 直接给 shell —— 不能走 write()（那会喂给正在跑的程序 ✗）
    // ⚠️ **行尾按后端来** —— `\r\n` 是**两个回车** ⇒ shell 打两个提示符
    //    ⇒ 终端里就是「一堆空提示符」（用户报过）✓
    this.pty.write(shellCdCommand(this.shell, dir, this.pty.lineEnding))
  }

  /**
   * 只写**显示层**，不进 stdin。
   *
   * ⚠️ 程序的输出必须走这里 —— 走 `write()` 会被 shell 当成**输入的命令**执行掉
   * （终端里跑出来的程序输出会被 PowerShell 当命令跑一遍）。
   *
   * ⚠️⚠️ **写之前先写 `\n\x1b[G`**（换行 + 回到列 0）——
   *    **VS Code 就是这么干的**（`terminalInstance.ts:1912` 的 `reuseTerminal`：
   *    "Ensure new processes' output starts at start of new line"）✓
   *    ⇒ 注入的内容**从新行开头写**，不会接在 shell 那一行的半截后面 ✓
   *    ⇒ **而且绝不「要」一个提示符** —— shell 的提示符是唯一的（见上面那段）✓
   */
  display(text: string): void {
    // ⚠️ **也走排队** —— 程序输出同样可能刷屏 ⇒ 同样要限速 ✓
    this.enqueue('\n\x1b[G')
    this.enqueue(text)
  }

  /**
   * 把一条**已经执行过的命令**显示在终端里（不发给 shell）。
   *
   * 跟 VS Code 的任务终端一个样：IDE 的按钮触发了什么命令，终端里就看得见什么。
   * 只写到显示层，不进 stdin —— 所以 shell 不会把它当输入执行一遍。
   */
  echo(command: string): void {
    this.display(`\x1b[90m> ${command}\x1b[0m\r\n`)
  }
  /**
   * 杀掉 shell **进程树**。
   *
   * `child.kill()` 在 Windows 上只杀自己，子孙进程（比如你敲 `notepad`）会留下来。
   * 管道版用 `taskkill /T /F`（见 `ptyPipe.ts`）；真控制台版用 node-pty 的 kill ✓。
   */
  async kill(): Promise<void> {
    await this.pty.kill()
  }
}
