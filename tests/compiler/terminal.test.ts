import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../../src/main/terminal'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 终端的**输入路由** —— 不启动真的 shell（`child` 是 null ⇒ 写给 shell 的部分
 * 直接返回），只验「程序在跑的时候输入去哪儿」。
 */
function makeSession(): { session: TerminalSession; shown: () => string } {
  const chunks: string[] = []
  const session = new TerminalSession({
    shell: 'bash',
    cwd: 'C:/tmp',
    onData: (e) => chunks.push(e.data),
    onExit: () => {},
    // ⚠️ **强制管道后端** —— 真控制台（node-pty）自己会回显 ⇒ IDE 不回显，
    //    那样这些断言就全反了；而「装没装 node-pty」不该决定测试结果。
    backend: 'pipe',
  })
  return { session, shown: () => chunks.join('') }
}

describe('往终端里写内容（注入）', () => {
  it('**写之前先写 `\\n\\x1b[G`**（VS Code 的写法：内容从新行开头写）', () => {
    const { session, shown } = makeSession()
    session.display('编译器输出')
    // ⚠️ **VS Code 就是这么干的**（`terminalInstance.ts:1912` 的 `reuseTerminal`：
    //    "Ensure new processes' output starts at start of new line"）✓
    //    ⇒ 注入的内容**接在 shell 那一行的半截后面** ✗
    expect(shown()).toBe('\n\x1b[G编译器输出')
  })

  it('**不再「要」一个提示符** —— 注入的内容后面没有多出来的提示符', () => {
    const { session, shown } = makeSession()
    session.display('编译器输出')
    // ⚠️ 以前 `display()` 之后 IDE 会往 shell 的 stdin 写一个空行（补提示符）
    //    ⇒ shell 会跑一整轮额外的提示符 ⇒ **终端里多一个提示符** ✗
    //    ⇒ 现在**只写内容** ✓
    expect(shown()).not.toContain('\r')
  })
})

describe('终端输入路由', () => {
  it('程序在跑时，输入喂给程序，并且**屏幕上要回显**', () => {
    const { session, shown } = makeSession()
    const fed: string[] = []
    session.setProgramInput((t) => fed.push(t))

    session.write('42')
    expect(fed.join('')).toBe('42')
    // ⚠️ 程序从管道读 stdin ⇒ 它自己**没有 TTY、不会回显**；
    //    xterm 也不管回显 ⇒ 不回显的话用户敲的字一个字都看不见。
    expect(shown()).toBe('42')

    session.write('\r')
    expect(fed.join('')).toBe('42\r')
    expect(shown()).toBe('42\r\n')
  })

  it('退格把屏幕上最后一个字符擦掉', () => {
    const { session, shown } = makeSession()
    session.setProgramInput(() => {})

    session.write('4')
    session.write('\x7f')
    expect(shown()).toBe('4\b \b')
  })

  it('控制字符（方向键之类）不回显', () => {
    const { session, shown } = makeSession()
    session.setProgramInput(() => {})
    session.write('\x1b[A') // 上箭头
    expect(shown()).toBe('')
  })

  it('程序结束后输入还给 shell（不再喂程序、不再回显）', () => {
    const { session, shown } = makeSession()
    const fed: string[] = []
    session.setProgramInput((t) => fed.push(t))
    session.write('a')

    session.setProgramInput(null)
    session.write('b')

    expect(fed.join('')).toBe('a')
    expect(shown()).toBe('a')
  })
})

describe('终端的背压', () => {
  it('渲染进程不回执 ⇒ 主进程不会一股脑往前推（不然 IDE 会卡死）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-bp-'))
    const chunks: string[] = []
    const seqs: number[] = []
    // ⚠️ **别加载用户自己的 ~/.bashrc** —— 它可能很慢（nvm/conda init…）
    //    ⇒ 机器一忙，命令就迟迟跑不起来 ⇒ 测试会偶发失败 ⇒
    //    ⇒ HOME 指到一个空目录 ✓
    const oldHome = process.env.HOME
    const oldProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    const session = new TerminalSession({
      shell: 'bash',
      cwd: dir,
      onData: (e) => {
        chunks.push(e.data)
        seqs.push(e.seq)
      },
      onExit: () => {},
      backend: 'pipe',
    })
    try {
      // ⚠️ **等 shell 真的空闲了**（提示符出来了）再发命令 ——
      //    否则命令可能排在启动过程前面，看起来像「没输出」✓
      const t0 = Date.now()
      while (Date.now() - t0 < 30_000 && session.shellState.idle !== true) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(session.shellState.idle).toBe(true)

      // 造一大堆输出（`seq 1 1000000` ≈ 7 MB）
      session.write('seq 1 1000000\n')
      await new Promise((r) => setTimeout(r, 4000))

      const sent = chunks.join('').length
      // ⚠️ **没回执 ⇒ 只推「在途上限」那一小段**（512 KB + 一个小批次）⇒
      //    不然 IPC 队列会无限涨 ⇒ 内存被吃光 ⇒ 整个 IDE 卡死 ✓
      expect(sent).toBeGreaterThan(0)
      expect(sent).toBeLessThan(4 * 1024 * 1024)

      // ⚠️ **回执之后剩下的继续发** ⇒ 数据没丢 ✓
      const before = chunks.join('').length
      session.ack(Math.max(...seqs))
      await new Promise((r) => setTimeout(r, 3000))
      expect(chunks.join('').length).toBeGreaterThan(before)
    } finally {
      await session.kill()
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = oldProfile
    }
  })
})
