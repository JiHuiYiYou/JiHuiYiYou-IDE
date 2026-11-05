import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInLiveShell } from '../../src/main/liveRun'
import { TerminalSession } from '../../src/main/terminal'
import { TerminalRegistry } from '../../src/main/terminalRegistry'
import { parseDiagnostics } from '../../src/main/compiler/diagnostics'
import type { TerminalShell } from '@shared/terminal'

/**
 * **「运行」在「当前那个活着的终端」里跑** —— 端到端（真 bash + 假编译器）。
 *
 * ## 这些测试钉住的是什么
 *
 * 1. **程序跑在「当前那个终端」里** ⇒ **可见的终端页签不跳**（用户报过）✓
 * 2. **跑完终端还活着**（shell 还在、提示符回来了）✓（用户报过）
 * 3. 退出码是**程序自己的** ✓
 * 4. 编译失败 ⇒ 程序不跑 ✓
 * 5. **终端正忙 ⇒ 一个字都不写进去** ⇒ 退回老路（不打扰用户）✓
 *
 * ## 为什么用「假编译器」
 *
 * 真编译器要链 gcc ⇒ 慢 ⇒ 而这里要测的是**终端那一层** ⇒
 * 用一个 bash 脚本冒充编译器（它把产物写成一个脚本）⇒ 快、稳 ✓
 * （真编译器那条路在 `liveRunReal.test.ts` 里测 ✓）
 */

/** 假编译器的产物会打印这个 ⇒ 测试靠它认「程序真的跑了」。 */
const PROGRAM_MARKER = 'PROGRAM_MARKER_7'
/** 假编译器成功时打印这个。 */
const COMPILE_MARKER = 'FAKE_COMPILE_OK'

/** 起一个真的 bash（管道后端 —— 测试不该取决于「装没装 node-pty」）。 */
async function makeBash(): Promise<{
  session: TerminalSession
  dir: string
  /** 终端里流过的**全部文本** */
  output: () => string
  restore: () => void
}> {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-live-'))
  // ⚠️ **别加载用户自己的 ~/.bashrc** —— 它可能很慢（nvm/conda init…）⇒ 测试会偶发失败 ✓
  const oldHome = process.env.HOME
  const oldProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  let text = ''
  const session = new TerminalSession({
    shell: 'bash',
    cwd: dir,
    onData: (e) => {
      text += e.data
    },
    onExit: () => {},
    backend: 'pipe',
  })
  // 等 shell 真的空闲了（提示符出来了）再发命令
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000 && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return {
    session,
    dir,
    output: () => text,
    restore: () => {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = oldProfile
    },
  }
}

/**
 * **造一个假编译器**（一个 bash 脚本）——
 * 它认 `-o <out>` ⇒ 把 `<out>.exe` 写成一个会打印标记、退出码 7 的脚本。
 *
 * ⚠️ **`FAKE_COMPILE_FAIL=1` ⇒ 编译失败**（打一行诊断、退出 1）✓
 */
function makeFakeCompiler(dir: string): string {
  const path = join(dir, 'fake-compiler.sh')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-o" ]; then out="$a"; fi',
      '  prev="$a"',
      'done',
      'if [ -n "$FAKE_COMPILE_FAIL" ]; then',
      // ⚠️ **诊断长得跟真编译器一样**（`file:line:col: error: msg`）✓
      '  echo "C:\\\\proj\\\\main.jhyy:3:5: error: fake compile error" >&2',
      '  exit 1',
      'fi',
      `printf '#!/bin/sh\\necho ${PROGRAM_MARKER}\\nexit 7\\n' > "$out.exe"`,
      `echo ${COMPILE_MARKER}`,
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(path, 0o755)
  return path
}

/**
 * **等 shell 回到提示符**（`idle === true`）。
 *
 * ⚠️ **不能一跑完就断言** ——
 *   bash 的集成脚本在提示符那里发 `D;<code>`（命令跑完了）**和** `A`（提示符开始）
 *   ⇒ ⇒ 我们等的是 `D;` ⇒ **提示符那一下还在路上** ⇒ 得等一下 ✓
 */
async function waitIdle(session: TerminalSession, timeoutMs = 5_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return session.shellState.idle === true
}

/** 跑一次「运行」的参数（路径都指到临时目录里）。 */
function runOpts(session: TerminalSession, dir: string, compiler: string) {
  return {
    kind: 'run' as const,
    session,
    shell: 'bash' as TerminalShell,
    compiler,
    src: join(dir, 'main.jhyy'),
    outBase: join(dir, 'out'),
    workDir: dir,
    runDir: dir,
  }
}

