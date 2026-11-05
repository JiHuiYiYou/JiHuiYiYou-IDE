import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInLiveShell } from '../../src/main/liveRun'
import { TerminalSession } from '../../src/main/terminal'
import { listCandidates, probeJhyy } from '../../src/main/compiler/locate'
import type { TerminalShell } from '@shared/terminal'

/**
 * **「运行」在活着的终端里跑** —— 端到端，**真编译器**。
 *
 * ## 为什么这条测试最重要
 *
 * ⚠️ **PowerShell 是默认 shell** ⇒ 而它的 OSC 633 行为跟 bash 不一样：
 * - 它的 `E;`（这条命令是什么）**只在提示符时**才发（bash 是在命令开始时发）
 * - 它**故意不报** `C`（命令开始）⇒ ⇒ 「shell 空闲吗」不能只看 `state.idle`
 * ⇒ ⇒ **PowerShell 这条路必须单独钉住** ⇒ 不然用户一按 F5 就挂 ✓
 *
 * ## 还要钉住「bash 不能带 `&`」
 *
 * ⚠️ bash 的 `&` 是**后台算符** ⇒ 编译会跑到后台 ⇒
 *   退出码是假的、产物还没生成就去跑 ⇒ **必错** ✗✗
 */

/** 一个会打印东西、并且返回 7 的 JHYY 程序。 */
const HELLO_PROGRAM = `extern fn printf(fmt: *u8, val: i64) -> i32;

fn main_jhyy() -> i32 {
    printf("HELLO_FROM_PROGRAM\\n", 42 as i64);
    7
}
`

/** 一个编译不过的程序（少个分号）。 */
const BROKEN_PROGRAM = `fn main_jhyy() -> i32 {
    let x: i32 = 1
    x
}
`

/**
 * **假 HOME** —— 让 shell **别加载用户的 profile**。
 *
 * ⚠️ **不是图快，是图「可复现」** ——
 *   这台机器的 PowerShell profile 要 **9 秒**（conda init 之类）
 *   ⇒ 加载它 ⇒ 每个测试都慢 ⇒ 而且**测的是 profile，不是我们的命令链** ✗
 */
let fakeHome = ''
const oldHome = process.env.HOME
const oldProfile = process.env.USERPROFILE

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'jhyy-livereal-'))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
})

afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  if (oldProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = oldProfile
})

/** 找一个能用的编译器；找不到就跳过这个测试。 */
async function findCompiler(): Promise<string | null> {
  for (const candidate of listCandidates(process.cwd())) {
    const probe = await probeJhyy(candidate.exePath)
    if (probe.ok) return candidate.exePath
  }
  return null
}

/** 编译器要一个可写的 scratch 目录（跨阶段临时文件走相对 CWD 的路径）。 */
function makeWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-livework-'))
  mkdirSync(join(dir, 'compiler', 'build', 'obj'), { recursive: true })
  return dir
}

/** 起一个真的 shell（管道后端 —— 测试不该取决于「装没装 node-pty」）。 */
async function makeShell(shell: TerminalShell, cwd: string): Promise<TerminalSession> {
  const session = new TerminalSession({
    shell,
    cwd,
    onData: () => {},
    onExit: () => {},
    backend: 'pipe',
  })
  // 等 shell 真的空闲了（提示符出来了）再发命令
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000 && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return session
}

/** 等 shell 回到提示符。 */
async function waitIdle(session: TerminalSession, timeoutMs = 10_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return session.shellState.idle === true
}

/** 「运行」的参数（路径都指到临时目录里）。 */
function runOpts(
  shell: TerminalShell,
  session: TerminalSession,
  compiler: string,
  src: string,
  outBase: string,
  workDir: string,
  runDir: string,
) {
  return {
    kind: 'run' as const,
    session,
    shell,
    compiler,
    src,
    outBase,
    workDir,
    runDir,
  }
}

describe('活着的终端 + 真编译器（端到端）', () => {
  it('⚠️⚠️ **PowerShell（默认 shell！）⇒ 编译 + 跑产物 ⇒ 程序有输出、退出码是程序的、终端还活着**', async () => {
    const compiler = await findCompiler()
    if (!compiler) return // 这台机器没有编译器 ⇒ 跳过

    const work = makeWorkDir()
    const src = join(work, 'prog.jhyy')
    writeFileSync(src, HELLO_PROGRAM, 'utf8')
    const outBase = join(work, 'out')
    const session = await makeShell('powershell', work)
    try {
      const live = await runInLiveShell(
        runOpts('powershell', session, compiler, src, outBase, work, work),
      )
      expect(live.ok).toBe(true)
      expect(live.fallback).toBeUndefined()
      // ⚠️⚠️ **核心断言：程序的输出必须在** ✓
      expect(live.programText).toContain('HELLO_FROM_PROGRAM')
      // ⚠️ **退出码是程序的（7），不是编译器的（0）** ✓
      expect(live.programExitCode).toBe(7)
      expect(live.compileExitCode).toBe(0)
      // ⚠️⚠️ **终端还活着**（用户报过「跑完就死了」）✓
      expect(session.running).toBe(true)
      expect(await waitIdle(session)).toBe(true)
    } finally {
      await session.kill()
    }
  })

  it('⚠️ **bash ⇒ 同样跑得起来**（bash 不能带 `&`！⇒ 这条正好钉住那个硬伤）', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const work = makeWorkDir()
    const src = join(work, 'prog.jhyy')
    writeFileSync(src, HELLO_PROGRAM, 'utf8')
    const outBase = join(work, 'out')
    const session = await makeShell('bash', work)
    try {
      const live = await runInLiveShell(runOpts('bash', session, compiler, src, outBase, work, work))
      expect(live.ok).toBe(true)
      expect(live.programText).toContain('HELLO_FROM_PROGRAM')
      expect(live.programExitCode).toBe(7)
      expect(session.running).toBe(true)
    } finally {
      await session.kill()
    }
  })

  it('⚠️ **编译失败 ⇒ 程序不跑、退出码非 0**', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const work = makeWorkDir()
    const src = join(work, 'broken.jhyy')
    writeFileSync(src, BROKEN_PROGRAM, 'utf8')
    const outBase = join(work, 'out')
    const session = await makeShell('powershell', work)
    try {
      const live = await runInLiveShell(
        runOpts('powershell', session, compiler, src, outBase, work, work),
      )
      expect(live.ran).toBe(false)
      expect(live.compileExitCode).not.toBe(0)
      expect(live.programText).not.toContain('HELLO_FROM_PROGRAM')
      // ⚠️ **编译器的报错要在**（诊断就是从这条流里解析的）✓
      expect(live.compileText).toMatch(/error/i)
    } finally {
      await session.kill()
    }
  })

  it('⚠️ **跑完还能接着用**（PowerShell 那边也得行）', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const work = makeWorkDir()
    const src = join(work, 'prog.jhyy')
    writeFileSync(src, HELLO_PROGRAM, 'utf8')
    const outBase = join(work, 'out')
    const session = await makeShell('powershell', work)
    try {
      await runInLiveShell(runOpts('powershell', session, compiler, src, outBase, work, work))
      // ⚠️ **再敲一条命令** ⇒ 要成功 ✓
      const after = await session.runCommand('Write-Output STILL_ALIVE', {
        match: 'STILL_ALIVE',
        timeoutMs: 10_000,
      })
      expect(after.exitCode).toBe(0)
      expect(after.output).toContain('STILL_ALIVE')
    } finally {
      await session.kill()
    }
  })
})
