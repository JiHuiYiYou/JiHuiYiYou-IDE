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
 */
export function useResizable(options: {
  /** 拖动时回调新的尺寸（像素） */
  onResize: (size: number) => void
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
  const { onResize, size, direction, min, max, invert } = options

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startPos = direction === 'horizontal' ? e.clientY : e.clientX
      const startSize = size

      const onMove = (ev: PointerEvent) => {
        const cur = direction === 'horizontal' ? ev.clientY : ev.clientX
        const delta = cur - startPos
        const next = startSize + (invert ? -delta : delta)
        onResize(Math.min(Math.max(next, min), max))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      // 指针在窗口外松开（或者系统开始拖动窗口）也得收手，否则监听器会一直挂着
      window.addEventListener('pointercancel', onUp)
    },
    [onResize, size, direction, min, max, invert],
  )

  return { onPointerDown }
}
