import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../../src/main/terminal'

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
  })
  return { session, shown: () => chunks.join('') }
}

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