describe('在「当前那个活着的终端」里跑', () => {
  beforeEach(() => {
    delete process.env.FAKE_COMPILE_FAIL
  })
  afterEach(() => {
    delete process.env.FAKE_COMPILE_FAIL
  })

  it('⚠️⚠️ **跑在当前终端里 ⇒ 可见的终端页签不跳**（用户报过「跳到别的终端」）', async () => {
    const { session, dir, restore } = await makeBash()
    const reg = new TerminalRegistry('bash', {
      onData: () => {},
      onExit: () => {},
      onState: () => {},
      onListChanged: () => {},
    })
    try {
      // ⚠️ **先建一个终端**（它就是「当前那个」）✓
      const first = reg.create(dir)
      const activeBefore = reg.activeTerminalId
      expect(activeBefore).toBe(first.id)

      const compiler = makeFakeCompiler(dir)
      const live = await runInLiveShell(runOpts(first, dir, compiler))

      expect(live.ok).toBe(true)
      expect(live.fallback).toBeUndefined()
      // ⭐ **当前终端没变** ⇒ 渲染进程不会跳页签 ✓
      expect(reg.activeTerminalId).toBe(activeBefore)
      // ⭐ **正常路径下一个一次性终端都不创建** ⇒ 终端列表保持干净 ✓
      expect(reg.list()).toHaveLength(1)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️⚠️ **跑完终端还活着**（shell 还在、提示符回来了）—— 用户报过「跑完就死了」', async () => {
    const { session, dir, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      const live = await runInLiveShell(runOpts(session, dir, compiler))

      expect(live.ok).toBe(true)
      // ⚠️ **终端还活着** ⇒ pty 没死 ✓
      expect(session.running).toBe(true)
      // ⚠️ **提示符回来了** ⇒ shell 空闲了 ✓
      expect(await waitIdle(session)).toBe(true)
      // ⚠️ **程序真的跑了**（标记在输出里）✓
      expect(live.programText).toContain(PROGRAM_MARKER)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **跑完还能接着用**（终端不是死的）', async () => {
    const { session, dir, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      await runInLiveShell(runOpts(session, dir, compiler))
      // ⚠️ **再敲一条命令** ⇒ 要成功 ✓
      const after = await session.runCommand('echo STILL_ALIVE', { match: 'STILL_ALIVE' })
      expect(after.exitCode).toBe(0)
      expect(after.output).toContain('STILL_ALIVE')
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **退出码是程序自己的**（7，不是编译器的）', async () => {
    const { session, dir, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      const live = await runInLiveShell(runOpts(session, dir, compiler))
      expect(live.ran).toBe(true)
      expect(live.programExitCode).toBe(7)
      expect(live.compileExitCode).toBe(0)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **编译失败 ⇒ 程序不跑**', async () => {
    // ⚠️ **环境变量要在起 shell 之前设** —— pty 的 env 是**起进程那一刻**抓的 ✓
    process.env.FAKE_COMPILE_FAIL = '1'
    const { session, dir, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      const live = await runInLiveShell(runOpts(session, dir, compiler))

      expect(live.ran).toBe(false)
      expect(live.compileExitCode).not.toBe(0)
      expect(live.programText).not.toContain(PROGRAM_MARKER)
      // ⚠️ **诊断能从编译输出里解析出来** ✓
      const { diagnostics } = parseDiagnostics(live.compileText)
      expect(diagnostics.some((d) => d.severity === 'error')).toBe(true)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **终端正忙 ⇒ 一个字都不写进去** ⇒ 退回老路（不打扰用户）', async () => {
    const { session, dir, output, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      // ⚠️ **用户自己敲了一条命令**（还没跑完）⇒ 终端「忙」✓
      session.write('sleep 5\n')
      // 等 shell 真的开始跑它
      await new Promise((r) => setTimeout(r, 300))

      const before = output().length
      const live = await runInLiveShell(runOpts(session, dir, compiler))

      expect(live.ok).toBe(false)
      expect(live.fallback).toBe('busy')
      // ⭐ **终端里一个字都没多**（我们的命令没进去）✓
      expect(output().length).toBe(before)
      expect(output()).not.toContain(compiler)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **用户敲了半截命令 ⇒ 管道版清不掉 ⇒ 退回老路**（不把他的半截命令搞坏）', async () => {
    const { session, dir, output, restore } = await makeBash()
    try {
      const compiler = makeFakeCompiler(dir)
      // ⚠️ **敲了半截，不回车** ⇒ `pendingInput` = true ✓
      session.write('half-typed-command')
      await new Promise((r) => setTimeout(r, 200))

      const before = output().length
      const live = await runInLiveShell(runOpts(session, dir, compiler))

      expect(live.ok).toBe(false)
      expect(live.fallback).toBe('pending-input')
      // ⭐ **一个字都没写进去** ⇒ 他的半截命令没被我们的命令污染 ✓
      expect(output().length).toBe(before)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('⚠️ **超时不发 Ctrl+C**（不打断用户自己的命令）', async () => {
    const { session, output, restore } = await makeBash()
    try {
      // ⚠️ **匹配对不上 ⇒ 我们的命令压根没开始** ⇒ 超时了也不能 Ctrl+C ✓
      const run = await session.runCommand('sleep 30', {
        match: '完全对不上的名字',
        timeoutMs: 800,
      })
      expect(run.timedOut).toBe(true)
      expect(run.exitCode).toBe(null)
      // ⚠️ **终端里没有 `^C`** ⇒ 说明没打断任何东西 ✓
      expect(output()).not.toContain('^C')
    } finally {
      await session.kill()
      restore()
    }
  })
})
