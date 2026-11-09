import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASH_INTEGRATION_SCRIPT,
  integrationScriptPath,
  shellCommandArgs,
  withShellIntegration,
} from '../../src/main/shellIntegration'
import { TerminalSession } from '../../src/main/terminal'
import {
  ShellIntegrationParser,
  normalizeCwd,
  unescapeShellValue,
  type ShellIntegrationEvent,
} from '../../src/shared/shellIntegration'
import type { ShellState } from '../../src/shared/terminal'

/**
 * **Shell 集成**（OSC 633）的测试。
 *
 * ⚠️ **真跑 bash** —— 光测解析器不够：脚本本身写错了（比如 DEBUG trap
 *    装的位置不对、PROMPT_COMMAND 拿不到 `$?`）解析器也测不出来。
 *    ⇒ 这里真的起一个 bash、真的敲命令、真的看序列 ✓。
 */

function bashPath(): string | null {
  const candidates = [
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\ucrt64\\bin\\bash.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const bash = bashPath()

/** 起一个带集成的 bash，把输出喂给解析器。 */
interface BashSession {
  /** 敲一条命令（回车结尾） */
  send(cmd: string): void
  /** 在 shell 里跑一条命令，把它的**输出**抓回来 */
  capture(cmd: string, timeoutMs?: number): Promise<string>
  /** 等到某个条件满足（或者超时） */
  waitFor(pred: (ev: ShellIntegrationEvent[]) => boolean, timeoutMs?: number): Promise<void>
  /** 已经收到的所有事件 */
  events: ShellIntegrationEvent[]
  /** 已经收到的、剥掉 OSC 之后的纯文本 */
  text: string
  kill(): void
}

function startBash(): BashSession {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-si-'))
  const script = join(dir, 'si.sh')
  writeFileSync(script, BASH_INTEGRATION_SCRIPT, 'utf8')

  const args = withShellIntegration('bash', ['-i'])
  const child = spawn(bash as string, args, {
    cwd: dir,
    env: {
      ...process.env,
      // ⚠️ **别加载用户的 ~/.bashrc** —— 它可能打印东西、可能改 PATH
      //    （测试要的是「干净」的 shell）⇒ HOME 指到一个空目录 ✓
      HOME: dir,
      USERPROFILE: dir,
      MSYS2_PATH_TYPE: 'inherit',
      // 关掉 MSYS2 的启动横幅
      MSYS2_ARG_CONV_EXCL: '*',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  const parser = new ShellIntegrationParser()
  const events: ShellIntegrationEvent[] = []
  let text = ''

  const onData = (chunk: Buffer): void => {
    const r = parser.push(chunk.toString('utf8'))
    text += r.text
    events.push(...r.events)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const session: BashSession = {
    events,
    get text() {
      return text
    },
    send(cmd: string) {
      child.stdin.write(`${cmd}\n`)
    },
    /**
     * **在 shell 里跑一条命令，把它的输出抓回来**。
     *
     * ⚠️ **用标记包起来** —— 但标记**在回显里也会出现一次**
     *   （bash 会回显我们敲的那一行 ⇒ 标记后面紧跟着 `$(`）⇒
     *   ⇒ **回显的那次要跳过**（它后面是 `$(`，不是值）✓
     */
    async capture(cmd: string, timeoutMs = 15_000) {
      const marker = `__JHY_CAPTURE_${Date.now()}__`
      child.stdin.write(`echo "${marker}$(${cmd})"\n`)
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        let i = text.indexOf(marker)
        while (i >= 0) {
          const rest = text.slice(i + marker.length)
          // ⚠️ **回显的那一次**：后面紧跟着 `$(`（命令还没跑）⇒ 跳过 ✓
          if (!rest.startsWith('$')) {
            const nl = rest.indexOf('\n')
            if (nl >= 0) return rest.slice(0, nl).trim()
          }
          i = text.indexOf(marker, i + 1)
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(
        `抓不到输出：${cmd}\n文本：${JSON.stringify(text.slice(-400))}`,
      )
    },
    async waitFor(pred, timeoutMs = 15_000) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (pred(events)) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(
        `等超时了。收到的事件：${JSON.stringify(events)}\n文本：${JSON.stringify(text.slice(-400))}`,
      )
    },
    kill() {
      child.kill()
    },
  }
  return session
}

describe('shell 集成的协议层', () => {
  it('解析器能认出各种 OSC 633 序列', () => {
    const p = new ShellIntegrationParser()
    const r = p.push(
      '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D;42\x07\x1b]633;P;Cwd=/tmp\x07',
    )
    expect(r.text).toBe('')
    expect(r.events).toEqual([
      { type: 'promptStart' },
      { type: 'promptEnd' },
      { type: 'commandStart' },
      { type: 'commandFinished', exitCode: 42 },
      { type: 'property', key: 'Cwd', value: '/tmp' },
    ])
  })

  it('序列横跨两块也能拼起来（shell 的输出是任意切块的）', () => {
    const p = new ShellIntegrationParser()
    const a = p.push('hello\x1b]633;D;')
    expect(a.text).toBe('hello')
    expect(a.events).toEqual([])
    const b = p.push('7\x07world')
    expect(b.text).toBe('world')
    expect(b.events).toEqual([{ type: 'commandFinished', exitCode: 7 }])
  })

  /**
   * ⚠️ **一块数据正好以 `ESC` 结尾** —— `ESC ]` 的第一个字节到了、`]` 还没到。
   *
   * ⇒ 以前那个 `ESC` 被当成正文冲掉了 ⇒ 下一块以 `]633;…` 开头
   * ⇒ **前缀没了 ⇒ 整条 OSC 633 丢了** ✗
   *
   * ⇒ 后果特别严重：`D;<code>` 永远不来 ⇒ 「命令执行完」永远等不到
   * ⇒ **「运行」会永远挂着**（跑产物那一步故意不设超时）✗
   */
  it('块尾那个孤零零的 ESC 要留着等下一块（不然 OSC 就丢了）', () => {
    const p = new ShellIntegrationParser()
    const a = p.push('hello\x1b')
    expect(a.text, 'ESC 不能被当成正文冲掉').toBe('hello')
    expect(a.events).toEqual([])
    const b = p.push(']633;D;7\x07world')
    expect(b.text).toBe('world')
    expect(b.events, 'OSC 必须被认出来').toEqual([{ type: 'commandFinished', exitCode: 7 }])
  })

  it('不是 633 的 OSC 序列原样放行（改标题那些得让 xterm 自己处理）', () => {
    const p = new ShellIntegrationParser()
    const r = p.push('\x1b]0;my title\x07after')
    expect(r.text).toBe('\x1b]0;my title\x07after')
    expect(r.events).toEqual([])
  })

  it('`D`（没有退出码）⇒ 这一行敲的是空的', () => {
    const p = new ShellIntegrationParser()
    const r = p.push('\x1b]633;D\x07')
    expect(r.events).toEqual([{ type: 'commandFinished', exitCode: null }])
  })

  it('解转义跟 shell 脚本的编码配套', () => {
    expect(unescapeShellValue('a\\x3bb')).toBe('a;b')
    expect(unescapeShellValue('a\\\\b')).toBe('a\\b')
    expect(unescapeShellValue('C:/x/y')).toBe('C:/x/y')
  })

  it('目录归一：斜杠方向、大小写、尾部斜杠都不影响比较', () => {
    expect(normalizeCwd('C:\\Users\\Foo')).toBe(normalizeCwd('c:/users/foo/'))
    expect(normalizeCwd('/home/me')).toBe('/home/me')
  })
})

describe('shell 集成的脚本（真跑 bash）', () => {
  it.skipIf(!bash)('bash 起来之后会报「提示符开始」和当前目录', async () => {
    const s = startBash()
    try {
      await s.waitFor((ev) => ev.some((e) => e.type === 'promptEnd'))
      expect(s.events.some((e) => e.type === 'promptStart')).toBe(true)
      const cwd = s.events.find((e) => e.type === 'property' && e.key === 'Cwd')
      expect(cwd).toBeDefined()
      expect(String((cwd as { value: string }).value)).not.toBe('')
    } finally {
      s.kill()
    }
  })

  it.skipIf(!bash)('跑完一条命令会报退出码', async () => {
    const s = startBash()
    try {
      await s.waitFor((ev) => ev.some((e) => e.type === 'promptEnd'))
      s.send('echo jhyy-marker')
      await s.waitFor((ev) => ev.some((e) => e.type === 'commandFinished'))
      const done = s.events.filter((e) => e.type === 'commandFinished')
      const last = done[done.length - 1]
      expect(last).toEqual({ type: 'commandFinished', exitCode: 0 })
      expect(s.text).toContain('jhyy-marker')
    } finally {
      s.kill()
    }
  })

  it.skipIf(!bash)('命令失败 ⇒ 退出码不是 0', async () => {
    const s = startBash()
    try {
      await s.waitFor((ev) => ev.some((e) => e.type === 'promptEnd'))
      // ⚠️ 不能用 `exit 7` —— 那会把 shell 本身关掉 ⇒ 就没有下一个提示符了
      s.send(`sh -c 'exit 7'`)
      await s.waitFor((ev) => ev.some((e) => e.type === 'commandFinished' && e.exitCode === 7))
      const done = s.events.filter((e) => e.type === 'commandFinished')
      expect(done[done.length - 1]).toEqual({ type: 'commandFinished', exitCode: 7 })
    } finally {
      s.kill()
    }
  })

  it.skipIf(!bash)('空回车 ⇒ 不报退出码（说明「没跑过命令」）', async () => {
    const s = startBash()
    try {
      await s.waitFor((ev) => ev.some((e) => e.type === 'promptEnd'))
      const before = s.events.length
      s.send('')
      await s.waitFor((ev) => ev.slice(before).some((e) => e.type === 'commandFinished'))
      const done = s.events.filter((e) => e.type === 'commandFinished')
      const last = done[done.length - 1]
      expect(last).toEqual({ type: 'commandFinished', exitCode: null })
    } finally {
      s.kill()
    }
  })

  it.skipIf(!bash)('换了目录 ⇒ 报出来的是新目录', async () => {
    const s = startBash()
    try {
      await s.waitFor((ev) => ev.some((e) => e.type === 'promptEnd'))
      const first = s.events.find((e) => e.type === 'property' && e.key === 'Cwd')
      const before = String((first as { value: string }).value)
      s.send('cd /tmp')
      /*
        ⚠️⚠️ **别断言「报出来的路径以 `/tmp` 结尾」** ——
          报出来的是 **Windows 路径**（脚本用 `cygpath -m` 换的）⇒
          它长什么样**取决于这台机器怎么映射 `/tmp`**：
          本地是 `C:/msys64/tmp`，CI 那台是 `C:/Windows` ⇒
          写死 `/tmp` ⇒ **必假红** ✗

        ⇒ ⇒ **问 shell 自己**：它把当前目录报成什么？⇒ 拿那个来比 ✓
          （`__jhyy_cwd` 就是集成脚本里那个函数 ⇒ **同一套逻辑** ✓）
      */
      await s.waitFor((ev) =>
        ev.some(
          (e) =>
            e.type === 'property' &&
            e.key === 'Cwd' &&
            normalizeCwd(String((e as { value: string }).value)) !== normalizeCwd(before),
        ),
      )
      const cwds = s.events
        .filter((e) => e.type === 'property' && e.key === 'Cwd')
        .map((e) => (e as { value: string }).value)
      expect(cwds.length).toBeGreaterThan(1)
      const expected = await s.capture('__jhyy_cwd')
      expect(normalizeCwd(cwds[cwds.length - 1])).toBe(normalizeCwd(expected))
    } finally {
      s.kill()
    }
  })
})

describe('TerminalSession 接上 shell 集成', () => {
  /** 起一个真的终端会话（管道后端 —— 不依赖 node-pty 装没装）。 */
  function makeSession(cwd: string): {
    session: TerminalSession
    shown: () => string
    states: ShellState[]
    waitFor: (p: (s: ShellState) => boolean, ms?: number) => Promise<void>
  } {
    const chunks: string[] = []
    const states: ShellState[] = []
    const session = new TerminalSession({
      shell: 'bash',
      cwd,
      onData: (e) => chunks.push(e.data),
      onExit: () => {},
      onState: (s) => states.push(s),
      backend: 'pipe',
    })
    return {
      session,
      shown: () => chunks.join(''),
      states,
      waitFor: async (p, ms = 15_000) => {
        const start = Date.now()
        while (Date.now() - start < ms) {
          if (p(session.shellState)) return
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(
          `等超时了。状态：${JSON.stringify(session.shellState)}\n` +
            `文本：${JSON.stringify(chunks.join('').slice(-400))}`,
        )
      },
    }
  }

  it.skipIf(!bash)('OSC 序列被抠掉（不该漏到输出面板里），状态被记下来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-si2-'))
    const t = makeSession(dir)
    try {
      await t.waitFor((s) => s.cwd !== null)
      // ⚠️ **OSC 序列一个字都不该出现在显示文本里** ✓
      expect(t.shown()).not.toContain('\x1b]633;')

      t.session.write('echo jhyy-marker\n')
      await t.waitFor((s) => s.exitCode === 0)
      expect(t.shown()).toContain('jhyy-marker')
      // ⚠️ 退出之后 shell 空闲了 ⇒ 「补提示符」这条路才通 ✓
      await t.waitFor((s) => s.idle === true)
    } finally {
      await t.session.kill()
    }
  })

  it.skipIf(!bash)('命令失败 ⇒ 退出码被记下来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-si3-'))
    const t = makeSession(dir)
    try {
      await t.waitFor((s) => s.cwd !== null)
      t.session.write(`sh -c 'exit 7'\n`)
      await t.waitFor((s) => s.exitCode === 7)
    } finally {
      await t.session.kill()
    }
  })

  it.skipIf(!bash)('shell 已经在那个目录 ⇒ 不用再发 cd（不污染历史）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-si4-'))
    const t = makeSession(dir)
    try {
      await t.waitFor((s) => s.cwd !== null)
      const before = t.shown().length
      t.session.cd(dir)
      await new Promise((r) => setTimeout(r, 800))
      // ⚠️ **不该发出 cd** ⇒ 屏幕上不该多出那条命令 ✓
      expect(t.shown().slice(before)).not.toContain('cd ')
    } finally {
      await t.session.kill()
    }
  })
})

