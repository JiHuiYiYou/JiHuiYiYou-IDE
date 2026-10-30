import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CompileResult, RunResult } from '@shared/jhyy'
import { parseDiagnostics } from './diagnostics'
import { buildSubprocessEnv } from './env'

/**
 * Windows NTSTATUS 名称表 —— 与 `mcp-jhyy/jhyy_ntstatus.py` 保持一致。
 * 用来区分「程序崩溃」和「程序正常返回非零」（比如 fib30 正常退出 832040）。
 */
const NTSTATUS_NAMES: Record<number, string> = {
  0xc0000005: 'ACCESS_VIOLATION',
  0xc0000006: 'INVALID_HANDLE',
  0xc0000008: 'INVALID_HANDLE',
  0xc000001d: 'ILLEGAL_INSTRUCTION',
  0xc000008c: 'ARRAY_BOUNDS_EXCEEDED',
  0xc0000094: 'INTEGER_DIVIDE_BY_ZERO',
  0xc0000096: 'PRIVILEGED_INSTRUCTION',
  0xc00000fd: 'STACK_OVERFLOW',
  0xc0000374: 'HEAP_CORRUPTION',
  0xc0000409: 'STACK_BUFFER_OVERRUN',
  0xc000041d: 'STATUS_FATAL_USER_CALLBACK_EXCEPTION',
}

/** 退出码是不是 NTSTATUS（Windows 崩溃）区间。 */
export function ntstatusName(code: number | null): string | undefined {
  if (code === null) return undefined
  // Node 在 Windows 上给的是无符号 32 位值；保险起见两种都归一化。
  const unsigned = code >>> 0
  if (unsigned < 0xc0000000) return undefined
  return NTSTATUS_NAMES[unsigned] ?? `NTSTATUS_0x${unsigned.toString(16).toUpperCase()}`
}

/**
 * 编译产物工作目录。
 *
 * 为什么必须隔离：
 * 1. 编译器的跨阶段临时文件走的是**相对 CWD** 的路径
 *    （`compiler/build/obj/_inline_asm.buf` 等，见 jhyy_helpers.c 的
 *    `jh_sidefile_path`），而编译器**不会自己创建**这个目录 ——
 *    目录不存在时 fopen 失败。
 * 2. 如果 CWD = 用户项目目录，编译就会在用户项目里凭空造出
 *    `compiler/build/obj/` 一堆垃圾。
 * 3. `C:\Program Files` 默认不可写，用官方安装版编译器时 CWD 不能是它的目录。
 *
 * 所以：给编译器一个 IDE 自己管的、可写的 scratch 目录，并预先建好
 * `compiler/build/obj/`。
 */
export function ensureWorkDir(): string {
  const work = join(tmpdir(), 'jhyy-ide-work')
  mkdirSync(join(work, 'compiler', 'build', 'obj'), { recursive: true })
  return work
}

/** 清掉上一次编译留下的产物。 */
export function cleanWorkDir(): void {
  const work = join(tmpdir(), 'jhyy-ide-work')
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响下一次编译 */
  }
}

interface SpawnOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 输出太多被截断了（程序在疯狂打印） */
  truncated?: boolean
  spawnError?: string
  /** 往程序的 stdin 写（`stdin: 'pipe'` 时才有） */
  writeStdin?: (text: string) => void
}

/**
 * 捕获输出的**上限**（每个流）。
 *
 * ⚠️ **必须有上限** —— 用户报过「运行类似 `while true` 的程序时，
 * 整个 IDE 会直接卡死」。原因是程序在无限打印，而我们在**无上限地拼接**
 * 它的输出 ⇒ 内存被吃光 ⇒ 机器开始换页 ⇒ 谁都动不了。
 *
 * 超了怎么办：**立刻杀掉程序**（runaway 的循环没有停下来的道理），
 * 并且只保留**开头**的一部分（前面那几行往往才是有用的）。
 *
 * ⚠️ VS Code 为什么不会卡？因为它跑的是**真 PTY**（Windows 上是 ConPTY）：
 * 伪终端有固定大小的缓冲，输出比读快的时候**写端会阻塞**（程序自己慢下来），
 * 而且 xterm.js 是**边收边渲染**、滚动缓冲有上限 ⇒ 内存始终有界。
 * 我们没有 PTY（见 `src/main/terminal.ts` 的说明）⇒ 得自己加这个上限。
 */
const MAX_CAPTURE = 512 * 1024

/** 子进程的输出回调（流式 —— 让用户像 VS Code 那样边跑边看）。 */
export type OutputListener = (stream: 'stdout' | 'stderr', text: string) => void

