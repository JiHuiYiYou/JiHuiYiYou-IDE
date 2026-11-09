// @vitest-environment jsdom
import { EditorView } from '@codemirror/view'
import { describe, it } from 'vitest'
import { createEditorState } from '../../src/renderer/editor/codemirror'
import { sourceToBlocks } from '../../src/renderer/sync/doc'

/**
 * **编辑器性能基准** —— 量一量「大文件」到底卡在哪。
 *
 * ⚠️ **默认不跑** —— 要显式开：
 * ```bash
 * JHY_BENCH=1 npx vitest run tests/renderer/editorBench.test.ts
 * ```
 *
 * ⚠️ **为什么要有它** ——
 *   「打开大文件慢」这种问题，**光看代码看不出来** ⇒
 *   ⇒ 得有一个能重复量的数 ⇒
 *   ⇒ 以后谁动了编辑器这一层，**跑一遍就知道有没有变慢** ✓
 *
 * ⚠️ **在 jsdom 里量** —— 比真浏览器慢（jsdom 没有真布局）⇒
 *   ⇒ **绝对值没意义**，**比值有意义**（新架构 vs 旧架构）✓
 */

/** 造一份「大文件」源码（语法正确 ⇒ 块树那步能真的跑完）。 */
function makeBigSource(lines: number): string {
  const parts: string[] = ['// 自动生成的大文件（基准用）\n\n']
  for (let i = 0; i < lines; i++) {
    parts.push(`fn helper_${i}(x: i32) -> i32 {\n    x + ${i}\n}\n\n`)
  }
  parts.push('fn main_jhyy() -> i32 {\n    0\n}\n')
  return parts.join('')
}

function bench(label: string, fn: () => void): number {
  const t = performance.now()
  fn()
  const ms = performance.now() - t
  console.log(`  ${label}：${ms.toFixed(1)} ms`)
  return ms
}

/** 默认跳过 —— 只在 `JHY_BENCH=1` 时跑。 */
const benchIt = process.env.JHY_BENCH ? it : it.skip

describe('编辑器性能基准', () => {
  benchIt('大文件（1.4 MB / 12 万行）', () => {
    const raw = makeBigSource(30000)
    console.log(`文件：${(raw.length / 1024 / 1024).toFixed(2)} MB`)

    /*
      ⚠️ **旧架构**：打开文件时**就**把源码解析成块树 ⇒
      ⇒ 这一步是「打开大文件」里最大的一笔开销 ✗✗
      ⇒ ⇒ 现在**懒建**（切到块视图时才建）⇒ 打开时是 **0 ms** ✓
    */
    bench('【旧】打开时建块树（sourceToBlocks）', () => {
      sourceToBlocks(raw)
    })

    let state = createEditorState(raw, {})
    bench('【新】打开文件（建 EditorState）', () => {
      state = createEditorState(raw, {})
    })

    /*
      ⚠️ **先热身一次** ——
      进程里**第一次**建视图有一笔**一次性**的初始化开销
      （样式挂载、模块初始化 …）⇒ 不热身的话那个数会被它盖住 ⇒
      ⇒ 量出来的就不是「跟文件大小有没有关系」了 ✗
    */
    const warmHost = document.createElement('div')
    document.body.appendChild(warmHost)
    new EditorView({ state: createEditorState('fn main_jhyy() -> i32 { 0 }\n', {}), parent: warmHost }).destroy()

    const host = document.createElement('div')
    document.body.appendChild(host)
    let view!: EditorView
    bench('建视图（首屏）', () => {
      view = new EditorView({ state, parent: host })
    })

    /*
      ⚠️ **新架构**：每次按键**只报「变了」** ⇒ O(1) ✓
      ⚠️ **旧架构**：每次按键都 `doc.toString()`（把整份文件重新物化成字符串）⇒ O(n) ✗
    */
    bench('【新】打 20 个字', () => {
      for (let i = 0; i < 20; i++) view.dispatch({ changes: { from: 0, insert: 'x' } })
    })
    bench('【旧】打 20 个字（每次 doc.toString()）', () => {
      for (let i = 0; i < 20; i++) {
        view.state.doc.toString()
        view.state.doc.toString() !== raw
      }
    })

    // 切标签：新的 `setState` 是 O(1)；旧的是「逐字符最长公共前后缀」⇒ O(n) ✗
    const other = createEditorState(raw, {})
    bench('【新】切 5 次标签（setState）', () => {
      for (let i = 0; i < 5; i++) view.setState(i % 2 === 0 ? other : state)
    })
    bench('【旧】切 5 次标签（逐字符求公共前后缀）', () => {
      for (let i = 0; i < 5; i++) {
        const cur = view.state.doc.toString()
        let prefix = 0
        const maxPrefix = Math.min(cur.length, raw.length)
        while (prefix < maxPrefix && cur[prefix] === raw[prefix]) prefix++
        void prefix
      }
    })

    view.destroy()
  })
})
