// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '@shared/claude'
import ChatPane from '../../src/renderer/panes/ChatPane'

/**
 * 聊天面板的**折叠**行为。
 *
 * ⚠️ 用户提的：以前 AI 的思考过程、工具调用一条条直接打出来，
 * 一轮下来能刷十几行，把真正的回答挤出屏幕。
 * 现在：
 * - **进行中** ⇒ 只显示一行状态（「正在思考…」/「正在调用工具 Read…」）
 * - **出了最终回答** ⇒ 过程整个收进一个折叠块，摘要就一行「已完成」
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

// jsdom 没实现 `Element.scrollTo`（聊天面板滚到底用它）
Element.prototype.scrollTo = function scrollTo(): void {
  /* 什么都不用做 —— 测试不看滚动 */
}

type EventHandler = (e: ClaudeEvent) => void

/** 装一个假的 `window.jhyyIde`（聊天面板用到的那几个方法）。 */
function installApi() {
  let onEvent: EventHandler | null = null
  let onStatus: ((s: unknown) => void) | null = null
  const api = {
    claude: {
      locate: async () => ({ path: 'claude', version: '2.1.302' }),
      start: async () => ({ ok: true }),
      send: async () => true,
      stop: async () => {},
      onEvent: (cb: EventHandler) => {
        onEvent = cb
        return () => {
          onEvent = null
        }
      },
      onStatus: (cb: (s: unknown) => void) => {
        onStatus = cb
        return () => {
          onStatus = null
        }
      },
    },
    file: { cwd: async () => 'C:\\work' },
  }
  ;(globalThis as unknown as { window: { jhyyIde: unknown } }).window.jhyyIde = api
  return {
    emit: (e: ClaudeEvent) => onEvent?.(e),
    status: (s: unknown) => onStatus?.(s),
  }
}

/** 渲染聊天面板并返回宿主页 + 事件发射器。 */
async function mount() {
  const bridge = installApi()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ChatPane, { filePath: 'C:\\work\\a.jhyy' }))
  })
  return { host, bridge }
}

/** 在输入框里打字并回车发送。 */
async function send(host: HTMLElement, text: string): Promise<void> {
  const textarea = host.querySelector('.chat-textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('聊天面板的折叠', () => {
  it('进行中只显示一行状态，出了最终回答才折叠成「已完成」', async () => {
    const { host, bridge } = await mount()

    await send(host, '你好')

    // 用户那句话在
    expect(host.querySelector('.bubble.user')?.textContent).toBe('你好')
    // 还没有回答 ⇒ 没有折叠块
    expect(host.querySelector('details.chat-turn-steps')).toBeNull()

    // 思考中 ⇒ 一行状态
    await act(async () => {
      bridge.emit({ type: 'thinking-delta', text: '让我想想' })
    })
    const activity = host.querySelector('.bubble.activity')?.textContent ?? ''
    expect(activity).toContain('正在思考')
    // 思考过程**没有**被一条条打出来
    expect(host.querySelector('.bubble.thinking')).toBeNull()

    // 调用工具 ⇒ 状态换成「正在调用工具 …」
    await act(async () => {
      bridge.emit({
        type: 'message',
        message: {
          role: 'assistant',
          thinking: '让我想想',
          toolUses: [{ id: 't1', name: 'Read', input: { file_path: 'a.jhyy' } }],
        },
      })
    })
    expect(host.querySelector('.bubble.activity')?.textContent ?? '').toContain('Read')
    // 工具调用**没有**被一条条打出来
    expect(host.querySelector('.bubble.tool')).toBeNull()

    // 最终回答到了 ⇒ **这一轮还没结束**（模型可能接着调工具）
    //    ⇒ 此刻**不能**标「已完成」
    await act(async () => {
      bridge.emit({
        type: 'message',
        message: { role: 'assistant', text: '收到' },
      })
    })
    expect(host.querySelector('details.chat-turn-steps'), '还没结束就不该折叠').toBeNull()
    expect(host.querySelector('.bubble.assistant')?.textContent).toBe('收到')

    // 这一轮真的结束了（CLI 的 result 事件）⇒ 折叠成一行「已完成」
    await act(async () => {
      bridge.status({ state: 'waiting', turnComplete: true })
    })
    const details = host.querySelector('details.chat-turn-steps')
    expect(details).toBeTruthy()
    expect(details!.querySelector('summary')?.textContent).toBe('已完成')
    expect(host.querySelector('.bubble.assistant')?.textContent).toBe('收到')
    // 状态行没了
    expect(host.querySelector('.bubble.activity')).toBeNull()
    // 折叠块里能看到思考和工具调用（展开后）
    expect(details!.textContent).toContain('让我想想')
    expect(details!.textContent).toContain('Read')
  })

  it('回答还没来就结束了 ⇒ 流式文本也要显示出来（别被吞）', async () => {
    const { host, bridge } = await mount()
    await send(host, '你好')
    // 有些 CLI 版本只发增量、不发完整消息
    await act(async () => {
      bridge.emit({ type: 'delta', text: '半句回答' })
    })
    await act(async () => {
      bridge.status({ state: 'waiting', turnComplete: true })
    })
    expect(host.querySelector('.bubble.assistant')?.textContent).toContain('半句回答')
  })

  it('多轮对话各自折叠', async () => {
    const { host, bridge } = await mount()

    await send(host, '第一句')
    await act(async () => {
      bridge.emit({ type: 'message', message: { role: 'assistant', text: '回答一' } })
      bridge.status({ state: 'waiting', turnComplete: true })
    })
    await send(host, '第二句')
    await act(async () => {
      bridge.emit({ type: 'message', message: { role: 'assistant', text: '回答二' } })
      bridge.status({ state: 'waiting', turnComplete: true })
    })

    const turns = host.querySelectorAll('.chat-turn')
    expect(turns.length).toBe(2)
    expect(host.querySelectorAll('details.chat-turn-steps').length).toBe(2)
    expect(host.querySelectorAll('.bubble.assistant').length).toBe(2)
  })
})

