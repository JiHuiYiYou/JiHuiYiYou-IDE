import { useCallback } from 'react'

/**
 * 可拖动的分隔条。
 *
 * VS Code 的侧栏和面板都能拖边缘调大小。拖的时候要：
 * - 抓住鼠标（`setPointerCapture`）
 * - 监听 `pointermove` 实时改尺寸
 * - `pointerup` 收手
 *
 * ⚠️ 增量要从**按下那一刻**算起（不是从上一帧），否则会抖。
 *
 * ## ⚠️ **拖动过程中别写 React state**
 *
 * 用户报过：「拖动终端的分割线**卡卡的**」。
 *
 * ⇒ 以前每次 `pointermove` 都 `setState` ⇒ **整个 React 树重渲染**
 *    （这个项目里**一处 `memo` 都没有** ⇒ CodeMirror、Blockly、ChatPane
 *    全跟着重渲染）⇒ 再加上 `useEffect(saveLayout)` 每次都**同步写
 *    `localStorage`** ⇒ 拖一下就是几十次全树重渲染 + 几十次磁盘写 ✗
 *
 * ⇒ 现在分两层：
 *   - `onResize` —— **拖动中**调用（**一帧最多一次**）⇒
 *     调用方**直接改 DOM 的 style** ⇒ 不进 React ⇒ 不重渲染 ✓
 *   - `onCommit` —— **松手时**调用一次 ⇒ 这才写回 React state（和存档）✓
 */
export function useResizable(options: {
  /** 拖动时回调新的尺寸（像素）—— **一帧最多一次** */
  onResize: (size: number) => void
  /**
   * **松手时**回调最终的尺寸（像素）。
   *
   * ⚠️ 只有这儿才该写 React state（⇒ 触发一次重渲染 + 一次存档）✓
   */
  onCommit?: (size: number) => void
  /** 当前的尺寸 —— 用来算增量 */
  size: number
  /** 'horizontal' = 上下拖（改高度）；'vertical' = 左右拖（改宽度） */
  direction: 'horizontal' | 'vertical'
  /** 尺寸的上下限 */
  min: number
  max: number
  /** 拖动时反向吗？（右侧栏往左拖会变宽） */
  invert?: boolean
}) {
  const { onResize, onCommit, size, direction, min, max, invert } = options

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startPos = direction === 'horizontal' ? e.clientY : e.clientX
      const startSize = size
      /** 最新的尺寸（还没生效的也算） */
      let latest = startSize
      /** rAF 的句柄（0 = 没有排着） */
      let raf = 0

      const apply = (): void => {
        raf = 0
        onResize(latest)
      }
      const onMove = (ev: PointerEvent) => {
        const cur = direction === 'horizontal' ? ev.clientY : ev.clientX
        const delta = cur - startPos
        const next = startSize + (invert ? -delta : delta)
        latest = Math.min(Math.max(next, min), max)
        // ⚠️ **一帧最多改一次** —— pointermove 可以比帧还快
        //    （实测一次拖动能收到上百个 pointermove）⇒ 不节流就是上百次重排 ✗
        if (!raf) raf = requestAnimationFrame(apply)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        // ⚠️ **排着的那一帧还没跑** ⇒ 取消掉，直接用最终值 ✓
        if (raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
        // ⚠️ **最后一次一定要生效**（rAF 可能被浏览器丢掉）⇒ 直接调 ✓
        onResize(latest)
        // ⚠️ **松手了才写回 React state** ⇒ 整个拖动过程零重渲染 ✓
        onCommit?.(latest)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      // 指针在窗口外松开（或者系统开始拖动窗口）也得收手，否则监听器会一直挂着
      window.addEventListener('pointercancel', onUp)
    },
    [onResize, onCommit, size, direction, min, max, invert],
  )

  return { onPointerDown }
}
