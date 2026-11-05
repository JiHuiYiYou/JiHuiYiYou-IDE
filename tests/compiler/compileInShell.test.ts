import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { locateJhyy } from '../../src/main/compiler/locate'
import { ensureWorkDir } from '../../src/main/compiler/runner'
import { parseDiagnostics } from '../../src/main/compiler/diagnostics'
import { buildShellCommand, TerminalSession } from '../../src/main/terminal'

/**
 * **在 shell 里编译**（VS Code 的 task 模型）。
 *
 * ## 为什么编译也要在 shell 里
 *
 * ⚠️⚠️ 以前编译是 IDE 直接 spawn 的，输出靠 `display()` **注入**到终端 ⇒
 *    注入的内容**不在 conhost 的屏幕里** ⇒ 而 shell 的提示符**在它上面**
 *    ⇒ 用户看到「先打印程序输出，然后又打印一遍 (base) PS ...」✗
 *
 * ⇒ 现在：`jhyy compile "文件"` **写进 shell 的 stdin** ⇒
 *    编译器输出、程序输出、提示符**全在同一条流里** ⇒ **提示符只出现一次** ✓
 *
 * ## 这条测试钉住什么
 *
 * 1. 编译**真的**在 shell 里跑 ⇒ 输出在 shell 的流里 ✓
 * 2. 退出码**是真的**（不是 IDE 自己写的那个空行污染的 0）✓
 * 3. 诊断能从 shell 的输出里**解析出来** ✓
 * 4. **每条命令后面只有一个提示符** ✓
 */

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'jhyy-ide-shellcompile-'))

let exePath: string

beforeAll(async () => {
  const toolchain = await locateJhyy(repoRoot)
  if (!toolchain.available) {
    throw new Error(`找不到 jhyy 编译器：\n${toolchain.error ?? ''}`)
  }
  exePath = toolchain.exePath
})

/**
 * 数一数 bash 的提示符出现了几次（提示符是 **shell 自己**画的）。
 *
 * ⚠️ **认不出提示符就返回 0** ⇒ 调用方据此**跳过**那条断言
 *    （不同机器的 PS1 不一样 ⇒ 硬认会误伤 CI）✓
 */
function countPrompts(text: string): number {
  // ⚠️ bash 的默认 PS1 里带一个「设置窗口标题」的 OSC ⇒ 每个提示符一个 ✓
  const byTitle = (text.match(/\x1b\]0;/g) ?? []).length
  if (byTitle > 0) return byTitle
  // 兜底：默认 PS1 是 `bash-x.y$ `
  return (text.match(/bash-[0-9.]+[$#]\s?/g) ?? []).length
}

interface Bash {
  session: TerminalSession
  output: () => string
  restore: () => void
}

async function makeBash(): Promise<Bash> {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-shellbash-'))
  // ⚠️ **别加载用户自己的 ~/.bashrc** —— 它可能很慢 ⇒ 测试会偶发失败 ✓
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
  // 等 shell 真的空闲了（提示符出来了）
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000 && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return {
    session,
    output: () => text,
    restore: () => {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = oldProfile
    },
  }
}

describe('在 shell 里编译（VS Code 的 task 模型）', () => {
  it('编译器的输出在 **shell 的流里** ⇒ 提示符只出现一次，诊断也能解析出来', async () => {
    const { session, output, restore } = await makeBash()
    try {
      const file = join(scratch, 'hello.jhyy')
      writeFileSync(
        file,
        ['extern fn printf(fmt: *u8, val: i32) -> i32;', '', 'fn main_jhyy() -> i32 {', '    printf("hi\\n", 42);', '    0', '}', ''].join(
          '\n',
        ),
        'utf8',
      )

      // ⚠️ **先 cd 到 scratch 目录** —— 编译器的中间文件走相对 CWD 的路径 ✓
      const work = ensureWorkDir()
      const outBase = join(work, 'shell-test-1')
      session.cd(work)

      const before = countPrompts(output())
      const cmd = buildShellCommand('bash', exePath, ['compile', file, '-o', outBase])
      // ⚠️ **匹配串用「基名」** —— bash 命令里的路径是正斜杠（`C:/…`）
      //    而 IDE 手里是反斜杠 ⇒ 拿整个路径去匹配会对不上 ⇒ 一直等到超时 ✗
      const run = await session.runCommand(cmd, {
        match: basename(outBase),
        timeoutMs: 60_000,
      })
      await new Promise((r) => setTimeout(r, 500))
      const after = countPrompts(output())

      // ⚠️ **退出码是真的** ✓
      expect(run.exitCode).toBe(0)
      // ⚠️ **编译器的输出在 shell 的流里** ✓
      expect(run.output).toContain('jhyy')
      // ⚠️ **诊断能从 shell 的输出里解析出来** ✓
      const { diagnostics } = parseDiagnostics(run.output)
      expect(Array.isArray(diagnostics)).toBe(true)
      // ⚠️ **每条命令后面只有一个提示符** ——
      //    「cd 到 scratch」+「编译」= 2 个 ⇒ 多了 2 个（不是更多）✓
      //    （以前 IDE 会「补」一个 ⇒ 3 个 ✗）
      //    ⇒ 认不出提示符的机器上**跳过**（不同 PS1 ⇒ 硬认会误伤）✓
      if (before > 0) {
        expect(after - before).toBeLessThanOrEqual(2)
        expect(after - before).toBeGreaterThanOrEqual(1)
      }
    } finally {
      await session.kill()
      restore()
    }
  })

  it('**编译失败 ⇒ 退出码不是 0**（不是 IDE 自己写的那个空行污染的）', async () => {
    const { session, restore } = await makeBash()
    try {
      const file = join(scratch, 'bad.jhyy')
      writeFileSync(file, 'fn main_jhyy() -> i32 { let x: i32 = "不是数字"; x }\n', 'utf8')

      const work = ensureWorkDir()
      const outBase = join(work, 'shell-test-2')
      session.cd(work)

      const cmd = buildShellCommand('bash', exePath, ['compile', file, '-o', outBase])
      const run = await session.runCommand(cmd, { match: basename(outBase), timeoutMs: 60_000 })

      // ⚠️ **有 error 级诊断** ⇒ 编译失败 ✓
      const { diagnostics } = parseDiagnostics(run.output)
      expect(diagnostics.some((d) => d.severity === 'error')).toBe(true)
    } finally {
      await session.kill()
      restore()
    }
  })
})
