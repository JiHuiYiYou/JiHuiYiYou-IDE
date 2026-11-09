// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CLAUDE_CONTEXT_MAX_KB,
  MAX_LARGE_FILE_THRESHOLD,
  MIN_CLAUDE_CONTEXT_MAX_KB,
  MIN_LARGE_FILE_THRESHOLD,
} from '../../src/renderer/editor/largeFile'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from '../../src/renderer/state/settings'
import SettingsDialog from '../../src/renderer/workbench/SettingsDialog'

/**
 * **用户设置** —— 编辑区的字体/字号。
 *
 * ⚠️ 以前**根本没有设置**（编辑区的字号是继承 `body { font-size: 13px }` 来的）
 *    ⇒ 现在有了 ⇒ 默认是 **MV Boli / 12px**（用户要的）✓
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const KEY = 'jhyy-ide.settings.v1'

describe('用户设置', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认是 MV Boli / 12px', () => {
    expect(DEFAULT_SETTINGS.editorFontSize).toBe(12)
    expect(DEFAULT_SETTINGS.editorFontFamily).toContain('MV Boli')
    // ⚠️ 后面得有等宽兜底 ⇒ 别的机器上也能正常显示 ✓
    expect(DEFAULT_SETTINGS.editorFontFamily).toContain('monospace')
  })

  it('存了再读回来还是一样', () => {
    const s = { ...DEFAULT_SETTINGS, editorFontFamily: 'Consolas', editorFontSize: 18 }
    saveSettings(s)
    expect(loadSettings()).toEqual(s)
  })

  it('没存过 ⇒ 默认值', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('localStorage 里是坏的 ⇒ 默认值（不能崩）', () => {
    localStorage.setItem(KEY, '{ 这不是 JSON')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('字号不靠谱 ⇒ 夹到合理范围', () => {
    localStorage.setItem(KEY, JSON.stringify({ editorFontSize: 9999 }))
    expect(loadSettings().editorFontSize).toBe(48)
    localStorage.setItem(KEY, JSON.stringify({ editorFontSize: -5 }))
    expect(loadSettings().editorFontSize).toBe(8)
    localStorage.setItem(KEY, JSON.stringify({ editorFontSize: 'abc' }))
    expect(loadSettings().editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
  })

  it('字体是空字符串 ⇒ 默认值', () => {
    localStorage.setItem(KEY, JSON.stringify({ editorFontFamily: '   ' }))
    expect(loadSettings().editorFontFamily).toBe(DEFAULT_SETTINGS.editorFontFamily)
  })

  /*
    ⚠️ **大文件阈值 / Claude 上下文上限** ——
      这两个是「大文件模式」的旋钮 ⇒ 存进 localStorage ⇒ 重开窗口还在 ✓
  */
  it('大文件阈值和 Claude 上限都存得住', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      largeFileThreshold: 2 * 1024 * 1024,
      claudeContextMaxKb: 512,
    }
    saveSettings(s)
    expect(loadSettings()).toEqual(s)
  })

  it('阈值 / 上限不靠谱 ⇒ 夹到合理范围', () => {
    localStorage.setItem(KEY, JSON.stringify({ largeFileThreshold: 999999999 }))
    expect(loadSettings().largeFileThreshold).toBe(MAX_LARGE_FILE_THRESHOLD)
    localStorage.setItem(KEY, JSON.stringify({ largeFileThreshold: -1 }))
    expect(loadSettings().largeFileThreshold).toBe(MIN_LARGE_FILE_THRESHOLD)
    localStorage.setItem(KEY, JSON.stringify({ claudeContextMaxKb: 0 }))
    expect(loadSettings().claudeContextMaxKb).toBe(MIN_CLAUDE_CONTEXT_MAX_KB)
    localStorage.setItem(KEY, JSON.stringify({ claudeContextMaxKb: 999999 }))
    expect(loadSettings().claudeContextMaxKb).toBe(MAX_CLAUDE_CONTEXT_MAX_KB)
  })
})

describe('编辑区的字体/字号', () => {
  it('走 **CSS 变量** ⇒ 改了变量就生效（不用重建编辑器）', async () => {
    const { createCodeEditor } = await import('../../src/renderer/editor/codemirror')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = createCodeEditor(host, { doc: 'let x = 1;' })
    const content = host.querySelector('.cm-content') as HTMLElement
    // ⚠️ jsdom 不会解析 `var()` ⇒ 只能断言「**用的是变量**」，
    //    真正的值由浏览器解析 ✓
    expect(window.getComputedStyle(content).fontFamily).toContain('--editor-font-family')
    expect(window.getComputedStyle(content).fontSize).toContain('--editor-font-size')
    view.destroy()
  })
})

describe('设置对话框', () => {
  it('能挂上（字体/字号两个输入框都在）', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        createElement(SettingsDialog, {
          open: true,
          settings: DEFAULT_SETTINGS,
          onChange: () => {},
          onClose: () => {},
        }),
      )
    })
    expect(host.querySelector('#jhyy-setting-font')).toBeTruthy()
    expect(host.querySelector('#jhyy-setting-size')).toBeTruthy()
    act(() => root.unmount())
  })

  it('关着的时候什么都不渲染', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        createElement(SettingsDialog, {
          open: false,
          settings: DEFAULT_SETTINGS,
          onChange: () => {},
          onClose: () => {},
        }),
      )
    })
    expect(host.querySelector('.settings-dialog')).toBeNull()
    act(() => root.unmount())
  })

  it('改字号 ⇒ 立刻回调（VS Code 的设置就是这样的）', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const changes: number[] = []
    act(() => {
      root.render(
        createElement(SettingsDialog, {
          open: true,
          settings: DEFAULT_SETTINGS,
          onChange: (s) => changes.push(s.editorFontSize),
          onClose: () => {},
        }),
      )
    })
    const input = host.querySelector('#jhyy-setting-size') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(input, '20')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(changes).toContain(20)
    act(() => root.unmount())
  })
})
