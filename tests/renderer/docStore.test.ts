// @vitest-environment jsdom
import { undo } from '@codemirror/commands'
import { EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { createEditorState, isHistoryJump } from '../../src/renderer/editor/codemirror'
import { DocStore } from '../../src/renderer/editor/docStore'

/**
 * **文档仓库**（`DocStore`）—— 文本只存在编辑器里。
 *
 * ⚠️⚠️ **这里钉的是「打字不卡」的核心不变量** ——
 *   以前 App 的 state 里存着**三份全文**（`source` / `saved` / `blocksAt`），
 *   加上 CodeMirror 那一份 ⇒ 一个大文件在内存里躺了**四遍** ⇒
 *   而且**每次按键**还要 `doc.toString()`（把整份文件重新物化成字符串）⇒
 *   ⇒ 10 MB 的文件 ⇒ 每次按键几十毫秒 + 几十 MB 垃圾 ✗✗
 *
 * ⇒ ⇒ 现在：**每次按键 O(1)** ✓
 */

/** 造一个视图（jsdom 里 CodeMirror 能跑）。 */
function makeView(state: EditorState): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({ state, parent: host })
}

/**
 * 造一个「文件」：状态 + 仓库条目 + 变更回调。
 *
 * ⚠️ 回调里做的正是 `App.tsx` 做的事 ⇒ 测的就是**真链路** ✓
 */
function makeFile(
  store: DocStore,
  id: string,
  doc: string,
  savedText = doc,
): { state: EditorState; box: { jumps: number; calls: number } } {
  const box = { jumps: 0, calls: 0 }
  const state = createEditorState(doc, {
    onDocChange: (update) => {
      box.calls += 1
      const jump = isHistoryJump(update)
      if (jump) box.jumps += 1
      store.noteChange(id, update.state, jump)
    },
  })
  store.open(id, state, savedText, false, `${id}.jhyy`)
  return { state, box }
}

