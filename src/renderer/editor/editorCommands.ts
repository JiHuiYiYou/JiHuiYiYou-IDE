import {
  addCursorAbove,
  addCursorBelow,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectMatchingBracket,
  toggleLineComment,
  undo,
} from '@codemirror/commands'
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectNextOccurrence,
} from '@codemirror/search'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * 编辑器命令 —— 菜单项和快捷键共用。
 *
 * ⚠️ CodeMirror 6 **不导出** `cut` / `copy` / `paste`（官方那套在
 * `@codemirror/clipboard` 里，本项目没装）。所以这三个自己实现，
 * 剪贴板走 Electron 的 `clipboard` 模块（见 `src/preload/index.ts`）——
 * 不要用 `navigator.clipboard`（要 clipboard-read 权限），
 * 也不要 `document.execCommand('paste')`（Chromium 明令禁止）。
 */
export type EditorCommand =
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'find'
  | 'findNext'
  | 'findPrevious'
  | 'selectNextOccurrence'
  | 'replace'
  | 'replaceAll'
  | 'replaceNext'
  | 'gotoLine'
  | 'toggleLineComment'
  | 'indentMore'
  | 'indentLess'
  | 'moveLineUp'
  | 'moveLineDown'
  | 'deleteLine'
  | 'addCursorAbove'
  | 'addCursorBelow'
  | 'selectMatchingBracket'

/** 复制选区到剪贴板。 */
export async function copySelection(view: EditorView): Promise<void> {
  const range = view.state.selection.main
  if (range.empty) return
  const text = view.state.sliceDoc(range.from, range.to)
  await window.jhyyIde.clipboard.writeText(text)
}

/** 剪切选区到剪贴板。 */
export async function cutSelection(view: EditorView): Promise<void> {
  const range = view.state.selection.main
  if (range.empty) return
  const text = view.state.sliceDoc(range.from, range.to)
  await window.jhyyIde.clipboard.writeText(text)
  view.dispatch({ changes: { from: range.from, to: range.to } })
}

/** 从剪贴板粘贴。 */
export async function pasteFromClipboard(view: EditorView): Promise<void> {
  const text = await window.jhyyIde.clipboard.readText()
  if (!text) return
  const range = view.state.selection.main
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  })
}

/**
 * 打开「替换」面板。
 *
 * ⚠️ `@codemirror/search` **没有** `openReplacePanel` 这个导出 —— 但搜索面板
 * 在编辑器非只读时**始终**带着替换输入框（没有开关可点），字段名是
 * `input[name="replace"]`。所以就是打开搜索面板，然后把焦点挪到替换框。
 */
export function openReplacePanel(view: EditorView): void {
  openSearchPanel(view)
  requestAnimationFrame(() => {
    const input = view.dom.querySelector<HTMLInputElement>('input[name="replace"]')
    input?.focus()
    input?.select()
  })
}

/** 执行一条编辑器命令。 */
export function runEditorCommand(view: EditorView, cmd: EditorCommand): void {
  switch (cmd) {
    case 'undo':
      undo(view)
      return
    case 'redo':
      redo(view)
      return
    case 'selectAll':
      selectAll(view)
      return
    case 'cut':
      void cutSelection(view)
      return
    case 'copy':
      void copySelection(view)
      return
    case 'paste':
      void pasteFromClipboard(view)
      return
    case 'find':
      openSearchPanel(view)
      return
    case 'findNext':
      findNext(view)
      return
    case 'findPrevious':
      findPrevious(view)
      return
    case 'selectNextOccurrence':
      selectNextOccurrence(view)
      return
    case 'replace':
      openReplacePanel(view)
      return
    case 'replaceAll':
      replaceAll(view)
      return
    case 'replaceNext':
      replaceNext(view)
      return
    case 'gotoLine':
      gotoLine(view)
      return
    case 'toggleLineComment':
      toggleLineComment(view)
      return
    case 'indentMore':
      indentMore(view)
      return
    case 'indentLess':
      indentLess(view)
      return
    case 'moveLineUp':
      moveLineUp(view)
      return
    case 'moveLineDown':
      moveLineDown(view)
      return
    case 'deleteLine':
      deleteLine(view)
      return
    case 'addCursorAbove':
      addCursorAbove(view)
      return
    case 'addCursorBelow':
      addCursorBelow(view)
      return
    case 'selectMatchingBracket':
      selectMatchingBracket(view)
      return
  }
}

/**
 * 跳到 1-based 的行列并把光标放过去。
 *
 * ⚠️ 编译器的行列是 **1-based**（`src/shared/jhyy.ts`），CodeMirror 是 **0-based**
 * —— 要减 1，而且得按**行**换算成文档偏移。
 */
export function revealLine(view: EditorView, line: number, col: number): void {
  const lineNo = Math.min(Math.max(line, 1), view.state.doc.lines)
  const l = view.state.doc.line(lineNo)
  const pos = Math.min(l.to, l.from + Math.max(0, col - 1))
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  })
  view.focus()
}
