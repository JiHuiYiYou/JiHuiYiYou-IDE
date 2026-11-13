/**
 * 判分器 —— 「模型改完的代码算不算对」。
 *
 * ## 判据（三条都要满足）
 *
 * 1. **编译通过**（含链接 —— `fn main` 那种错只在链接期暴露）
 * 2. **退出码对**（跟原文件一致）
 * 3. **stdout 逐字一致**（跟原文件一致）
 *
 * 第 3 条是主力。少了它，`expectExit: 0` 的题会被「把函数体删了返回 0」白送分。
 *
 * ## 为什么判据跟「回归 harness」而不是「模型自己说的」
 *
 * 编译器是唯一的裁判。模型说「修好了」不算，**它改出来的文件能编能跑且行为一致**才算。
 */

import { spawnSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'

import { compileFile, runFile } from '../../src/main/compiler/runner'
import type { EvalTask } from './tasks'

/**
 * 编译 + 运行一个 **C** 文件（对照组用）。
 *
 * ⚠️ 口径跟 JHYY 侧对齐：`gcc -O0`（同 `bench/difftest.py`）+ 跑 + 比 stdout。
 */
function compileAndRunC(
  file: string,
  gccPath: string,
): { ok: boolean; stdout: string; stderr: string; exitCode: number | null } {
  const exe = file.replace(/\\.c$/, '') + '.exe'
  const c = spawnSync(gccPath, ['-O0', '-ffp-contract=off', '-o', exe, file], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (c.status !== 0) {
    return { ok: false, stdout: '', stderr: String(c.stderr ?? '').trim(), exitCode: c.status }
  }
  try {
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    return {
      ok: true,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? '').trim(),
      exitCode: r.status,
    }
  } finally {
    try {
      unlinkSync(exe)
    } catch {
      /* 删不掉就算了 */
    }
  }
}

/** 判分结果。 */
export interface Grade {
  /** 三条判据全过才算过 */
  passed: boolean
  compiled: boolean
  exitOk: boolean
  stdoutOk: boolean
  /** 实际退出码 */
  actualExit?: number
  /** 实际 stdout */
  actualStdout?: string
  /** 失败原因（给报告看） */
  reason?: string
  /** 编译诊断 */
  errors: string[]
}

/**
 * **行尾归一化** —— 两个语言分支**都要用**。
 *
 * ⚠️ **踩过的坑**：期望值是**构建任务时**抓的，而构建用的是 **Python 的 subprocess**
 *   （`text=True` ⇒ CRLF 已被翻成 LF），评测时抓 stdout 用的是 **Node**
 *   （Windows 文本模式 ⇒ CRLF 原样）⇒ 内容一模一样也判失败。
 * ⚠️ **第一版只在 C 分支加了归一化** ⇒ JHYY 分支漏了 ⇒ 配对集的 JHYY 侧**全挂**
 *   （全是假失败 —— 模型其实改对了）。⇒ **归一化必须是共用函数，不是某个分支的补丁。**
 */
function normEol(x: string): string {
  return x.replace(/\r\n/g, '\n')
}

/** 判分输入。 */
export interface GradeInput {
  task: EvalTask
  /** 待判的源码文件（模型改出来的那份） */
  file: string
  /** 编译器 */
  exePath: string
  /** 运行时的工作目录 —— 必须跟构建任务时**一致**（原文件也是在那边跑的） */
  cwd: string
  /** 产物基名（并发时不能撞） */
  outBase: string
}

/**
 * 退出码比对 —— 只看低 8 位。
 *
 * Windows 的进程退出码只保留低 8 位，语言仓库的回归 harness 也是用
 * `& 0xFF` 比的（`mcp-jhyy/jhyy_regress.py`）。直接比全值会误判。
 */
function exitMatches(expected: number | undefined, actual: number | null): boolean {
  if (expected === undefined) return true
  return ((actual ?? 0) & 0xff) === (expected & 0xff)
}

/** 判一次分。 */
export async function grade(input: GradeInput): Promise<Grade> {
  const { task, file, exePath, cwd, outBase } = input

  // ── C 对照组：走 gcc ────────────────────────────────────────
  if (task.lang === 'c') {
    const gccPath = process.env.GCC || 'gcc'
    const r = compileAndRunC(file, gccPath)
    if (!r.ok) {
      const errs = r.stderr ? r.stderr.split(/\r?\n/).filter(Boolean).slice(0, 5) : []
      return {
        passed: false,
        compiled: false,
        exitOk: false,
        stdoutOk: false,
        reason: errs.length > 0 ? `编译失败：${errs[0]}` : '编译失败',
        errors: errs,
      }
    }
    const expectedStdout = task.expectStdout
    // ⚠️ **行尾要归一化** —— 期望值是**构建时**用 Python 的 subprocess 抓的
    //   （`text=True` ⇒ CRLF 已被翻成 LF），而评测时是 **Node 的 spawnSync**
    //   抓的（Windows 文本模式 ⇒ CRLF 原样）⇒ 不归一化就是**假失败**
    //   （实测：内容一模一样，只差 CR LF 与 LF ⇒ 判失败）。
    const norm = (x: string) => x.replace(/\r\n/g, '\n')
    const exactOk =
      expectedStdout !== undefined ? norm(r.stdout) === norm(expectedStdout) : true
    const stdoutOk = exactOk
    const reasons: string[] = []
    if (!stdoutOk) {
      reasons.push(
        `stdout 不一致：期望 ${JSON.stringify(expectedStdout?.slice(0, 60))}，` +
          `实际 ${JSON.stringify(r.stdout.slice(0, 60))}`,
      )
    }
    return {
      passed: stdoutOk,
      compiled: true,
      exitOk: true,
      stdoutOk,
      actualExit: r.exitCode ?? undefined,
      actualStdout: r.stdout,
      reason: reasons.length > 0 ? reasons.join('；') : undefined,
      errors: [],
    }
  }

  const compile = await compileFile({ exePath, file, noLink: false, timeoutMs: 30_000, outBase })
  if (!compile.ok) {
    const errs = compile.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.line}:${d.col} ${d.message}`)
    return {
      passed: false,
      compiled: false,
      exitOk: false,
      stdoutOk: false,
      reason: errs.length > 0 ? `编译失败：${errs[0]}` : '编译失败（无诊断）',
      errors: errs,
    }
  }

  // ⚠️ **`stdinPipe: false`（stdin 接空设备 ⇒ 立刻 EOF）** —— 跟语言仓库的
  //   回归 harness 同一口径（`mcp-jhyy/jhyy_regress.py` 用 `stdin=DEVNULL`）。
  //   ⚠️ **不关掉的话，读 stdin 的程序会一直等** ⇒ 超时被杀 ⇒ 没有输出
  //   ⇒ **模型改对了也会被判失败**（实测 `dungeon_game` 问「前往下一层？」）。
  const run = await runFile({ exePath, file, timeoutMs: 20_000, cwd, stdinPipe: false })
  const exitOk = exitMatches(task.expectExit, run.exitCode)

  // stdout 判据 —— **两个检查都要过**：
  //
  // ① 逐字比（`expectStdout`）：原文件跑出来的**精确** stdout
  //    —— 构建时只有在输出**稳定**（跑两遍一样）时才会记下来
  // ② EXPECT-OUT 子串（`expectOut`）：语料作者自己写的期望
  //
  // ⚠️ **为什么 ① 要有条件**：有些语料会打印**堆指针地址**（实测 `arena_test`
  //   打印 `p1=-968043984` ⇒ 每次跑都不一样）⇒ 逐字比**天然不稳定**。
  // ⚠️ **为什么 ② 要单独判**：有些是**随机游戏**（实测 `dungeon_game` 的期望是
  //   「最终金币：0」⇒ 两次跑金币数不一样）⇒ 子串也可能不稳 ⇒ 构建时会把
  //   这种题**丢掉**（判不了就不该出题）。
  //
  // ⚠️ **两个检查都要有 reason** —— 旧版只给「逐字」写了 reason，
  //   子串失败时 reason 是空的（`undefined` 被 JSON.stringify 丢掉）
  //   ⇒ **静默失败**，看不出到底哪条没过 ✗
  const expectedStdout = task.expectStdout
  const exactOk =
    expectedStdout !== undefined
      ? normEol(run.programStdout) === normEol(expectedStdout)
      : true
  const substrOk =
    task.expectOut !== undefined ? normEol(run.programStdout).includes(task.expectOut) : true
  const stdoutOk = exactOk && substrOk

  const reasons: string[] = []
  if (!exitOk) reasons.push(`退出码不对：期望 ${task.expectExit}，实际 ${run.exitCode}`)
  if (!exactOk) {
    reasons.push(
      `stdout 不逐字一致：期望 ${JSON.stringify(expectedStdout?.slice(0, 60))}，` +
        `实际 ${JSON.stringify(run.programStdout.slice(0, 60))}`,
    )
  }
  if (!substrOk) {
    reasons.push(
      `stdout 不含 EXPECT-OUT ${JSON.stringify(task.expectOut)}：` +
        `实际 ${JSON.stringify(run.programStdout.slice(0, 60))}`,
    )
  }

  return {
    passed: exitOk && stdoutOk,
    compiled: true,
    exitOk,
    stdoutOk,
    actualExit: run.exitCode ?? undefined,
    actualStdout: run.programStdout,
    reason: reasons.length > 0 ? reasons.join('；') : undefined,
    errors: [],
  }
}