describe('文档仓库 —— 打字不碰全文', () => {
  it('普通编辑**不**把整份文档重新物化成字符串', () => {
    const store = new DocStore()
    const state = createEditorState('abc\n', {})
    store.open('a', state, 'abc\n', false, 'a.jhyy')

    const spy = vi.spyOn(Text.prototype, 'toString')
    const info = store.noteChange('a', state, false)
    // ⚠️ **这是「打字不卡」的关键** —— 一次按键不许 O(n) ✓
    expect(spy).not.toHaveBeenCalled()
    expect(info.dirty).toBe(true)
    spy.mockRestore()
  })

  it('撤销/重做才精确比一次（所以脏标记能「撤销回存盘点就消失」）', () => {
    const store = new DocStore()
    const state = createEditorState('abc\n', {})
    store.open('a', state, 'abc\n', false, 'a.jhyy')

    const spy = vi.spyOn(Text.prototype, 'toString')
    store.noteChange('a', state, true)
    // ⚠️ 撤销是低频动作 ⇒ 付一次 O(n) 换准确，值得 ✓
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('大文件模式**不做**精确比较（O(n) 不划算）', () => {
    const store = new DocStore()
    const state = createEditorState('abc\n', {})
    store.open('a', state, 'abc\n', true, 'a.jhyy')

    const spy = vi.spyOn(Text.prototype, 'toString')
    const info = store.noteChange('a', state, true)
    expect(spy).not.toHaveBeenCalled()
    // ⚠️ 大文件的脏标记只到「存盘」为止 ✓
    expect(info.dirty).toBe(true)
    spy.mockRestore()
  })
})

describe('文档仓库 —— 脏标记只在翻转时才报', () => {
  it('第一次编辑 ⇒ 翻转（true）', () => {
    const store = new DocStore()
    const s0 = createEditorState('a\n', {})
    store.open('a', s0, 'a\n', false, 'a.jhyy')
    const s1 = s0.update({ changes: { from: 0, insert: 'x' } }).state
    const info = store.noteChange('a', s1, false)
    expect(info.dirty).toBe(true)
    expect(info.dirtyChanged).toBe(true)
  })

  it('接着编辑 ⇒ **不翻转**（⇒ 打字不引发 React 重渲染）', () => {
    const store = new DocStore()
    const s0 = createEditorState('a\n', {})
    store.open('a', s0, 'a\n', false, 'a.jhyy')
    const s1 = s0.update({ changes: { from: 0, insert: 'x' } }).state
    store.noteChange('a', s1, false)
    const s2 = s1.update({ changes: { from: 0, insert: 'y' } }).state
    const info = store.noteChange('a', s2, false)
    expect(info.dirty).toBe(true)
    // ⚠️⚠️ **这条是「打字不卡」的第二道闸** ——
    //   每次按键都更新 React state ⇒ 整棵树重渲染 ⇒ 卡 ✗
    expect(info.dirtyChanged).toBe(false)
  })

  it('存盘 ⇒ 脏标记清掉', () => {
    const store = new DocStore()
    const s0 = createEditorState('a\n', {})
    store.open('a', s0, 'a\n', false, 'a.jhyy')
    const s1 = s0.update({ changes: { from: 0, insert: 'x' } }).state
    store.noteChange('a', s1, false)
    expect(store.isDirty('a')).toBe(true)
    store.markSaved('a')
    expect(store.isDirty('a')).toBe(false)
  })
})

describe('文档仓库 —— 撤销', () => {
  it('撤销回存盘点 ⇒ 脏标记消失（VS Code 的行为）', () => {
    const store = new DocStore()
    const { state } = makeFile(store, 'a', 'abc\n')
    const view = makeView(state)

    view.dispatch({ changes: { from: 3, insert: 'd' } })
    expect(store.isDirty('a')).toBe(true)
    expect(store.text('a')).toBe('abcd\n')

    // ⚠️ 真撤销（`history()` 扩展 + `undo` 命令）
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    expect(store.text('a')).toBe('abc\n')
    // ⚠️ **撤销之后**才做精确比较 ⇒ 脏标记准确地消失 ✓
    expect(store.isDirty('a')).toBe(false)
    view.destroy()
  })

  it('撤销只认「userEvent 是 undo/redo」的那次改动', () => {
    const store = new DocStore()
    const { state, box } = makeFile(store, 'a', 'abc\n')
    const view = makeView(state)

    view.dispatch({ changes: { from: 3, insert: 'd' } })
    expect(box.jumps).toBe(0)
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    expect(box.jumps).toBe(1)
    view.destroy()
  })
})

describe('文档仓库 —— 每个文件各归各的', () => {
  it('切标签 = 换 state ⇒ 撤销历史也各归各的', () => {
    const store = new DocStore()
    const a = makeFile(store, 'a', 'a\n')
    makeFile(store, 'b', 'b\n')
    const view = makeView(a.state)

    // 在 a 里打字
    view.dispatch({ changes: { from: 1, insert: 'x' } })
    expect(store.text('a')).toBe('ax\n')

    // 切到 b
    view.setState(store.get('b')!)
    expect(view.state.doc.toString()).toBe('b\n')

    // 切回 a —— **内容还在**（没被 b 覆盖）✓
    view.setState(store.get('a')!)
    expect(view.state.doc.toString()).toBe('ax\n')

    // 在 a 里撤销 ⇒ **只影响 a** ✓
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    expect(store.text('a')).toBe('a\n')
    expect(store.text('b')).toBe('b\n')
    view.destroy()
  })

  it('关掉文件 ⇒ 连同它的撤销历史一起扔掉', () => {
    const store = new DocStore()
    makeFile(store, 'a', 'a\n')
    expect(store.has('a')).toBe(true)
    store.delete('a')
    expect(store.has('a')).toBe(false)
    expect(store.get('a')).toBeUndefined()
  })
})

describe('文档仓库 —— 整份换掉内容', () => {
  it('换完之后回调还在（扩展没丢）', () => {
    const store = new DocStore()
    makeFile(store, 'a', 'a\n')
    store.replaceDoc('a', 'new\n')
    expect(store.text('a')).toBe('new\n')

    const view = makeView(store.get('a')!)
    view.dispatch({ changes: { from: 3, insert: 'z' } })
    // ⚠️ **回调还在** ⇒ 之后的改动照样进仓库 ✓
    expect(store.text('a')).toBe('newz\n')
    view.destroy()
  })

  it('换内容**不进撤销历史**（那不是用户的编辑）', () => {
    const store = new DocStore()
    const { state } = makeFile(store, 'a', 'a\n')
    const view = makeView(state)
    store.replaceDoc('a', 'new\n')
    view.setState(store.get('a')!)
    // ⚠️ 用户没改过这个文件 ⇒ Ctrl+Z 不该把它变回去 ✓
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    expect(store.text('a')).toBe('new\n')
    view.destroy()
  })

  /*
    ⚠️⚠️ **版本号必须 +1** ——
      内容变了 ⇒ 块视图**过期了** ⇒
      ⇒ 不 +1 的话 `blocksStale` 说「没过期」⇒
      ⇒ 切到块视图时**不会重建** ⇒ **块视图显示的是旧内容** ✗✗
      （这个洞是在自查时发现的 —— 「重新加载磁盘上的文件」那条路）
  */
  it('换内容 ⇒ 版本号 +1（块视图要知道「我过期了」）', () => {
    const store = new DocStore()
    const s0 = createEditorState('a\n', {})
    store.open('a', s0, 'a\n', false, 'a.jhyy')
    store.setBlocksVersion('a', store.version('a'))
    expect(store.blocksStale('a')).toBe(false)
    store.replaceDoc('a', 'new\n')
    expect(store.blocksStale('a')).toBe(true)
  })
})

describe('文档仓库 —— 块视图的版本号', () => {
  it('没建过块 ⇒ 过期', () => {
    const store = new DocStore()
    const state = createEditorState('a\n', {})
    store.open('a', state, 'a\n', false, 'a.jhyy')
    expect(store.blocksStale('a')).toBe(true)
    expect(store.blocksVersion('a')).toBe(-1)
  })

  it('按这个版本建过 ⇒ 不期', () => {
    const store = new DocStore()
    const state = createEditorState('a\n', {})
    store.open('a', state, 'a\n', false, 'a.jhyy')
    store.setBlocksVersion('a', store.version('a'))
    expect(store.blocksStale('a')).toBe(false)
  })

  it('源码又变了 ⇒ 过期', () => {
    const store = new DocStore()
    const s0 = createEditorState('a\n', {})
    store.open('a', s0, 'a\n', false, 'a.jhyy')
    store.setBlocksVersion('a', store.version('a'))
    const s1 = s0.update({ changes: { from: 0, insert: 'x' } }).state
    store.noteChange('a', s1, false)
    expect(store.blocksStale('a')).toBe(true)
  })
})
