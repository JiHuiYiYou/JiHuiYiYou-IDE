import { describe, expect, it } from 'vitest'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { TERMINAL_OPTIONS } from '../../src/renderer/panes/terminalOptions'

/**
 * 终端的**装配** —— 插件能不能装上。
 *
 * ⚠️ **为什么要有这个测试** —— 用户在真应用里看到过：
 *   「You must set the allowProposedApi option to true to use proposed API」
 *   ⇒ **整个 `<TerminalPane>` 崩掉**（React 把它卸了 ⇒ 终端没了）✗
 *
 *   而单测全都绿（因为它们没碰 xterm 的**装配**）⇒
 *   ⇒ 这里拿**同一份选项**（`TERMINAL_OPTIONS`）把插件装一遍 ⇒
 *      少设一个选项 ⇒ 这里就红 ✓
 *
 * ⚠️ **不用 DOM** —— `new Terminal()` 和 `loadAddon()` 都不碰 DOM
 *    （`open()` 才碰）⇒ 纯 Node 就能测 ✓
 */
describe('终端的装配', () => {
  it('四个插件都能装上（用终端真正用的那份选项）', () => {
    const term = new Terminal(TERMINAL_OPTIONS)
    expect(() => {
      term.loadAddon(new FitAddon())
      term.loadAddon(new Unicode11Addon())
      term.loadAddon(new SearchAddon())
      term.loadAddon(new SerializeAddon())
      term.loadAddon(new WebglAddon())
    }).not.toThrow()
  })

  it('Unicode 11 的宽度表生效（中文的列宽才算得对）', () => {
    const term = new Terminal(TERMINAL_OPTIONS)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    expect(term.unicode.activeVersion).toBe('11')
  })

  it('allowProposedApi 必须开（不然 term.unicode 一访问就抛）', () => {
    // ⚠️ 这是**故意**不设 allowProposedApi ⇒ 插件一装就该抛 ⇒
    //    把这个坑钉在这儿（免得以后有人把选项改了，红的却是这里）✓
    const term = new Terminal()
    expect(() => term.loadAddon(new Unicode11Addon())).toThrow(/allowProposedApi/)
  })
})
