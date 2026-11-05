import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../../src/shared/ansi'

/**
 * 剥 ANSI 转义序列。
 *
 * 走**真控制台**（ConPTY / node-pty）之后，程序的输出是**终端渲染后的流** ——
 * 输出面板要的是纯文本 ⇒ 得剥一遍 ⇒ 不然日志里全是转义序列。
 */
const ESC = String.fromCharCode(27)

describe('stripAnsi', () => {
  it('颜色序列剥掉，正文留着', () => {
    expect(stripAnsi(`${ESC}[32m你好${ESC}[0m`)).toBe('你好')
  })

  it('光标移动 / 清屏序列剥掉', () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[Hhello`)).toBe('hello')
    expect(stripAnsi(`a${ESC}[10;20Hb`)).toBe('ab')
  })

  it('OSC 序列（窗口标题）整段剥掉', () => {
    expect(stripAnsi(`${ESC}]0;窗口标题文本`)).toBe('文本')
  })

  it('没有转义序列时原样返回', () => {
    expect(stripAnsi('普通的一行输出')).toBe('普通的一行输出')
    expect(stripAnsi('')).toBe('')
  })

  it('换行不能被吃掉', () => {
    expect(stripAnsi(`第一行${ESC}[0m\n第二行`)).toBe('第一行\n第二行')
  })

  it('裸 ESC 也剥掉', () => {
    expect(stripAnsi(`a${ESC}b`)).toBe('ab')
  })
})
