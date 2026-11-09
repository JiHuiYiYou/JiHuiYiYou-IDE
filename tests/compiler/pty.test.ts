import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutputBatcher } from '../../src/main/pty'
import { existingDir } from '../../src/main/ptyNode'
import { shellCdCommand, PipePtySession } from '../../src/main/ptyPipe'
import { mergeShellEnv, parseNulEnv, parseSetEnv } from '../../src/main/shellEnv'
import { buildSubprocessEnv } from '../../src/main/compiler/env'

/**
 * 终端后端的**接口层**（`src/main/pty.ts`）+ **登录 shell 的环境**
 * （`src/main/shellEnv.ts`）。
 *
 * 这两样都是**与后端无关**的部分 —— 换成 ConPTY / node-pty 时它们照旧能用。
 */
describe('登录 shell 的环境变量', () => {
  it('`env -0`（NUL 分隔）能解析出来', () => {
    const raw = 'PATH=/usr/bin\x00HOME=/home/liuzhen\x00WEIRD=a=b=c\x00'
    const vars = parseNulEnv(raw)
    expect(vars.PATH).toBe('/usr/bin')
    expect(vars.HOME).toBe('/home/liuzhen')
    // ⚠️ 值里有 '=' 不能被截断
    expect(vars.WEIRD).toBe('a=b=c')
  })

  it('`cmd /c set`（一行一个 KEY=VALUE）能解析出来', () => {
    const raw = 'Path=C:\\Windows\r\nSystemRoot=C:\\Windows\r\n\r\n'
    const vars = parseSetEnv(raw)
    expect(vars.Path).toBe('C:\\Windows')
    expect(vars.SystemRoot).toBe('C:\\Windows')
    // 空行跳过
    expect(Object.keys(vars)).toHaveLength(2)
  })

  it('登录 shell 的变量**盖在**继承来的上面（用户的 nvm/rbenv 路径要活下来）', () => {
    const base = { PATH: 'C:\\Windows', HOME: 'C:\\Users\\x' }
    const merged = mergeShellEnv(base, {
      PATH: '/home/x/.nvm/versions/node/v20/bin:/usr/bin',
      NVM_DIR: '/home/x/.nvm',
    })
    expect(merged.PATH).toBe('/home/x/.nvm/versions/node/v20/bin:/usr/bin')
    expect(merged.NVM_DIR).toBe('/home/x/.nvm')
    // ⚠️ 继承来的、shell 没提到的变量**不能丢**
    expect(merged.HOME).toBe('C:\\Users\\x')
  })

  it('没有登录 shell 的环境时，原样返回', () => {
    const base = { PATH: 'C:\\Windows' }
    expect(mergeShellEnv(base, null)).toEqual(base)
  })

  it('**PATH 的键名大小写不一样 ⇒ 不能两份并存**（不然后面会挑错那一份）', () => {
    // ⚠️⚠️ Windows 上 `process.env` 里常见的是 `Path`，导出来的是 `PATH`
    //   ⇒ 两份并存 ⇒ `buildSubprocessEnv` 挑「第一个」⇒
    //   ⇒ **挑到继承来的那份** ⇒ **用户 PATH 白导了** ✗
    const base = { Path: 'C:\\Windows' }
    const merged = mergeShellEnv(base, { PATH: 'C:\\conda;C:\\Windows' })
    const pathKeys = Object.keys(merged).filter((k) => k.toUpperCase() === 'PATH')
    expect(pathKeys).toHaveLength(1)
    expect(merged[pathKeys[0]]).toBe('C:\\conda;C:\\Windows')
  })
})

describe('子进程的环境变量', () => {
  it('**PATH 只「追加」，绝不「替换」**（继承来的一个字都不能丢）', () => {
    const env = buildSubprocessEnv({ PATH: 'C:\\my\\tools;C:\\Windows' })
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string
    expect(env[pathKey]).toContain('C:\\my\\tools')
    expect(env[pathKey]).toContain('C:\\Windows')
    // ⚠️ **ucrt64 的 gcc 要排最前**（挑错 gcc 版本会 PE 链接失败）✓
    expect(env[pathKey]?.toLowerCase().startsWith('c:\\msys64\\ucrt64\\bin')).toBe(true)
  })

  it('**`extra` 里的 PATH 要赢过继承来的那份**（哪怕键名大小写不同）', () => {
    // ⚠️ `extra` 常常是 `{ ...base, ...别的 }` ⇒ 两份 PATH 变体并存时
    //   ⇒ **后 spread 的那份才是「要赢的」** ⇒ 取最后一个 ✓
    const env = buildSubprocessEnv({ Path: 'C:\\inherited', PATH: 'C:\\wanted' })
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string
    expect(env[pathKey]).toContain('C:\\wanted')
    expect(env[pathKey]).not.toContain('C:\\inherited')
  })

  it('**MSYS 风格的 PATH（`:` 分隔、`/c/…`）也得能用**', () => {
    // ⚠️ MSYS2 的 PATH 用 `:` 分隔、目录写成 `/c/Users/…`（**没有盘符**）⇒
    //   按 `;` 切完还是**一整条** ⇒ 子进程**一个目录都认不出来**
    //   ⇒ 用户的工具全找不到 ✗
    // ⇒ ⇒ 得**追加**一份 Windows 风格的（**绝不替换** —— W-156 的教训）✓
    const env = buildSubprocessEnv({ PATH: '/c/my/tools:/c/Windows' })
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string
    expect(env[pathKey]).toContain('C:\\my\\tools')
    expect(env[pathKey]).toContain('C:\\Windows')
    // ⚠️ **继承来的那份一个字都不能丢** ✓
    expect(env[pathKey]).toContain('/c/my/tools')
  })
})

