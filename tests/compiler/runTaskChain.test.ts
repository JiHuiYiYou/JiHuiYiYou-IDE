import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRunCommandChain, TerminalSession } from '../../src/main/terminal'
import { listCandidates, probeJhyy } from '../../src/main/compiler/locate'
import type { TerminalShell } from '@shared/terminal'

/**
 * **「运行」按钮的完整命令链**（VS Code 的任务终端模型）—— 端到端。
 *
 * ## 这条测试钉住的是什么
 *
 * ⚠️⚠️ **以前这条路完全没有测试覆盖** ——
 *   `tests/compiler/compileInShell.test.ts` 走的是**老路**
 *   （`session.cd()` + `session.runCommand()` ⇒ 敲进 shell 的 stdin），
 *   而生产代码早改成「命令 = **shell 的启动参数**」了 ⇒
 *   ⇒ **新路一次都没被真正执行过** ⇒
 *   ⇒ 用户报「点运行按钮根本就没有程序输出了」✗
 *
 * ## 那个 bug 的根因
 *
 * 「跑产物」那一步**以前**是用 `shellQuote(shell, exePath)` 拼的 ——
 * 那只是**引号包起来的字面量** ⇒
 * ⚠️ **PowerShell 里 `'C:\…\prog.exe'` 是「一个字符串」，不是命令** ⇒
 *    解析器直接 `ParserError` ⇒ **程序压根没跑** ⇒ **一点输出都没有** ✗
 * ⚠️ bash 那边侥幸能跑（引号里有 `/` ⇒ bash 当路径执行）⇒
 *    ⇒ **只有 PowerShell 犯这个病** —— 而 **PowerShell 正是默认 shell** ✗
 *
 * ⇒ 现在那一步用 `buildShellCommand(shell, exePath, [])`（它带调用运算符 `&`）✓
 * ⇒ 而且**拼法挪进了 `buildRunCommandChain`** ⇒ **测试跟生产代码用同一个函数** ✓
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
 * **假 HOME** —— 让 PowerShell **别加载用户的 profile**。
 *
 * ⚠️ **不是图快，是图「可复现」** ——
 *   这台机器的 PowerShell profile 要 **9 秒**（conda init 之类）
 *   ⇒ 加载它 ⇒ 每个测试都慢 9 秒 ⇒ 而且**测的是 profile，不是我们的命令链** ✗
 * ⚠️ 用户的 profile 里可能有 `exit`、有 `Set-Location`、有乱七八糟的输出 ⇒
 *   ⇒ 那些东西会**混进终端的输出** ⇒ 断言就不稳了 ✗
 *   ⇒ 所以这里把 `USERPROFILE`/`HOME` 指到一个空目录 ⇒ profile 找不到 ⇒ 不加载 ✓
 *   （跟 `tests/compiler/terminalRun.test.ts` 里 `makeBash` 干的是同一件事 ✓）
 */
let fakeHome = ''
const oldHome = process.env.HOME
const oldProfile = process.env.USERPROFILE

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'jhyy-taskhome-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-taskchain-'))
  mkdirSync(join(dir, 'compiler', 'build', 'obj'), { recursive: true })
  return dir
}

/** 起一个一次性终端（生产代码的形状：`shellCommand` = shell 的启动参数）。 */
function runOneShot(shell: TerminalShell, command: string, cwd: string): TerminalSession {
  return new TerminalSession({
    shell,
    cwd,
    shellCommand: command,
    initialText: `> ${command}\r\n`,
    backend: 'pipe',
    onData: () => {},
    onExit: () => {},
  })
}

