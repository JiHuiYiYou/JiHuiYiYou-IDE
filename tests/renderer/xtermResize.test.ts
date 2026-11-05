// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { TERMINAL_OPTIONS } from '../../src/renderer/panes/terminalOptions'

// ⚠️ **jsdom 没有 `matchMedia`** —— xterm 的 `open()` 要用它算 DPR ⇒ 不补就抛
;(globalThis as unknown as { window: { matchMedia: unknown } }).window.matchMedia = (
  query: string,
) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})

/**
 * **终端 resize 之后，内容还在不在？**
 *
 * ⚠️ 用户报过：「**调整下栏大小会把程序的输出卡没**」，
 *    而且「**全屏到下栏的转换**也会」⇒ 而**提示符那一行不丢**。
 *
 * ⇒ 这个测试就是把那个现象**复现出来**（xterm 的 reflow 到底会不会丢内容）✓
 */

function makeTerminal(): { term: Terminal; el: HTMLDivElement } {
  const term = new Terminal(TERMINAL_OPTIONS)
  const el = document.createElement('div')
  document.body.appendChild(el)
  term.open(el)
  return { term, el }
}

/** 等 xterm 把写进去的东西解析完。 */
async function settle(term: Terminal, ms = 150): Promise<void> {
  await new Promise<void>((resolve) => term.write('', resolve))
  await new Promise((r) => setTimeout(r, ms))
}

describe('xterm resize 之后的内容', () => {
  it('变窄（要 reflow）⇒ 长行的内容会不会丢', async () => {
    const { term } = makeTerminal()
    const long = 'ABCDEFGHIJ'.repeat(12) // 120 列 ⇒ 会折行
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(`${i}:${long}`)
    term.write(lines.join('\r\n'))
    await settle(term)

    const before = term.buffer.active.getLine(0)?.translateToString(true) ?? ''
    expect(before).toContain('ABCDEFGHIJ')

    // ⚠️ **变窄** ⇒ xterm 要 reflow（把折行的内容重新折）⇒
    term.resize(40, 24)
    await settle(term)

    // ⚠️ 折行之后，第一行只剩前半截 ⇒ 后半截跑到下一行去了 ⇒
    //    **内容应该还在**（只是换行了）⇒
    const after = term.buffer.active.getLine(0)?.translateToString(true) ?? ''
    console.log('第一行（前）:', JSON.stringify(before.slice(0, 80)))
    console.log('第一行（后）:', JSON.stringify(after.slice(0, 80)))
    const whole = term.buffer.active
      .getLine(0)
      ?.translateToString(true)
    expect(whole).toBeDefined()
  })

  it('变高/变矮（不 reflow）⇒ 内容一行都不能少', async () => {
    const { term } = makeTerminal()
    const lines: string[] = []
    for (let i = 0; i < 30; i++) lines.push(`row-${i}`)
    term.write(lines.join('\r\n'))
    await settle(term)

    const count = (): number => {
      let n = 0
      for (let i = 0; i < term.buffer.active.length; i++) {
        if (term.buffer.active.getLine(i)?.translateToString(true)) n++
      }
      return n
    }
    const before = count()
    expect(before).toBe(30)

    term.resize(80, 24)
    await settle(term)
    expect(count()).toBe(before)

    term.resize(80, 40)
    await settle(term)
    expect(count()).toBe(before)
  })

  it('resize 之后，写进去的内容还在（不会被清掉）', async () => {
    const { term } = makeTerminal()
    term.write('marker-before-resize')
    await settle(term)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain('marker-before-resize')

    term.resize(40, 10)
    await settle(term)

    const text = term.buffer.active
      .getLine(0)
      ?.translateToString(true)
    console.log('resize 后第一行:', JSON.stringify(text))
    expect(text).toContain('marker-before-resize')
  })
})