describe('输出攒批（流控）', () => {
  it('碎片先攒着，到点了一次性发出去', async () => {
    const batches: string[] = []
    const batcher = new OutputBatcher((t) => batches.push(t), 10)
    batcher.push('PRO')
    batcher.push('MPT: ')
    expect(batches, '还没到时间 ⇒ 不该发').toEqual([])
    await new Promise((r) => setTimeout(r, 30))
    expect(batches.join('')).toBe('PROMPT: ')
  })

  it('flushNow 立刻把攒着的发出去（进程结束时用）', () => {
    const batches: string[] = []
    const batcher = new OutputBatcher((t) => batches.push(t), 10_000)
    batcher.push('abc')
    batcher.flushNow()
    expect(batches.join('')).toBe('abc')
  })

  it('dispose 把攒着的丢掉（进程被杀了，别发半截）', () => {
    const batches: string[] = []
    const batcher = new OutputBatcher((t) => batches.push(t), 10_000)
    batcher.push('abc')
    batcher.dispose()
    batcher.flushNow()
    expect(batches).toEqual([])
  })

  it('空串不触发任何东西', async () => {
    const batches: string[] = []
    const batcher = new OutputBatcher((t) => batches.push(t), 5)
    batcher.push('')
    await new Promise((r) => setTimeout(r, 20))
    expect(batches).toEqual([])
  })
})

describe('cwd 兜底', () => {
  it('目录不存在时，往上找一个真存在的', () => {
    // ⚠️ cwd 不存在 ⇒ `CreateProcess` 失败 ⇒ node-pty 抛 ⇒ **整个终端退成管道版**
    //    ⇒ 「终端一会真一会假」（用户报过）⇒ 必须在起进程**之前**兜住 ✓
    const got = existingDir('C:/这个目录/不存在/更深')
    expect(existsSync(got)).toBe(true)
    expect(statSync(got).isDirectory()).toBe(true)
  })

  it('目录存在时就用它（别乱换）', () => {
    const here = process.cwd()
    expect(existingDir(here)).toBe(resolve(here))
  })
})

describe('往 shell 发命令的行尾', () => {
  it('**不能是 `\\r\\n`** —— 那是两个回车 ⇒ shell 打两个提示符', () => {
    // 用户报过：「终端有时候会打印一堆空的 [提示符]」
    // ⇒ 根因：IDE 给 shell 的 `cd` 命令用 `\r\n` 结尾 ⇒ readline 收到**两个**
    //    accept-line ⇒ **两个提示符**（中间还夹一个空行）✓
    //    实测：管道版和真控制台版都是 `\r\n` ⇒ 2 个提示符；`\n` / `\r` ⇒ 1 个 ✓
    for (const shell of ['bash', 'cmd', 'powershell'] as const) {
      for (const eol of ['\r', '\n'] as const) {
        const cmd = shellCdCommand(shell, 'C:/work', eol)
        expect(cmd.includes('\r\n'), `${shell} + ${JSON.stringify(eol)}`).toBe(false)
        // 行尾只有一个
        const tail = cmd.slice(-2)
        expect(tail.endsWith('\r') || tail.endsWith('\n')).toBe(true)
        expect(tail === '\r\n').toBe(false)
      }
    }
  })

  it('行尾按后端来：管道用 `\\n`、真控制台用 `\\r`', () => {
    expect(shellCdCommand('bash', 'C:/work', '\n').endsWith('\n')).toBe(true)
    expect(shellCdCommand('bash', 'C:/work', '\r').endsWith('\r')).toBe(true)
  })
})

describe('管道后端起不来 ⇒ 也不能留「僵尸终端」', () => {
  it('**spawn 失败 ⇒ 退出回调要被调用**（不然死终端留在列表里）', async () => {
    /*
      ⚠️⚠️ **为什么要有这条** ——
        spawn 失败（ENOENT 之类）时 Node **只发 'error'、不发 'exit'**
        ⇒ 以前只在 'exit' 里通知 ⇒ 上层（终端登记表）**不知道这个终端死了**
        ⇒ 它就**留在列表里**（僵尸标签）⇒ 还是「当前那个」
        ⇒ 下次「运行」看到 `running === false` ⇒ **在旁边再开一个**
        ⇒ 终端标签越点越多 ✗
    */
    const session = new PipePtySession({
      shell: 'cmd',
      cwd: process.cwd(),
      // ⚠️ **一个根本不存在的 exe** ⇒ spawn 失败 ⇒ 走 'error' 那条路
      command: { exe: 'C:/这个程序/根本不存在/jhyy-nope.exe', args: [] },
      cols: 80,
      rows: 24,
    })
    const exits: (number | null)[] = []
    session.onExit((code) => exits.push(code))

    // 等它报「起不来」
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000 && exits.length === 0) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(exits.length).toBe(1)
    expect(session.running).toBe(false)
  })
})
