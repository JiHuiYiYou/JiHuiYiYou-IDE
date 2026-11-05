import type { ITerminalOptions } from '@xterm/xterm'

/**
 * 终端的**选项** —— 单独一个文件，好让单测直接用**同一份** ✓
 *
 * ⚠️ **为什么不能就写在组件里** —— 那样单测没法复用 ⇒ 装配出错
 *    （比如少设一个选项 ⇒ 插件一装就抛）只有真跑起来才发现 ⇒
 *    而真跑起来就是「终端面板整个崩掉」（用户报过）⇒
 *    ⇒ 选项放这儿，单测拿它去装一遍插件 ✓
 */
export const TERMINAL_OPTIONS: ITerminalOptions = {
  /**
   * ⚠️⚠️ **必须开** —— xterm.js 6 把好几个 API 标成了 **proposed**：
   *
   * - `term.unicode` ⇒ **Unicode11Addon** 要用（`terminal.unicode.register()`）
   * - `term.registerMarker()` ⇒ **SearchAddon / SerializeAddon** 要用
   *
   * 而 `allowProposedApi` **默认是 false** ⇒ 一访问就抛：
   * 「You must set the allowProposedApi option to true to use proposed API」
   * ⇒ **整个 `<TerminalPane>` 崩掉**（React 把它整个卸了 ⇒ 终端没了）✗
   *
   * （VS Code 自己就开着这个 —— 它是 xterm.js 的维护方 ✓）
   */
  allowProposedApi: true,

  fontFamily: "'Cascadia Mono', 'Consolas', 'JetBrains Mono', monospace",
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  convertEol: false,
  theme: {
    background: '#101219',
    foreground: '#d7dce5',
    cursor: '#00d4aa',
    selectionBackground: '#2b4a52',
    black: '#14161c',
    red: '#ff6b6b',
    green: '#7ee787',
    yellow: '#ffb454',
    blue: '#89ddff',
    magenta: '#c792ea',
    cyan: '#00d4aa',
    white: '#d7dce5',
    brightBlack: '#5f6b7a',
    brightRed: '#ff8787',
    brightGreen: '#a5f3b0',
    brightYellow: '#ffd08a',
    brightBlue: '#a5e8ff',
    brightMagenta: '#d7b6ff',
    brightCyan: '#5ce8c4',
    brightWhite: '#ffffff',
  },
}
