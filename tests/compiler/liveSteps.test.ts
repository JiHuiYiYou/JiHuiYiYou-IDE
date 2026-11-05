import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'
import { buildLiveSteps, cdCommandLine } from '../../src/main/terminal'
import type { TerminalShell } from '@shared/terminal'

/**
 * **「运行」/「检查」在活 shell 里的命令序列**（纯函数，最快的测试）。
 *
 * ## 这些断言钉住的是什么
 *
 * ⚠️⚠️ **每条命令必须是「一条简单命令」** ——
 *   bash 的 DEBUG trap（它报「这条命令是什么」，OSC 633 的 `E;`）
 *   **一行只报第一条**（实测 `a && b && c` ⇒ 只报 `E;a`）⇒
 *   ⇒ 一行里塞 `&&` / `;` / 管道 ⇒ shell 报的 `E;` 里**没有**我们的 match
 *   ⇒ **永远匹配不上** ⇒ 「运行」永远挂着 ✗
 *
 * ⚠️⚠️ **bash 不能带 `&`** —— bash 的 `&` 是**后台算符** ⇒
 *   编译会跑到后台 ⇒ shell 立刻回提示符 ⇒ 退出码是假的、
 *   产物还没生成就去跑 ⇒ **必错** ✗✗
 *   （PowerShell **必须**带 `&` —— `'C:\x.exe'` 是字符串不是命令 ⇒ 压根不执行 ✗）
 *
 * ⚠️ **每一步的 match 必须在自己的 command 里** —— 不然认不出是哪条跑完了 ✗
 * ⚠️ **编译步的 match 和运行步的 match 不能互相包含** ——
 *   不带 `.exe` 的话编译步的（`ide-run-1-0`）是运行步的（`ide-run-1-0.exe`）的**子串**
 *   ⇒ 用户插命令时会张冠李戴 ✗
 */

const COMPILER = 'C:\\tools\\jhyy.exe'
const SRC = 'C:\\proj\\main.jhyy'
const OUT = 'C:\\tmp\\jhyy-ide-work\\ide-run-1700000000-0'
const WORK = 'C:\\tmp\\jhyy-ide-work'
const RUN_DIR = 'C:\\proj'

function steps(shell: TerminalShell, kind: 'run' | 'check' = 'run', currentCwd: string | null = null) {
  return buildLiveSteps(shell, {
    kind,
    compiler: COMPILER,
    src: SRC,
    outBase: OUT,
    workDir: WORK,
    runDir: RUN_DIR,
    currentCwd,
    ...(kind === 'check' ? { returnCwd: currentCwd } : {}),
  })
}

describe('每一步都是「一条简单命令」', () => {
  it('bash：每一步都不含 `&&` / `;` / `|`', () => {
    for (const s of steps('bash')) {
      expect(s.command).not.toMatch(/&&/)
      expect(s.command).not.toMatch(/;/)
      expect(s.command).not.toMatch(/\|/)
    }
  })

  it('powershell：每一步都不含 `&&` / `;` / `|`', () => {
    for (const s of steps('powershell')) {
      expect(s.command).not.toMatch(/&&/)
      expect(s.command).not.toMatch(/;/)
      expect(s.command).not.toMatch(/\|/)
    }
  })

  it('⚠️⚠️ **bash 的命令里没有 `&`**（bash 的 `&` 是后台算符 ⇒ 编译会跑到后台）', () => {
    for (const s of steps('bash')) {
      expect(s.command).not.toMatch(/&\s/)
      // ⚠️ **也不能以 `&` 开头**（那是后台算符）
      expect(s.command.trimStart().startsWith('&')).toBe(false)
    }
  })

  it('⚠️ **PowerShell 的命令带调用运算符 `&`**（不带 ⇒ 路径只是字符串 ⇒ 压根不执行）', () => {
    const compile = steps('powershell').find((s) => s.role === 'compile')
    expect(compile).toBeDefined()
    expect(compile?.command.startsWith('& ')).toBe(true)
  })
})

