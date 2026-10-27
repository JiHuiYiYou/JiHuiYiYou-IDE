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
  spawnError?: string
}

function runProcess(
  exe: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(exe, args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      // stdin 接到"空设备" —— 读 stdin 的程序立刻拿到 EOF，而不是一直阻塞。
      // 语言仓库的回归 harness 也是这么做的（subprocess.DEVNULL）。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSubprocessEnv(),
    })

    activeChild = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      stdout += d
    })
    child.stderr?.on('data', (d: string) => {
      stderr += d
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
      resolvePromise({ code: null, stdout, stderr, timedOut, spawnError: err.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChild = undefined
      resolvePromise({ code, stdout, stderr, timedOut })
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
    timeoutMs: opts.timeoutMs ?? 10_000,
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
