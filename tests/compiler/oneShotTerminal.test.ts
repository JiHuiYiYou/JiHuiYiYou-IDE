import { describe, expect, it } from 'vitest'
import { buildCommandChain, shellQuote } from '../../src/main/terminal'
import { TerminalRegistry } from '../../src/main/terminalRegistry'
import type { TerminalShell } from '@shared/terminal'

/**
 * **一次性终端**（VS Code 的任务终端模型）。
 *
 * ⚠️⚠️ **命令 = shell 的启动参数**（`bash -c "…"` / `powershell -Command "…"`）
 *   ⇒ shell 跑完就退出 ⇒
 *   ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
 *   ⇒ ⇒ **不用等 shell 集成**、**不依赖 OSC 633** ⇒ 集成挂了也能跑 ✓
 *
 * ⇒ 这就是「一个终端都没有时点运行」现在走的路 ✓
 */

describe('命令链的拼接', () => {
  it('bash：用 `&&` 串起来（上一步失败就不跑下一步）', () => {
    const cmd = buildCommandChain('bash', [
      { command: "'/jhyy.exe' compile 'a.jhyy'", cwd: '/work' },
      { command: "'/work/a.exe'", cwd: '/proj' },
    ])
    expect(cmd).toContain('&&')
    expect(cmd).toContain("cd '/work'")
    expect(cmd).toContain("cd '/proj'")
  })

  it('powershell：**5.1 没有 `&&`** ⇒ 用嵌套 if', () => {
    const cmd = buildCommandChain('powershell', [
      { command: "& 'jhyy.exe' compile 'a.jhyy'", cwd: 'C:\\work' },
      { command: "& 'C:\\work\\a.exe'", cwd: 'C:\\proj' },
    ])
    // ⚠️ PowerShell 5.1（Windows 默认的 powershell.exe）**没有 `&&`** ✗
    expect(cmd).not.toContain('&&')
    expect(cmd).toContain('if ($LASTEXITCODE -eq 0)')
    expect(cmd).toContain("Set-Location -LiteralPath 'C:\\work'")
  })

  it('引号按 shell 的规矩来', () => {
    expect(shellQuote('powershell', "a'b")).toBe("'a''b'")
    expect(shellQuote('cmd', 'a"b')).toBe('"a""b"')
    expect(shellQuote('bash', "a'b")).toBe("'a'\\''b'")
  })
})

describe('一次性终端', () => {
  const shell = 'bash' as TerminalShell

  function makeRegistry(): TerminalRegistry {
    return new TerminalRegistry(shell, {
      onData: () => {},
      onExit: () => {},
      onState: () => {},
      onListChanged: () => {},
    })
  }

  it('**跑完 ⇒ 终端自己退出 ⇒ 退出码就是命令的退出码**', async () => {
    const reg = makeRegistry()
    const term = reg.create(process.cwd(), {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 42'",
      initialText: '',
    })
    // ⚠️ **判完成 = 等终端退出**（不是等 OSC 633 的 `D;<code>`）✓
    const exitCode = await term.exited
    expect(exitCode).toBe(42)
  })

  it('**一次性终端跑完 ⇒ 留在列表里**（VS Code 的 task 终端：输出能看）', async () => {
    const reg = makeRegistry()
    const term = reg.create(process.cwd(), {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 0'",
      initialText: '',
      oneShot: true,
    })
    expect(reg.list()).toHaveLength(1)
    await term.exited
    // ⚠️ **跑完不关** ⇒ 输出还能看 ⇒ 下次跑复用它 ✓
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0].id).toBe(term.id)
  })

  it('**普通的交互终端退出 ⇒ 从列表里去掉**', async () => {
    const reg = makeRegistry()
    const term = reg.create(process.cwd(), {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 0'",
      initialText: '',
    })
    expect(reg.list()).toHaveLength(1)
    await term.exited
    expect(reg.list()).toHaveLength(0)
    expect(reg.activeTerminalId).toBeNull()
  })

  it('**下次跑复用同一个终端**（VS Code 的 `reuseTerminal`：把 shell 重启一遍）', async () => {
    const reg = makeRegistry()
    const first = reg.runTerminal('run', {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 3'",
      cwd: process.cwd(),
    })
    expect(await first.exited).toBe(3)
    expect(reg.list()).toHaveLength(1)

    // ⚠️ **再跑一次 ⇒ 同一个终端（不是新开一个）** ✓
    const second = reg.runTerminal('run', {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 7'",
      cwd: process.cwd(),
    })
    expect(second.id).toBe(first.id)
    expect(reg.list()).toHaveLength(1)
    // ⚠️ **shell 被重启了 ⇒ 是一轮新的 ⇒ 退出码也是新的** ✓
    expect(await second.exited).toBe(7)
  })

  it('**「检查」和「运行」各用一个终端**（互不冲掉对方的输出）', async () => {
    const reg = makeRegistry()
    const run = reg.runTerminal('run', {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 0'",
      cwd: process.cwd(),
    })
    const check = reg.runTerminal('check', {
      shell,
      shellCommand: "'/bin/sh' -c 'exit 0'",
      cwd: process.cwd(),
    })
    expect(run.id).not.toBe(check.id)
    await Promise.all([run.exited, check.exited])
    expect(reg.list()).toHaveLength(2)
  })

  it('**输出被攒下来**（诊断和程序输出都在这条流里）', async () => {
    const reg = makeRegistry()
    const term = reg.create(process.cwd(), {
      shell,
      shellCommand: "'/bin/sh' -c 'echo hello-from-one-shot'",
      initialText: '',
    })
    await term.exited
    expect(term.capturedOutput).toContain('hello-from-one-shot')
  })

  it('**「初始文字」排在 shell 的输出前面**（用户先看到跑的是哪条命令）', async () => {
    const chunks: string[] = []
    const reg2 = new TerminalRegistry(shell, {
      onData: (e) => chunks.push(e.data),
      onExit: () => {},
      onState: () => {},
      onListChanged: () => {},
    })
    const term = reg2.create(process.cwd(), {
      shell,
      shellCommand: "'/bin/sh' -c 'echo after-the-initial-text'",
      initialText: '> the-command-line\r\n',
    })
    await term.exited
    const all = chunks.join('')
    expect(all.indexOf('> the-command-line')).toBeGreaterThanOrEqual(0)
    expect(all.indexOf('> the-command-line')).toBeLessThan(all.indexOf('after-the-initial-text'))
  })
})
