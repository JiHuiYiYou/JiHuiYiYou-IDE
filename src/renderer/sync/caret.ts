import type { EditorView } from '@codemirror/view'

/**
 * 把行尾统一成 **LF**。
 *
 * ⚠️ **为什么必须统一** —— CodeMirror 灌字符串的时候是
 * `Text.of(insert.split(/\r\n?|\n/))`：**`\r` 会被丢掉**。
 * 所以文档里的行尾**永远是 LF**，而磁盘上的文件可能是 CRLF。
 *
 * 两边不一致 ⇒ 长度对不上 ⇒ 选区会被算到**文档外面** ⇒
 * **"RangeError: Selection points outside of document"**（用户报过，
 * 一开 CRLF 的文件就崩）。
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 文件里用的行尾（CRLF 还是 LF）。 */
export type Eol = '\n' | '\r\n'

/** 看一段源码用的是什么行尾。 */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 把源码转成指定的行尾（存盘时用 —— 别把用户的行尾改了）。 */
export function toEol(text: string, eol: Eol): string {
  const lf = normalizeEol(text)
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

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
  // ⚠️ **两边都要是 LF** —— 见 `normalizeEol` 的说明（CRLF 会让选区越界）。
  const target = normalizeEol(newText)
  const current = view.state.doc.toString()
  if (current === target) return

  // 最长公共前缀
  let prefix = 0
  const maxPrefix = Math.min(current.length, target.length)
  while (prefix < maxPrefix && current[prefix] === target[prefix]) prefix++

  // 最长公共后缀
  let suffix = 0
  const maxSuffix = Math.min(current.length - prefix, target.length - prefix)
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix++
  }

  const from = prefix
  const to = current.length - suffix
  const insert = target.slice(prefix, target.length - suffix)
  const delta = insert.length - (to - from)

  const mapOffset = (offset: number): number => {
    if (offset <= from) return offset
    if (offset >= to) return offset + delta
    return from
  }

  const selection = view.state.selection.main
  const anchor = Math.max(0, Math.min(mapOffset(selection.anchor), target.length))
  const head = Math.max(0, Math.min(mapOffset(selection.head), target.length))

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor, head },
    scrollIntoView: false,
  })
}
