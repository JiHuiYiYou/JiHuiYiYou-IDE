// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import PanelView from '../../src/renderer/workbench/PanelView'
import type { ShellState, TerminalInfo } from '@shared/terminal'

/**
 * **终端页签上的运行状态**（VS Code 的 task 页签）。
 *
 * ⚠️ 用户明说：「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
 *    ⇒ 运行状态**不在状态栏** ⇒ **在终端页签上**：
 *    **转圈 = 正在跑 / ✓ = 跑完了 / ✗ = 挂了**
 *    （VS Code 的 `tasks/browser/taskTerminalStatus.ts` 一模一样）✓
 *
 * ⚠️ 顺带钉住另一件事：**终端死了 ⇒ 它的运行状态要清掉**
 *    （用户报过：「有的终端杀掉了右上角还是在运行中」）✗
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** jsdom 没有 ResizeObserver（xterm 用它跟着容器尺寸走）。 */
class FakeResizeObserver {
  observe(): void {
    /* 什么都不用做 */
  }
  disconnect(): void {
    /* 什么都不用做 */
  }
  unobserve(): void {
    /* 什么都不用做 */
  }
}

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = null
  }
})

const TERMINAL: TerminalInfo = { id: 1, name: 'PowerShell', shell: 'powershell', cwd: 'C:/tmp' }

function render(states: Record<number, ShellState>): HTMLElement {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  // ⚠️ **面板里嵌着终端面板** ⇒ 它要用 `window.jhyyIde.terminal` ⇒ 装个假的
  ;(globalThis as unknown as { window: { jhyyIde: unknown } }).window.jhyyIde = {
    terminal: {
      start: async () => ({ ok: true, shell: 'bash', cwd: 'C:/tmp' }),
      write: () => {},
      display: () => {},
      resize: () => {},
      kill: async () => {},
      cd: async () => {},
      backend: async () => ({ backend: 'pipe' as const }),
      onBackendChange: () => () => {},
      onData: () => () => {},
      onExit: () => () => {},
      onCommand: () => () => {},
      onState: () => () => {},
      onRestart: () => () => {},
      onList: () => () => {},
      list: async () => [],
      create: async () => TERMINAL,
      close: async () => {},
      select: () => {},
      ack: () => {},
      ready: () => {},
      saveBuffer: () => {},
      getBuffer: async () => null as string | null,
    },
  }
  // ⚠️ **jsdom 没有 `matchMedia`** —— xterm 的 `open()` 要用它算 DPR ⇒ 不补就抛
  ;(globalThis as unknown as { window: { matchMedia: unknown } }).window.matchMedia = (
    query: string,
  ) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      createElement(PanelView, {
        open: true,
        tab: 'terminal',
        onTabChange: () => {},
        onClose: () => {},
        maximized: false,
        onToggleMaximize: () => {},
        height: 240,
        onHeightChange: () => {},
        diagnostics: [],
        onSelectDiagnostic: () => {},
        cwd: 'C:/tmp',
        shellStates: states,
        terminals: [TERMINAL],
        activeTerminalId: 1,
        onSelectTerminal: () => {},
        onCreateTerminal: () => {},
        onCloseTerminal: () => {},
      }),
    )
  })
  return container
}

describe('终端页签上的运行状态', () => {
  it('正在跑 ⇒ 转圈', () => {
    const container = render({ 1: { cwd: 'C:/tmp', exitCode: null, idle: false, run: 'running' } })
    expect(container.querySelector('.terminal-tab-run.running')).toBeTruthy()
  })

  it('跑完了 ⇒ ✓', () => {
    const container = render({ 1: { cwd: 'C:/tmp', exitCode: 0, idle: true, run: 'ok' } })
    expect(container.querySelector('.terminal-tab-run.ok')).toBeTruthy()
  })

  it('挂了 ⇒ ✗', () => {
    const container = render({ 1: { cwd: 'C:/tmp', exitCode: null, idle: true, run: 'failed' } })
    expect(container.querySelector('.terminal-tab-run.failed')).toBeTruthy()
  })

  it('没跑过 ⇒ **什么都不显示**（别一上来就画个圈）', () => {
    const container = render({ 1: { cwd: 'C:/tmp', exitCode: null, idle: true } })
    expect(container.querySelector('.terminal-tab-run')).toBeNull()
  })

  it('**终端死了 ⇒ 它的状态被清掉** ⇒ 页签上不再有图标', () => {
    // ⚠️ 终端死了 ⇒ 主进程报 exit ⇒ 渲染进程把那个终端的状态**删掉**
    //    ⇒ 页签上不该再有「正在跑」的圈（用户报过：「杀了还在运行中」）✗
    const container = render({})
    expect(container.querySelector('.terminal-tab-run')).toBeNull()
  })
})