/**
 * 历史会话要**真的存下来**。
 *
 * ⚠️ 以前只在「消息数变了」的时候存 —— 而第一条消息是在 `claude.start()`
 * 返回**之后**才发出去的，CLI 的 `system/init` 事件（带 sessionId）**那时候
 * 还没到** ⇒ sessionId 是空的 ⇒ 直接 return ⇒ **历史永远存不下来**
 * （用户报过「即使有 ai 的历史对话，也不会显示出来，依旧是空的」）。
 */
describe('历史会话', () => {
  it('sessionId 到了就把这次会话存进历史', async () => {
    localStorage.clear()
    const { host, bridge } = await mount()

    await send(host, '帮我写个 hello world')
    // 此刻 CLI 的 init 事件还没来 ⇒ sessionId 还是空的
    expect(localStorage.getItem('jhyy-ide.claude-sessions.v1')).toBeNull()

    // init 事件到了
    await act(async () => {
      bridge.status({ state: 'running', sessionId: 'sess-123' })
    })

    const raw = localStorage.getItem('jhyy-ide.claude-sessions.v1')
    expect(raw, '会话应该被存进历史了').toBeTruthy()
    const list = JSON.parse(raw!) as { sessionId: string; title: string }[]
    expect(list.length).toBe(1)
    expect(list[0].sessionId).toBe('sess-123')
    expect(list[0].title).toContain('hello world')
  })

  it('重开面板能从 localStorage 里读回历史', async () => {
    localStorage.setItem(
      'jhyy-ide.claude-sessions.v1',
      JSON.stringify([{ sessionId: 'sess-abc', title: '上次的会话', cwd: 'C:\\w', ts: 1 }]),
    )
    const { host } = await mount()
    // 点开「历史会话」下拉
    const btn = [...host.querySelectorAll('.icon-button')].find(
      (b) => b.getAttribute('title') === '历史会话',
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const items = [...host.querySelectorAll('.chat-history-item-title')]
    expect(items.map((e) => e.textContent)).toContain('上次的会话')
    localStorage.clear()
  })

  /**
   * 点历史会话 ⇒ **对话要出现在界面上**。
   *
   * ⚠️ `claude --resume` 只是把对话**接上**，**不会**把历史消息再吐一遍 ⇒
   *   历史得由 IDE 自己存、自己还原（用户报过「点历史会话然后点其中一个，
   *   还是没有历史对话」）。
   */
  it('点历史会话能把对话填回界面', async () => {
    localStorage.setItem(
      'jhyy-ide.claude-sessions.v1',
      JSON.stringify([
        {
          sessionId: 'sess-1',
          title: '上次说的',
          cwd: 'C:\\w',
          ts: 1,
          turns: [
            { userText: '第一个问题', answer: '第一个回答', steps: [] },
            { userText: '第二个问题', answer: '第二个回答', steps: [] },
          ],
        },
      ]),
    )
    const { host } = await mount()
    const btn = [...host.querySelectorAll('.icon-button')].find(
      (b) => b.getAttribute('title') === '历史会话',
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const item = host.querySelector('.chat-history-item') as HTMLElement
    expect(item).toBeTruthy()
    await act(async () => {
      item.click()
    })

    // 两轮对话都在
    expect(host.querySelectorAll('.chat-turn').length).toBe(2)
    expect(host.querySelector('.bubble.user')?.textContent).toBe('第一个问题')
    expect(host.querySelector('.bubble.assistant')?.textContent).toContain('第一个回答')
    localStorage.clear()
  })
})
