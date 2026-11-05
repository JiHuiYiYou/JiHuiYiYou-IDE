// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommands, type CommandContext } from '../../src/renderer/commands/registry'
import { useKeybindings } from '../../src/renderer/commands/useKeybindings'
import type { Command } from '../../src/renderer/commands/types'

/**
 * 粘贴（Ctrl+V）必须走**浏览器原生**那条路。
 *
 * ⚠️ 用户报过：「文本编辑模式下 ctrl+v 粘贴不了」。
 *
 * 根因：全局快捷键在 `window` 的**捕获阶段** `preventDefault()` +
 * `stopPropagation()` —— 浏览器因此**不再触发** `paste` 事件，
 * 而 CodeMirror 6 的粘贴处理（`handlers.paste`）就靠那个事件
 * ⇒ 编辑器永远收不到要粘的东西。
 *
 * ⇒ 粘贴这条命令必须标成 `native`：**别抢**，让浏览器自己派发 `paste`。
 * （原生路径还更快：直接读 `event.clipboardData`，不用绕 IPC。）
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 一个什么都不干的命令上下文（只测快捷键的归属）。 */
function stubContext(): CommandContext {
  const noop = (): void => {}
  return {
    newFile: noop,
    openFile: noop,
    saveFile: noop,
    saveAs: noop,
    closeFile: noop,
    compile: noop,
    run: noop,
    stop: noop,
    showCommandPalette: noop,
    openSettings: noop,
    toggleBlocks: noop,
    togglePanel: noop,
    showPanelTab: noop,
    newTerminal: noop,
    toggleSidebar: noop,
    toggleStatusBar: noop,
    editor: () => null,
    hasFile: () => false,
    isBusy: () => false,
    isBlocksView: () => false,
    isPanelOpen: () => false,
    isSidebarOpen: () => false,
    activePanelTab: () => null,
  }
}

/** 挂过的根 —— 用例结束后卸载（别把监听器留在 jsdom 里）。 */
const mountedRoots: Root[] = []

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount())
  }
  mountedRoots.length = 0
  document.body.innerHTML = ''
})

/** 挂一个只装快捷键的组件。 */
async function mountKeybindings(commands: Command[]): Promise<void> {
  function Harness(): null {
    useKeybindings(commands)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(Harness))
  })
}

/** 敲一个键，返回这个事件有没有被 `preventDefault`（= 被我们抢走）。 */
function press(key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: Boolean(mods.ctrlKey),
    shiftKey: Boolean(mods.shiftKey),
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('粘贴的按键归属', () => {
  it('「编辑 → 粘贴」这条命令标成了 native（别抢浏览器的 paste 事件）', () => {
    const commands = createCommands({ current: stubContext() })
    const paste = commands.find((c) => c.id === 'edit.paste')
    expect(paste, '命令表里得有 edit.paste').toBeTruthy()
    expect(paste!.keybinding).toBe('Ctrl+V')
    expect(paste!.native, '必须标 native，否则浏览器不再发 paste 事件 ⇒ 粘不上').toBe(true)
  })

  it('按 Ctrl+V **不**被全局快捷键抢走（浏览器照常派发 paste 事件）', async () => {
    await mountKeybindings(createCommands({ current: stubContext() }))
    expect(press('v', { ctrlKey: true }), 'Ctrl+V 被抢了 ⇒ 粘不上').toBe(false)
  })

  it('别的快捷键照旧被接管（比如 Ctrl+J 切面板 —— 它不在浏览器/编辑器的原生范围里）', async () => {
    await mountKeybindings(createCommands({ current: stubContext() }))
    expect(press('j', { ctrlKey: true })).toBe(true)
  })
})
