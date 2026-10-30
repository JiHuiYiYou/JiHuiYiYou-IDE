// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { indentOnInput } from '@codemirror/language'
import { jhyyLanguage } from '../../src/renderer/editor/jhyyLanguage'

/**
 * 语言数据（`languageData`）的形状检查 —— **这条断言钉的是「编辑器能不能打字」**。
 *
 * CodeMirror 的 `indentOnInput()` 是个**事务过滤器**：每次输入都读语言数据里的
 * `indentOnInput` 字段，然后 `rules.some(r => r.test(lineStart))`。
 *
 * 之前这里写的是 `indentOnInput: true` ⇒ `true.test` 不是函数 ⇒ **抛 TypeError**
 * ⇒ 整个事务被丢掉 ⇒ **编辑器里的字打不进去**（用户报过「编译器又变成只读的了」，
 * 而且极难查 —— 界面完全正常，只是字进不去）。
 *
 * 文档原文：*which must hold a regular expression*。
 */
describe('JHYY 语言数据', () => {
  it('indentOnInput 必须是正则（或带 test 方法的对象），不能是 true', () => {
    const state = EditorState.create({ doc: '', extensions: [jhyyLanguage] })
    const rules = state.languageDataAt('indentOnInput', 0)
    expect(rules.length, 'indentOnInput 不能缺').toBeGreaterThan(0)
    for (const rule of rules) {
      expect(
        typeof (rule as { test?: unknown }).test,
        'indentOnInput 必须是正则表达式（CodeMirror 会调用 rule.test(...)）',
      ).toBe('function')
    }
  })

  it('输入的事务不会抛异常（这正是「只读」的根因）', () => {
    const state = EditorState.create({
      doc: 'fn main_jhyy() -> i32 {\n    0\n}',
      extensions: [jhyyLanguage, indentOnInput()],
    })
    // 模拟一次键盘输入（userEvent: 'input.type' 才会触发 indentOnInput 过滤器）
    expect(() =>
      state.update({ changes: { from: 27, insert: 'x' }, userEvent: 'input.type' }),
    ).not.toThrow()
  })

  it('规则只在一行开头打「}」时生效（不会误伤普通代码行）', () => {
    const state = EditorState.create({ doc: '', extensions: [jhyyLanguage] })
    const rule = state.languageDataAt('indentOnInput', 0)[0] as RegExp
    expect(rule.test('    }')).toBe(true) // 行首的右花括号 ⇒ 该重新缩进
    expect(rule.test('    let x = 1;')).toBe(false) // 普通代码 ⇒ 不动
    expect(rule.test('}')).toBe(true)
  })

  it('注释 / 括号 / 单词字符的语言数据都在', () => {
    const state = EditorState.create({ doc: '', extensions: [jhyyLanguage] })
    expect(state.languageDataAt('commentTokens', 0).length).toBeGreaterThan(0)
    expect(state.languageDataAt('closeBrackets', 0).length).toBeGreaterThan(0)
    expect(state.languageDataAt('wordChars', 0)[0]).toBe('_')
  })
})
