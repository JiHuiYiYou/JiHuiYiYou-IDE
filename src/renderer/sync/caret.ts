import { Transaction } from '@codemirror/state'
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
  /*
    ⚠️ **快路径：文件里根本没有 `\r` 就别跑正则** ——
    `text.replace(/\r\n?/g, '\n')` 会**重新分配一整份副本**（10 MB 文件 ⇒ 10 MB），
    而正则扫描本身也不便宜（10 MB ⇒ 几十毫秒）。
    ⇒ `includes('\r')` 是原生的 memchr（~1 GB/s）⇒ 没 `\r` 时几乎不要钱 ✓
    ⇒ 而且**连副本都不分配**（返回的还是原来那个字符串）✓
  */
  if (!text.includes('\r')) return text
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
 * **算「改成 target」需要动哪一段** —— 最长公共前缀 + 最长公共后缀。
 *
 * ⚠️ **为什么要算「最小改动区间」而不是整段替换** ——
 *   CodeMirror 的 `history` 扩展在处理一次改动时，会把**已有的每一条历史事件**
 *   都**映射**到新的坐标上（`addMapping`）⇒
 *   ⇒ 如果这次改动是「整段替换」，每一条历史事件都会被映射成**空区间** ⇒
 *   ⇒ **整个撤销栈就此作废**（按 Ctrl+Z 什么都不会发生）✗✗
 *   ⇒ ⇒ 所以只改**真正变了的那一段** ⇒ 映射得对 ⇒ 撤销还能用 ✓
 *
 * ⚠️ **同理：别用 `Transaction.addToHistory.of(false)` 配「整段替换」** ——
 *   那条注解让 history 走 `addMapping` 分支 ⇒ 一样会作废整个撤销栈 ✗✗
 *   ⇒ ⇒ 要「这次改动不进历史」，就**用小改动区间**，不要用「整段替换 + 注解」✓
 *
 * @param current 现在文档里的内容
 * @param target 要改成的内容
 * @returns 改动区间；内容一样时返回 null
 */
export function diffRange(
  current: string,
  target: string,
): { from: number; to: number; insert: string } | null {
  if (current === target) return null

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

  return {
    from: prefix,
    to: current.length - suffix,
    insert: target.slice(prefix, target.length - suffix),
  }
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
 *
 * @param addToHistory 这次改动要不要进撤销历史
 *   ⚠️ **默认要进** —— 「重新加载磁盘上的文件」也**要**可撤销 ⇒
 *   ⇒ 因为它会把**用户没保存的修改覆盖掉** ⇒
 *   ⇒ 不可撤销 ⇒ 用户**再也拿不回来**了 ✗✗（Ctrl+Z 能找回来 ✓）
 *   ⚠️ **但必须配「最小改动区间」** —— 整段替换 + `addToHistory: false`
 *   ⇒ 会把**整个撤销栈**作废（见 `diffRange` 的说明）⇒ ⇒ 撤销永远没反应 ✗✗
 */
export function applyTextChange(
  view: EditorView,
  newText: string,
  addToHistory = true,
): void {
  // ⚠️ **两边都要是 LF** —— 见 `normalizeEol` 的说明（CRLF 会让选区越界）。
  const target = normalizeEol(newText)
  const current = view.state.doc.toString()
  const d = diffRange(current, target)
  if (!d) return

  const { from, to, insert } = d
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
    /*
      ⚠️ **多光标要交给 CodeMirror 自己映射** ——
        直接给一个 `selection` ⇒ **别的光标全没了** ✗
        （编辑器开了 `allowMultipleSelections` ⇒ 用户可以有多个光标 ⇒
          块视图回写一次 ⇒ 三个光标只剩一个 ⇒ 看着像编辑器坏了）✗
        ⇒ ⇒ **只有单光标时**才自己算并给 selection ✓
    */
    ...(view.state.selection.ranges.length > 1
      ? {}
      : { selection: { anchor, head } }),
    scrollIntoView: false,
    ...(addToHistory ? {} : { annotations: Transaction.addToHistory.of(false) }),
  })
}
