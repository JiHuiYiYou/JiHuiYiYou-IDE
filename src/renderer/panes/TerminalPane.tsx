import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalInfo } from '@shared/terminal'
import { TERMINAL_OPTIONS } from './terminalOptions'
import { PtySizeDebouncer, TerminalResizeDebouncer } from './terminalResizeDebouncer'

interface Props {
  /** 终端的起始目录（当前打开的文件所在目录） */
  cwd: string
  /** 「终端」页签是不是当前页签 —— 用来懒启动 shell */
  active: boolean
  /** 终端列表（主进程给的 —— **列表在面板头部**，不在这里） */
  terminals: TerminalInfo[]
  /** 当前显示的是哪个终端 */
  activeTerminalId: number | null
}

/**
 * **xterm 的字符度量** —— 一个格子多大（像素）。
 *
 * ⚠️ **内部 API** —— 但 FitAddon 用的也是同一个
 *    （`term._core._renderService.dimensions.css.cell`），
 *    VS Code 也读 xterm 的内部（`raw._core`）⇒ 同一路子 ✓
 *
 * ⚠️ **读它不触发布局**（就是个属性）⇒ 每帧读都便宜 ✓
 *    （而 `getComputedStyle()` 会**强制同步布局** ⇒ 卡 ⇒ 闪 ✗）
 */
function xtermCellSize(term: Terminal): { width: number; height: number } | null {
  const core = (
    term as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width: number; height: number } } }
        }
      }
    }
  )._core
  const cell = core?._renderService?.dimensions?.css?.cell
  if (!cell || !cell.width || !cell.height) return null
  return { width: cell.width, height: cell.height }
}

/**
 * **发给 pty 的尺寸**去抖多久（毫秒）。
 *
 * ⚠️ **为什么单独去抖** —— ConPTY 一 resize 就**整屏重画**（很贵）⇒
 *    拖动的时候每帧一次 = 每帧一次整屏重画 ⇒ 卡死 ✗
 *    ⇒ 停手之后补发一次就够了 ✓（见 `createView` 里的 `notifyPtySize`）
 */
const PTY_SIZE_DEBOUNCE_MS = 100

/**
 * **一个终端的视图** —— 每个终端一份（xterm 实例 + 它自己的状态）。
 *
 * ⚠️ **每个终端一个 xterm 实例**（VS Code 那样）⇒ 切来切去 scrollback 不丢 ✓
 *    ⇒ 状态也得**各自一份**（背压序号、恢复队列、保存定时器…）✓
 */
interface TerminalView {
  id: number
  el: HTMLDivElement
  term: Terminal
  search: SearchAddon
  serialize: SerializeAddon
  fit: FitAddon
  webgl: WebglAddon | null
  offData: () => void
  offExit: () => void
  /** 背压：收到过的最大序号 */
  lastSeq: number
  /** 背压：已经回执的序号 */
  ackedSeq: number
  ackTimer: ReturnType<typeof setTimeout> | null
  /** 还在恢复中？（恢复完之前收到的数据先攒着） */
  restoring: boolean
  pendingWhileRestoring: string[]
  /** 内容变了没？（变了才值得序列化） */
  dirty: boolean
  saveTimer: ReturnType<typeof setInterval> | null
  /** 尺寸的去抖器（VS Code 那套） */
  debouncer: TerminalResizeDebouncer
  /** 攒着的尺寸立刻生效（终端刚变成可见时调） */
  flushResize: () => void
  dispose: () => void
}

/**
 * 终端 —— xterm.js 渲染，主进程跑 shell。
 *
 * ⚠️ **可以有多个终端**（VS Code 的模型）——
 * - 上面那排是**终端列表**（点一下切换、× 关掉、+ 新开）
 * - 「运行」用**当前那个**；一个都没有 ⇒ 主进程会**新开一个** ✓
 * - 反复运行 ⇒ **复用同一个**（不每次都开新的）✓
 *
 * ⚠️ **组件要一直挂载** —— 面板折叠时只是把它 `display:none` 藏起来。
 * 一旦卸载，xterm 实例就销毁了，scrollback 和 shell 状态全丢。
 *
 * ⚠️ **`new Terminal()` 必须在 `useEffect` 里构造** —— 不能放 `useState` 或模块
 * 作用域。否则 React 19 StrictMode 的双调用会在同一个 DOM 节点上建两个终端。
 */
