import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

interface Props {
  /** 终端的起始目录（当前打开的文件所在目录） */
  cwd: string
  /** 「终端」页签是不是当前页签 —— 用来懒启动 shell */
  active: boolean
}

/**
 * 终端 —— xterm.js 渲染，主进程跑 shell。
 *
 * ⚠️ **没有 PTY**（见 `src/shared/terminal.ts`）：主进程用管道 stdio 跑
 * PowerShell / cmd / bash。代价是 `vim`/`top` 这类全屏 TUI 跑不了。
 *
 * ⚠️ **组件要一直挂载** —— 面板折叠时只是把它 `display:none` 藏起来。
 * 一旦卸载，xterm 实例就销毁了，scrollback 和 shell 状态全丢。
 * （隐藏的那段时间容器是 0×0，`fit()` 前要判尺寸，见下。）
 *
 * ⚠️ **`new Terminal()` 必须在 `useEffect` 里构造** —— 不能放 `useState` 或模块
 * 作用域。否则 React 19 StrictMode 的双调用会在同一个 DOM 节点上建两个终端。
 * `term.dispose()` 会把它自己建的 DOM 摘掉，所以重挂是干净的。
 */
export default function TerminalPane({ cwd, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** shell 只拉起一次 */
  const startedRef = useRef(false)
  /** 当前目录变了要同步给 shell */
  const cwdRef = useRef(cwd)
  /** 已经发给 shell 的目录 —— 用来判断「是不是真的变了」 */
  const sentCwdRef = useRef<string | null>(null)
  cwdRef.current = cwd

  // ── 建终端（只建一次） ─────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
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
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    /**
     * fit 之前要判尺寸 —— 面板折叠时容器是 0×0，
     * `fit()` 在 0 尺寸下会算出垃圾（甚至抛）。
     */
    const fitIfBigEnough = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return
      try {
        fit.fit()
      } catch {
        // fit() 在 0 尺寸时会抛 —— 上面已经挡了，这里只是保险
      }
    }
    fitIfBigEnough()

    // 面板展开/折叠、改高度都会改容器尺寸 —— 重新量一遍
    const ro = new ResizeObserver(fitIfBigEnough)
    ro.observe(host)

    const offData = window.jhyyIde.terminal.onData((e) => term.write(e.data))
    const offExit = window.jhyyIde.terminal.onExit((e) => {
      term.writeln(`\r\n\x1b[90m[进程已退出，代码 ${e.code}]\x1b[0m`)
    })

    // 键盘 → stdin
    const dataSub = term.onData((data) => {
      window.jhyyIde.terminal.write(data)
    })

    /*
      让浏览器来复制。

      ⚠️ xterm 默认会把 `Ctrl+C` 当成 SIGINT 吃掉（`preventDefault`），
      于是浏览器的原生复制**永远不会触发** —— 终端里的字就选不出来也复制不了。

      返回 false = 「xterm 别管这个键」⇒ 浏览器照常触发 `copy` 事件
      ⇒ xterm 的 CopyService 把选中的文本写进系统剪贴板 ✓
    */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 'c' && term.hasSelection()) {
        return false // 有选区 ⇒ 让浏览器复制
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'c') {
        return false // Ctrl+Shift+C 一律复制
      }
      return true
    })

    return () => {
      dataSub.dispose()
      offData()
      offExit()
      ro.disconnect()
      term.dispose()
    }
  }, [])

  // ── 懒启动 shell（第一次切到「终端」页签时） ────────────────
  useEffect(() => {
    if (!active || startedRef.current) return
    startedRef.current = true
    // shell 就是**在这个目录里**起来的 —— 别再补一条 cd 了
    sentCwdRef.current = cwdRef.current
    void window.jhyyIde.terminal.start({ cwd: cwdRef.current }).then((r) => {
      if (!r.ok) {
        // shell 起不来 —— 在终端里说一声
        window.jhyyIde.terminal.write(`\r\n\x1b[31m${r.error ?? '终端启动失败'}\x1b[0m`)
      }
    })
  }, [active])

  // ── 打开的文件换了目录 → 让 shell 跟过去 ───────────────────
  //
  // ⚠️ 只在**目录真的变了**的时候才发 cd ——
  // 挂载时也会跑这个 effect，不挡一下的话会白发一条 `Set-Location`，
  // 终端里凭空多出几行噪音。
  useEffect(() => {
    // '~' 不是真目录（shell 自己就在 home 目录），发过去反而会报错
    if (!cwd || cwd === '~') return
    if (sentCwdRef.current === cwd) return
    sentCwdRef.current = cwd
    if (!startedRef.current) return
    void window.jhyyIde.terminal.cd(cwd)
  }, [cwd])

  return <div ref={hostRef} className="terminal-pane" />
}