describe('匹配串（match）', () => {
  it('每个 match 都出现在自己的 command 里', () => {
    for (const s of steps('powershell')) {
      expect(s.command).toContain(s.match)
    }
  })

  it('⚠️ **编译步的命令行里不含运行步的 match**（否则认错命令）', () => {
    const list = steps('powershell')
    const compile = list.find((s) => s.role === 'compile')
    const run = list.find((s) => s.role === 'run')
    expect(compile).toBeDefined()
    expect(run).toBeDefined()
    // ⚠️ 编译步的 match 用了 basename（路径的斜杠方向两边不一样 ⇒ 不能用整条路径）
    expect(compile?.match).toBe(basename(OUT))
    // ⚠️ 运行步的**必须带 `.exe`** ⇒ 编译命令（`-o '<out>'`，**没有 .exe**）
    //    里不会出现运行步的 match ⇒ 两步不会互相认错 ✓
    expect(run?.match).toBe(`${basename(OUT)}.exe`)
    expect(compile?.command).not.toContain(run?.match ?? 'x')
  })
})

describe('超时', () => {
  it('⚠️ **运行程序那一步没有超时**（CLAUDE.md 铁律：别把长时间运行的程序杀掉）', () => {
    const run = steps('powershell').find((s) => s.role === 'run')
    expect(run?.timeoutMs).toBe(0)
  })

  it('编译那一步**有**超时（要链 gcc ⇒ 可能慢）', () => {
    const compile = steps('powershell').find((s) => s.role === 'compile')
    expect(compile?.timeoutMs).toBeGreaterThan(0)
  })

  it('⚠️ **只有编译那一步允许超时发 Ctrl+C**（那是**我们自己的**编译器）', () => {
    for (const s of steps('powershell')) {
      if (s.role === 'compile') expect(s.interruptOnTimeout).toBe(true)
      else expect(s.interruptOnTimeout).toBe(false)
    }
  })
})

describe('cd 那几步', () => {
  it('⚠️ **编译必须在 scratch 目录里跑**（编译器的临时文件走相对 CWD 的路径）', () => {
    const list = steps('powershell')
    const first = list[0]
    expect(first.role).toBe('cd')
    expect(first.command).toContain(WORK)
  })

  it('⚠️ **目录已经对上了 ⇒ 不发多余的 cd**', () => {
    const list = steps('powershell', 'run', WORK)
    expect(list.filter((s) => s.role === 'cd')).toHaveLength(1)
    expect(list.filter((s) => s.role === 'cd')[0].command).toContain(RUN_DIR)
  })

  it('⚠️ **「检查」跑完要 cd 回原目录**（不然 shell 永远停在 scratch 目录）', () => {
    const list = steps('powershell', 'check', RUN_DIR)
    const last = list[list.length - 1]
    expect(last.role).toBe('cd')
    expect(last.command).toContain(RUN_DIR)
  })

  it('⚠️ **「运行」的最后一步是跑产物**（shell 停在源文件目录 ⇒ 程序的相对路径才对）', () => {
    const list = steps('powershell', 'run', RUN_DIR)
    const last = list[list.length - 1]
    expect(last.role).toBe('run')
  })
})

describe('cdCommandLine', () => {
  it('bash：正斜杠 + 匹配串就是命令里写的那个路径', () => {
    const c = cdCommandLine('bash', 'C:\\Users\\me\\proj')
    expect(c.command).toBe('cd "C:/Users/me/proj"')
    expect(c.command).toContain(c.match)
    expect(c.match).toBe('C:/Users/me/proj')
  })

  it('powershell：反斜杠 + 单引号', () => {
    const c = cdCommandLine('powershell', "C:\\Users\\me's proj")
    expect(c.command).toBe("Set-Location -LiteralPath 'C:\\Users\\me''s proj'")
    expect(c.command).toContain(c.match)
  })
})
