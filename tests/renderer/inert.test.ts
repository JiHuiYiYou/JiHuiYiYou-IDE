// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

/**
 * `inert` 属性。
 *
 * ⚠️ **HTML 的布尔属性是「有就是真」** —— `inert="false"` 照样是 inert！
 * 如果 React 把 `inert={false}` 渲染成 `inert="false"`，那这个元素就**不能聚焦、
 * 不能选中** ⇒ 编辑器看着就像只读的。
 *
 * 这条钉住 React 对 `inert` 的处理（React 19 把它当布尔属性）。
 */
describe('inert 属性', () => {
  it('inert={false} 不该渲染成 inert="false"', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement('div', { inert: false, id: 'target' }))
    })
    const el = host.querySelector('#target') as HTMLElement
    expect(el.hasAttribute('inert')).toBe(false)
    root.unmount()
  })

  it('inert={true} 该渲染成 inert', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(createElement('div', { inert: true, id: 'target2' }))
    })
    const el = host.querySelector('#target2') as HTMLElement
    expect(el.hasAttribute('inert')).toBe(true)
    root.unmount()
  })
})
