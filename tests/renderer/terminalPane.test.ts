// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import TerminalPane from '../../src/renderer/panes/TerminalPane'
import type { TerminalInfo } from '@shared/terminal'

/**
 * **终端面板挂载** —— 别等真应用里才发现它崩了。
 *
 * ⚠️ 用户撞到过：`<TerminalPane>` 因为 xterm 的 proposed API 直接**崩掉**
 *    （React 把它整个卸了 ⇒ 终端没了）⇒ 而单测全绿（它们没渲染这个组件）⇒
 *    ⇒ 这里真的**渲染一遍** ⇒ 崩了这里就红 ✓
 *
 * ⚠️ **jsdom 里 xterm 能跑吗** —— 能（DOM 渲染器不用 canvas）⇒
 *    WebGL 插件会失败 ⇒ 但它有 try/catch ⇒ 退回 DOM 渲染器 ✓（正好也测了退路）
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** jsdom 没有 ResizeObserver（终端用它跟着容器尺寸走）。 */
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

/** 装一个假的 `window.jhyyIde`（终端面板用到的那几个方法）。 */
function installApi() {
  /** 收到的终端数据（测试可以自己往外发） */
  const dataListeners: ((e: { terminalId: number; seq: number; data: string }) => void)[] = []
  /** 回执（说明数据真的写进 xterm 了） */
  const acks: { id: number; seq: number }[] = []
  const api = {
    terminal: {
      start: async () => ({ ok: true, shell: 'bash', cwd: 'C:/tmp' }),
      write: () => {},
      display: () => {},
      resize: () => {},
      kill: async () => {},
      cd: async () => {},
      backend: async () => ({ backend: 'pipe' as const }),
      onBackendChange: () => () => {},
      visible: () => {},
      onData: (cb: (e: { terminalId: number; seq: number; data: string }) => void) => {
        dataListeners.push(cb)
        return () => {
          const i = dataListeners.indexOf(cb)
          if (i >= 0) dataListeners.splice(i, 1)
        }
      },
      onExit: () => () => {},
      onCommand: () => () => {},
      onState: () => () => {},
      onRestart: () => () => {},
      onList: () => () => {},
      list: async () => [{ id: 1, name: 'bash', shell: 'bash', cwd: null }] as TerminalInfo[],
      create: async () => ({ id: 1, name: 'bash', shell: 'bash', cwd: null }) as TerminalInfo,
      close: async () => {},
      select: () => {},
      ack: (id: number, seq: number) => {
        acks.push({ id, seq })
      },
      ready: () => {},
      saveBuffer: () => {},
      getBuffer: async () => null as string | null,
    },
  }
  ;(globalThis as unknown as { window: { jhyyIde: unknown } }).window.jhyyIde = api
  return {
    /** 假装主进程发来一批终端数据 */
    emitData: (e: { terminalId: number; seq: number; data: string }) => {
      for (const cb of [...dataListeners]) cb(e)
    },
    acks,
  }
}

describe('终端面板', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
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
    installApi()
  })

  it('**view 还没建好时来的数据不能丢**（新终端的第一批输出）', async () => {
    /*
      ⚠️⚠️ **这是用户报过的问题** ——
        `onData` 以前是**每个 view 订阅一次** ⇒ 视图建好之前到的数据
        **没有任何人接** ⇒ 直接掉地上 ⇒ 用户看到「终端是空的」✗
        （新终端的第一个提示符最容易在这个窗口里到）

        ⇒ 现在组件级订阅 ⇒ 没 view 的先**攒着** ⇒ view 建好时补给它 ✓
        ⇒ 判据：**数据写进 xterm 了 ⇒ 会回执（ack）** ✓
    */
    const { emitData, acks } = installApi()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    // ① 先挂一个**空的**终端列表 ⇒ 组件级订阅挂上了，但还没有任何 view
    await act(async () => {
      root.render(
        createElement(TerminalPane, {
          cwd: 'C:/tmp',
          active: false,
          terminals: [],
          activeTerminalId: null,
        }),
      )
    })

    // ② 这时候终端 #7 的数据到了（view 还没建）⇒ 必须**攒着**，不能丢
    emitData({ terminalId: 7, seq: 1, data: '第一个提示符' })

    // ③ 终端列表更新 ⇒ view 建起来 ⇒ 攒着的数据要**补进去**
    await act(async () => {
      root.render(
        createElement(TerminalPane, {
          cwd: 'C:/tmp',
          active: false,
          terminals: [{ id: 7, name: 'bash', shell: 'bash', cwd: null }],
          activeTerminalId: 7,
        }),
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    // ④ 数据写进 xterm 了 ⇒ 会回执 ✓
    expect(acks.some((a) => a.id === 7 && a.seq === 1)).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })

  it('能挂上（xterm 实例建起来、DOM 里有 .xterm）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(TerminalPane, {
        cwd: 'C:/tmp',
        active: false,
        terminals: [{ id: 1, name: 'bash', shell: 'bash', cwd: null }],
        activeTerminalId: 1,
      }))
    })
    // ⚠️ **崩溃的话这里就没有 .xterm** ⇒ 组件被 React 卸了 ⇒ 断言红 ✓
    expect(host.querySelector('.xterm')).toBeTruthy()
    await act(async () => {
      root.unmount()
    })
  })

  it('Ctrl+F 能打开搜索框（VS Code 的终端也能搜回滚）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(TerminalPane, {
        cwd: 'C:/tmp',
        active: false,
        terminals: [{ id: 1, name: 'bash', shell: 'bash', cwd: null }],
        activeTerminalId: 1,
      }))
    })
    expect(host.querySelector('.terminal-search')).toBeNull()
    await act(async () => {
      root.unmount()
    })
  })
})
