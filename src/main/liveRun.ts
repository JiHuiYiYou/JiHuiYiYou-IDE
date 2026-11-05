import { stripAnsi } from '@shared/ansi'
import type { TerminalShell } from '@shared/terminal'
import { supportsShellIntegration } from './shellIntegration'
import { buildLiveSteps, type LiveStep, type TerminalSession } from './terminal'

/**
 * **在「当前那个活着的终端」里跑程序**（用户要的模型）。
 *
 * ## 跟「一次性终端」那条路的区别
 *
 * | | 一次性终端（老路，现在只当**保底**） | 活 shell（本模块） |
 * |---|---|---|
 * | 命令怎么进去 | **shell 的启动参数**（`bash -c "…"`） | **敲进 shell 的 stdin** |
 * | 跑完之后 | **shell 自己退出** ⇒ 终端死了 ✗ | **shell 还活着** ⇒ 提示符回来 ✓ |
 * | 判完成靠 | 终端进程退出 | OSC 633 的 `D;<code>` |
 * | 可见的终端会不会跳 | **会**（`runTerminal()` 改了 `activeId`）✗ | **不会** ✓ |
 *
 * ⇒ 走这条路，**用户抱怨的两条都解决**：程序跑在**你正在看的那个终端**里，
 *   跑完终端**还是活的** ✓✓
 *
 * ## 为什么需要「保底」
 *
 * - `cmd` **没有** shell 集成（VS Code 也不支持）⇒
 * - 用户可以用 `JHY_IDE_NO_SHELL_INTEGRATION=1` 把集成关掉 ⇒
 * - 集成脚本加载失败（PowerShell 的 profile 被策略挡了…）⇒
 * ⇒ 这三种情况 ⇒ 退回一次性终端那条老路（它不依赖 OSC 633）✓
 */

/** **为什么退回老路**（给用户看的原因）。 */
export type LiveFallbackReason =
  /** 这个 shell 没有 shell 集成（cmd / 用户用环境变量关掉了） */
  | 'no-shell-integration'
  /** 等了半天集成还没起来（脚本加载失败 / profile 极慢） */
  | 'integration-timeout'
  /** **用户自己的命令在跑** ⇒ 不要打扰他 */
  | 'busy'
  /** 用户敲了半截命令 ⇒ 清不掉（管道版）⇒ 不要打扰他 */
  | 'pending-input'
  /** 终端没了 */
  | 'shell-dead'

export interface LiveRunOptions {
  kind: 'run' | 'check'
  /** 跑命令的那个终端（**当前那个**）✓ */
  session: TerminalSession
  shell: TerminalShell
  compiler: string
  src: string
  outBase: string
  workDir: string
  runDir: string
  noLink?: boolean
  extraArgs?: string[]
  /** 「检查」跑完要 cd 回哪儿（`null` = 不用回） */
  returnCwd?: string | null
  /**
   * **真的要动手了**（pre-flight 全过了）⇒ 回调一下。
   *
   * ⚠️ **主进程在这儿把「运行绑定到终端」** ——
   *    「停止」按钮的 Ctrl+C 必须发给**真正跑程序的那个**终端 ✓
   *    （以前发给 `terminals.active()` ⇒ 用户切了个终端就 Ctrl+C 不到了）✗
   */
  onStart?: (session: TerminalSession) => void
}

export interface LiveRunOutcome {
  /** 真的在当前终端里跑完了（`false` = 走了保底） */
  ok: boolean
  /** 为什么退回老路（没退 = `undefined`） */
  fallback?: LiveFallbackReason
  /** 编译那一步的退出码 */
  compileExitCode: number | null
  /** 编译那一步的输出（**纯文本**，已剥 ANSI） */
  compileText: string
  /** 程序那一步的退出码 */
  programExitCode: number | null
  /** 程序那一步的输出（**纯文本**，已剥 ANSI） */
  programText: string
  /** 程序真的跑了吗 */
  ran: boolean
  /** 超时了（不是程序自己退的） */
  timedOut: boolean
  /** 终端（shell）在跑的过程中死了 */
  terminalClosed: boolean
  /** 跑了多久（毫秒） */
  durationMs: number
}