describe('「运行」的完整命令链（端到端，真编译器）', () => {
  it('**PowerShell（默认 shell）⇒ 编译 + 跑产物 ⇒ 程序有输出、退出码是程序的**', async () => {
    const compiler = await findCompiler()
    if (!compiler) return // 这台机器没有编译器 ⇒ 跳过

    const work = makeWorkDir()
    const src = join(work, 'prog.jhyy')
    writeFileSync(src, HELLO_PROGRAM, 'utf8')
    const outBase = join(work, 'out')

    // ⚠️ **直接调生产代码那个函数** ⇒ 测试钉的就是生产代码那条路 ✓
    const command = buildRunCommandChain('powershell', {
      compiler,
      src,
      outBase,
      workDir: work,
      runDir: work,
    })
    const session = runOneShot('powershell', command, work)
    try {
      const exitCode = await session.exited
      const text = session.capturedOutput
      // ⚠️⚠️ **核心断言：程序的输出必须在** ✗（以前 PowerShell 下压根没有）
      expect(text).toContain('HELLO_FROM_PROGRAM')
      // ⚠️ **退出码是程序的（7），不是编译器的（0）** ✓
      expect(exitCode).toBe(7)
    } finally {
      await session.kill()
    }
  })

  it('**bash ⇒ 同样跑得起来**（别的 shell 不能跟着 PowerShell 一起坏）', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const work = makeWorkDir()
    const src = join(work, 'prog.jhyy')
    writeFileSync(src, HELLO_PROGRAM, 'utf8')
    const outBase = join(work, 'out')

    const command = buildRunCommandChain('bash', {
      compiler,
      src,
      outBase,
      workDir: work,
      runDir: work,
    })
    const session = runOneShot('bash', command, work)
    try {
      const exitCode = await session.exited
      expect(session.capturedOutput).toContain('HELLO_FROM_PROGRAM')
      expect(exitCode).toBe(7)
    } finally {
      await session.kill()
    }
  })

  it('**编译失败 ⇒ 程序不跑、退出码非 0、也没有程序输出**', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const work = makeWorkDir()
    const src = join(work, 'broken.jhyy')
    writeFileSync(src, BROKEN_PROGRAM, 'utf8')
    const outBase = join(work, 'out')

    const command = buildRunCommandChain('powershell', {
      compiler,
      src,
      outBase,
      workDir: work,
      runDir: work,
    })
    const session = runOneShot('powershell', command, work)
    try {
      const exitCode = await session.exited
      expect(exitCode).not.toBe(0)
      // ⚠️ **编译器的报错要在**（诊断就是从这条流里解析的）✓
      expect(session.capturedOutput).toMatch(/error/i)
      // ⚠️ **程序没跑 ⇒ 它的输出不能有** ✓
      expect(session.capturedOutput).not.toContain('HELLO_FROM_PROGRAM')
    } finally {
      await session.kill()
    }
  })

  it('**命令压根没跑起来 ⇒ 退出码不能是 0**（PowerShell 的 `$LASTEXITCODE` 是 `$null`）', async () => {
    /*
      ⚠️⚠️ **以前会报「成功」** ——
        `powershell -Command "…; exit $LASTEXITCODE"` ⇒ 命令没跑起来时
        `$LASTEXITCODE` **从来没被赋过值**（还是 `$null`）⇒
        ⇒ `exit $null` ⇒ **退出码 0** ⇒
        ⇒ IDE 以为「成功」⇒ 而屏幕上只有一条红色的报错 ⇒ **最坏的一种** ✗
      ⇒ 现在 `$null` ⇒ 退出码 1 ✓
    */
    const work = makeWorkDir()
    // ⚠️ **故意指向一个不存在的编译器** ⇒ 命令压根跑不起来 ✓
    const command = buildRunCommandChain('powershell', {
      compiler: join(work, 'no-such-compiler.exe'),
      src: join(work, 'prog.jhyy'),
      outBase: join(work, 'out'),
      workDir: work,
      runDir: work,
    })
    const session = runOneShot('powershell', command, work)
    try {
      const exitCode = await session.exited
      expect(exitCode).not.toBe(0)
    } finally {
      await session.kill()
    }
  })
})

/**
 * **命令链里的 `cd` 必须用 `&&`，不能用 `;`**。
 *
 * ⚠️⚠️ **以前 cd 后面是 `;`** ⇒ bash 里 `;` 和 `&&` **优先级相同、从左往右** ⇒
 *   `cd A; 编译 && cd B; 跑产物` 实际是：
 *     ① cd A     （总是）
 *     ② 编译     （总是！）
 *     ③ && cd B  （编译成功才跑）
 *     ④ ; 跑产物 （**总是**！）✗✗
 *   ⇒ **编译失败产物照样跑**，而且跑在**错的目录**里 ✗
 *
 * ⇒ cmd.exe 更糟：它**根本不支持 `;`** ⇒ 整条命令塌成一条 `cd`
 *   ⇒ **编译器和程序都跑不了** ✗
 */
describe('命令链的连接符', () => {
  const OPTS = {
    compiler: 'C:\\jh\\jhyy.exe',
    src: 'C:\\work\\a.jhyy',
    outBase: 'C:\\work\\out',
    workDir: 'C:\\work',
    runDir: 'C:\\run',
  }

  it('**bash：cd 后面是 `&&` 不是 `;`**', () => {
    const cmd = buildRunCommandChain('bash', OPTS)
    expect(cmd).toContain('&&')
    // ⚠️ **不能有 `;`** —— 它会把 `&&` 链拆断（`;` 和 `&&` 同优先级）
    expect(cmd).not.toContain(';')
  })

  it('**cmd：同样用 `&&`**（cmd 压根不支持 `;`）', () => {
    const cmd = buildRunCommandChain('cmd', OPTS)
    expect(cmd).toContain('&&')
    expect(cmd).not.toContain(';')
  })

  it('**PowerShell：用嵌套 if**（PS 5.1 没有 `&&`）', () => {
    const cmd = buildRunCommandChain('powershell', OPTS)
    expect(cmd).toContain('if ($LASTEXITCODE -eq 0)')
    expect(cmd).not.toContain('&&')
  })

  it('**bash：编译失败 ⇒ 产物不跑**（真跑一遍 bash）', async () => {
    // ⚠️ 用**真 bash** 验 ⇒ 光看字符串不够（`;` 和 `&&` 的差别只有真跑才知道）✓
    const cmd = `cd /tmp && false && echo SHOULD_NOT_PRINT`
    const session = runOneShot('bash', cmd, '/tmp')
    try {
      const exitCode = await session.exited
      expect(exitCode).not.toBe(0)
      expect(session.capturedOutput).not.toContain('SHOULD_NOT_PRINT')
    } finally {
      await session.kill()
    }
  })
})
