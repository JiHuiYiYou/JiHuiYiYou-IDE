// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useResizable } from '../../src/renderer/hooks/useResizable'

/**
 * **拖动分隔条的手感** —— 用户报过「拖动终端的分割线**卡卡的**」。
 *
 * ⇒ 两个要钉住的行为：
 *   1. **`pointermove` 不该一次一次都改尺寸** —— 它可以比帧还快
 *      ⇒ 一帧最多改一次（rAF 节流）✓
 *   2. **松手时才写回 React state**（`onCommit`）——
 *      拖动过程中不碰 state ⇒ 整个 React 树不重渲染 ⇒ 不卡 ✓
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

interface HarnessProps {
  onResize: (size: number) => void
  onCommit?: (size: number) => void
  size: number
}

function Harness(props: HarnessProps) {
  const drag = useResizable({
    onResize: props.onResize,
    onCommit: props.onCommit,
    size: props.size,
    direction: 'horizontal',
    min: 100,
    max: 900,
    // ⚠️ 不反转 ⇒ 往下拖尺寸变大（算式好验证）
    invert: false,
  })
  return createElement('div', {
    'data-testid': 'handle',
    onPointerDown: drag.onPointerDown,
  })
}

/** 渲染一个 harness，返回它的把手元素。 */
function render(props: HarnessProps): { handle: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(Harness, props))
  })
  const handle = container.querySelector('[data-testid="handle"]') as HTMLElement
  return { handle, unmount: () => act(() => root.unmount()) }
}

/** 等一帧（rAF 在 jsdom 里是 16ms 的定时器）。 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40))
  })
}

describe('拖动分隔条', () => {
  it('**一帧最多改一次** —— pointermove 可以比帧还快', async () => {
    const resized: number[] = []
    const { handle, unmount } = render({ onResize: (n) => resized.push(n), size: 200 })
    try {
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }))
      })
      // 三个 pointermove 挤在同一帧里
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 120 }))
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 140 }))
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 160 }))
      })
      // ⚠️ **还没到一帧 ⇒ 一次都不该调**（不然就是三次全树重渲染）✓
      expect(resized.length).toBe(0)

      await nextFrame()
      // ⇒ 只调**一次**，而且用的是**最新**的位置 ✓
      expect(resized.length).toBe(1)
      expect(resized[0]).toBe(260) // 200 + (160 - 100)
    } finally {
      unmount()
    }
  })

  it('**松手时才写回 React state**（拖动全程不碰 state ⇒ 不重渲染）', async () => {
    const resized: number[] = []
    const committed: number[] = []
    const { handle, unmount } = render({
      onResize: (n) => resized.push(n),
      onCommit: (n) => committed.push(n),
      size: 200,
    })
    try {
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }))
      })
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 150 }))
      })
      await nextFrame()
      // 拖动中：改了尺寸，但**没写 state** ✓
      expect(resized.length).toBe(1)
      expect(committed.length).toBe(0)

      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      })
      // 松手 ⇒ 写 state（**一次**）✓
      expect(committed).toEqual([250])
    } finally {
      unmount()
    }
  })

  it('松手时排着的那一帧还没跑 ⇒ 最后的尺寸也得生效', () => {
    const resized: number[] = []
    const committed: number[] = []
    const { handle, unmount } = render({
      onResize: (n) => resized.push(n),
      onCommit: (n) => committed.push(n),
      size: 200,
    })
    try {
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }))
      })
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 175 }))
      })
      // ⚠️ **不等那一帧** ⇒ 直接松手 ⇒ 最终尺寸不能丢 ✓
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      })
      expect(resized[resized.length - 1]).toBe(275)
      expect(committed).toEqual([275])
    } finally {
      unmount()
    }
  })
})
