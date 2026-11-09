// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import StatusBar from '../../src/renderer/workbench/StatusBar'

/**
 * 状态栏上那个 **PTY 徽章**。
 *
 * ⚠️ 为什么要有它 —— node-pty 起不来时终端会**静悄悄**退成管道版
 *    （用户报过「终端一会真一会假的」）⇒ 用户**看不出来**⇒
 *    ⇒ 徽章把「现在是真控制台还是管道兜底」摆在明面上 ✓。
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = null
  }
})

function render(
  ptyBackend: { backend: 'node-pty' | 'pipe'; reason?: string } | null,
  message?: { text: string; kind: 'bad' },
): string {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      createElement(StatusBar, {
        diagnostics: [],
        toolchain: null,
        ptyBackend,
        message,
        view: 'code',
      }),
    )
  })
  return container.textContent ?? ''
}

describe('状态栏的 PTY 徽章', () => {
  it('真控制台 ⇒ 写「PTY」', () => {
    expect(render({ backend: 'node-pty' })).toContain('PTY')
  })

  it('管道兜底 ⇒ 写「管道」，而且 title 里说清原因', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(StatusBar, {
            diagnostics: [],
          toolchain: null,
          ptyBackend: { backend: 'pipe', reason: 'node-pty 模块没装' },
          message: undefined,
          view: 'code',
        }),
      )
    })
    expect(container.textContent ?? '').toContain('管道')
    const badge = container.querySelector('.status-item.warn')
    expect(badge?.getAttribute('title') ?? '').toContain('node-pty 模块没装')
  })

  it('还没探出来 ⇒ 不显示徽章（别先闪一个假的）', () => {
    expect(render(null)).not.toContain('PTY')
    expect(render(null)).not.toContain('管道')
  })
})

/**
 * **状态栏**不再显示**程序行为**。
 *
 * ⚠️ 用户明说：「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
 *    ⇒ 「运行中…」「退出码 42」「已保存…」「降级运行…」**全都不显示** ✓
 *    ⇒ **类型限死成 `'bad'`** ⇒ 编译器替你把关（写错了编译不过）✓✓
 *    ⇒ 运行状态改到**终端页签**上（转圈 / ✓ / ✗）✓
 */
describe('状态栏上的程序行为', () => {
  it('**类型只允许 bad** ⇒ 「退出码 42」这种消息根本传不进来', () => {
    const message = { text: '运行结束，退出码 42（12ms）', kind: 'info' }
    // @ts-expect-error ⚠️ **故意的** —— 类型限死了 ⇒ 写程序行为就编译不过 ✓
    const wrong: { text: string; kind: 'bad' } = message
    expect(wrong.text).toContain('退出码 42')
  })

  it('出错的消息**照常显示**（编译失败、运行失败那种）', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(StatusBar, {
            diagnostics: [],
          toolchain: null,
          ptyBackend: null,
          message: { text: '编译失败（12ms）', kind: 'bad' },
          view: 'code',
        }),
      )
    })
    expect(container.textContent ?? '').toContain('编译失败')
    const item = container.querySelector('.status-item.message')
    expect(item?.className).toContain('bad')
  })

  it('**不再**提示「块视图已过期」（用户明说那个黄点没意义）', () => {
    expect(render(null)).not.toContain('块视图已过期')
  })
})
