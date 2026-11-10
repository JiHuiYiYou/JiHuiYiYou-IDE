// @vitest-environment jsdom
import { createElement, createRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorState } from '../../src/renderer/editor/codemirror'
import { DocStore } from '../../src/renderer/editor/docStore'
import CodePane, { type CodePaneHandle } from '../../src/renderer/panes/CodePane'
import { cursorStore } from '../../src/renderer/state/cursorStore'

/**
 * **文本视图**（`CodePane`）—— 挂载 / 切文件 / 回写。
 *
 * ⚠️ **为什么要有这个测试** ——
 *   这个项目栽过好几次「组件一挂载就崩」（xterm 的 `allowProposedApi`、
 *   Blockly 的 `setState` 时机、CodeMirror 的选区越界 …）⇒
 *   ⇒ 凡是**用户会看到的路径**，都得在 jsdom 里真的挂一遍 ⇒
 *   ⇒ 「组件一挂载就崩」这类问题当场红 ✓
 *
 * ⚠️ **新架构的核心约定** ——
 *   **文本只存在编辑器里**（`DocStore`）⇒
 *   ⇒ 切标签 = `view.setState(别的文件的 state)` ⇒ O(1) ✓
 *   ⇒ 撤销历史各归各的 ✓
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
})

/**
 * 造一个仓库（两个文件）。
 *
 * ⚠️ **回调的接法跟 `App.tsx` 的 `makeEditorState` 一样** ——
 *   不然测的就不是「真链路」了 ✓
 */
function makeStore(): DocStore {
  const store = new DocStore()
  for (const [id, text] of [
    ['a', 'AAA\n'],
    ['b', 'BBB\n'],
  ] as const) {
    store.open(
      id,
      createEditorState(text, {
        onDocChange: (u) => {
          store.noteChange(id, u.state, false)
        },
        onStateChange: (u) => store.syncState(id, u.state),
      }),
      text,
      false,
      `${id}.jhyy`,
    )
  }
  return store
}

/** 挂一个文本视图。 */
function mount(props: {
  fileId: string | null
  store: DocStore
  ref?: ReturnType<typeof createRef<CodePaneHandle>>
}): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      createElement(CodePane, {
        fileId: props.fileId,
        store: props.store,
        ...(props.ref ? { ref: props.ref } : {}),
      }),
    )
  })
  return host
}

/** 编辑器里显示的文字。 */
function shownText(): string {
  const content = host?.querySelector('.cm-content') as HTMLElement | null
  return content?.textContent ?? ''
}

describe('文本视图 —— 挂载', () => {
  it('没有文件 ⇒ 挂得上（不是崩）', () => {
    mount({ fileId: null, store: makeStore() })
    expect(host?.querySelector('.cm-content')).toBeTruthy()
  })

  it('有文件 ⇒ 显示的是那个文件的内容', () => {
    mount({ fileId: 'a', store: makeStore() })
    expect(shownText()).toContain('AAA')
  })
})

describe('文本视图 —— 切文件', () => {
  it('切标签 ⇒ 内容跟着换', () => {
    const store = makeStore()
    mount({ fileId: 'a', store })
    expect(shownText()).toContain('AAA')
    act(() => {
      root?.render(
        createElement(CodePane, { fileId: 'b', store }),
      )
    })
    expect(shownText()).toContain('BBB')
    expect(shownText()).not.toContain('AAA')
  })

  it('切回 ⇒ 内容换回去', () => {
    const store = makeStore()
    mount({ fileId: 'a', store })
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'b', store }))
    })
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'a', store }))
    })
    expect(shownText()).toContain('AAA')
  })
})

describe('文本视图 —— 切回去', () => {
  it('光标还在离开时的位置（VS Code 的行为）', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    mount({ fileId: 'a', store, ref })

    // 把光标挪到第 3 列
    act(() => {
      ref.current?.revealLine(1, 3)
    })
    expect(ref.current?.getSelectionInfo()).toEqual({ line: 1, col: 3, selectedLines: 0 })

    // 切到 b，再切回 a
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'b', store, ref }))
    })
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'a', store, ref }))
    })

    // ⚠️ **光标还在原处** ——
    //   以前仓库里存的那份 state 只在「内容变了」时才更新 ⇒
    //   ⇒ 光标一动就被丢掉了 ⇒ 切回来光标回到老位置 ✗
    expect(ref.current?.getSelectionInfo()).toEqual({ line: 1, col: 3, selectedLines: 0 })
  })
})

describe('文本视图 —— 状态栏的光标', () => {
  it('切文件后状态栏的光标位置跟着换', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    mount({ fileId: 'a', store, ref })

    // 把光标挪到第 3 列 ⇒ 状态栏跟着变
    act(() => {
      ref.current?.revealLine(1, 3)
    })
    expect(cursorStore.getSnapshot()).toEqual({ line: 1, col: 3, selectedLines: 0 })

    // ⚠️ **切到别的文件 ⇒ 状态栏要跟着换** ——
    //   `view.setState()` **不触发 `updateListener`** ⇒
    //   ⇒ 光标位置**没人报** ⇒ 状态栏上还是上一个文件的 ✗
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'b', store, ref }))
    })
    expect(cursorStore.getSnapshot().line).toBe(1)
    expect(cursorStore.getSnapshot().col).not.toBe(3)
  })
})

describe('文本视图 —— 回写', () => {
  it('`replaceDoc` 把内容换掉（块视图回写走这条）', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    mount({ fileId: 'a', store, ref })
    act(() => {
      ref.current?.replaceDoc('NEW\n')
    })
    expect(shownText()).toContain('NEW')
  })

  it('`setDoc` 把内容换掉（磁盘上被改了 ⇒ 重新加载走这条）', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    mount({ fileId: 'a', store, ref })
    act(() => {
      ref.current?.setDoc('FROM_DISK\n')
    })
    expect(shownText()).toContain('FROM_DISK')
  })

  it('`isShowing` 认得出视图现在显示的是哪个文件', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    mount({ fileId: 'a', store, ref })
    expect(ref.current?.isShowing('a')).toBe(true)
    expect(ref.current?.isShowing('b')).toBe(false)
    act(() => {
      root?.render(createElement(CodePane, { fileId: 'b', store, ref }))
    })
    expect(ref.current?.isShowing('b')).toBe(true)
    expect(ref.current?.isShowing('a')).toBe(false)
  })
})
