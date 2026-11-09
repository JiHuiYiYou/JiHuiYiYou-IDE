/**
 * **光标位置** —— 单独一个小 store。
 *
 * ⚠️⚠️ **为什么它不能待在 `App` 的 state 里** ——
 *   以前 `App.tsx` 有 `const [cursor, setCursor] = useState(...)`，
 *   而编辑器的 `onCursorChange` 一动就调它 ⇒
 *   ⇒ **每敲一个字、每按一次方向键，整个 React 树都重渲染一遍**
 *   （这个项目里几乎没有 `memo` ⇒ CodeMirror / Blockly / 聊天面板全跟着重渲染）✗✗
 *   ⇒ 用户报过「打字的时候特别卡」⇒ 这就是其中一条大头 ✓
 *
 * ⇒ 现在光标**只有状态栏**要看 ⇒ 把它放进自己的 store，
 *   状态栏用 `useSyncExternalStore` 订阅 ⇒
 *   ⇒ **光标一动，只有状态栏那二十来行 DOM 重渲染** ✓
 *   ⇒ App 那一大棵树**完全不受影响** ✓
 *
 * （跟 `layout.ts` / `settings.ts` 一个套路 —— 但这个**不落盘**：
 *   光标位置没必要跨窗口保留。）
 */

export interface CursorInfo {
  /** 行号（1-based） */
  line: number
  /** 列号（1-based） */
  col: number
  /** 选区跨了几行（没有选区时是 0） */
  selectedLines: number
}

const EMPTY: CursorInfo = { line: 1, col: 1, selectedLines: 0 }

let current: CursorInfo = EMPTY
const listeners = new Set<() => void>()

function same(a: CursorInfo, b: CursorInfo): boolean {
  return a.line === b.line && a.col === b.col && a.selectedLines === b.selectedLines
}

/**
 * 光标 store。
 *
 * ⚠️ `getSnapshot` **必须返回稳定的引用** —— 不变的时候返回同一个对象，
 * 否则 `useSyncExternalStore` 会认为「一直在变」⇒ 无限重渲染 ✗
 */
export const cursorStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  getSnapshot(): CursorInfo {
    return current
  },

  /** 光标动了。 */
  set(next: CursorInfo): void {
    if (same(current, next)) return
    current = next
    for (const fn of listeners) fn()
  },

  /** 复位（关掉文件的时候）。 */
  reset(): void {
    cursorStore.set(EMPTY)
  },
}
