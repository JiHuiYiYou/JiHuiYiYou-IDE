import { describe, expect, it } from 'vitest'
import {
  chordOf,
  displayChord,
  fuzzyScore,
  type KeyChord,
} from '../../src/renderer/commands/types'

/**
 * 快捷键规范化 + 命令面板模糊匹配。
 *
 * ⚠️ 这里的每一条都是**踩过的坑**：
 * 注册表里写的是 "Ctrl+J"，而 `KeyboardEvent.key` 给的是 "j" ——
 * 规范化不统一的话，**所有**快捷键都会静默失灵（按了没反应，也不报错）。
 */
function chord(key: string, mods: Partial<KeyChord> = {}): string {
  return chordOf({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  })
}

describe('chordOf', () => {
  it('单字符键转成大写 —— 注册表里写的是 "Ctrl+J"', () => {
    expect(chord('j', { ctrlKey: true })).toBe('Ctrl+J')
    expect(chord('s', { ctrlKey: true })).toBe('Ctrl+S')
    expect(chord('b', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+B')
  })

  it('修饰键顺序固定：Ctrl → Alt → Shift → Meta', () => {
    expect(chord('p', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+P')
    expect(chord('i', { ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+I')
    expect(chord('p', { shiftKey: true, ctrlKey: true })).toBe('Ctrl+Shift+P')
  })

  it('功能键原样保留', () => {
    expect(chord('F5')).toBe('F5')
    expect(chord('F5', { shiftKey: true })).toBe('Shift+F5')
  })

  it('反引号和方向键用别名', () => {
    expect(chord('`', { ctrlKey: true })).toBe('Ctrl+Backquote')
    expect(chord('ArrowUp', { ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+Up')
    expect(chord('ArrowDown', { ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+Down')
  })

  it('没有修饰键时就是键名本身', () => {
    expect(chord('Escape')).toBe('Escape')
    expect(chord('Enter')).toBe('Enter')
  })
})

describe('displayChord', () => {
  it('Backquote 显示成反引号', () => {
    expect(displayChord('Ctrl+Backquote')).toBe('Ctrl+`')
  })

  it('别的原样', () => {
    expect(displayChord('Ctrl+Shift+P')).toBe('Ctrl+Shift+P')
  })
})

describe('fuzzyScore', () => {
  it('空查询匹配一切', () => {
    expect(fuzzyScore('', '随便什么')).toBeGreaterThan(0)
  })

  it('不匹配返回 0', () => {
    expect(fuzzyScore('xyz', 'Ctrl+Shift+P')).toBe(0)
  })

  it('子序列能匹配上', () => {
    expect(fuzzyScore('csp', 'Ctrl+Shift+P')).toBeGreaterThan(0)
  })

  it('连续的命中得分更高', () => {
    const contiguous = fuzzyScore('shift', 'Ctrl+Shift+P')
    const scattered = fuzzyScore('shft', 'Ctrl+Shift+P')
    expect(contiguous).toBeGreaterThan(scattered)
  })
})