function runProcess(
  exe: string,
  args: string[],
  opts: {
    cwd: string
    timeoutMs: number
    env?: Record<string, string>
    /** 输出**边产生边**回调（不是等程序结束） */
    onOutput?: OutputListener
    /**
     * 程序的 stdin 要不要**接管一根管道**。
     *
     * ⚠️ 默认是「空设备」—— 读 stdin 的程序立刻拿到 EOF，而不是一直阻塞。
     *   语言仓库的回归 harness 也是这么做的（subprocess.DEVNULL）。
     *   **但这样 `scanf` 根本读不到东西**（用户报过「scanf 是坏的，
     *   他根本就不会让我读，直接就跳到后面了」）⇒ 跑**程序**时要接管管道，
     *   把终端里敲的字喂进去 ✓。
     */
    stdinPipe?: boolean
    /** 进程刚起来时的回调（拿到写 stdin 的能力） */
    onStart?: (writeStdin: (text: string) => void) => void
  },
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let truncated = false
    let settled = false

    const child = spawn(exe, args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      // stdin 默认接到"空设备"；跑程序时接管一根管道（见上面 stdinPipe 的说明）
      stdio: [opts.stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: buildSubprocessEnv(opts.env),
    })

    /** 往程序的 stdin 写。 */
    const writeStdin = (text: string): void => {
      try {
        child.stdin?.write(text)
      } catch {
        /* 程序已经退出了 */
      }
    }
    // 程序**刚起来**就把写 stdin 的能力交出去 ——
    // 等 promise resolve 就太晚了（那时程序已经跑完，scanf 早就 EOF 了）。
    if (opts.stdinPipe) opts.onStart?.(writeStdin)

    activeChild = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    /** 超量了就杀掉程序（别让它继续吃内存）。 */
    const killIfRunaway = () => {
      if (truncated) return
      truncated = true
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
    }

    child.stdout?.on('data', (d: string) => {
      if (truncated) return
      stdout += d
      if (stdout.length > MAX_CAPTURE) {
        stdout = stdout.slice(0, MAX_CAPTURE)
        killIfRunaway()
        return
      }
      opts.onOutput?.('stdout', d)
    })
    child.stderr?.on('data', (d: string) => {
      if (truncated) return
      stderr += d
      if (stderr.length > MAX_CAPTURE) {
        stderr = stderr.slice(0, MAX_CAPTURE)
        killIfRunaway()
        return
      }
      opts.onOutput?.('stderr', d)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, opts.timeoutMs)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChild = undefined
      resolvePromise({
        code: null,
        stdout,
        stderr,
        timedOut,
        truncated,
        spawnError: err.message,
        writeStdin: opts.stdinPipe ? writeStdin : undefined,
      })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChild = undefined
      resolvePromise({
        code,
        stdout,
        stderr,
        timedOut,
        truncated,
        writeStdin: opts.stdinPipe ? writeStdin : undefined,
      })
    })
  })
}

/** 正在跑的子进程（用于「停止」按钮）。 */
let activeChild: ChildProcess | undefined

export function stopRunning(): void {
  if (!activeChild) return
  try {
    activeChild.kill()
  } catch {
    /* 已经退出了 */
  }
  activeChild = undefined
}

export interface CompileOptions {
  exePath: string
  file: string
  /** 只做诊断：加 --no-link，跳过 gcc 链接（快很多） */
  noLink?: boolean
  timeoutMs?: number
  extraArgs?: string[]
  /**
   * 产物基名（不含扩展名）。默认取源文件名。
   * 并发编译时必须传不同的名字，否则会互相覆盖。
   */
  outBase?: string
  /**
   * 额外的环境变量（覆盖继承来的同名变量）。
   *
   * 一致性测试用它实现 `// SETENV: KEY=VALUE` 指令 —— 语言仓库的回归 harness
   * 也是把 SETENV 注入到编译 + 运行两个 env 里（`mcp-jhyy/jhyy_regress.py:471`）。
   */
  env?: Record<string, string>
}

/**
 * 编译一个 .jhyy 文件。
 *
 * 产出物走 `-o <scratch>`，不落在用户项目目录里。
 */
export async function compileFile(opts: CompileOptions): Promise<CompileResult> {
  const started = Date.now()
  const file = resolve(opts.file)
  const work = ensureWorkDir()
  // ⚠️ `path.join` 遇到绝对路径**不会**重置（不像 `path.resolve`）——
  // `join('C:\\a', 'C:\\a\\b')` 会得到 `C:\a\C:\a\b` 这种垃圾路径。
  // 所以绝对路径要原样用。
  const outBase = opts.outBase
    ? isAbsolute(opts.outBase)
      ? opts.outBase
      : join(work, opts.outBase)
    : join(work, basename(file).replace(/\.jhyy$/i, '') || 'program')

  const args = ['compile', file, '-o', outBase]
  if (opts.noLink) args.push('--no-link')
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)

  const outcome = await runProcess(opts.exePath, args, {
    cwd: work,
    timeoutMs: opts.timeoutMs ?? 60_000,
    env: opts.env,
  })

  const { diagnostics, raw } = parseDiagnostics(outcome.stderr)
  const hasError = diagnostics.some((d) => d.severity === 'error')

  return {
    ok: outcome.code === 0 && !hasError,
    exitCode: outcome.code,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    diagnostics,
    raw: outcome.spawnError ? [outcome.spawnError, ...raw] : raw,
    durationMs: Date.now() - started,
    noLink: Boolean(opts.noLink),
    truncated: outcome.truncated,
  }
}

