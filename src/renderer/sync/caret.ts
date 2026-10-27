import type { EditorView } from '@codemirror/view'

/**
 * 把编辑器的文档替换成新内容，同时**尽量保住光标位置**。
 *
 * 块视图改动会重写整份源码，如果直接 `setDoc`，光标会跳到开头 —— 打字的时候
 * 体验很差。所以这里用「最长公共前缀 + 最长公共后缀」求出真正的改动区间，
 * 只替换那一段，并把光标映射过去。
 *
 * 映射规则：
 * - 光标在未变的前缀里 → 原样不动
 * - 光标在未变的后缀里 → 按长度差平移
 * - 光标在改动区间里   → 夹到改动区间的起点
 */
export function applyTextChange(view: EditorView, newText: string): void {
  const current = view.state.doc.toString()
  if (current === newText) return

  // 最长公共前缀
  let prefix = 0
  const maxPrefix = Math.min(current.length, newText.length)
  while (prefix < maxPrefix && current[prefix] === newText[prefix]) prefix++

  // 最长公共后缀
  let suffix = 0
  const maxSuffix = Math.min(current.length - prefix, newText.length - prefix)
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++
  }

  const from = prefix
  const to = current.length - suffix
  const insert = newText.slice(prefix, newText.length - suffix)
  const delta = insert.length - (to - from)

  const mapOffset = (offset: number): number => {
    if (offset <= from) return offset
    if (offset >= to) return offset + delta
    return from
  }

  const selection = view.state.selection.main
  const anchor = Math.max(0, Math.min(mapOffset(selection.anchor), newText.length))
  const head = Math.max(0, Math.min(mapOffset(selection.head), newText.length))

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor, head },
    scrollIntoView: false,
  })
}
