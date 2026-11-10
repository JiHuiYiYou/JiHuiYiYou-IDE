// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../src/renderer/App'

/**
 * **App 的文件生命周期** —— 打开 / 保存 / 外部改动 / 切标签。
 *
 * ⚠️ **为什么要有这个测试** ——
 *   「编辑器持有文本」那次重构动的是 **App 的整个文件生命周期**
 *   （打开 / 新建 / 切换 / 关闭 / 存盘 / 另存为 / 重新加载 / 历史跳转）
 *   ⇒ 而这些路径**一个都没有单测** ⇒
 *   ⇒ 「App 挂上去就崩」「打开的文件不在标签上」「存盘写错内容」
 *   这些都是**用户立刻能看见**的 ⇒ 必须有网 ✓
 *
 * ⚠️ **用的是假的 `window.jhyyIde`** —— 主进程那侧不参与 ✓
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

// jsdom 没实现 `Element.scrollTo`（聊天面板滚到底用它）
Element.prototype.scrollTo = function scrollTo(): void {
  /* 什么都不用做 —— 测试不看滚动 */
}

/** 假的主进程 API。 */
interface FakeApi {
  api: Record<string, unknown>
  /** 打开的文件（路径 → 内容） */
  disk: Map<string, string>
  /** 写盘记录 */
  writes: { path: string; content: string }[]
  /** 触发「磁盘上被改了」 */
  emitChanged(path: string, internal: boolean): void
}

function installApi(startup: { path: string; content: string } | null): FakeApi {
  const disk = new Map<string, string>()
  if (startup) disk.set(startup.path, startup.content)
  const writes: { path: string; content: string }[] = []
  let onChanged: ((e: { path: string; internal: boolean }) => void) | null = null

  const api = {
    toolchain: {
      locate: async () => ({ available: true, exePath: 'jhyy.exe', versionText: 'v1' }),
      setPath: async () => ({ available: true, exePath: 'jhyy.exe', versionText: 'v1' }),
    },
    file: {
      initial: async () =>
        startup ? { path: startup.path, content: startup.content, bytes: startup.content.length } : null,
      openDialog: async () => null,
      saveDialog: async () => null,
      read: async (path: string) => {
        const content = disk.get(path) ?? ''
        return { content, bytes: content.length }
      },
      write: async (path: string, content: string) => {
        writes.push({ path, content })
        disk.set(path, content)
      },
      watch: async () => {},
      onChanged: (cb: (e: { path: string; internal: boolean }) => void) => {
        onChanged = cb
        return () => {
          onChanged = null
        }
      },
      cwd: async () => 'C:\\work',
    },
    ide: { setContext: () => {} },
    window: { setEdited: () => {} },
    jhyy: {
      compile: async () => ({ ok: true, diagnostics: [], raw: [], durationMs: 1 }),
      run: async () => ({
        ok: true,
        diagnostics: [],
        raw: [],
        ran: true,
        exitCode: 0,
        crashed: false,
        crashName: '',
        timedOut: false,
        truncated: false,
        terminalClosed: false,
        durationMs: 1,
      }),
      stop: async () => {},
      onOutput: () => () => {},
    },
    terminal: {
      backend: async () => ({ backend: 'pipe' }),
      onBackendChange: () => () => {},
      list: async () => [],
      onList: () => () => {},
      onState: () => () => {},
      onExit: () => () => {},
      onCommand: () => () => {},
      onData: () => () => {},
      onRestart: () => () => {},
      create: async () => 1,
      select: async () => {},
      close: async () => {},
      ack: async () => {},
      saveBuffer: async () => '',
      getBuffer: async () => '',
      ready: async () => {},
      start: async () => {},
      write: async () => {},
      resize: async () => {},
      cd: async () => {},
      display: async () => {},
    },
    claude: {
      locate: async () => ({ path: 'claude' }),
      start: async () => ({ ok: true }),
      send: async () => true,
      stop: async () => {},
      onEvent: () => () => {},
      onStatus: () => () => {},
    },
  }
  ;(globalThis as unknown as { window: { jhyyIde: unknown } }).window.jhyyIde = api
  return {
    api,
    disk,
    writes,
    emitChanged: (path, internal) => onChanged?.({ path, internal }),
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  localStorage.clear()
})

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

/** 挂 App。 */
function mount(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(createElement(App))
  })
  return host
}

/** 标签上的文字。 */
function tabTexts(): string[] {
  return [...(host?.querySelectorAll('.editor-tab-label') ?? [])].map((e) => e.textContent ?? '')
}

/** 编辑器里显示的文字。 */
function editorText(): string {
  const content = host?.querySelector('.cm-content') as HTMLElement | null
  return content?.textContent ?? ''
}

/** 按一个快捷键。 */
function pressKey(key: string, opts: { ctrl?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: opts.ctrl ?? false,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

describe('App —— 启动时打开命令行带来的文件', () => {
  it('标签上有那个文件，编辑器里是它的内容', async () => {
    installApi({ path: 'C:\\work\\a.jhyy', content: 'fn main_jhyy() -> i32 {\n    0\n}\n' })
    mount()
    // ⚠️ `file.initial()` 是异步的 ⇒ 等一拍
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(tabTexts()).toEqual(['a.jhyy'])
    expect(editorText()).toContain('main_jhyy')
  })

  it('没有文件 ⇒ 显示欢迎页', async () => {
    installApi(null)
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(tabTexts()).toEqual([])
    expect(host?.querySelector('.welcome-view, .welcome') ?? host?.textContent).toBeTruthy()
  })
})

describe('App —— 存盘', () => {
  it('Ctrl+S ⇒ 写盘写的是编辑器里那份内容', async () => {
    const fake = installApi({ path: 'C:\\work\\a.jhyy', content: 'AAA\n' })
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    pressKey('s', { ctrl: true })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // ⚠️ **写的是编辑器里那份**（不是打开时那份）——
    //   以前 `App` 里存着两份全文 ⇒ 很容易写错那一份 ✗
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0].path).toBe('C:\\work\\a.jhyy')
    expect(fake.writes[0].content).toBe('AAA\n')
  })
})

describe('App —— 磁盘上被改了', () => {
  it('内部改动（Claude 改的）⇒ 直接把内容换掉', async () => {
    const fake = installApi({ path: 'C:\\work\\a.jhyy', content: 'AAA\n' })
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    fake.disk.set('C:\\work\\a.jhyy', 'BBB\n')
    await act(async () => {
      fake.emitChanged('C:\\work\\a.jhyy', true)
      await new Promise((r) => setTimeout(r, 0))
    })
    // ⚠️ **编辑器里要换成新的内容** ——
    //   以前这一步是「改 App 的 state 里的 source」⇒
    //   现在文本在编辑器里 ⇒ 得**真的改编辑器** ⇒ 否则屏幕上是旧的 ✗
    expect(editorText()).toContain('BBB')
  })

  it('外部改动 ⇒ 不动内容（等用户决定）', async () => {
    const fake = installApi({ path: 'C:\\work\\a.jhyy', content: 'AAA\n' })
    mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    fake.disk.set('C:\\work\\a.jhyy', 'BBB\n')
    await act(async () => {
      fake.emitChanged('C:\\work\\a.jhyy', false)
      await new Promise((r) => setTimeout(r, 0))
    })
    // ⚠️ **外部改动不能偷偷改用户正在看的内容** ✓
    expect(editorText()).toContain('AAA')
    expect(editorText()).not.toContain('BBB')
  })
})