/**
 * 等 shell 集成起来要多久（毫秒）。
 *
 * ⚠️ **为什么给到 30 秒** —— shell 的**第一个提示符**要等它自己的 profile 加载完
 *   （这台机器的 PowerShell profile 要 **9～11 秒** —— `conda init` 之类）⇒
 *   ⇒ 提示符不出来 ⇒ 集成就没起来 ⇒ 等不到「命令执行完」⇒ **运行会挂住** ✗
 *   ⇒ ⇒ **等它**（跟 `shellEnv.ts` 导 profile env 的 30 秒超时一个量级）✓
 *   ⇒ ⚠️ **只冷终端要等** —— 之后每次跑都是瞬间的 ✓
 */
const INTEGRATION_TIMEOUT_MS = 30_000
/** 「清掉用户敲了一半的那行」之后，等新提示符要多久。 */
const PROMPT_TIMEOUT_MS = 3_000

/**
 * **在当前终端里跑一组命令**。
 *
 * ⚠️⚠️ **pre-flight 必须在动手之前全部做完** ——
 *   只要有一项不过 ⇒ **用户的终端一个字节都不碰** ⇒ 直接退回老路 ✓
 *   （先敲了再发现要退回 ⇒ 用户的终端已经被污染了 ✗）
 */
export async function runInLiveShell(opts: LiveRunOptions): Promise<LiveRunOutcome> {
  const started = Date.now()
  const { session, shell } = opts

  const bail = (reason: LiveFallbackReason): LiveRunOutcome => ({
    ok: false,
    fallback: reason,
    compileExitCode: null,
    compileText: '',
    programExitCode: null,
    programText: '',
    ran: false,
    timedOut: false,
    terminalClosed: false,
    durationMs: Date.now() - started,
  })

  // ── ① 这个 shell 支持集成吗？ ──────────────────────────────
  //    ⚠️ cmd 没有（VS Code 也不支持）⇒ 退回老路 ✓
  if (!supportsShellIntegration(shell)) return bail('no-shell-integration')

  // ── ② 终端死了吗？ ────────────────────────────────────────
  if (!session.running) return bail('shell-dead')

  // ── ③ 集成起来了吗？ ──────────────────────────────────────
  //    ⚠️⚠️ **集成没起来 ⇒ 等不到「命令执行完」⇒ 整个运行会挂住** ✗
  //    ⇒ ⇒ **等它**（冷终端要等 profile 加载完 ⇒ 第一个提示符可能十几秒）✓
  //    ⇒ 等不到就退回老路 ✓
  //
  //    ⚠️ **「开始跑了」在这里报** ⇒ 用户看得见终端页签在转圈
  //    （不然「等 shell 起来」那十几秒里**什么反应都没有** ⇒ 像坏了）✓
  opts.onStart?.(session)
  if (!session.shellIntegrationReady) {
    const ready = await waitForIntegration(session, INTEGRATION_TIMEOUT_MS)
    if (!ready) return bail('integration-timeout')
  }

  // ── ④ 终端忙不忙？ ────────────────────────────────────────
  //    ⚠️⚠️ **用户自己的命令在跑 ⇒ 不要往他的终端里敲东西** ✗
  //    ⇒ 退回老路（= VS Code 的任务终端行为：另开一个终端跑）✓
  if (session.shellBusy) return bail('busy')

  /*
    ⚠️ **用户敲了半截命令** ⇒ 我们的命令会接在他的半截后面
    （`ls& 'C:\…'`）⇒ shell 报一个莫名其妙的错 ⇒ 命令根本没跑 ✗

    ⚠️⚠️ **能不能清掉那行，取决于后端** ——
      - **真控制台（ConPTY）** ⇒ Ctrl+C 会产生 CTRL_C_EVENT ⇒ 那一行被丢掉 ✓
      - **管道版** ⇒ 没有控制台 ⇒ `0x03` 只是个普通字节 ⇒
        bash 从管道读行时**不做行编辑** ⇒ **清不掉** ✗
        ⇒ ⇒ 管道版只能**不打扰用户** ⇒ **退回老路** ✓
  */
  if (session.hasPendingInput) {
    if (!session.canClearInputLine) return bail('pending-input')
    session.interrupt()
    // ⚠️ **等一个「新的」提示符** —— 不等的话命令会接在旧行后面 ✗
    //    （不能等固定毫秒数 ⇒ 并行跑的时候会偶发失败 ⇒ 旧代码就是这么翻车的）
    await session.waitForPrompt(PROMPT_TIMEOUT_MS)
  }

  // ── 排命令序列 ────────────────────────────────────────────
  /*
    ⚠️⚠️ **cwd 在动手之前读一次** ——
      bash 的 `P;Cwd` 跟 `D;` 是两次写 ⇒ ConPTY 下 `P;Cwd` 可能晚一个 chunk
      ⇒ resolve 的时候 `state.cwd` 还是 cd **之前**的值 ⇒ 判断会错 ✗
      ⇒ 之后的 cwd 由 `buildLiveSteps` 自己一路记着 ✓
  */
  const steps: LiveStep[] = buildLiveSteps(shell, {
    kind: opts.kind,
    compiler: opts.compiler,
    src: opts.src,
    outBase: opts.outBase,
    workDir: opts.workDir,
    runDir: opts.runDir,
    currentCwd: session.shellState.cwd,
    returnCwd: opts.returnCwd ?? null,
    ...(opts.noLink !== undefined ? { noLink: opts.noLink } : {}),
    ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
  })

  // ── 一条一条跑 ────────────────────────────────────────────
  let compileExitCode: number | null = null
  let compileText = ''
  let programExitCode: number | null = null
  let programText = ''
  let ran = false
  let timedOut = false
  let terminalClosed = false
  let compileFailed = false

  for (const step of steps) {
    /*
      ⚠️⚠️ **编译失败 ⇒ 跳过「跑产物」那一步** ——
        跟一次性路径那条 `&&` 链一个意思（编译失败就不该跑产物）✓
        ⚠️ **但后面那条 cd 照样要跑** —— 不然 shell 留在 scratch 目录 ✗
    */
    if (compileFailed && step.role === 'run') continue

    /*
      ⚠️ **管道版：shell 自己不回显我们敲的命令** ——
        （bash 从管道读行 ⇒ 没有终端回显 ⇒ 用户看不到「跑的是哪条命令」）✗
        ⇒ **自己写一行**（`echo()` 只写显示层，不进 stdin ⇒ shell 不会执行它）✓
        ⇒ 真控制台（ConPTY）**自己会回显** ⇒ 那种就别写 ⇒ 不然**同一个字出现两次** ✗
    */
    if (!session.echoesInput) session.echo(step.command)

    const r = await session.runCommand(step.command, {
      match: step.match,
      timeoutMs: step.timeoutMs ?? 0,
      ...(step.interruptOnTimeout !== undefined
        ? { interruptOnTimeout: step.interruptOnTimeout }
        : {}),
    })
    // ⚠️ **输出带 ANSI 颜色** ⇒ 喂诊断之前**必须剥掉**
    //    （不然 `parseDiagnostics` 会把 `\x1b[31m` 吃进 file 字段 ⇒ 路径点不开 ✗）
    const text = stripAnsi(r.output)

    if (r.terminalClosed) {
      terminalClosed = true
      break
    }
    if (r.timedOut) {
      timedOut = true
      break
    }
    if (step.role === 'compile') {
      compileExitCode = r.exitCode
      compileText = text
      if (r.exitCode !== 0) compileFailed = true
    } else if (step.role === 'run') {
      programExitCode = r.exitCode
      programText = text
      ran = true
    } else if (step.role === 'cd' && r.exitCode !== null && r.exitCode !== 0) {
      /*
        ⚠️⚠️ **cd 失败 ⇒ 整条序列停下** ——
          不然编译会在**用户的项目目录**里跑 ⇒
          凭空造出 `compiler/build/obj/` 垃圾（CLAUDE.md 记过这个坑）✗

          ⚠️ **cd 的退出码是可靠的** ——
            PowerShell 的 `Set-Location` 是 cmdlet ⇒ `$LASTEXITCODE` 不变 ⇒ 看着像不可靠，
            **但我们的集成脚本每个提示符都把 `$LASTEXITCODE` 清成 `$null`**
            ⇒ 到 cd 的提示符时它是 null ⇒ 报的是 `$?` 的反面（成功 0 / 失败 1）✓
      */
      break
    }
  }

  return {
    ok: true,
    compileExitCode,
    compileText,
    programExitCode,
    programText,
    ran,
    timedOut,
    terminalClosed,
    durationMs: Date.now() - started,
  }
}

/**
 * 等 shell 集成起来（收到过 OSC 633 ⇒ 脚本加载成功了 ✓）。
 *
 * ⚠️ **必须能判断「集成真的起来了吗」** ——
 *   集成脚本加载失败 ⇒ 静悄悄地没有 OSC ⇒ 「让 shell 跑命令」等不到结果
 *   ⇒ **整个「运行」会挂住** ✗ ⇒ 所以要能判断 ⇒ 判断不了就退回老路 ✓
 */
async function waitForIntegration(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (session.shellIntegrationReady) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return session.shellIntegrationReady
}
