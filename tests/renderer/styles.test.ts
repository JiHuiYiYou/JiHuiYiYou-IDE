import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const raw = readFileSync(join(here, '../../src/renderer/styles.css'), 'utf8')
/** 去掉注释 —— 注释里也会出现这些关键字 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 样式表里的**继承陷阱**。
 *
 * ⚠️ CodeMirror 6 **自己一个 `user-select` 都不设** —— 它靠继承。
 * 所以 `body { user-select: none }` 会一路继承进编辑器的 contenteditable：
 * 选不中文字、不能编辑、光标不走（跟只读模式一模一样）。
 *
 * 这个坑踩过一次 —— 所以钉在这儿。
 */
describe('styles.css', () => {
  it('body 上不能有 user-select: none（CodeMirror 靠继承）', () => {
    const bodyRule = css.match(/(?:^|\})\s*body\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(bodyRule).not.toMatch(/user-select\s*:\s*none/)
  })

  it('编辑器要显式给 user-select: text', () => {
    expect(css).toMatch(/\.code-pane[^{]*\{[^}]*user-select\s*:\s*text/)
  })

  it('终端也要显式给 user-select: text', () => {
    expect(css).toMatch(/\.terminal-pane[^{]*\{[^}]*user-select\s*:\s*text/)
  })

  it('终端的搜索框也要能选中（不然鼠标选不了搜索词）', () => {
    expect(css).toMatch(/\.terminal-search[^{]*\{[^}]*user-select\s*:\s*text/)
  })

  it('藏起来的视图用 visibility 而不是 display:none（Blockly 的坐标系会崩）', () => {
    const rule = css.match(/\[data-hidden='true'\][^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/visibility\s*:\s*hidden/)
    expect(rule).not.toMatch(/display\s*:\s*none/)
  })

  it('终端的 padding 必须在 **xterm 挂的那一层**（FitAddon 减的就是它）', () => {
    // ⚠️ **FitAddon 减的是「xterm 的父元素」的 padding** ——
    //    以前 padding 在外层 `.terminal-pane` 上 ⇒ 它减的是 `.xterm` 自己
    //    的 padding（= 0）⇒ **那 8px 压根没减掉** ⇒ **多算一行**
    //    ⇒ 最后一行被裁掉 ✗
    expect(css).toMatch(/\.terminal-pane-inner[^{]*\{[^}]*padding/)
    const outer = css.match(/(?:^|\})\s*\.terminal-pane\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(outer).not.toMatch(/padding\s*:/)
  })

  it('终端名旁边的退出码**不能用红色**（退出码不是「失败」的判据）', () => {
    // ⚠️ JHYY 的 `main_jhyy() -> i32` **返回值就是进程退出码** ⇒
    //    程序自己返回什么就是什么 ⇒ 非 0 **不等于出错** ⇒ 不能用红色（用户明说）✓
    const rule = css.match(/\.terminal-tab\s+\.terminal-tab-badge[^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toMatch(/var\(--error\)/)
  })

  it('**没有**「块视图已过期」的小黄点（用户明说那个没意义）', () => {
    // ⚠️ 文本视图改了代码，块视图**不用**再标小黄点 ——
    //    「本来如果要用用户自然回去点，所以这个黄点就没有存在的意义」✓
    expect(css).not.toMatch(/\.icon-badge/)
  })
})