export interface RunOptions {
  exePath: string
  file: string
  timeoutMs?: number
  /**
   * 程序的**工作目录**。
   *
   * 默认是源文件所在目录（IDE 里的直觉行为：程序里的相对路径指向源码旁边）。
   * 一致性测试要覆盖语言仓库的回归 harness 时会覆盖成仓库根目录 ——
   * 有些例子用相对路径读写 `compiler/build/bin/…`。
   */
  cwd?: string
  /**
   * 额外的环境变量 —— **编译和运行都带上**。
   *
   * 一致性测试用它实现 `// SETENV: KEY=VALUE` 指令：语言仓库的回归 harness
   * 也是把 SETENV 同时注入编译 env 和运行 env（`mcp-jhyy/jhyy_regress.py:470-471`），
   * 少一边的话测试的语义就跟上游对不上了。
   */
  env?: Record<string, string>
  /** 程序的输出**边跑边**回调（让用户像 VS Code 那样实时看到） */
  onOutput?: OutputListener
  /**
   * 程序启动时的回调 —— 拿到「往程序 stdin 写」的能力。
   *
   * ⚠️ **必须有它**，否则 `scanf` 读不到东西：程序的 stdin 默认是**空设备**
   * （立刻 EOF ⇒ `scanf` 直接返回 ⇒ 程序就跑过去了 —— 用户报过
   * 「scanf 是坏的，他根本就不会让我读，直接就提到后面了」）。
   *
   * IDE 把这个写入器接到**终端**上 ⇒ 用户在终端里敲的字就喂给程序 ✓
   * （跟 VS Code 的「在终端里运行」一个意思）。
   */
  onProgramStart?: (writeStdin: (text: string) => void) => void
}

/**
 * 编译并运行。
 *
 * ⚠️ **不能 shell out `jhyy run`** —— 它的 `jh_run` 只管道 stderr，stdout/stdin
 * 直接继承（jhyy_helpers.c:747，W-050 的设计），拿不到程序输出。
 * 所以这里自己 compile + 自己 spawn 产物。
 */
export async function runFile(opts: RunOptions): Promise<RunResult> {
  const file = resolve(opts.file)
  const started = Date.now()

  const work = ensureWorkDir()
  const outBase = join(work, basename(file).replace(/\.jhyy$/i, '') || 'program')

  const compile = await compileFile({
    exePath: opts.exePath,
    file,
    noLink: false,
    timeoutMs: 60_000,
    outBase,
    env: opts.env,
  })

  if (!compile.ok) {
    return {
      ...compile,
      durationMs: Date.now() - started,
      ran: false,
      crashed: false,
      programStdout: '',
      programStderr: '',
    }
  }

  const exePath = outBase + '.exe'
  if (!existsSync(exePath)) {
    return {
      ...compile,
      durationMs: Date.now() - started,
      ran: false,
      crashed: false,
      programStdout: '',
      programStderr: `编译成功但找不到产物：${exePath}`,
    }
  }

  // 程序的 CWD = 源文件所在目录（用户直觉：程序里的相对路径操作指向源码旁边）
  const outcome = await runProcess(exePath, [], {
    cwd: opts.cwd ?? dirname(file),
    // ⚠️ **默认 60 秒**（原来 10 秒）——
    //   程序可能在等输入（`scanf`）⇒ 得给用户时间打字。
    //   疯狂打印的那种由**输出上限**秒杀 ✓（不用靠超时）。
    timeoutMs: opts.timeoutMs ?? 60_000,
    env: opts.env,
    // ⚠️ **边跑边送** —— 用户像 VS Code 那样实时看到输出（VS Code 那边是
    // PTY + xterm 增量渲染，我们没 PTY，就自己推）。
    onOutput: opts.onOutput,
    // ⚠️ **接管 stdin** —— 否则 `scanf` 读不到东西（空设备 = 立刻 EOF）。
    stdinPipe: true,
    // 程序**刚起来**就把写 stdin 的能力交给 IDE（它接到终端上）——
    // 等 promise resolve 就太晚了（那时程序已经跑完）。
    onStart: opts.onProgramStart,
  })

  const crash = ntstatusName(outcome.code)

  return {
    ...compile,
    durationMs: Date.now() - started,
    ran: true,
    exitCode: outcome.code,
    crashed: crash !== undefined,
    crashName: crash,
    programStdout: outcome.stdout,
    programStderr: outcome.stderr,
    raw: outcome.spawnError ? [outcome.spawnError, ...compile.raw] : compile.raw,
  }
}
