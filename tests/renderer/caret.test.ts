// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyTextChange, detectEol, normalizeEol, toEol } from '../../src/renderer/sync/caret'

/**
 * 行尾（CRLF / LF）的处理。
 *
 * ⚠️ **CodeMirror 灌字符串时会按 `/\r\n?|\n/` 拆行** —— `\r` 被丢掉。
 * 所以编辑器里的文档**永远是 LF**，而磁盘上的文件可能是 CRLF。
 *
 * 两边不一致 ⇒ 长度对不上 ⇒ 选区被算到**文档外面** ⇒
 * **"RangeError: Selection points outside of document"**（用户报过：
 * 一打开 CRLF 的文件就崩）。
 */
describe('行尾归一', () => {
  it('normalizeEol 把 CRLF / 裸 CR 都变成 LF', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n')
    expect(normalizeEol('a\rb')).toBe('a\nb')
    expect(normalizeEol('a\nb')).toBe('a\nb')
  })

  it('detectEol 看得出文件用哪种行尾', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n')
    expect(detectEol('a\nb')).toBe('\n')
  })

  it('toEol 能还原回去', () => {
    expect(toEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(toEol('a\r\nb\r\n', '\n')).toBe('a\nb\n')
  })

  it('归一化是幂等的', () => {
    const once = normalizeEol('a\r\nb\r\nc')
    expect(normalizeEol(once)).toBe(once)
  })
})

/** 造一个最小的 CodeMirror 视图（只要能 dispatch 就够）。 */
function makeView(doc: string, multi = false): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({
    state: EditorState.create({
      doc,
      // ⚠️ **多光标要显式开** —— 跟真编辑器一样（`codemirror.ts` 里有）
      extensions: multi ? EditorState.allowMultipleSelections.of(true) : [],
    }),
    parent: host,
  })
}

describe('applyTextChange —— 多光标不能被弄没了', () => {
  it('三个光标 ⇒ 改完还是三个', () => {
    const view = makeView('abcdef', true)
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(2),
        EditorSelection.cursor(4),
      ]),
    })
    expect(view.state.selection.ranges.length).toBe(3)

    applyTextChange(view, 'abXdef')

    // ⚠️ **多光标要交给 CodeMirror 自己映射** ——
    //   直接给一个 `selection` ⇒ **别的光标全没了** ✗
    //   （编辑器开了 `allowMultipleSelections` ⇒ 看着像编辑器坏了）✗
    expect(view.state.selection.ranges.length).toBe(3)
    expect(view.state.doc.toString()).toBe('abXdef')
  })

  it('单光标 ⇒ 位置按改动区间映射过去', () => {
    const view = makeView('abcdef')
    view.dispatch({ selection: { anchor: 5 } })
    applyTextChange(view, 'abXdef')
    expect(view.state.selection.ranges.length).toBe(1)
    // ⚠️ 只有 `c` 被 `X` 换掉了（`def` 是公共后缀）⇒ 长度没变 ⇒ 光标不动 ✓
    expect(view.state.selection.main.head).toBe(5)
  })
})

describe('applyTextChange —— 不能让选区越界', () => {
  it('CRLF 的新内容：选区不能算到文档外面', () => {
    const view = makeView('fn main_jhyy() -> i32 {\n    0\n}\n')
    // 光标在文档末尾（最容易越界的位置）
    view.dispatch({ selection: { anchor: view.state.doc.length, head: view.state.doc.length } })
    const crlf = 'fn main_jhyy() -> i32 {\r\n    1\r\n}\r\n'
    expect(() => applyTextChange(view, crlf)).not.toThrow()
    // 文档里不能有 \r（CodeMirror 自己会拆行）
    expect(view.state.doc.toString()).not.toContain('\r')
  })

  it('CRLF → 更短的 CRLF', () => {
    const view = makeView('aaaa\r\nbbbb\r\ncccc\r\n'.replace(/\r\n/g, '\n'))
    view.dispatch({ selection: { anchor: view.state.doc.length, head: view.state.doc.length } })
    expect(() => applyTextChange(view, 'x\r\ny\r\n')).not.toThrow()
  })

  it('长文本换短文本（光标在末尾）', () => {
    const view = makeView('0123456789\nabcdefghij\n')
    view.dispatch({ selection: { anchor: view.state.doc.length, head: view.state.doc.length } })
    expect(() => applyTextChange(view, '01')).not.toThrow()
    expect(view.state.doc.toString()).toBe('01')
  })

  it('空文档 → 有内容', () => {
    const view = makeView('')
    expect(() => applyTextChange(view, 'hello\nworld')).not.toThrow()
    expect(view.state.doc.toString()).toBe('hello\nworld')
  })

  it('有内容 → 空', () => {
    const view = makeView('hello\nworld')
    view.dispatch({ selection: { anchor: 11, head: 11 } })
    expect(() => applyTextChange(view, '')).not.toThrow()
    expect(view.state.doc.toString()).toBe('')
  })

  it('内容一样就不动（不产生事务）', () => {
    const view = makeView('abc\n')
    const before = view.state.doc.toString()
    applyTextChange(view, 'abc\n')
    expect(view.state.doc.toString()).toBe(before)
  })
})
