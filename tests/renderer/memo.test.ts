// @vitest-environment jsdom
import { createElement, createRef } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import BlockPane, { type BlockPaneHandle } from '../../src/renderer/panes/BlockPane'
import { cursorStore } from '../../src/renderer/state/cursorStore'
import StatusBar from '../../src/renderer/workbench/StatusBar'

/**
 * **`React.memo`** —— 重渲染的闸门。
 *
 * ⚠️⚠️ **为什么现在才有 `memo`** ——
 *   以前这个项目**一处 `memo` 都没有** ⇒
 *   ⇒ `App` 一重渲染（后台诊断每 600 ms 一次！）⇒
 *   ⇒ **CodeMirror + Blockly + xterm + 聊天面板**全跟着重渲染 ⇒ 卡 ✗✗
 *   ⇒ ⇒ 现在：重的组件都加了 `memo` ⇒ 只重渲染**真的变了**的那些 ✓
 *
 * ⚠️ **但 `memo` 有两个坑，这里都钉住** ——
 *   ① **别把 `ref` 弄丢了** —— React 19 里 `ref` 是普通 prop ⇒
 *      `memo` 会不会透传？⇒ 必须测 ✓
 *   ② **别把「自己订阅的 store」挡掉** ——
 *      状态栏的光标是 `useSyncExternalStore` 订阅的 ⇒
 *      `memo` 只比 props ⇒ **内部 store 的更新照样能进来** ⇒ 必须测 ✓
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** jsdom 没有 `ResizeObserver`（块视图用它跟着容器尺寸走）。 */
class FakeResizeObserver {
  observe(): void {
    /* 什么都不用做 */
  }
  disconnect(): void {
    /* 什么都不用做 */
  }
  unobserve(): void {
    /* 什么都不用做 */
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

describe('memo —— ref 还要能用', () => {
  it('块视图加了 memo ⇒ ref 照样拿得到', () => {
    const ref = createRef<BlockPaneHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement(BlockPane, { ref, tree: [], onChange: () => {} }))
    })
    // ⚠️ **React 19：ref 是普通 prop** ⇒ `memo` 也要透传它 ✓
    expect(ref.current).toBeTruthy()
    expect(typeof ref.current?.resize).toBe('function')
    act(() => root.unmount())
  })
})

describe('memo —— 自己订阅的 store 照样进得来', () => {
  it('状态栏加了 memo ⇒ 光标动了照样更新', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = (): void => {
      act(() => {
        root.render(
          createElement(StatusBar, {
            diagnostics: [],
            toolchain: null,
            ptyBackend: null,
            message: undefined,
            view: 'code',
          }),
        )
      })
    }
    render()
    expect(host.textContent ?? '').toContain('Ln 1, Col 1')

    // ⚠️ **光标动了** —— 状态栏是**自己订阅**的（不是 App 传进来的 prop）
    //   ⇒ ⇒ `memo` 只比 props ⇒ 内部的 store 更新**照样**能进来 ✓
    act(() => {
      cursorStore.set({ line: 42, col: 7, selectedLines: 0 })
    })
    expect(host.textContent ?? '').toContain('Ln 42, Col 7')

    act(() => {
      cursorStore.reset()
    })
    act(() => root.unmount())
  })
})
