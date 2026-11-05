// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import * as Blockly from 'blockly/core'
import { DoubleClickWatcher } from '../../src/renderer/blocks/doubleClick'

/**
 * 块上的参数字段：**单击是下拉，双击是自己填**。
 *
 * ## 为什么单测要「造」一个字段
 *
 * 无头工作区（`Blockly.Workspace`）里的块**不渲染** ⇒ 字段没有 SVG 元素 ⇒
 * `initView()` 不会跑 ⇒ 挂不上监听。
 * ⇒ 所以这里**手工把字段组塞给它**、再调 `initView()` ⇒
 * ⇒ 走的**正是真应用里的那条路**（`Field.init()` → `initView()`）✓
 */

/** jsdom 里不一定有 `PointerEvent` ⇒ 退回 `MouseEvent`（字段只读坐标）✓ */
function pointerDown(el: Element, x = 10, y = 20): Event {
  const Ctor =
    (globalThis as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const ev = new Ctor('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  })
  el.dispatchEvent(ev)
  return ev
}

/** 造一个「渲染好了」的参数字段。 */
async function makeField(): Promise<{
  field: {
    getValue(): string
    initView(): void
    fieldGroup_: SVGGElement | null
    textElement_: SVGTextElement | null
  }
  group: SVGGElement
  text: SVGTextElement
}> {
  const { defineJhyyBlocks } = await import('../../src/renderer/blocks/definitions')
  defineJhyyBlocks()
  const Blockly = await import('blockly/core')
  const ws = new Blockly.Workspace()
  const block = ws.newBlock('jhyy_print')
  const field = block.getField('FMT') as unknown as {
    getValue(): string
    initView(): void
    fieldGroup_: SVGGElement | null
    textElement_: SVGTextElement | null
    constants_: Record<string, unknown>
  }
  // ⚠️ **字段组得先存在** —— 真应用里是 `Field.init()` 建的（在 `initView()` 之前）✓
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement
  field.fieldGroup_ = group
  // ⚠️ 无头工作区没渲染 ⇒ `getConstants()` 是 undefined ⇒ 得自己给一份 ✓
  field.constants_ = {
    FIELD_BORDER_RECT_RADIUS: 4,
    FIELD_TEXT_BASELINE_CENTER: false,
    FIELD_DROPDOWN_NO_BORDER_RECT_SHADOW: false,
    FIELD_DROPDOWN_SVG_ARROW: false,
    FIELD_DROPDOWN_SVG_ARROW_SIZE: 12,
    FIELD_DROPDOWN_SVG_ARROW_DATAURI: '',
  }
  try {
    field.initView()
  } catch {
    // ⚠️ `recomputeAriaContext` 要真工作区 ⇒ 抛了也**没关系**：
    //    我们要的东西（字段组、`<text>`、监听）在它之前就建好了 ✓
  }
  const text = field.textElement_ as SVGTextElement
  // jsdom 没有布局 ⇒ 给个盒子（不然 `openCustomEditor` 会因为「量不出大小」直接返回）
  text.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      width: 80,
      height: 16,
      right: 90,
      bottom: 36,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect
  return { field, group, text }
}

describe('双击自己填（探测器）', () => {
  it('单击 ⇒ 不触发', () => {
    const onDouble = vi.fn()
    const w = new DoubleClickWatcher(onDouble)
    const el = document.createElement('div')
    w.attach(el)
    pointerDown(el)
    expect(onDouble).not.toHaveBeenCalled()
  })

  it('连着两下（同一处）⇒ 触发一次', () => {
    const onDouble = vi.fn()
    const w = new DoubleClickWatcher(onDouble)
    const el = document.createElement('div')
    w.attach(el)
    pointerDown(el)
    pointerDown(el)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it('三下 ⇒ 触发一次（第二下是双击，第三下又变成「单击」——跟浏览器一个语义）', () => {
    const onDouble = vi.fn()
    const w = new DoubleClickWatcher(onDouble)
    const el = document.createElement('div')
    w.attach(el)
    pointerDown(el)
    pointerDown(el)
    pointerDown(el)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it('目标**就是**挂载的元素（点空白处）⇒ 也算双击', () => {
    // ⚠️ DOM 规范在「at target」阶段**只跑非捕获监听器** ⇒
    //    捕获阶段的监听器收不到 ⇒ 靠冒泡阶段那个兜底 ✓
    const onDouble = vi.fn()
    const w = new DoubleClickWatcher(onDouble)
    const el = document.createElement('div')
    w.attach(el)
    pointerDown(el)
    pointerDown(el)
    expect(onDouble).toHaveBeenCalledTimes(1)
  })

  it('两下离得远 ⇒ 不触发（那是拖块，不是双击）', () => {
    const onDouble = vi.fn()
    const w = new DoubleClickWatcher(onDouble)
    const el = document.createElement('div')
    w.attach(el)
    pointerDown(el, 10, 20)
    pointerDown(el, 300, 20)
    expect(onDouble).not.toHaveBeenCalled()
  })

  it('两下隔太久 ⇒ 不触发', () => {
    vi.useFakeTimers()
    try {
      const onDouble = vi.fn()
      const w = new DoubleClickWatcher(onDouble)
      const el = document.createElement('div')
      w.attach(el)
      pointerDown(el)
      vi.advanceTimersByTime(1000)
      pointerDown(el)
      expect(onDouble).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('双击自己填（接线）', () => {
  it('单击 ⇒ **不弹输入框**，也不拦 Blockly（单击还是原来那个下拉）', async () => {
    const { group, text } = await makeField()
    document.body.appendChild(group)
    let reachedBlockly = false
    // 祖先上的冒泡监听 = 模拟 Blockly 的手势（它挂在工作区上 ⇒ 祖先 ⇒ 冒泡）✓
    document.body.addEventListener('pointerdown', () => {
      reachedBlockly = true
    })
    pointerDown(text)
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(reachedBlockly).toBe(true)
  })

  it('双击 ⇒ 弹出输入框，内容**全选中**', async () => {
    const { field, group, text } = await makeField()
    document.body.appendChild(group)
    pointerDown(text)
    pointerDown(text)
    const inputs = document.querySelectorAll('input')
    expect(inputs).toHaveLength(1)
    const input = inputs[0] as HTMLInputElement
    expect(input.value).toBe(field.getValue())
    // ⚠️ 「看到选中态大多数人可能下意识就会输入」（用户原话）✓
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('双击 ⇒ **拦住 Blockly**（不然下拉会弹回来 / 块会被拖走）', async () => {
    const { group, text } = await makeField()
    document.body.appendChild(group)
    let reachedBlockly = 0
    document.body.addEventListener('pointerdown', () => {
      reachedBlockly++
    })
    pointerDown(text)
    expect(reachedBlockly).toBe(1)
    pointerDown(text)
    // ⇒ 第二下**没到**祖先 ⇒ Blockly 看不到它 ✓
    expect(reachedBlockly).toBe(1)
  })

  it('双击 ⇒ 关掉单击时打开的下拉', async () => {
    const { group, text } = await makeField()
    document.body.appendChild(group)
    const hide = vi.spyOn(Blockly.DropDownDiv, 'hide').mockImplementation(() => {})
    pointerDown(text)
    pointerDown(text)
    expect(hide).toHaveBeenCalled()
    hide.mockRestore()
  })
})
