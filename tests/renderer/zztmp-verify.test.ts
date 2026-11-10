// @vitest-environment jsdom
import { createElement, createRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorState } from '../../src/renderer/editor/codemirror'
import { DocStore } from '../../src/renderer/editor/docStore'
import CodePane, { type CodePaneHandle } from '../../src/renderer/panes/CodePane'

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

function mount(fileId: string, store: DocStore, ref: ReturnType<typeof createRef<CodePaneHandle>>) {
  act(() => {
    root?.render(createElement(CodePane, { fileId, store, ref }))
  })
}

function makeStore(): DocStore {
  const store = new DocStore()
  store.open('a', createEditorState('AAA\n', {}), 'AAA\n', false, 'a.jhyy')
  store.open('b', createEditorState('BBB\n', {}), 'BBB\n', false, 'b.jhyy')
  return store
}

function contentClass(): string {
  const content = host?.querySelector('.cm-content') as HTMLElement | null
  return content?.className ?? ''
}

describe('VERIFY: word wrap per file', () => {
  it('toggle on a, switch to b', () => {
    const store = makeStore()
    const ref = createRef<CodePaneHandle>()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    mount('a', store, ref)
    console.log('a class before:', JSON.stringify(contentClass()))

    act(() => {
      ref.current?.exec('toggleLineWrapping')
    })
    console.log('a class after toggle:', JSON.stringify(contentClass()))

    mount('b', store, ref)
    console.log('b class after switch:', JSON.stringify(contentClass()))

    mount('a', store, ref)
    console.log('a class after switch back:', JSON.stringify(contentClass()))
  })
})
