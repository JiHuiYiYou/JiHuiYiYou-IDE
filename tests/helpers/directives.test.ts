import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectJhyyFiles, readDirectives } from './repo'

/**
 * 一致性门的「语料口径 + 指令解析」单测。
 *
 * 这两件事**改错了不会立刻炸**，只会让门在某个环境下莫名其妙地红：
 *
 *   · 语料口径 —— 少收/多收文件，直接改变门跑的东西。
 *   · SETENV —— 解析错了，靠 env 区分行为的测试就跑成了另一个环境。
 *
 * 所以单独锁住，别等 CI 红了才发现。
 */

describe('readDirectives —— 指令解析', () => {
  it('认独立成行的 EXPECT / EXPECT-OUT / EXPECT-ERROR', () => {
    const d = readDirectives(
      [
        '// EXPECT: 42',
        '// EXPECT-OUT: "hello"',
        '// EXPECT-ERROR: "type mismatch"',
        'fn main_jhyy() -> i32 { 0 }',
      ].join('\n'),
    )
    expect(d.expectExit).toBe(42)
    expect(d.expectOut).toBe('hello')
    expect(d.expectError).toBe('type mismatch')
  })

  it('散文里提到的指令不算数（上游同一口径）', () => {
    // 「此前是 `// EXPECT: 42`」这种说明文字不该凭空生成一条断言
    const d = readDirectives(
      ['// 此前是 `// EXPECT: 42`，现已改成下面这条', '// EXPECT: 7'].join('\n'),
    )
    expect(d.expectExit).toBe(7)
  })

  it('散文里**只有**指令、没有真指令 ⇒ 不产生断言', () => {
    const d = readDirectives('// 以前写的是 // EXPECT: 42')
    expect(d.expectExit).toBeUndefined()
  })

  it('SETENV：多行 KEY=VALUE', () => {
    const d = readDirectives(
      [
        '// SETENV: JHY_GCC=C:\\msys64\\ucrt64\\bin\\gcc.exe',
        '// SETENV: JHYY_HOME=/tmp/home',
        '// EXPECT: 1',
      ].join('\n'),
    )
    expect(d.setenv).toEqual({
      JHY_GCC: 'C:\\msys64\\ucrt64\\bin\\gcc.exe',
      JHYY_HOME: '/tmp/home',
    })
  })

  it('SETENV：行尾 # 起是注释', () => {
    const d = readDirectives('// SETENV: KEY=value   # 这是注释')
    expect(d.setenv).toEqual({ KEY: 'value' })
  })

  it('SETENV：散文里提到的不算', () => {
    const d = readDirectives('// 以前用 // SETENV: JHY_GCC=xxx 注入')
    expect(d.setenv).toEqual({})
  })

  it('没有指令时 setenv 是空对象（不是 undefined）', () => {
    expect(readDirectives('fn main_jhyy() -> i32 { 0 }').setenv).toEqual({})
  })
})

describe('collectJhyyFiles —— 语料口径', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jhyy-corpus-'))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'normal.jhyy'), 'fn main_jhyy() -> i32 { 0 }')
    writeFileSync(join(dir, '_private.jhyy'), 'fn main_jhyy() -> i32 { 0 }')
    writeFileSync(join(dir, 'not_jhyy.txt'), 'x')
    writeFileSync(join(dir, 'sub', '_also_private.jhyy'), 'fn main_jhyy() -> i32 { 0 }')
    writeFileSync(join(dir, 'sub', 'nested.jhyy'), 'fn main_jhyy() -> i32 { 0 }')
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('以 _ 开头的文件不进语料（跟语言仓库三处 harness 同口径）', () => {
    const names = collectJhyyFiles(dir).map((f) => f.replace(/\\/g, '/').split('/').pop())
    expect(names).toContain('normal.jhyy')
    expect(names).toContain('nested.jhyy')
    expect(names).not.toContain('_private.jhyy')
    expect(names).not.toContain('_also_private.jhyy')
    expect(names).not.toContain('not_jhyy.txt')
  })
})
