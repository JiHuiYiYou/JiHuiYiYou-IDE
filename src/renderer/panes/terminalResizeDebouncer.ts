/**
 * **终端尺寸的去抖** —— 结构照抄 VS Code 的
 * `src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts`，
 * 但**有一处故意的偏差**（见下面「为什么我们比 VS Code 更激进」）。
 *
 * ## VS Code 的规则
 *
 * > Update dimensions independently as **vertical resize is cheap** and
 * > **horizontal resize is expensive due to reflow**.
 *
 * - **竖向（行数变）便宜** ⇒ 立刻改 ⇒ 终端跟着面板长高 ✓
 * - **横向（列数变）贵** —— xterm 要**reflow** ⇒ 去抖 100ms ✓
 * - **缓冲区不到 200 行时根本不去抖**（小终端永远跟手）✓
 * - **终端看不见的时候** ⇒ 排到空闲时再改 ✓
 * - **终端刚变成可见** ⇒ `flush()` ⇒ 攒着的尺寸立刻生效 ✓
 *
 * ## ⚠️ **为什么我们比 VS Code 更激进**（一行都不 resize ⇒ 一次都不闪）
 *
 * 查了 xterm.js 6 的源码（`@xterm/addon-webgl` 的 `WebglRenderer.handleResize`）：
 *
 * ```js
 * this._canvas.width = ...; this._canvas.height = ...   // ← 改 width/height **会清空画布**
 * this._refreshCharAtlas();                              // ← **整个字符图集重建**（很贵）
 * this._clearModel(false);                               // ← 模型清空 ⇒ 整屏要重画
 * ```
 *
 * ⇒ **每一次 `term.resize()` 都会**：清空画布 + 重建字形图集 + 整屏重画
 * ⇒ ⇒ **每帧 resize 一次 = 每帧闪一次** ✗（用户报过：「还是一闪一闪的」）
 *
 * ⇒ 而 VS Code 那条「缓冲区不到 200 行就不去抖」的规则**对我们是反效果** ——
 *    我们的缓冲区天生就小 ⇒ ⇒ **永远走「立刻改」那条路** ⇒ ⇒ 每帧都闪 ✗
 *
 * ⇒ 所以：**两个方向都去抖**（100ms）⇒ 拖动过程中终端**一次都不 resize**
 *    ⇒ 停手后**只 resize 一次** ⇒ **只闪一次**（而且是内容正确的那一次）✓
 *
 * ⚠️ **代价**：拖动的时候终端的内容区**不跟着面板长高**（面板和分割线照样
 *    实时跟手）⇒ 停手后终端一次性贴上去 ⇒ VS Code 的横向拖动就是这个手感 ✓
 */

const enum Constants {
  /** resize 的去抖延迟（毫秒）。 */
  DebounceDelay = 100,
}

