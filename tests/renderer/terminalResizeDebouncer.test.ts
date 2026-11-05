import { describe, expect, it } from 'vitest'
import {
  PtySizeDebouncer,
  TerminalResizeDebouncer,
} from '../../src/renderer/panes/terminalResizeDebouncer'

/**
 * **终端尺寸的去抖** —— 结构抄 VS Code，但**有一处故意的偏差**。
 *
 * ## 为什么偏差
 *
 * 查了 xterm.js 6 的源码（`@xterm/addon-webgl` 的 `WebglRenderer.handleResize`）：
 * **每一次 `term.resize()` 都会**
 * ① 改 `canvas.width/height` ⇒ **清空画布**（HTML 规范就是这么规定的）
 * ② `_refreshCharAtlas()` ⇒ **整个字符图集重建**
 * ③ `_clearModel(false)` ⇒ 模型清空 ⇒ 整屏重画
 *
 * ⇒ **每帧 resize 一次 = 每帧闪一次** ✗（用户报过：「还是一闪一闪的」）
 *
 * ⇒ 而 VS Code 那条「缓冲区不到 200 行就不去抖」的规则**对我们是反效果** ——
 *    我们的缓冲区天生就小 ⇒ ⇒ **永远走「立刻改」那条路** ⇒ ⇒ 每帧都闪 ✗
 *
 * ⇒ 所以我们**两个方向都去抖**（100ms）⇒ 拖动期间一次都不 resize
 *    ⇒ 停手后只 resize 一次 ⇒ **只闪一次** ✓
 */

interface Call {
  kind: 'both' | 'x' | 'y'
  cols: number
  rows: number
}

function makeDebouncer(opts?: { visible?: boolean }) {
  const calls: Call[] = []
  let visible = opts?.visible ?? true
  const debouncer = new TerminalResizeDebouncer(
    () => visible,
    (cols, rows) => calls.push({ kind: 'both', cols, rows }),
    (cols) => calls.push({ kind: 'x', cols, rows: -1 }),
    (rows) => calls.push({ kind: 'y', cols: -1, rows }),
  )
  return {
    calls,
    debouncer,
    setVisible: (v: boolean) => {
      visible = v
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('终端尺寸的去抖', () => {
  it('**拖动期间一次都不改**（xterm 每次 resize 都会清空画布 ⇒ 每帧改就是每帧闪）', () => {
    const { calls, debouncer } = makeDebouncer()
    debouncer.resize(80, 24, false)
    // ⚠️ **什么都没发生** ✓
    expect(calls).toHaveLength(0)
  })

  it('停下来之后 ⇒ **只改一次**（而且是最新的那个尺寸）', async () => {
    const { calls, debouncer } = makeDebouncer()
    debouncer.resize(90, 30, false)
    debouncer.resize(95, 32, false)
    debouncer.resize(100, 40, false)
    expect(calls).toHaveLength(0)
    await sleep(200)
    // ⚠️ **只有一次** ⇒ 只闪一次 ✓
    expect(calls).toEqual([{ kind: 'both', cols: 100, rows: 40 }])
  })

  it('显式要求立刻改 ⇒ 立刻改（终端刚变可见时用）', () => {
    const { calls, debouncer } = makeDebouncer()
    debouncer.resize(100, 30, true)
    expect(calls).toEqual([{ kind: 'both', cols: 100, rows: 30 }])
  })

  it('flush ⇒ 攒着的尺寸立刻生效（终端刚变可见时用）', () => {
    const { calls, debouncer } = makeDebouncer()
    debouncer.resize(100, 30, false)
    expect(calls).toHaveLength(0)
    debouncer.flush()
    expect(calls[calls.length - 1]).toEqual({ kind: 'both', cols: 100, rows: 30 })
  })

  it('看不见的时候 ⇒ 排到空闲再改（别在拖的时候惊动隐藏的终端）', async () => {
    const { calls, debouncer } = makeDebouncer({ visible: false })
    debouncer.resize(100, 30, false)
    // ⚠️ **立刻什么都没做** ✓
    expect(calls).toHaveLength(0)
    await sleep(150)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('拆掉之后不再动（别让定时器打到已经销毁的 xterm 上）', async () => {
    const { calls, debouncer } = makeDebouncer()
    debouncer.resize(100, 30, false)
    debouncer.dispose()
    await sleep(200)
    expect(calls).toHaveLength(0)
  })
})

describe('发给 pty 的尺寸的去抖', () => {
  /**
   * ⚠️ **为什么要单独去抖** ——
   *   ConPTY 一 resize 就**整屏重画**（很贵！）⇒ 拖动的时候每帧一次 =
   *   每帧一次整屏重画 + 一屏文本从 IPC 灌回来 ⇒ **反馈回路** ⇒ 卡死 ✗
   *   ⇒ 停手之后补发一次就够了 ✓
   *
   * ⚠️ **而且它跟 xterm 的去抖是同一个 100ms** ⇒ ⇒ **两者一直同步**
   *    ⇒ ⇒ conhost 重画时 xterm 的行数已经对上了 ⇒ 内容**不会跳** ✓
   */
  it('拖动的时候**一次都不发**，停手之后只发**最后一次**', async () => {
    const sent: { cols: number; rows: number }[] = []
    const d = new PtySizeDebouncer((cols, rows) => sent.push({ cols, rows }))

    // 模拟拖动：一连改了五次尺寸
    d.request(120, 30)
    d.request(120, 32)
    d.request(120, 34)
    d.request(120, 36)
    d.request(120, 40)

    // ⚠️ **还没到去抖时间 ⇒ 一次都没发** ✓
    expect(sent).toHaveLength(0)

    await sleep(160)
    // ⇒ **只发一次**，而且是**最后**那个尺寸 ✓
    expect(sent).toEqual([{ cols: 120, rows: 40 }])
  })

  it('尺寸没变 ⇒ 别发（白白惊动 ConPTY 一次 ✗）', async () => {
    const sent: { cols: number; rows: number }[] = []
    const d = new PtySizeDebouncer((cols, rows) => sent.push({ cols, rows }))
    d.request(120, 40)
    await sleep(160)
    expect(sent).toHaveLength(1)
    d.request(120, 40)
    await sleep(160)
    expect(sent).toHaveLength(1)
  })

  it('flush ⇒ **立刻**发出去（终端刚变可见时用）', () => {
    const sent: { cols: number; rows: number }[] = []
    const d = new PtySizeDebouncer((cols, rows) => sent.push({ cols, rows }))
    d.request(80, 24)
    expect(sent).toHaveLength(0)
    d.flush()
    expect(sent).toEqual([{ cols: 80, rows: 24 }])
  })
})
