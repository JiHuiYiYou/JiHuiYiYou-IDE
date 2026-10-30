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

  it('藏起来的视图用 visibility 而不是 display:none（Blockly 的坐标系会崩）', () => {
    const rule = css.match(/\[data-hidden='true'\][^{]*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/visibility\s*:\s*hidden/)
    expect(rule).not.toMatch(/display\s*:\s*none/)
  })
})