describe('PowerShell 的 shell 集成', () => {
  /** Windows 上有 powershell.exe 吗？（路径跟着 SystemRoot 走 —— 别写死 C:） */
  const psRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const psPath = join(psRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const ps = existsSync(psPath) ? psPath : null

  it.skipIf(!ps)('PowerShell 也会报「提示符开始」「退出码」「当前目录」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-ps-'))
    // ⚠️ **用真的那个函数写脚本** —— 它会带 UTF-8 BOM
    //    （PowerShell 5.1 没有 BOM 就按 GBK 解 ⇒ 中文注释把脚本解析坏）✓
    const script = integrationScriptPath('powershell')
    expect(script).not.toBeNull()

    const child = spawn(
      ps as string,
      [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        `try { . '${script}' } catch {}`,
      ],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    const parser = new ShellIntegrationParser()
    const events: ShellIntegrationEvent[] = []
    let text = ''
    const onData = (chunk: Buffer): void => {
      const r = parser.push(chunk.toString('utf8'))
      text += r.text
      events.push(...r.events)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    try {
      // 等第一个提示符
      const t0 = Date.now()
      while (Date.now() - t0 < 20_000 && !events.some((e) => e.type === 'promptEnd')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(events.some((e) => e.type === 'promptStart')).toBe(true)
      expect(events.some((e) => e.type === 'property' && e.key === 'Cwd')).toBe(true)

      // 敲一条命令 ⇒ 应该有退出码
      child.stdin.write('Write-Output jhyy-ps-marker\n')
      // ⚠️ **等命令的输出真的出来** —— 第一个提示符时就已经有一条 `D` 了
      //    （那是 IDE 自己起的 `-Command`，不是用户敲的）⇒ 别拿它当「跑完了」
      const t1 = Date.now()
      while (Date.now() - t1 < 20_000 && !text.includes('jhyy-ps-marker')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(text).toContain('jhyy-ps-marker')
      expect(events.some((e) => e.type === 'commandFinished')).toBe(true)
    } finally {
      child.kill()
    }
  })

  it.skipIf(!ps)('PowerShell 报**真实**的退出码（原生程序）+ 报「这条命令是什么」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-ps2-'))
    const script = integrationScriptPath('powershell')
    const child = spawn(
      ps as string,
      [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        `try { . '${script}' } catch {}`,
      ],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    const parser = new ShellIntegrationParser()
    const events: ShellIntegrationEvent[] = []
    const onData = (chunk: Buffer): void => {
      events.push(...parser.push(chunk.toString('utf8')).events)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    try {
      const t0 = Date.now()
      while (Date.now() - t0 < 20_000 && !events.some((e) => e.type === 'promptEnd')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      // ⚠️ **必须用调用运算符 `&` + 完整路径** ——
      //    不然 PowerShell 把命令名解析成别的东西 ⇒ `$LASTEXITCODE` 是空的
      //    （实测：`cmd /c exit 42` ⇒ 空；`& '…\cmd.exe' /c exit 44` ⇒ 44）✗
      const cmdExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      child.stdin.write(`& '${cmdExe}' /c exit 42\n`)

      const t1 = Date.now()
      while (
        Date.now() - t1 < 20_000 &&
        !events.some((e) => e.type === 'commandFinished' && e.exitCode === 42)
      ) {
        await new Promise((r) => setTimeout(r, 25))
      }
      const done = events.filter((e) => e.type === 'commandFinished')
      expect(done.length).toBeGreaterThan(0)
      // ⚠️ **真实退出码** —— 不是 VS Code 那套只有 0/1 的「假码」✓
      //    （分不出「Ctrl+C 中断（0xC000013A）」和「真崩了」✗）
      expect(done[done.length - 1]).toEqual({ type: 'commandFinished', exitCode: 42 })

      // ⚠️ **也要报「这条命令是什么」** ⇒ IDE 靠它认出**哪条**命令跑完了
      //    （不然用户自己敲的命令会被当成 IDE 的 ⇒ 退出码张冠李戴 ✗）
      const lines = events
        .filter((e) => e.type === 'commandLine')
        .map((e) => (e as { commandLine: string }).commandLine)
      expect(lines.some((l) => l.includes('cmd.exe'))).toBe(true)
    } finally {
      child.kill()
    }
  })

  /**
   * ⚠️ **cmdlet 失败 ⇒ 退出码不能是 0**。
   *
   * ⚠️ 以前 `$?` 是在 `Prompt` 函数**中间**读的 ⇒ 函数里执行过的语句
   *    （`Set-StrictMode`、两句赋值）已经把它覆盖成 True ⇒ **失败也报 0** ✗
   *
   * ⇒ 后果：IDE 的「cd 失败 ⇒ 停下整条序列」那道护栏**永远不触发**
   * ⇒ 编译会在**用户的项目目录**里跑 ⇒ 凭空造出 `compiler/build/obj/` 垃圾 ✗
   */
  it.skipIf(!ps)('PowerShell：cmdlet 失败 ⇒ 退出码不是 0（$? 要第一个读）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-ps3-'))
    const script = integrationScriptPath('powershell')
    const child = spawn(
      ps as string,
      [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        `try { . '${script}' } catch {}`,
      ],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    const parser = new ShellIntegrationParser()
    const events: ShellIntegrationEvent[] = []
    const onData = (chunk: Buffer): void => {
      events.push(...parser.push(chunk.toString('utf8')).events)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    try {
      const t0 = Date.now()
      while (Date.now() - t0 < 20_000 && !events.some((e) => e.type === 'promptEnd')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      // ⚠️ **故意失败**：Set-Location 到一个不存在的目录
      child.stdin.write(`Set-Location -LiteralPath 'C:\\jhyy-no-such-dir' -ErrorAction SilentlyContinue\n`)

      const t1 = Date.now()
      while (
        Date.now() - t1 < 20_000 &&
        !events.some((e) => e.type === 'commandFinished' && e.exitCode === 1)
      ) {
        await new Promise((r) => setTimeout(r, 25))
      }
      const done = events.filter((e) => e.type === 'commandFinished')
      expect(done.length).toBeGreaterThan(0)
      // ⚠️ **失败必须报非 0** —— 报 0 就等于说「成功」⇒ 护栏失效 ✗
      expect(done[done.length - 1]).toEqual({ type: 'commandFinished', exitCode: 1 })
    } finally {
      child.kill()
    }
  })
})

/**
 * **任务终端的启动参数**（VS Code 的 `useShellEnvironment` 模型）。
 *
 * ⚠️ **用户的 PowerShell profile 可能要 9～11 秒**（这台机器上是 `conda init`）
 *   ⇒ 「运行」/「检查」每次都等它 ⇒ **按钮点了半天才有反应** ✗
 * ⇒ ⇒ VS Code 的任务终端用 `useShellEnvironment = true`
 *   ⇒ 用的是**算好的** shell 环境（profile 的 env 导一次、缓存住）
 *   ⇒ **不重新跑 profile** ✓
 */
describe('任务终端的启动参数', () => {
  it('**PowerShell：不加 `-NoProfile` 时就照常加载**（交互终端要有漂亮的提示符）', () => {
    const args = shellCommandArgs('powershell', 'echo hi')
    expect(args).not.toContain('-NoProfile')
    expect(args).toContain('-NoLogo')
  })

  it('**PowerShell：`-NoProfile` ⇒ profile 的 env 已经注入了 ⇒ 不用再加载**', () => {
    const args = shellCommandArgs('powershell', 'echo hi', { noProfile: true })
    expect(args).toContain('-NoProfile')
    // ⚠️ **顺序有讲究**：`-NoLogo`/`-NoProfile` 必须在 `-Command` **前面** ✓
    expect(args.indexOf('-NoProfile')).toBeLessThan(args.indexOf('-Command'))
  })

  it('**bash 用 `-c` ⇒ 本来就不加载 profile**（不用 `-NoProfile`）', () => {
    const args = shellCommandArgs('bash', 'echo hi')
    expect(args[0]).toBe('-c')
    expect(args).not.toContain('-NoProfile')
  })

  it('**退出码要显式带出去**（`powershell -Command` 默认退 0）', () => {
    const args = shellCommandArgs('powershell', 'echo hi')
    const script = args[args.indexOf('-Command') + 1]
    expect(script).toContain('exit')
    expect(script).toContain('$LASTEXITCODE')
    // ⚠️ **`$LASTEXITCODE` 是 `$null`（命令压根没跑起来）⇒ 退出码不能是 0** ✓
    expect(script).toContain('$null')
  })
})