/** 排到「空闲」时再跑（VS Code 用 `runWhenWindowIdle`）。 */
function runWhenIdle(fn: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (ric) {
    const handle = ric(() => fn())
    return () => {
      const cancel = (globalThis as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback
      cancel?.(handle)
    }
  }
  // 没有 requestIdleCallback ⇒ 用 setTimeout 兜底
  const handle = setTimeout(fn, 50)
  return () => clearTimeout(handle)
}

export class TerminalResizeDebouncer {
  /** 最新一次的列数。 */
  private latestX = 0
  /** 最新一次的行数。 */
  private latestY = 0
  /** 去抖定时器（列和行**共用一个** ⇒ 一次到位）。 */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 「空闲时再改」的取消函数（X / Y 各一个）。 */
  private idleX: (() => void) | null = null
  private idleY: (() => void) | null = null
  private disposed = false

  constructor(
    /** 这个终端现在是不是显示着的 */
    private readonly isVisible: () => boolean,
    /** 列和行一起改 */
    private readonly resizeBoth: (cols: number, rows: number) => void,
    /** 只改列（贵 ⇒ 要去抖） */
    private readonly resizeX: (cols: number) => void,
    /** 只改行（便宜 ⇒ 立刻改） */
    private readonly resizeY: (rows: number) => void,
  ) {}

  /**
   * 请求改成 `cols × rows`。
   *
   * @param immediate 显式要求立刻改（绕过去抖）—— 只在「终端刚变可见」时用
   */
  resize(cols: number, rows: number, immediate: boolean): void {
    if (this.disposed) return
    this.latestX = cols
    this.latestY = rows

    // 显式要求 ⇒ 立刻改 ✓
    if (immediate) {
      this.clearPending()
      this.resizeBoth(cols, rows)
      return
    }

    // 看不见 ⇒ 排到空闲时再改（拖的时候别惊动它）✓
    if (!this.isVisible()) {
      if (!this.idleX) {
        this.idleX = runWhenIdle(() => {
          this.idleX = null
          if (this.disposed) return
          this.resizeX(this.latestX)
        })
      }
      if (!this.idleY) {
        this.idleY = runWhenIdle(() => {
          this.idleY = null
          if (this.disposed) return
          this.resizeY(this.latestY)
        })
      }
      return
    }

    // ⚠️ **两个方向都去抖** ⇒ 拖动过程中**一次都不 resize**
    //    ⇒ xterm 不会「清空画布 + 重建字形图集」⇒ **不会闪** ✓
    this.schedule()
  }

  /**
   * 把攒着的尺寸**立刻**用上。
   *
   * ⚠️ **终端刚变成可见时要调** —— 不然它会一直用旧尺寸（VS Code 在
   *    `setVisible(true)` 里也是这么做的）✓
   */
  flush(): void {
    if (this.disposed) return
    if (!this.timer && !this.idleX && !this.idleY) return
    this.clearPending()
    this.resizeBoth(this.latestX, this.latestY)
  }

  /** 拆掉（别让定时器打到已经销毁的 xterm 上）。 */
  dispose(): void {
    this.disposed = true
    this.clearPending()
  }

  /** 去抖（列和行一起 ⇒ 一次到位）。 */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed) return
      this.resizeBoth(this.latestX, this.latestY)
    }, Constants.DebounceDelay)
  }

  /** 把所有攒着的活儿都取消掉。 */
  private clearPending(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.idleX?.()
    this.idleX = null
    this.idleY?.()
    this.idleY = null
  }
}

/**
 * **「发给 pty 的尺寸」的去抖器** —— 只发最后一次。
 *
 * ## 为什么要单独一个（不去抖 xterm 自己的尺寸）
 *
 * - **xterm 的尺寸** ⇒ **立刻改** ⇒ 画面跟手（拖分割线时终端跟着面板长高）✓
 * - **pty 的尺寸** ⇒ **ConPTY 一 resize 就把整块屏幕重画一遍**（很贵！）⇒
 *   每帧一次 = 每帧一次整屏重画 + 一屏文本从 IPC 灌回来 ⇒ **反馈回路** ⇒
 *   拖起来卡死（用户报过：「拖动终端分割线卡卡的」）✗
 *
 * ⇒ 停手之后补发一次 ⇒ 只重画一次 ✓
 *
 * ⚠️ 这 100ms 里 **xterm 的尺寸和 pty 的尺寸是不一致的**
 *    （shell 还按旧宽度折行）⇒ 跟 VS Code 自己的 X 去抖一个样 ✓
 */
export class PtySizeDebouncer {
  /** 排着的定时器。 */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 最新一次的尺寸。 */
  private latest: { cols: number; rows: number } | null = null
  /** 已经发出去的尺寸（`列x行`）—— 一样就别发（白白惊动 ConPTY 一次 ✗）。 */
  private lastSent = ''

  constructor(
    /** 把尺寸告诉主进程（⇒ 主进程去 resize 那个 pty） */
    private readonly send: (cols: number, rows: number) => void,
    /** 去抖多久（毫秒） */
    private readonly delayMs: number = 100,
  ) {}

  /** 请求改成这个尺寸（**去抖之后**才真的发出去）。 */
  request(cols: number, rows: number): void {
    this.latest = { cols, rows }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
  }

  /** **立刻**把攒着的尺寸发出去（尺寸跟上次一样就别发）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const l = this.latest
    if (!l) return
    const size = `${l.cols}x${l.rows}`
    if (size === this.lastSent) return
    this.lastSent = size
    this.send(l.cols, l.rows)
  }

  /** 拆掉（别让定时器打到已经销毁的东西上）。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