export default function TerminalPane({
  cwd,
  active,
  terminals: list,
  activeTerminalId: activeId,
}: Props) {
  /** 每个终端的 DOM 容器（React 渲染，xterm 挂上去） */
  const containersRef = useRef(new Map<number, HTMLDivElement>())
  /** 每个终端的视图（xterm 实例 + 状态） */
  const viewsRef = useRef(new Map<number, TerminalView>())
  /**
   * **「view 还没建好」的终端收到的数据**（先攒着，等 view 建好时补给它）。
   *
   * ⚠️ **不能丢** —— 新终端的第一批输出很容易在这个窗口里到 ⇒
   *    丢了用户看到的就是「终端是空的」（用户报过）✗
   */
  const pendingDataRef = useRef(new Map<number, { data: string; seq: number }[]>())
  /** shell 只拉起一次 */
  const startedRef = useRef(false)
  /** 当前目录变了要同步给 shell */
  const cwdRef = useRef(cwd)
  /** 已经发给 shell 的目录 —— 用来判断「是不是真的变了」 */
  const sentCwdRef = useRef<string | null>(null)
  /** 搜索框开着吗 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 搜索框里的字 */
  const [query, setQuery] = useState('')
  /** 搜索框的输入框（要抢焦点） */
  const searchInputRef = useRef<HTMLInputElement>(null)
  cwdRef.current = cwd

  /** 打开搜索框（Ctrl+F）。 */
  const openSearch = useCallback(() => {
    setSearchOpen(true)
  }, [])

  /** 关掉搜索框。 */
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    for (const v of viewsRef.current.values()) v.search.clearDecorations()
    // 焦点还给终端（不然用户还得再点一下终端才能继续敲命令）✓
    viewsRef.current.get(activeIdRef.current ?? -1)?.term.focus()
  }, [])

  /** 当前那个终端的 id（给回调用，避免闭包里拿到旧的） */
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId

  /** 找下一个 / 上一个（只搜当前那个终端）。 */
  const findNext = useCallback((q: string) => {
    if (!q) return
    viewsRef.current.get(activeIdRef.current ?? -1)?.search.findNext(q, { incremental: true })
  }, [])
  const findPrev = useCallback((q: string) => {
    if (!q) return
    viewsRef.current.get(activeIdRef.current ?? -1)?.search.findPrevious(q, { incremental: true })
  }, [])

  /*
    ⚠️ **搜索框一打开就得抢焦点** ——

    xterm 的那个 textarea 才是终端的焦点所在 ⇒ 搜索框渲染出来了但焦点还在
    终端上 ⇒ 用户打的字**进了终端而不是搜索框** ⇒ 看着像「搜索框坏了」✗
    ⇒ 显式 focus 一下 ✓
  */
  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
  }, [searchOpen])

  // ⚠️ `openSearch` 变了要让已有的视图知道 ⇒ 用 ref 转发（视图不用重建）✓
  const openSearchRef = useRef(openSearch)
  openSearchRef.current = openSearch

  // ── 每个终端建一份 xterm ────────────────────────────────────
  useEffect(() => {
    const views = viewsRef.current
    // 新开的 ⇒ 建一个视图
    for (const info of list) {
      if (views.has(info.id)) continue
      const el = containersRef.current.get(info.id)
      if (!el) continue
      /*
        ⚠️ **把「view 还没建好时」攒着的输出交给它** ——
          新终端的第一批输出（shell 的第一个提示符、程序刚跑的头几行）
          很容易在 view 建好之前就到 ⇒ 以前直接**掉地上**了
          ⇒ 用户看到的是「终端是空的」✗
      */
      const buffered = pendingDataRef.current.get(info.id) ?? []
      pendingDataRef.current.delete(info.id)
      views.set(
        info.id,
        createView(
          info.id,
          el,
          () => openSearchRef.current(),
          () => activeIdRef.current === info.id,
          buffered,
        ),
      )
    }
    // 关掉的 ⇒ 拆掉
    for (const [id, v] of views) {
      if (list.some((t) => t.id === id)) continue
      v.dispose()
      views.delete(id)
    }
    // ⚠️ **已经关掉的终端 ⇒ 它攒着的输出也别留**（不然白占内存）✓
    for (const id of [...pendingDataRef.current.keys()]) {
      if (list.some((t) => t.id === id)) continue
      pendingDataRef.current.delete(id)
    }
  }, [list])

  /*
    ⚠️⚠️ **「view 还没建好」的终端数据不能丢** ——
      `onData` 以前是**每个 view 订阅一次** ⇒ 视图建好之前到的数据
      **没有任何人接** ⇒ 直接掉地上 ⇒ 用户看到「终端是空的」✗
      （用户报过：「点运行，终端里什么都没有」）

      ⇒ 改成**组件级订阅**：有 view 的 ⇒ 让 view 自己处理；
        没有 view 的 ⇒ **先攒着**，等 view 建好时补给它 ✓
  */
  useEffect(() => {
    return window.jhyyIde.terminal.onData((e) => {
      // 有 view ⇒ view 自己处理（它订阅的是同一个事件源）
      if (viewsRef.current.has(e.terminalId)) return
      const list = pendingDataRef.current.get(e.terminalId) ?? []
      list.push({ data: e.data, seq: e.seq })
      pendingDataRef.current.set(e.terminalId, list)
    })
  }, [])

  /*
    **终端刚变成可见 ⇒ 把攒着的尺寸立刻用上**（VS Code 的 `setVisible(true)`
    里也是这么做的：`this._resizeDebouncer?.flush()`）⇒
    不然它会一直用旧尺寸（切过去看着窄窄的）✓

    ⚠️ **面板展开/最大化也算「刚变成可见」** —— 之前只盯着「切了哪个终端」，
    面板从折叠变成展开的时候没 flush ⇒ 尺寸是旧的（靠 RO 兜着，
    但 RO 有 rAF 节流 ⇒ 会晚一帧）⇒ 加上 `active` 这个依赖 ✓
  */
  useEffect(() => {
    if (activeId === null) return
    viewsRef.current.get(activeId)?.flushResize()
  }, [activeId, list, active])

  // ── 懒启动 shell（第一次切到「终端」页签时） ────────────────
  useEffect(() => {
    if (!active || startedRef.current) return
    startedRef.current = true
    // shell 就是**在这个目录里**起来的 —— 别再补一条 cd 了
    sentCwdRef.current = cwdRef.current
    void window.jhyyIde.terminal.start({ cwd: cwdRef.current }).then((r) => {
      if (!r.ok) {
        // shell 起不来 —— 在终端里说一声
        // ⚠️ **走 display（显示层），不走 write（stdin）** ——
        //    往 stdin 写会被 shell 当成**命令**执行掉（用户报过
        //    「程序的输出被当命令执行了」）⇒
        window.jhyyIde.terminal.display(`\r\n\x1b[31m${r.error ?? '终端启动失败'}\x1b[0m`)
      }
    })
  }, [active])

  /*
    ⚠️ **这里原来有个 `terminal.visible(active)`** —— 它是为了「补提示符」用的
      （看不见的时候别补 ⇒ 后台不会攒一堆空提示符）⇒
      ⇒ **「补提示符」整个机制删了**（它会多出一个提示符，还会把退出码变成 0）
      ⇒ ⇒ 这个通知也没用了 ⇒ **删掉** ✓
      （VS Code 的模型：shell 的提示符是唯一的提示符）
  */

  /*
    ⚠️ **终端被「重启」了（复用 ⇒ shell 重启）⇒ 屏幕要清空** ——
      VS Code 复用任务终端时会 `clearBuffer()`
      （`tasks/browser/terminalTaskSystem.ts:1614`）⇒
      不清的话，上一轮跑程序的输出会**堆在**这一轮上面 ⇒ 看得莫名其妙 ✓
  */
  useEffect(() => {
    return window.jhyyIde.terminal.onRestart((terminalId) => {
      viewsRef.current.get(terminalId)?.term.clear()
    })
  }, [])

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

  return (
    <div className="terminal-pane-wrap">
      {searchOpen && (
        <div className="terminal-search">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            placeholder="在终端里查找"
            spellCheck={false}
            onChange={(e) => {
              const q = e.target.value
              setQuery(q)
              // ⚠️ **边打边找**（VS Code 就是这个手感）✓
              findNext(q)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) findPrev(query)
                else findNext(query)
              }
            }}
          />
          <button className="terminal-search-btn" title="上一个 (Shift+Enter)" onClick={() => findPrev(query)}>
            ↑
          </button>
          <button className="terminal-search-btn" title="下一个 (Enter)" onClick={() => findNext(query)}>
            ↓
          </button>
          <button className="terminal-search-btn" title="关闭 (Esc)" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}

      {/* 每个终端一个容器（只有当前那个是显示的） */}
      <div className="terminal-views">
        {list.map((t) => (
          <div
            key={t.id}
            className="terminal-pane"
            style={{ display: t.id === activeId ? 'block' : 'none' }}
          >
            {/*
              ⚠️ **xterm 挂在这层里** —— padding 也在这一层 ⇒
              FitAddon 减的**正是它** ⇒ 算出来的行列数准 ✓

              （以前 padding 在外层 `.terminal-pane` 上 ⇒
                FitAddon 减的是 **`.xterm` 自己**的 padding（= 0）⇒
                那 8px 压根没被减掉 ⇒ **多算一行** ⇒ 最后一行被裁掉 ✗）
            */}
            <div
              className="terminal-pane-inner"
              ref={(el) => {
                if (el) containersRef.current.set(t.id, el)
                else containersRef.current.delete(t.id)
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 给一个终端建一套 xterm（+ 它自己的状态）。
 *
 * ⚠️ 这段逻辑**每个终端一份** ⇒ 状态（背压序号、恢复队列、保存定时器）也各自一份 ✓
 */
function createView(
  id: number,
  el: HTMLDivElement,
  onFind: () => void,
  /** 这个终端是不是当前显示着的 */
  isActive: () => boolean,
  /**
   * **「view 还没建好时」收到的数据** —— 建好之后要**补上**（不然就丢了）✓
   *
   * ⚠️ 补的时机跟「恢复上次的内容」一样 ⇒ 走 `pendingWhileRestoring` ⇒
   *    顺序不乱（旧内容 → 新数据）✓
   */
  buffered: { data: string; seq: number }[] = [],
): TerminalView {
  const term = new Terminal(TERMINAL_OPTIONS)
  const fit = new FitAddon()
  term.loadAddon(fit)

  /*
    **Unicode 11 的宽度表**（VS Code 也装了这个）。

    xterm 自带的宽度表是老的（Unicode 6 左右）⇒ **中文/全角/emoji 的列宽
    算不对** ⇒ 中文输出错位、框线接不上 ⇒ 跟 VS Code 一比就是「歪的」。
    ⚠️ 必须在**任何数据写进来之前**装 —— 装晚了已经算过的宽度不会回头改。
  */
  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  term.unicode.activeVersion = '11'

  /** 搜索插件 —— VS Code 的终端里 Ctrl+F 能搜回滚 ✓ */
  const search = new SearchAddon()
  term.loadAddon(search)

  /** 序列化插件 —— 窗口重载之后能把终端内容恢复回来 ✓ */
  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  term.open(el)

  /*
    **WebGL 渲染器**（VS Code 默认开，`gpuAcceleration: auto`）。

    xterm.js 6 **删掉了 canvas 渲染器** ⇒ 核心包里只剩 **DOM 渲染器**，
    而 DOM 渲染器**明确不支持 customGlyphs** ⇒ `─│┌┐└┘` 这类框线字符
    会走浏览器字体回退 ⇒ **字形和宽度都跟 VS Code 不一样**（看着就是「怪」）。

    ⚠️ **要等容器真的有尺寸才能装** —— WebGL 渲染器要往容器里塞 canvas，
      0×0 的容器（面板还折叠着）会让它算错。
    ⚠️ **GPU 不可用就退回 DOM**（`loadAddon` 会抛 ⇒ try/catch 掉就行）✓
  */
  let webgl: WebglAddon | null = null
  const ensureRenderer = () => {
    if (webgl) return
    if (el.clientWidth < 20 || el.clientHeight < 20) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // GPU context 掉了 ⇒ 退回 DOM 渲染器（别让终端变成一块黑）
        addon.dispose()
        if (webgl === addon) webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch {
      // 这台机器/这个驱动用不了 WebGL ⇒ 用 DOM 渲染器（能跑，只是慢一点）
      webgl = null
    }
  }

  /*
    **尺寸的去抖** —— 照抄 VS Code 的 `TerminalResizeDebouncer` ✓

    ⚠️⚠️ **别自己拍脑袋定策略** —— VS Code 的源码注释说得很清楚：
    > vertical resize is **cheap**, horizontal resize is **expensive due to reflow**
    ⇒ 行数变 ⇒ **立刻改**（终端跟着面板长高 ✓）
    ⇒ 列数变 ⇒ **去抖 100ms**（xterm 要 reflow ⇒ 拖动时终端根本不动 ⇒
      **屏幕上的东西不会被搅乱** ✓）
    ⇒ 而且**缓冲区不到 200 行时根本不去抖** ⇒ 小终端永远跟手 ✓
    ⇒ 而且**终端看不见时**排到空闲再改 ✓

    ⚠️ **xterm 自己的 resize 也放在去抖回调里**（VS Code 的 `_resizeYCallback`
    之类就是这么写的）⇒ 拖动过程中终端**完全不动** ⇒ 不会 reflow ✓
    ⇒ **用户报过：「调整下栏大小会抹掉终端输出」** —— 就是这个 reflow 干的 ✗

    ⚠️ **pty 的尺寸也跟着一起改**（真控制台据此发 SIGWINCH ⇒ vim 分屏不错位）✓
  */
  /**
   * **发给 pty 的尺寸去抖 100ms** ——
   *
   * ⚠️ **为什么单独去抖**（不跟 xterm 一起）——
   *   - **xterm 的尺寸** ⇒ 画面跟手（拖分割线时终端跟着面板长高）✓
   *   - **pty 的尺寸** ⇒ **ConPTY 会把整块屏幕重画一遍**（很贵！）⇒
   *     每帧一次就是「拖一下 = 几十次整屏重画 + 几十屏文本从 IPC 灌回来」
   *     ⇒ **反馈回路** ⇒ 卡得要死（用户报过）✗
   *
   * ⇒ 停手之后补发一次 ⇒ 只重画一次 ✓
   *
   * ⚠️ 这 100ms 里 **xterm 的尺寸和 pty 的尺寸是不一致的**
   *    （shell 还按旧宽度折行）⇒ 跟 VS Code 自己的 X 去抖一个样 ✓
   */
  const ptySize = new PtySizeDebouncer(
    (cols, rows) => window.jhyyIde.terminal.resize(id, cols, rows),
    PTY_SIZE_DEBOUNCE_MS,
  )
  const notifyPtySize = (): void => {
    ptySize.request(term.cols, term.rows)
  }
  const debouncer = new TerminalResizeDebouncer(
    // 这个终端是不是当前显示着的（隐藏的终端别去惊动它）✓
    isActive,
    // 列 + 行一起改
    (cols, rows) => {
      term.resize(cols, rows)
      notifyPtySize()
    },
    // 只改列（终端看不见时走这条路）
    (cols) => {
      term.resize(cols, term.rows)
      notifyPtySize()
    },
    // 只改行（终端看不见时走这条路）
    (rows) => {
      term.resize(term.cols, rows)
      notifyPtySize()
    },
  )

  /**
   * **算出行列数** —— **不触发布局** ✓
   *
   * ⚠️ **为什么不用 `fit.proposeDimensions()`**（VS Code 也是自己算的 ——
   *    `TerminalInstance._evaluateColsAndRows`）：
   *   ① 它每次都 `getComputedStyle()` ⇒ **强制同步布局** ⇒
   *      「读 → 写（resize）→ 再读」⇒ **布局抖动**（layout thrashing）
   *      ⇒ 每帧一次全页重排 ⇒ **卡** ⇒ 而且**闪**（重排和重绘交错）✗
   *   ② 它**无条件减掉 14px**（`scrollback > 0` 时）—— 那是
   *      **overview ruler** 的宽度（**我们没有那个东西**）⇒
   *      终端比容器**窄 14px** ⇒ 画布和容器对不上 ⇒ 一动就「闪」✗
   *
   * ⇒ 改成：
   *   - 尺寸从 **ResizeObserver 的 `contentRect`** 拿 ——
   *     它**就是内容框**（已经减掉 padding 了）⇒ **不用 `getComputedStyle`** ✓
   *   - 格子大小从 **xterm 的字符度量**拿（内部 API ——
   *     FitAddon 用的也是同一个，VS Code 也读 xterm 的内部）✓
   *     ⇒ 读它**不触发布局**（就是个属性）⇒ 每帧读都便宜 ✓
   */
  const measure = (availW: number, availH: number): { cols: number; rows: number } | null => {
    const cell = xtermCellSize(term)
    if (!cell) {
      // 兜底：拿不到度量就用老办法（会强制同步布局 ⇒ 只在万一时用）
      try {
        return fit.proposeDimensions() ?? null
      } catch {
        return null
      }
    }
    return {
      cols: Math.max(2, Math.floor(availW / cell.width)),
      rows: Math.max(1, Math.floor(availH / cell.height)),
    }
  }

  /** 「算不出尺寸 ⇒ 稍后再试」的定时器（见 `applySize`）。 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 已经重试了几次（别变成一个永远跑着的定时器 ✗）。 */
  let retryCount = 0

  /** 按给定的可用尺寸重算（**只量尺寸，不改** —— 改是去抖器的事）✓ */
  const applySize = (availW: number, availH: number): void => {
    if (availW < 20 || availH < 20) return
    ensureRenderer()
    const m = measure(availW, availH)
    if (!m) {
      /*
        ⚠️ **算不出来 ⇒ xterm 的字体还没量好**（面板折叠着开终端时就是这样）
        ⇒ 稍后再试（**有限次** ⇒ 别变成一个永远跑着的定时器 ✗）✓
      */
      if (retryTimer === null && retryCount < 20) {
        retryCount++
        retryTimer = setTimeout(() => {
          retryTimer = null
          applySize(availW, availH)
        }, 50)
      }
      return
    }
    debouncer.resize(m.cols, m.rows, false)
  }

  // 面板展开/折叠、改高度都会改容器尺寸 —— 重新量一遍
  //
  // ⚠️ **要 rAF 节流** —— ResizeObserver 的回调跟着布局走，
  //    拖分割线时**一帧能来好几次** ⇒ 不节流就是每帧好几次 ✗
  //    （`BlockPane` 的那个 RO 就是这么节流的 —— 见 `BlockPane.tsx`）✓
  //
  // ⚠️ **而且要在 rAF 里改尺寸** —— RO 回调是在**布局阶段**跑的 ⇒
  //    在里面改 xterm 的尺寸 ⇒ 又触发一轮布局 ⇒
  //    Chromium 会报 "ResizeObserver loop limit exceeded" ⇒ 抖得厉害 ✗
  let raf = 0
  const ro = new ResizeObserver((entries) => {
    // ⚠️ **`contentRect` 就是内容框**（已经减掉 padding 了）⇒
    //    不用 `getComputedStyle` ⇒ **不强制同步布局** ✓
    const rect = entries[entries.length - 1]?.contentRect
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      raf = 0
      if (!rect) return
      applySize(rect.width, rect.height)
    })
  })
  ro.observe(el)

  /*
    ⚠️ **告诉 xterm「对面是 ConPTY」** ——
    VS Code 就是这么干的（`xterm.raw.options.windowsPty = processTraits.windowsPty`）✓

    ⇒ 不设的话，xterm 按 **Unix 的规则**处理「终端变高」：
       把滚动缓冲里的内容**拉回视口**；
    ⇒ 而 ConPTY 实际上是**在视口底部填空行**（它自己会重画整屏）⇒
       两边对不上 ⇒ 「行被替换导致丢数据」✗

    ⚠️ **只给 `backend`，不要给 `buildNumber`** ——
       给了 buildNumber 且 < 21376 的话，xterm 会**关掉 reflow** ⇒ 更糟 ✓
  */
  void window.jhyyIde.terminal.backend().then((info) => {
    if (info.backend !== 'node-pty') return
    try {
      term.options.windowsPty = { backend: 'conpty' }
    } catch {
      /* 老版本 xterm 没这个选项 ⇒ 忽略 */
    }
  })

  // ── 背压 ────────────────────────────────────────────────────
  let lastSeq = 0
  let ackedSeq = 0
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  const flushAck = (): void => {
    ackTimer = null
    if (ackedSeq > 0) window.jhyyIde.terminal.ack(id, ackedSeq)
  }
  const scheduleAck = (): void => {
    if (ackTimer) return
    ackTimer = setTimeout(flushAck, 16)
  }

  // ── 恢复（窗口重载之后）─────────────────────────────────────
  let restoring = true
  const pendingWhileRestoring: string[] = []

  /** 写一批数据（写完回执 ⇒ 背压）。 */
  const writeChunk = (data: string, seq: number): void => {
    term.write(data, () => {
      if (seq > ackedSeq) {
        ackedSeq = seq
        scheduleAck()
      }
    })
  }

  /** 内容变了没？（变了才值得序列化） */
  let dirty = false

  /*
    ⚠️ **「view 建好之前」收到的数据 ⇒ 一起攒着** ——
      新终端的第一批输出（shell 的第一个提示符）很容易在这个窗口里到
      ⇒ 以前直接掉地上 ⇒ 用户看到「终端是空的」✗
      ⇒ 跟「恢复上次的内容」走同一条路 ⇒ 顺序不乱 ✓
  */
  for (const b of buffered) {
    lastSeq = Math.max(lastSeq, b.seq)
    dirty = true
    pendingWhileRestoring.push(b.data)
  }

  const offData = window.jhyyIde.terminal.onData((e) => {
    // ⚠️ **别的终端的数据不管**（多终端 ⇒ 事件带 id）✓
    if (e.terminalId !== id) return
    lastSeq = Math.max(lastSeq, e.seq)
    dirty = true
    if (restoring) {
      pendingWhileRestoring.push(e.data)
      return
    }
    writeChunk(e.data, e.seq)
  })

  const offExit = window.jhyyIde.terminal.onExit((e) => {
    if (e.terminalId !== id) return
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
    /*
      ⚠️ **Ctrl+F 在终端里 = 搜回滚**（VS Code 就是一个样）——

      不会被编辑器的 `edit.find` 抢走：那条命令的 scope 是 `editor` ⇒
      只有**编辑器**有焦点时才触发（见 `useKeybindings.ts`）⇒
      焦点在终端里的时候，Ctrl+F 是空的 ⇒ 正好给终端用 ✓
    */
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      e.preventDefault()
      onFind()
      return false
    }
    return true
  })

  /*
    **定期把终端内容存到主进程** —— 窗口重载后能恢复 ✓

    ⚠️ **不要每次输出都存** —— 序列化整个 scrollback 不便宜 ⇒
    ⇒ 每 15 秒存一次（只在「有变化」的时候）✓
  */
  const saveTimer = setInterval(() => {
    if (!dirty) return
    dirty = false
    try {
      window.jhyyIde.terminal.saveBuffer(id, serialize.serialize())
    } catch {
      // 序列化失败就算了 —— 下次再存
    }
  }, 15_000)
  saveTimer.unref?.()

  /*
    **恢复之前的终端内容**（窗口重载之后）——

    ⚠️ 恢复完之前收到的数据**先攒着**（见上面）⇒ 顺序不会乱 ✓
  */
  void window.jhyyIde.terminal.getBuffer(id).then((saved) => {
    if (saved) term.write(saved)
    restoring = false
    for (const data of pendingWhileRestoring) writeChunk(data, lastSeq)
    pendingWhileRestoring.length = 0
  })

  // 告诉主进程「我准备好了」—— **重置背压状态**（窗口重载后主进程卡在途）
  window.jhyyIde.terminal.ready(id)

  return {
    id,
    el,
    term,
    search,
    serialize,
    fit,
    webgl,
    offData,
    offExit,
    lastSeq,
    ackedSeq,
    ackTimer,
    restoring,
    pendingWhileRestoring,
    dirty,
    saveTimer,
    debouncer,
    // ⚠️ **顺序要紧**：先去抖器 flush（它会 `term.resize` ⇒ 请求新的 pty 尺寸）
    //    ⇒ 再把 pty 的尺寸也 flush 出去 ⇒ 发出去的是**新**尺寸 ✓
    flushResize: () => {
      debouncer.flush()
      ptySize.flush()
    },
    dispose: () => {
      dataSub.dispose()
      offData()
      offExit()
      ro.disconnect()
      cancelAnimationFrame(raf)
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      clearInterval(saveTimer)
      debouncer.dispose()
      ptySize.dispose()
      // ⚠️ **卸载前把回执发掉** —— xterm 一销毁，那些 write 的回调就**永远不来了**
      //    ⇒ 主进程那边会一直卡在途 ⇒ 终端再也不出东西 ⇒
      //    ⇒ 把「收到过的最大序号」直接回执掉（当作都写完了）✓
      if (ackTimer) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
      if (lastSeq > 0) window.jhyyIde.terminal.ack(id, lastSeq)
      // ⚠️ **卸载前把终端内容存下来** —— 窗口重载之后能恢复 ✓
      try {
        window.jhyyIde.terminal.saveBuffer(id, serialize.serialize())
      } catch {
        // 存不了就算了
      }
      term.dispose()
    },
  }
}
